import { type PaymentMethod } from '../../../lib/events';
import { type Money } from '../../../lib/money';
import { AccountType, EntryDirection, EntryType, ReferenceType } from '../enums';
import { type AccountKey, type Booking, type Posting } from './ledger.model';

const COD: PaymentMethod = 'cod';
const KASHIER: PaymentMethod = 'kashier';

const PLATFORM_COMMISSION: AccountKey = {
  accountType: AccountType.PLATFORM_COMMISSION_REVENUE,
  ownerId: null,
};
const PLATFORM_DELIVERY: AccountKey = { accountType: AccountType.PLATFORM_DELIVERY_REVENUE, ownerId: null };

/** What `seller_order.delivered` carries for the ledger, parsed (events §3.4). */
export interface DeliveredAmounts {
  sellerOrderId: string;
  sellerId: string;
  agentId: string;
  paymentMethod: PaymentMethod;
  sellerNet: Money;
  commission: Money;
  agentFeeShare: Money;
  /** COD: cash the agent took. Kashier: null. */
  codCollectedAmount: Money | null;
  deliveryFeeCollected: boolean;
  deliveryFeeAmount: Money;
}

/** What `order.closed` carries for the ledger, parsed (events §3.4). */
export interface ClosedAmounts {
  orderId: string;
  paymentMethod: PaymentMethod;
  /** The final fee: "0.00" when nothing was delivered (Q-28). */
  deliveryFee: Money;
}

const posting = (
  account: AccountKey,
  direction: EntryDirection,
  amount: Money,
  entryType: EntryType,
): Posting => ({ account, direction, amount, entryType });

/** Entries only for amounts > 0 (spec 12 FI-4): a share of 0.00 writes nothing. */
const positive = (postings: readonly Posting[]): Posting[] => postings.filter((p) => !p.amount.isZero());

/** Rows 1–6 of spec 12 §1.2 for one delivered seller order. */
export function deliveryBooking(delivered: DeliveredAmounts, sourceEventId: string): Booking {
  const { CREDIT, DEBIT } = EntryDirection;
  const agentFee: AccountKey = { accountType: AccountType.AGENT_FEE_PAYABLE, ownerId: delivered.agentId };
  const postings: Posting[] = [
    posting(
      { accountType: AccountType.SELLER_PAYABLE, ownerId: delivered.sellerId },
      CREDIT,
      delivered.sellerNet,
      EntryType.SELLER_NET_EARNED,
    ),
    posting(PLATFORM_COMMISSION, CREDIT, delivered.commission, EntryType.COMMISSION_EARNED),
    // The agent's share comes out of the platform's delivery revenue (rows 3/4).
    posting(agentFee, CREDIT, delivered.agentFeeShare, EntryType.AGENT_FEE_EARNED),
    posting(PLATFORM_DELIVERY, DEBIT, delivered.agentFeeShare, EntryType.AGENT_FEE_EARNED),
  ];
  if (delivered.paymentMethod === COD && delivered.codCollectedAmount) {
    postings.push(
      posting(
        { accountType: AccountType.AGENT_COD_CASH, ownerId: delivered.agentId },
        CREDIT,
        delivered.codCollectedAmount,
        EntryType.COD_CASH_COLLECTED,
      ),
    );
    // A COD fee is revenue once collected (row 6); S-3 may leave it uncollected (FI-1).
    if (delivered.deliveryFeeCollected) {
      postings.push(
        posting(PLATFORM_DELIVERY, CREDIT, delivered.deliveryFeeAmount, EntryType.PLATFORM_FEE_EARNED),
      );
    }
  }
  return {
    referenceType: ReferenceType.SELLER_ORDER,
    referenceId: delivered.sellerOrderId,
    sourceEventId,
    postings: positive(postings),
  };
}

/** Row 7 of spec 12 §1.2: a Kashier fee is revenue when the order closes; anything else books nothing. */
export function orderClosedBooking(closed: ClosedAmounts, sourceEventId: string): Booking {
  const postings =
    closed.paymentMethod === KASHIER
      ? [posting(PLATFORM_DELIVERY, EntryDirection.CREDIT, closed.deliveryFee, EntryType.PLATFORM_FEE_EARNED)]
      : [];
  return {
    referenceType: ReferenceType.ORDER,
    referenceId: closed.orderId,
    sourceEventId,
    postings: positive(postings),
  };
}
