/** Why a cart line can't be checked out as it is (spec 08 UC-CT-1). */
export const CartItemIssue = {
  UNAVAILABLE: 'UNAVAILABLE',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
} as const;
export type CartItemIssue = (typeof CartItemIssue)[keyof typeof CartItemIssue];
