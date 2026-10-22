import { type RequestHandler, Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { ADMIN_RETURN_PATHS as A, RETURN_PATHS as P, SELLER_RETURN_PATHS as S } from './constants';
import { type AdminReturnController } from './controller/admin-return.controller';
import { type ReturnController } from './controller/return.controller';
import { type SellerReturnController } from './controller/seller-return.controller';
import {
  AdminDecideReturnDto,
  ConfirmReceiptDto,
  DisputeReturnDto,
  EscalateReturnDto,
  RejectReturnDto,
  RequestReturnDto,
  ResolveDisputeDto,
} from './dto/return-request.dto';
import { AdminReturnDto, ReturnableItemsDto, ReturnDto, SellerReturnDto } from './dto/return-response.dto';
import { ReturnReason, ReturnStatus } from './enums';

export interface ReturnRouteDeps {
  customer: ReturnController;
  seller: SellerReturnController;
  admin: AdminReturnController;
  jwtVerifier: JwtVerifier;
  /** `requireIdempotency`, required on the request, the receipt and the dispute resolution (spec 18 §4, G25). */
  idempotency: RequestHandler;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 18 §4: customers (§4.1), sellers (§4.2) and admins (§4.3). Rate class: general. */
export function returnRoutes(deps: ReturnRouteDeps): Router {
  const { customer: c, seller: s, admin: a, docs, basePath } = deps;
  const router = Router();
  const customers = [authenticate(deps.jwtVerifier), requireRole(UserRole.CUSTOMER)];
  const sellers = [authenticate(deps.jwtVerifier), requireRole(UserRole.SELLER)];
  const admins = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];

  router.get(P.RETURNABLE_ITEMS, ...customers, c.returnableItems);
  router.post(P.RETURNS, ...customers, deps.idempotency, c.request);
  router.get(P.RETURNS, ...customers, c.list);
  router.get(P.RETURN, ...customers, c.get);
  router.post(P.CANCEL, ...customers, c.cancel);
  router.post(P.ESCALATE, ...customers, c.escalate);

  router.get(S.RETURNS, ...sellers, s.list);
  router.get(S.RETURN, ...sellers, s.get);
  router.post(S.APPROVE, ...sellers, s.approve);
  router.post(S.REJECT, ...sellers, s.reject);
  router.post(S.CONFIRM_RECEIPT, ...sellers, deps.idempotency, s.confirmReceipt);
  router.post(S.DISPUTE, ...sellers, s.dispute);

  router.get(A.RETURNS, ...admins, a.list);
  router.get(A.RETURN, ...admins, a.get);
  router.post(A.DECIDE, ...admins, a.decide);
  router.post(A.RESOLVE_DISPUTE, ...admins, deps.idempotency, a.resolveDispute);

  const page = [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'cursor', in: 'query', schema: { type: 'string' } },
  ] as const;
  const status = [
    { name: 'status[eq]', in: 'query', schema: { enum: Object.values(ReturnStatus) } },
    { name: 'status[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
  ] as const;
  const createdAtSort = { name: 'sort', in: 'query' as const, schema: { enum: ['createdAt', '-createdAt'] } };

  const mine = { tags: ['returns'], auth: true } as const;
  const one = { 200: { description: 'The return', body: ReturnDto } };
  docs.add({
    ...mine,
    method: 'get',
    path: `${basePath}${P.RETURNABLE_ITEMS}`,
    summary:
      'What can still be returned from a delivered seller order, until when, and the current return fee (ORDER_NOT_FOUND 404, SELLER_ORDER_NOT_FOUND 404, RETURN_NOT_ALLOWED 422, RETURN_WINDOW_CLOSED 422, RETURN_PICKUP_UNAVAILABLE 422)',
    responses: { 200: { description: 'The returnable items', body: ReturnableItemsDto } },
  });
  docs.add({
    ...mine,
    method: 'post',
    path: `${basePath}${P.RETURNS}`,
    summary:
      'Ask to return items of one seller order, one reason per request. A COD order needs refundPayout (walletNumber for mobile_wallet, instapayAddress for instapay); a Kashier order must not send it (400). Seller-fault reasons need a photo; changed_mind pays the return fee (SELLER_ORDER_NOT_FOUND 404, RETURN_NOT_ALLOWED, RETURN_WINDOW_CLOSED, RETURN_QUANTITY_INVALID, RETURN_PHOTOS_REQUIRED, RETURN_AMOUNT_TOO_LOW, RETURN_PICKUP_UNAVAILABLE, MEDIA_NOT_ATTACHABLE: 422; RETURN_ALREADY_OPEN 409)',
    idempotent: true,
    requestBody: RequestReturnDto,
    responses: { 201: { description: 'The new return', body: ReturnDto } },
  });
  docs.add({
    ...mine,
    method: 'get',
    path: `${basePath}${P.RETURNS}`,
    summary:
      'My returns, newest first. Filters: status[eq|in], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: [
      ...page,
      createdAtSort,
      ...status,
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: {
      200: { description: 'One page of returns', body: ReturnDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...mine,
    method: 'get',
    path: `${basePath}${P.RETURN}`,
    summary: 'One of my returns; photo URLs are short-lived (RETURN_NOT_FOUND)',
    responses: one,
  });
  docs.add({
    ...mine,
    method: 'post',
    path: `${basePath}${P.CANCEL}`,
    summary:
      'Cancel before the parcel is picked up (requested or approved) (RETURN_NOT_FOUND, RETURN_INVALID_STATUS_TRANSITION 409)',
    responses: one,
  });
  docs.add({
    ...mine,
    method: 'post',
    path: `${basePath}${P.ESCALATE}`,
    summary:
      'Ask an admin to decide a rejected return, before escalationDeadlineAt (RETURN_NOT_FOUND, RETURN_INVALID_STATUS_TRANSITION 409, RETURN_ESCALATION_WINDOW_CLOSED 409)',
    requestBody: EscalateReturnDto,
    responses: one,
  });

  const sellerTags = { tags: ['seller: returns'], auth: true } as const;
  const sellerOne = { 200: { description: 'The return', body: SellerReturnDto } };
  docs.add({
    ...sellerTags,
    method: 'get',
    path: `${basePath}${S.RETURNS}`,
    summary:
      'Returns of my orders. Filters: status[eq|in]. Sort: createdAt (default -createdAt), sellerDecisionDeadlineAt (the decision queue, with status[eq]=requested)',
    query: [
      ...page,
      {
        name: 'sort',
        in: 'query',
        schema: {
          enum: ['createdAt', '-createdAt', 'sellerDecisionDeadlineAt', '-sellerDecisionDeadlineAt'],
        },
      },
      ...status,
    ],
    responses: {
      200: { description: 'One page of returns', body: SellerReturnDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...sellerTags,
    method: 'get',
    path: `${basePath}${S.RETURN}`,
    summary: 'One return of my orders (RETURN_NOT_FOUND)',
    responses: sellerOne,
  });
  docs.add({
    ...sellerTags,
    method: 'post',
    path: `${basePath}${S.APPROVE}`,
    summary:
      'Approve a requested return; an agent then picks it up from the customer (RETURN_NOT_FOUND, RETURN_INVALID_STATUS_TRANSITION 409)',
    responses: sellerOne,
  });
  docs.add({
    ...sellerTags,
    method: 'post',
    path: `${basePath}${S.REJECT}`,
    summary:
      'Reject a requested return with a reason; the customer may escalate it to an admin (RETURN_NOT_FOUND, RETURN_INVALID_STATUS_TRANSITION 409)',
    requestBody: RejectReturnDto,
    responses: sellerOne,
  });

  docs.add({
    ...sellerTags,
    method: 'post',
    path: `${basePath}${S.CONFIRM_RECEIPT}`,
    summary:
      'Confirm the parcel arrived, item by item: restock true puts the units back on sale, false (damaged) does not. Completes the return and refunds the customer (RETURN_NOT_FOUND, RETURN_INVALID_STATUS_TRANSITION 409, RETURN_ITEMS_MISMATCH 422)',
    idempotent: true,
    requestBody: ConfirmReceiptDto,
    responses: sellerOne,
  });
  docs.add({
    ...sellerTags,
    method: 'post',
    path: `${basePath}${S.DISPUTE}`,
    summary:
      'Dispute a received return before inspectionDeadlineAt, with optional photos you uploaded (return_photo); an admin decides (RETURN_NOT_FOUND, RETURN_INVALID_STATUS_TRANSITION 409, RETURN_INSPECTION_WINDOW_CLOSED 409, MEDIA_NOT_ATTACHABLE 422)',
    requestBody: DisputeReturnDto,
    responses: sellerOne,
  });

  const adminTags = { tags: ['admin: returns'], auth: true } as const;
  docs.add({
    ...adminTags,
    method: 'get',
    path: `${basePath}${A.RETURNS}`,
    summary:
      'Every return, newest first. Filters: status[eq|in], reason[eq|in], sellerId[eq], customerId[eq]. Sort: createdAt (default -createdAt)',
    query: [
      ...page,
      createdAtSort,
      ...status,
      { name: 'reason[eq]', in: 'query', schema: { enum: Object.values(ReturnReason) } },
      { name: 'reason[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'sellerId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'customerId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: {
      200: { description: 'One page of returns', body: AdminReturnDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...adminTags,
    method: 'get',
    path: `${basePath}${A.RETURN}`,
    summary: 'One return with its full history (RETURN_NOT_FOUND)',
    responses: { 200: { description: 'The return', body: AdminReturnDto } },
  });
  docs.add({
    ...adminTags,
    method: 'post',
    path: `${basePath}${A.DECIDE}`,
    summary:
      'Approve or reject a requested or escalated return, final and audited (RETURN_NOT_FOUND, RETURN_INVALID_STATUS_TRANSITION 409)',
    requestBody: AdminDecideReturnDto,
    responses: { 200: { description: 'The return', body: AdminReturnDto } },
  });
  docs.add({
    ...adminTags,
    method: 'post',
    path: `${basePath}${A.RESOLVE_DISPUTE}`,
    summary:
      'Resolve a disputed return, final and audited: refund completes it (nothing restocked), no_refund refuses it (RETURN_NOT_FOUND, RETURN_INVALID_STATUS_TRANSITION 409)',
    idempotent: true,
    requestBody: ResolveDisputeDto,
    responses: { 200: { description: 'The return', body: AdminReturnDto } },
  });
  return router;
}
