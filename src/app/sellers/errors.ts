import { AppError, governorateReferenceNotFound, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** sellers error codes (docs/spec/05-sellers.md §6). GOVERNORATE_NOT_FOUND is common (spec 01 §6). */
export const SellersErrorCode = {
  SELLER_NOT_FOUND: 'SELLER_NOT_FOUND',
  SELLER_INVALID_STATUS_TRANSITION: 'SELLER_INVALID_STATUS_TRANSITION',
  SELLER_EMAIL_NOT_VERIFIED: 'SELLER_EMAIL_NOT_VERIFIED',
  SELLER_NOT_APPROVED: 'SELLER_NOT_APPROVED',
  BUSINESS_NAME_TAKEN: 'BUSINESS_NAME_TAKEN',
  COMMISSION_RATE_UNCHANGED: 'COMMISSION_RATE_UNCHANGED',
} as const;

const C = SellersErrorCode;
const S = HTTP_STATUS;

export const sellerNotFound = () => new AppError(C.SELLER_NOT_FOUND, 'Seller not found', S.NOT_FOUND);
export const sellerInvalidStatusTransition = () =>
  new AppError(
    C.SELLER_INVALID_STATUS_TRANSITION,
    'This status change is not allowed from the current status',
    S.CONFLICT,
  );
export const sellerEmailNotVerified = () =>
  new AppError(C.SELLER_EMAIL_NOT_VERIFIED, "The seller hasn't verified their email yet", S.CONFLICT);
/** Thrown by other modules' guards (catalog writes) when the seller isn't approved. */
export const sellerNotApproved = () =>
  new AppError(C.SELLER_NOT_APPROVED, 'Your seller account is not approved', S.FORBIDDEN);
export const businessNameTaken = (cause?: unknown) =>
  new AppError(C.BUSINESS_NAME_TAKEN, 'This business name is already taken', S.CONFLICT, { cause });
export const commissionRateUnchanged = () =>
  new AppError(C.COMMISSION_RATE_UNCHANGED, 'The new rate equals the current one', S.CONFLICT);

/** Constraints that race with app-level checks (CLAUDE.md §6.4). */
export function registerSellersConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('uq_sellers_business_name_lower', businessNameTaken);
  mapper.register('fk_sellers_pickup_governorate_id', governorateReferenceNotFound);
}
