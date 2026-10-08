/**
 * Value types used inside event payloads. They mirror the owning modules' enums
 * (kept here because lib/ may not import app/; a module's enum must stay assignable to these).
 */
export type PaymentMethod = 'cod' | 'kashier';

export type UserRoleValue = 'customer' | 'seller' | 'admin' | 'delivery_agent';

export type SellerOrderStatus =
  | 'pending_payment'
  | 'placed'
  | 'accepted'
  | 'ready_for_pickup'
  | 'picked_up'
  | 'out_for_delivery'
  | 'delivery_failed'
  | 'returning_to_seller'
  | 'returned_to_seller'
  | 'delivered'
  | 'cancelled';

export type SellerOrderCancelReason =
  | 'customer_cancelled'
  | 'seller_cancelled'
  | 'seller_acceptance_timeout'
  | 'payment_failed'
  | 'payment_expired';

export type ItemCancelReason = 'out_of_stock' | 'seller_request' | 'other';

export type AttemptFailureReason =
  'customer_unreachable' | 'customer_refused' | 'wrong_address' | 'customer_rescheduled';

export interface PickupSnapshot {
  businessName: string;
  phone: string;
  governorateId: string;
  city: string;
  area: string;
  street: string;
  building: string;
  landmark: string | null;
}

export interface DropoffSnapshot {
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
