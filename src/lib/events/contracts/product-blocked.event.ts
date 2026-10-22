import { defineEvent } from './define-event';

/** Publisher: catalog (spec 20 §3.4). `product.blocked` → notifications (the seller, BO-8, NO-33). */
export interface ProductBlockPayload {
  productId: string;
  sellerId: string;
  /** ISO-8601. */
  at: string;
}

export const ProductBlocked = defineEvent<ProductBlockPayload>('product.blocked', 1, 'product');

/** No consumer in R2 (spec 20 BO-14, spec 02 v1.3). */
export const ProductUnblocked = defineEvent<ProductBlockPayload>('product.unblocked', 1, 'product');
