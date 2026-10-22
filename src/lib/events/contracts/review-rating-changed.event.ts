import { defineEvent } from './define-event';

/** One subject's aggregate after the change; `version` orders them (spec 17 §1.2). */
export interface RatingAggregate {
  ratingCount: number;
  ratingSum: number;
  version: number;
}

/**
 * Publisher: reviews, whenever what counts changes (create, rating edit, hide, unhide, delete).
 * Consumers: catalog (`catalog.listing-projections`), sellers (`sellers.rating-projection`). Absolute
 * values, so a consumer applies only a newer `version` and computes the average itself (`lib/rating`).
 */
export interface ReviewRatingChangedPayload {
  product: RatingAggregate & { productId: string };
  seller: RatingAggregate & { sellerId: string };
}

export const ReviewRatingChanged = defineEvent<ReviewRatingChangedPayload>(
  'review.rating_changed',
  1,
  'product',
);
