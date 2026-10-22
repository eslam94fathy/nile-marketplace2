import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type Env } from '../../../lib/config';
import {
  type EventEnvelope,
  OrderClosed,
  type PaymentMethod,
  PaymentRefunded,
  PaymentRefundRecorded,
  PermanentEventError,
  ReturnCompleted,
  SellerOrderDelivered,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { addDuration, TimeUnit } from '../../../pkg/time';
import {
  deliveryBooking,
  orderClosedBooking,
  refundPaidBooking,
  returnBooking,
} from '../model/booking-rules';
import { heldNow, splitReturnDebits } from '../model/hold.model';
import { type SellerOrderHoldRepository } from '../repository/seller-order-hold.repository';
import { type Booking } from '../model/ledger.model';
import { type LedgerService } from './ledger.service';

/**
 * The `finance.ledger` consumer (spec 12 §1.2, §8.2, §8.4, §8.5), inside the host's transaction with its
 * `processed_events` row, so a replay is a no-op (FI-4). Finance books nothing before delivery (E-6).
 * A delivery holds the seller's net; a return reverses it from the hold first (FI-18); a refund paid for a
 * return settles what the customer was owed. A refund booked before its return would take the customer
 * account below 0: the ledger refuses it and the event is retried (FI-15).
 */
@injectable()
export class LedgerBookingService {
  constructor(
    @inject(TOKENS.LedgerService) private readonly ledger: LedgerService,
    @inject(TOKENS.SellerOrderHoldRepository) private readonly holds: SellerOrderHoldRepository,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'RETURN_WINDOW_DAYS'>,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const booking = await this.bookingOf(envelope, trx);
    if (!booking) return;
    const entries = await this.ledger.post(booking, trx);
    this.logger.info('ledger booking posted', {
      event: 'LEDGER_BOOKED',
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      referenceType: booking.referenceType,
      referenceId: booking.referenceId,
      entries: entries.length,
    });
  }

  private async bookingOf(envelope: EventEnvelope, trx: DbTransaction): Promise<Booking | null> {
    switch (envelope.eventType) {
      case SellerOrderDelivered.type: {
        const paymentMethod = paymentMethodField(envelope);
        const cod = envelope.payload.codCollectedAmount;
        if (paymentMethod === 'cod' && typeof cod !== 'string') {
          throw new PermanentEventError(
            `${envelope.eventType}: payload.codCollectedAmount is required for COD`,
          );
        }
        const sellerOrderId = uuidField(envelope, 'sellerOrderId');
        const sellerId = uuidField(envelope, 'sellerId');
        const sellerNet = moneyField(envelope, 'sellerNet');
        // §8.2: held until the return window (the same RETURN_WINDOW_DAYS as returns) has passed.
        await this.holds.insertIfNew(
          {
            sellerOrderId,
            sellerId,
            heldAmount: sellerNet,
            releaseAfter: addDuration(
              dateField(envelope, 'deliveredAt'),
              this.env.RETURN_WINDOW_DAYS,
              TimeUnit.DAY,
            ),
          },
          trx,
        );
        return deliveryBooking(
          {
            sellerOrderId,
            sellerId,
            agentId: uuidField(envelope, 'agentId'),
            paymentMethod,
            sellerNet,
            commission: moneyField(envelope, 'commission'),
            agentFeeShare: moneyField(envelope, 'agentFeeShare'),
            codCollectedAmount: paymentMethod === 'cod' ? moneyField(envelope, 'codCollectedAmount') : null,
            deliveryFeeCollected: booleanField(envelope, 'deliveryFeeCollected'),
            deliveryFeeAmount: moneyField(envelope, 'deliveryFeeAmount'),
          },
          envelope.eventId,
        );
      }
      case OrderClosed.type:
        return orderClosedBooking(
          {
            orderId: uuidField(envelope, 'orderId'),
            paymentMethod: paymentMethodField(envelope),
            deliveryFee: moneyField(envelope, 'deliveryFee'),
          },
          envelope.eventId,
        );
      case ReturnCompleted.type: {
        const sellerOrderId = uuidField(envelope, 'sellerOrderId');
        const returnFee = moneyField(envelope, 'returnFee');
        const payer = envelope.payload.returnFeePayer;
        if (payer !== 'seller' && payer !== 'customer') {
          throw new PermanentEventError(`${envelope.eventType}: payload.returnFeePayer is unknown`);
        }
        // Lock order inside finance: the hold, then the accounts (FI-18, as the release job).
        const hold = await this.holds.lock(sellerOrderId, trx);
        const split = splitReturnDebits(
          heldNow(hold),
          moneyField(envelope, 'sellerNetReversed'),
          payer === 'seller' ? returnFee : Money.zero(),
        );
        if (hold && hold.releasedAt === null)
          await this.holds.setHeldAmount(sellerOrderId, split.heldAfter, trx);
        return returnBooking(
          {
            returnId: uuidField(envelope, 'returnId'),
            sellerId: uuidField(envelope, 'sellerId'),
            customerId: uuidField(envelope, 'customerId'),
            agentId: uuidField(envelope, 'agentId'),
            commissionReversed: moneyField(envelope, 'commissionReversed'),
            refundAmount: moneyField(envelope, 'refundAmount'),
            returnFee,
            agentFeeShare: moneyField(envelope, 'agentFeeShare'),
          },
          split,
          envelope.eventId,
        );
      }
      case PaymentRefunded.type:
      case PaymentRefundRecorded.type: {
        // Refunds of other reasons book nothing: nothing was booked before delivery (E-6, §8.5).
        if (envelope.payload.reason !== 'return') return null;
        return refundPaidBooking(
          {
            refundId: uuidField(envelope, 'refundId'),
            customerId: uuidField(envelope, 'customerId'),
            amount: moneyField(envelope, 'amount'),
          },
          envelope.eventId,
        );
      }
      default:
        throw new PermanentEventError(`finance.ledger does not handle ${envelope.eventType}`);
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_METHODS: readonly PaymentMethod[] = ['cod', 'kashier'];

/** A payload that can never be processed goes straight to the DLQ (retries can't fix it, FI-4). */
function uuidField(envelope: EventEnvelope, field: string): string {
  const value = envelope.payload[field];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PermanentEventError(`${envelope.eventType}: payload.${field} must be a UUID`);
  }
  return value;
}

function moneyField(envelope: EventEnvelope, field: string): Money {
  const value = envelope.payload[field];
  try {
    if (typeof value !== 'string') throw new RangeError('not a string');
    const money = Money.of(value);
    if (money.isNegative()) throw new RangeError('negative');
    return money;
  } catch {
    throw new PermanentEventError(
      `${envelope.eventType}: payload.${field} must be a non-negative money string`,
    );
  }
}

function dateField(envelope: EventEnvelope, field: string): Date {
  const value = envelope.payload[field];
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new PermanentEventError(`${envelope.eventType}: payload.${field} must be an ISO date`);
  }
  return date;
}

function booleanField(envelope: EventEnvelope, field: string): boolean {
  const value = envelope.payload[field];
  if (typeof value !== 'boolean') {
    throw new PermanentEventError(`${envelope.eventType}: payload.${field} must be a boolean`);
  }
  return value;
}

function paymentMethodField(envelope: EventEnvelope): PaymentMethod {
  const value = envelope.payload.paymentMethod;
  const method = PAYMENT_METHODS.find((m) => m === value);
  if (!method) throw new PermanentEventError(`${envelope.eventType}: payload.paymentMethod is unknown`);
  return method;
}
