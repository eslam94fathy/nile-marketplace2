import { AppError, internalError, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';
import { OrderingErrorCode } from '../ordering';

/**
 * returns error codes (docs/spec/18-returns.md §6). RETURN_QUANTITY_INVALID is ordering's (OR-28);
 * ORDER_NOT_FOUND / SELLER_ORDER_NOT_FOUND are ordering's too.
 */
export const ReturnsErrorCode = {
  RETURN_NOT_FOUND: 'RETURN_NOT_FOUND',
  RETURN_NOT_ALLOWED: 'RETURN_NOT_ALLOWED',
  RETURN_WINDOW_CLOSED: 'RETURN_WINDOW_CLOSED',
  RETURN_PHOTOS_REQUIRED: 'RETURN_PHOTOS_REQUIRED',
  RETURN_AMOUNT_TOO_LOW: 'RETURN_AMOUNT_TOO_LOW',
  RETURN_PICKUP_UNAVAILABLE: 'RETURN_PICKUP_UNAVAILABLE',
  RETURN_ALREADY_OPEN: 'RETURN_ALREADY_OPEN',
  RETURN_INVALID_STATUS_TRANSITION: 'RETURN_INVALID_STATUS_TRANSITION',
  RETURN_ESCALATION_WINDOW_CLOSED: 'RETURN_ESCALATION_WINDOW_CLOSED',
  RETURN_ITEMS_MISMATCH: 'RETURN_ITEMS_MISMATCH',
} as const;

const C = ReturnsErrorCode;
const S = HTTP_STATUS;

/** Missing, or not the caller's (customer / seller): never told apart. */
export const returnNotFound = () => new AppError(C.RETURN_NOT_FOUND, 'Return not found', S.NOT_FOUND);

export const orderNotFound = () =>
  new AppError(OrderingErrorCode.ORDER_NOT_FOUND, 'Order not found', S.NOT_FOUND);

export const sellerOrderNotFound = () =>
  new AppError(OrderingErrorCode.SELLER_ORDER_NOT_FOUND, 'Seller order not found', S.NOT_FOUND);

export const returnNotAllowed = () =>
  new AppError(C.RETURN_NOT_ALLOWED, 'Only delivered items can be returned', S.UNPROCESSABLE_ENTITY);

export const returnWindowClosed = () =>
  new AppError(C.RETURN_WINDOW_CLOSED, 'The return window for this order has closed', S.UNPROCESSABLE_ENTITY);

export const returnPhotosRequired = () =>
  new AppError(
    C.RETURN_PHOTOS_REQUIRED,
    'Add at least one photo of the problem with the items',
    S.UNPROCESSABLE_ENTITY,
  );

export const returnAmountTooLow = () =>
  new AppError(C.RETURN_AMOUNT_TOO_LOW, 'The return fee would take the whole refund', S.UNPROCESSABLE_ENTITY);

export const returnPickupUnavailable = () =>
  new AppError(
    C.RETURN_PICKUP_UNAVAILABLE,
    'We can not pick up from this governorate at the moment',
    S.UNPROCESSABLE_ENTITY,
  );

export const returnAlreadyOpen = (cause?: unknown) =>
  new AppError(C.RETURN_ALREADY_OPEN, 'This order already has an open return', S.CONFLICT, { cause });

export const returnInvalidStatusTransition = (status: string) =>
  new AppError(
    C.RETURN_INVALID_STATUS_TRANSITION,
    `This action is not allowed while the return is ${status}`,
    S.CONFLICT,
  );

export const returnEscalationWindowClosed = () =>
  new AppError(C.RETURN_ESCALATION_WINDOW_CLOSED, 'The time to escalate this return has passed', S.CONFLICT);

/** A customer- or seller-role account without its profile: a data defect, 500 (as P4-Q9). */
export const profileMissing = (role: string, userId: string) =>
  internalError(new Error(`${role}-role user ${userId} has no ${role} profile`));

/** The open-return race (RE-1): check-then-insert is answered by the partial unique index. */
export function registerReturnsConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('uq_return_requests_seller_order_id_open', returnAlreadyOpen);
}
