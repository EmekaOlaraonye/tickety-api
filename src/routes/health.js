/**
 * Liveness and readiness.
 *
 * Unauthenticated on purpose — a load balancer has no token — and deliberately
 * says almost nothing. A health endpoint that reports versions, hostnames or
 * dependency states is a free map of the system for anyone who finds it.
 */
export default async function healthRoutes(fastify) {
  fastify.get(
    '/healthz',
    {
      // Probes run constantly; they must not consume the request budget that
      // real callers share.
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string' } },
          },
        },
      },
    },
    async () => ({ status: 'ok' })
  );

  fastify.get(
    '/readyz',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Readiness probe',
        description:
          'Confirms Firestore is reachable. Returns 503 when it is not, so ' +
          'Cloud Run stops routing traffic to an instance that cannot serve.',
        response: {
          200: { type: 'object', properties: { status: { type: 'string' } } },
          503: { type: 'object', properties: { status: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      try {
        // Cheapest possible round trip that proves credentials and network.
        const { db } = await import('../lib/firebase.js');
        await db.listCollections();
        return { status: 'ready' };
      } catch (error) {
        request.log.error({ err: error }, 'readiness check failed');
        reply.code(503);
        return { status: 'unavailable' };
      }
    }
  );
}
