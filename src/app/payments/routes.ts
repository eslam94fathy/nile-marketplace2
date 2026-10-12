import { type RequestHandler, Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { PAYMENTS_PATHS as P } from './constants';
import { type PaymentAdminController, type PaymentWebhookController } from './controller/payment.controller';
import { AdminPaymentDto, RecordRefundDto, RefundDto, WebhookReceivedDto } from './dto/payment-admin.dto';

/**
 * Spec 10 §4.1: the Kashier webhook. No auth (the signature is checked) and no rate limit: the
 * composition root mounts this router before the global limiter; the body size is limited.
 */
export function paymentWebhookRoutes(deps: {
  webhooks: PaymentWebhookController;
  docs: OpenApiRegistry;
  basePath: string;
}): Router {
  const router = Router();
  router.post(P.KASHIER_WEBHOOK, deps.webhooks.kashier);
  deps.docs.add({
    method: 'post',
    path: `${deps.basePath}${P.KASHIER_WEBHOOK}`,
    summary:
      'Kashier server webhook, signed in x-kashier-signature (INVALID_WEBHOOK_SIGNATURE 401). Deduplicated per Kashier event; unknown orders, failed attempts and other events are recorded and answered 200',
    tags: ['webhooks'],
    auth: false,
    responses: { 200: { description: 'Received', body: WebhookReceivedDto } },
  });
  return router;
}

export interface PaymentAdminRouteDeps {
  admin: PaymentAdminController;
  jwtVerifier: JwtVerifier;
  idempotency: RequestHandler;
  docs: OpenApiRegistry;
  basePath: string;
}

/** Spec 10 §4.2: admin only, general rate limit. */
export function paymentAdminRoutes(deps: PaymentAdminRouteDeps): Router {
  const { admin, docs, basePath } = deps;
  const router = Router();
  const adminOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];

  router.get(P.REFUNDS, ...adminOnly, admin.listRefunds);
  router.post(P.RECORD_REFUND, ...adminOnly, deps.idempotency, admin.recordRefund);
  router.get(P.PAYMENT, ...adminOnly, admin.getPayment);
  router.get(P.ORDER_PAYMENT, ...adminOnly, admin.getOrderPayment);

  const common = { tags: ['admin: payments'], auth: true } as const;
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.REFUNDS}`,
    summary:
      'Refunds, oldest first (a work queue). Filters: status[eq], reason[eq|in], createdAt[gte|lte]. Sort: createdAt (default ascending)',
    query: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
      { name: 'status[eq]', in: 'query', schema: { enum: ['pending_manual', 'recorded'] } },
      { name: 'reason[eq]', in: 'query', schema: { type: 'string' } },
      { name: 'reason[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: {
      200: { description: 'One page of refunds', body: RefundDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.RECORD_REFUND}`,
    summary:
      'Record a refund done by hand in the Kashier dashboard; the payment becomes partially_refunded_manually or refunded_manually (REFUND_NOT_FOUND 404, REFUND_ALREADY_RECORDED 409)',
    requestBody: RecordRefundDto,
    idempotent: true,
    responses: { 200: { description: 'The recorded refund', body: RefundDto } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.PAYMENT}`,
    summary: 'A payment with its refunds and webhook events (no payloads) (PAYMENT_NOT_FOUND)',
    responses: { 200: { description: 'The payment', body: AdminPaymentDto } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.ORDER_PAYMENT}`,
    summary: "An order's payment with its refunds and webhook events (PAYMENT_NOT_FOUND)",
    responses: { 200: { description: 'The payment', body: AdminPaymentDto } },
  });
  return router;
}
