import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { MY_REVIEW_PATHS as P, REVIEW_PATHS as R } from './constants';
import { type MyReviewController } from './controller/my-review.controller';
import {
  type AdminReviewController,
  type PublicReviewController,
  type SellerReviewController,
} from './controller/review-moderation.controller';
import { CreateReviewDto, EditReviewDto, HideDto, ReplyDto } from './dto/review-request.dto';
import {
  AdminReviewDto,
  MyReviewDto,
  RatingSummaryDto,
  ReviewableItemDto,
  ReviewDto,
  SellerReviewDto,
} from './dto/review-response.dto';
import { ReviewStatus } from './enums';

const TAGS = ['reviews'] as const;

export interface ReviewRouteDeps {
  mine: MyReviewController;
  public: PublicReviewController;
  seller: SellerReviewController;
  admin: AdminReviewController;
  jwtVerifier: JwtVerifier;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/**
 * Spec 17 §4: public (§4.1), customers' own reviews (§4.2), sellers (§4.3), admins (§4.4); general
 * rate limit. No Idempotency-Key on `POST /reviews`:
 * the unique index already makes a retry harmless (409).
 */
export function reviewRoutes(deps: ReviewRouteDeps): Router {
  const { mine: c, docs, basePath } = deps;
  const router = Router();
  const customers = [authenticate(deps.jwtVerifier), requireRole(UserRole.CUSTOMER)];

  router.post(P.REVIEWS, ...customers, c.create);
  router.get(P.MY_REVIEWS, ...customers, c.list);
  router.get(P.MY_REVIEW, ...customers, c.get);
  router.patch(P.MY_REVIEW, ...customers, c.edit);
  router.delete(P.MY_REVIEW, ...customers, c.remove);
  router.get(P.REVIEWABLE_ITEMS, ...customers, c.reviewableItems);

  router.get(R.PRODUCT_SUMMARY, deps.public.summary);
  router.get(R.PRODUCT_REVIEWS, deps.public.list);

  const sellers = [authenticate(deps.jwtVerifier), requireRole(UserRole.SELLER)];
  router.get(R.SELLER_REVIEWS, ...sellers, deps.seller.list);
  router.post(R.SELLER_REPLY, ...sellers, deps.seller.reply);

  const a = deps.admin;
  const admins = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];
  router.get(R.ADMIN_REVIEWS, ...admins, a.list);
  router.get(R.ADMIN_REVIEW, ...admins, a.get);
  router.post(R.ADMIN_HIDE, ...admins, a.hide);
  router.post(R.ADMIN_UNHIDE, ...admins, a.unhide);
  router.post(R.ADMIN_REPLY_HIDE, ...admins, a.hideReply);
  router.post(R.ADMIN_REPLY_UNHIDE, ...admins, a.unhideReply);

  const common = { tags: TAGS, auth: true } as const;
  const page = [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'cursor', in: 'query', schema: { type: 'string' } },
  ] as const;
  const myReview = { 200: { description: 'The review', body: MyReviewDto } };
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.REVIEWS}`,
    summary:
      'Review a product you received, from one of its delivered order items, within REVIEW_WINDOW_DAYS of delivery. One live review per product (REVIEW_NOT_ALLOWED 422, REVIEW_WINDOW_CLOSED 422, REVIEW_ALREADY_EXISTS 409, MEDIA_NOT_ATTACHABLE 422)',
    requestBody: CreateReviewDto,
    responses: { 201: { description: 'The review, published', body: MyReviewDto } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.MY_REVIEWS}`,
    summary: 'My reviews, newest first, hidden ones included',
    query: [...page, { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } }],
    responses: {
      200: { description: 'One page of reviews', body: MyReviewDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.MY_REVIEW}`,
    summary: 'One of my reviews (REVIEW_NOT_FOUND)',
    responses: myReview,
  });
  docs.add({
    ...common,
    method: 'patch',
    path: `${basePath}${P.MY_REVIEW}`,
    summary:
      'Edit within REVIEW_EDIT_WINDOW_DAYS of writing it; imageMediaIds replaces the list (REVIEW_NOT_FOUND, REVIEW_EDIT_WINDOW_CLOSED 422, MEDIA_NOT_ATTACHABLE 422)',
    requestBody: EditReviewDto,
    responses: myReview,
  });
  docs.add({
    ...common,
    method: 'delete',
    path: `${basePath}${P.MY_REVIEW}`,
    summary: 'Delete; you may review the product again while its window is open (REVIEW_NOT_FOUND)',
    responses: { 204: { description: 'Deleted' } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.REVIEWABLE_ITEMS}`,
    summary:
      'Delivered items you can still review (products you reviewed are left out), newest delivery first',
    query: [...page, { name: 'sort', in: 'query', schema: { enum: ['-deliveredAt'] } }],
    responses: {
      200: { description: 'One page of items', body: ReviewableItemDto, isArray: true, paginated: true },
    },
  });
  const sortRating = {
    name: 'sort',
    in: 'query' as const,
    schema: { enum: ['createdAt', '-createdAt', 'rating', '-rating'] },
  };
  docs.add({
    tags: ['catalog: reviews'],
    auth: false,
    method: 'get',
    path: `${basePath}${R.PRODUCT_REVIEWS}`,
    summary:
      'Published reviews of a visible product, newest first. Filters: rating[eq|in], hasImages[eq]. Sort: createdAt, rating (PRODUCT_NOT_FOUND)',
    query: [
      ...page,
      sortRating,
      { name: 'rating[eq]', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5 } },
      { name: 'rating[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'hasImages[eq]', in: 'query', schema: { type: 'boolean' } },
    ],
    responses: {
      200: { description: 'One page of reviews', body: ReviewDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    tags: ['catalog: reviews'],
    auth: false,
    method: 'get',
    path: `${basePath}${R.PRODUCT_SUMMARY}`,
    summary: 'Average, count and distribution of the published reviews (PRODUCT_NOT_FOUND)',
    responses: { 200: { description: 'The rating summary', body: RatingSummaryDto } },
  });
  const seller = { tags: ['seller: reviews'], auth: true } as const;
  docs.add({
    ...seller,
    method: 'get',
    path: `${basePath}${R.SELLER_REVIEWS}`,
    summary:
      'Published reviews of my products, newest first (any seller status). Filters: productId[eq], rating[eq|in], replied[eq], createdAt[gte|lte]. Sort: createdAt, rating',
    query: [
      ...page,
      sortRating,
      { name: 'productId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'rating[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'replied[eq]', in: 'query', schema: { type: 'boolean' } },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: {
      200: { description: 'One page of reviews', body: SellerReviewDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...seller,
    method: 'post',
    path: `${basePath}${R.SELLER_REPLY}`,
    summary:
      'Reply once, final (SELLER_NOT_APPROVED 403, REVIEW_NOT_FOUND 404, REVIEW_HIDDEN 409, REVIEW_ALREADY_REPLIED 409)',
    requestBody: ReplyDto,
    responses: { 201: { description: 'The review with its reply', body: SellerReviewDto } },
  });
  const admin = { tags: ['admin: reviews'], auth: true } as const;
  const adminReview = { 200: { description: 'The review', body: AdminReviewDto } };
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${R.ADMIN_REVIEWS}`,
    summary:
      'Every live review, hidden ones included, newest first. Filters: status[eq], productId[eq], sellerId[eq], customerId[eq], rating[eq|in|lte], createdAt[gte|lte]',
    query: [
      ...page,
      { name: 'status[eq]', in: 'query', schema: { enum: Object.values(ReviewStatus) } },
      { name: 'productId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'sellerId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'customerId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'rating[lte]', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5 } },
    ],
    responses: {
      200: { description: 'One page of reviews', body: AdminReviewDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${R.ADMIN_REVIEW}`,
    summary: 'One review (REVIEW_NOT_FOUND)',
    responses: adminReview,
  });
  const moderation = [
    [
      R.ADMIN_HIDE,
      'Hide a published review; it stops counting (REVIEW_NOT_FOUND, REVIEW_INVALID_STATUS_TRANSITION 409)',
      HideDto,
    ],
    [
      R.ADMIN_UNHIDE,
      'Publish a hidden review again (REVIEW_NOT_FOUND, REVIEW_INVALID_STATUS_TRANSITION 409)',
      undefined,
    ],
    [
      R.ADMIN_REPLY_HIDE,
      "Hide the seller's reply (REVIEW_NOT_FOUND, REVIEW_REPLY_NOT_FOUND 404, REVIEW_INVALID_STATUS_TRANSITION 409)",
      HideDto,
    ],
    [
      R.ADMIN_REPLY_UNHIDE,
      "Show the seller's reply again (REVIEW_NOT_FOUND, REVIEW_REPLY_NOT_FOUND 404, REVIEW_INVALID_STATUS_TRANSITION 409)",
      undefined,
    ],
  ] as const;
  for (const [path, summary, requestBody] of moderation) {
    docs.add({
      ...admin,
      method: 'post',
      path: `${basePath}${path}`,
      summary,
      requestBody,
      responses: adminReview,
    });
  }
  return router;
}
