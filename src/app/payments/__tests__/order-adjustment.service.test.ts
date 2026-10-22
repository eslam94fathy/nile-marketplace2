import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type EventEnvelope, PermanentEventError } from '../../../lib/events';
import { Money } from '../../../lib/money';
import { type Payment } from '../model/payment.model';
import { OrderAdjustmentService } from '../service/order-adjustment.service';

const TRX = {} as DbTransaction;
const ORDER_ID = '0192f5e0-0000-7000-8000-000000000001';
const SELLER_ORDER_ID = '0192f5e0-0000-7000-8000-000000000002';

const payment = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'payment-1',
  orderId: ORDER_ID,
  customerId: 'customer-1',
  method: 'cod',
  status: 'pending',
  amount: Money.of('300.00'),
  collectedAmount: Money.zero(),
  refundedAmount: Money.zero(),
  session: null,
  providerTransactionRef: null,
  paidAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const envelope = (eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
  eventId: 'event-1',
  eventType,
  version: 1,
  occurredAt: new Date().toISOString(),
  correlationId: null,
  aggregateType: 'seller_order',
  aggregateId: SELLER_ORDER_ID,
  payload: { orderId: ORDER_ID, sellerOrderId: SELLER_ORDER_ID, ...payload },
});

function setup(current: Payment | null, alreadyFlagged = '0.00') {
  const payments = {
    lockByOrderId: vi.fn(() => Promise.resolve(current)),
    updateAmounts: vi.fn(() => Promise.resolve()),
  };
  const refunds = {
    insertPending: vi.fn((_refund: { amount: Money; reason: string }) => Promise.resolve()),
    sumForPayment: vi.fn(() => Promise.resolve(Money.of(alreadyFlagged))),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.PaymentRepository, { useValue: payments });
  container.register(TOKENS.PaymentRefundRepository, { useValue: refunds });
  container.register(TOKENS.Logger, { useValue: logger });
  container.register(TOKENS.Clock, { useValue: { now: () => new Date('2026-10-22T10:00:00.000Z') } });
  return { payments, refunds, logger, service: container.resolve(OrderAdjustmentService) };
}

describe('OrderAdjustmentService (spec 10 UC-PA-3)', () => {
  it('COD: a cancellation lowers the amount still to collect', async () => {
    const { service, payments } = setup(payment());
    await service.handle(envelope('seller_order.cancelled', { amountCancelled: '120.50' }), TRX);
    expect(payments.updateAmounts).toHaveBeenCalledWith(
      'payment-1',
      expect.objectContaining({ status: 'pending', amount: Money.of('179.50') }),
      TRX,
    );
  });

  it('COD: an amount that would go below 0 is a permanent error', async () => {
    const { service, payments } = setup(payment({ amount: Money.of('10.00') }));
    await expect(
      service.handle(envelope('seller_order.returned', { subtotal: '10.01' }), TRX),
    ).rejects.toBeInstanceOf(PermanentEventError);
    expect(payments.updateAmounts).not.toHaveBeenCalled();
  });

  it('Kashier: a 0.00 amount needs no refund row (the refund CHECK requires > 0)', async () => {
    const { service, refunds } = setup(payment({ method: 'kashier', status: 'paid' }));
    await service.handle(envelope('seller_order.cancelled', { amountCancelled: '0.00' }), TRX);
    expect(refunds.insertPending).not.toHaveBeenCalled();
  });

  it('a fully refunded Kashier payment and a settled COD payment are left alone', async () => {
    for (const settled of [
      payment({ method: 'kashier', status: 'refunded' }),
      payment({ status: 'collected' }),
    ]) {
      const { service, payments, refunds } = setup(settled);
      await service.handle(envelope('seller_order.cancelled', { amountCancelled: '5.00' }), TRX);
      expect(payments.updateAmounts).not.toHaveBeenCalled();
      expect(refunds.insertPending).not.toHaveBeenCalled();
    }
  });

  it('COD close: an unexplained difference is logged as COD_AMOUNT_MISMATCH and still settles', async () => {
    const { service, payments, logger } = setup(
      payment({ status: 'partially_collected', collectedAmount: Money.of('90.00') }),
    );
    await service.handle(
      envelope('order.closed', {
        deliveredItemsTotal: '100.00',
        deliveryFee: '50.00',
        originalDeliveryFee: '50.00',
      }),
      TRX,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'COD_AMOUNT_MISMATCH', expected: '150.00', collected: '90.00' }),
    );
    expect(payments.updateAmounts).toHaveBeenCalledWith(
      'payment-1',
      { status: 'collected', amount: Money.of('90.00'), collectedAmount: Money.of('90.00') },
      TRX,
    );
  });

  it.each([
    ['a bad uuid', 'seller_order.cancelled', { orderId: 'nope', amountCancelled: '1.00' }],
    ['a bad amount', 'seller_order.cancelled', { amountCancelled: '1.005' }],
    ['a COD delivery without codCollectedAmount', 'seller_order.delivered', { codCollectedAmount: null }],
    ['an unbound event type', 'order.placed', {}],
  ])('%s is a permanent error', async (_name, eventType, payload) => {
    const { service } = setup(payment());
    await expect(service.handle(envelope(eventType, payload), TRX)).rejects.toBeInstanceOf(
      PermanentEventError,
    );
  });

  it('an order without a payment is a permanent error', async () => {
    const { service } = setup(null);
    await expect(
      service.handle(envelope('seller_order.cancelled', { amountCancelled: '1.00' }), TRX),
    ).rejects.toBeInstanceOf(PermanentEventError);
  });

  it('Kashier: refunds never exceed what was collected (PA-20)', async () => {
    const paidPayment = payment({ method: 'kashier', status: 'paid', collectedAmount: Money.of('150.00') });
    const capped = setup(paidPayment, '120.00');
    await capped.service.handle(envelope('seller_order.cancelled', { amountCancelled: '100.00' }), TRX);
    expect(capped.refunds.insertPending.mock.calls[0]?.[0].amount).toEqual(Money.of('30.00'));
    expect(capped.logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'REFUND_CAPPED' }),
    );

    // A late payment already flagged its whole amount (SD-5): the cancellation adds nothing.
    const covered = setup(paidPayment, '150.00');
    await covered.service.handle(
      envelope('order.closed', {
        deliveredItemsTotal: '0.00',
        deliveryFee: '0.00',
        originalDeliveryFee: '50.00',
      }),
      TRX,
    );
    expect(covered.refunds.insertPending).not.toHaveBeenCalled();
  });
});
