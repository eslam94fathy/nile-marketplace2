import { type RequestHandler } from 'express';
import { routeNotFound } from '../error/common-errors';

export function notFound(): RequestHandler {
  return () => {
    throw routeNotFound();
  };
}
