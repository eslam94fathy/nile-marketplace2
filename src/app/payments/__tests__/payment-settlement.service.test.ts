import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { type Payment } from '../model/payment.model';
import { PaymentSettlementService } from '../service/payment-settlement.service';

const TRX = {} as DbTransaction;

const payment = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'payment-1',
  orderId: 'order-1',
  method: 'kashier',
  status: 'initiated',
  amount: Money.of('150.00'),
  collectedAmount: Money.zero(),
  refundedAmount: Money.zero(),
  session: null,
  providerTransactionRef: null,
  paidAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

function setup() {
  const payments = { transition: vi.fn(() => Promise.resolve(true)) };
  const refunds = { insertPending: vi.fn(() => Promise.resolve()) };
  const outbox = {
    add: vi.fn((_trx: DbTransaction, _event: { payload: Record<string, unknown> }) => Promise.resolve()),
    addMany: vi.fn(),
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
  container.register(TOKENS.Outbox, { useValue: outbox });
  container.register(TOKENS.Logger, { useValue: logger });
  return { payments, refunds, outbox, logger, service: container.resolve(PaymentSettlementService) };
}

const paid = { transactionRef: 'TX-1', amount: Money.of('150.00'), paidAt: new Date('2026-10-12T10:00:00Z') };

describe('PaymentSettlementService (spec 10 UC-PA-2)', () => {
  it('initiated → paid with the transaction, and payment.paid (not late)', async () => {
    const { service, payments, outbox, refunds } = setup();
    expect(await service.applySuccess(payment(), paid, TRX)).toBe('paid');
    expect(payments.transition).toHaveBeenCalledWith('payment-1', ['initiated', 'expired'], 'paid', TRX, {
      collectedAmount: paid.amount,
      providerTransactionRef: 'TX-1',
      paidAt: paid.paidAt,
    });
    expect(refunds.insertPending).not.toHaveBeenCalled();
    expect(outbox.add.mock.calls[0]?.[1].payload).toMatchObject({ lateAfterExpiry: false, amount: '150.00' });
  });

  it('a COD payment or a payment already settled or refunded is left alone', async () => {
    for (const [current, outcome] of [
      [payment({ method: 'cod', status: 'pending' }), 'not_kashier'],
      [payment({ status: 'paid' }), 'already_settled'],
      [payment({ status: 'refunded_manually' }), 'already_settled'],
      [payment({ status: 'failed' }), 'already_settled'],
    ] as const) {
      const { service, payments, outbox } = setup();
      expect(await service.applySuccess(current, paid, TRX)).toBe(outcome);
      expect(payments.transition).not.toHaveBeenCalled();
      expect(outbox.add).not.toHaveBeenCalled();
    }
  });
});
