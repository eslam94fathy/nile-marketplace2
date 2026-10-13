import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  OrderClosed,
  type PaymentMethod,
  PermanentEventError,
  SellerOrderDelivered,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { deliveryBooking, orderClosedBooking } from '../model/booking-rules';
import { type Booking } from '../model/ledger.model';
import { type LedgerService } from './ledger.service';

/**
 * The `finance.ledger` consumer (spec 12 §1.2), inside the host's transaction with its
 * `processed_events` row, so a replay is a no-op (FI-4). Finance books nothing before delivery (E-6).
 */
@injectable()
export class LedgerBookingService {
  constructor(
    @inject(TOKENS.LedgerService) private readonly ledger: LedgerService,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const booking = this.bookingOf(envelope);
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

  private bookingOf(envelope: EventEnvelope): Booking {
    switch (envelope.eventType) {
      case SellerOrderDelivered.type: {
        const paymentMethod = paymentMethodField(envelope);
        const cod = envelope.payload.codCollectedAmount;
        if (paymentMethod === 'cod' && typeof cod !== 'string') {
          throw new PermanentEventError(
            `${envelope.eventType}: payload.codCollectedAmount is required for COD`,
          );
        }
        return deliveryBooking(
          {
            sellerOrderId: uuidField(envelope, 'sellerOrderId'),
            sellerId: uuidField(envelope, 'sellerId'),
            agentId: uuidField(envelope, 'agentId'),
            paymentMethod,
            sellerNet: moneyField(envelope, 'sellerNet'),
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
