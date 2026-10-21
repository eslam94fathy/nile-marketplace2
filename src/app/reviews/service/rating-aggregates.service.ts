import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, ReviewRatingChanged } from '../../../lib/events';
import { type Rating, RATINGS } from '../constants';
import { RatingSubjectType } from '../enums';
import { type ProductReview } from '../model/review.model';
import { type RatingDelta, type RatingStatsRepository } from '../repository/rating-stats.repository';

/** One review starting (`add`) and / or stopping (`remove`) to count, by rating. */
export function ratingDelta(change: { add?: Rating; remove?: Rating }): RatingDelta {
  const delta = Object.fromEntries(RATINGS.map((r) => [r, 0])) as Record<Rating, number>;
  if (change.add !== undefined) delta[change.add] += 1;
  if (change.remove !== undefined) delta[change.remove] -= 1;
  return delta;
}

const isEmpty = (delta: RatingDelta): boolean => RATINGS.every((r) => delta[r] === 0);

/**
 * The rating aggregates of spec 17 §1.2: only published, live reviews count. Every write that changes
 * what counts moves the product row, then the seller row (the lock order after the review row), and
 * publishes both absolute aggregates with their versions in the same transaction.
 */
@injectable()
export class RatingAggregatesService {
  constructor(
    @inject(TOKENS.RatingStatsRepository) private readonly stats: RatingStatsRepository,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
  ) {}

  /** Nothing happens for an empty delta (e.g. an edit that keeps the rating). */
  async apply(
    review: Pick<ProductReview, 'productId' | 'sellerId'>,
    delta: RatingDelta,
    trx: DbTransaction,
  ): Promise<void> {
    if (isEmpty(delta)) return;
    const product = await this.stats.apply(RatingSubjectType.PRODUCT, review.productId, delta, trx);
    const seller = await this.stats.apply(RatingSubjectType.SELLER, review.sellerId, delta, trx);
    await this.outbox.add(trx, {
      contract: ReviewRatingChanged,
      aggregateId: review.productId,
      payload: {
        product: {
          productId: review.productId,
          ratingCount: product.ratingCount,
          ratingSum: product.ratingSum,
          version: product.version,
        },
        seller: {
          sellerId: review.sellerId,
          ratingCount: seller.ratingCount,
          ratingSum: seller.ratingSum,
          version: seller.version,
        },
      },
    });
  }
}
