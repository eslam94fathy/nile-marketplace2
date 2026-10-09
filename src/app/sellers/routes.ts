import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import {
  authenticate,
  byIpAndEmail,
  RateLimitClass,
  type RateLimiters,
  requireRole,
} from '../../lib/middleware';
import { SELLERS_PATHS as P } from './constants';
import { type SellerController } from './controller/seller.controller';
import { RegisterSellerDto, UpdateSellerProfileDto } from './dto/seller-request.dto';
import { RegisteredSellerDto, SellerProfileDto } from './dto/seller-response.dto';

const AUTH_TAGS = ['auth'] as const;
const TAGS = ['seller'] as const;

export interface SellersRouteDeps {
  sellers: SellerController;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 05 §4.2–§4.3. Registration is strict-auth; the rest uses the global general limit. */
export function sellersRoutes(deps: SellersRouteDeps): Router {
  const { sellers, docs, basePath } = deps;
  const router = Router();
  const sellerOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.SELLER)];

  router.post(
    P.REGISTER,
    deps.rateLimiters.limit(RateLimitClass.STRICT_AUTH, byIpAndEmail),
    sellers.register,
  );
  router.get(P.PROFILE, ...sellerOnly, sellers.getProfile);
  router.patch(P.PROFILE, ...sellerOnly, sellers.updateProfile);
  router.post(P.REAPPLY, ...sellerOnly, sellers.reapply);

  docs.add({
    method: 'post',
    path: `${basePath}${P.REGISTER}`,
    summary:
      'Register as a seller (pending admin approval); a verification OTP is emailed (EMAIL_ALREADY_REGISTERED, BUSINESS_NAME_TAKEN, GOVERNORATE_NOT_FOUND)',
    tags: AUTH_TAGS,
    auth: false,
    requestBody: RegisterSellerDto,
    responses: { 201: { description: 'The pending account and seller profile', body: RegisteredSellerDto } },
  });
  const mine = { tags: TAGS, auth: true } as const;
  const profile = { 200: { description: 'My seller profile', body: SellerProfileDto } };
  docs.add({
    ...mine,
    method: 'get',
    path: `${basePath}${P.PROFILE}`,
    summary: 'My seller profile',
    responses: profile,
  });
  docs.add({
    ...mine,
    method: 'patch',
    path: `${basePath}${P.PROFILE}`,
    summary:
      'Edit my profile in any status, no re-approval; affects new orders only (BUSINESS_NAME_TAKEN, GOVERNORATE_NOT_FOUND)',
    requestBody: UpdateSellerProfileDto,
    responses: profile,
  });
  docs.add({
    ...mine,
    method: 'post',
    path: `${basePath}${P.REAPPLY}`,
    summary: 'Re-apply after a rejection: back to pending approval (SELLER_INVALID_STATUS_TRANSITION)',
    responses: profile,
  });

  return router;
}
