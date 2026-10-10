export const CATALOG_TABLES = {
  CATEGORIES: 'categories',
  CATEGORY_ATTRIBUTES: 'category_attributes',
  CATEGORY_ATTRIBUTE_OPTIONS: 'category_attribute_options',
  PRODUCTS: 'products',
  PRODUCT_VARIANTS: 'product_variants',
  VARIANT_ATTRIBUTE_VALUES: 'variant_attribute_values',
} as const;

/** Public paths under /api/v1 (spec 06 §4.1). */
export const CATALOG_PATHS = {
  CATEGORIES: '/categories',
  CATEGORY_ATTRIBUTES: '/categories/:categoryId/attributes',
} as const;

/** Admin paths under /api/v1 (spec 06 §4.2). */
export const CATALOG_ADMIN_PATHS = {
  CATEGORIES: '/admin/categories',
  CATEGORY: '/admin/categories/:categoryId',
  CATEGORY_ATTRIBUTES: '/admin/categories/:categoryId/attributes',
  ATTRIBUTE: '/admin/attributes/:attributeId',
  ATTRIBUTE_OPTIONS: '/admin/attributes/:attributeId/options',
  OPTION: '/admin/options/:optionId',
} as const;

/** Limits (spec 06 §1; a change goes through code review). */
export const CATEGORY_MAX_DEPTH = 3;
export const MAX_EFFECTIVE_ATTRIBUTES = 5;
export const MAX_OPTIONS_PER_ATTRIBUTE = 100;
export const MAX_VARIANTS_PER_PRODUCT = 100;
export const MAX_CHILDREN_PER_CATEGORY = 100;

/** DTO limits = column lengths (02-database.md §5). */
export const CATEGORY_NAME_MAX_LENGTH = 100;
export const CATEGORY_SLUG_MAX_LENGTH = 120;
export const ATTRIBUTE_NAME_MAX_LENGTH = 60;
export const ATTRIBUTE_CODE_MAX_LENGTH = 60;
export const OPTION_VALUE_MAX_LENGTH = 60;
export const OPTION_CODE_MAX_LENGTH = 60;
export const SORT_ORDER_MAX = 10_000;

/** The whole category tree with attributes and options, cache-aside (spec 06 CA-8). */
export const CATEGORY_TREE_CACHE_KEY = 'v1:catalog:category-tree';

/** Seller paths under /api/v1 (spec 06 §4.3). */
export const CATALOG_SELLER_PATHS = {
  PRODUCTS: '/seller/products',
  PRODUCT: '/seller/products/:productId',
  ACTIVATE: '/seller/products/:productId/activate',
  DEACTIVATE: '/seller/products/:productId/deactivate',
  VARIANTS: '/seller/products/:productId/variants',
  VARIANT: '/seller/products/:productId/variants/:variantId',
  STOCK_ADJUSTMENTS: '/seller/variants/:variantId/stock-adjustments',
  STOCK_MOVEMENTS: '/seller/variants/:variantId/stock-movements',
} as const;

/** Product and variant DTO limits = column lengths (02-database.md §5, DB-Q4). */
export const PRODUCT_NAME_MIN_LENGTH = 2;
export const PRODUCT_NAME_MAX_LENGTH = 200;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 5000;
export const PRODUCT_SLUG_MAX_LENGTH = 220;
export const SKU_MAX_LENGTH = 64;
export const SKU_PATTERN = /^[A-Za-z0-9._-]+$/;
export const INITIAL_STOCK_MAX = 100_000;
export const STOCK_DELTA_MAX = 100_000;

/** `kebab(name)-xxxxxx` (spec 06 UC-CA-3); `product-xxxxxx` when the name has nothing usable (CA-10). */
export const PRODUCT_SLUG_SUFFIX_LENGTH = 6;
export const PRODUCT_SLUG_FALLBACK = 'product';

/** Public product detail, static part only (no stock), cache-aside (spec 06 CA-8). */
export const productDetailCacheKey = (productId: string): string => `v1:catalog:product:${productId}`;

/** Public paths under /api/v1 (spec 06 §4.1): products. */
export const CATALOG_PRODUCT_PATHS = {
  PRODUCTS: '/products',
  PRODUCT: '/products/:idOrSlug',
} as const;

/** Search text `q` (spec 06 §4.1). */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
/** `attr.*` filters per request, and option codes per filter (spec 06 §4.1). */
export const MAX_ATTRIBUTE_FILTERS = 5;
export const MAX_ATTRIBUTE_FILTER_VALUES = 20;
/** Detail `availableQuantity` = min(sellable, 99): the cart line maximum (DB-Q3). */
export const MAX_AVAILABLE_QUANTITY = 99;
