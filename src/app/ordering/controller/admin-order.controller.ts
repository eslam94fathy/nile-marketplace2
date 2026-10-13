import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { ADMIN_ORDER_LIST_SPEC, OrderIdParamsDto } from '../dto/order-request.dto';
import { toAdminOrderDetailDto, toAdminOrderSummaryDto } from '../dto/order-response.dto';
import { type OrderViewService } from '../service/order-view.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 09 §4.3). Routes are admin-guarded; admin cancellation isn't in R1 (S-9). */
@injectable()
export class AdminOrderController {
  constructor(
    @inject(TOKENS.OrderViewService) private readonly views: OrderViewService,
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
}
