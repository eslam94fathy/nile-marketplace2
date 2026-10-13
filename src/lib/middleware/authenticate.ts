import './express-augment';
import { type RequestHandler } from 'express';
import { type JwtVerifier } from '../auth/jwt-verifier';
import { type UserRole } from '../auth/roles';
import { setContextUserId } from '../context';
import { forbidden, unauthenticated } from '../error/common-errors';
import { HEADER } from './headers';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/** Verifies `Authorization: Bearer <access JWT>` and sets `req.auth` (CLAUDE.md §10). */
export function authenticate(verifier: JwtVerifier): RequestHandler {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.get(HEADER.AUTHORIZATION) ?? '');
    if (!match?.[1]) throw unauthenticated();
    req.auth = await verifier.verify(match[1]);
    setContextUserId(req.auth.userId);
    next();
  };
}

/** Role guard. Deny by default: must run after `authenticate`. */
export function requireRole(...roles: readonly UserRole[]): RequestHandler {
  if (roles.length === 0) throw new Error('requireRole needs at least one role');
  return (req, _res, next) => {
    if (!req.auth) throw unauthenticated();
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };
}
