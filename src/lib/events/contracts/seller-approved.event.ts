import { defineEvent } from './define-event';

/** Publisher: sellers (first approval and reinstatement). Consumer: catalog. */
export interface SellerApprovedPayload {
  sellerId: string;
  userId: string;
  previousStatus: 'pending_approval' | 'suspended';
}

export const SellerApproved = defineEvent<SellerApprovedPayload>('seller.approved', 1, 'seller');
