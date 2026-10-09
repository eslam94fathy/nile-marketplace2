import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendSuccess, validateDto } from '../../../lib/http';
import { Rate } from '../../../lib/money';
import {
  ADMIN_SELLER_LIST_SPEC,
  DefaultCommissionDto,
  SellerCommissionRateDto,
  SellerDecisionDto,
  SellerIdParamsDto,
  SellerReinstateDto,
} from '../dto/seller-admin-request.dto';
import {
  toAdminSellerDetailDto,
  toAdminSellerListItemDto,
  toCommissionSettingsDto,
} from '../dto/seller-admin-response.dto';
import { type SellerAdminService } from '../service/seller-admin.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 05 §4.4). Routes are admin-guarded. */
@injectable()
export class SellerAdminController {
  constructor(
    @inject(TOKENS.SellerAdminService) private readonly admin: SellerAdminService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, ADMIN_SELLER_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.admin.list(query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAdminSellerListItemDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { sellerId } = await validateDto(SellerIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAdminSellerDetailDto(await this.admin.getDetail(sellerId)));
  };

  approve = async (req: Request, res: Response): Promise<void> => {
    const { sellerId } = await validateDto(SellerIdParamsDto, req.params);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toAdminSellerDetailDto(await this.admin.approve(sellerId, actorOf(req))),
    );
  };

  reject = async (req: Request, res: Response): Promise<void> => {
    const { sellerId } = await validateDto(SellerIdParamsDto, req.params);
    const { reason } = await validateDto(SellerDecisionDto, req.body);
    const detail = await this.admin.reject(sellerId, reason, actorOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toAdminSellerDetailDto(detail));
  };

  suspend = async (req: Request, res: Response): Promise<void> => {
    const { sellerId } = await validateDto(SellerIdParamsDto, req.params);
    const { reason } = await validateDto(SellerDecisionDto, req.body);
    const detail = await this.admin.suspend(sellerId, reason, actorOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toAdminSellerDetailDto(detail));
  };

  reinstate = async (req: Request, res: Response): Promise<void> => {
    const { sellerId } = await validateDto(SellerIdParamsDto, req.params);
    // The body is optional here, and Express leaves req.body undefined without one.
    const { reason } = await validateDto(SellerReinstateDto, req.body ?? {});
    const detail = await this.admin.reinstate(sellerId, reason ?? null, actorOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toAdminSellerDetailDto(detail));
  };

  changeCommissionRate = async (req: Request, res: Response): Promise<void> => {
    const { sellerId } = await validateDto(SellerIdParamsDto, req.params);
    const { commissionRate } = await validateDto(SellerCommissionRateDto, req.body);
    const detail = await this.admin.changeCommissionRate(sellerId, Rate.of(commissionRate), actorOf(req));
    sendSuccess(res, HTTP_STATUS.OK, toAdminSellerDetailDto(detail));
  };

  getCommissionSettings = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, HTTP_STATUS.OK, toCommissionSettingsDto(await this.admin.getCommissionSettings()));
  };

  updateCommissionSettings = async (req: Request, res: Response): Promise<void> => {
    const { defaultCommissionRate } = await validateDto(DefaultCommissionDto, req.body);
    const settings = await this.admin.updateDefaultCommissionRate(
      Rate.of(defaultCommissionRate),
      actorOf(req),
    );
    sendSuccess(res, HTTP_STATUS.OK, toCommissionSettingsDto(settings));
  };
}

function actorOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
