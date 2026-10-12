import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { type ICustomerDirectory } from '../../customers';
import { CheckoutDto, CUSTOMER_ORDER_LIST_SPEC, OrderIdParamsDto } from '../dto/order-request.dto';
import { type CheckoutResultDto, toOrderDetailDto, toOrderSummaryDto } from '../dto/order-response.dto';
import { profileMissing } from '../errors';
import { type CheckoutService } from '../service/checkout.service';
import { type OrderViewService } from '../service/order-view.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 09 §4.1). The caller's own orders, resolved from the token. */
@injectable()
export class OrderController {
  constructor(
    @inject(TOKENS.CheckoutService) private readonly checkoutService: CheckoutService,
    @inject(TOKENS.OrderViewService) private readonly views: OrderViewService,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  checkout = async (req: Request, res: Response): Promise<void> => {
    const input = await validateDto(CheckoutDto, req.body);
    const { customerId, userId } = await this.callerOf(req);
    const order = await this.checkoutService.checkout(customerId, userId, input);
    // Built after the commit, from what was stored.
    const body: CheckoutResultDto = {
      order: toOrderDetailDto(await this.views.getForCustomer(customerId, order.id)),
      kashier: null,
    };
    sendSuccess(res, HTTP_STATUS.CREATED, body);
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, CUSTOMER_ORDER_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const { customerId } = await this.callerOf(req);
    const page = await this.views.listForCustomer(customerId, query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toOrderSummaryDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { orderId } = await validateDto(OrderIdParamsDto, req.params);
    const { customerId } = await this.callerOf(req);
    sendSuccess(res, HTTP_STATUS.OK, toOrderDetailDto(await this.views.getForCustomer(customerId, orderId)));
  };

  private async callerOf(req: Request): Promise<{ customerId: string; userId: string }> {
    if (!req.auth) throw unauthenticated();
    const customerId = await this.customers.getCustomerIdByUserId(req.auth.userId);
    if (customerId === null) throw profileMissing('customer', req.auth.userId);
    return { customerId, userId: req.auth.userId };
  }
}
