import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { ADMIN_RETURN_LIST_SPEC, AdminDecideReturnDto, ReturnIdParamsDto } from '../dto/return-request.dto';
import { toAdminReturnDto } from '../dto/return-response.dto';
import { type ReturnDecisionService } from '../service/return-decision.service';
import { type ReturnViewService } from '../service/return-view.service';
import { userIdOf } from './return.controller';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 18 §4.3): every return; decisions are audited (spec 20 §2.3). */
@injectable()
export class AdminReturnController {
  constructor(
    @inject(TOKENS.ReturnDecisionService) private readonly decisions: ReturnDecisionService,
    @inject(TOKENS.ReturnViewService) private readonly views: ReturnViewService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, ADMIN_RETURN_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.views.list({}, query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAdminReturnDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { returnId } = await validateDto(ReturnIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminReturnDto(await this.views.get({}, returnId)));
  };

  decide = async (req: Request, res: Response): Promise<void> => {
    const { returnId } = await validateDto(ReturnIdParamsDto, req.params);
    const { decision, note } = await validateDto(AdminDecideReturnDto, req.body);
    const decided = await this.decisions.adminDecide(userIdOf(req), returnId, decision, note);
    sendSuccess(res, HTTP_STATUS.OK, toAdminReturnDto(await this.views.viewOf(decided)));
  };
}
