import { AppError, type ErrorDetail, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';
import { type Money } from '../../lib/money';
import { CatalogErrorCode } from '../catalog';
import { SellersErrorCode } from '../sellers';

/** promotions error codes (docs/spec/19-promotions.md §6). */
export const PromotionsErrorCode = {
  COUPON_NOT_FOUND: 'COUPON_NOT_FOUND',
  COUPON_INACTIVE: 'COUPON_INACTIVE',
  COUPON_NOT_ACTIVE_YET: 'COUPON_NOT_ACTIVE_YET',
  COUPON_EXPIRED: 'COUPON_EXPIRED',
  COUPON_LIMIT_REACHED: 'COUPON_LIMIT_REACHED',
  COUPON_CUSTOMER_LIMIT_REACHED: 'COUPON_CUSTOMER_LIMIT_REACHED',
  COUPON_NOT_APPLICABLE: 'COUPON_NOT_APPLICABLE',
  COUPON_MIN_SUBTOTAL_NOT_MET: 'COUPON_MIN_SUBTOTAL_NOT_MET',
  COUPON_INVALID: 'COUPON_INVALID',
  COUPON_CODE_TAKEN: 'COUPON_CODE_TAKEN',
  COUPON_LOCKED: 'COUPON_LOCKED',
  COUPON_BLOCKED: 'COUPON_BLOCKED',
  COUPON_BLOCK_INVALID_STATUS: 'COUPON_BLOCK_INVALID_STATUS',
  COUPON_SELLER_FUNDED: 'COUPON_SELLER_FUNDED',
} as const;
export type PromotionsErrorCode = (typeof PromotionsErrorCode)[keyof typeof PromotionsErrorCode];

const C = PromotionsErrorCode;
const S = HTTP_STATUS;
const unprocessable = (code: PromotionsErrorCode, message: string, details?: ErrorDetail[]) =>
  new AppError(code, message, S.UNPROCESSABLE_ENTITY, { details });

/* §3.1: a code the customer typed (preview, checkout). All 422; the code tells the client the message. */

export const couponCodeUnknown = () => unprocessable(C.COUPON_NOT_FOUND, 'This coupon code does not exist');

/** Deactivated, blocked, or its seller isn't approved: the customer learns nothing about the seller. */
export const couponInactive = () => unprocessable(C.COUPON_INACTIVE, 'This coupon is not active');

export const couponNotActiveYet = () =>
  unprocessable(C.COUPON_NOT_ACTIVE_YET, 'This coupon is not active yet');

export const couponExpired = () => unprocessable(C.COUPON_EXPIRED, 'This coupon has expired');

export const couponLimitReached = () => unprocessable(C.COUPON_LIMIT_REACHED, 'This coupon has been used up');

export const couponCustomerLimitReached = () =>
  unprocessable(C.COUPON_CUSTOMER_LIMIT_REACHED, 'You have already used this coupon');

export const couponNotApplicable = () =>
  unprocessable(C.COUPON_NOT_APPLICABLE, 'This coupon does not apply to any item in your cart');

/** Details carry the missing amount (spec 19 §1.2 step 2). */
export const couponMinSubtotalNotMet = (missing: Money) =>
  unprocessable(C.COUPON_MIN_SUBTOTAL_NOT_MET, 'Add more eligible items to use this coupon', [
    {
      field: 'code',
      value: missing.toString(),
      constraint: 'min_items_subtotal',
      message: `missing ${missing.toString()}`,
    },
  ]);

/* §4: coupon management. */

/** A missing coupon id, or another seller's coupon (conventions §3). */
export const couponNotFound = () => new AppError(C.COUPON_NOT_FOUND, 'Coupon not found', S.NOT_FOUND);

export const couponInvalid = (details: ErrorDetail[]) =>
  unprocessable(C.COUPON_INVALID, 'The coupon fields are not consistent', details);

export const couponCodeTaken = () =>
  new AppError(C.COUPON_CODE_TAKEN, 'This coupon code is already taken', S.CONFLICT);

export const couponLocked = (fields: readonly string[]) =>
  new AppError(
    C.COUPON_LOCKED,
    'This coupon has been used: only endsAt, globalLimit and status can change',
    S.CONFLICT,
    {
      details: fields.map((field) => ({
        field,
        constraint: 'locked',
        message: 'locked after the first redemption',
      })),
    },
  );

export const couponBlocked = () =>
  new AppError(C.COUPON_BLOCKED, 'This coupon was blocked by the platform', S.CONFLICT);

export const couponBlockInvalidStatus = () =>
  new AppError(
    C.COUPON_BLOCK_INVALID_STATUS,
    'Only an unblocked seller coupon can be blocked, and only a blocked one unblocked',
    S.CONFLICT,
  );

export const couponSellerFunded = () =>
  new AppError(
    C.COUPON_SELLER_FUNDED,
    'A seller coupon is changed by its seller; block or unblock it instead',
    S.CONFLICT,
  );

/** A body reference to a category that doesn't exist: 422 (spec 19 §4.2, catalog's code). */
export const scopeCategoryNotFound = () =>
  new AppError(CatalogErrorCode.CATEGORY_NOT_FOUND, 'Category not found', S.UNPROCESSABLE_ENTITY, {
    details: [{ field: 'scopeCategoryId', constraint: 'exists', message: 'no such category' }],
  });

/** A body reference to a seller that doesn't exist: 422 (spec 19 §4.3, sellers' code). */
export const scopeSellerNotFound = () =>
  new AppError(SellersErrorCode.SELLER_NOT_FOUND, 'Seller not found', S.UNPROCESSABLE_ENTITY, {
    details: [{ field: 'scopeSellerId', constraint: 'exists', message: 'no such seller' }],
  });

/** The code is unique by constraint; the create has no pre-check (CLAUDE.md §6.4). */
export function registerPromotionsConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('uq_coupons_code', couponCodeTaken);
}
