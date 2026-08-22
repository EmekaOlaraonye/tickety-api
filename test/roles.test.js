import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  ROLES,
  ALL_ROLES,
  claimsFor,
  customerClaims,
  hasRole,
  roleFromToken,
} from '../src/lib/roles.js';

describe('claimsFor', () => {
  test('carries the role and the legacy staff flag', () => {
    const claims = claimsFor(ROLES.SCANNER);
    assert.equal(claims.role, 'scanner');
    // The deployed redeemTicket and the current firestore.rules both test
    // `staff === true`. Dropping it would lock every door mid-migration.
    assert.equal(claims.staff, true);
  });

  test('scopes an organiser and only an organiser', () => {
    assert.equal(claimsFor(ROLES.ORGANISER, { orgId: 'org_9' }).orgId, 'org_9');
    // A scanner must not inherit a scope from a previous role, or it would
    // keep an organiser's reach after demotion.
    assert.equal(claimsFor(ROLES.SCANNER, { orgId: 'org_9' }).orgId, null);
  });

  test('refuses an unknown role rather than minting an empty claim', () => {
    assert.throws(() => claimsFor('superuser'), /Unknown role/);
    assert.throws(() => claimsFor(undefined), /Unknown role/);
  });
});

describe('customerClaims', () => {
  test('clears every privilege', () => {
    const claims = customerClaims();
    assert.equal(claims.role, null);
    assert.equal(claims.staff, null);
    assert.equal(claims.orgId, null);
  });
});

describe('roleFromToken', () => {
  test('reads a modern token', () => {
    assert.equal(roleFromToken({ role: 'admin' }), ROLES.ADMIN);
  });

  test('falls back to the least privileged role for a legacy token', () => {
    // A token minted before roles existed carries only `staff: true`. Treating
    // it as a scanner keeps doors working while denying catalogue access —
    // the safe direction to be wrong in.
    assert.equal(roleFromToken({ staff: true }), ROLES.SCANNER);
  });

  test('gives an unprivileged token no role at all', () => {
    assert.equal(roleFromToken({}), null);
    assert.equal(roleFromToken({ staff: false }), null);
    // A client cannot promote itself by inventing a claim value.
    assert.equal(roleFromToken({ role: 'superuser' }), null);
    assert.equal(roleFromToken({ role: true }), null);
  });
});

describe('hasRole', () => {
  test('a null role never matches anything', () => {
    assert.equal(hasRole(null, ALL_ROLES), false);
  });

  test('matches only what is listed', () => {
    assert.equal(hasRole(ROLES.SCANNER, [ROLES.SCANNER]), true);
    // Admin is not implicitly allowed everywhere — routes list it explicitly.
    assert.equal(hasRole(ROLES.ADMIN, [ROLES.SCANNER]), false);
  });
});

test('roles are mutually exclusive and stable', () => {
  assert.deepEqual(ALL_ROLES, ['admin', 'organiser', 'scanner']);
  assert.equal(new Set(ALL_ROLES).size, ALL_ROLES.length);
});
