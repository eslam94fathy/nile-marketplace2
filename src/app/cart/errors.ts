import { AppError, internalError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** cart error codes (docs/spec/08-cart.md §6). INSUFFICIENT_STOCK is inventory's (CT-3). */
export const CartErrorCode = {
  CART_ITEM_NOT_FOUND: 'CART_ITEM_NOT_FOUND',
  VARIANT_NOT_PURCHASABLE: 'VARIANT_NOT_PURCHASABLE',
  CART_ITEM_QUANTITY_LIMIT: 'CART_ITEM_QUANTITY_LIMIT',
  CART_LINE_LIMIT_REACHED: 'CART_LINE_LIMIT_REACHED',
} as const;

const C = CartErrorCode;
const S = HTTP_STATUS;

/** Also another customer's line, or no cart yet: never reveal that the id exists. */
export const cartItemNotFound = () => new AppError(C.CART_ITEM_NOT_FOUND, 'Cart item not found', S.NOT_FOUND);

export const variantNotPurchasable = () =>
  new AppError(C.VARIANT_NOT_PURCHASABLE, 'This item is not available for purchase', S.UNPROCESSABLE_ENTITY);

export const cartItemQuantityLimit = (max: number) =>
  new AppError(
    C.CART_ITEM_QUANTITY_LIMIT,
    `A cart line can hold at most ${max} units`,
    S.UNPROCESSABLE_ENTITY,
  );

export const cartLineLimitReached = (max: number) =>
  new AppError(C.CART_LINE_LIMIT_REACHED, `A cart can hold at most ${max} lines`, S.UNPROCESSABLE_ENTITY);

/** Registration creates the user and the profile in one transaction, so this is a bug (CT-8). */
export const customerProfileMissing = (userId: string) =>
  internalError(new Error(`customer-role user ${userId} has no customer profile`));
