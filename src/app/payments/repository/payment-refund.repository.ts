import { injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { type Money } from '../../../lib/money';
import { PAYMENTS_TABLES } from '../constants';
import { type RefundReason, RefundStatus } from '../enums';

const T = PAYMENTS_TABLES.PAYMENT_REFUNDS;

interface PaymentRefundTable {
  id: string;
  payment_id: string;
  seller_order_id: string | null;
  amount: string;
  reason: RefundReason;
  status: RefundStatus;
  recorded_by_user_id: string | null;
  recorded_at: Date | null;
  provider_refund_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

@injectable()
export class PaymentRefundRepository {
  /** A refund due, waiting for an admin to do it in the Kashier dashboard and record it (UC-PA-4). */
  async insertPending(
    refund: { paymentId: string; sellerOrderId: string | null; amount: Money; reason: RefundReason },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<PaymentRefundTable>(T).insert({
      payment_id: refund.paymentId,
      seller_order_id: refund.sellerOrderId,
      amount: refund.amount.toString(),
      reason: refund.reason,
      status: RefundStatus.PENDING_MANUAL,
      recorded_by_user_id: null,
      recorded_at: null,
      provider_refund_ref: null,
    });
  }
}
