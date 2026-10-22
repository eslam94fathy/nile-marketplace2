import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import {
  CouponDisplayStatus,
  CouponFunding,
  CouponScope,
  CouponStatus,
  DiscountType,
  RedemptionStatus,
} from '../enums';
import { type Coupon, displayStatusOf, type Redemption } from '../model/coupon.model';
import { discountValueOf } from '../model/coupon-rules.model';

/* Response DTOs for spec 19 §4 (decorators describe the OpenAPI shape only). */

export class CouponDto {
  @IsUUID()
  id!: string;

  @IsString()
  code!: string;

  @IsIn(Object.values(CouponFunding))
  funding!: CouponFunding;

  @IsOptional()
  @IsUUID()
  sellerId!: string | null;

  @IsIn(Object.values(DiscountType))
  discountType!: DiscountType;

  /** A rate ("0.1000") for percent, an amount ("25.00") for fixed. */
  @IsString()
  discountValue!: string;

  @IsOptional()
  @IsString()
  maxDiscount!: string | null;

  @IsString()
  minItemsSubtotal!: string;

  @IsIn(Object.values(CouponScope))
  scope!: CouponScope;

  @IsOptional()
  @IsUUID()
  scopeSellerId!: string | null;

  @IsOptional()
  @IsUUID()
  scopeCategoryId!: string | null;

  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;

  @IsOptional()
  @IsInt()
  globalLimit!: number | null;

  @IsInt()
  perCustomerLimit!: number;

  @IsInt()
  redemptionCount!: number;

  @IsIn(Object.values(CouponStatus))
  status!: CouponStatus;

  /** Derived from the status and the dates. */
  @IsIn(Object.values(CouponDisplayStatus))
  displayStatus!: CouponDisplayStatus;

  /** Blocked by an admin (PR-20): the seller can't activate it. */
  @IsBoolean()
  adminBlocked!: boolean;

  @IsOptional()
  @IsString()
  adminBlockReason!: string | null;

  @IsISO8601()
  createdAt!: string;

  @IsISO8601()
  updatedAt!: string;
}

export class CouponRedemptionDto {
  @IsUUID()
  orderId!: string;

  @IsUUID()
  customerId!: string;

  @IsString()
  discountTotal!: string;

  @IsIn(Object.values(RedemptionStatus))
  status!: RedemptionStatus;

  @IsISO8601()
  createdAt!: string;
}

/** `GET /admin/coupons/:couponId`: the coupon and its last 50 redemptions, newest first. */
export class AdminCouponDetailDto extends CouponDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CouponRedemptionDto)
  redemptions!: CouponRedemptionDto[];
}

export function toCouponDto(coupon: Coupon, now: Date): CouponDto {
  return {
    id: coupon.id,
    code: coupon.code,
    funding: coupon.funding,
    sellerId: coupon.sellerId,
    discountType: coupon.discount.type,
    discountValue: discountValueOf(coupon.discount),
    maxDiscount: coupon.maxDiscount?.toString() ?? null,
    minItemsSubtotal: coupon.minItemsSubtotal.toString(),
    scope: coupon.scope,
    scopeSellerId: coupon.scopeSellerId,
    scopeCategoryId: coupon.scopeCategoryId,
    startsAt: coupon.startsAt.toISOString(),
    endsAt: coupon.endsAt.toISOString(),
    globalLimit: coupon.globalLimit,
    perCustomerLimit: coupon.perCustomerLimit,
    redemptionCount: coupon.redemptionCount,
    status: coupon.status,
    displayStatus: displayStatusOf(coupon, now),
    adminBlocked: coupon.adminBlockedAt !== null,
    adminBlockReason: coupon.adminBlockReason,
    createdAt: coupon.createdAt.toISOString(),
    updatedAt: coupon.updatedAt.toISOString(),
  };
}

export function toAdminCouponDetailDto(
  detail: { coupon: Coupon; redemptions: Redemption[] },
  now: Date,
): AdminCouponDetailDto {
  return {
    ...toCouponDto(detail.coupon, now),
    redemptions: detail.redemptions.map((r) => ({
      orderId: r.orderId,
      customerId: r.customerId,
      discountTotal: r.discountTotal.toString(),
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
