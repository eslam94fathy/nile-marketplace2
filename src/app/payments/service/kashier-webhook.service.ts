import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { EGP, Money } from '../../../lib/money';
import { type IPaymentGateway } from '../../../pkg/payments';
import { invalidWebhookSignature } from '../errors';
import { type PaymentEventRepository } from '../repository/payment-event.repository';
import { type PaymentRepository } from '../repository/payment.repository';
import { type PaymentSettlementService } from './payment-settlement.service';

const PROVIDER = 'kashier';
/** The Kashier event that carries a payment's outcome; anything else (refund, void…) is recorded only. */
const PAY_EVENT = 'pay';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Spec 10 UC-PA-1: verify, dedupe, record, then apply a successful payment (UC-PA-2) in one short
 * transaction that locks only the payment row (spec 10 PA-2). Unknown orders, failed attempts and
 * other events are recorded and answered 200 so Kashier stops retrying.
 */
@injectable()
export class KashierWebhookService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.PaymentGateway) private readonly gateway: IPaymentGateway,
    @inject(TOKENS.PaymentRepository) private readonly payments: PaymentRepository,
    @inject(TOKENS.PaymentEventRepository) private readonly events: PaymentEventRepository,
    @inject(TOKENS.PaymentSettlementService) private readonly settlement: PaymentSettlementService,
  ) {}

  async receive(rawBody: Buffer, signatureHeader: string | undefined): Promise<void> {
    const notification = this.gateway.verifyWebhook(rawBody, signatureHeader);
    if (!notification) {
      this.logger.warn('kashier webhook rejected: bad or missing signature', {
        event: 'INVALID_WEBHOOK_SIGNATURE',
      });
      throw invalidWebhookSignature();
    }
    const fields = { eventType: notification.event, transactionId: notification.transactionId };

    await this.tx.run(async (trx) => {
      // merchantOrderId is our payment id (PA-12); anything else can't be ours.
      const payment = UUID.test(notification.merchantOrderId)
        ? await this.payments.lockById(notification.merchantOrderId, trx)
        : null;
      const eventId = await this.events.insertIfNew(
        {
          provider: PROVIDER,
          providerEventId: notification.eventId,
          eventType: notification.event,
          paymentId: payment?.id ?? null,
          payload: notification.storablePayload,
        },
        trx,
      );
      if (!eventId) {
        this.logger.info('kashier webhook already received', {
          event: 'KASHIER_WEBHOOK_DUPLICATE',
          ...fields,
        });
        return;
      }

      if (!payment) {
        this.logger.error('kashier webhook for an unknown order', {
          event: 'KASHIER_UNKNOWN_ORDER',
          ...fields,
        });
      } else if (notification.event !== PAY_EVENT || !notification.succeeded) {
        // S-4: a failed attempt leaves the payment initiated, so the customer can retry in the window.
        this.logger.info('kashier webhook recorded', {
          event: 'KASHIER_WEBHOOK_RECORDED',
          ...fields,
          paymentId: payment.id,
          succeeded: notification.succeeded,
        });
      } else if (notification.currency !== EGP) {
        // Sessions are always created in EGP, so this is a misconfiguration: recorded, investigated by hand.
        this.logger.error('kashier payment in another currency', {
          event: 'KASHIER_CURRENCY_MISMATCH',
          ...fields,
          paymentId: payment.id,
          currency: notification.currency,
        });
      } else {
        await this.settlement.applySuccess(
          payment,
          {
            transactionRef: notification.transactionId,
            amount: Money.of(notification.amount),
            paidAt: this.clock.now(),
          },
          trx,
        );
      }
      await this.events.markProcessed(eventId, this.clock.now(), trx);
    });
  }
}
