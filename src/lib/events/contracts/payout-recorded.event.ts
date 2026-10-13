import { defineEvent } from './define-event';

/** Publisher: finance. Consumers: none in R1. */
export interface PayoutRecordedPayload {
  payoutId: string;
  payeeType: 'seller' | 'agent';
  payeeId: string;
  amount: string;
  recordedByUserId: string;
}

export const PayoutRecorded = defineEvent<PayoutRecordedPayload>('payout.recorded', 1, 'payout');
