import { type ErrorRequestHandler, type Request, type Response } from 'express';
import { REFRESH_COOKIE, WEB_CLIENT } from '../../../lib/auth';
import { isAppError, validationFailed } from '../../../lib/error';
import { readCookie } from '../../../lib/http';
import { HEADER } from '../../../lib/middleware';
import { IdentityErrorCode } from '../errors';

/*
 * Spec 03 §8.1: where the refresh token travels. HTTP only, so it lives next to the controller.
 * Native clients send and receive it in the body; a request with `X-Nile-Client: web` receives it in
 * an HttpOnly cookie instead and may send it back the same way.
 */

export const isWebClient = (req: Request): boolean => req.get(HEADER.NILE_CLIENT) === WEB_CLIENT;

const cookieOf = (req: Request): string | undefined => readCookie(req, REFRESH_COOKIE.NAME);

/** A web request, or one that carries the cookie: such a request may get the cookie cleared. */
const usesCookieTransport = (req: Request): boolean => isWebClient(req) || cookieOf(req) !== undefined;

/**
 * The token from the body or the cookie. Both at once, or the cookie without the web header (the CSRF
 * guard: a custom header forces a CORS preflight), is VALIDATION_FAILED; so is neither.
 */
export function refreshTokenFrom(req: Request, bodyToken: string | undefined): string {
  const cookie = cookieOf(req);
  if (bodyToken !== undefined && cookie !== undefined) {
    throw validationFailed([
      {
        field: 'refreshToken',
        constraint: 'singleTransport',
        message: 'send the refresh token in the body or in the cookie, not both',
      },
    ]);
  }
  if (bodyToken !== undefined) return bodyToken;
  if (cookie === undefined) {
    throw validationFailed([
      { field: 'refreshToken', constraint: 'isDefined', message: 'refreshToken is required' },
    ]);
  }
  if (!isWebClient(req)) {
    throw validationFailed([
      {
        field: HEADER.NILE_CLIENT,
        constraint: 'equals',
        message: `the refresh cookie needs the header ${HEADER.NILE_CLIENT}: ${WEB_CLIENT}`,
      },
    ]);
  }
  return cookie;
}

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: REFRESH_COOKIE.PATH,
} as const;

/** Web: sets the cookie and answers `null` in the body. Native: the token goes in the body. */
export function deliverRefreshToken(
  req: Request,
  res: Response,
  token: string,
  maxAgeMs: number,
): string | null {
  if (!isWebClient(req)) return token;
  res.cookie(REFRESH_COOKIE.NAME, token, { ...cookieOptions, maxAge: maxAgeMs });
  return null;
}

/** `Max-Age=0`. Only for requests on the cookie transport: native answers never carry Set-Cookie. */
export function clearRefreshCookie(req: Request, res: Response): void {
  if (usesCookieTransport(req)) res.cookie(REFRESH_COOKIE.NAME, '', { ...cookieOptions, maxAge: 0 });
}

/** Route-level: every INVALID_REFRESH_TOKEN answer clears the cookie, then the global handler answers. */
export const clearRefreshCookieOnInvalidToken: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (isAppError(error) && error.code === IdentityErrorCode.INVALID_REFRESH_TOKEN)
    clearRefreshCookie(req, res);
  next(error);
};
