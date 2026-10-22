/** What cart and ordering see of a variant (spec 06 §2 `getVariantsForPurchase`). */
export interface PurchasableVariant {
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  /** The product's category: the coupon scope (spec 06 CA-20). */
  categoryId: string;
  sku: string;
  /** Decimal string, e.g. "150.00" (EGP). */
  price: string;
  sellerId: string;
  /** Display name and value, ancestors' attributes first. */
  attributes: { attribute: string; value: string }[];
  /** Variant active and live; product active, seller approved, product live. */
  purchasable: boolean;
  /** The variant's image (spec 06 §8.1, §8.3): its lowest tied image, else the primary; null if none. */
  imageMediaId: string | null;
}
