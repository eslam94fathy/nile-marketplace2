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
import { SELLERS_ADMIN_PATHS as A, SELLERS_PATHS as P } from './constants';
import { type SellerAdminController } from './controller/seller-admin.controller';
import { type SellerController } from './controller/seller.controller';
import {
  DefaultCommissionDto,
  SellerCommissionRateDto,
  SellerDecisionDto,
  SellerReinstateDto,
} from './dto/seller-admin-request.dto';
import {
  AdminSellerDetailDto,
  AdminSellerListItemDto,
  CommissionSettingsDto,
} from './dto/seller-admin-response.dto';
import { RegisterSellerDto, UpdateSellerProfileDto } from './dto/seller-request.dto';
import { RegisteredSellerDto, SellerProfileDto } from './dto/seller-response.dto';

const AUTH_TAGS = ['auth'] as const;
const TAGS = ['seller'] as const;
const ADMIN_TAGS = ['admin: sellers'] as const;

export interface SellersRouteDeps {
  sellers: SellerController;
  admin: SellerAdminController;
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

  mountAdminRoutes(router, deps);
  return router;
}

/** Spec 05 §4.4: admin only, general rate limit (applied globally). */
function mountAdminRoutes(router: Router, deps: SellersRouteDeps): void {
  const { admin, docs, basePath } = deps;
  const adminOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];

  router.get(A.SELLERS, ...adminOnly, admin.list);
  router.get(A.SELLER, ...adminOnly, admin.get);
  router.post(A.APPROVE, ...adminOnly, admin.approve);
  router.post(A.REJECT, ...adminOnly, admin.reject);
  router.post(A.SUSPEND, ...adminOnly, admin.suspend);
  router.post(A.REINSTATE, ...adminOnly, admin.reinstate);
  router.put(A.COMMISSION_RATE, ...adminOnly, admin.changeCommissionRate);
  router.get(A.COMMISSION_SETTINGS, ...adminOnly, admin.getCommissionSettings);
  router.put(A.COMMISSION_SETTINGS, ...adminOnly, admin.updateCommissionSettings);

  const common = { tags: ADMIN_TAGS, auth: true } as const;
  const detail = { 200: { description: 'The seller after the change', body: AdminSellerDetailDto } };
  const settings = { 200: { description: 'The commission settings', body: CommissionSettingsDto } };
  const transitions: [string, string, (typeof SellerDecisionDto | typeof SellerReinstateDto)?][] = [
    [
      A.APPROVE,
      'Approve a pending seller; needs a verified email; publishes seller.approved (SELLER_NOT_FOUND, SELLER_INVALID_STATUS_TRANSITION, SELLER_EMAIL_NOT_VERIFIED)',
    ],
    [
      A.REJECT,
      'Reject a pending seller with a reason the seller sees (SELLER_NOT_FOUND, SELLER_INVALID_STATUS_TRANSITION)',
      SellerDecisionDto,
    ],
    [
      A.SUSPEND,
      'Suspend an approved seller; their products are hidden; publishes seller.suspended (SELLER_NOT_FOUND, SELLER_INVALID_STATUS_TRANSITION)',
      SellerDecisionDto,
    ],
    [
      A.REINSTATE,
      'Reinstate a suspended seller; publishes seller.approved (SELLER_NOT_FOUND, SELLER_INVALID_STATUS_TRANSITION)',
      SellerReinstateDto,
    ],
  ];

  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${A.SELLERS}`,
    summary:
      'List sellers. Filters: status[eq|in], createdAt[gte|lte], businessName[like], pickupGovernorateId[eq]. Sort: createdAt (default -createdAt)',
    query: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
      { name: 'status[eq]', in: 'query', schema: { type: 'string' } },
      { name: 'status[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'businessName[like]', in: 'query', schema: { type: 'string' } },
      { name: 'pickupGovernorateId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: {
      200: {
        description: 'One page of sellers',
        body: AdminSellerListItemDto,
        isArray: true,
        paginated: true,
      },
    },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${A.SELLER}`,
    summary: 'A seller with its status and commission history, newest 50 each (SELLER_NOT_FOUND)',
    responses: { 200: { description: 'The seller', body: AdminSellerDetailDto } },
  });
  for (const [path, summary, requestBody] of transitions) {
    docs.add({
      ...common,
      method: 'post',
      path: `${basePath}${path}`,
      summary,
      ...(requestBody ? { requestBody } : {}),
      responses: detail,
    });
  }
  docs.add({
    ...common,
    method: 'put',
    path: `${basePath}${A.COMMISSION_RATE}`,
    summary:
      "Change a seller's commission rate; new checkouts only (SELLER_NOT_FOUND, COMMISSION_RATE_UNCHANGED)",
    requestBody: SellerCommissionRateDto,
    responses: detail,
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${A.COMMISSION_SETTINGS}`,
    summary: 'The default commission rate for new sellers',
    responses: settings,
  });
  docs.add({
    ...common,
    method: 'put',
    path: `${basePath}${A.COMMISSION_SETTINGS}`,
    summary: 'Change the default commission rate; applies to sellers who register afterwards',
    requestBody: DefaultCommissionDto,
    responses: settings,
  });
}
