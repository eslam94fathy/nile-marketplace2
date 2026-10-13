import { ReservationStatus } from '../enums';

/** Stock held for one order line (spec 07 UC-IN-1…3). `quantity` is what is still reserved (D-9). */
export interface InventoryReservation {
  id: string;
  inventoryItemId: string;
  orderItemId: string;
  quantity: number;
  status: ReservationStatus;
}

/** One line to reserve at checkout (spec 07 §2 `reserve`). */
export interface ReserveLine {
  variantId: string;
  orderItemId: string;
  quantity: number;
}

/** Releases `quantity` of an order line's reservation, partly or fully (spec 07 §2 `release`). */
export interface ReleaseLine {
  orderItemId: string;
  quantity: number;
}

export const isActive = (reservation: InventoryReservation): boolean =>
  reservation.status === ReservationStatus.ACTIVE;
