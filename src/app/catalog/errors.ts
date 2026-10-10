import { AppError, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** catalog error codes (docs/spec/06-catalog.md §6). */
export const CatalogErrorCode = {
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  CATEGORY_MAX_DEPTH_EXCEEDED: 'CATEGORY_MAX_DEPTH_EXCEEDED',
  CATEGORY_NAME_TAKEN: 'CATEGORY_NAME_TAKEN',
  CATEGORY_SLUG_TAKEN: 'CATEGORY_SLUG_TAKEN',
  CATEGORY_SLUG_REQUIRED: 'CATEGORY_SLUG_REQUIRED',
  CATEGORY_CHILD_LIMIT_REACHED: 'CATEGORY_CHILD_LIMIT_REACHED',
  CATEGORY_IN_USE: 'CATEGORY_IN_USE',
  CATEGORY_PARENT_INACTIVE: 'CATEGORY_PARENT_INACTIVE',
  CATEGORY_HAS_PRODUCTS: 'CATEGORY_HAS_PRODUCTS',
  ATTRIBUTE_NOT_FOUND: 'ATTRIBUTE_NOT_FOUND',
  ATTRIBUTE_CODE_CONFLICT: 'ATTRIBUTE_CODE_CONFLICT',
  ATTRIBUTE_LIMIT_REACHED: 'ATTRIBUTE_LIMIT_REACHED',
  ATTRIBUTE_IN_USE: 'ATTRIBUTE_IN_USE',
  OPTION_NOT_FOUND: 'OPTION_NOT_FOUND',
  OPTION_CODE_TAKEN: 'OPTION_CODE_TAKEN',
  OPTION_LIMIT_REACHED: 'OPTION_LIMIT_REACHED',
  OPTION_IN_USE: 'OPTION_IN_USE',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_INVALID_STATUS_TRANSITION: 'PRODUCT_INVALID_STATUS_TRANSITION',
  PRODUCT_HAS_NO_ACTIVE_VARIANT: 'PRODUCT_HAS_NO_ACTIVE_VARIANT',
  PRODUCT_CATEGORY_LOCKED: 'PRODUCT_CATEGORY_LOCKED',
  VARIANT_NOT_FOUND: 'VARIANT_NOT_FOUND',
  VARIANT_OPTIONS_INVALID: 'VARIANT_OPTIONS_INVALID',
  DEFAULT_VARIANT_EXISTS: 'DEFAULT_VARIANT_EXISTS',
  VARIANT_COMBINATION_EXISTS: 'VARIANT_COMBINATION_EXISTS',
  VARIANT_LIMIT_REACHED: 'VARIANT_LIMIT_REACHED',
  SKU_TAKEN: 'SKU_TAKEN',
  COMPARE_AT_PRICE_INVALID: 'COMPARE_AT_PRICE_INVALID',
  // STOCK_ADJUSTMENT_INVALID (spec 06 §6) is raised by inventory: InventoryErrorCode.
} as const;

const C = CatalogErrorCode;
const S = HTTP_STATUS;

/** 404 for a path id, 422 when a body references it (spec 06 §6). */
export const categoryNotFound = () => new AppError(C.CATEGORY_NOT_FOUND, 'Category not found', S.NOT_FOUND);
export const categoryReferenceNotFound = (cause?: unknown) =>
  new AppError(C.CATEGORY_NOT_FOUND, 'The category does not exist or is inactive', S.UNPROCESSABLE_ENTITY, {
    cause,
  });
export const categoryMaxDepthExceeded = (maxDepth: number) =>
  new AppError(
    C.CATEGORY_MAX_DEPTH_EXCEEDED,
    `Categories can be at most ${maxDepth} levels deep`,
    S.UNPROCESSABLE_ENTITY,
  );
export const categoryNameTaken = (cause?: unknown) =>
  new AppError(C.CATEGORY_NAME_TAKEN, 'A sibling category already has this name', S.CONFLICT, { cause });
export const categorySlugTaken = (cause?: unknown) =>
  new AppError(C.CATEGORY_SLUG_TAKEN, 'This slug is already taken; send another one', S.CONFLICT, {
    cause,
  });
export const categorySlugRequired = () =>
  new AppError(
    C.CATEGORY_SLUG_REQUIRED,
    'A slug cannot be derived from this name; send one',
    S.UNPROCESSABLE_ENTITY,
  );
export const categoryChildLimitReached = (max: number) =>
  new AppError(
    C.CATEGORY_CHILD_LIMIT_REACHED,
    `A category can have at most ${max} children`,
    S.UNPROCESSABLE_ENTITY,
  );
export const categoryInUse = () =>
  new AppError(C.CATEGORY_IN_USE, 'The category still has active children or products', S.CONFLICT);
export const categoryParentInactive = () =>
  new AppError(C.CATEGORY_PARENT_INACTIVE, 'Activate the parent category first', S.CONFLICT);
export const categoryHasProducts = () =>
  new AppError(
    C.CATEGORY_HAS_PRODUCTS,
    'Attributes cannot be added while the category or its subcategories have products',
    S.CONFLICT,
  );

export const attributeNotFound = () =>
  new AppError(C.ATTRIBUTE_NOT_FOUND, 'Attribute not found', S.NOT_FOUND);
export const attributeCodeConflict = (cause?: unknown) =>
  new AppError(
    C.ATTRIBUTE_CODE_CONFLICT,
    'This code already exists on the category, a parent or a subcategory',
    S.CONFLICT,
    { cause },
  );
export const attributeLimitReached = (max: number) =>
  new AppError(
    C.ATTRIBUTE_LIMIT_REACHED,
    `A category can have at most ${max} attributes, inherited ones included`,
    S.UNPROCESSABLE_ENTITY,
  );
export const attributeInUse = (cause?: unknown) =>
  new AppError(C.ATTRIBUTE_IN_USE, 'Products use this attribute', S.CONFLICT, { cause });

export const optionNotFound = () => new AppError(C.OPTION_NOT_FOUND, 'Option not found', S.NOT_FOUND);
export const optionCodeTaken = (cause?: unknown) =>
  new AppError(C.OPTION_CODE_TAKEN, 'The attribute already has an option with this code', S.CONFLICT, {
    cause,
  });
export const optionLimitReached = (max: number) =>
  new AppError(
    C.OPTION_LIMIT_REACHED,
    `An attribute can have at most ${max} options`,
    S.UNPROCESSABLE_ENTITY,
  );
export const optionInUse = (cause?: unknown) =>
  new AppError(C.OPTION_IN_USE, 'Variants use this option', S.CONFLICT, { cause });

/** Constraints that race with app-level checks (CLAUDE.md §6.4, spec 06 CA-11). */
export function registerCatalogConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('uq_categories_slug', categorySlugTaken);
  mapper.register('uq_categories_parent_id_name_lower', categoryNameTaken);
  mapper.register('fk_categories_parent_id', categoryReferenceNotFound);
  mapper.register('uq_category_attributes_category_id_code', attributeCodeConflict);
  mapper.register('uq_category_attribute_options_attribute_id_code', optionCodeTaken);
  mapper.register('fk_variant_attribute_values_attribute_id', attributeInUse);
  mapper.register('fk_variant_attribute_values_option_id', optionInUse);
}
