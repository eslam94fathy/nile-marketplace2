import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { RejectReturnDto, ReturnIdParamsDto, SELLER_RETURN_LIST_SPEC } from '../dto/return-request.dto';
import { toSellerReturnDto } from '../dto/return-response.dto';
import { type ReturnDecisionService } from '../service/return-decision.service';
import { type ReturnViewService } from '../service/return-view.service';
import { userIdOf } from './return.controller';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 18 §4.2): the returns of the seller's orders. Any seller status (Q-36). */
@injectable()
export class SellerReturnController {
  constructor(
    @inject(TOKENS.ReturnDecisionService) private readonly decisions: ReturnDecisionService,
    @inject(TOKENS.ReturnViewService) private readonly views: ReturnViewService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const sellerId = await this.decisions.sellerIdOf(userIdOf(req));
    const query = parseListQuery(req.query, SELLER_RETURN_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.views.list({ sellerId }, query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toSellerReturnDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { returnId } = await validateDto(ReturnIdParamsDto, req.params);
    const sellerId = await this.decisions.sellerIdOf(userIdOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toSellerReturnDto(await this.views.get({ sellerId }, returnId)));
  };

  approve = async (req: Request, res: Response): Promise<void> => {
    const { returnId } = await validateDto(ReturnIdParamsDto, req.params);
    const approved = await this.decisions.sellerApprove(userIdOf(req), returnId);
    sendSuccess(res, HTTP_STATUS.OK, toSellerReturnDto(await this.views.viewOf(approved)));
  };

  reject = async (req: Request, res: Response): Promise<void> => {
    const { returnId } = await validateDto(ReturnIdParamsDto, req.params);
    const { reason } = await validateDto(RejectReturnDto, req.body);
    const rejected = await this.decisions.sellerReject(userIdOf(req), returnId, reason);
    sendSuccess(res, HTTP_STATUS.OK, toSellerReturnDto(await this.views.viewOf(rejected)));
  };
}
