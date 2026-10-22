import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type AuthContext } from '../../../lib/auth';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import {
  HTTP_STATUS,
  type ListSpec,
  parseListQuery,
  sendNoContent,
  sendSuccess,
  validateDto,
} from '../../../lib/http';
import {
  CreateReviewDto,
  EditReviewDto,
  MY_REVIEW_LIST_SPEC,
  REVIEWABLE_ITEM_LIST_SPEC,
  ReviewIdParamsDto,
} from '../dto/review-request.dto';
import { toMyReviewDto, toReviewableItemDto } from '../dto/review-response.dto';
import { type ReviewViewService } from '../service/review-view.service';
import { type ReviewService } from '../service/review.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 17 §4.2): the customer's own reviews. */
@injectable()
export class MyReviewController {
  constructor(
    @inject(TOKENS.ReviewService) private readonly reviews: ReviewService,
    @inject(TOKENS.ReviewViewService) private readonly views: ReviewViewService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const customer = callerOf(req);
    const dto = await validateDto(CreateReviewDto, req.body);
    const review = await this.reviews.create(customer, {
      orderItemId: dto.orderItemId,
      rating: dto.rating,
      title: dto.title ?? null,
      body: dto.body ?? null,
      imageMediaIds: dto.imageMediaIds ?? [],
    });
    sendSuccess(res, HTTP_STATUS.CREATED, toMyReviewDto(await this.views.getMine(customer, review.id)));
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const page = await this.views.listMine(callerOf(req), this.listQuery(req, MY_REVIEW_LIST_SPEC));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toMyReviewDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toMyReviewDto(await this.views.getMine(callerOf(req), reviewId)));
  };

  edit = async (req: Request, res: Response): Promise<void> => {
    const customer = callerOf(req);
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    const dto = await validateDto(EditReviewDto, req.body);
    await this.reviews.edit(customer, reviewId, {
      rating: dto.rating,
      title: dto.title,
      body: dto.body,
      imageMediaIds: dto.imageMediaIds,
    });
    sendSuccess(res, HTTP_STATUS.OK, toMyReviewDto(await this.views.getMine(customer, reviewId)));
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { reviewId } = await validateDto(ReviewIdParamsDto, req.params);
    await this.reviews.remove(callerOf(req), reviewId);
    sendNoContent(res);
  };

  reviewableItems = async (req: Request, res: Response): Promise<void> => {
    const page = await this.views.reviewableItems(
      callerOf(req),
      this.listQuery(req, REVIEWABLE_ITEM_LIST_SPEC),
    );
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toReviewableItemDto), page.meta);
  };

  private listQuery(req: Request, spec: ListSpec) {
    return parseListQuery(req.query, spec, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
  }
}

function callerOf(req: Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
