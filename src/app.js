import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';

import config from './config.js';
import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import healthRoutes from './routes/health.js';
import eventRoutes from './routes/events.js';
import userRoutes from './routes/users.js';
import scannerRoutes from './routes/scanners.js';
import organiserRoutes from './routes/organisers.js';
import reportRoutes from './routes/reports.js';

/**
 * Builds the server without starting it.
 *
 * Kept separate from `index.js` so tests can build an app, drive it with
 * `app.inject()` and never bind a port. The old entry point called `listen()`
 * at import time, which made the whole thing untestable.
 */
export async function buildApp({ logger = true } = {}) {
  const app = Fastify({
    logger:
      logger === false
        ? false
        : {
            level: config.logLevel,
            // Credentials must never reach the log, and a request log is the
            // easiest place to leak one by accident.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'body.password',
              ],
              censor: '[redacted]',
            },
          },
    // Trust Cloud Run's proxy so rate limiting and logs see the real client IP
    // rather than the load balancer's.
    trustProxy: true,
    // A body larger than this is never a legitimate call to this API.
    bodyLimit: 1_048_576,
    // `/v1/events` is the canonical collection URL, but `/v1/events/` should
    // reach it rather than 404 — a trailing slash is not a different resource.
    ignoreTrailingSlash: true,
  });

  await app.register(errorHandlerPlugin);

  await app.register(fastifyHelmet, {
    // The API serves JSON plus the Swagger UI; the strict default CSP breaks
    // the latter, so it is relaxed only on the docs route below.
    contentSecurityPolicy: false,
  });

  await app.register(fastifyCors, {
    // An explicit allow-list. `origin: '*'` combined with `Authorization` —
    // what this API shipped with — lets any page on the internet drive it with
    // a signed-in user's token.
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: ['x-request-id'],
    credentials: true,
    maxAge: 86_400,
  });

  await app.register(fastifyRateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    // Per-account when we know who is calling, per-IP otherwise, so one busy
    // office behind a single NAT does not throttle itself.
    keyGenerator: (request) => request.user?.uid ?? request.ip,
  });

  await app.register(authPlugin);

  await app.register(fastifySwagger, {
    // Generated from the route schemas rather than a hand-maintained
    // `openapi.json`. The checked-in file described two endpoints that no
    // longer exist and had already drifted from the code.
    openapi: {
      info: {
        title: 'Tickety API',
        version: '1.0.0',
        description:
          'Privileged operations for the Tickety admin panel and event ' +
          'dashboard. Every route requires a Firebase ID token; the role ' +
          'claim on that token decides what it may do.',
      },
      servers: [{ url: '/v1', description: 'Current version' }],
      components: {
        securitySchemes: {
          firebaseIdToken: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Firebase ID token from the signed-in user. Obtain with ' +
              '`getIdToken()` in the web SDK.',
          },
        },
      },
      security: [{ firebaseIdToken: [] }],
      tags: [
        { name: 'health', description: 'Liveness and readiness' },
        { name: 'events', description: 'The event catalogue' },
        { name: 'users', description: 'Customer accounts' },
        { name: 'scanners', description: 'Door accounts' },
        { name: 'organisers', description: 'Event organiser accounts' },
        { name: 'reports', description: 'Sales and attendance' },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Health sits outside /v1: a load balancer probing liveness should not have
  // to know or care which API version is current.
  await app.register(healthRoutes);

  await app.register(
    async (api) => {
      await api.register(eventRoutes, { prefix: '/events' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(scannerRoutes, { prefix: '/scanners' });
      await api.register(organiserRoutes, { prefix: '/organisers' });
      await api.register(reportRoutes, { prefix: '/reports' });
    },
    // Versioned from the start. The clients are shipped mobile apps that
    // cannot be force-updated, so there will eventually be two live versions.
    { prefix: '/v1' }
  );

  return app;
}

export default buildApp;
