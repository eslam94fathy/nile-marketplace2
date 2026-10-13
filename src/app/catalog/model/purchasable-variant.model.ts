/** What cart and ordering see of a variant (spec 06 §2 `getVariantsForPurchase`). */
export interface PurchasableVariant {
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  sku: string;
  /** Decimal string, e.g. "150.00" (EGP). */
  price: string;
  sellerId: string;
  /** Display name and value, ancestors' attributes first. */
  attributes: { attribute: string; value: string }[];
  /** Variant active and live; product active, seller approved, product live. */
  purchasable: boolean;
}
