import fp from 'fastify-plugin';

import { ApiError, badRequest, internal, notFound } from '../lib/errors.js';

/**
 * Turns everything thrown anywhere into one `application/problem+json` shape.
 *
 * Two rules:
 *
 *   * A 5xx never carries its message to the client. An unexpected exception's
 *     message tends to name internals — a collection path, an index, a
 *     hostname — and the client can do nothing with it anyway. It is logged in
 *     full, and the caller gets the request id to quote.
 *   * A 4xx always explains itself, because the caller is the one who can fix
 *     it.
 */
async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error);

    if (problem.status >= 500) {
      request.log.error(
        { err: error, reqId: request.id },
        'unhandled error serving request'
      );
    } else {
      request.log.info(
        { status: problem.status, code: problem.type, reqId: request.id },
        'request rejected'
      );
    }

    reply
      .code(problem.status)
      .type('application/problem+json')
      // Lets a user quote something specific when reporting a failure, without
      // exposing what actually went wrong.
      .header('x-request-id', request.id)
      .send({ ...problem.toProblem(request.url), requestId: request.id });
  });

  fastify.setNotFoundHandler((request, reply) => {
    const problem = notFound(`No route for ${request.method} ${request.url}.`);
    reply
      .code(404)
      .type('application/problem+json')
      .send(problem.toProblem(request.url));
  });
}

function toProblem(error) {
  if (error instanceof ApiError) return error;

  // Fastify's own schema validation failures. These are the caller's fault and
  // the detail is exactly what they need to correct the request.
  if (error.validation) {
    const detail = error.validation
      .map((issue) => {
        const field = issue.instancePath
          ? issue.instancePath.replace(/^\//, '').replace(/\//g, '.')
          : (issue.params?.missingProperty ?? 'body');
        return `${field} ${issue.message}`;
      })
      .join('; ');
    return badRequest(detail || 'The request did not validate.');
  }

  if (error.statusCode === 429) {
    return new ApiError(
      429,
      'rate-limited',
      'Rate limited',
      'Too many requests. Slow down and try again shortly.'
    );
  }

  if (typeof error.statusCode === 'number' && error.statusCode < 500) {
    return new ApiError(
      error.statusCode,
      'bad-request',
      'Bad request',
      error.message
    );
  }

  return internal(undefined, error);
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
