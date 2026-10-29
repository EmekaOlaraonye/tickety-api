import { strict as assert } from 'node:assert';
import { test, describe, before, after } from 'node:test';

/**
 * What the rate limiter counts, and who shares a bucket.
 *
 * The bug this file pins down was one of position, not of keying.
 * `@fastify/rate-limit` installs itself through an `onRoute` hook that
 * *appends* its handler to each route's own `onRequest` array. Every guard in
 * this API is a route-level hook, so the order came out as
 * `[requireRole, limiter]` — and a request the guard refused threw before the
 * limiter ran. Authenticated traffic was counted correctly all along. Anything
 * rejected at the gate was not counted at all: tokenless floods, expired-token
 * retry storms and scans for routes that do not exist were unlimited, on a
 * platform that bills per request and scales out to meet whatever arrives.
 *
 * The limiter is now an application-level hook, which runs ahead of every
 * route-level one, and the auth plugin identifies the caller earlier still so
 * the key can be an account rather than an address.
 *
 * Proving any of this needs a verified token, so `verifyIdToken` is stubbed.
 * That is the only thing faked here — the hook order, the limiter, its store
 * and its key are all real.
 */

/** A limit of 2 makes the third request of a bucket the interesting one. */
process.env.RATE_LIMIT_MAX = '2';
process.env.RATE_LIMIT_WINDOW_MS = '60000';

// Imported dynamically, and only after the environment is set: config.js reads
// it once at module evaluation, and a static import would be hoisted above
// these assignments.
const { buildApp } = await import('../src/app.js');
const { auth } = await import('../src/lib/firebase.js');

let app;
let verified = 0;

before(async () => {
  // A token whose text *is* the uid, so a test can say who is calling. It
  // carries no role, so every request below is refused by the route guard --
  // which is the point: the limiter has to have counted it first. No network
  // either: the real SDK fetches Google's signing keys and checks revocation.
  auth.verifyIdToken = async (token) => {
    verified += 1;
    if (token.startsWith('bad')) {
      throw Object.assign(new Error('nope'), { code: 'auth/argument-error' });
    }
    return { uid: token, email: `${token}@example.com`, email_verified: true };
  };

  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

/**
 * One request from `ip`, optionally carrying `token`.
 *
 * `/v1/users` is admin-only and no token here is an admin, so every call is
 * refused by the guard: 401 without a token, 403 with one. That is deliberate
 * -- a refusal proves the limiter counted the request before the guard got to
 * it, and no handler runs, so nothing in this file touches Firestore.
 */
const call = (token, ip) =>
  app.inject({
    method: 'GET',
    url: '/v1/users',
    headers: {
      'x-forwarded-for': ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

describe('what gets counted', () => {
  test('an anonymous flood is limited', async () => {
    // The regression this file exists for. These requests are refused by the
    // route guard, which used to mean they were never counted: a tokenless
    // caller could hold a Cloud Run service open indefinitely for free.
    const ip = '10.0.0.1';

    assert.equal((await call(null, ip)).statusCode, 401);
    assert.equal((await call(null, ip)).statusCode, 401);
    assert.equal((await call(null, ip)).statusCode, 429);
  });

  test('a storm of unusable tokens is limited', async () => {
    // The same path, and the more expensive one: an unverifiable token is
    // rejected only after signature work, and a well-formed stale one costs a
    // revocation lookup.
    const ip = '10.0.0.2';

    assert.equal((await call('bad_1', ip)).statusCode, 401);
    assert.equal((await call('bad_2', ip)).statusCode, 401);
    assert.equal((await call('bad_3', ip)).statusCode, 429);
  });

  test('a caller refused for its role is limited', async () => {
    // 403 rather than 401, and the same reasoning: a customer token looping
    // against an admin route is traffic somebody pays for.
    const ip = '10.0.0.3';

    assert.equal((await call('usr_customer', ip)).statusCode, 403);
    assert.equal((await call('usr_customer', ip)).statusCode, 403);
    assert.equal((await call('usr_customer', ip)).statusCode, 429);
  });

  test('a scan for routes that do not exist is limited', async () => {
    // Application-level hooks run for unmatched routes too, so probing for
    // /v1/admin, /v1/debug and friends counts against the prober.
    const probe = () =>
      app.inject({
        method: 'GET',
        url: `/v1/nope-${Math.random()}`,
        headers: { 'x-forwarded-for': '10.0.0.4' },
      });

    assert.equal((await probe()).statusCode, 404);
    assert.equal((await probe()).statusCode, 404);
    assert.equal((await probe()).statusCode, 429);
  });

  test('a 429 is still problem+json, like every other refusal', async () => {
    const ip = '10.0.0.5';
    await call(null, ip);
    await call(null, ip);
    const limited = await call(null, ip);

    assert.equal(limited.statusCode, 429);
    assert.match(limited.headers['content-type'], /application\/problem\+json/);
    assert.equal(limited.json().type, 'https://tickety.app/problems/rate-limited');
  });

  test('the health probes are never counted', async () => {
    // They set `config: { rateLimit: false }`, which the plugin's own onRoute
    // wiring used to honour and the application-level hook now has to honour
    // itself. Cloud Run polls these constantly from an address this process
    // cannot predict; throttling them would have it recycle healthy
    // instances.
    for (let i = 0; i < 6; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-forwarded-for': '10.0.0.6' },
      });
      assert.equal(response.statusCode, 200);
    }
  });
});

describe('who shares a bucket', () => {
  test('two accounts on one address do not share one', async () => {
    // A mobile carrier puts thousands of subscribers behind a few addresses.
    // Keyed by address, the fourth call here would be a 429 and one heavy
    // user would lock strangers out of their own tickets at a door.
    const ip = '10.1.0.1';

    assert.equal((await call('usr_a', ip)).statusCode, 403);
    assert.equal((await call('usr_a', ip)).statusCode, 403);
    assert.equal((await call('usr_b', ip)).statusCode, 403);
    assert.equal((await call('usr_b', ip)).statusCode, 403);
  });

  test('one account is still limited, wherever it calls from', async () => {
    // The other half: per-account must not mean unlimited. Moving address
    // does not reset the count, which is the point of keying on the account.
    assert.equal((await call('usr_busy', '10.1.0.2')).statusCode, 403);
    assert.equal((await call('usr_busy', '10.1.0.3')).statusCode, 403);
    assert.equal((await call('usr_busy', '10.1.0.4')).statusCode, 429);
  });

  test('an unverifiable token falls back to the address, not to nothing', async () => {
    // `identify` swallows the failure, so the key has to fall through to the
    // address rather than keying on undefined — which would put every bad
    // token on the platform into one shared bucket.
    const limited = await call('bad_x', '10.0.0.1'); // address already exhausted above
    assert.equal(limited.statusCode, 429);

    const fresh = await call('bad_x', '10.1.0.9');
    assert.equal(fresh.statusCode, 401);
  });
});

describe('identifying the caller', () => {
  test('a token is verified once per request, not once per guard', async () => {
    // `identify` runs for every request and the route guard runs again after
    // it. Both call verifyIdToken, which with checkRevoked on is a network
    // round trip, so `authenticate` returns early when the hook has already
    // done the work. Without that, every authenticated request costs two.
    verified = 0;
    await call('usr_counted', '10.2.0.1');
    assert.equal(verified, 1);
  });

  test('an unauthenticated probe is not a verification', async () => {
    verified = 0;
    await call(null, '10.2.0.2');
    assert.equal(verified, 0);
  });

  test('the hook refuses nobody: liveness answers with a broken token', async () => {
    // The failure mode that would matter most. `identify` runs in front of
    // every route including the probes, so if it threw on an unusable token,
    // a stray Authorization header would take the liveness check down with
    // it and Cloud Run would recycle a healthy instance.
    const badToken = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: 'Bearer bad_token' },
    });
    assert.equal(badToken.statusCode, 200);

    const wrongScheme = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(wrongScheme.statusCode, 200);
  });

  test('and grants nobody: being identified is not being authorised', async () => {
    // The hook sets `request.user` for every caller with a working token,
    // customers included. The admin-only route must still turn one away.
    const response = await call('usr_plain', '10.2.0.3');

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().type, 'https://tickety.app/problems/forbidden');
  });

  test('an unverifiable token still produces a 401 from the guard', async () => {
    // `identify` swallowed the failure, so the guard has to be the one that
    // refuses — and it must not leak which way the token was wrong.
    const response = await call('bad_token', '10.2.0.4');

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().type, 'https://tickety.app/problems/unauthorized');

    const body = JSON.stringify(response.json()).toLowerCase();
    for (const leak of ['argument-error', 'nope', 'firebase']) {
      assert.ok(!body.includes(leak), `response leaked "${leak}"`);
    }
  });
});
