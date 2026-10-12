import { Money } from '../../../lib/money';
import { type AttemptFailureReason, type DeliveryActorRole, type ShipmentStatus } from '../enums';

/** What payments' COD amounts and the agent's screen need, as the event snapshotted it (D-2). */
export type ShipmentPaymentMethod = 'cod' | 'kashier';

export interface ShipmentPickup {
  businessName: string;
  phone: string;
  governorateId: string;
  city: string;
  area: string;
  street: string;
  building: string;
  landmark: string | null;
}

export interface ShipmentDropoff {
  recipientName: string;
  recipientPhone: string;
  governorateId: string;
  governorateName: string;
  city: string;
  area: string;
  street: string;
  building: string;
  floor: string | null;
  apartment: string | null;
  landmark: string | null;
}

/** One shipment per seller order (spec 11 §1). */
export interface Shipment {
  id: string;
  sellerOrderId: string;
  orderId: string;
  agentId: string | null;
  status: ShipmentStatus;
  orderNumber: string;
  paymentMethod: ShipmentPaymentMethod;
  orderDeliveryFee: Money;
  pickup: ShipmentPickup;
  dropoff: ShipmentDropoff;
  codItemsAmount: Money;
  carriesDeliveryFee: boolean;
  codFeeAmount: Money;
  codCollectedAmount: Money | null;
  attemptCount: number;
  assignedAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  sellerOrderCancelledAt: Date | null;
  createdAt: Date;
}

/** COD: the items plus the fee if this shipment carries it. Kashier: nothing (spec 11 §4.2, DE-8). */
export const amountToCollect = (shipment: Shipment): Money =>
  shipment.paymentMethod === 'cod' ? shipment.codItemsAmount.plus(shipment.codFeeAmount) : Money.zero();

export interface ShipmentAttempt {
  shipmentId: string;
  attemptNumber: number;
  reason: AttemptFailureReason;
  note: string | null;
  createdAt: Date;
}

export interface ShipmentHistoryEntry {
  shipmentId: string;
  fromStatus: ShipmentStatus | null;
  toStatus: ShipmentStatus;
  actorRole: DeliveryActorRole;
  actorUserId: string | null;
  reason: string | null;
  createdAt: Date;
}

/** Who caused a transition (history rows). */
export interface DeliveryActor {
  role: DeliveryActorRole;
  /** null = system */
  userId: string | null;
}
