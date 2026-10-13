import { randomUUID } from 'node:crypto';
import { type RequestHandler } from 'express';
import { runWithContext } from '../context';
import { HEADER, UUID_ANY_VERSION } from './headers';

/**
 * G26: accept a valid incoming X-Correlation-Id or generate one, echo the SAME value,
 * and run the rest of the request inside an AsyncLocalStorage context so every log line carries it.
 */
export function correlationId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(HEADER.CORRELATION_ID);
    const id = incoming && UUID_ANY_VERSION.test(incoming) ? incoming.toLowerCase() : randomUUID();
    res.setHeader(HEADER.CORRELATION_ID, id);
    runWithContext({ correlationId: id }, () => next());
  };
}
