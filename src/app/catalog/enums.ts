/** Values match the CHECK constraints in the catalog migrations (spec 06 §1). */
export const ProductStatus = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

export const VariantStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type VariantStatus = (typeof VariantStatus)[keyof typeof VariantStatus];
