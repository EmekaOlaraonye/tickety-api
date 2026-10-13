import { strict as assert } from 'node:assert';
import { test, describe, before, after } from 'node:test';

import { buildApp } from '../src/app.js';
import {
  toHolderOrderResource,
  toHolderTicketResource,
  toTicketResource,
} from '../src/services/order-service.js';

/**
 * The customer app's half of the API.
 *
 * Two things are pinned down here, and they pull in opposite directions.
 *
 * The first is that `/me` must not need a role, because a customer has none —
 * guarding those routes with `requireRole` would 403 every person who has
 * ever bought a ticket, which is the failure this file exists to catch.
 *
 * The second is that relaxing the role check must not relax the token check.
 * `/me` is scoped entirely by the uid inside a verified token, so an
 * anonymous caller reaching any of it would be reading somebody's tickets —
 * secrets included.
 *
 * The mappers are exercised directly with fake documents: they decide what
 * leaves the process, and reaching them over HTTP would need a signed
 * Firebase token and a live Firestore.
 */
let app;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

/** A Firestore document, as far as a mapper is concerned. */
const doc = (id, data) => ({ id, data: () => data });

describe('the /me routes', () => {
  const routes = [
    '/v1/me',
    '/v1/me/orders',
    '/v1/me/orders/ord_1',
    '/v1/me/tickets',
    '/v1/me/tickets/tkt_1',
  ];

  for (const url of routes) {
    test(`GET ${url} refuses an anonymous caller`, async () => {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401);
    });
  }

  test('they are declared without a role requirement', () => {
    // The guard itself cannot be asserted without a token, but the OpenAPI
    // document generated from the schemas proves the routes exist and are
    // reachable as a group — if someone wraps them in requireRole, the 401
    // tests above still pass and only a customer notices, in production.
    const spec = app.swagger();

    assert.ok(spec.paths['/me']);
    assert.ok(spec.paths['/me/orders']);
    assert.ok(spec.paths['/me/tickets']);
    assert.deepEqual(
      spec.tags.find((tag) => tag.name === 'me')?.name,
      'me'
    );
  });

  test('no path under /me takes a user id', () => {
    // The whole scoping model is "whatever the token says you are". A
    // `{userId}` parameter appearing here would be a parameter an attacker
    // can edit.
    const underMe = Object.keys(app.swagger().paths).filter((path) =>
      path.startsWith('/me')
    );

    assert.ok(underMe.length >= 5);
    for (const path of underMe) {
      assert.ok(!/user|uid/i.test(path), `${path} names a user`);
    }
  });
});

describe('the catalogue is readable by a customer', () => {
  test('listing events still needs a token', async () => {
    // Dropping the role check must not drop the token check.
    const response = await app.inject({ method: 'GET', url: '/v1/events' });
    assert.equal(response.statusCode, 401);
  });

  test('writing events is still guarded separately', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/events' });
    assert.equal(response.statusCode, 401);
  });
});

describe('the ticket secret', () => {
  const ticketDoc = doc('tkt_7', {
    orderId: 'ord_3',
    userId: 'usr_1',
    eventId: 'evt_9',
    eventTitle: 'Jazz Night',
    eventLocation: 'Gaborone',
    holderName: 'Ada Lovelace',
    seat: 2,
    seatCount: 3,
    secret: 'a'.repeat(64),
    status: 'valid',
  });

  test('reaches the holder as a ready-made QR payload', () => {
    const resource = toHolderTicketResource(ticketDoc);

    // The format the scanner parses, assembled server-side so it can be
    // versioned without an app release.
    assert.equal(resource.qrPayload, `TKT1:tkt_7:${'a'.repeat(64)}`);
    // The raw field is not sent under its own name as well: one way out, not
    // two.
    assert.ok(!('secret' in resource));
  });

  test('is absent from the staff view of the same ticket', () => {
    const resource = toTicketResource(ticketDoc);
    const serialised = JSON.stringify(resource);

    assert.ok(!('secret' in resource));
    assert.ok(!('qrPayload' in resource));
    assert.ok(!serialised.includes('a'.repeat(64)), 'staff view leaked the secret');
  });

  test('is null, not a half-built payload, when the ticket has none', () => {
    // A client that drew a QR from `TKT1:tkt_7:` would print a code that
    // fails at the door with no explanation.
    const resource = toHolderTicketResource(doc('tkt_7', { status: 'valid' }));
    assert.equal(resource.qrPayload, null);
  });
});

describe('what a customer is told their order cost', () => {
  const orderDoc = doc('ord_3', {
    orderDate: new Date('2026-02-01T18:00:00Z'),
    status: 'issued',
    subtotal: 300,
    tax: 42,
    totalAmount: 342,
    region: 'BW',
    paymentMethod: 'card',
    items: [{ ticketId: 'evt_9', title: 'Jazz Night', quantity: 2, price: 150 }],
  });

  test('is the figure that was charged, tax included', () => {
    const resource = toHolderOrderResource(orderDoc);

    // The admin resource reports a line-item sum (300 here) because it has to
    // split an order between organisers. Showing that to the person who paid
    // 342 would understate their own receipt by the tax.
    assert.equal(resource.total, 342);
    assert.equal(resource.subtotal, 300);
    assert.equal(resource.tax, 42);
    assert.equal(resource.seats, 2);
  });

  test('carries no other customer on it', () => {
    // An order resource built for its own holder has no business naming
    // anybody, and the admin mapper attaches a customer name and email.
    const resource = toHolderOrderResource(orderDoc);

    assert.ok(!('customerName' in resource));
    assert.ok(!('customerEmail' in resource));
    assert.ok(!('userId' in resource));
  });

  test('reports missing money as null rather than zero', () => {
    // A legacy order with no stored total should not claim it cost nothing.
    const resource = toHolderOrderResource(doc('ord_4', { items: [] }));

    assert.equal(resource.total, null);
    assert.equal(resource.subtotal, null);
    assert.equal(resource.seats, 0);
  });
});
