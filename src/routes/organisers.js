import { ROLES, ALL_ROLES } from '../lib/roles.js';
import * as accounts from '../services/account-service.js';
import { errorResponses, pageSchema } from '../schemas/common.js';
import { accountResource } from './scanners.js';

const uidParam = {
  type: 'object',
  required: ['uid'],
  properties: { uid: { type: 'string', minLength: 1, maxLength: 128 } },
};

/**
 * Event organiser accounts.
 *
 * Admin-only throughout: an organiser cannot create another organiser, or
 * change their own scope. Otherwise `orgId` would be self-assignable, and the
 * scoping that keeps one organiser out of another's sales figures would mean
 * nothing.
 */
export default async function organiserRoutes(fastify) {
  const adminOnly = fastify.requireRole(ROLES.ADMIN);

  fastify.get(
    '',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['organisers'],
        summary: 'List organiser accounts',
        response: { 200: pageSchema(accountResource), ...errorResponses },
      },
    },
    async () => accounts.listAccounts({ role: ROLES.ORGANISER })
  );

  fastify.post(
    '',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['organisers'],
        summary: 'Create an organiser account',
        body: {
          type: 'object',
          required: ['email', 'orgId'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email', maxLength: 320 },
            displayName: { type: 'string', maxLength: 120 },
            orgId: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              description:
                'Scopes this organiser. Their events, scanners and reports ' +
                'are filtered to it, and they cannot change it themselves.',
            },
            phoneNumber: { type: 'string', maxLength: 32 },
            notes: { type: 'string', maxLength: 500 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              account: accountResource,
              setPasswordLink: { type: 'string' },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await accounts.createAccount({
        ...request.body,
        role: ROLES.ORGANISER,
      });
      reply.code(201);
      return result;
    }
  );

  fastify.patch(
    '/:uid/role',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['organisers'],
        summary: 'Change an account’s role',
        description:
          'Also revokes the account’s refresh tokens. Without that, a ' +
          'demoted account keeps its old privileges until its ID token ' +
          'expires — up to an hour after you removed them.',
        params: uidParam,
        body: {
          type: 'object',
          required: ['role'],
          additionalProperties: false,
          properties: {
            role: {
              type: ['string', 'null'],
              enum: [...ALL_ROLES, null],
              description: 'Null demotes the account to an ordinary customer.',
            },
            orgId: { type: ['string', 'null'], maxLength: 100 },
          },
        },
        response: { 200: accountResource, ...errorResponses },
      },
    },
    async (request) =>
      accounts.setRole(request.params.uid, {
        role: request.body.role,
        orgId: request.body.orgId ?? null,
      })
  );

  fastify.post(
    '/:uid/disable',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['organisers'],
        summary: 'Suspend or restore an organiser',
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
    async (request) =>
      accounts.setDisabled(request.params.uid, request.body.disabled)
  );
}
