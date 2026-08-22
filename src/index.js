import config from './config.js';
import { buildApp } from './app.js';

/**
 * Process entry point.
 *
 * Only concerns itself with binding a port and shutting down cleanly; the app
 * itself is built in `app.js` so tests can construct one without listening.
 */
const app = await buildApp();

/**
 * Cloud Run sends SIGTERM and then waits before killing the container. Closing
 * Fastify lets in-flight requests finish instead of being severed mid-write.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'failed to shut down cleanly');
      process.exit(1);
    }
  });
}

// An exception escaping an async handler would otherwise take the process down
// silently, leaving Cloud Run to restart it with no explanation in the log.
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  process.exit(1);
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
