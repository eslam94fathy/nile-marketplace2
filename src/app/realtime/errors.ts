import { CommonErrorCode } from '../../lib/error';

/** `connect_error.data.code` (spec 15 §6, conventions §6). */
export const ConnectErrorCode = {
  UNAUTHENTICATED: CommonErrorCode.UNAUTHENTICATED,
  FORBIDDEN: CommonErrorCode.FORBIDDEN,
  RATE_LIMITED: CommonErrorCode.RATE_LIMITED,
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  /** The gateway is shutting down (UC-RT-4): the client reconnects to another task. */
  SERVICE_UNAVAILABLE: CommonErrorCode.SERVICE_UNAVAILABLE,
  /** A lookup failed (database down): the client retries with backoff. */
  INTERNAL_ERROR: CommonErrorCode.INTERNAL_ERROR,
} as const;
export type ConnectErrorCode = (typeof ConnectErrorCode)[keyof typeof ConnectErrorCode];

/** Ack codes of client signals (spec 15 §3.3, §6). */
export const AckErrorCode = {
  RATE_LIMITED: CommonErrorCode.RATE_LIMITED,
  VALIDATION_FAILED: CommonErrorCode.VALIDATION_FAILED,
} as const;

/** What Socket.IO sends the client as `connect_error`: the message plus `data.code`. */
export class ConnectError extends Error {
  override readonly name = 'ConnectError';
  readonly data: { code: ConnectErrorCode };

  constructor(code: ConnectErrorCode) {
    super(code);
    this.data = { code };
  }
}

/** A factory, never a shared instance (CLAUDE.md §9.1). */
export const connectError = (code: ConnectErrorCode): ConnectError => new ConnectError(code);
