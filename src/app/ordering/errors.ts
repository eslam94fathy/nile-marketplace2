import { AppError, type ErrorDetail, internalError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';
import { CustomersErrorCode } from '../customers';

/** ordering error codes (docs/spec/09-ordering.md §6). */
export const OrderingErrorCode = {
  CART_EMPTY: 'CART_EMPTY',
  CART_HAS_ISSUES: 'CART_HAS_ISSUES',
  GOVERNORATE_NOT_DELIVERABLE: 'GOVERNORATE_NOT_DELIVERABLE',
  ORDER_TOTAL_CHANGED: 'ORDER_TOTAL_CHANGED',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_NOT_AWAITING_PAYMENT: 'ORDER_NOT_AWAITING_PAYMENT',
  SELLER_ORDER_NOT_FOUND: 'SELLER_ORDER_NOT_FOUND',
  SELLER_ORDER_INVALID_STATUS_TRANSITION: 'SELLER_ORDER_INVALID_STATUS_TRANSITION',
  SELLER_ORDER_NOT_CANCELLABLE: 'SELLER_ORDER_NOT_CANCELLABLE',
  ORDER_ITEM_NOT_FOUND: 'ORDER_ITEM_NOT_FOUND',
  ITEM_CANCEL_QUANTITY_INVALID: 'ITEM_CANCEL_QUANTITY_INVALID',
} as const;

const C = OrderingErrorCode;
const S = HTTP_STATUS;

export const cartEmpty = () => new AppError(C.CART_EMPTY, 'Your cart is empty', S.UNPROCESSABLE_ENTITY);

/** One detail per variant that can't be bought (unavailable, or its seller isn't approved). */
export const cartHasIssues = (variantIds: readonly string[]) =>
  new AppError(C.CART_HAS_ISSUES, 'Some items in your cart can no longer be bought', S.CONFLICT, {
    details: variantIds.map((variantId): ErrorDetail => ({
      field: 'variantId',
      value: variantId,
      constraint: 'purchasable',
      message: 'not available',
    })),
  });

export const governorateNotDeliverable = () =>
  new AppError(
    C.GOVERNORATE_NOT_DELIVERABLE,
    'We do not deliver to this governorate yet',
    S.UNPROCESSABLE_ENTITY,
  );

/** S-8: the client shows the new total and asks again. */
export const orderTotalChanged = (currentTotal: string) =>
  new AppError(C.ORDER_TOTAL_CHANGED, 'The order total has changed', S.CONFLICT, {
    details: [
      {
        field: 'expectedTotal',
        value: currentTotal,
        constraint: 'current',
        message: `current: ${currentTotal}`,
      },
    ],
  });

/** Spec 09 §6: the address is a body reference at checkout, so it's 422 here (customers answers 404). */
export const checkoutAddressNotFound = () =>
  new AppError(CustomersErrorCode.ADDRESS_NOT_FOUND, 'Address not found', S.UNPROCESSABLE_ENTITY);

/** Missing, or another customer's: never tell them apart. */
export const orderNotFound = () => new AppError(C.ORDER_NOT_FOUND, 'Order not found', S.NOT_FOUND);

/** Not a Kashier order still inside its payment window (spec 09 §4.1.2, OR-7). */
export const orderNotAwaitingPayment = () =>
  new AppError(C.ORDER_NOT_AWAITING_PAYMENT, 'This order is not awaiting an online payment', S.CONFLICT);

export const sellerOrderNotFound = () =>
  new AppError(C.SELLER_ORDER_NOT_FOUND, 'Seller order not found', S.NOT_FOUND);

export const sellerOrderInvalidStatusTransition = (status: string) =>
  new AppError(
    C.SELLER_ORDER_INVALID_STATUS_TRANSITION,
    `This action is not allowed while the seller order is ${status}`,
    S.CONFLICT,
  );

/** Customer: only while placed. Seller: until it is picked up (Q-31). */
export const sellerOrderNotCancellable = (status: string) =>
  new AppError(
    C.SELLER_ORDER_NOT_CANCELLABLE,
    `A ${status} seller order can no longer be cancelled`,
    S.CONFLICT,
  );

export const orderItemNotFound = () =>
  new AppError(C.ORDER_ITEM_NOT_FOUND, 'Order item not found', S.NOT_FOUND);

export const itemCancelQuantityInvalid = (open: number) =>
  new AppError(
    C.ITEM_CANCEL_QUANTITY_INVALID,
    `At most ${open} can still be cancelled`,
    S.UNPROCESSABLE_ENTITY,
    {
      details: [{ field: 'quantity', value: String(open), constraint: 'max', message: `open: ${open}` }],
    },
  );

/** Registration creates the user and the profile in one transaction, so this is a bug (as cart CT-8). */
export const profileMissing = (role: string, userId: string) =>
  internalError(new Error(`${role}-role user ${userId} has no ${role} profile`));
