import { type Money } from '../../../lib/money';
import { type PayeeType } from '../enums';

/** COD cash an agent handed in, confirmed by an admin (spec 12 §1.3). Append-only. */
export interface CodRemittance {
  id: string;
  agentId: string;
  amount: Money;
  confirmedByUserId: string;
  note: string | null;
  createdAt: Date;
}

/** A payout made outside the system and recorded by an admin (spec 12 §1.3). Append-only. */
export interface Payout {
  id: string;
  payeeType: PayeeType;
  payeeId: string;
  amount: Money;
  externalReference: string;
  recordedByUserId: string;
  paidAt: Date;
  createdAt: Date;
}
