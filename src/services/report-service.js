import { Timestamp } from 'firebase-admin/firestore';

import { COLLECTIONS, db } from '../lib/firebase.js';

/**
 * Sales and attendance.
 *
 * Every number here is derived from the underlying records rather than read
 * from a counter. That is a direct response to how attendance used to work: a
 * single `count` node in Realtime Database, incremented client-side by every
 * scanner, with a reset button on the dashboard. It was shared across all
 * events, lost increments under concurrency, and could be zeroed by accident.
 *
 * A derived number can be slow, and can cost reads. It cannot be wrong.
 */

function toDate(raw) {
  if (!raw) return null;
  if (raw instanceof Timestamp) return raw.toDate();
  const parsed = new Date(String(raw));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Admission figures for one event.
 *
 * Uses aggregation queries, which are billed per batch of index entries rather
 * than per document — so this stays cheap even for a sold-out arena, where
 * reading every ticket document would not.
 */
export async function eventAttendance(eventId) {
  const seats = db
    .collection(COLLECTIONS.issuedTickets)
    .where('eventId', '==', eventId);

  const [issued, admitted] = await Promise.all([
    seats.count().get(),
    seats.where('status', '==', 'redeemed').count().get(),
  ]);

  const issuedCount = issued.data().count;
  const admittedCount = admitted.data().count;

  return {
    eventId,
    issued: issuedCount,
    admitted: admittedCount,
    outstanding: Math.max(0, issuedCount - admittedCount),
    // Sent rather than computed client-side so every consumer agrees, and so
    // a zero-ticket event reads as 0 rather than NaN.
    admittedPercent: issuedCount === 0 ? 0 : Math.round((admittedCount / issuedCount) * 100),
  };
}

/**
 * Who is coming, and who has arrived.
 *
 * Reads `IssuedTickets` through the Admin SDK. No client can do this: rules
 * deny that collection to everyone, because each document holds the ticket
 * `secret` and a leaked secret is a working ticket. The secret is stripped
 * here and never appears in a response.
 */
export async function eventAttendees(eventId, { limit = 50, cursor = null } = {}) {
  let query = db
    .collection(COLLECTIONS.issuedTickets)
    .where('eventId', '==', eventId)
    .orderBy('__name__')
    .limit(limit + 1);

  if (cursor) query = query.startAfter(cursor);

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);

  return {
    items: docs.map((doc) => {
      const data = doc.data() ?? {};
      return {
        ticketId: doc.id,
        orderId: data.orderId ?? '',
        holderName: data.holderName ?? '',
        seat: Number(data.seat ?? 1),
        seatCount: Number(data.seatCount ?? 1),
        status: data.status ?? 'valid',
        issuedAt: toDate(data.issuedAt)?.toISOString() ?? null,
        redeemedAt: toDate(data.redeemedAt)?.toISOString() ?? null,
        redeemedBy: data.redeemedBy ?? null,
        // `secret` is intentionally absent.
      };
    }),
    nextCursor: snapshot.docs.length > limit ? docs[docs.length - 1].id : null,
    total: null,
  };
}

/**
 * Sales across orders.
 *
 * Orders live at `Users/{uid}/Orders/{orderId}`, so this is a collection-group
 * query — it needs the `Orders` collection-group index to be deployed.
 *
 * Organiser scoping is applied per line item rather than per order: one order
 * can contain seats for two different organisers' events, and each should see
 * only their own revenue from it.
 */
export async function sales({ organiserEventIds = null, since = null, limit = 500 } = {}) {
  let query = db.collectionGroup(COLLECTIONS.orders).limit(limit);
  if (since) query = query.where('orderDate', '>=', Timestamp.fromDate(since));

  const snapshot = await query.get();

  let grossRevenue = 0;
  let seatsSold = 0;
  let orderCount = 0;
  const byEvent = new Map();

  for (const doc of snapshot.docs) {
    const data = doc.data() ?? {};
    const items = Array.isArray(data.items) ? data.items : [];

    let orderCounted = false;

    for (const item of items) {
      const eventId = item?.ticketId ?? item?.eventId ?? null;

      // Scope check happens here, so a mixed order contributes only the lines
      // this organiser owns.
      if (organiserEventIds && (!eventId || !organiserEventIds.has(eventId))) {
        continue;
      }

      const quantity = Number(item?.quantity ?? 0) || 0;
      const price = Number(item?.price ?? 0) || 0;
      const lineTotal = quantity * price;

      grossRevenue += lineTotal;
      seatsSold += quantity;

      const running = byEvent.get(eventId) ?? {
        eventId,
        title: item?.title ?? '',
        seatsSold: 0,
        revenue: 0,
      };
      running.seatsSold += quantity;
      running.revenue += lineTotal;
      byEvent.set(eventId, running);

      if (!orderCounted) {
        orderCount += 1;
        orderCounted = true;
      }
    }
  }

  return {
    orderCount,
    seatsSold,
    // Money is summed from line items rather than read off `totalAmount`,
    // because that figure includes tax and, for a mixed order, revenue that
    // belongs to a different organiser.
    grossRevenue: Math.round(grossRevenue * 100) / 100,
    byEvent: [...byEvent.values()].sort((a, b) => b.revenue - a.revenue),
    truncated: snapshot.size >= limit,
  };
}
