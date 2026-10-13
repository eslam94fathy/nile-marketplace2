import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { type ISellerDirectory } from '../../sellers';
import {
  CancelOrderItemDto,
  CancelSellerOrderDto,
  SELLER_ORDER_LIST_SPEC,
  SellerOrderIdParamsDto,
  SellerOrderItemParamsDto,
} from '../dto/order-request.dto';
import { toSellerOrderDto } from '../dto/order-response.dto';
import { profileMissing } from '../errors';
import { type OrderActionService, type SellerCaller } from '../service/order-action.service';
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
    @inject(TOKENS.OrderActionService) private readonly actions: OrderActionService,
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
    const seller = await this.callerOf(req);
    await this.send(res, seller, sellerOrderId);
  };

  accept = async (req: Request, res: Response): Promise<void> => {
    const { sellerOrderId } = await validateDto(SellerOrderIdParamsDto, req.params);
    const seller = await this.callerOf(req);
    await this.actions.accept(seller, sellerOrderId);
    await this.send(res, seller, sellerOrderId);
  };

  ready = async (req: Request, res: Response): Promise<void> => {
    const { sellerOrderId } = await validateDto(SellerOrderIdParamsDto, req.params);
    const seller = await this.callerOf(req);
    await this.actions.ready(seller, sellerOrderId);
    await this.send(res, seller, sellerOrderId);
  };

  cancel = async (req: Request, res: Response): Promise<void> => {
    const { sellerOrderId } = await validateDto(SellerOrderIdParamsDto, req.params);
    const { note } = await validateDto(CancelSellerOrderDto, req.body ?? {});
    const seller = await this.callerOf(req);
    await this.actions.sellerCancel(seller, sellerOrderId, note ?? null);
    await this.send(res, seller, sellerOrderId);
  };

  cancelItems = async (req: Request, res: Response): Promise<void> => {
    const { sellerOrderId, itemId } = await validateDto(SellerOrderItemParamsDto, req.params);
    const { quantity, reason, note } = await validateDto(CancelOrderItemDto, req.body);
    const seller = await this.callerOf(req);
    await this.actions.cancelItems(seller, sellerOrderId, itemId, { quantity, reason, note: note ?? null });
    await this.send(res, seller, sellerOrderId);
  };

  returnReceived = async (req: Request, res: Response): Promise<void> => {
    const { sellerOrderId } = await validateDto(SellerOrderIdParamsDto, req.params);
    const seller = await this.callerOf(req);
    await this.actions.returnReceived(seller, sellerOrderId);
    await this.send(res, seller, sellerOrderId);
  };

  /** Every action answers with the seller order after the change. */
  private async send(res: Response, seller: SellerCaller, sellerOrderId: string): Promise<void> {
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toSellerOrderDto(await this.views.getForSeller(seller.sellerId, sellerOrderId)),
    );
  }

  private async sellerIdOf(req: Request): Promise<string> {
    return (await this.callerOf(req)).sellerId;
  }

  private async callerOf(req: Request): Promise<SellerCaller> {
    if (!req.auth) throw unauthenticated();
    const seller = await this.sellers.getSellerByUserId(req.auth.userId);
    if (!seller) throw profileMissing('seller', req.auth.userId);
    return { sellerId: seller.sellerId, userId: req.auth.userId };
  }
}
