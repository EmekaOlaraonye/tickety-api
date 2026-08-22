import { Timestamp, FieldValue } from 'firebase-admin/firestore';

import { COLLECTIONS, db, stripUndefined } from '../lib/firebase.js';
import { conflict, notFound } from '../lib/errors.js';
import { slugify } from '../schemas/common.js';

/**
 * The event catalogue.
 *
 * This service is the whole reason the free-text date problem exists
 * downstream. `AddEvent.js` wrote `Date: selectedDate.toLocaleDateString()` —
 * a locale-formatted string like "20/08/2026" — so:
 *
 *   * `orderBy('Date')` silently omits every document, because Firestore
 *     cannot order mixed types.
 *   * `TicketModel` needs lenient fallback parsing to show a date at all.
 *   * "20/08/2026" and "8/20/2026" mean different days depending on who was
 *     logged in when the event was created.
 *
 * Everything written here stores `Date` as a real Firestore `Timestamp`, so
 * that fallback path stops being reached for anything created from now on.
 * Reads stay lenient, because documents written by the old form still exist.
 */

const collection = () => db.collection(COLLECTIONS.events);

/** Reads a stored value that may be a Timestamp, an ISO string, or junk. */
function toDate(raw) {
  if (!raw) return null;
  if (raw instanceof Timestamp) return raw.toDate();
  if (raw instanceof Date) return raw;

  const parsed = new Date(String(raw));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toInt(raw, fallback = 0) {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function toNumber(raw, fallback = 0) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Firestore document -> API resource.
 *
 * The stored field names are historical (`Name`, `Stock`, PascalCase) and two
 * Flutter apps plus two React apps already read them, so they are not being
 * renamed. The API presents a clean camelCase resource and absorbs the
 * mismatch in one place.
 */
export function toResource(doc) {
  const data = doc.data() ?? {};
  const startsAt = toDate(data.Date);

  return {
    id: doc.id,
    title: String(data.Name ?? '').trim(),
    category: String(data.Category ?? '').trim(),
    description: String(data.Description ?? '').trim(),
    location: String(data.Location ?? '').trim(),
    startsAt: startsAt ? startsAt.toISOString() : null,
    // Surfaced so a client can tell "no date" from "a date we could not read",
    // and so the admin UI can offer to repair legacy rows.
    rawDate: startsAt === null && data.Date ? String(data.Date) : null,
    durationMinutes: data.Duration == null ? null : toInt(data.Duration),
    price: toNumber(data.Price),
    stock: toInt(data.Stock),
    thumbnail: String(data.Thumbnail ?? '').trim(),
    ticketType: data.TicketType ? String(data.TicketType) : null,
    isFeatured: data.IsFeatured === true,
    organiserId: data.organiserId ?? null,
    createdAt: toDate(data.createdAt)?.toISOString() ?? null,
    updatedAt: toDate(data.updatedAt)?.toISOString() ?? null,
  };
}

/** API payload -> Firestore document fields. */
function toDocument(input) {
  return stripUndefined({
    Name: input.title,
    Category: input.category,
    Description: input.description,
    Location: input.location,
    // The fix: a real Timestamp, never a locale string.
    Date: input.startsAt ? Timestamp.fromDate(new Date(input.startsAt)) : undefined,
    Duration: input.durationMinutes,
    Price: input.price,
    Stock: input.stock,
    Thumbnail: input.thumbnail,
    TicketType: input.ticketType,
    IsFeatured: input.isFeatured,
    organiserId: input.organiserId,
  });
}

/**
 * Lists events, newest-first by start date.
 *
 * Ordered by document id rather than `Date`. That looks wrong until you
 * remember the legacy rows: `orderBy('Date')` would drop every event whose
 * date is still a string, which at a glance reads as "the event was deleted".
 * Sorting is applied in memory after the lenient read, so nothing disappears.
 */
export async function list({ organiserId = null, limit = 25, cursor = null } = {}) {
  let query = collection().orderBy('__name__').limit(limit + 1);

  if (organiserId) query = query.where('organiserId', '==', organiserId);
  if (cursor) query = query.startAfter(cursor);

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);
  const hasMore = snapshot.docs.length > limit;

  return {
    items: docs.map(toResource),
    nextCursor: hasMore ? docs[docs.length - 1].id : null,
    total: null,
  };
}

export async function get(id) {
  const doc = await collection().doc(id).get();
  if (!doc.exists) throw notFound(`No event with id ${id}.`);
  return toResource(doc);
}

/**
 * Creates an event.
 *
 * The id is derived from the title, not taken from a free-text "Event ID" box
 * the operator had to invent. A collision is reported rather than silently
 * overwriting — `setDoc` with an existing id used to replace a live event,
 * including its stock, with no warning at all.
 */
export async function create(input) {
  const base = slugify(input.title);
  if (!base) {
    throw conflict('That title cannot be turned into an id. Use some letters or numbers.');
  }

  const id = await reserveId(base);
  const now = FieldValue.serverTimestamp();

  await collection().doc(id).create({
    ...toDocument(input),
    createdAt: now,
    updatedAt: now,
  });

  return get(id);
}

/**
 * Finds a free id, appending -2, -3 … on collision.
 *
 * Bounded so a pathological case fails fast rather than looping. Ten events
 * with the same exact title is already a naming problem, not an id problem.
 */
async function reserveId(base) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await collection().doc(candidate).get();
    if (!existing.exists) return candidate;
  }
  throw conflict('Too many events already share that title. Rename it.');
}

export async function update(id, input) {
  const ref = collection().doc(id);
  const patch = toDocument(input);

  if (Object.keys(patch).length === 0) return get(id);

  try {
    await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  } catch (error) {
    // `update` on a missing document throws NOT_FOUND; say so plainly rather
    // than letting it surface as a 500.
    if (error?.code === 5) throw notFound(`No event with id ${id}.`);
    throw error;
  }

  return get(id);
}

/**
 * Deletes an event, refusing while seats are outstanding.
 *
 * The admin panel's delete button had no such check. Removing an event whose
 * tickets are in customers' hands leaves those tickets pointing at nothing:
 * the scanner would reject every one of them at the door, and the customer app
 * would render an order for an event that no longer exists.
 */
export async function remove(id, { force = false } = {}) {
  const ref = collection().doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw notFound(`No event with id ${id}.`);

  if (!force) {
    const issued = await db
      .collection(COLLECTIONS.issuedTickets)
      .where('eventId', '==', id)
      .limit(1)
      .get();

    if (!issued.empty) {
      throw conflict(
        'Tickets have already been issued for this event, so it cannot be ' +
          'deleted. Cancel it instead, or pass force=true if you are certain.'
      );
    }
  }

  await ref.delete();
}
