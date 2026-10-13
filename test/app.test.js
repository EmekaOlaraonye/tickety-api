import { strict as assert } from 'node:assert';
import { test, describe, before, after } from 'node:test';

import { buildApp } from '../src/app.js';

/**
 * Route-level behaviour, driven through `app.inject()` so nothing binds a port
 * and no Firebase credentials are needed. Anything past the auth gate would
 * need the emulator; these cover the gate itself, which is the part that must
 * never regress.
 */
let app;

before(async () => {
  app = await buildApp({ logger: false });
  // `app.swagger()` is only available once plugins have finished booting.
  await app.ready();
});

after(async () => {
  await app.close();
});

describe('health', () => {
  test('liveness needs no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });
});

describe('authentication', () => {
  const protectedRoutes = [
    ['GET', '/v1/events'],
    ['POST', '/v1/events'],
    ['GET', '/v1/users'],
    ['GET', '/v1/scanners'],
    ['POST', '/v1/scanners'],
    ['GET', '/v1/organisers'],
    ['GET', '/v1/reports/sales'],
    ['GET', '/v1/reports/events/evt_1/attendees'],
    ['GET', '/v1/orders'],
    ['GET', '/v1/orders/usr_1/ord_1'],
    ['GET', '/v1/users/usr_1/orders'],
    // A ticket document is the one record a scanner may read directly, so the
    // gate in front of it carries more than usual.
    ['GET', '/v1/tickets/tkt_1'],
    // Voiding a ticket is felt at a door hours later by someone who cannot
    // appeal it there, so the gate in front of it must never regress.
    ['POST', '/v1/tickets/tkt_1/void'],
    ['POST', '/v1/tickets/tkt_1/restore'],
  ];

  for (const [method, url] of protectedRoutes) {
    test(`${method} ${url} refuses an anonymous caller`, async () => {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 401);
    });
  }

  test('rejects a non-Bearer scheme', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(response.statusCode, 401);
  });

  test('rejects a Bearer header with no token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: { authorization: 'Bearer' },
    });
    assert.equal(response.statusCode, 401);
  });
});

describe('error shape', () => {
  test('errors are problem+json with a stable type', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/events' });

    assert.match(response.headers['content-type'], /application\/problem\+json/);
    const body = response.json();
    assert.equal(body.status, 401);
    assert.equal(body.type, 'https://tickety.app/problems/unauthorized');
    assert.equal(body.instance, '/v1/events');
    // Quotable by a user reporting a failure.
    assert.ok(body.requestId);
  });

  test('an unknown route is a 404 problem, not an HTML page', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().type, 'https://tickety.app/problems/not-found');
  });

  test('a rejected token reveals nothing about our internals', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/events',
      headers: { authorization: 'Bearer not-a-real-token' },
    });

    assert.equal(response.statusCode, 401);
    const body = JSON.stringify(response.json()).toLowerCase();

    // Telling callers their OWN token is expired or malformed is good UX and
    // leaks nothing — they already hold it. What must never appear is our
    // internals: project ids, signing keys, file paths, stack frames.
    for (const leak of ['ticketycustomer', 'serviceaccount', 'privatekey',
                        'googleapis', 'at object.', '.js:', 'firebase-admin']) {
      assert.ok(!body.includes(leak), `response leaked "${leak}": ${body}`);
    }
    assert.ok(!('stack' in response.json()));
  });
});

describe('organiser scoping', () => {
  // The decorators are exercised directly: reaching them through a route would
  // need a signed Firebase token, and what matters here is the decision they
  // make about a token's claims, not the transport.
  const as = (role, orgId = null) => ({ user: { uid: `uid_${role}`, role, orgId } });

  test('an admin is unscoped, and sees the whole platform', () => {
    assert.equal(app.scopeFor(as('admin')), null);
  });

  test('an organiser is scoped to their own organisation', () => {
    assert.equal(app.scopeFor(as('organiser', 'org_9')), 'org_9');
  });

  test('an organiser with no orgId is refused, not silently unscoped', () => {
    // The regression this file exists for. Returning null here read as "no
    // filter" to every caller, so the account listed every organisation's
    // events and counted every organisation's revenue.
    assert.throws(
      () => app.scopeFor(as('organiser')),
      (error) => error.status === 403 && /no organisation set/i.test(error.detail)
    );

    assert.throws(() => app.scopeFor(as('organiser', '')), (error) => error.status === 403);
  });

  test('a scanner stays unscoped, because a door needs the whole event list', () => {
    // Scanner tokens deliberately carry no orgId (see claimsFor). Folding them
    // into the organiser rule above would 403 every door at sign-in.
    assert.equal(app.scopeFor(as('scanner')), null);
  });
});

describe('ownership', () => {
  const as = (role, orgId = null) => ({ user: { uid: `uid_${role}`, role, orgId } });

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

describe('documentation', () => {
  test('serves an OpenAPI document generated from the route schemas', async () => {
    const spec = app.swagger();

    assert.equal(spec.info.title, 'Tickety API');
    assert.ok(spec.paths['/events']);
    assert.ok(spec.paths['/scanners']);
    // The old checked-in openapi.json described endpoints that no longer
    // existed; generating it from the schemas keeps them in step.
    assert.ok(!spec.paths['/users/getusers']);
  });

  test('every scanner response schema omits password fields', () => {
    const spec = app.swagger();
    const serialised = JSON.stringify(spec.paths['/scanners']);

    assert.ok(!/"password"/i.test(serialised));
    // A set-password *link* is fine; a password is not.
    assert.ok(/setPasswordLink/.test(serialised));
  });
});
