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
