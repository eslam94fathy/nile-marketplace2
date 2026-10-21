import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { MY_REVIEW_PATHS as P } from './constants';
import { type MyReviewController } from './controller/my-review.controller';
import { CreateReviewDto, EditReviewDto } from './dto/review-request.dto';
import { MyReviewDto, ReviewableItemDto } from './dto/review-response.dto';

const TAGS = ['reviews'] as const;

export interface ReviewRouteDeps {
  mine: MyReviewController;
  jwtVerifier: JwtVerifier;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/**
 * Spec 17 §4.2: customers, their own reviews; general rate limit. No Idempotency-Key on `POST /reviews`:
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
  return router;
}
