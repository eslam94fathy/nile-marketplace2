import { type Rating } from '../constants';
import { type ReviewStatus } from '../enums';

/** A row of `product_reviews` (spec 17 §1, database §14.8, D-19). */
export interface ProductReview {
  id: string;
  productId: string;
  sellerId: string;
  customerId: string;
  orderItemId: string;
  variantId: string;
  variantOptions: { attribute: string; value: string }[];
  rating: Rating;
  title: string | null;
  body: string | null;
  status: ReviewStatus;
  hiddenReason: string | null;
  hiddenAt: Date | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export type NewProductReview = Pick<
  ProductReview,
  | 'productId'
  | 'sellerId'
  | 'customerId'
  | 'orderItemId'
  | 'variantId'
  | 'variantOptions'
  | 'rating'
  | 'title'
  | 'body'
>;

/** A seller's reply (spec 17 UC-RV-3). */
export interface ReviewReply {
  id: string;
  reviewId: string;
  sellerId: string;
  body: string;
  hiddenAt: Date | null;
  hiddenReason: string | null;
  createdAt: Date;
}

/** One subject's aggregate (spec 17 §1.2). */
export interface RatingStats {
  ratingCount: number;
  ratingSum: number;
  counts: Record<Rating, number>;
  version: number;
}
