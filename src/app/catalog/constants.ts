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
