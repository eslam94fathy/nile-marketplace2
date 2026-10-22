import { IsString, Length } from 'class-validator';
import { IntField, UuidField } from '../../../lib/http';
import { CART_MAX_LINE_QUANTITY } from '../constants';

/** Request DTOs for spec 08 §4. Notation: docs/spec/01-api-conventions.md §1.1. */

export class AddCartItemDto {
  @UuidField()
  variantId!: string;

  @IntField(1, CART_MAX_LINE_QUANTITY)
  quantity!: number;
}

export class UpdateCartItemDto {
  @IntField(1, CART_MAX_LINE_QUANTITY)
  quantity!: number;
}

export class CartItemIdParamsDto {
  @UuidField()
  itemId!: string;
}

/** `POST /cart/coupon-preview` (spec 08 §8). The quote upper-cases the code (spec 19 PR-12). */
export class CouponPreviewRequestDto {
  @IsString()
  @Length(4, 32)
  code!: string;
}
