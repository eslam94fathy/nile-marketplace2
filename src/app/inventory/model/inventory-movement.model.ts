import { type MovementType } from '../enums';

/** One row of the stock audit trail (seller stock history, spec 06 §4.3). */
export interface InventoryMovement {
  id: string;
  type: MovementType;
  quantityDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

export interface NewInventoryMovement {
  inventoryItemId: string;
  type: MovementType;
  quantityDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  referenceType: string | null;
  referenceId: string | null;
  /** null = system */
  actorUserId: string | null;
}
