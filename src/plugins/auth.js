import fp from 'fastify-plugin';

import { auth } from '../lib/firebase.js';
import { forbidden, fromFirebase, unauthorized } from '../lib/errors.js';
import { ROLES, hasRole, roleFromToken } from '../lib/roles.js';

/**
 * Identity and authorisation.
 *
 * The API trusts exactly one thing: a Firebase ID token in
 * `Authorization: Bearer <token>`. It is signed by Google, verified here
 * against Google's public keys, and carries the role claim that only this API
 * can set. Nothing else about a request is trusted — not a header naming a
 * role, not a user id in a body, not the origin.
 *
 * Decorates:
 *   `request.user`  — { uid, email, role, orgId } once authenticated.
 *   `fastify.authenticate`  — preHandler: requires a valid token.
 *   `fastify.requireRole(...)` — preHandler factory: requires one of the roles.
 */
async function authPlugin(fastify) {
  fastify.decorateRequest('user', null);

  /**
   * Verifies the bearer token.
   *
   * `checkRevoked` is on: a scanner phone that is lost, or an organiser who is
   * removed, must stop working the moment their sessions are revoked rather
   * than up to an hour later when the token would expire on its own. It costs
   * a lookup per request, which is the right trade for an API that can mint
   * accounts and grant roles.
   */
  fastify.decorate('authenticate', async (request) => {
    const header = request.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw unauthorized('Provide a Firebase ID token as a Bearer token.');
    }

    let decoded;
    try {
      decoded = await auth.verifyIdToken(token, true);
    } catch (error) {
      // Never echo the SDK's message here — it distinguishes "malformed" from
      // "expired" from "wrong project", which is free reconnaissance.
      const mapped = fromFirebase(error);
      throw mapped.status === 401
        ? mapped
        : unauthorized('That token is not valid.');
    }

    request.user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified === true,
      role: roleFromToken(decoded),
      orgId: typeof decoded.orgId === 'string' ? decoded.orgId : null,
    };
  });

  /**
   * Requires one of `allowed`. Authenticates first, so a route only needs this.
   *
   * Admins are *not* implicitly allowed everywhere: a route that admins may use
   * lists `ROLES.ADMIN` explicitly. Implicit superuser access is how a role
   * check quietly becomes decorative.
   */
  fastify.decorate('requireRole', (...allowed) => {
    if (allowed.length === 0) {
      throw new Error('requireRole needs at least one role.');
    }

    return async function roleGuard(request, reply) {
      if (!request.user) {
        await fastify.authenticate(request, reply);
      }

      if (!hasRole(request.user.role, allowed)) {
        request.log.warn(
          { uid: request.user.uid, role: request.user.role, allowed },
          'role check failed'
        );
        throw forbidden(
          'This account does not have access to that. Ask an administrator.'
        );
      }
    };
  });

  /**
   * Organiser scoping.
   *
   * An organiser may only touch resources carrying their own `orgId`; an admin
   * may touch any. Returns the orgId a listing should be filtered by, or null
   * for "no filter" (admin).
   */
  fastify.decorate('scopeFor', (request) => {
    if (request.user.role === ROLES.ADMIN) return null;
    return request.user.orgId;
  });

  /** Throws unless the caller may act on a resource owned by `orgId`. */
  fastify.decorate('assertOwns', (request, orgId) => {
    if (request.user.role === ROLES.ADMIN) return;

    // An organiser with no scope owns nothing. Failing closed here matters:
    // a null-vs-null comparison would otherwise grant access to every
    // unowned legacy record.
    if (!request.user.orgId || request.user.orgId !== orgId) {
      throw forbidden('That belongs to another organiser.');
    }
  });
}

export default fp(authPlugin, { name: 'auth' });
