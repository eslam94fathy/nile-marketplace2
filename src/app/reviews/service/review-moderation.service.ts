import { inject, injectable } from 'tsyringe';
import { type AuditAction, type IAuditRecorder } from '../../../lib/audit';
import { type AuthContext } from '../../../lib/auth';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, ReviewReplied } from '../../../lib/events';
import { type ISellerDirectory, SellerStatus, sellerNotApproved } from '../../sellers';
import { ReviewStatus } from '../enums';
import { reviewHidden, reviewInvalidStatusTransition, reviewNotFound, reviewReplyNotFound } from '../errors';
import { type ProductReview } from '../model/review.model';
import { type ProductReviewRepository } from '../repository/product-review.repository';
import { type ReviewReplyRepository } from '../repository/review-reply.repository';
import { type RatingAggregatesService, ratingDelta } from './rating-aggregates.service';

/**
 * The seller's reply (UC-RV-3) and the admin's moderation (UC-RV-4). Each locks the review first;
 * hiding or unhiding a review then moves the aggregates (review → product stats → seller stats).
 */
@injectable()
export class ReviewModerationService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
    @inject(TOKENS.ProductReviewRepository) private readonly reviews: ProductReviewRepository,
    @inject(TOKENS.ReviewReplyRepository) private readonly replies: ReviewReplyRepository,
    @inject(TOKENS.RatingAggregatesService) private readonly aggregates: RatingAggregatesService,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
  ) {}

  /**
   * UC-RV-3: once and final (RV-5). The seller must be approved, read `FOR SHARE` in the transaction
   * (the catalog write guard, SE-4); a second reply fails on its unique constraint (409).
   */
  async reply(seller: AuthContext, reviewId: string, body: string): Promise<ProductReview> {
    return this.tx.run(async (trx) => {
      const profile = await this.sellers.getSellerByUserId(seller.userId, { trx, lockShared: true });
      if (profile?.status !== SellerStatus.APPROVED) throw sellerNotApproved();
      const review = await this.reviews.lockLive(reviewId, trx, profile.sellerId);
      if (!review) throw reviewNotFound();
      if (review.status === ReviewStatus.HIDDEN) throw reviewHidden();
      await this.replies.insert({ reviewId: review.id, sellerId: profile.sellerId, body }, trx);
      await this.outbox.add(trx, {
        contract: ReviewReplied,
        aggregateId: review.id,
        payload: { reviewId: review.id, productId: review.productId, customerId: review.customerId },
      });
      return review;
    });
  }

  /** UC-RV-4: `published → hidden`; the review stops counting. */
  hide(admin: AuthContext, reviewId: string, reason: string): Promise<void> {
    return this.tx.run(async (trx) => {
      const review = await this.lockReview(reviewId, trx);
      if (review.status !== ReviewStatus.PUBLISHED) throw reviewInvalidStatusTransition();
      await this.reviews.setVisibility(
        review.id,
        { reason, byUserId: admin.userId, at: this.clock.now() },
        trx,
      );
      await this.aggregates.apply(review, ratingDelta({ remove: review.rating }), trx);
      await this.record(
        'review.hidden',
        review.id,
        { status: review.status },
        { status: ReviewStatus.HIDDEN },
        reason,
        trx,
      );
    });
  }

  /** UC-RV-4: `hidden → published`; the review counts again. */
  unhide(reviewId: string): Promise<void> {
    return this.tx.run(async (trx) => {
      const review = await this.lockReview(reviewId, trx);
      if (review.status !== ReviewStatus.HIDDEN) throw reviewInvalidStatusTransition();
      await this.reviews.setVisibility(review.id, null, trx);
      await this.aggregates.apply(review, ratingDelta({ add: review.rating }), trx);
      await this.record(
        'review.unhidden',
        review.id,
        { status: review.status },
        { status: ReviewStatus.PUBLISHED },
        null,
        trx,
      );
    });
  }

  /** UC-RV-4 for the seller's reply; no aggregate effect. */
  hideReply(admin: AuthContext, reviewId: string, reason: string): Promise<void> {
    return this.setReplyHidden(reviewId, { reason, byUserId: admin.userId });
  }

  unhideReply(reviewId: string): Promise<void> {
    return this.setReplyHidden(reviewId, null);
  }

  private setReplyHidden(reviewId: string, hide: { reason: string; byUserId: string } | null): Promise<void> {
    return this.tx.run(async (trx) => {
      const review = await this.lockReview(reviewId, trx);
      const reply = await this.replies.lockByReviewId(review.id, trx);
      if (!reply) throw reviewReplyNotFound();
      const wasHidden = reply.hiddenAt !== null;
      if (wasHidden === (hide !== null)) throw reviewInvalidStatusTransition();
      await this.replies.setHidden(reply.id, hide && { ...hide, at: this.clock.now() }, trx);
      await this.record(
        hide ? 'review_reply.hidden' : 'review_reply.unhidden',
        reply.id,
        { hidden: wasHidden },
        { hidden: !wasHidden },
        hide?.reason ?? null,
        trx,
      );
    });
  }

  private async lockReview(reviewId: string, trx: DbTransaction): Promise<ProductReview> {
    const review = await this.reviews.lockLive(reviewId, trx);
    if (!review) throw reviewNotFound();
    return review;
  }

  /** The audit row in the same transaction (spec 20 §2.2); the reason is the entry's `reason`. */
  private record(
    action: AuditAction,
    targetId: string,
    before: Record<string, string | boolean>,
    after: Record<string, string | boolean>,
    reason: string | null,
    trx: DbTransaction,
  ): Promise<void> {
    return this.audit.record({ action, targetId, before, after, reason }, trx);
  }
}
