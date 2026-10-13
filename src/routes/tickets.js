import { ROLES } from '../lib/roles.js';
import * as orders from '../services/order-service.js';
import { errorResponses } from '../schemas/common.js';
import { ticketResource } from './orders.js';

/**
 * Individual issued tickets.
 *
 * There is no list here on purpose — the guest list already lives at
 * `/reports/events/:eventId/attendees`, and a second way to enumerate tickets
 * is a second thing that can leak one. What this file adds is the ability to
 * stop a single ticket, which nothing in the platform could do.
 *
 * Voiding works without a scanner deploy: `redeemTicket` already refuses any
 * ticket whose status is not `valid`, so the write takes effect at every door
 * immediately.
 */

const ticketParam = {
  type: 'object',
  required: ['ticketId'],
  properties: { ticketId: { type: 'string', minLength: 1, maxLength: 1500 } },
};

export default async function ticketRoutes(fastify) {
  // Admin-only. Voiding a ticket takes something away from a paying customer
  // and is felt at a door hours later, by someone who cannot appeal it there.
  const adminOnly = fastify.requireRole(ROLES.ADMIN);

  fastify.post(
    '/:ticketId/void',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['tickets'],
        summary: 'Stop a ticket',
        description:
          'Marks the ticket void, which every door refuses from the moment it ' +
          'is written. Refused for a ticket that has already been admitted: ' +
          'the holder is inside, and attendance figures are derived from that ' +
          'same field.',
        params: ticketParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reason: {
              type: 'string',
              maxLength: 500,
              description: 'Recorded on the ticket. Worth filling in — it is the only trace.',
            },
          },
        },
        response: { 200: ticketResource, ...errorResponses },
      },
    },
    async (request) =>
      orders.setTicketStatus(request.params.ticketId, 'void', {
        // Taken from the verified token, never from the body: who did this is
        // not something a caller gets to assert.
        actor: request.user.email ?? request.user.uid,
        reason: request.body?.reason ?? null,
      })
  );

  fastify.post(
    '/:ticketId/restore',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['tickets'],
        summary: 'Put a voided ticket back',
        description: 'Returns the ticket to valid and clears the void trail.',
        params: ticketParam,
        response: { 200: ticketResource, ...errorResponses },
      },
    },
    async (request) =>
      orders.setTicketStatus(request.params.ticketId, 'valid', {
        actor: request.user.email ?? request.user.uid,
      })
  );
}
