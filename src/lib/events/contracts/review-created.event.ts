import { defineEvent } from './define-event';

/** Publisher: reviews (UC-RV-1). Consumer: notifications (the seller, RV-8). */
export interface ReviewCreatedPayload {
  reviewId: string;
  productId: string;
  sellerId: string;
  customerId: string;
  rating: number;
}

export const ReviewCreated = defineEvent<ReviewCreatedPayload>('review.created', 1, 'product_review');
