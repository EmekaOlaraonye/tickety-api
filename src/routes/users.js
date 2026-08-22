import { ROLES } from '../lib/roles.js';
import * as accounts from '../services/account-service.js';
import {
  errorResponses,
  idParam,
  pageSchema,
  paginationQuery,
} from '../schemas/common.js';

const customerResource = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    email: { type: 'string' },
    phoneNumber: { type: 'string' },
    profilePicture: { type: 'string' },
  },
};

/**
 * Customer accounts.
 *
 * Admin-only. An organiser has no business browsing the customer list: they
 * see who is coming to *their* events through the attendee report, which is
 * scoped, rather than the whole platform's user base.
 */
export default async function userRoutes(fastify) {
  const adminOnly = fastify.requireRole(ROLES.ADMIN);

  fastify.get(
    '',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['users'],
        summary: 'List customers',
        description:
          'Reads through the Admin SDK. The admin panel previously called ' +
          'getDocs(collection(db, "Users")) from the browser, which security ' +
          'rules deny — a customer may read only their own document — so the ' +
          'table always rendered empty.',
        querystring: { type: 'object', properties: { ...paginationQuery } },
        response: { 200: pageSchema(customerResource), ...errorResponses },
      },
    },
    async (request) =>
      accounts.listCustomers({
        limit: request.query.limit ?? 25,
        cursor: request.query.cursor ?? null,
      })
  );

  fastify.delete(
    '/:id',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['users'],
        summary: 'Delete a customer account',
        description:
          'Removes the auth account and the profile document. Orders and ' +
          'issued tickets are deliberately left in place: they are financial ' +
          'and admission records, and deleting them would corrupt event ' +
          'attendance history.',
        params: idParam,
        response: { 204: { type: 'null' }, ...errorResponses },
      },
    },
    async (request, reply) => {
      await accounts.deleteAccount(request.params.id);
      reply.code(204);
      return null;
    }
  );
}
