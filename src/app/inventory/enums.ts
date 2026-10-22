/** Values match `chk_inventory_movements_type` (spec 07 §1). */
export const MovementType = {
  SELLER_ADJUSTMENT: 'seller_adjustment',
  RESERVE: 'reserve',
  RELEASE: 'release',
  COMMIT: 'commit',
  /** Returned units put back on hand (spec 07 §8). */
  RETURN_RESTOCK: 'return_restock',
} as const;
export type MovementType = (typeof MovementType)[keyof typeof MovementType];

/** Values match `chk_inventory_reservations_status` (spec 07 §1). */
export const ReservationStatus = {
  ACTIVE: 'active',
  COMMITTED: 'committed',
  RELEASED: 'released',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];
