import { defineEvent } from './define-event';

/** Publisher: reviews (UC-RV-3). Consumer: notifications (the reviewer, RV-8). */
export interface ReviewRepliedPayload {
  reviewId: string;
  productId: string;
  customerId: string;
}

export const ReviewReplied = defineEvent<ReviewRepliedPayload>('review.replied', 1, 'product_review');
