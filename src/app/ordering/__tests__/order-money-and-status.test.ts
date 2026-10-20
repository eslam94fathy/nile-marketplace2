import { describe, expect, it } from 'vitest';
import { Money, Rate } from '../../../lib/money';
import { OrderStatus, SellerOrderStatus as S } from '../enums';
import { computeCheckoutMoney, type PricedLine } from '../model/checkout-money.model';
import { deriveOrderStatus } from '../model/order-status.model';

const line = (
  sellerId: string,
  price: string,
  quantity: number,
  variantId = `${sellerId}-${price}`,
): PricedLine => ({
  variantId,
  productId: 'product',
  sellerId,
  productName: 'Thing',
  sku: 'SKU',
  attributes: [],
  unitPrice: Money.of(price),
  quantity,
  imageMediaId: null,
});

describe('computeCheckoutMoney (spec 09 §3.1 step 5)', () => {
  it('splits per seller in cart order, rounds commission half-up to the piastre, and adds the fee once', () => {
    const money = computeCheckoutMoney(
      [line('b', '33.33', 1), line('a', '10.05', 3), line('b', '0.10', 2, 'b-second')],
      new Map([
        ['a', Rate.of('0.1500')],
        ['b', Rate.of('0.1000')],
      ]),
      Money.of('45.00'),
    );
    expect(
      money.sellers.map((s) => ({
        sellerId: s.sellerId,
        lineTotals: s.lines.map((l) => l.lineTotal.toString()),
        subtotal: s.subtotal.toString(),
        commission: s.commission.toString(),
        sellerNet: s.sellerNet.toString(),
      })),
    ).toEqual([
      // 33.53 × 0.10 = 3.353 → 3.35
      {
        sellerId: 'b',
        lineTotals: ['33.33', '0.20'],
        subtotal: '33.53',
        commission: '3.35',
        sellerNet: '30.18',
      },
      // 30.15 × 0.15 = 4.5225 → 4.52
      { sellerId: 'a', lineTotals: ['30.15'], subtotal: '30.15', commission: '4.52', sellerNet: '25.63' },
    ]);
    expect(money.itemsTotal.toString()).toBe('63.68');
    expect(money.total.toString()).toBe('108.68');
  });

  it('rounds an exact half up (0.125 → 0.13)', () => {
    const money = computeCheckoutMoney(
      [line('a', '1.25', 1)],
      new Map([['a', Rate.of('0.1000')]]),
      Money.zero(),
    );
    expect(money.sellers[0]?.commission.toString()).toBe('0.13');
  });

  it('a seller without a commission rate is a bug', () => {
    expect(() => computeCheckoutMoney([line('a', '1.00', 1)], new Map(), Money.zero())).toThrow(
      /commission rate/,
    );
  });
});

describe('deriveOrderStatus (spec 09 §1.1)', () => {
  it.each([
    [[S.PENDING_PAYMENT, S.PENDING_PAYMENT], OrderStatus.PENDING_PAYMENT],
    [[S.PLACED, S.PLACED], OrderStatus.PLACED],
    [[S.PLACED, S.CANCELLED], OrderStatus.PLACED],
    [[S.PLACED, S.ACCEPTED], OrderStatus.IN_PROGRESS],
    [[S.READY_FOR_PICKUP, S.CANCELLED], OrderStatus.IN_PROGRESS],
    [[S.DELIVERED, S.OUT_FOR_DELIVERY], OrderStatus.IN_PROGRESS],
    [[S.DELIVERED, S.DELIVERED], OrderStatus.COMPLETED],
    [[S.DELIVERED, S.CANCELLED], OrderStatus.PARTIALLY_COMPLETED],
    [[S.DELIVERED, S.RETURNED_TO_SELLER], OrderStatus.PARTIALLY_COMPLETED],
    [[S.CANCELLED, S.RETURNED_TO_SELLER], OrderStatus.CANCELLED],
    [[S.CANCELLED], OrderStatus.CANCELLED],
  ])('%j → %s', (statuses, expected) => {
    expect(deriveOrderStatus(statuses)).toBe(expected);
  });

  it('an order without seller orders is a bug', () => {
    expect(() => deriveOrderStatus([])).toThrow();
  });
});
