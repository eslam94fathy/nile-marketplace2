import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsMoney } from '../../../lib/http';
import { MovementType, type InventoryMovement, type StockDto } from '../../inventory';
import { ProductStatus, VariantStatus } from '../enums';
import { type VariantView } from '../service/variant-view.service';
import { type ProductDetail } from '../service/seller-product.service';
import { type Product } from '../model/product.model';

/* Response DTOs for spec 06 §4.3 (decorators describe the OpenAPI shape only). */

export class StockLevelDto {
  @IsInt()
  onHand!: number;

  @IsInt()
  reserved!: number;

  /** onHand - reserved */
  @IsInt()
  sellable!: number;
}

export class VariantStockDto extends StockLevelDto {
  @IsUUID()
  variantId!: string;
}

export class SellerVariantOptionDto {
  @IsUUID()
  attributeId!: string;

  @IsString()
  attributeCode!: string;

  @IsUUID()
  optionId!: string;

  @IsString()
  optionCode!: string;

  @IsString()
  value!: string;
}

export class SellerVariantDto {
  @IsUUID()
  id!: string;

  @IsString()
  sku!: string;

  @IsMoney()
  price!: string;

  // Nullable: present in every item.
  @IsOptional()
  @IsMoney()
  compareAtPrice!: string | null;

  @IsIn(Object.values(VariantStatus))
  status!: VariantStatus;

  @IsBoolean()
  isDefault!: boolean;

  @ValidateNested({ each: true })
  @Type(() => SellerVariantOptionDto)
  options!: SellerVariantOptionDto[];

  @ValidateNested()
  @Type(() => StockLevelDto)
  stock!: StockLevelDto;

  @IsISO8601()
  createdAt!: string;

  @IsISO8601()
  updatedAt!: string;
}

export class SellerProductDto {
  @IsUUID()
  id!: string;

  @IsString()
  slug!: string;

  @IsString()
  name!: string;

  @IsString()
  description!: string;

  @IsUUID()
  categoryId!: string;

  @IsIn(Object.values(ProductStatus))
  status!: ProductStatus;

  /** What the public sees: active, seller approved, not deleted. */
  @IsBoolean()
  visible!: boolean;

  // Nullable: null while the product has no active variant.
  @IsOptional()
  @IsMoney()
  minPrice!: string | null;

  @IsOptional()
  @IsMoney()
  maxPrice!: string | null;

  @IsBoolean()
  inStock!: boolean;

  @IsOptional()
  @IsISO8601()
  publishedAt!: string | null;

  @IsISO8601()
  createdAt!: string;

  @IsISO8601()
  updatedAt!: string;
}

export class SellerProductDetailDto extends SellerProductDto {
  /** Live variants, oldest first. */
  @ValidateNested({ each: true })
  @Type(() => SellerVariantDto)
  variants!: SellerVariantDto[];
}

export class StockMovementDto {
  @IsUUID()
  id!: string;

  @IsIn(Object.values(MovementType))
  type!: MovementType;

  @IsInt()
  quantityDelta!: number;

  @IsInt()
  onHandAfter!: number;

  @IsInt()
  reservedAfter!: number;

  @IsOptional()
  @IsString()
  referenceType!: string | null;

  @IsOptional()
  @IsUUID()
  referenceId!: string | null;

  @IsISO8601()
  createdAt!: string;
}

export function toSellerProductDto(product: Product): SellerProductDto {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    categoryId: product.categoryId,
    status: product.status,
    visible: product.visible,
    minPrice: product.minPrice?.toString() ?? null,
    maxPrice: product.maxPrice?.toString() ?? null,
    inStock: product.inStock,
    publishedAt: product.publishedAt?.toISOString() ?? null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function toStockLevelDto(stock: StockDto): StockLevelDto {
  return { onHand: stock.onHand, reserved: stock.reserved, sellable: stock.sellable };
}

export function toVariantStockDto(stock: StockDto): VariantStockDto {
  return { variantId: stock.variantId, ...toStockLevelDto(stock) };
}

export function toSellerVariantDto({ variant, options, stock }: VariantView): SellerVariantDto {
  return {
    id: variant.id,
    sku: variant.sku,
    price: variant.price.toString(),
    compareAtPrice: variant.compareAtPrice?.toString() ?? null,
    status: variant.status,
    isDefault: variant.isDefault,
    options: options.map((o) => ({ ...o })),
    stock: toStockLevelDto(stock),
    createdAt: variant.createdAt.toISOString(),
    updatedAt: variant.updatedAt.toISOString(),
  };
}

export function toSellerProductDetailDto(detail: ProductDetail): SellerProductDetailDto {
  return { ...toSellerProductDto(detail.product), variants: detail.variants.map(toSellerVariantDto) };
}

export function toStockMovementDto(movement: InventoryMovement): StockMovementDto {
  return { ...movement, createdAt: movement.createdAt.toISOString() };
}
