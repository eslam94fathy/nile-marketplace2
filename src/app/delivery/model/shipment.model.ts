import { Money } from '../../../lib/money';
import { AttemptFailureReason, type DeliveryActorRole, ShipmentStatus } from '../enums';
import { codAmountMismatch, codAmountNotAllowed, codAmountRequired } from '../errors';

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

/** A failed attempt ends the trip at the 3rd one (spec 11 §1.1). */
export const MAX_DELIVERY_ATTEMPTS = 3;
export type AttemptNumber = 1 | 2 | 3;

export function toAttemptNumber(value: number): AttemptNumber {
  if (value === 1 || value === 2 || value === 3) return value;
  throw new Error(`attempt number ${value} is out of range`);
}

/**
 * DE-8: a COD shipment going out takes the checkout's fee when no shipment of the checkout carries
 * it (a delivered carrier keeps it). `checkout` is every shipment of the order, locked.
 */
export const takesDeliveryFee = (shipment: Shipment, checkout: readonly Shipment[]): boolean =>
  shipment.paymentMethod === 'cod' && !checkout.some((s) => s.carriesDeliveryFee);

/** UC-DE-3: refused, or the 3rd attempt, sends the parcel back; otherwise it may go out again. */
export function afterFailedAttempt(
  attemptCount: number,
  reason: AttemptFailureReason,
): { attemptNumber: AttemptNumber; returning: boolean } {
  const attemptNumber = toAttemptNumber(attemptCount + 1);
  return {
    attemptNumber,
    returning: reason === AttemptFailureReason.CUSTOMER_REFUSED || attemptNumber === MAX_DELIVERY_ATTEMPTS,
  };
}

/**
 * UC-DE-3 delivered: COD needs exactly items + fee; Kashier takes no amount. Returns what was
 * collected (null for Kashier).
 */
export function collectedAmountFor(shipment: Shipment, given: Money | undefined): Money | null {
  if (shipment.paymentMethod !== 'cod') {
    if (given !== undefined) throw codAmountNotAllowed();
    return null;
  }
  if (given === undefined) throw codAmountRequired();
  const expected = amountToCollect(shipment);
  if (!given.equals(expected)) throw codAmountMismatch(expected.toString());
  return given;
}

/** A shipment in these statuses may still go out, and so still take the fee. */
const MAY_STILL_GO_OUT: readonly ShipmentStatus[] = [
  ShipmentStatus.UNASSIGNED,
  ShipmentStatus.ASSIGNED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.DELIVERY_FAILED,
];

/**
 * S-3 (accepted gap): the checkout had a COD delivery, but no shipment carries the fee and none
 * of the existing ones can go out any more. A seller order not yet ready has no shipment here, so
 * this is a warning, never a booking.
 */
export function deliveryFeeLeftUncollected(checkout: readonly Shipment[]): boolean {
  const cod = checkout.filter((s) => s.paymentMethod === 'cod');
  const fee = cod[0]?.orderDeliveryFee;
  if (!fee || fee.isZero()) return false;
  return (
    !cod.some((s) => s.carriesDeliveryFee) &&
    cod.some((s) => s.status === ShipmentStatus.DELIVERED) &&
    !cod.some((s) => MAY_STILL_GO_OUT.includes(s.status))
  );
}

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
