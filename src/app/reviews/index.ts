/**
 * reviews module (docs/spec/17-reviews.md): verified product reviews, seller replies, and the rating
 * aggregates of every product and seller.
 * Owns tables: product_reviews, review_images, review_replies, review_rating_stats. No other module reads
 * or writes them.
 * May call: ordering (reviewable items), catalog (product cards, visibility), customers (reviewer names),
 * sellers (the reply guard), media (review images); audit rows go through lib/audit. Nobody calls reviews:
 * catalog and sellers receive the aggregates through `review.rating_changed` (spec 17 §5).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type OpenApiRegistry } from '../../lib/http';
import { MyReviewController } from './controller/my-review.controller';
import {
  AdminReviewController,
  PublicReviewController,
  SellerReviewController,
} from './controller/review-moderation.controller';
import { registerReviewsConstraintErrors } from './errors';
import { ProductReviewRepository } from './repository/product-review.repository';
import { RatingStatsRepository } from './repository/rating-stats.repository';
import { ReviewImageRepository } from './repository/review-image.repository';
import { ReviewReplyRepository } from './repository/review-reply.repository';
import { reviewRoutes } from './routes';
import { RatingAggregatesService } from './service/rating-aggregates.service';
import { ReviewModerationService } from './service/review-moderation.service';
import { ReviewViewService } from './service/review-view.service';
import { ReviewService } from './service/review.service';

export { ReviewsErrorCode } from './errors';
export { ReviewStatus } from './enums';

/** api process. Needs ordering, catalog, customers, sellers and media registered. */
export function registerReviewsModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.ProductReviewRepository, ProductReviewRepository);
  container.registerSingleton(TOKENS.ReviewImageRepository, ReviewImageRepository);
  container.registerSingleton(TOKENS.ReviewReplyRepository, ReviewReplyRepository);
  container.registerSingleton(TOKENS.RatingStatsRepository, RatingStatsRepository);
  container.registerSingleton(TOKENS.RatingAggregatesService, RatingAggregatesService);
  container.registerSingleton(TOKENS.ReviewService, ReviewService);
  container.registerSingleton(TOKENS.ReviewViewService, ReviewViewService);
  container.registerSingleton(TOKENS.MyReviewController, MyReviewController);
  container.registerSingleton(TOKENS.ReviewModerationService, ReviewModerationService);
  container.registerSingleton(TOKENS.PublicReviewController, PublicReviewController);
  container.registerSingleton(TOKENS.SellerReviewController, SellerReviewController);
  container.registerSingleton(TOKENS.AdminReviewController, AdminReviewController);
  registerReviewsConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createReviewsRouter(container: DependencyContainer, basePath: string): Router {
  return reviewRoutes({
    mine: container.resolve<MyReviewController>(TOKENS.MyReviewController),
    public: container.resolve<PublicReviewController>(TOKENS.PublicReviewController),
    seller: container.resolve<SellerReviewController>(TOKENS.SellerReviewController),
    admin: container.resolve<AdminReviewController>(TOKENS.AdminReviewController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
