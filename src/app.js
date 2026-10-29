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
import meRoutes from './routes/me.js';
import userRoutes from './routes/users.js';
import scannerRoutes from './routes/scanners.js';
import organiserRoutes from './routes/organisers.js';
import reportRoutes from './routes/reports.js';
import orderRoutes from './routes/orders.js';
import ticketRoutes from './routes/tickets.js';

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

  // Before the rate limiter, and that order is load-bearing: the auth plugin
  // installs the `onRequest` hook that identifies the caller, and the limiter
  // below needs a caller to key on.
  await app.register(authPlugin);

  await app.register(fastifyRateLimit, {
    /**
     * Not installed per route, which is the whole point of this block.
     *
     * Left global, `@fastify/rate-limit` hooks itself in through `onRoute` and
     * *appends* its handler to each route's own `onRequest` array. The guards
     * in this API are route-level hooks, so the resulting order is
     * `[requireRole, limiter]` — and a request the guard refuses throws before
     * the limiter is ever reached. Authenticated traffic was counted
     * correctly; everything rejected at the gate was not counted at all.
     *
     * Which is the traffic that most needs a limit. An anonymous caller is
     * refused by `authenticate` in microseconds and costs nothing to serve —
     * except that this runs on Cloud Run, where every request is billed and
     * instances scale out to meet whatever arrives. A flood of tokenless
     * requests was unbounded, and so was a scan for routes that do not exist.
     */
    global: false,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    /**
     * Per account when we know who is calling, per address when we do not.
     *
     * Namespaced so a uid can never collide with an address, and so a 429 in
     * the log says which kind of caller was throttled. `request.ip` is only
     * as trustworthy as `trustProxy` makes it — on Cloud Run the load
     * balancer rewrites `X-Forwarded-For`, but it is a client-supplied header
     * anywhere else, which is the other reason to prefer the uid.
     */
    keyGenerator: (request) =>
      request.user?.uid ? `uid:${request.user.uid}` : `ip:${request.ip}`,
  });

  /**
   * The limiter, as an application-level hook so it runs ahead of the guards.
   *
   * `app.rateLimit()` is the same handler the plugin would have attached per
   * route, with the same store and counters — only positioned where it sees
   * every request, including the ones no route accepts.
   *
   * It honours a route's own `config.rateLimit: false`, because the plugin's
   * `onRoute` wiring is no longer there to do it. The liveness and readiness
   * probes rely on that: they are polled constantly, from an address this
   * process cannot predict, and throttling them would have Cloud Run recycle
   * instances that are perfectly healthy.
   */
  const limiter = app.rateLimit();

  app.addHook('onRequest', async (request, reply) => {
    const routeConfig = request.routeOptions?.config ?? request.routeConfig;
    if (routeConfig?.rateLimit === false) return;

    return limiter(request, reply);
  });

  await app.register(fastifySwagger, {
    // Generated from the route schemas rather than a hand-maintained
    // `openapi.json`. The checked-in file described two endpoints that no
    // longer exist and had already drifted from the code.
    openapi: {
      info: {
        title: 'Tickety API',
        version: '1.0.0',
        description:
          'The server side of Tickety, for all four clients: the customer ' +
          'app, the door scanner, the admin panel and the organiser ' +
          'dashboard. Every route requires a Firebase ID token. The role ' +
          'claim on that token decides what a staff account may do; routes ' +
          'under /me need no role and serve whoever the token says is ' +
          'calling.',
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
        {
          name: 'me',
          description:
            'The signed-in account’s own profile, orders and tickets. No role ' +
            'required; scoped entirely by the uid in the token.',
        },
        { name: 'events', description: 'The event catalogue' },
        { name: 'users', description: 'Customer accounts' },
        { name: 'scanners', description: 'Door accounts' },
        { name: 'organisers', description: 'Event organiser accounts' },
        { name: 'reports', description: 'Sales and attendance' },
        { name: 'orders', description: 'What customers bought' },
        { name: 'tickets', description: 'Individual issued tickets' },
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
      // Before `/users`, and a separate file, because `/me` is the one group
      // of routes that needs no role at all — see routes/me.js.
      await api.register(meRoutes, { prefix: '/me' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(scannerRoutes, { prefix: '/scanners' });
      await api.register(organiserRoutes, { prefix: '/organisers' });
      await api.register(reportRoutes, { prefix: '/reports' });
      await api.register(orderRoutes, { prefix: '/orders' });
      await api.register(ticketRoutes, { prefix: '/tickets' });
    },
    // Versioned from the start. The clients are shipped mobile apps that
    // cannot be force-updated, so there will eventually be two live versions.
    { prefix: '/v1' }
  );

  return app;
}

export default buildApp;
