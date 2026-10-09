/** Values match the CHECK constraints in the sellers migrations (spec 05 §1). */
export const SellerStatus = {
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
} as const;
export type SellerStatus = (typeof SellerStatus)[keyof typeof SellerStatus];
