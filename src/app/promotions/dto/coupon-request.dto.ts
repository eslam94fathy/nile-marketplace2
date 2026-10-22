import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsString, Length, Matches } from 'class-validator';
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
import { COUPON_LIMITS as L } from '../constants';
import { CouponFunding, CouponScope, CouponStatus, DiscountType } from '../enums';

/* Spec 19 §4 request DTOs and list whitelists. The cross-field rules live in the service (COUPON_INVALID). */

/** A date-time with an explicit offset, so a coupon window is never read in local time. */
const DATE_TIME_WITH_OFFSET = /T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
/** A rate (percent) or an amount (fixed); which one is checked against `discountType` (§4). */
const DISCOUNT_VALUE = /^\d{1,10}(\.\d{1,4})?$/;
const SELLER_SCOPES = [CouponScope.SELLER, CouponScope.CATEGORY] as const;

/** Upper-cased before the pattern check, never trimmed (PR-12). */
export const CouponCode = () => (target: object, property: string | symbol) => {
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toUpperCase() : value))(
    target,
    property,
  );
  IsString()(target, property);
  Length(L.CODE_MIN, L.CODE_MAX)(target, property);
  Matches(L.CODE_PATTERN, { message: 'code may hold only letters, digits and dashes' })(target, property);
};

const DateTime = () => (target: object, property: string | symbol) => {
  IsISO8601({ strict: true, strictSeparator: true })(target, property);
  Matches(DATE_TIME_WITH_OFFSET, {
    message: `${String(property)} must be a date-time with a time zone offset`,
  })(target, property);
};

export class CouponIdParamsDto {
  @UuidField()
  couponId!: string;
}

/** The fields shared by every create. */
abstract class CouponBodyDto {
  @CouponCode()
  code!: string;

  @IsIn(Object.values(DiscountType))
  discountType!: DiscountType;

  @IsString()
  @Matches(DISCOUNT_VALUE, { message: 'discountValue must be a decimal string' })
  discountValue!: string;

  /** Percent coupons only. */
  @Optional()
  @Nullable()
  @IsPositiveMoney()
  maxDiscount?: string | null;

  @IsMoney()
  minItemsSubtotal!: string;

  @Optional()
  @UuidField()
  scopeCategoryId?: string;

  @DateTime()
  startsAt!: string;

  @DateTime()
  endsAt!: string;

  /** `null` or absent = unlimited. */
  @Optional()
  @Nullable()
  @IntField(L.GLOBAL_LIMIT_MIN, L.GLOBAL_LIMIT_MAX)
  globalLimit?: number | null;

  @IntField(L.PER_CUSTOMER_LIMIT_MIN, L.PER_CUSTOMER_LIMIT_MAX)
  perCustomerLimit!: number;
}

/** `POST /seller/coupons`: the coupon covers the seller's own products (`scopeSellerId` not accepted). */
export class SellerCreateCouponDto extends CouponBodyDto {
  @IsIn(SELLER_SCOPES)
  scope!: CouponScope;
}

/** `POST /admin/coupons`: a platform-funded coupon. */
export class AdminCreateCouponDto extends CouponBodyDto {
  @IsIn(Object.values(CouponScope))
  scope!: CouponScope;

  /** With `scope = seller`. */
  @Optional()
  @UuidField()
  scopeSellerId?: string;
}

/** The fields shared by every patch: the create fields except `code`, plus `status`; at least one. */
abstract class CouponPatchDto extends PatchDto {
  @Optional()
  @IsIn(Object.values(DiscountType))
  discountType?: DiscountType;

  @Optional()
  @IsString()
  @Matches(DISCOUNT_VALUE, { message: 'discountValue must be a decimal string' })
  discountValue?: string;

  @Optional()
  @Nullable()
  @IsPositiveMoney()
  maxDiscount?: string | null;

  @Optional()
  @IsMoney()
  minItemsSubtotal?: string;

  @Optional()
  @Nullable()
  @UuidField()
  scopeCategoryId?: string | null;

  @Optional()
  @DateTime()
  startsAt?: string;

  @Optional()
  @DateTime()
  endsAt?: string;

  @Optional()
  @Nullable()
  @IntField(L.GLOBAL_LIMIT_MIN, L.GLOBAL_LIMIT_MAX)
  globalLimit?: number | null;

  @Optional()
  @IntField(L.PER_CUSTOMER_LIMIT_MIN, L.PER_CUSTOMER_LIMIT_MAX)
  perCustomerLimit?: number;

  @Optional()
  @IsIn(Object.values(CouponStatus))
  status?: CouponStatus;
}

export class SellerUpdateCouponDto extends CouponPatchDto {
  @Optional()
  @IsIn(SELLER_SCOPES)
  scope?: CouponScope;
}

export class AdminUpdateCouponDto extends CouponPatchDto {
  @Optional()
  @IsIn(Object.values(CouponScope))
  scope?: CouponScope;

  @Optional()
  @Nullable()
  @UuidField()
  scopeSellerId?: string | null;
}

/** `POST /admin/coupons/:couponId/block` (PR-20). */
export class BlockCouponDto {
  @StrField(L.BLOCK_REASON_MIN, L.BLOCK_REASON_MAX)
  reason!: string;
}

const CREATED_AT = { column: 'created_at', type: FieldType.DATE, ops: [], sortable: true } as const;
const STATUS = {
  column: 'status',
  type: FieldType.ENUM,
  ops: [FilterOp.EQ],
  enumValues: Object.values(CouponStatus),
} as const;

/** `GET /seller/coupons` (spec 19 §4.2), newest first. */
export const SELLER_COUPON_LIST_SPEC: ListSpec = {
  fields: { status: STATUS, createdAt: CREATED_AT },
  defaultSort: '-createdAt',
};

/** `GET /admin/coupons` (spec 19 §4.3); `code` is matched as stored (upper-case). */
export const ADMIN_COUPON_LIST_SPEC: ListSpec = {
  fields: {
    funding: {
      column: 'funding',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(CouponFunding),
    },
    status: STATUS,
    sellerId: { column: 'seller_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    code: { column: 'code', type: FieldType.TEXT, ops: [FilterOp.EQ] },
    createdAt: CREATED_AT,
  },
  defaultSort: '-createdAt',
};
