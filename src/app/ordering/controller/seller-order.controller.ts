import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { type ISellerDirectory } from '../../sellers';
import { SELLER_ORDER_LIST_SPEC, SellerOrderIdParamsDto } from '../dto/order-request.dto';
import { toSellerOrderDto } from '../dto/order-response.dto';
import { profileMissing } from '../errors';
import { type OrderViewService } from '../service/order-view.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/**
 * HTTP only (spec 09 §4.2). The caller's own seller orders, in any seller status: open orders go on
 * after a suspension (Q-36).
 */
@injectable()
export class SellerOrderController {
  constructor(
    @inject(TOKENS.OrderViewService) private readonly views: OrderViewService,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, SELLER_ORDER_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.views.listForSeller(await this.sellerIdOf(req), query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toSellerOrderDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { sellerOrderId } = await validateDto(SellerOrderIdParamsDto, req.params);
    const view = await this.views.getForSeller(await this.sellerIdOf(req), sellerOrderId);
    sendSuccess(res, HTTP_STATUS.OK, toSellerOrderDto(view));
  };

  private async sellerIdOf(req: Request): Promise<string> {
    if (!req.auth) throw unauthenticated();
    const seller = await this.sellers.getSellerByUserId(req.auth.userId);
    if (!seller) throw profileMissing('seller', req.auth.userId);
    return seller.sellerId;
  }
}
