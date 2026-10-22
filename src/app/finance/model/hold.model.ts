import { Money } from '../../../lib/money';

/**
 * A delivered seller order's net held in `seller_pending` until its return window ends (spec 12 §8.1,
 * R-16). `heldAmount` is what is still held: returns take their seller debits from it first (FI-18).
 */
export interface SellerOrderHold {
  sellerOrderId: string;
  sellerId: string;
  heldAmount: Money;
  releaseAfter: Date;
  releasedAt: Date | null;
}

/** What is still in pending for this seller order: nothing once released (or without a hold, FI-13). */
export const heldNow = (hold: SellerOrderHold | null): Money =>
  hold && hold.releasedAt === null ? hold.heldAmount : Money.zero();

/** A return's seller debits split between pending and available (FI-18). */
export interface ReturnDebitSplit {
  netFromPending: Money;
  netFromAvailable: Money;
  feeFromPending: Money;
  feeFromAvailable: Money;
  /** The hold's `held_amount` after the return. */
  heldAfter: Money;
}

/**
 * FI-18: the seller net reversed first, then the return fee when the seller pays it, each from pending up
 * to what the hold still holds, the rest from available (`seller_payable`, which may go negative, FI-12).
 */
export function splitReturnDebits(held: Money, sellerNet: Money, sellerFee: Money): ReturnDebitSplit {
  const min = (a: Money, b: Money) => (a.lessThan(b) ? a : b);
  const netFromPending = min(sellerNet, held);
  const feeFromPending = min(sellerFee, held.minus(netFromPending));
  return {
    netFromPending,
    netFromAvailable: sellerNet.minus(netFromPending),
    feeFromPending,
    feeFromAvailable: sellerFee.minus(feeFromPending),
    heldAfter: held.minus(netFromPending).minus(feeFromPending),
  };
}
