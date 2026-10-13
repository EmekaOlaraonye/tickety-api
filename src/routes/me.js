import * as accounts from '../services/account-service.js';
import * as orders from '../services/order-service.js';
import {
  errorResponses,
  pageSchema,
  paginationQuery,
} from '../schemas/common.js';

/**
 * The signed-in caller's own account.
 *
 * Every other route in this API is guarded by `requireRole`, which asks what
 * an account *is*. These ask only that it is signed in, because what they
 * serve is decided entirely by the uid inside the verified token: a customer
 * reading their own orders, their own seats, their own profile. There is no
 * user id in any path here, so there is no parameter an attacker can change to
 * read somebody else. That is the whole design — the one scoping rule is
 * "whatever this token says you are", and tokens are signed by Google.
 *
 * A staff token works here too, and sees that account's own purchases. An
 * admin is also a person who might buy a ticket.
 *
 * Why these exist at all is worth being honest about, because it is not the
 * reason the admin routes exist. `firestore.rules` already lets a customer
 * read their own profile, their own orders and their own `IssuedTickets`, so
 * the Flutter app is not blocked today the way the admin panel was. What it
 * does instead is embed the storage layout — `Users/{uid}/Orders`,
 * `IssuedTickets where userId ==`, `TKT1:$id:$secret` — in a binary on a
 * phone that cannot be force-updated. Moving those shapes behind this API
 * means the next change to them ships from the server.
 */
export default async function meRoutes(fastify) {
  // Authentication, and deliberately no role check. `requireRole` would 403
  // every customer on the platform, which is who these routes are for.
  const signedIn = fastify.authenticate;

  const profileResource = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      email: { type: 'string' },
      emailVerified: { type: 'boolean' },
      phoneNumber: { type: 'string' },
      profilePicture: { type: 'string' },
      role: {
        type: ['string', 'null'],
        description:
          'Null for an ordinary customer. Lets a client tell in one request ' +
          'whether this account is also a staff account.',
      },
      profileComplete: { type: 'boolean' },
    },
  };

  const holderOrderLine = {
    type: 'object',
    properties: {
      eventId: { type: ['string', 'null'] },
      title: { type: 'string' },
      quantity: { type: 'integer' },
      price: { type: 'number' },
      lineTotal: { type: 'number' },
    },
  };

  const holderOrderResource = {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      placedAt: { type: ['string', 'null'], format: 'date-time' },
      status: { type: 'string' },
      subtotal: { type: ['number', 'null'] },
      tax: { type: ['number', 'null'] },
      total: {
        type: ['number', 'null'],
        description:
          'What this order was charged, tax included — the stored figure, not ' +
          'a sum of the line items. The admin view of the same order reports a ' +
          'line-item sum instead, because it has to attribute each line to an ' +
          'organiser; using that figure here would understate a receipt.',
      },
      region: { type: ['string', 'null'] },
      paymentMethod: { type: ['string', 'null'] },
      seats: { type: 'integer' },
      items: { type: 'array', items: holderOrderLine },
    },
  };

  /**
   * A seat as its holder sees it.
   *
   * The only response schema in this API that declares `qrPayload`, which
   * carries the ticket secret. Everywhere else the schema is what stops a
   * secret escaping; here it is what lets exactly one through, to exactly the
   * account the ticket belongs to.
   */
  const holderTicketResource = {
    type: 'object',
    properties: {
      ticketId: { type: 'string' },
      orderId: { type: 'string' },
      eventId: { type: ['string', 'null'] },
      eventTitle: { type: 'string' },
      eventLocation: { type: 'string' },
      eventStart: { type: ['string', 'null'], format: 'date-time' },
      holderName: { type: 'string' },
      seat: { type: 'integer' },
      seatCount: { type: 'integer' },
      status: {
        type: 'string',
        description: 'valid, redeemed or void. Only `valid` is admitted.',
      },
      issuedAt: { type: ['string', 'null'], format: 'date-time' },
      redeemedAt: { type: ['string', 'null'], format: 'date-time' },
      qrPayload: {
        type: ['string', 'null'],
        description:
          'Exactly what the QR image should encode: `TKT1:<ticketId>:<secret>`. ' +
          'Render it as given rather than reassembling it — the format is ' +
          'versioned here so it can change without an app release. Null means ' +
          'the ticket has no secret stored and cannot be drawn.',
      },
    },
  };

  fastify.get(
    '',
    {
      onRequest: signedIn,
      schema: {
        tags: ['me'],
        summary: 'The signed-in account',
        description:
          'Identity from the token, details from the profile document. A ' +
          'customer who has not saved their details yet gets empty names and ' +
          '`profileComplete: false`, not a 404.',
        response: { 200: profileResource, ...errorResponses },
      },
    },
    async (request) =>
      accounts.getOwnProfile(request.user.uid, {
        email: request.user.email,
        emailVerified: request.user.emailVerified,
        role: request.user.role,
      })
  );

  fastify.get(
    '/orders',
    {
      onRequest: signedIn,
      schema: {
        tags: ['me', 'orders'],
        summary: 'Your order history',
        description: 'Newest first. Scoped to the uid in the token.',
        querystring: { type: 'object', properties: { ...paginationQuery } },
        response: { 200: pageSchema(holderOrderResource), ...errorResponses },
      },
    },
    async (request) =>
      orders.listOwnOrders(request.user.uid, {
        limit: request.query.limit ?? 25,
        cursor: request.query.cursor ?? null,
      })
  );

  fastify.get(
    '/orders/:orderId',
    {
      onRequest: signedIn,
      schema: {
        tags: ['me', 'orders'],
        summary: 'One of your orders, with its tickets',
        description:
          'The order and every seat it issued, in seat order, each with the ' +
          'payload its QR encodes. This is a wallet screen in one request.',
        params: {
          type: 'object',
          required: ['orderId'],
          properties: { orderId: { type: 'string', minLength: 1, maxLength: 1500 } },
        },
        response: {
          200: {
            ...holderOrderResource,
            properties: {
              ...holderOrderResource.properties,
              tickets: { type: 'array', items: holderTicketResource },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => orders.getOwnOrder(request.user.uid, request.params.orderId)
  );

  fastify.get(
    '/tickets',
    {
      onRequest: signedIn,
      schema: {
        tags: ['me', 'tickets'],
        summary: 'Every seat you hold',
        description:
          'Most recently issued first, across all orders and events — the ' +
          'wallet. Needs the IssuedTickets (userId, issuedAt) composite index, ' +
          'which is the same one the app’s own version of this query ' +
          'already depends on.',
        querystring: { type: 'object', properties: { ...paginationQuery } },
        response: { 200: pageSchema(holderTicketResource), ...errorResponses },
      },
    },
    async (request) =>
      orders.listOwnTickets(request.user.uid, {
        limit: request.query.limit ?? 25,
        cursor: request.query.cursor ?? null,
      })
  );

  fastify.get(
    '/tickets/:ticketId',
    {
      onRequest: signedIn,
      schema: {
        tags: ['me', 'tickets'],
        summary: 'One of your seats',
        description:
          'A ticket belonging to another account answers 404, not 403: a 403 ' +
          'would confirm the id exists, and the id is one half of the QR ' +
          'payload — the half that can be read off a screen.',
        params: {
          type: 'object',
          required: ['ticketId'],
          properties: { ticketId: { type: 'string', minLength: 1, maxLength: 1500 } },
        },
        response: { 200: holderTicketResource, ...errorResponses },
      },
    },
    async (request) => orders.getOwnTicket(request.user.uid, request.params.ticketId)
  );
}
