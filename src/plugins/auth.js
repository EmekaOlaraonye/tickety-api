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
 * Two levels of access, not one. `requireRole` asks what an account *is* and
 * guards everything a staff client does. `authenticate` on its own asks only
 * that somebody is signed in, and guards the routes whose scope comes from the
 * uid in the token rather than from a claim: the catalogue, and everything
 * under `/me`. A customer has no `role`, so a role check is the wrong tool for
 * the two clients most people use.
 *
 * Decorates:
 *   `request.user`  — { uid, email, role, orgId } once authenticated.
 *   `fastify.authenticate`  — hook: requires a valid token, any account.
 *   `fastify.requireRole(...)` — hook factory: requires one of the roles.
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
   * Returns the `orgId` a listing must be filtered by, or `null` meaning "no
   * filter". Three kinds of caller get `null`, each deliberately: an admin,
   * who may see the whole platform; a scanner, whose token carries no scope by
   * design (see `claimsFor`) and which needs the full event list to choose the
   * door it is working; and a customer, who has no role at all and browses the
   * whole catalogue because that is the shop window.
   *
   * An organiser always gets a real scope, or an error.
   *
   * Returning `null` for an organiser whose token carried no `orgId` was a
   * read leak. Every caller treats `null` as "no filter", so such an account
   * listed every organisation's catalogue through `GET /events` and counted
   * every organisation's orders through `GET /reports/sales`. It could not
   * *act* on any of it — `assertOwns` below already fails closed — but reading
   * it is precisely what organiser scoping exists to prevent, and nothing in
   * the response told the caller the figures were not their own.
   *
   * Failing closed beats returning a sentinel that matches no records: an
   * unscoped organiser is a misconfigured account, and an empty list would
   * leave them to guess why.
   */
  fastify.decorate('scopeFor', (request) => {
    if (request.user.role === ROLES.ADMIN) return null;

    if (request.user.role === ROLES.ORGANISER) {
      if (!request.user.orgId) {
        // Worth a log line: this is a provisioning mistake someone has to fix,
        // and the account will keep hitting it until they do.
        request.log?.warn(
          { uid: request.user.uid },
          'organiser token carries no orgId; refusing rather than serving an unfiltered scope'
        );
        throw forbidden(
          'This organiser account has no organisation set, so it owns nothing yet. ' +
            'Ask an administrator to set your organisation.'
        );
      }
      return request.user.orgId;
    }

    return null;
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
