import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type EventEnvelope, PermanentEventError } from '../../../lib/events';
import { Money } from '../../../lib/money';
import { AccountType, EntryDirection, EntryType, ReferenceType } from '../enums';
import {
  type DeliveredAmounts,
  deliveryBooking,
  holdReleaseBooking,
  orderClosedBooking,
  refundPaidBooking,
  returnBooking,
  type ReturnedAmounts,
} from '../model/booking-rules';
import { type SellerOrderHold, splitReturnDebits } from '../model/hold.model';
import {
  accountKeyOf,
  type AccountKey,
  type Booking,
  type FinanceAccount,
  type LedgerEntry,
} from '../model/ledger.model';
import { type NewLedgerEntry } from '../repository/ledger-entry.repository';
import { LedgerBookingService } from '../service/ledger-booking.service';
import { InsufficientBalanceError, LedgerService } from '../service/ledger.service';

const TRX = {} as DbTransaction;
const SELLER = '0192f5e0-0000-7000-8000-00000000000a';
const SELLER_B = '0192f5e0-0000-7000-8000-00000000000b';
const AGENT = '0192f5e0-0000-7000-8000-0000000000a1';
const ORDER = '0192f5e0-0000-7000-8000-000000000001';
const SO_1 = '0192f5e0-0000-7000-8000-000000000011';
const SO_2 = '0192f5e0-0000-7000-8000-000000000012';
const m = (value: string) => Money.of(value);

const delivered = (overrides: Partial<DeliveredAmounts> = {}): DeliveredAmounts => ({
  sellerOrderId: SO_1,
  sellerId: SELLER,
  agentId: AGENT,
  paymentMethod: 'cod',
  sellerNet: m('90.00'),
  commission: m('10.00'),
  platformDiscount: m('0.00'),
  agentFeeShare: m('14.00'),
  codCollectedAmount: m('160.00'),
  deliveryFeeCollected: true,
  deliveryFeeAmount: m('60.00'),
  ...overrides,
});

/** Postings as plain tuples for readable expectations. */
const rows = (booking: Booking) =>
  booking.postings.map((p) => [p.account.accountType, p.direction, p.amount.toString(), p.entryType]);

describe('booking rules (spec 12 §1.2)', () => {
  it('COD delivery carrying the fee books rows 1–6', () => {
    const booking = deliveryBooking(delivered(), 'event-1');
    expect([booking.referenceType, booking.referenceId, booking.sourceEventId]).toEqual([
      ReferenceType.SELLER_ORDER,
      SO_1,
      'event-1',
    ]);
    expect(rows(booking)).toEqual([
      ['seller_pending', 'credit', '90.00', 'seller_net_held'],
      ['platform_commission_revenue', 'credit', '10.00', 'commission_earned'],
      ['agent_fee_payable', 'credit', '14.00', 'agent_fee_earned'],
      ['platform_delivery_revenue', 'debit', '14.00', 'agent_fee_earned'],
      ['agent_cod_cash', 'credit', '160.00', 'cod_cash_collected'],
      ['platform_delivery_revenue', 'credit', '60.00', 'platform_fee_earned'],
    ]);
    expect(booking.postings[0]?.account.ownerId).toBe(SELLER);
    expect(booking.postings[2]?.account.ownerId).toBe(AGENT);
    expect(booking.postings[1]?.account.ownerId).toBeNull();
  });

  it('COD delivery without the fee books no fee revenue (row 6)', () => {
    const booking = deliveryBooking(
      delivered({
        codCollectedAmount: m('100.00'),
        deliveryFeeCollected: false,
        deliveryFeeAmount: m('0.00'),
      }),
      'e',
    );
    expect(rows(booking).map((r) => r[3])).not.toContain(EntryType.PLATFORM_FEE_EARNED);
    expect(rows(booking)).toContainEqual(['agent_cod_cash', 'credit', '100.00', 'cod_cash_collected']);
  });

  it('Kashier delivery books no cash and no fee: rows 1–4 only', () => {
    const booking = deliveryBooking(
      delivered({ paymentMethod: 'kashier', codCollectedAmount: null, deliveryFeeCollected: false }),
      'e',
    );
    expect(rows(booking).map((r) => r[0])).toEqual([
      'seller_pending',
      'platform_commission_revenue',
      'agent_fee_payable',
      'platform_delivery_revenue',
    ]);
  });

  it('a platform-funded discount books row 8: net + commission − discount = what the customer paid', () => {
    const booking = deliveryBooking(
      delivered({
        paymentMethod: 'kashier',
        sellerNet: m('180.00'),
        commission: m('20.00'),
        platformDiscount: m('20.00'),
        codCollectedAmount: null,
        deliveryFeeCollected: false,
        deliveryFeeAmount: m('0.00'),
      }),
      'event-c',
    );
    expect(rows(booking)).toEqual([
      ['seller_pending', 'credit', '180.00', 'seller_net_held'],
      ['platform_commission_revenue', 'credit', '20.00', 'commission_earned'],
      ['platform_promotions', 'debit', '20.00', 'promotion_funded'],
      ['agent_fee_payable', 'credit', '14.00', 'agent_fee_earned'],
      ['platform_delivery_revenue', 'debit', '14.00', 'agent_fee_earned'],
    ]);
  });

  it('a share or commission of 0.00 writes no entry (FI-4)', () => {
    const booking = deliveryBooking(
      delivered({ agentFeeShare: m('0.00'), commission: m('0.00'), sellerNet: m('100.00') }),
      'e',
    );
    expect(rows(booking).map((r) => r[3])).toEqual([
      EntryType.SELLER_NET_HELD,
      EntryType.COD_CASH_COLLECTED,
      EntryType.PLATFORM_FEE_EARNED,
    ]);
  });

  it('order.closed books the fee only for Kashier with a fee > 0 (row 7)', () => {
    const kashier = orderClosedBooking(
      { orderId: ORDER, paymentMethod: 'kashier', deliveryFee: m('60.00') },
      'e',
    );
    expect([kashier.referenceType, kashier.referenceId]).toEqual([ReferenceType.ORDER, ORDER]);
    expect(rows(kashier)).toEqual([['platform_delivery_revenue', 'credit', '60.00', 'platform_fee_earned']]);
    expect(
      orderClosedBooking({ orderId: ORDER, paymentMethod: 'kashier', deliveryFee: m('0.00') }, 'e').postings,
    ).toEqual([]);
    expect(
      orderClosedBooking({ orderId: ORDER, paymentMethod: 'cod', deliveryFee: m('60.00') }, 'e').postings,
    ).toEqual([]);
  });
});

/** In-memory accounts and entries: the ledger service's arithmetic without a database. */
function memoryLedger() {
  const accounts = new Map<string, FinanceAccount>();
  const entries: NewLedgerEntry[] = [];
  let next = 0;
  const accountRepo = {
    ensure: vi.fn((keys: readonly AccountKey[]) => {
      for (const key of keys) {
        if (!accounts.has(accountKeyOf(key))) {
          next += 1;
          accounts.set(accountKeyOf(key), {
            ...key,
            id: `account-${String(next).padStart(3, '0')}`,
            balance: Money.zero(),
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
      return Promise.resolve();
    }),
    lockByKeys: vi.fn((keys: readonly AccountKey[]) =>
      Promise.resolve(
        keys
          .map((key) => accounts.get(accountKeyOf(key)))
          .filter((a): a is FinanceAccount => a !== undefined)
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    ),
    updateBalance: vi.fn((id: string, balance: Money) => {
      for (const [key, account] of accounts)
        if (account.id === id) accounts.set(key, { ...account, balance });
      return Promise.resolve();
    }),
  };
  const entryRepo = {
    insertMany: vi.fn((rows: readonly NewLedgerEntry[]) => {
      entries.push(...rows);
      return Promise.resolve(
        rows.map((row, i): LedgerEntry => ({
          ...row,
          id: `entry-${entries.length + i}`,
          createdAt: new Date(),
        })),
      );
    }),
  };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.FinanceAccountRepository, { useValue: accountRepo });
  container.register(TOKENS.LedgerEntryRepository, { useValue: entryRepo });
  const ledger = container.resolve(LedgerService);
  const balanceOf = (accountType: AccountType, ownerId: string | null = null) =>
    accounts.get(accountKeyOf({ accountType, ownerId }))?.balance.toString() ?? 'none';
  return { ledger, accounts, entries, accountRepo, balanceOf };
}

const CUSTOMER = '0192f5e0-0000-7000-8000-0000000000c1';
const RETURN_ID = '0192f5e0-0000-7000-8000-0000000000r1'.replace('r', 'f');

const returned = (overrides: Partial<ReturnedAmounts> = {}): ReturnedAmounts => ({
  returnId: RETURN_ID,
  sellerId: SELLER,
  customerId: CUSTOMER,
  agentId: AGENT,
  commissionReversed: m('20.00'),
  platformDiscountReversed: m('0.00'),
  refundAmount: m('150.00'),
  returnFee: m('50.00'),
  agentFeeShare: m('35.00'),
  ...overrides,
});

describe('return bookings (spec 12 §8.4, FI-18)', () => {
  it('splits seller debits: net first, then the seller-paid fee, from what is still held', () => {
    const split = splitReturnDebits(m('100.00'), m('80.00'), m('50.00'));
    expect(
      Object.fromEntries((Object.entries(split) as [string, Money][]).map(([k, v]) => [k, v.toString()])),
    ).toEqual({
      netFromPending: '80.00',
      netFromAvailable: '0.00',
      feeFromPending: '20.00',
      feeFromAvailable: '30.00',
      heldAfter: '0.00',
    });
    expect(splitReturnDebits(m('0.00'), m('80.00'), m('0.00')).netFromAvailable.toString()).toBe('80.00');
  });

  it('a changed-mind return of 2 × 100 (commission 20, fee 50, agent 70 %) balances (§8.4 example without a coupon)', () => {
    const split = splitReturnDebits(m('180.00'), m('180.00'), m('0.00'));
    const booking = returnBooking(returned(), split, 'event-r');
    expect([booking.referenceType, booking.referenceId]).toEqual([ReferenceType.RETURN, RETURN_ID]);
    expect(rows(booking)).toEqual([
      ['seller_pending', 'debit', '180.00', 'seller_net_reversed'],
      ['platform_commission_revenue', 'debit', '20.00', 'commission_reversed'],
      ['customer_refund_payable', 'credit', '150.00', 'customer_refund_owed'],
      ['platform_delivery_revenue', 'credit', '50.00', 'return_fee_earned'],
      ['agent_fee_payable', 'credit', '35.00', 'agent_fee_earned'],
      ['platform_delivery_revenue', 'debit', '35.00', 'agent_fee_earned'],
    ]);
    const total = (direction: EntryDirection) =>
      Money.sum(booking.postings.filter((p) => p.direction === direction).map((p) => p.amount)).toString();
    expect(total(EntryDirection.DEBIT)).toBe(total(EntryDirection.CREDIT));
  });

  it('§8.4 example with a platform coupon of 10 %: the discount goes back to promotions (row 11) and it balances', () => {
    const split = splitReturnDebits(m('180.00'), m('180.00'), m('0.00'));
    const booking = returnBooking(
      returned({ platformDiscountReversed: m('20.00'), refundAmount: m('130.00') }),
      split,
      'event-r',
    );
    expect(rows(booking)).toEqual([
      ['seller_pending', 'debit', '180.00', 'seller_net_reversed'],
      ['platform_commission_revenue', 'debit', '20.00', 'commission_reversed'],
      ['platform_promotions', 'credit', '20.00', 'promotion_reversed'],
      ['customer_refund_payable', 'credit', '130.00', 'customer_refund_owed'],
      ['platform_delivery_revenue', 'credit', '50.00', 'return_fee_earned'],
      ['agent_fee_payable', 'credit', '35.00', 'agent_fee_earned'],
      ['platform_delivery_revenue', 'debit', '35.00', 'agent_fee_earned'],
    ]);
    const total = (direction: EntryDirection) =>
      Money.sum(booking.postings.filter((p) => p.direction === direction).map((p) => p.amount)).toString();
    expect(total(EntryDirection.DEBIT)).toBe(total(EntryDirection.CREDIT));
  });

  it('a seller-fault return takes the fee from the seller, pending first then available; it still balances', () => {
    const split = splitReturnDebits(m('100.00'), m('90.00'), m('50.00'));
    const booking = returnBooking(
      returned({ commissionReversed: m('10.00'), refundAmount: m('100.00') }),
      split,
      'e',
    );
    expect(rows(booking).filter((r) => r[0] === 'seller_pending' || r[0] === 'seller_payable')).toEqual([
      ['seller_pending', 'debit', '90.00', 'seller_net_reversed'],
      ['seller_pending', 'debit', '10.00', 'return_fee_charged'],
      ['seller_payable', 'debit', '40.00', 'return_fee_charged'],
    ]);
    const total = (direction: EntryDirection) =>
      Money.sum(booking.postings.filter((p) => p.direction === direction).map((p) => p.amount)).toString();
    expect(total(EntryDirection.DEBIT)).toBe(total(EntryDirection.CREDIT));
  });

  it('refund paid and hold release bookings', () => {
    expect(
      rows(refundPaidBooking({ refundId: 'rf', customerId: CUSTOMER, amount: m('150.00') }, 'e')),
    ).toEqual([['customer_refund_payable', 'debit', '150.00', 'customer_refund_paid']]);
    const release = holdReleaseBooking({ sellerOrderId: SO_1, sellerId: SELLER, heldAmount: m('70.00') });
    expect([release.referenceType, release.referenceId, release.sourceEventId]).toEqual([
      ReferenceType.SELLER_ORDER_HOLD,
      SO_1,
      null,
    ]);
    expect(rows(release)).toEqual([
      ['seller_pending', 'debit', '70.00', 'seller_net_released'],
      ['seller_payable', 'credit', '70.00', 'seller_net_released'],
    ]);
    expect(
      holdReleaseBooking({ sellerOrderId: SO_1, sellerId: SELLER, heldAmount: m('0.00') }).postings,
    ).toEqual([]);
  });
});

describe('LedgerService', () => {
  it('overview §5 example: fee 60, 3 seller orders, 1 cancelled → agents 14 + 14, delivery revenue 32', async () => {
    const { ledger, balanceOf } = memoryLedger();
    // The first delivery carried the fee; the second didn't; the cancelled one books nothing.
    await ledger.post(deliveryBooking(delivered(), 'e1'), TRX);
    await ledger.post(
      deliveryBooking(
        delivered({
          sellerOrderId: SO_2,
          sellerId: SELLER_B,
          codCollectedAmount: m('100.00'),
          deliveryFeeCollected: false,
          deliveryFeeAmount: m('0.00'),
        }),
        'e2',
      ),
      TRX,
    );
    await ledger.post(
      orderClosedBooking({ orderId: ORDER, paymentMethod: 'cod', deliveryFee: m('60.00') }, 'e3'),
      TRX,
    );

    expect(balanceOf(AccountType.AGENT_FEE_PAYABLE, AGENT)).toBe('28.00');
    expect(balanceOf(AccountType.PLATFORM_DELIVERY_REVENUE)).toBe('32.00');
    expect(balanceOf(AccountType.AGENT_COD_CASH, AGENT)).toBe('260.00');
    expect(balanceOf(AccountType.SELLER_PENDING, SELLER)).toBe('90.00');
    expect(balanceOf(AccountType.SELLER_PENDING, SELLER_B)).toBe('90.00');
    expect(balanceOf(AccountType.PLATFORM_COMMISSION_REVENUE)).toBe('20.00');
  });

  it('records balance_after per account, in posting order, and updates each balance once', async () => {
    const { ledger, entries, accountRepo } = memoryLedger();
    await ledger.post(deliveryBooking(delivered(), 'e1'), TRX);
    const delivery = entries.filter((e) => e.entryType !== EntryType.SELLER_NET_HELD);
    // Delivery revenue: −14 then +60.
    const revenue = entries.filter((_, i) => i === 3 || i === 5).map((e) => e.balanceAfter.toString());
    expect(revenue).toEqual(['-14.00', '46.00']);
    expect(delivery.every((e) => e.sourceEventId === 'e1')).toBe(true);
    // 5 distinct accounts → 5 balance updates; the keys were created sorted.
    expect(accountRepo.updateBalance).toHaveBeenCalledTimes(5);
    const ensured = (accountRepo.ensure.mock.calls[0]?.[0] ?? []).map(accountKeyOf);
    expect(ensured).toEqual([...ensured].sort());
  });

  it('delivery revenue and seller payable may go below 0 (FI-1, FI-12); pending may not; strict refuses', async () => {
    const { ledger, balanceOf } = memoryLedger();
    await ledger.post(
      deliveryBooking(
        delivered({ paymentMethod: 'kashier', codCollectedAmount: null, deliveryFeeCollected: false }),
        'e',
      ),
      TRX,
    );
    expect(balanceOf(AccountType.PLATFORM_DELIVERY_REVENUE)).toBe('-14.00');

    const debit = (accountType: AccountType, amount: string): Booking => ({
      referenceType: ReferenceType.PAYOUT,
      referenceId: 'payout-1',
      sourceEventId: null,
      postings: [
        {
          account: { accountType, ownerId: SELLER },
          direction: EntryDirection.DEBIT,
          amount: m(amount),
          entryType: EntryType.SELLER_PAYOUT,
        },
      ],
    });
    const pending = await ledger
      .post(debit(AccountType.SELLER_PENDING, '90.01'), TRX)
      .catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(InsufficientBalanceError);
    expect((pending as InsufficientBalanceError).balance.toString()).toBe('90.00');

    // A payout is strict: the seller's balance of 0 refuses it; a return's debit may take it negative.
    const strict = await ledger
      .post(debit(AccountType.SELLER_PAYABLE, '0.01'), TRX, { strict: true })
      .catch((e: unknown) => e);
    expect(strict).toBeInstanceOf(InsufficientBalanceError);
    await ledger.post(debit(AccountType.SELLER_PAYABLE, '25.00'), TRX);
    expect(balanceOf(AccountType.SELLER_PAYABLE, SELLER)).toBe('-25.00');
  });

  it('refuses postings of 0.00 and writes nothing for an empty booking', async () => {
    const { ledger, accountRepo } = memoryLedger();
    expect(
      await ledger.post(
        { referenceType: ReferenceType.ORDER, referenceId: ORDER, sourceEventId: 'e', postings: [] },
        TRX,
      ),
    ).toEqual([]);
    expect(accountRepo.ensure).not.toHaveBeenCalled();
    await expect(
      ledger.post(
        {
          referenceType: ReferenceType.ORDER,
          referenceId: ORDER,
          sourceEventId: 'e',
          postings: [
            {
              account: { accountType: AccountType.PLATFORM_DELIVERY_REVENUE, ownerId: null },
              direction: EntryDirection.CREDIT,
              amount: m('0.00'),
              entryType: EntryType.PLATFORM_FEE_EARNED,
            },
          ],
        },
        TRX,
      ),
    ).rejects.toThrow(RangeError);
  });
});

describe('LedgerBookingService (finance.ledger)', () => {
  const envelope = (eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
    eventId: '0192f5e0-0000-7000-8000-0000000000e1',
    eventType,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    aggregateType: 'seller_order',
    aggregateId: SO_1,
    payload,
  });
  const deliveredPayload = (overrides: Record<string, unknown> = {}) => ({
    sellerOrderId: SO_1,
    orderId: ORDER,
    sellerId: SELLER,
    paymentMethod: 'cod',
    subtotal: '100.00',
    commissionRate: '0.1000',
    commission: '10.00',
    sellerNet: '90.00',
    agentId: AGENT,
    agentFeeShare: '14.00',
    codCollectedAmount: '160.00',
    deliveryFeeCollected: true,
    deliveryFeeAmount: '60.00',
    deliveredAt: new Date().toISOString(),
    ...overrides,
  });

  let hold: SellerOrderHold | null = null;
  function setup() {
    const post = vi.fn((_booking: Booking) => Promise.resolve([]));
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const holds = {
      insertIfNew: vi.fn(() => Promise.resolve()),
      lock: vi.fn((): Promise<SellerOrderHold | null> => Promise.resolve(hold)),
      setHeldAmount: vi.fn(() => Promise.resolve()),
    };
    const container = rootContainer.createChildContainer();
    container.register(TOKENS.LedgerService, { useValue: { post } });
    container.register(TOKENS.SellerOrderHoldRepository, { useValue: holds });
    container.register(TOKENS.Env, { useValue: { RETURN_WINDOW_DAYS: 14 } });
    container.register(TOKENS.Logger, { useValue: logger });
    return { service: container.resolve(LedgerBookingService), post, holds };
  }

  it('return.completed: the hold is locked first and keeps what the return did not take (FI-18)', async () => {
    hold = {
      sellerOrderId: SO_1,
      sellerId: SELLER,
      heldAmount: m('90.00'),
      releaseAfter: new Date(),
      releasedAt: null,
    };
    const { service, post, holds } = setup();
    await service.handle(
      envelope('return.completed', {
        returnId: '0192f5e0-0000-7000-8000-0000000000f1',
        sellerOrderId: SO_1,
        orderId: ORDER,
        customerId: '0192f5e0-0000-7000-8000-0000000000c1',
        sellerId: SELLER,
        paymentMethod: 'cod',
        itemsPaid: '50.00',
        itemsSubtotal: '50.00',
        commissionReversed: '5.00',
        sellerNetReversed: '45.00',
        platformDiscountReversed: '0.00',
        returnFee: '30.00',
        returnFeePayer: 'seller',
        agentId: AGENT,
        agentFeeShare: '21.00',
        refundAmount: '50.00',
        refundPayoutEncrypted: null,
      }),
      TRX,
    );
    expect(holds.lock).toHaveBeenCalledWith(SO_1, TRX);
    expect(holds.setHeldAmount).toHaveBeenCalledWith(SO_1, m('15.00'), TRX);
    expect(rows(post.mock.calls[0]?.[0] as Booking).slice(0, 2)).toEqual([
      ['seller_pending', 'debit', '45.00', 'seller_net_reversed'],
      ['platform_commission_revenue', 'debit', '5.00', 'commission_reversed'],
    ]);
    hold = null;
  });

  it('refund events book only return refunds (§8.5)', async () => {
    const { service, post } = setup();
    const refund = (reason: string) => ({
      paymentId: '0192f5e0-0000-7000-8000-0000000000p1'.replace('p', 'e'),
      orderId: ORDER,
      customerId: '0192f5e0-0000-7000-8000-0000000000c1',
      refundId: '0192f5e0-0000-7000-8000-0000000000d1',
      returnId: null,
      reason,
      amount: '50.00',
      newPaymentStatus: 'partially_refunded',
    });
    await service.handle(envelope('payment.refunded', refund('seller_order_cancelled')), TRX);
    expect(post).not.toHaveBeenCalled();
    await service.handle(envelope('payment.refund_recorded', refund('return')), TRX);
    expect(rows(post.mock.calls[0]?.[0] as Booking)).toEqual([
      ['customer_refund_payable', 'debit', '50.00', 'customer_refund_paid'],
    ]);
  });

  it('a delivery creates its hold until the return window ends (§8.2)', async () => {
    const { service, holds } = setup();
    await service.handle(
      envelope('seller_order.delivered', deliveredPayload({ deliveredAt: '2026-10-01T10:00:00.000Z' })),
      TRX,
    );
    expect(holds.insertIfNew).toHaveBeenCalledWith(
      {
        sellerOrderId: SO_1,
        sellerId: SELLER,
        heldAmount: m('90.00'),
        releaseAfter: new Date('2026-10-15T10:00:00.000Z'),
      },
      TRX,
    );
  });

  it('books seller_order.delivered with the event id as the source', async () => {
    const { service, post } = setup();
    await service.handle(envelope('seller_order.delivered', deliveredPayload()), TRX);
    const booking = post.mock.calls[0]?.[0];
    expect(booking?.sourceEventId).toBe('0192f5e0-0000-7000-8000-0000000000e1');
    expect(booking?.postings).toHaveLength(6);
  });

  it('Kashier deliveries ignore the (null) cash amount', async () => {
    const { service, post } = setup();
    await service.handle(
      envelope(
        'seller_order.delivered',
        deliveredPayload({ paymentMethod: 'kashier', codCollectedAmount: null, deliveryFeeCollected: false }),
      ),
      TRX,
    );
    expect(post.mock.calls[0]?.[0].postings).toHaveLength(4);
  });

  it('books order.closed', async () => {
    const { service, post } = setup();
    await service.handle(
      envelope('order.closed', { orderId: ORDER, paymentMethod: 'kashier', deliveryFee: '60.00' }),
      TRX,
    );
    expect(post.mock.calls[0]?.[0].referenceType).toBe(ReferenceType.ORDER);
  });

  it.each([
    ['a COD delivery without the cash amount', { codCollectedAmount: null }],
    ['a malformed amount', { sellerNet: '90.001' }],
    ['a negative amount', { commission: '-1.00' }],
    ['a missing agent', { agentId: undefined }],
    ['an unknown payment method', { paymentMethod: 'cash' }],
    ['a non-boolean fee flag', { deliveryFeeCollected: 'yes' }],
  ])('sends %s to the DLQ (FI-4)', async (_name, overrides) => {
    const { service, post } = setup();
    await expect(
      service.handle(envelope('seller_order.delivered', deliveredPayload(overrides)), TRX),
    ).rejects.toBeInstanceOf(PermanentEventError);
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects events it does not handle', async () => {
    const { service } = setup();
    await expect(service.handle(envelope('seller_order.cancelled', {}), TRX)).rejects.toBeInstanceOf(
      PermanentEventError,
    );
  });
});
