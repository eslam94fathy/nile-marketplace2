import { inject, injectable } from 'tsyringe';
import { type AuthContext } from '../../../lib/auth';
import { type IClock } from '../../../lib/clock';
import { TOKENS } from '../../../lib/di';
import { invalidQuery } from '../../../lib/error';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ICatalogDirectory, type ProductCard } from '../../catalog';
import { type ICustomerDirectory } from '../../customers';
import { type ImageView, type MediaService } from '../../media';
import { type DeliveredItem, type IOrderingDirectory } from '../../ordering';
import { productNotFound, reviewNotFound, sellerProfileMissing } from '../errors';
import { type ProductReview, type RatingStats, type ReviewReply } from '../model/review.model';
import { type RatingStatsRepository } from '../repository/rating-stats.repository';
import { RatingSubjectType, ReviewStatus } from '../enums';
import { type ISellerDirectory, SellerStatus } from '../../sellers';
import { type ProductReviewRepository } from '../repository/product-review.repository';
import { type ReviewImageRepository } from '../repository/review-image.repository';
import { type ReviewReplyRepository } from '../repository/review-reply.repository';
import { type ReviewService } from './review.service';

export interface ReviewView {
  review: ProductReview;
  images: ImageView[];
  reviewerName: string;
  /** Hidden replies too; the DTO decides who sees them. */
  reply: ReviewReply | null;
}

export interface MyReviewView extends ReviewView {
  /** Undefined only if catalog lost the product, which never happens (products are soft-deleted). */
  product: ProductCard | undefined;
  canEdit: boolean;
}

export interface SellerReviewView extends ReviewView {
  productName: string;
  canReply: boolean;
}

export interface ReviewableItemView {
  item: DeliveredItem;
  image: ImageView | null;
  windowEndsAt: Date;
}

export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

/**
 * Read side of spec 17 §4, with batched lookups per page (G20): images (media, public), reviewer
 * names (customers, RV-6), replies, product cards (catalog).
 */
@injectable()
export class ReviewViewService {
  constructor(
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.ProductReviewRepository) private readonly reviews: ProductReviewRepository,
    @inject(TOKENS.ReviewImageRepository) private readonly images: ReviewImageRepository,
    @inject(TOKENS.ReviewReplyRepository) private readonly replies: ReviewReplyRepository,
    @inject(TOKENS.ReviewService) private readonly reviewService: ReviewService,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
    @inject(TOKENS.CatalogDirectory) private readonly catalog: ICatalogDirectory,
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.RatingStatsRepository) private readonly stats: RatingStatsRepository,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
  ) {}

  async listMine(customer: AuthContext, query: ParsedListQuery): Promise<Page<MyReviewView>> {
    const customerId = await this.reviewService.customerIdOf(customer.userId);
    const page = toPage(await this.reviews.listForCustomer(customerId, query), query, (r) => r.createdAt);
    return { items: await this.myViews(page.items), meta: page.meta };
  }

  async getMine(customer: AuthContext, reviewId: string): Promise<MyReviewView> {
    const customerId = await this.reviewService.customerIdOf(customer.userId);
    const review = await this.reviews.findForCustomer(reviewId, customerId);
    if (!review) throw reviewNotFound();
    const [view] = await this.myViews([review]);
    if (!view) throw new Error(`no view built for review ${reviewId}`);
    return view;
  }

  /** The author's view of reviews: content, status, the product card and whether it can still be edited. */
  async myViews(reviews: readonly ProductReview[]): Promise<MyReviewView[]> {
    const [base, cards] = await Promise.all([
      this.views(reviews),
      this.catalog.getProductCards(reviews.map((r) => r.productId)),
    ]);
    const now = this.clock.now();
    return base.map((view) => ({
      ...view,
      product: cards.get(view.review.productId),
      canEdit: this.reviewService.editWindowEnd(view.review.createdAt) >= now,
    }));
  }

  /**
   * GET /me/reviewable-items (spec 17 §4.2): delivered items still inside the window whose product the
   * customer hasn't reviewed (RV-12: ordering leaves them out, so pages are full), newest delivery first.
   */
  async reviewableItems(customer: AuthContext, query: ParsedListQuery): Promise<Page<ReviewableItemView>> {
    // Ordering pages newest delivery first only (OR-26).
    if (query.sort.direction !== 'desc') {
      throw invalidQuery([{ field: 'sort', constraint: 'isIn', message: 'only -deliveredAt is supported' }]);
    }
    const customerId = await this.reviewService.customerIdOf(customer.userId);
    const now = this.clock.now();
    const reviewed = await this.reviews.findReviewedProductIds(customerId);
    const items = await this.ordering.listDeliveredItems(customerId, {
      deliveredAfter: this.reviewService.windowStart(now),
      excludeProductIds: reviewed,
      after: query.cursor
        ? { deliveredAt: new Date(String(query.cursor.value)), orderItemId: query.cursor.id }
        : null,
      limit: query.limit + 1,
    });
    const page = toPage(
      items.map((item) => ({ ...item, id: item.orderItemId })),
      query,
      (item) => item.deliveredAt,
    );
    const images = await this.media.getImages(
      page.items.flatMap((i) => (i.imageMediaId ? [i.imageMediaId] : [])),
    );
    return {
      items: page.items.map((item) => ({
        item,
        image: item.imageMediaId ? (images.get(item.imageMediaId) ?? null) : null,
        windowEndsAt: this.reviewService.windowEnd(item.deliveredAt),
      })),
      meta: page.meta,
    };
  }

  /** GET /products/:productId/reviews (spec 17 §4.1): published, live reviews of a visible product. */
  async listPublic(
    productId: string,
    query: ParsedListQuery,
    hasImages: boolean | undefined,
  ): Promise<Page<ReviewView>> {
    if (!(await this.catalog.isPubliclyVisible(productId))) throw productNotFound();
    const rows = await this.reviews.listPublic(productId, query, hasImages);
    const page = toPage(rows, query, (r) => (query.sort.field === 'rating' ? r.rating : r.createdAt));
    return { items: await this.views(page.items), meta: page.meta };
  }

  /** The summary is the stored aggregate, never computed per request (spec 17 §4.1). */
  async summary(productId: string): Promise<RatingStats> {
    if (!(await this.catalog.isPubliclyVisible(productId))) throw productNotFound();
    return (
      (await this.stats.find(RatingSubjectType.PRODUCT, productId)) ?? {
        ratingCount: 0,
        ratingSum: 0,
        counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        version: 0,
      }
    );
  }

  /**
   * GET /seller/reviews (spec 17 §4.3): the seller reads in any seller status; replying needs
   * `approved`, so `canReply` says whether a reply would be accepted now.
   */
  async listForSeller(
    seller: AuthContext,
    query: ParsedListQuery,
    replied: boolean | undefined,
  ): Promise<Page<SellerReviewView>> {
    const profile = await this.sellers.getSellerByUserId(seller.userId);
    if (!profile) throw sellerProfileMissing(seller.userId);
    const rows = await this.reviews.listForSeller(profile.sellerId, query, replied);
    const page = toPage(rows, query, (r) => (query.sort.field === 'rating' ? r.rating : r.createdAt));
    return {
      items: await this.sellerViews(page.items, profile.status === SellerStatus.APPROVED),
      meta: page.meta,
    };
  }

  async sellerViews(reviews: readonly ProductReview[], approved: boolean): Promise<SellerReviewView[]> {
    const [base, cards] = await Promise.all([
      this.views(reviews),
      this.catalog.getProductCards(reviews.map((r) => r.productId)),
    ]);
    return base.map((view) => ({
      ...view,
      productName: cards.get(view.review.productId)?.name ?? '',
      canReply: approved && view.reply === null && view.review.status === ReviewStatus.PUBLISHED,
    }));
  }

  /** GET /admin/reviews (spec 17 §4.4): every live review, hidden ones and hidden replies included. */
  async listForAdmin(query: ParsedListQuery): Promise<Page<ReviewView>> {
    const rows = await this.reviews.listForAdmin(query);
    const page = toPage(rows, query, (r) => r.createdAt);
    return { items: await this.views(page.items), meta: page.meta };
  }

  async getForAdmin(reviewId: string): Promise<ReviewView> {
    const review = await this.reviews.findLiveById(reviewId);
    if (!review) throw reviewNotFound();
    const [view] = await this.views([review]);
    if (!view) throw new Error(`no view built for review ${reviewId}`);
    return view;
  }

  /** Images, reviewer names and replies for a page of reviews: one query or call each. */
  async views(reviews: readonly ProductReview[]): Promise<ReviewView[]> {
    const ids = reviews.map((r) => r.id);
    const [mediaIds, names, replies] = await Promise.all([
      this.images.findMediaIds(ids),
      this.customers.getDisplayNames(reviews.map((r) => r.customerId)),
      this.replies.findByReviewIds(ids),
    ]);
    const images = await this.media.getImages([...mediaIds.values()].flat());
    return reviews.map((review) => ({
      review,
      images: (mediaIds.get(review.id) ?? []).flatMap((id) => {
        const image = images.get(id);
        return image ? [image] : [];
      }),
      reviewerName: names.get(review.customerId) ?? '',
      reply: replies.get(review.id) ?? null,
    }));
  }
}
