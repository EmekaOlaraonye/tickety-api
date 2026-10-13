import { Timestamp } from 'firebase-admin/firestore';

import { COLLECTIONS, db } from '../lib/firebase.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

/**
 * Orders, and the tickets they issued.
 *
 * Nothing in this platform could answer "I paid and never got my ticket"
 * before this file existed. Orders were written by `placeOrder`, read once by
 * the sales report to be summed, and never looked at again: no endpoint, no
 * screen, no way to find one. The same gap meant a stolen or charged-back
 * ticket could not be stopped except by deleting the customer's whole account.
 *
 * Two facts about the data shape drive everything here:
 *
 * 1. Orders live at `Users/{uid}/Orders/{orderId}`, a per-user subcollection,
 *    so listing them across customers is a collection-group query and every
 *    order is addressed by the pair (uid, orderId) rather than an id alone.
 *
 * 2. An issued ticket carries its `orderId` but the order does not list its
 *    ticket ids, so the tickets for an order are found by querying
 *    `IssuedTickets` rather than read from the order document.
 */

function toDate(raw) {
  if (!raw) return null;
  if (raw instanceof Timestamp) return raw.toDate();
  if (raw instanceof Date) return raw;

  const parsed = new Date(String(raw));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber(raw, fallback = 0) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Order document -> API resource.
 *
 * `total` is summed from the line items rather than read off `totalAmount`,
 * for the same reason the sales report does it: the stored figure includes tax
 * and, in a mixed order, money belonging to more than one organiser. The
 * stored value is still surfaced as `storedTotal` so a discrepancy between the
 * two is visible rather than hidden — that difference is exactly what someone
 * investigating a payment complaint needs to see.
 */
export function toResource(doc, { customer = null } = {}) {
  const data = doc.data() ?? {};
  const items = Array.isArray(data.items) ? data.items : [];

  const lines = items.map((item) => {
    const quantity = Math.trunc(toNumber(item?.quantity, 0));
    const price = toNumber(item?.price, 0);

    return {
      eventId: item?.ticketId ?? item?.eventId ?? null,
      title: String(item?.title ?? '').trim(),
      quantity,
      price,
      lineTotal: Math.round(quantity * price * 100) / 100,
    };
  });

  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);

  return {
    orderId: doc.id,
    // The parent of Users/{uid}/Orders/{orderId} is the Orders collection;
    // its parent is the user document.
    userId: doc.ref.parent.parent?.id ?? null,
    customerName: customer?.name ?? null,
    customerEmail: customer?.email ?? null,
    placedAt: toDate(data.orderDate)?.toISOString() ?? null,
    seats: lines.reduce((sum, line) => sum + line.quantity, 0),
    total: Math.round(total * 100) / 100,
    storedTotal: data.totalAmount == null ? null : toNumber(data.totalAmount),
    status: String(data.status ?? 'placed'),
    items: lines,
  };
}

/** Issued ticket -> API resource. The `secret` is never included. */
export function toTicketResource(doc) {
  const data = doc.data() ?? {};

  return {
    ticketId: doc.id,
    orderId: data.orderId ?? '',
    eventId: data.eventId ?? null,
    holderName: String(data.holderName ?? '').trim(),
    seat: Math.trunc(toNumber(data.seat, 1)),
    seatCount: Math.trunc(toNumber(data.seatCount, 1)),
    status: String(data.status ?? 'valid'),
    issuedAt: toDate(data.issuedAt)?.toISOString() ?? null,
    redeemedAt: toDate(data.redeemedAt)?.toISOString() ?? null,
    redeemedBy: data.redeemedBy ?? null,
    voidedAt: toDate(data.voidedAt)?.toISOString() ?? null,
    voidedBy: data.voidedBy ?? null,
    voidReason: data.voidReason ?? null,
  };
}

/**
 * Attaches customer identity to a page of orders.
 *
 * One `getAll` for the page's distinct users rather than a read per order: a
 * page of 25 orders from 25 different customers costs one round trip instead
 * of 25 sequential ones.
 */
async function withCustomers(docs) {
  const userIds = [...new Set(docs.map((doc) => doc.ref.parent.parent?.id).filter(Boolean))];
  if (userIds.length === 0) return docs.map((doc) => toResource(doc));

  const refs = userIds.map((id) => db.collection(COLLECTIONS.users).doc(id));
  const snapshots = await db.getAll(...refs);

  const byId = new Map(
    snapshots.map((snapshot) => {
      const data = snapshot.data() ?? {};
      const name = [data.FirstName, data.LastName].filter(Boolean).join(' ').trim();
      return [snapshot.id, { name: name || null, email: data.Email ?? null }];
    })
  );

  return docs.map((doc) =>
    toResource(doc, { customer: byId.get(doc.ref.parent.parent?.id) ?? null })
  );
}

/**
 * Recent orders across every customer.
 *
 * Newest first, which is the only useful order for a support queue. That needs
 * the `Orders` collection-group index on `orderDate` — the same index
 * `/reports/sales` already requires.
 *
 * The cursor is an order's full document path rather than an encoded field
 * tuple: `startAfter` accepts a document snapshot, so paging costs one extra
 * read and cannot drift out of step with the sort the way a hand-encoded
 * cursor can.
 */
export async function list({ limit = 25, cursor = null, since = null } = {}) {
  let query = db
    .collectionGroup(COLLECTIONS.orders)
    .orderBy('orderDate', 'desc')
    .limit(limit + 1);

  if (since) query = query.where('orderDate', '>=', Timestamp.fromDate(since));

  if (cursor) {
    const anchor = await db.doc(cursor).get();
    if (!anchor.exists) throw badRequest('That cursor no longer points at an order.');
    query = query.startAfter(anchor);
  }

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);
  const hasMore = snapshot.docs.length > limit;

  return {
    items: await withCustomers(docs),
    nextCursor: hasMore ? docs[docs.length - 1].ref.path : null,
    total: null,
  };
}

/** One customer's order history, newest first. */
export async function listForUser(userId, { limit = 25, cursor = null } = {}) {
  let query = db
    .collection(COLLECTIONS.users)
    .doc(userId)
    .collection(COLLECTIONS.orders)
    .orderBy('orderDate', 'desc')
    .limit(limit + 1);

  if (cursor) {
    const anchor = await db.doc(cursor).get();
    if (!anchor.exists) throw badRequest('That cursor no longer points at an order.');
    query = query.startAfter(anchor);
  }

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);
  const hasMore = snapshot.docs.length > limit;

  return {
    items: await withCustomers(docs),
    nextCursor: hasMore ? docs[docs.length - 1].ref.path : null,
    total: null,
  };
}

/**
 * One order, with every ticket it issued.
 *
 * The tickets are the point: an order on its own cannot tell you whether the
 * customer actually holds anything, which is the first question when someone
 * says they paid and got nothing.
 */
export async function get(userId, orderId) {
  const ref = db
    .collection(COLLECTIONS.users)
    .doc(userId)
    .collection(COLLECTIONS.orders)
    .doc(orderId);

  const [doc, tickets] = await Promise.all([
    ref.get(),
    db.collection(COLLECTIONS.issuedTickets).where('orderId', '==', orderId).get(),
  ]);

  if (!doc.exists) throw notFound(`No order ${orderId} for that customer.`);

  const [order] = await withCustomers([doc]);

  return {
    ...order,
    tickets: tickets.docs
      .map(toTicketResource)
      // Seat order, so a party of six reads 1..6 rather than by document id.
      .sort((a, b) => a.seat - b.seat),
  };
}

/**
 * Stops a ticket, or puts it back.
 *
 * This works because `redeemTicket` already refuses any ticket whose status is
 * not `valid` — so writing `void` here takes effect at every door immediately,
 * with no deploy and no change to the scanner. That refusal reaches the door
 * as the verdict the scanner already draws for a refunded or voided ticket.
 *
 * A redeemed ticket cannot be voided. The holder is already inside; changing
 * the record would misstate what happened at the gate, and attendance figures
 * are derived from exactly this field.
 *
 * @param {'valid'|'void'} status
 */
export async function setTicketStatus(ticketId, status, { actor = null, reason = null } = {}) {
  if (status !== 'valid' && status !== 'void') {
    throw badRequest('A ticket can only be set to valid or void.');
  }

  const ref = db.collection(COLLECTIONS.issuedTickets).doc(ticketId);

  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists) throw notFound('No such ticket.');

    const current = String(doc.get('status') ?? 'valid');

    if (current === 'redeemed') {
      throw conflict(
        'That ticket has already been admitted. Voiding it now would misstate what happened at the gate.'
      );
    }
    if (current === status) {
      throw conflict(`That ticket is already ${status}.`);
    }

    const patch =
      status === 'void'
        ? {
            status: 'void',
            voidedAt: Timestamp.now(),
            voidedBy: actor,
            voidReason: reason,
          }
        : // Restoring clears the void trail rather than leaving a stale reason
          // attached to a ticket that now works.
          { status: 'valid', voidedAt: null, voidedBy: null, voidReason: null };

    transaction.update(ref, patch);

    return toTicketResource({
      id: doc.id,
      data: () => ({ ...(doc.data() ?? {}), ...patch }),
    });
  });
}

/* --------------------------------------------------------------------------
 * The holder's own view
 *
 * Everything above this line answers "what did someone else buy?" and is read
 * by staff. Everything below answers "what do I hold?", keyed on the uid in
 * the caller's own token, and is read by the customer app.
 *
 * They are separate functions rather than one with a flag because they differ
 * on the two things that matter most in this file — whether the ticket
 * `secret` is included, and which of several totals is the honest one.
 * -------------------------------------------------------------------------- */

/**
 * The QR format the scanner parses: `TKT1:<ticketId>:<secret>`.
 *
 * Assembled here rather than on the device so the format is owned by the
 * server. `redeemTicket` rejects anything whose prefix is not this, and the
 * shipped apps cannot be force-updated — so the day a `TKT2` is needed, a
 * client that renders whatever this field contains keeps working, and one that
 * concatenates the parts itself does not.
 */
const QR_PREFIX = 'TKT1';

/**
 * Issued ticket -> the resource its own holder gets.
 *
 * The one place in this API where a ticket secret is allowed out, and only
 * ever to the uid stored on the ticket itself. That is not a new exposure:
 * `firestore.rules` already lets a customer read their own `IssuedTickets`
 * documents, because without the secret there is no QR to show at a door.
 * What it replaces is the client knowing the collection name, the query shape
 * and the payload format.
 *
 * Staff get `toTicketResource` instead, which has no secret in it at all —
 * rules deny them the collection for exactly that reason.
 */
export function toHolderTicketResource(doc) {
  const data = doc.data() ?? {};
  const secret = typeof data.secret === 'string' ? data.secret : null;

  return {
    ticketId: doc.id,
    orderId: data.orderId ?? '',
    eventId: data.eventId ?? null,
    // Denormalised onto the ticket when it was minted, so a wallet renders
    // without a read per seat — and so a ticket still says what it admits you
    // to after the event row has been edited.
    eventTitle: String(data.eventTitle ?? '').trim(),
    eventLocation: String(data.eventLocation ?? '').trim(),
    eventStart: toDate(data.eventStart)?.toISOString() ?? null,
    holderName: String(data.holderName ?? '').trim(),
    seat: Math.trunc(toNumber(data.seat, 1)),
    seatCount: Math.trunc(toNumber(data.seatCount, 1)),
    status: String(data.status ?? 'valid'),
    issuedAt: toDate(data.issuedAt)?.toISOString() ?? null,
    redeemedAt: toDate(data.redeemedAt)?.toISOString() ?? null,
    // Null rather than a half-built string for a ticket stored without one: a
    // client drawing a QR from this must be able to tell the difference
    // between "no secret" and a payload of `TKT1:id:`.
    qrPayload: secret ? `${QR_PREFIX}:${doc.id}:${secret}` : null,
  };
}

/**
 * Order document -> the resource the customer who placed it gets.
 *
 * Deliberately not `toResource`. That one sums the line items and treats the
 * result as authoritative, because an order can hold seats for two organisers
 * and a sales report must attribute each line separately. A customer is owed
 * the opposite figure: what their card was actually charged. Serving them a
 * line-item sum would understate every order by its tax.
 */
export function toHolderOrderResource(doc) {
  const data = doc.data() ?? {};
  const items = Array.isArray(data.items) ? data.items : [];

  return {
    orderId: doc.id,
    placedAt: toDate(data.orderDate)?.toISOString() ?? null,
    status: String(data.status ?? 'placed'),
    subtotal: data.subtotal == null ? null : toNumber(data.subtotal),
    tax: data.tax == null ? null : toNumber(data.tax),
    total: data.totalAmount == null ? null : toNumber(data.totalAmount),
    region: data.region ?? null,
    paymentMethod: data.paymentMethod ?? null,
    seats: items.reduce((sum, item) => sum + Math.trunc(toNumber(item?.quantity, 0)), 0),
    items: items.map((item) => {
      const quantity = Math.trunc(toNumber(item?.quantity, 0));
      const price = toNumber(item?.price, 0);

      return {
        eventId: item?.ticketId ?? item?.eventId ?? null,
        title: String(item?.title ?? '').trim(),
        quantity,
        price,
        lineTotal: Math.round(quantity * price * 100) / 100,
      };
    }),
  };
}

/** One customer's own order history, newest first. */
export async function listOwnOrders(userId, { limit = 25, cursor = null } = {}) {
  const ownOrders = db
    .collection(COLLECTIONS.users)
    .doc(userId)
    .collection(COLLECTIONS.orders);

  let query = ownOrders.orderBy('orderDate', 'desc').limit(limit + 1);

  if (cursor) {
    // Resolved inside this user's own subcollection rather than as a full
    // document path: a cursor is caller-supplied, and `db.doc(cursor)` would
    // happily accept one pointing into somebody else's history.
    const anchor = await ownOrders.doc(cursor).get();
    if (!anchor.exists) throw badRequest('That cursor no longer points at an order.');
    query = query.startAfter(anchor);
  }

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);

  return {
    items: docs.map(toHolderOrderResource),
    nextCursor: snapshot.docs.length > limit ? docs[docs.length - 1].id : null,
    total: null,
  };
}

/**
 * One of the caller's own orders, with the tickets it issued.
 *
 * Addressed by order id alone — the uid comes from the token, so there is no
 * parameter here that could name another customer.
 */
export async function getOwnOrder(userId, orderId) {
  const ref = db
    .collection(COLLECTIONS.users)
    .doc(userId)
    .collection(COLLECTIONS.orders)
    .doc(orderId);

  const [doc, tickets] = await Promise.all([
    ref.get(),
    // Filtered on `userId` as well as `orderId`. Order ids are unique, but the
    // one query in this file that returns secrets should not be relying on
    // that to stay scoped to the caller.
    db
      .collection(COLLECTIONS.issuedTickets)
      .where('userId', '==', userId)
      .where('orderId', '==', orderId)
      .get(),
  ]);

  if (!doc.exists) throw notFound(`No order ${orderId} on your account.`);

  return {
    ...toHolderOrderResource(doc),
    tickets: tickets.docs.map(toHolderTicketResource).sort((a, b) => a.seat - b.seat),
  };
}

/**
 * Every seat the caller holds, most recently issued first.
 *
 * The same query the customer app runs against Firestore today, which is why
 * it needs no new index: `IssuedTickets` on (`userId` ASC, `issuedAt` DESC) is
 * already in `firestore.indexes.json` for exactly this.
 */
export async function listOwnTickets(userId, { limit = 25, cursor = null } = {}) {
  const issued = db.collection(COLLECTIONS.issuedTickets);

  let query = issued
    .where('userId', '==', userId)
    .orderBy('issuedAt', 'desc')
    .limit(limit + 1);

  if (cursor) {
    const anchor = await issued.doc(cursor).get();

    // A cursor naming someone else's ticket is refused rather than used. The
    // `userId` filter would still scope the page correctly, but paging from a
    // foreign anchor leaks that ticket's `issuedAt` through which of the
    // caller's own tickets come back.
    if (!anchor.exists || anchor.get('userId') !== userId) {
      throw badRequest('That cursor no longer points at one of your tickets.');
    }
    query = query.startAfter(anchor);
  }

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);

  return {
    items: docs.map(toHolderTicketResource),
    nextCursor: snapshot.docs.length > limit ? docs[docs.length - 1].id : null,
    total: null,
  };
}

/** One of the caller's own tickets, with the payload its QR encodes. */
export async function getOwnTicket(userId, ticketId) {
  const doc = await db.collection(COLLECTIONS.issuedTickets).doc(ticketId).get();

  // Someone else's ticket is reported missing, not forbidden. A 403 would
  // confirm that a given ticket id exists, and the id is one half of the QR
  // payload — the half an attacker can read off a screen.
  if (!doc.exists || doc.get('userId') !== userId) {
    throw notFound('No such ticket on your account.');
  }

  return toHolderTicketResource(doc);
}

/**
 * One ticket, as staff see it: no secret.
 *
 * This is the lookup a door needs when a scan is refused — the scanner holds
 * an id and has to tell the person in front of it *why*: already admitted at
 * 20:14, or voided, or issued for tomorrow. The guest list at
 * `/reports/events/:eventId/attendees` stays off the scanner role; one ticket
 * at a time, in answer to a scan, is not a list of who is coming.
 */
export async function getTicket(ticketId) {
  const doc = await db.collection(COLLECTIONS.issuedTickets).doc(ticketId).get();
  if (!doc.exists) throw notFound('No such ticket.');

  return toTicketResource(doc);
}
