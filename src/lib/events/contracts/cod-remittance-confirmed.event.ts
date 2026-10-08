import { defineEvent } from './define-event';

/** Publisher: finance. Consumers: none in R1. */
export interface CodRemittanceConfirmedPayload {
  remittanceId: string;
  agentId: string;
  amount: string;
  confirmedByUserId: string;
}

export const CodRemittanceConfirmed = defineEvent<CodRemittanceConfirmedPayload>(
  'cod.remittance_confirmed',
  1,
  'cod_remittance',
);
