import { defineEvent } from './define-event';

/** Publisher: sellers. Consumer: catalog. */
export interface SellerSuspendedPayload {
  sellerId: string;
  userId: string;
  reason: string;
}

export const SellerSuspended = defineEvent<SellerSuspendedPayload>('seller.suspended', 1, 'seller');
