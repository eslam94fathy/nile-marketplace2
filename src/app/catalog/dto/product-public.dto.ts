import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { validationFailed } from '../../../lib/error';
import { FieldType, FilterOp, IsMoney, type ListSpec, SLUG_PATTERN } from '../../../lib/http';
import { MAX_ATTRIBUTE_FILTERS, MAX_ATTRIBUTE_FILTER_VALUES, PRODUCT_SLUG_MAX_LENGTH } from '../constants';
import { RELEVANCE_FIELD } from '../repository/product.repository';
import {
  type ProductListItem,
  PRODUCT_LIST_PARAMS,
  type PublicProductDetail,
} from '../service/product-browse.service';

/* Public product DTOs (spec 06 §4.1). Response decorators describe the OpenAPI shape only. */

const BROWSE_FIELDS: ListSpec['fields'] = {
  [PRODUCT_LIST_PARAMS.CATEGORY_ID]: { type: FieldType.UUID, ops: [FilterOp.EQ] },
  price: { column: 'p.min_price', type: FieldType.MONEY, ops: [FilterOp.GTE, FilterOp.LTE] },
  minPrice: { column: 'p.min_price', type: FieldType.MONEY, ops: [], sortable: true },
  publishedAt: { column: 'p.published_at', type: FieldType.DATE, ops: [], sortable: true },
  inStock: { column: 'p.in_stock', type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
  sellerId: { column: 'p.seller_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
};
const ATTRIBUTE_FILTERS: ListSpec['prefixFields'] = {
  [PRODUCT_LIST_PARAMS.ATTR_PREFIX]: {
    type: FieldType.TEXT,
    ops: [FilterOp.IN],
    maxValues: MAX_ATTRIBUTE_FILTER_VALUES,
    maxKeys: MAX_ATTRIBUTE_FILTERS,
  },
};

/** Without `q`: newest first; `sort=relevance` is unknown, so a 400 (spec 06 §4.1). */
export const PRODUCT_BROWSE_LIST_SPEC: ListSpec = {
  fields: BROWSE_FIELDS,
  prefixFields: ATTRIBUTE_FILTERS,
  defaultSort: '-publishedAt',
  extraParams: [PRODUCT_LIST_PARAMS.Q],
};

/** With `q`: the computed relevance is sortable, and the default. */
export const PRODUCT_SEARCH_LIST_SPEC: ListSpec = {
  fields: { ...BROWSE_FIELDS, [RELEVANCE_FIELD]: { type: FieldType.NUMBER, ops: [], sortable: true } },
  prefixFields: ATTRIBUTE_FILTERS,
  defaultSort: `-${RELEVANCE_FIELD}`,
  extraParams: [PRODUCT_LIST_PARAMS.Q],
};

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `idOrSlug`: a UUID v7, else a `slug(1..220)`; anything else is a 400. */
export function parseIdOrSlug(raw: unknown): { id: string } | { slug: string } {
  if (typeof raw === 'string' && UUID_V7_PATTERN.test(raw)) return { id: raw.toLowerCase() };
  if (typeof raw === 'string' && raw.length <= PRODUCT_SLUG_MAX_LENGTH && SLUG_PATTERN.test(raw)) {
    return { slug: raw };
  }
  throw validationFailed([
    { field: 'idOrSlug', constraint: 'format', message: 'idOrSlug must be a UUID or a slug' },
  ]);
}

export class ProductCategoryRefDto {
  @IsUUID()
  id!: string;

  @IsString()
  name!: string;

  @IsString()
  slug!: string;
}

export class ProductSellerRefDto {
  @IsUUID()
  id!: string;

  @IsString()
  businessName!: string;
}

export class ProductListItemDto {
  @IsUUID()
  id!: string;

  @IsString()
  slug!: string;

  @IsString()
  name!: string;

  @IsMoney()
  minPrice!: string;

  @IsMoney()
  maxPrice!: string;

  @IsBoolean()
  inStock!: boolean;

  @ValidateNested()
  @Type(() => ProductCategoryRefDto)
  category!: ProductCategoryRefDto;

  @ValidateNested()
  @Type(() => ProductSellerRefDto)
  seller!: ProductSellerRefDto;

  @IsISO8601()
  publishedAt!: string;
}

export class ProductCategoryDto extends ProductCategoryRefDto {
  /** Root first, the category itself last. */
  @ValidateNested({ each: true })
  @Type(() => ProductCategoryRefDto)
  path!: ProductCategoryRefDto[];
}

export class ProductOptionValueDto {
  @IsString()
  code!: string;

  @IsString()
  value!: string;
}

export class ProductAttributeDto {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  /** Only options that active variants use. */
  @ValidateNested({ each: true })
  @Type(() => ProductOptionValueDto)
  options!: ProductOptionValueDto[];
}

export class ProductVariantOptionDto {
  @IsString()
  attributeCode!: string;

  @IsString()
  optionCode!: string;

  @IsString()
  value!: string;
}

export class ProductVariantDto {
  @IsUUID()
  id!: string;

  @IsString()
  sku!: string;

  @IsMoney()
  price!: string;

  @IsOptional()
  @IsMoney()
  compareAtPrice!: string | null;

  @ValidateNested({ each: true })
  @Type(() => ProductVariantOptionDto)
  options!: ProductVariantOptionDto[];

  @IsBoolean()
  inStock!: boolean;

  /** min(sellable, 99). Read live, never cached. */
  @IsInt()
  availableQuantity!: number;
}

export class ProductDetailDto {
  @IsUUID()
  id!: string;

  @IsString()
  slug!: string;

  @IsString()
  name!: string;

  @IsString()
  description!: string;

  @ValidateNested()
  @Type(() => ProductCategoryDto)
  category!: ProductCategoryDto;

  @ValidateNested()
  @Type(() => ProductSellerRefDto)
  seller!: ProductSellerRefDto;

  @IsMoney()
  minPrice!: string;

  @IsMoney()
  maxPrice!: string;

  @IsBoolean()
  inStock!: boolean;

  @ValidateNested({ each: true })
  @Type(() => ProductAttributeDto)
  attributes!: ProductAttributeDto[];

  /** Active variants only. */
  @ValidateNested({ each: true })
  @Type(() => ProductVariantDto)
  variants!: ProductVariantDto[];

  @IsISO8601()
  publishedAt!: string;
}

/** Visible products always have an active variant, so prices and publishedAt are set (VIS). */
const visibleMoney = (value: { toString(): string } | null): string => value?.toString() ?? '0.00';
const visibleDate = (value: Date | null, fallback: Date): string => (value ?? fallback).toISOString();

export function toProductListItemDto({ product, category, seller }: ProductListItem): ProductListItemDto {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    minPrice: visibleMoney(product.minPrice),
    maxPrice: visibleMoney(product.maxPrice),
    inStock: product.inStock,
    category,
    seller,
    publishedAt: visibleDate(product.publishedAt, product.createdAt),
  };
}

export function toProductDetailDto(detail: PublicProductDetail): ProductDetailDto {
  const { product } = detail;
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    category: detail.category,
    seller: detail.seller,
    minPrice: visibleMoney(product.minPrice),
    maxPrice: visibleMoney(product.maxPrice),
    inStock: detail.inStock,
    attributes: detail.attributes,
    variants: detail.variants.map((variant) => ({
      ...variant,
      ...(detail.stock.get(variant.id) ?? { inStock: false, availableQuantity: 0 }),
    })),
    publishedAt: visibleDate(product.publishedAt, product.createdAt),
  };
}
