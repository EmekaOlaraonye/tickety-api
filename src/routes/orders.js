import { ROLES } from '../lib/roles.js';
import * as orders from '../services/order-service.js';
import { errorResponses, pageSchema, paginationQuery } from '../schemas/common.js';

/**
 * Orders.
 *
 * Admin-only, deliberately. An order can contain seats for several organisers'
 * events and always carries the customer's identity, so showing one to an
 * organiser would leak both a rival's line items and a customer's details.
 * Organisers get their own revenue through `/reports/sales`, which is scoped
 * per line item for exactly this reason.
 */

const orderItem = {
  type: 'object',
  properties: {
    eventId: { type: ['string', 'null'] },
    title: { type: 'string' },
    quantity: { type: 'integer' },
    price: { type: 'number' },
    lineTotal: { type: 'number' },
  },
};

export const orderResource = {
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    userId: { type: ['string', 'null'] },
    customerName: { type: ['string', 'null'] },
    customerEmail: { type: ['string', 'null'] },
    placedAt: { type: ['string', 'null'], format: 'date-time' },
    seats: { type: 'integer' },
    total: {
      type: 'number',
      description: 'Summed from the line items — the figure this API considers authoritative.',
    },
    storedTotal: {
      type: ['number', 'null'],
      description:
        'What the order document records. Differs from `total` when it includes tax, so a ' +
        'mismatch is shown rather than hidden — that gap is what a payment complaint turns on.',
    },
    status: { type: 'string' },
    items: { type: 'array', items: orderItem },
  },
};

export const ticketResource = {
  type: 'object',
  properties: {
    ticketId: { type: 'string' },
    orderId: { type: 'string' },
    eventId: { type: ['string', 'null'] },
    holderName: { type: 'string' },
    seat: { type: 'integer' },
    seatCount: { type: 'integer' },
    status: { type: 'string' },
    issuedAt: { type: ['string', 'null'], format: 'date-time' },
    redeemedAt: { type: ['string', 'null'], format: 'date-time' },
    redeemedBy: { type: ['string', 'null'] },
    voidedAt: { type: ['string', 'null'], format: 'date-time' },
    voidedBy: { type: ['string', 'null'] },
    voidReason: { type: ['string', 'null'] },
    // No `secret`, here or anywhere else.
  },
};

export default async function orderRoutes(fastify) {
  const adminOnly = fastify.requireRole(ROLES.ADMIN);

  fastify.get(
    '',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['orders'],
        summary: 'Recent orders',
        description:
          'Newest first, across every customer. Requires the Orders ' +
          'collection-group index on `orderDate`.',
        querystring: {
          type: 'object',
          properties: {
            ...paginationQuery,
            since: {
              type: 'string',
              format: 'date-time',
              description: 'Only orders placed at or after this instant.',
            },
          },
        },
        response: { 200: pageSchema(orderResource), ...errorResponses },
      },
    },
    async (request) =>
      orders.list({
        limit: request.query.limit ?? 25,
        cursor: request.query.cursor ?? null,
        since: request.query.since ? new Date(request.query.since) : null,
      })
  );

  fastify.get(
    '/:userId/:orderId',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['orders'],
        summary: 'One order, with the tickets it issued',
        description:
          'An order is addressed by the customer who placed it and the order ' +
          'id, because orders are stored per user at Users/{uid}/Orders/{id}.',
        params: {
          type: 'object',
          required: ['userId', 'orderId'],
          properties: {
            userId: { type: 'string', minLength: 1, maxLength: 128 },
            orderId: { type: 'string', minLength: 1, maxLength: 1500 },
          },
        },
        response: {
          200: {
            ...orderResource,
            properties: {
              ...orderResource.properties,
              tickets: { type: 'array', items: ticketResource },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => orders.get(request.params.userId, request.params.orderId)
  );
}
