export const DELIVERY_TABLES = {
  GOVERNORATES: 'governorates',
  DELIVERY_SETTINGS: 'delivery_settings',
} as const;

/** Paths under /api/v1 (spec 11 §4). */
export const DELIVERY_PATHS = {
  GOVERNORATES: '/governorates',
} as const;

export const DELIVERY_ADMIN_PATHS = {
  GOVERNORATES: '/admin/governorates',
  GOVERNORATE: '/admin/governorates/:governorateId',
  SETTINGS: '/admin/settings/delivery',
} as const;

/** The whole governorate list, cache-aside (architecture §8, spec 11 DE-3). */
export const GOVERNORATES_CACHE_KEY = 'v1:delivery:governorates';
