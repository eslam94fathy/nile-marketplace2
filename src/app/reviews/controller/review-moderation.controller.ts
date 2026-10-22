import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type AuthContext } from '../../../lib/auth';
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
  ADMIN_REVIEW_LIST_SPEC,
  HideDto,
  ProductIdParamsDto,
  PUBLIC_REVIEW_LIST_SPEC,
  ReplyDto,
  ReviewIdParamsDto,
  SELLER_REVIEW_LIST_SPEC,
} from '../dto/review-request.dto';
import {
  toAdminReviewDto,
  toRatingSummaryDto,
  toReviewDto,
  toSellerReviewDto,
} from '../dto/review-response.dto';
import { type ReviewModerationService } from '../service/review-moderation.service';
import { type ReviewViewService } from '../service/review-view.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** A boolean custom filter (no column): applied by the repository. */
function booleanFilter(query: ParsedListQuery, field: string): boolean | undefined {
  const value = query.filters.find((filter) => filter.field === field)?.value;
  return typeof value === 'boolean' ? value : undefined;
}

function callerOf(req: Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}

abstract class ListController {
  constructor(private readonly listEnv: ListEnv) {}

  protected listQuery(req: Request, spec: ListSpec): ParsedListQuery {
    return parseListQuery(req.query, spec, {
      defaultLimit: this.listEnv.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.listEnv.PAGINATION_MAX_LIMIT,
    });
  }
}

/** HTTP only (spec 17 §4.1): a product's reviews and its summary, for anyone. */
@injectable()
export class PublicReviewController extends ListController {
  constructor(
    @inject(TOKENS.ReviewViewService) private readonly views: ReviewViewService,
    @inject(TOKENS.Env) env: ListEnv,
  ) {
    super(env);
  }

  list = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    const query = this.listQuery(req, PUBLIC_REVIEW_LIST_SPEC);
    const page = await this.views.listPublic(productId, query, booleanFilter(query, 'hasImages'));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toReviewDto), page.meta);
  };

  summary = async (req: Request, res: Response): Promise<void> => {
    const { productId } = await validateDto(ProductIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toRatingSummaryDto(await this.views.summary(productId)));
  };
}

/** HTTP only (spec 17 §4.3): the reviews of the seller's products, and the one reply. */
@injectable()
export class SellerReviewController extends ListController {
  constructor(
    @inject(TOKENS.ReviewViewService) private readonly views: ReviewViewService,
    @inject(TOKENS.ReviewModerationService) private readonly moderation: ReviewModerationService,
    @inject(TOKENS.Env) env: ListEnv,
  ) {
    super(env);
  }

  list = async (req: Request, res: Response): Promise<void> => {
    const query = this.listQuery(req, SELLER_REVIEW_LIST_SPEC);
    const page = await this.views.listForSeller(callerOf(req), query, booleanFilter(query, 'replied'));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toSellerReviewDto), page.meta);
  };

  reply = async (req: Request, res: Response): Promise<void> => {
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    const { body } = await validateDto(ReplyDto, req.body);
    const review = await this.moderation.reply(callerOf(req), reviewId, body);
    // The seller is approved here (the reply needed it), and it has just replied.
    const [view] = await this.views.sellerViews([review], true);
    if (!view) throw new Error(`no view built for review ${reviewId}`);
    sendSuccess(res, HTTP_STATUS.CREATED, toSellerReviewDto(view));
  };
}

/** HTTP only (spec 17 §4.4): every live review; hiding is audited (spec 20). */
@injectable()
export class AdminReviewController extends ListController {
  constructor(
    @inject(TOKENS.ReviewViewService) private readonly views: ReviewViewService,
    @inject(TOKENS.ReviewModerationService) private readonly moderation: ReviewModerationService,
    @inject(TOKENS.Env) env: ListEnv,
  ) {
    super(env);
  }

  list = async (req: Request, res: Response): Promise<void> => {
    const page = await this.views.listForAdmin(this.listQuery(req, ADMIN_REVIEW_LIST_SPEC));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAdminReviewDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    await this.respond(res, reviewId);
  };

  hide = async (req: Request, res: Response): Promise<void> => {
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    const { reason } = await validateDto(HideDto, req.body);
    await this.moderation.hide(callerOf(req), reviewId, reason);
    await this.respond(res, reviewId);
  };

  unhide = async (req: Request, res: Response): Promise<void> => {
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    await this.moderation.unhide(reviewId);
    await this.respond(res, reviewId);
  };

  hideReply = async (req: Request, res: Response): Promise<void> => {
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    const { reason } = await validateDto(HideDto, req.body);
    await this.moderation.hideReply(callerOf(req), reviewId, reason);
    await this.respond(res, reviewId);
  };

  unhideReply = async (req: Request, res: Response): Promise<void> => {
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    await this.moderation.unhideReply(reviewId);
    await this.respond(res, reviewId);
  };

  private async respond(res: Response, reviewId: string): Promise<void> {
    sendSuccess(res, HTTP_STATUS.OK, toAdminReviewDto(await this.views.getForAdmin(reviewId)));
  }
}
