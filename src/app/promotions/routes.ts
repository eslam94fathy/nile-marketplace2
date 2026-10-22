import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type ParameterObject } from 'openapi3-ts/oas31';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { COUPON_PATHS as P } from './constants';
import { type AdminCouponController, type SellerCouponController } from './controller/coupon.controller';
import {
  AdminCreateCouponDto,
  AdminUpdateCouponDto,
  BlockCouponDto,
  SellerCreateCouponDto,
  SellerUpdateCouponDto,
} from './dto/coupon-request.dto';
import { AdminCouponDetailDto, CouponDto } from './dto/coupon-response.dto';
import { CouponFunding, CouponStatus } from './enums';

const TAGS = ['coupons'] as const;

export interface PromotionsRouteDeps {
  seller: SellerCouponController;
  admin: AdminCouponController;
  jwtVerifier: JwtVerifier;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/**
 * Spec 19 §4.2 (sellers) and §4.3 (admins), general rate limit. No Idempotency-Key: a coupon has no money
 * or stock effect until checkout, and a repeated create is refused by the code's unique constraint.
 * The customer preview is served by cart (spec 08 §8).
 */
export function promotionsRoutes(deps: PromotionsRouteDeps): Router {
  const { seller: s, admin: a, docs, basePath } = deps;
  const router = Router();

  const sellers = [authenticate(deps.jwtVerifier), requireRole(UserRole.SELLER)];
  router.get(P.SELLER_COUPONS, ...sellers, s.list);
  router.post(P.SELLER_COUPONS, ...sellers, s.create);
  router.get(P.SELLER_COUPON, ...sellers, s.get);
  router.patch(P.SELLER_COUPON, ...sellers, s.update);

  const admins = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];
  router.get(P.ADMIN_COUPONS, ...admins, a.list);
  router.post(P.ADMIN_COUPONS, ...admins, a.create);
  router.get(P.ADMIN_COUPON, ...admins, a.get);
  router.patch(P.ADMIN_COUPON, ...admins, a.update);
  router.post(P.ADMIN_BLOCK, ...admins, a.block);
  router.post(P.ADMIN_UNBLOCK, ...admins, a.unblock);

  const common = { tags: TAGS, auth: true } as const;
  const page: ParameterObject[] = [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'cursor', in: 'query', schema: { type: 'string' } },
    { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] as string[] } },
    { name: 'status[eq]', in: 'query', schema: { enum: Object.values(CouponStatus) as string[] } },
  ];
  const list = {
    200: { description: 'One page of coupons', body: CouponDto, isArray: true, paginated: true },
  };
  const one = { 200: { description: 'The coupon', body: CouponDto } };
  const rules =
    'percent: discountValue is a rate 0.01..0.90, maxDiscount optional; fixed: an amount above 0, no maxDiscount; ' +
    'startsAt < endsAt, endsAt in the future (COUPON_INVALID 422 with details)';

  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.SELLER_COUPONS}`,
    summary: 'My coupons, newest first, in any seller status',
    query: page,
    responses: list,
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.SELLER_COUPONS}`,
    summary: `Create a seller-funded coupon for my products (scope seller, or category within my products). The code is upper-cased. ${rules}. SELLER_NOT_APPROVED 403, COUPON_CODE_TAKEN 409, CATEGORY_NOT_FOUND 422`,
    requestBody: SellerCreateCouponDto,
    responses: { 201: { description: 'The coupon, active', body: CouponDto } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.SELLER_COUPON}`,
    summary: 'One of my coupons (COUPON_NOT_FOUND 404)',
    responses: one,
  });
  docs.add({
    ...common,
    method: 'patch',
    path: `${basePath}${P.SELLER_COUPON}`,
    summary: `Change my coupon; at least one field, code excluded. After the first redemption only endsAt, globalLimit (not below the uses) and status (COUPON_LOCKED 409). A blocked coupon can't be activated (COUPON_BLOCKED 409). ${rules}. COUPON_NOT_FOUND, SELLER_NOT_APPROVED`,
    requestBody: SellerUpdateCouponDto,
    responses: one,
  });

  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.ADMIN_COUPONS}`,
    summary: 'Every coupon, newest first',
    query: [
      ...page,
      { name: 'funding[eq]', in: 'query', schema: { enum: Object.values(CouponFunding) } },
      { name: 'sellerId[eq]', in: 'query', schema: { type: 'string' as const, format: 'uuid' } },
      { name: 'code[eq]', in: 'query', schema: { type: 'string' } },
    ],
    responses: list,
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.ADMIN_COUPONS}`,
    summary: `Create a platform-funded coupon (scope all, seller with scopeSellerId, or category with scopeCategoryId); audited. ${rules}. COUPON_CODE_TAKEN 409, CATEGORY_NOT_FOUND 422, SELLER_NOT_FOUND 422`,
    requestBody: AdminCreateCouponDto,
    responses: { 201: { description: 'The coupon, active', body: CouponDto } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.ADMIN_COUPON}`,
    summary: 'A coupon and its last 50 redemptions (COUPON_NOT_FOUND 404)',
    responses: { 200: { description: 'The coupon', body: AdminCouponDetailDto } },
  });
  docs.add({
    ...common,
    method: 'patch',
    path: `${basePath}${P.ADMIN_COUPON}`,
    summary: `Change a platform coupon, as a seller changes theirs; audited. A seller coupon is blocked or unblocked instead (COUPON_SELLER_FUNDED 409). ${rules}. COUPON_NOT_FOUND, COUPON_LOCKED`,
    requestBody: AdminUpdateCouponDto,
    responses: one,
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.ADMIN_BLOCK}`,
    summary:
      'Block a seller coupon: it becomes inactive and its seller cannot activate it; the seller is notified; audited (COUPON_NOT_FOUND, COUPON_BLOCK_INVALID_STATUS 409 for a blocked or platform coupon)',
    requestBody: BlockCouponDto,
    responses: one,
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.ADMIN_UNBLOCK}`,
    summary:
      'Unblock a seller coupon; it stays inactive for the seller to re-activate; audited (COUPON_NOT_FOUND, COUPON_BLOCK_INVALID_STATUS 409)',
    responses: one,
  });
  return router;
}
