import { describe, expect, it } from 'vitest';
import { Money, Rate } from '../../../lib/money';
import { SellerOrderStatus as S } from '../enums';
import { type Order, type SellerOrder } from '../model/order.model';
import { agentFeeShare } from '../service/shipment-update.service';
import { type LockedOrder } from '../service/order-lifecycle.service';

const order = (fee: string, rate = '0.7000') =>
  ({ deliveryFee: Money.of(fee), agentFeeShareRate: Rate.of(rate) }) as Order;
const sellerOrder = (id: string, status: SellerOrder['status']) => ({ id, status }) as SellerOrder;
const locked = (fee: string, statuses: SellerOrder['status'][], rate?: string): LockedOrder => ({
  order: order(fee, rate),
  sellerOrders: statuses.map((status, i) => sellerOrder(`so-${i}`, status)),
});

describe('agentFeeShare (spec 09 §3.8, Q-27, S-13)', () => {
  it('splits round(fee × rate) equally, rounded down to the piastre', () => {
    // 50.00 × 0.7 = 35.00 / 3 = 11.666… → 11.66, 0.02 left over
    expect(agentFeeShare(locked('50.00', [S.DELIVERED, S.PLACED, S.PLACED]), 'so-0').toString()).toBe(
      '11.66',
    );
  });

  it('the delivery that closes the order gets the leftover piastres', () => {
    expect(
      agentFeeShare(locked('50.00', [S.DELIVERED, S.CANCELLED, S.RETURNED_TO_SELLER]), 'so-0').toString(),
    ).toBe('11.68');
  });

  it('a seller order still open elsewhere means this delivery does not close the order', () => {
    expect(
      agentFeeShare(locked('50.00', [S.DELIVERED, S.OUT_FOR_DELIVERY, S.CANCELLED]), 'so-0').toString(),
    ).toBe('11.66');
  });

  it('rounds the total half up before splitting: 33.33 × 0.7 = 23.331 → 23.33', () => {
    expect(agentFeeShare(locked('33.33', [S.DELIVERED]), 'so-0').toString()).toBe('23.33');
  });

  it('no fee, no share', () => {
    expect(agentFeeShare(locked('0.00', [S.DELIVERED, S.DELIVERED]), 'so-1').toString()).toBe('0.00');
  });
});
