/**
 * Values match `chk_inventory_movements_type` (spec 07 §1). `ReservationStatus` lands with the
 * reservations table in Phase 5 (IN-1).
 */
export const MovementType = {
  SELLER_ADJUSTMENT: 'seller_adjustment',
  RESERVE: 'reserve',
  RELEASE: 'release',
  COMMIT: 'commit',
} as const;
export type MovementType = (typeof MovementType)[keyof typeof MovementType];
