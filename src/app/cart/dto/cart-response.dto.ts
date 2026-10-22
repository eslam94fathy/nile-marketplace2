import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { IsMoney } from '../../../lib/http';
import { ImageDto, toImageDto } from '../../media';
import { CartItemIssue } from '../enums';
import { type CartLineView, type CartView } from '../model/cart-view.model';
import { type CouponPreview } from '../service/cart-view.service';

/* Response DTOs for spec 08 §4 (decorators describe the OpenAPI shape only). */

export class CartItemAttributeDto {
  @IsString()
  attribute!: string;

  @IsString()
  value!: string;
}

export class CartItemDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  variantId!: string;

  @IsUUID()
  productId!: string;

  @IsString()
  productName!: string;

  @IsString()
  productSlug!: string;

  @IsString()
  sku!: string;

  @ValidateNested({ each: true })
  @Type(() => CartItemAttributeDto)
  attributes!: CartItemAttributeDto[];

  /** The current price (EGP). */
  @IsMoney()
  unitPrice!: string;

  @IsInt()
  quantity!: number;

  /** unitPrice × quantity, also on lines with an issue. */
  @IsMoney()
  lineTotal!: string;

  // Nullable: present in every item, null when the line is OK.
  @IsOptional()
  @IsIn(Object.values(CartItemIssue))
  issue!: CartItemIssue | null;

  /** 0 when UNAVAILABLE, else min(sellable, 99). */
  @IsInt()
  availableQuantity!: number;

  // Nullable: the variant's image (its own, else the product's primary), null when there is none.
  @IsOptional()
  @ValidateNested()
  @Type(() => ImageDto)
  image!: ImageDto | null;
}

export class CartSellerDto {
  @IsUUID()
  sellerId!: string;

  @IsString()
  businessName!: string;

  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];

  /** Lines without an issue only. */
  @IsMoney()
  subtotal!: string;
}

export class CartDto {
  // Nullable: null until the first add.
  @IsOptional()
  @IsUUID()
  id!: string | null;

  @ValidateNested({ each: true })
  @Type(() => CartSellerDto)
  sellers!: CartSellerDto[];

  /** Σ subtotals; the delivery fee isn't known until an address is chosen. */
  @IsMoney()
  itemsTotal!: string;

  /** Σ quantities of lines without an issue. */
  @IsInt()
  itemCount!: number;

  @IsBoolean()
  hasIssues!: boolean;
}

function toCartItemDto(line: CartLineView): CartItemDto {
  return {
    id: line.id,
    variantId: line.variantId,
    productId: line.productId,
    productName: line.productName,
    productSlug: line.productSlug,
    sku: line.sku,
    attributes: line.attributes.map(({ attribute, value }) => ({ attribute, value })),
    unitPrice: line.unitPrice.toString(),
    quantity: line.quantity,
    lineTotal: line.lineTotal.toString(),
    issue: line.issue,
    availableQuantity: line.availableQuantity,
    image: line.image ? toImageDto(line.image) : null,
  };
}

export function toCartDto(view: CartView): CartDto {
  return {
    id: view.id,
    sellers: view.sellers.map((group) => ({
      sellerId: group.sellerId,
      businessName: group.businessName,
      items: group.items.map(toCartItemDto),
      subtotal: group.subtotal.toString(),
    })),
    itemsTotal: view.itemsTotal.toString(),
    itemCount: view.itemCount,
    hasIssues: view.hasIssues,
  };
}

export class CouponSellerShareDto {
  @IsUUID()
  sellerId!: string;

  @IsMoney()
  discount!: string;
}

export class CouponLineShareDto {
  @IsUUID()
  variantId!: string;

  @IsMoney()
  discount!: string;
}

/** `CouponQuoteDto` (spec 19 §4): what the code would take off the cart's items, per seller and line. */
export class CouponQuoteDto {
  @IsString()
  code!: string;

  @IsMoney()
  discountTotal!: string;

  @ValidateNested({ each: true })
  @Type(() => CouponSellerShareDto)
  sellerOrders!: CouponSellerShareDto[];

  @ValidateNested({ each: true })
  @Type(() => CouponLineShareDto)
  lines!: CouponLineShareDto[];

  /** The cart's items total less the discount; the delivery fee is added at checkout. */
  @IsMoney()
  itemsTotalAfterDiscount!: string;
}

export function toCouponQuoteDto(preview: CouponPreview): CouponQuoteDto {
  return {
    code: preview.code,
    discountTotal: preview.discountTotal.toString(),
    sellerOrders: preview.sellerOrders.map((s) => ({
      sellerId: s.sellerId,
      discount: s.discount.toString(),
    })),
    lines: preview.lines.map((l) => ({ variantId: l.variantId, discount: l.discount.toString() })),
    itemsTotalAfterDiscount: preview.itemsTotalAfterDiscount.toString(),
  };
}
