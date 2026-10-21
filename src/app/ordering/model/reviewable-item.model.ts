/** A delivered order item of a customer, as reviews sees it (spec 09 §8.1, OR-26, spec 17 UC-RV-1). */
export interface ReviewableItem {
  orderItemId: string;
  orderId: string;
  productId: string;
  variantId: string;
  sellerId: string;
  /** When its seller order was delivered, to the millisecond (D-19). */
  deliveredAt: Date;
  /** quantity − cancelled quantity; a fully cancelled item can't be reviewed. */
  openQuantity: number;
  /** The variant's attributes as ordered (the review's `variant_options` snapshot, RV-10). */
  attributes: { attribute: string; value: string }[];
}

/** One row of `GET /me/reviewable-items` (spec 17 §4.2). */
export interface DeliveredItem extends ReviewableItem {
  orderNumber: string;
  productName: string;
  /** The order-item image snapshot (spec 09 §8.3); null without one. */
  imageMediaId: string | null;
}

export interface DeliveredItemsQuery {
  /** Only seller orders delivered at or after this (the review window, spec 17 §1.1). */
  deliveredAfter: Date;
  /** Products the customer already reviewed (RV-12). */
  excludeProductIds: readonly string[];
  /** Keyset position: the last row of the previous page. */
  after: { deliveredAt: Date; orderItemId: string } | null;
  limit: number;
}
