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
