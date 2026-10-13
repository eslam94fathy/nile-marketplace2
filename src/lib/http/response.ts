import { type Response } from 'express';
import { HTTP_STATUS, type HttpStatus } from './status-codes';
import { type ErrorDetail } from '../error/app-error';

export interface PageMeta {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: PageMeta;
}

export interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: readonly ErrorDetail[] };
  correlationId: string | null;
}

/** Uniform success envelope (CLAUDE.md §7). */
export function sendSuccess<T>(res: Response, status: HttpStatus, data: T, meta?: PageMeta): void {
  const body: SuccessEnvelope<T> = meta ? { success: true, data, meta } : { success: true, data };
  res.status(status).json(body);
}

export function sendNoContent(res: Response): void {
  res.status(HTTP_STATUS.NO_CONTENT).end();
}

export function buildErrorEnvelope(
  code: string,
  message: string,
  correlationId: string | null,
  details?: readonly ErrorDetail[],
): ErrorEnvelope {
  return {
    success: false,
    error: details && details.length > 0 ? { code, message, details } : { code, message },
    correlationId,
  };
}
