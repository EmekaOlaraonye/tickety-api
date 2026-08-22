/**
 * Schema fragments shared by every resource.
 *
 * Fastify compiles these for both validation and serialisation. Serialisation
 * matters as much as validation here: a response schema means a field nobody
 * declared cannot leak, which is how a ticket `secret` or a password hash
 * escapes in the first place.
 */

export const problemSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    requestId: { type: 'string' },
  },
};

/** The error responses every authenticated route can produce. */
export const errorResponses = {
  400: { ...problemSchema, description: 'Malformed request' },
  401: { ...problemSchema, description: 'Missing or invalid token' },
  403: { ...problemSchema, description: 'Role not permitted' },
  404: { ...problemSchema, description: 'No such resource' },
  429: { ...problemSchema, description: 'Rate limited' },
  500: { ...problemSchema, description: 'Server error' },
};

/**
 * Cursor pagination.
 *
 * Cursors rather than offsets: an offset re-reads and skips every preceding
 * document, so `?page=50` costs fifty pages of reads and still shifts under
 * you when a row is inserted. The cursor is the last document id seen.
 */
export const paginationQuery = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 25,
    description: 'Maximum items to return.',
  },
  cursor: {
    type: 'string',
    description: 'Opaque cursor from a previous response. Omit for page one.',
  },
};

export function pageSchema(itemSchema) {
  return {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array', items: itemSchema },
      /** Absent when there are no further pages. */
      nextCursor: { type: ['string', 'null'] },
      total: {
        type: ['integer', 'null'],
        description:
          'Total matching items. Null when counting would be too expensive.',
      },
    },
  };
}

export const idParam = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 1500 },
  },
};

/**
 * A Firestore document id must be usable as a path segment.
 *
 * `AddEvent` used the event's display name as its document id, so an event
 * called "Jazz / Blues Night" produced an unreachable path. Ids are generated
 * or validated against this instead.
 */
export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidDocumentId(value) {
  return typeof value === 'string' && DOCUMENT_ID_PATTERN.test(value);
}

/** `Jazz / Blues Night!` -> `jazz-blues-night`. */
export function slugify(value) {
  const slug = String(value)
    .normalize('NFKD')
    // Strip combining marks left behind by NFKD, so 'Café' -> 'cafe'.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return slug || null;
}
