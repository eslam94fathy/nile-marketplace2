import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { KASHIER_SIGNATURE_HEADER } from '../../../pkg/payments';
import {
  OrderPaymentParamsDto,
  PaymentIdParamsDto,
  RecordRefundDto,
  REFUND_LIST_SPEC,
  RefundIdParamsDto,
  toAdminPaymentDto,
  toRefundDetailDto,
  toRefundDto,
  type WebhookReceivedDto,
} from '../dto/payment-admin.dto';
import { type KashierWebhookService } from '../service/kashier-webhook.service';
import { type PaymentAdminService } from '../service/payment-admin.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 10 §4.1): the raw body (express.raw on this path) goes to the signature check. */
@injectable()
export class PaymentWebhookController {
  constructor(@inject(TOKENS.KashierWebhookService) private readonly webhooks: KashierWebhookService) {}

  kashier = async (req: Request, res: Response): Promise<void> => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = req.header(KASHIER_SIGNATURE_HEADER);
    await this.webhooks.receive(raw, header);
    sendSuccess<WebhookReceivedDto>(res, HTTP_STATUS.OK, { received: true });
  };
}

/** HTTP only (spec 10 §4.2). Routes are admin-guarded. */
@injectable()
export class PaymentAdminController {
  constructor(
    @inject(TOKENS.PaymentAdminService) private readonly admin: PaymentAdminService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  listRefunds = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, REFUND_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.admin.listRefunds(query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toRefundDto), page.meta);
  };

  getPayment = async (req: Request, res: Response): Promise<void> => {
    const { paymentId } = await validateDto(PaymentIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminPaymentDto(await this.admin.getPayment(paymentId)));
  };

  getOrderPayment = async (req: Request, res: Response): Promise<void> => {
    const { orderId } = await validateDto(OrderPaymentParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminPaymentDto(await this.admin.getPaymentOfOrder(orderId)));
  };

  getRefund = async (req: Request, res: Response): Promise<void> => {
    const { refundId } = await validateDto(RefundIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toRefundDetailDto(await this.admin.getRefund(refundId)));
  };

  retryRefund = async (req: Request, res: Response): Promise<void> => {
    const { refundId } = await validateDto(RefundIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toRefundDto(await this.admin.retryRefund(refundId)));
  };

  recordRefund = async (req: Request, res: Response): Promise<void> => {
    const { refundId } = await validateDto(RefundIdParamsDto, req.params);
    const { providerRefundRef } = await validateDto(RecordRefundDto, req.body);
    if (!req.auth) throw unauthenticated();
    const refund = await this.admin.recordRefund(refundId, req.auth.userId, providerRefundRef);
    sendSuccess(res, HTTP_STATUS.OK, toRefundDto(refund));
  };
}
