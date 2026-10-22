import { AppError, type ErrorDetail, internalError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';
import { CustomersErrorCode } from '../customers';

/** ordering error codes (docs/spec/09-ordering.md §6). */
export const OrderingErrorCode = {
  CART_EMPTY: 'CART_EMPTY',
  CART_HAS_ISSUES: 'CART_HAS_ISSUES',
  GOVERNORATE_NOT_DELIVERABLE: 'GOVERNORATE_NOT_DELIVERABLE',
  ORDER_TOTAL_CHANGED: 'ORDER_TOTAL_CHANGED',
  KASHIER_TOTAL_ZERO: 'KASHIER_TOTAL_ZERO',
  ORDER_PAYMENT_PENDING: 'ORDER_PAYMENT_PENDING',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_NOT_AWAITING_PAYMENT: 'ORDER_NOT_AWAITING_PAYMENT',
  SELLER_ORDER_NOT_FOUND: 'SELLER_ORDER_NOT_FOUND',
  SELLER_ORDER_INVALID_STATUS_TRANSITION: 'SELLER_ORDER_INVALID_STATUS_TRANSITION',
  SELLER_ORDER_NOT_CANCELLABLE: 'SELLER_ORDER_NOT_CANCELLABLE',
  ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
  ORDER_ITEM_NOT_FOUND: 'ORDER_ITEM_NOT_FOUND',
  ITEM_CANCEL_QUANTITY_INVALID: 'ITEM_CANCEL_QUANTITY_INVALID',
  /** Also raised by returns at request time (spec 09 OR-28). */
  RETURN_QUANTITY_INVALID: 'RETURN_QUANTITY_INVALID',
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
/** OR-16: one open Kashier payment per customer; the detail carries that order's id. */
export const orderPaymentPending = (orderId: string) =>
  new AppError(
    C.ORDER_PAYMENT_PENDING,
    'You have an order waiting for payment; pay it or let it expire first',
    S.CONFLICT,
    {
      details: [
        { field: 'orderId', value: orderId, constraint: 'pending_payment', message: 'awaiting payment' },
      ],
    },
  );

/** A coupon took every item and the delivery fee is 0: Kashier can't charge 0.00 (spec 09 OR-32). */
export const kashierTotalZero = () =>
  new AppError(
    C.KASHIER_TOTAL_ZERO,
    'This order costs nothing; choose cash on delivery',
    S.UNPROCESSABLE_ENTITY,
  );

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

/**
 * A return line over what is still returnable, of another seller order, or listed twice: one detail per
 * line (spec 18 §6, spec 09 OR-28). Ordering's code, so returns and recordReturn raise the same 422.
 */
export const returnQuantityInvalid = (details: readonly ErrorDetail[]) =>
  new AppError(
    C.RETURN_QUANTITY_INVALID,
    'Some items can not be returned in these quantities',
    S.UNPROCESSABLE_ENTITY,
    { details },
  );

/** Registration creates the user and the profile in one transaction, so this is a bug (as cart CT-8). */
export const profileMissing = (role: string, userId: string) =>
  internalError(new Error(`${role}-role user ${userId} has no ${role} profile`));

/**
 * UC-OR-10 (OR-17): a seller order is past `ready_for_pickup`, or nothing is open. `details` names each
 * blocking seller order (none when nothing is open); nothing was cancelled.
 */
export const orderNotCancellable = (blocking: readonly { sellerOrderId: string; status: string }[]) =>
  new AppError(C.ORDER_NOT_CANCELLABLE, 'This order can no longer be cancelled as a whole', S.CONFLICT, {
    details: blocking.map((s): ErrorDetail => ({
      field: 'sellerOrderId',
      constraint: 'not_cancellable',
      message: `seller order is ${s.status}`,
      value: s.sellerOrderId,
    })),
  });
