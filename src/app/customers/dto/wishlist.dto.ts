import { Type } from 'class-transformer';
import { IsArray, IsISO8601, IsUUID, ValidateNested } from 'class-validator';
import { FieldType, type ListSpec, UuidField } from '../../../lib/http';
import { ProductCardDto, toProductCardDto } from '../../catalog';
import { type WishlistItemView } from '../service/wishlist.service';

/* Spec 04 §8.4. Response decorators describe the OpenAPI shape only. */

export class WishlistProductParamsDto {
  @UuidField()
  productId!: string;
}

/** Newest first only (spec 04 §8.4): `sort=-addedAt`, keyset on (created_at, id). */
export const WISHLIST_LIST_SPEC: ListSpec = {
  fields: { addedAt: { column: 'created_at', type: FieldType.DATE, ops: [], sortable: true } },
  defaultSort: '-addedAt',
};

export class WishlistItemDto {
  @IsUUID()
  productId!: string;

  @IsISO8601()
  addedAt!: string;

  /** `available: false` once the product is no longer visible; it stays until removed (WL-2). */
  @ValidateNested()
  @Type(() => ProductCardDto)
  product!: ProductCardDto;
}

export class WishlistProductIdsDto {
  /** Every wishlisted product id (at most WISHLIST_MAX_ITEMS), for the hearts on product lists (WL-1). */
  @IsArray()
  @IsUUID('all', { each: true })
  productIds!: string[];
}

export function toWishlistItemDto(view: WishlistItemView): WishlistItemDto {
  const { item, product } = view;
  return {
    productId: item.productId,
    addedAt: item.addedAt.toISOString(),
    product: product
      ? toProductCardDto(product)
      : {
          id: item.productId,
          slug: '',
          name: '',
          minPrice: null,
          maxPrice: null,
          inStock: false,
          available: false,
          primaryImage: null,
          rating: { avg: null, count: 0 },
        },
  };
}
