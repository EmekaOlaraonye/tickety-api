import { strict as assert } from 'node:assert';
import { test, describe, before, after } from 'node:test';

import { buildApp } from '../src/app.js';

/**
 * Who may see whose records.
 *
 * The decorators are exercised directly rather than through a route: reaching
 * them over HTTP would need a signed Firebase token, and what matters here is
 * the decision they make about a token's claims, not the transport.
 *
 * These live in their own file because they belong to the auth plugin rather
 * than to any route, and because the rule they pin down is the one the whole
 * organiser role rests on — an organiser sees their own events and revenue,
 * and nobody else's.
 */
let app;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

/** A request as far as these decorators are concerned. */
const as = (role, orgId = null) => ({ user: { uid: `uid_${role}`, role, orgId } });

describe('scopeFor', () => {
  test('an admin is unscoped, and sees the whole platform', () => {
    assert.equal(app.scopeFor(as('admin')), null);
  });

  test('an organiser is scoped to their own organisation', () => {
    assert.equal(app.scopeFor(as('organiser', 'org_9')), 'org_9');
  });

  test('an organiser with no orgId is refused, not silently unscoped', () => {
    // The regression this file exists for. Returning null here read as "no
    // filter" to every caller, so the account listed every organisation's
    // events and counted every organisation's revenue — without anything in
    // the response suggesting the figures were not its own.
    assert.throws(
      () => app.scopeFor(as('organiser')),
      (error) => error.status === 403 && /no organisation set/i.test(error.detail)
    );

    // An empty string is a missing scope too, and `where('organiserId','==','')`
    // would quietly match nothing rather than failing.
    assert.throws(() => app.scopeFor(as('organiser', '')), (error) => error.status === 403);
  });

  test('a scanner stays unscoped, because a door needs the whole event list', () => {
    // Scanner tokens deliberately carry no orgId (see claimsFor). Folding them
    // into the organiser rule above would 403 every door at sign-in.
    assert.equal(app.scopeFor(as('scanner')), null);
  });
});

describe('assertOwns', () => {
  test('an admin may act on anything', () => {
    assert.doesNotThrow(() => app.assertOwns(as('admin'), 'org_9'));
    assert.doesNotThrow(() => app.assertOwns(as('admin'), null));
  });

  test('an organiser may act only on their own records', () => {
    assert.doesNotThrow(() => app.assertOwns(as('organiser', 'org_9'), 'org_9'));
    assert.throws(() => app.assertOwns(as('organiser', 'org_9'), 'org_7'), (e) => e.status === 403);
  });

  test('an unscoped organiser owns nothing, including unowned legacy records', () => {
    // null === null would otherwise hand them every record written before
    // events carried an organiserId.
    assert.throws(() => app.assertOwns(as('organiser'), null), (e) => e.status === 403);
  });
});
