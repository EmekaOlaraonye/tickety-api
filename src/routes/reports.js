import { ROLES } from '../lib/roles.js';
import * as reports from '../services/report-service.js';
import * as events from '../services/event-service.js';
import {
  errorResponses,
  pageSchema,
  paginationQuery,
} from '../schemas/common.js';

const attendeeResource = {
  type: 'object',
  properties: {
    ticketId: { type: 'string' },
    orderId: { type: 'string' },
    holderName: { type: 'string' },
    seat: { type: 'integer' },
    seatCount: { type: 'integer' },
    status: { type: 'string' },
    issuedAt: { type: ['string', 'null'], format: 'date-time' },
    redeemedAt: { type: ['string', 'null'], format: 'date-time' },
    redeemedBy: { type: ['string', 'null'] },
    // The response schema is the last line of defence against `secret`
    // escaping: Fastify serialises only declared properties.
  },
};

export default async function reportRoutes(fastify) {
  const anyStaff = fastify.requireRole(ROLES.ADMIN, ROLES.ORGANISER, ROLES.SCANNER);
  const management = fastify.requireRole(ROLES.ADMIN, ROLES.ORGANISER);

  /** Throws unless the caller may see this event's figures. */
  async function assertEventVisible(request) {
    const event = await events.get(request.params.eventId);
    if (request.user.role === ROLES.ORGANISER) {
      fastify.assertOwns(request, event.organiserId);
    }
    return event;
  }

  fastify.get(
    '/events/:eventId/attendance',
    {
      // Scanners included: this is what the door's attendance screen reads.
      onRequest: anyStaff,
      schema: {
        tags: ['reports'],
        summary: 'Admission figures for one event',
        params: {
          type: 'object',
          required: ['eventId'],
          properties: { eventId: { type: 'string', minLength: 1 } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              eventId: { type: 'string' },
              issued: { type: 'integer' },
              admitted: { type: 'integer' },
              outstanding: { type: 'integer' },
              admittedPercent: { type: 'integer' },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      if (request.user.role === ROLES.ORGANISER) await assertEventVisible(request);
      return reports.eventAttendance(request.params.eventId);
    }
  );

  fastify.get(
    '/events/:eventId/attendees',
    {
      // Deliberately not scanners: a door needs counts, not the guest list.
      onRequest: management,
      schema: {
        tags: ['reports'],
        summary: 'Guest list for one event',
        description:
          'Ticket secrets are never included. This data is unreachable from ' +
          'any browser or app — rules deny IssuedTickets to every client — ' +
          'so it is served here with the secret stripped.',
        params: {
          type: 'object',
          required: ['eventId'],
          properties: { eventId: { type: 'string', minLength: 1 } },
        },
        querystring: { type: 'object', properties: { ...paginationQuery } },
        response: { 200: pageSchema(attendeeResource), ...errorResponses },
      },
    },
    async (request) => {
      await assertEventVisible(request);
      return reports.eventAttendees(request.params.eventId, {
        limit: request.query.limit ?? 50,
        cursor: request.query.cursor ?? null,
      });
    }
  );

  fastify.get(
    '/sales',
    {
      onRequest: management,
      schema: {
        tags: ['reports'],
        summary: 'Sales summary',
        description:
          'Organisers see only revenue from their own events, including ' +
          'their share of an order that spanned several organisers.',
        querystring: {
          type: 'object',
          properties: {
            since: {
              type: 'string',
              format: 'date-time',
              description: 'Only count orders placed at or after this instant.',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              orderCount: { type: 'integer' },
              seatsSold: { type: 'integer' },
              grossRevenue: { type: 'number' },
              byEvent: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    eventId: { type: ['string', 'null'] },
                    title: { type: 'string' },
                    seatsSold: { type: 'integer' },
                    revenue: { type: 'number' },
                  },
                },
              },
              truncated: {
                type: 'boolean',
                description:
                  'True when the scan hit its cap; narrow the window with ' +
                  '`since` for a complete figure.',
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const scope = fastify.scopeFor(request);

      // An organiser's revenue is defined by which events are theirs, so the
      // event list is resolved first and used as the filter.
      let organiserEventIds = null;
      if (scope) {
        const owned = await events.list({ organiserId: scope, limit: 100 });
        organiserEventIds = new Set(owned.items.map((event) => event.id));
      }

      return reports.sales({
        organiserEventIds,
        since: request.query.since ? new Date(request.query.since) : null,
      });
    }
  );
}
