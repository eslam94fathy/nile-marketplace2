export const SELLERS_TABLES = {
  SELLERS: 'sellers',
  SELLER_STATUS_HISTORY: 'seller_status_history',
  SELLER_COMMISSION_HISTORY: 'seller_commission_history',
  SELLER_SETTINGS: 'seller_settings',
} as const;

/** Paths under /api/v1 (spec 05 §4). */
export const SELLERS_PATHS = {
  REGISTER: '/auth/register/seller',
  PROFILE: '/seller/profile',
  REAPPLY: '/seller/profile/reapply',
} as const;

/** DTO limits = column lengths (02-database.md §4). */
export const BUSINESS_NAME_MIN_LENGTH = 2;
export const BUSINESS_NAME_MAX_LENGTH = 150;
export const PICKUP_LIMITS = {
  CITY: 100,
  AREA: 100,
  STREET: 200,
  BUILDING: 50,
  LANDMARK: 200,
} as const;
