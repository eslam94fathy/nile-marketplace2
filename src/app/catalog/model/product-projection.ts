import { type Money } from '../../../lib/money';
import { ProductStatus } from '../enums';
import { type ProductVariant } from './product-variant.model';

export interface ProductProjection {
  minPrice: Money | null;
  maxPrice: Money | null;
  inStock: boolean;
  /** The product status after the change: an active product with no active variant becomes inactive. */
  status: ProductStatus;
}

/**
 * Listing projections of a product (spec 06 UC-CA-3/4): price range and in-stock over its live
 * active variants. `sellableByVariant` holds inventory's sellable stock of those variants.
 */
export function computeProjection(
  status: ProductStatus,
  liveVariants: readonly ProductVariant[],
  sellableByVariant: ReadonlyMap<string, number>,
): ProductProjection {
  const active = liveVariants.filter((variant) => variant.isActive);
  let minPrice: Money | null = null;
  let maxPrice: Money | null = null;
  for (const { price } of active) {
    if (minPrice === null || price.lessThan(minPrice)) minPrice = price;
    if (maxPrice === null || price.greaterThan(maxPrice)) maxPrice = price;
  }
  return {
    minPrice,
    maxPrice,
    inStock: active.some((variant) => (sellableByVariant.get(variant.id) ?? 0) > 0),
    status: status === ProductStatus.ACTIVE && active.length === 0 ? ProductStatus.INACTIVE : status,
  };
}
