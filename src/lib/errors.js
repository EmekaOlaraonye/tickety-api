/**
 * One error shape for the whole API.
 *
 * Responses follow RFC 9457 (`application/problem+json`), so a client can
 * branch on a stable `type` rather than string-matching a human sentence:
 *
 *   { "type": "https://tickety.app/problems/not-found",
 *     "title": "Not found",
 *     "status": 404,
 *     "detail": "No event with id evt_9.",
 *     "instance": "/v1/events/evt_9" }
 *
 * The old controllers did `reply.code(500).send({ error: 'Internal Server
 * Error' })` for every failure — a missing record, a bad payload and a broken
 * database were indistinguishable to the caller, and all three read as our
 * fault.
 */

const PROBLEM_BASE = 'https://tickety.app/problems';

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status.
   * @param {string} code Stable, kebab-case problem identifier.
   * @param {string} title Short human summary; the same for every instance.
   * @param {string} detail What went wrong this time. Safe to show a user.
   */
  constructor(status, code, title, detail, { cause = undefined } = {}) {
    super(detail || title, { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
  }

  toProblem(instance) {
    return {
      type: `${PROBLEM_BASE}/${this.code}`,
      title: this.title,
      status: this.status,
      detail: this.detail,
      instance,
    };
  }
}

export const badRequest = (detail) =>
  new ApiError(400, 'bad-request', 'Bad request', detail);

export const unauthorized = (detail = 'Sign in to continue.') =>
  new ApiError(401, 'unauthorized', 'Not authenticated', detail);

export const forbidden = (detail = 'You do not have access to this.') =>
  new ApiError(403, 'forbidden', 'Not allowed', detail);

export const notFound = (detail = 'Not found.') =>
  new ApiError(404, 'not-found', 'Not found', detail);

export const conflict = (detail) =>
  new ApiError(409, 'conflict', 'Conflict', detail);

export const unprocessable = (detail) =>
  new ApiError(422, 'unprocessable', 'Cannot process', detail);

export const tooManyRequests = (detail = 'Too many requests. Slow down.') =>
  new ApiError(429, 'rate-limited', 'Rate limited', detail);

export const internal = (detail = 'Something went wrong on our side.', cause) =>
  new ApiError(500, 'internal', 'Internal error', detail, { cause });

export const unavailable = (detail = 'Temporarily unavailable. Try again.') =>
  new ApiError(503, 'unavailable', 'Unavailable', detail);

/**
 * Maps a Firebase Admin SDK error onto an HTTP problem.
 *
 * Anything unrecognised becomes a 500 with a generic message — an unmapped
 * driver error can carry internal detail (index names, document paths) that
 * should not reach a browser.
 */
export function fromFirebase(error) {
  const code = error?.code ?? '';

  switch (code) {
    case 'auth/email-already-exists':
      return conflict('That email address already has an account.');
    case 'auth/invalid-email':
      return badRequest('That is not a valid email address.');
    case 'auth/invalid-password':
      return badRequest('Password must be at least 6 characters.');
    case 'auth/user-not-found':
      return notFound('No such account.');
    case 'auth/id-token-expired':
      return unauthorized('Your session expired. Sign in again.');
    case 'auth/id-token-revoked':
      return unauthorized('Your session was revoked. Sign in again.');
    case 'auth/argument-error':
      return unauthorized('Malformed credentials.');
    case 5: // Firestore NOT_FOUND
    case 'not-found':
      return notFound('That record no longer exists.');
    case 6: // Firestore ALREADY_EXISTS
    case 'already-exists':
      return conflict('That record already exists.');
    case 7: // Firestore PERMISSION_DENIED
    case 'permission-denied':
      return forbidden('The server is not allowed to do that.');
    case 8: // Firestore RESOURCE_EXHAUSTED
      return tooManyRequests('The database is over quota. Try again shortly.');
    case 4: // Firestore DEADLINE_EXCEEDED
    case 14: // Firestore UNAVAILABLE
      return unavailable();
    default:
      return internal(undefined, error);
  }
}
