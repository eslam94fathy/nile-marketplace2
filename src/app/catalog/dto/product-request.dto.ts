import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  NotEquals,
} from 'class-validator';
import {
  FieldType,
  FilterOp,
  IntField,
  IsMoney,
  IsPositiveMoney,
  type ListSpec,
  Nullable,
  Optional,
  PatchDto,
  StrField,
  UuidField,
} from '../../../lib/http';
import {
  INITIAL_STOCK_MAX,
  MAX_EFFECTIVE_ATTRIBUTES,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_NAME_MIN_LENGTH,
  SKU_MAX_LENGTH,
  SKU_PATTERN,
  STOCK_DELTA_MAX,
} from '../constants';
import { ProductStatus, VariantStatus } from '../enums';

/** Request DTOs for spec 06 §4.3 (seller). */

export class ProductIdParamsDto {
  @UuidField()
  productId!: string;
}

export class ProductVariantParamsDto {
  @UuidField()
  productId!: string;

  @UuidField()
  variantId!: string;
}

export class VariantIdParamsDto {
  @UuidField()
  variantId!: string;
}

export class CreateProductDto {
  @UuidField()
  categoryId!: string;

  @StrField(PRODUCT_NAME_MIN_LENGTH, PRODUCT_NAME_MAX_LENGTH)
  name!: string;

  @StrField(1, PRODUCT_DESCRIPTION_MAX_LENGTH)
  description!: string;
}

export class UpdateProductDto extends PatchDto {
  @Optional()
  @StrField(PRODUCT_NAME_MIN_LENGTH, PRODUCT_NAME_MAX_LENGTH)
  name?: string;

  @Optional()
  @StrField(1, PRODUCT_DESCRIPTION_MAX_LENGTH)
  description?: string;

  /** Only while the product has no variant (PRODUCT_CATEGORY_LOCKED). */
  @Optional()
  @UuidField()
  categoryId?: string;
}

const SkuField = () => (target: object, key: string | symbol) => {
  StrField(1, SKU_MAX_LENGTH)(target, key);
  Matches(SKU_PATTERN, { message: '$property may contain letters, digits, ".", "_" and "-" only' })(
    target,
    key,
  );
};

export class CreateVariantDto {
  @SkuField()
  sku!: string;

  @IsString()
  @IsPositiveMoney()
  price!: string;

  /** Must be greater than `price` (COMPARE_AT_PRICE_INVALID). */
  @Optional()
  @Nullable()
  @IsString()
  @IsMoney()
  compareAtPrice?: string | null;

  /** Exactly one option per attribute of the category; `[]` for a category without attributes. */
  @IsArray()
  @ArrayMaxSize(MAX_EFFECTIVE_ATTRIBUTES)
  @ArrayUnique()
  @IsUUID('7', { each: true })
  optionIds!: string[];

  @IntField(0, INITIAL_STOCK_MAX)
  initialStock!: number;

  @IsIn(Object.values(VariantStatus))
  status!: VariantStatus;
}

/** Options can't change: delete the variant and create another (spec 06 UC-CA-4). */
export class UpdateVariantDto extends PatchDto {
  @Optional()
  @SkuField()
  sku?: string;

  @Optional()
  @IsString()
  @IsPositiveMoney()
  price?: string;

  @Optional()
  @Nullable()
  @IsString()
  @IsMoney()
  compareAtPrice?: string | null;

  @Optional()
  @IsIn(Object.values(VariantStatus))
  status?: VariantStatus;
}

/** A delta, never an absolute value (S-6). */
export class StockAdjustmentDto {
  @IntField(-STOCK_DELTA_MAX, STOCK_DELTA_MAX)
  @NotEquals(0, { message: '$property must not be 0' })
  delta!: number;
}

/** `GET /seller/products` whitelist (spec 06 §4.3). */
export const SELLER_PRODUCT_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(ProductStatus),
    },
    categoryId: { column: 'category_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    name: { column: 'name', type: FieldType.TEXT, ops: [FilterOp.LIKE] },
    createdAt: {
      column: 'created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
  },
  defaultSort: '-createdAt',
};
