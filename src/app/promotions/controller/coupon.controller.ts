import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import {
  HTTP_STATUS,
  type ListSpec,
  type ParsedListQuery,
  parseListQuery,
  sendSuccess,
  validateDto,
} from '../../../lib/http';
import {
  ADMIN_COUPON_LIST_SPEC,
  AdminCreateCouponDto,
  AdminUpdateCouponDto,
  BlockCouponDto,
  CouponIdParamsDto,
  SELLER_COUPON_LIST_SPEC,
  SellerCreateCouponDto,
  SellerUpdateCouponDto,
} from '../dto/coupon-request.dto';
import { toAdminCouponDetailDto, toCouponDto } from '../dto/coupon-response.dto';
import {
  type CouponCreateInput,
  type CouponManagementService,
  type CouponPatchInput,
} from '../service/coupon-management.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

function userIdOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}

/** The validated dates as `Date`s; the DTOs already checked they carry an offset. */
function createInput(dto: SellerCreateCouponDto | AdminCreateCouponDto): CouponCreateInput {
  return { ...dto, startsAt: new Date(dto.startsAt), endsAt: new Date(dto.endsAt) };
}

function patchInput(dto: SellerUpdateCouponDto | AdminUpdateCouponDto): CouponPatchInput {
  const { startsAt, endsAt, ...rest } = dto;
  return {
    ...rest,
    ...(startsAt !== undefined ? { startsAt: new Date(startsAt) } : {}),
    ...(endsAt !== undefined ? { endsAt: new Date(endsAt) } : {}),
  };
}

abstract class CouponController {
  constructor(
    protected readonly management: CouponManagementService,
    protected readonly clock: IClock,
    private readonly listEnv: ListEnv,
  ) {}

  protected listQuery(req: Request, spec: ListSpec): ParsedListQuery {
    return parseListQuery(req.query, spec, {
      defaultLimit: this.listEnv.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.listEnv.PAGINATION_MAX_LIMIT,
    });
  }
}

/** HTTP only (spec 19 §4.2): a seller's own coupons. */
@injectable()
export class SellerCouponController extends CouponController {
  constructor(
    @inject(TOKENS.CouponManagementService) management: CouponManagementService,
    @inject(TOKENS.Clock) clock: IClock,
    @inject(TOKENS.Env) env: ListEnv,
  ) {
    super(management, clock, env);
  }

  list = async (req: Request, res: Response): Promise<void> => {
    const page = await this.management.listForSeller(
      userIdOf(req),
      this.listQuery(req, SELLER_COUPON_LIST_SPEC),
    );
    const now = this.clock.now();
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      page.items.map((coupon) => toCouponDto(coupon, now)),
      page.meta,
    );
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(SellerCreateCouponDto, req.body);
    const coupon = await this.management.createForSeller(userIdOf(req), createInput(dto));
    sendSuccess(res, HTTP_STATUS.CREATED, toCouponDto(coupon, this.clock.now()));
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { couponId } = await validateDto(CouponIdParamsDto, req.params);
    const coupon = await this.management.getForSeller(userIdOf(req), couponId);
    sendSuccess(res, HTTP_STATUS.OK, toCouponDto(coupon, this.clock.now()));
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { couponId } = await validateDto(CouponIdParamsDto, req.params);
    const dto = await validateDto(SellerUpdateCouponDto, req.body);
    const coupon = await this.management.updateForSeller(userIdOf(req), couponId, patchInput(dto));
    sendSuccess(res, HTTP_STATUS.OK, toCouponDto(coupon, this.clock.now()));
  };
}

/** HTTP only (spec 19 §4.3, PR-20): platform coupons, and the block of seller coupons; audited. */
@injectable()
export class AdminCouponController extends CouponController {
  constructor(
    @inject(TOKENS.CouponManagementService) management: CouponManagementService,
    @inject(TOKENS.Clock) clock: IClock,
    @inject(TOKENS.Env) env: ListEnv,
  ) {
    super(management, clock, env);
  }

  list = async (req: Request, res: Response): Promise<void> => {
    const page = await this.management.listForAdmin(this.listQuery(req, ADMIN_COUPON_LIST_SPEC));
    const now = this.clock.now();
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      page.items.map((coupon) => toCouponDto(coupon, now)),
      page.meta,
    );
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(AdminCreateCouponDto, req.body);
    const coupon = await this.management.createForAdmin(createInput(dto));
    sendSuccess(res, HTTP_STATUS.CREATED, toCouponDto(coupon, this.clock.now()));
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { couponId } = await validateDto(CouponIdParamsDto, req.params);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toAdminCouponDetailDto(await this.management.getForAdmin(couponId), this.clock.now()),
    );
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { couponId } = await validateDto(CouponIdParamsDto, req.params);
    const dto = await validateDto(AdminUpdateCouponDto, req.body);
    const coupon = await this.management.updateForAdmin(couponId, patchInput(dto));
    sendSuccess(res, HTTP_STATUS.OK, toCouponDto(coupon, this.clock.now()));
  };

  block = async (req: Request, res: Response): Promise<void> => {
    const { couponId } = await validateDto(CouponIdParamsDto, req.params);
    const { reason } = await validateDto(BlockCouponDto, req.body);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toCouponDto(await this.management.block(couponId, reason), this.clock.now()),
    );
  };

  unblock = async (req: Request, res: Response): Promise<void> => {
    const { couponId } = await validateDto(CouponIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toCouponDto(await this.management.unblock(couponId), this.clock.now()));
  };
}
