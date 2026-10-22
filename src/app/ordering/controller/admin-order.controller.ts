import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { type AuthContext } from '../../../lib/auth';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import {
  ADMIN_ORDER_LIST_SPEC,
  AdminCancelDto,
  OrderIdParamsDto,
  SellerOrderIdParamsDto,
} from '../dto/order-request.dto';
import { toAdminOrderDetailDto, toAdminOrderSummaryDto } from '../dto/order-response.dto';
import { type AdminOrderActionService } from '../service/admin-order-action.service';
import { type OrderViewService } from '../service/order-view.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 09 §4.3, §8.4). Routes are admin-guarded. */
@injectable()
export class AdminOrderController {
  constructor(
    @inject(TOKENS.OrderViewService) private readonly views: OrderViewService,
    @inject(TOKENS.AdminOrderActionService) private readonly actions: AdminOrderActionService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, ADMIN_ORDER_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.views.listForAdmin(query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAdminOrderSummaryDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { orderId } = await validateDto(OrderIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminOrderDetailDto(await this.views.getForAdmin(orderId)));
  };

  /** UC-OR-9. */
  cancelSellerOrder = async (req: Request, res: Response): Promise<void> => {
    const { sellerOrderId } = await validateDto(SellerOrderIdParamsDto, req.params);
    const { reason } = await validateDto(AdminCancelDto, req.body);
    const orderId = await this.actions.cancelSellerOrder(adminOf(req), sellerOrderId, reason);
    sendSuccess(res, HTTP_STATUS.OK, toAdminOrderDetailDto(await this.views.getForAdmin(orderId)));
  };

  /** UC-OR-10. */
  cancelOrder = async (req: Request, res: Response): Promise<void> => {
    const { orderId } = await validateDto(OrderIdParamsDto, req.params);
    const { reason } = await validateDto(AdminCancelDto, req.body);
    await this.actions.cancelOrder(adminOf(req), orderId, reason);
    sendSuccess(res, HTTP_STATUS.OK, toAdminOrderDetailDto(await this.views.getForAdmin(orderId)));
  };
}

function adminOf(req: Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
