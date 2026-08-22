import { ROLES } from '../lib/roles.js';
import * as events from '../services/event-service.js';
import {
  errorResponses,
  idParam,
  pageSchema,
  paginationQuery,
} from '../schemas/common.js';

const eventResource = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    category: { type: 'string' },
    description: { type: 'string' },
    location: { type: 'string' },
    startsAt: { type: ['string', 'null'], format: 'date-time' },
    rawDate: {
      type: ['string', 'null'],
      description:
        'Set only when the stored date could not be parsed — a legacy row ' +
        'written as free text. Offer to repair it.',
    },
    durationMinutes: { type: ['integer', 'null'] },
    price: { type: 'number' },
    stock: { type: 'integer' },
    thumbnail: { type: 'string' },
    ticketType: { type: ['string', 'null'] },
    isFeatured: { type: 'boolean' },
    organiserId: { type: ['string', 'null'] },
    createdAt: { type: ['string', 'null'], format: 'date-time' },
    updatedAt: { type: ['string', 'null'], format: 'date-time' },
  },
};

/** Fields a caller may set. Note the absence of `id` — the server assigns it. */
const writableEvent = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  category: { type: 'string', maxLength: 60 },
  description: { type: 'string', maxLength: 5000 },
  location: { type: 'string', maxLength: 200 },
  startsAt: {
    type: 'string',
    format: 'date-time',
    description: 'ISO 8601. Stored as a real timestamp, never a locale string.',
  },
  durationMinutes: { type: 'integer', minimum: 0, maximum: 60 * 24 * 30 },
  price: { type: 'number', minimum: 0, maximum: 1_000_000 },
  stock: { type: 'integer', minimum: 0, maximum: 1_000_000 },
  thumbnail: { type: 'string', maxLength: 2000 },
  ticketType: { type: 'string', maxLength: 60 },
  isFeatured: { type: 'boolean' },
};

export default async function eventRoutes(fastify) {
  const manage = fastify.requireRole(ROLES.ADMIN, ROLES.ORGANISER);

  fastify.get(
    '',
    {
      // Scanners list events too — that is how the door picks which event it
      // is working.
      onRequest: fastify.requireRole(ROLES.ADMIN, ROLES.ORGANISER, ROLES.SCANNER),
      schema: {
        tags: ['events'],
        summary: 'List events',
        querystring: {
          type: 'object',
          properties: {
            ...paginationQuery,
            organiserId: {
              type: 'string',
              description: 'Admins only. Organisers always see their own.',
            },
          },
        },
        response: { 200: pageSchema(eventResource), ...errorResponses },
      },
    },
    async (request) => {
      // An organiser's scope is taken from their token, never from the query —
      // otherwise `?organiserId=someone-else` reads another organiser's book.
      const scope = fastify.scopeFor(request);
      const organiserId = scope ?? request.query.organiserId ?? null;

      return events.list({
        organiserId,
        limit: request.query.limit ?? 25,
        cursor: request.query.cursor ?? null,
      });
    }
  );

  fastify.get(
    '/:id',
    {
      onRequest: fastify.requireRole(ROLES.ADMIN, ROLES.ORGANISER, ROLES.SCANNER),
      schema: {
        tags: ['events'],
        summary: 'Fetch one event',
        params: idParam,
        response: { 200: eventResource, ...errorResponses },
      },
    },
    async (request) => {
      const event = await events.get(request.params.id);

      // A scanner may read any event; an organiser only their own.
      if (request.user.role === ROLES.ORGANISER) {
        fastify.assertOwns(request, event.organiserId);
      }
      return event;
    }
  );

  fastify.post(
    '',
    {
      onRequest: manage,
      schema: {
        tags: ['events'],
        summary: 'Create an event',
        body: {
          type: 'object',
          required: ['title', 'startsAt'],
          additionalProperties: false,
          properties: writableEvent,
        },
        response: { 201: eventResource, ...errorResponses },
      },
    },
    async (request, reply) => {
      const created = await events.create({
        ...request.body,
        // An organiser can only create under their own scope; an admin creating
        // an event owns it at platform level until assigned.
        organiserId: fastify.scopeFor(request),
      });

      reply.code(201).header('location', `/v1/events/${created.id}`);
      return created;
    }
  );

  fastify.patch(
    '/:id',
    {
      onRequest: manage,
      schema: {
        tags: ['events'],
        summary: 'Update an event',
        params: idParam,
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          // Every field optional: PATCH is a partial update, so omitting a
          // field must leave it alone rather than clearing it.
          properties: {
            ...writableEvent,
            organiserId: {
              type: ['string', 'null'],
              description: 'Admins only. Reassigns the event to an organiser.',
            },
          },
        },
        response: { 200: eventResource, ...errorResponses },
      },
    },
    async (request) => {
      const existing = await events.get(request.params.id);
      if (request.user.role === ROLES.ORGANISER) {
        fastify.assertOwns(request, existing.organiserId);
      }

      const patch = { ...request.body };
      // Reassignment is an admin power; an organiser must not be able to hand
      // their event to someone else, or take one.
      if (request.user.role !== ROLES.ADMIN) delete patch.organiserId;

      return events.update(request.params.id, patch);
    }
  );

  fastify.delete(
    '/:id',
    {
      onRequest: manage,
      schema: {
        tags: ['events'],
        summary: 'Delete an event',
        description:
          'Refuses while tickets are outstanding, because deleting the event ' +
          'would strand every ticket already sold for it.',
        params: idParam,
        querystring: {
          type: 'object',
          properties: {
            force: {
              type: 'boolean',
              default: false,
              description: 'Admins only. Deletes even with tickets issued.',
            },
          },
        },
        response: { 204: { type: 'null' }, ...errorResponses },
      },
    },
    async (request, reply) => {
      const existing = await events.get(request.params.id);
      if (request.user.role === ROLES.ORGANISER) {
        fastify.assertOwns(request, existing.organiserId);
      }

      await events.remove(request.params.id, {
        force: request.query.force === true && request.user.role === ROLES.ADMIN,
      });

      reply.code(204);
      return null;
    }
  );
}
