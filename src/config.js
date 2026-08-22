/**
 * Configuration, read once from the environment and validated at boot.
 *
 * Anything that differs between a laptop and Cloud Run belongs here. The rule
 * is that a missing or nonsensical value fails immediately and loudly, rather
 * than surfacing later as a confusing 500 — a server that starts up in a state
 * it cannot work in is harder to diagnose than one that refuses to start.
 */

/** Reads a variable, falling back only when a fallback was offered. */
function read(name, { fallback = undefined, required = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : raw.trim();

  if (required && value === undefined) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`
    );
  }
  return value;
}

function readInt(name, fallback) {
  const raw = read(name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

function readList(name, fallback = []) {
  const raw = read(name);
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const nodeEnv = read('NODE_ENV', { fallback: 'development' });
const isProduction = nodeEnv === 'production';

const config = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',

  // Cloud Run injects PORT and expects the container to honour it.
  port: readInt('PORT', 3002),
  host: read('HOST', { fallback: '0.0.0.0' }),

  /**
   * The Firebase project holding the data.
   *
   * Note this is `ticketycustomer`, not `ticketyadmin`. Every client — both
   * Flutter apps and both React apps — is configured against
   * `ticketycustomer`; the service-account key previously checked in here
   * belonged to `ticketyadmin`, so the old endpoints were reading and writing
   * a project nothing else used.
   */
  projectId: read('GOOGLE_CLOUD_PROJECT', { fallback: 'ticketycustomer' }),

  /**
   * Browser origins allowed to call the API.
   *
   * The old server used `origin: '*'` with `Authorization` in the allowed
   * headers, which lets any site on the internet drive the API with a
   * logged-in user's token. In production this must be an explicit list.
   */
  corsOrigins: readList('CORS_ORIGINS', isProduction ? [] : [
    'http://localhost:3000',
    'http://localhost:3001',
  ]),

  /** Requests per window, per IP, before throttling. */
  rateLimitMax: readInt('RATE_LIMIT_MAX', 300),
  rateLimitWindowMs: readInt('RATE_LIMIT_WINDOW_MS', 60_000),

  logLevel: read('LOG_LEVEL', { fallback: isProduction ? 'info' : 'debug' }),
};

if (config.isProduction && config.corsOrigins.length === 0) {
  throw new Error(
    'CORS_ORIGINS must list the allowed web origins in production. ' +
      'Refusing to start with an open CORS policy.'
  );
}

export default config;
