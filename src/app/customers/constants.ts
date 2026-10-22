export const CUSTOMERS_TABLES = {
  CUSTOMERS: 'customers',
  CUSTOMER_ADDRESSES: 'customer_addresses',
  WISHLIST_ITEMS: 'wishlist_items',
} as const;

/** Paths under /api/v1 (spec 04 §4). */
export const CUSTOMERS_PATHS = {
  REGISTER: '/auth/register/customer',
  ME: '/me',
  ADDRESSES: '/me/addresses',
  ADDRESS: '/me/addresses/:addressId',
  WISHLIST: '/me/wishlist',
  WISHLIST_PRODUCT_IDS: '/me/wishlist/product-ids',
  WISHLIST_ITEM: '/me/wishlist/:productId',
} as const;

/** Admin paths under /api/v1 (spec 20 §3.3). */
export const CUSTOMERS_ADMIN_PATHS = {
  CUSTOMERS: '/admin/customers',
  CUSTOMER: '/admin/customers/:customerId',
} as const;

/** `GET /admin/customers` query fields applied by the repository (no column in the whitelist). */
export const CUSTOMER_LIST_PARAMS = { NAME: 'name' } as const;

/** DTO limits = column lengths (02-database.md §3). */
export const NAME_MAX_LENGTH = 100;
export const ADDRESS_LIMITS = {
  LABEL: 50,
  RECIPIENT_NAME: 100,
  CITY: 100,
  AREA: 100,
  STREET: 200,
  BUILDING: 50,
  FLOOR: 10,
  APARTMENT: 10,
  LANDMARK: 200,
} as const;
