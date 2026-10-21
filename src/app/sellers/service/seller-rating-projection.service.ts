import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type RatingProjection } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { type SellerRepository } from '../repository/seller.repository';

/**
 * Consumer `sellers.rating-projection` ← `review.rating_changed` (spec 05 §8.1), worker only: the
 * seller's rating, applied only when its version is newer, so a late or repeated event never rolls it
 * back. No seller lock first: one conditional update needs none.
 */
@injectable()
export class SellerRatingProjectionService {
  constructor(
    @inject(TOKENS.SellerRepository) private readonly sellers: SellerRepository,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async apply(sellerId: string, rating: RatingProjection, trx: DbTransaction): Promise<void> {
    const applied = await this.sellers.applyRating(sellerId, rating, trx);
    if (!applied)
      this.logger.debug('seller rating not newer, skipped', { sellerId, version: rating.version });
  }
}
