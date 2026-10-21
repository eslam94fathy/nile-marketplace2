import { inject, injectable } from 'tsyringe';
import { type AuthContext } from '../../../lib/auth';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, ReviewCreated } from '../../../lib/events';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { type ICustomerDirectory } from '../../customers';
import { MediaPurpose, type MediaService } from '../../media';
import { type IOrderingDirectory } from '../../ordering';
import { type Rating } from '../constants';
import { ReviewStatus } from '../enums';
import {
  customerProfileMissing,
  reviewEditWindowClosed,
  reviewNotAllowed,
  reviewNotFound,
  reviewWindowClosed,
} from '../errors';
import { type ProductReview } from '../model/review.model';
import { type ProductReviewRepository } from '../repository/product-review.repository';
import { type ReviewImageRepository } from '../repository/review-image.repository';
import { type RatingAggregatesService, ratingDelta } from './rating-aggregates.service';

type ReviewEnv = Pick<Env, 'REVIEW_WINDOW_DAYS' | 'REVIEW_EDIT_WINDOW_DAYS'>;

export interface WriteReviewInput {
  orderItemId: string;
  rating: Rating;
  title: string | null;
  body: string | null;
  imageMediaIds: readonly string[];
}

/** UC-RV-2 edit: what is absent stays; `imageMediaIds` replaces the list as a whole. */
export interface EditReviewInput {
  rating?: Rating;
  title?: string | null;
  body?: string | null;
  imageMediaIds?: readonly string[];
}

/**
 * The customer's writes (spec 17 UC-RV-1, UC-RV-2). Eligibility is read through ordering before the
 * transaction; inside it the lock order is review row → media rows (claim / release) → product stats
 * → seller stats (§1.2).
 */
@injectable()
export class ReviewService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Env) private readonly env: ReviewEnv,
    @inject(TOKENS.ProductReviewRepository) private readonly reviews: ProductReviewRepository,
    @inject(TOKENS.ReviewImageRepository) private readonly images: ReviewImageRepository,
    @inject(TOKENS.RatingAggregatesService) private readonly aggregates: RatingAggregatesService,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
  ) {}

  /**
   * UC-RV-1. A second live review of the product fails on its unique index (409 REVIEW_ALREADY_EXISTS,
   * mapped from 23505): there is no pre-check, a concurrent second review simply loses.
   */
  async create(customer: AuthContext, input: WriteReviewInput): Promise<ProductReview> {
    const customerId = await this.customerIdOf(customer.userId);
    const item = await this.ordering.getReviewableItem(customerId, input.orderItemId);
    if (!item || item.openQuantity <= 0) throw reviewNotAllowed();
    if (this.windowEnd(item.deliveredAt) < this.clock.now()) throw reviewWindowClosed();
    return this.tx.run(async (trx) => {
      const review = await this.reviews.insert(
        {
          productId: item.productId,
          sellerId: item.sellerId,
          customerId,
          orderItemId: item.orderItemId,
          variantId: item.variantId,
          variantOptions: item.attributes,
          rating: input.rating,
          title: input.title,
          body: input.body,
        },
        trx,
      );
      await this.attach(review.id, customer.userId, input.imageMediaIds, trx);
      await this.outbox.add(trx, {
        contract: ReviewCreated,
        aggregateId: review.id,
        payload: {
          reviewId: review.id,
          productId: review.productId,
          sellerId: review.sellerId,
          customerId,
          rating: review.rating,
        },
      });
      await this.aggregates.apply(review, ratingDelta({ add: review.rating }), trx);
      return review;
    });
  }

  /**
   * UC-RV-2 edit, within REVIEW_EDIT_WINDOW_DAYS of `created_at`. Allowed while hidden (it stays
   * hidden); a changed rating of a published review moves the aggregates by the difference.
   */
  async edit(customer: AuthContext, reviewId: string, input: EditReviewInput): Promise<ProductReview> {
    const customerId = await this.customerIdOf(customer.userId);
    return this.tx.run(async (trx) => {
      const locked = await this.reviews.lockForCustomer(reviewId, customerId, trx);
      if (!locked) throw reviewNotFound();
      const now = this.clock.now();
      if (this.editWindowEnd(locked.createdAt) < now) throw reviewEditWindowClosed();
      if (input.imageMediaIds !== undefined) {
        await this.replaceImages(locked.id, customer.userId, input.imageMediaIds, trx);
      }
      const review = await this.reviews.updateContent(
        locked.id,
        { rating: input.rating, title: input.title, body: input.body },
        now,
        trx,
      );
      if (locked.status === ReviewStatus.PUBLISHED && review.rating !== locked.rating) {
        await this.aggregates.apply(review, ratingDelta({ add: review.rating, remove: locked.rating }), trx);
      }
      return review;
    });
  }

  /**
   * UC-RV-2 delete, any time: a soft delete, images released, aggregates decremented if it counted. The
   * customer may then review the product again while the window is open (RV-4).
   */
  async remove(customer: AuthContext, reviewId: string): Promise<void> {
    const customerId = await this.customerIdOf(customer.userId);
    await this.tx.run(async (trx) => {
      const locked = await this.reviews.lockForCustomer(reviewId, customerId, trx);
      if (!locked) throw reviewNotFound();
      await this.replaceImages(locked.id, customer.userId, [], trx);
      await this.reviews.softDelete(locked.id, this.clock.now(), trx);
      if (locked.status === ReviewStatus.PUBLISHED) {
        await this.aggregates.apply(locked, ratingDelta({ remove: locked.rating }), trx);
      }
    });
  }

  /** The profile behind the JWT `sub`; a customer-role account without one is a defect (500). */
  async customerIdOf(userId: string): Promise<string> {
    const customerId = await this.customers.getCustomerIdByUserId(userId);
    if (customerId === null) throw customerProfileMissing(userId);
    return customerId;
  }

  /** The earliest delivery that is still reviewable at `now` (spec 17 §1.1). */
  windowStart(now: Date): Date {
    return addDuration(now, -this.env.REVIEW_WINDOW_DAYS, TimeUnit.DAY);
  }

  windowEnd(deliveredAt: Date): Date {
    return addDuration(deliveredAt, this.env.REVIEW_WINDOW_DAYS, TimeUnit.DAY);
  }

  editWindowEnd(createdAt: Date): Date {
    return addDuration(createdAt, this.env.REVIEW_EDIT_WINDOW_DAYS, TimeUnit.DAY);
  }

  private async attach(
    reviewId: string,
    ownerUserId: string,
    mediaIds: readonly string[],
    trx: DbTransaction,
  ): Promise<void> {
    await this.media.claim(mediaIds, { purpose: MediaPurpose.REVIEW_IMAGE, ownerUserId }, trx);
    await this.images.replace(reviewId, mediaIds, trx);
  }

  /**
   * Claims the new images, rewrites the rows, then releases the dropped ones (media wants the reference
   * rows gone before `release`, spec 14 §2). Images kept stay claimed.
   */
  private async replaceImages(
    reviewId: string,
    ownerUserId: string,
    next: readonly string[],
    trx: DbTransaction,
  ): Promise<void> {
    const current = (await this.images.findMediaIds([reviewId], trx)).get(reviewId) ?? [];
    const added = next.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !next.includes(id));
    await this.media.claim(added, { purpose: MediaPurpose.REVIEW_IMAGE, ownerUserId }, trx);
    await this.images.replace(reviewId, next, trx);
    await this.media.release(removed, trx);
  }
}
