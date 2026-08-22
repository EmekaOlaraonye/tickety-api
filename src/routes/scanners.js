import { ROLES } from '../lib/roles.js';
import * as accounts from '../services/account-service.js';
import { errorResponses, pageSchema } from '../schemas/common.js';

export const accountResource = {
  type: 'object',
  properties: {
    uid: { type: 'string' },
    email: { type: ['string', 'null'] },
    displayName: { type: ['string', 'null'] },
    role: { type: ['string', 'null'] },
    orgId: { type: ['string', 'null'] },
    disabled: { type: 'boolean' },
    lastSignInAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: ['string', 'null'], format: 'date-time' },
    phoneNumber: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    // Note there is no `password` field anywhere in this schema, on purpose.
  },
};

const uidParam = {
  type: 'object',
  required: ['uid'],
  properties: { uid: { type: 'string', minLength: 1, maxLength: 128 } },
};

export default async function scannerRoutes(fastify) {
  const manage = fastify.requireRole(ROLES.ADMIN, ROLES.ORGANISER);

  fastify.get(
    '',
    {
      onRequest: manage,
      schema: {
        tags: ['scanners'],
        summary: 'List door accounts',
        response: { 200: pageSchema(accountResource), ...errorResponses },
      },
    },
    async (request) =>
      accounts.listAccounts({
        role: ROLES.SCANNER,
        orgId: fastify.scopeFor(request),
      })
  );

  fastify.post(
    '',
    {
      onRequest: manage,
      schema: {
        tags: ['scanners'],
        summary: 'Create a door account',
        description:
          'Creates the account with a random password that is immediately ' +
          'discarded, grants the scanner role, and returns a one-time link ' +
          'for the holder to set their own password. No password is ever ' +
          'chosen by, sent to, or stored by this API.',
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email', maxLength: 320 },
            displayName: { type: 'string', maxLength: 120 },
            phoneNumber: { type: 'string', maxLength: 32 },
            notes: { type: 'string', maxLength: 500 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              account: accountResource,
              setPasswordLink: {
                type: 'string',
                description:
                  'One-time link. Show it to the holder or send it to them; ' +
                  'it is not stored after this response.',
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await accounts.createAccount({
        ...request.body,
        role: ROLES.SCANNER,
        // A scanner belongs to whoever created it. Admin-created scanners are
        // unscoped and can work any door.
        orgId: fastify.scopeFor(request),
      });

      reply.code(201);
      return result;
    }
  );

  fastify.get(
    '/:uid',
    {
      onRequest: manage,
      schema: {
        tags: ['scanners'],
        summary: 'Fetch one door account',
        params: uidParam,
        response: { 200: accountResource, ...errorResponses },
      },
    },
    async (request) => {
      const account = await accounts.getAccount(request.params.uid);
      if (request.user.role === ROLES.ORGANISER) {
        fastify.assertOwns(request, account.orgId);
      }
      return account;
    }
  );

  fastify.post(
    '/:uid/disable',
    {
      onRequest: manage,
      schema: {
        tags: ['scanners'],
        summary: 'Suspend or restore a door account',
        description:
          'Preferred over deletion for a lost phone: it stops the account ' +
          'immediately and revokes its sessions, while keeping the record of ' +
          'what it admitted intact.',
        params: uidParam,
        body: {
          type: 'object',
          required: ['disabled'],
          additionalProperties: false,
          properties: { disabled: { type: 'boolean' } },
        },
        response: { 200: accountResource, ...errorResponses },
      },
    },
    async (request) => {
      const account = await accounts.getAccount(request.params.uid);
      if (request.user.role === ROLES.ORGANISER) {
        fastify.assertOwns(request, account.orgId);
      }
      return accounts.setDisabled(request.params.uid, request.body.disabled);
    }
  );

  fastify.post(
    '/:uid/password-reset-link',
    {
      onRequest: manage,
      schema: {
        tags: ['scanners'],
        summary: 'Issue a new set-password link',
        params: uidParam,
        response: {
          200: {
            type: 'object',
            properties: { setPasswordLink: { type: 'string' } },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const account = await accounts.getAccount(request.params.uid);
      if (request.user.role === ROLES.ORGANISER) {
        fastify.assertOwns(request, account.orgId);
      }
      return { setPasswordLink: await accounts.passwordResetLink(request.params.uid) };
    }
  );

  fastify.delete(
    '/:uid',
    {
      // Deletion is admin-only: it orphans the `redeemedBy` on every ticket
      // that account ever admitted.
      onRequest: fastify.requireRole(ROLES.ADMIN),
      schema: {
        tags: ['scanners'],
        summary: 'Delete a door account',
        params: uidParam,
        response: { 204: { type: 'null' }, ...errorResponses },
      },
    },
    async (request, reply) => {
      await accounts.deleteAccount(request.params.uid);
      reply.code(204);
      return null;
    }
  );
}
