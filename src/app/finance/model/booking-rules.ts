import { type PaymentMethod } from '../../../lib/events';
import { type Money } from '../../../lib/money';
import { type ReturnDebitSplit } from './hold.model';
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

/** Rows 1–6 of spec 12 §1.2 for one delivered seller order, row 1 into `seller_pending` (§8.2). */
export function deliveryBooking(delivered: DeliveredAmounts, sourceEventId: string): Booking {
  const { CREDIT, DEBIT } = EntryDirection;
  const agentFee: AccountKey = { accountType: AccountType.AGENT_FEE_PAYABLE, ownerId: delivered.agentId };
  const postings: Posting[] = [
    // Held until the return window ends (spec 12 §8.2, R-16); the release moves it to seller_payable.
    posting(
      { accountType: AccountType.SELLER_PENDING, ownerId: delivered.sellerId },
      CREDIT,
      delivered.sellerNet,
      EntryType.SELLER_NET_HELD,
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

/** What `return.completed` carries for the ledger, parsed (spec 18 §5). */
export interface ReturnedAmounts {
  returnId: string;
  sellerId: string;
  customerId: string;
  agentId: string;
  commissionReversed: Money;
  refundAmount: Money;
  returnFee: Money;
  agentFeeShare: Money;
}

const sellerPending = (sellerId: string): AccountKey => ({
  accountType: AccountType.SELLER_PENDING,
  ownerId: sellerId,
});
const sellerPayable = (sellerId: string): AccountKey => ({
  accountType: AccountType.SELLER_PAYABLE,
  ownerId: sellerId,
});

/**
 * Rows 9, 10, 12–15 of spec 12 §8.4 (rows 11 and 8 come with coupons, FI-16). The seller debits are split
 * between pending and available by FI-18. Debits = seller net + commission (+ the fee if the seller pays)
 * = credits = refund + fee.
 */
export function returnBooking(
  returned: ReturnedAmounts,
  split: ReturnDebitSplit,
  sourceEventId: string,
): Booking {
  const { CREDIT, DEBIT } = EntryDirection;
  const agentFee: AccountKey = { accountType: AccountType.AGENT_FEE_PAYABLE, ownerId: returned.agentId };
  const postings: Posting[] = [
    posting(sellerPending(returned.sellerId), DEBIT, split.netFromPending, EntryType.SELLER_NET_REVERSED),
    posting(sellerPayable(returned.sellerId), DEBIT, split.netFromAvailable, EntryType.SELLER_NET_REVERSED),
    posting(PLATFORM_COMMISSION, DEBIT, returned.commissionReversed, EntryType.COMMISSION_REVERSED),
    posting(
      { accountType: AccountType.CUSTOMER_REFUND_PAYABLE, ownerId: returned.customerId },
      CREDIT,
      returned.refundAmount,
      EntryType.CUSTOMER_REFUND_OWED,
    ),
    posting(sellerPending(returned.sellerId), DEBIT, split.feeFromPending, EntryType.RETURN_FEE_CHARGED),
    posting(sellerPayable(returned.sellerId), DEBIT, split.feeFromAvailable, EntryType.RETURN_FEE_CHARGED),
    // The whole fee is delivery revenue; the customer's share is inside the refund deduction (row 14).
    posting(PLATFORM_DELIVERY, CREDIT, returned.returnFee, EntryType.RETURN_FEE_EARNED),
    posting(agentFee, CREDIT, returned.agentFeeShare, EntryType.AGENT_FEE_EARNED),
    posting(PLATFORM_DELIVERY, DEBIT, returned.agentFeeShare, EntryType.AGENT_FEE_EARNED),
  ];
  return {
    referenceType: ReferenceType.RETURN,
    referenceId: returned.returnId,
    sourceEventId,
    postings: positive(postings),
  };
}

/** Spec 12 §8.5: the platform paid the customer what a return owed (FI-19). */
export function refundPaidBooking(
  refund: { refundId: string; customerId: string; amount: Money },
  sourceEventId: string,
): Booking {
  return {
    referenceType: ReferenceType.REFUND,
    referenceId: refund.refundId,
    sourceEventId,
    postings: positive([
      posting(
        { accountType: AccountType.CUSTOMER_REFUND_PAYABLE, ownerId: refund.customerId },
        EntryDirection.DEBIT,
        refund.amount,
        EntryType.CUSTOMER_REFUND_PAID,
      ),
    ]),
  };
}

/** Spec 12 §8.3: the return window ended; what is still held becomes available. */
export function holdReleaseBooking(hold: {
  sellerOrderId: string;
  sellerId: string;
  heldAmount: Money;
}): Booking {
  return {
    referenceType: ReferenceType.SELLER_ORDER_HOLD,
    referenceId: hold.sellerOrderId,
    sourceEventId: null,
    postings: positive([
      posting(
        sellerPending(hold.sellerId),
        EntryDirection.DEBIT,
        hold.heldAmount,
        EntryType.SELLER_NET_RELEASED,
      ),
      posting(
        sellerPayable(hold.sellerId),
        EntryDirection.CREDIT,
        hold.heldAmount,
        EntryType.SELLER_NET_RELEASED,
      ),
    ]),
  };
}
