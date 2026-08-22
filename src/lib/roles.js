/**
 * Who can do what.
 *
 * Tickety previously had one boolean claim, `staff: true`, shared by everybody
 * with any privilege at all. That meant a door-scanner account — an account
 * whose password was, until now, derived from its own email address — could
 * also delete the entire event catalogue, because `firestore.rules` granted
 * `Tickets` writes to `isStaff()`.
 *
 * Roles are mutually exclusive and carried in a `role` custom claim. Claims can
 * only be set by a trusted backend, which is this API and nothing else: a
 * client can read its own token but cannot mint one.
 */
export const ROLES = Object.freeze({
  /** Platform owner. Everything, including granting roles. */
  ADMIN: 'admin',
  /** Runs their own events. Scoped to their own `orgId`. */
  ORGANISER: 'organiser',
  /** Works a door. Can redeem tickets and read attendance, nothing else. */
  SCANNER: 'scanner',
});

export const ALL_ROLES = Object.freeze(Object.values(ROLES));

/**
 * Legacy claim kept alongside `role` for the whole migration.
 *
 * The deployed `redeemTicket` and `gateStats` functions, and the current
 * `firestore.rules`, both test `staff === true`. Emitting it as well as `role`
 * means a token minted today works against yesterday's backend and tomorrow's,
 * so the API, the rules and the two Flutter apps do not have to ship in the
 * same instant. Remove it once rules and functions test `role` directly.
 */
export const LEGACY_STAFF_CLAIM = 'staff';

/**
 * Builds the claim set for a role.
 *
 * `orgId` scopes an organiser to their own events. It is deliberately part of
 * the token rather than looked up per request: a token is signed by Google and
 * cannot be edited by the holder, whereas a lookup is one more thing that can
 * be stale or fail open.
 */
export function claimsFor(role, { orgId = null } = {}) {
  if (!ALL_ROLES.includes(role)) {
    throw new Error(`Unknown role "${role}".`);
  }

  return {
    role,
    // Every privileged role is "staff" to the old backend.
    [LEGACY_STAFF_CLAIM]: true,
    // Only organisers carry a scope; null clears a stale one on role change.
    orgId: role === ROLES.ORGANISER ? orgId : null,
  };
}

/** Claims that strip every privilege — used when demoting to a customer. */
export function customerClaims() {
  return { role: null, [LEGACY_STAFF_CLAIM]: null, orgId: null };
}

/**
 * Reads the role out of a decoded token.
 *
 * Falls back to `scanner` for a token that carries only the legacy `staff`
 * claim. That is the least-privileged role, so an old token issued before this
 * change keeps working at a door but cannot touch the catalogue — the failure
 * direction we want if the fallback is ever wrong.
 */
export function roleFromToken(token = {}) {
  if (ALL_ROLES.includes(token.role)) return token.role;
  if (token[LEGACY_STAFF_CLAIM] === true) return ROLES.SCANNER;
  return null;
}

/** True when `role` is one of `allowed`. */
export function hasRole(role, allowed) {
  return role !== null && allowed.includes(role);
}
