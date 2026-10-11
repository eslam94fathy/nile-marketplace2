export const CART_TABLES = {
  CARTS: 'carts',
  CART_ITEMS: 'cart_items',
} as const;

/** Max quantity of one line (DB-Q3). Mirrors `chk_cart_items_quantity`, so it isn't env (spec 08 CT-9). */
export const CART_MAX_LINE_QUANTITY = 99;
