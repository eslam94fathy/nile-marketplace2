import { describe, expect, it } from 'vitest';
import { Money, Rate } from '../../../lib/money';
import { type OrderItem } from '../model/order.model';
import { computeReturnAmounts, type ReturnLine, returnLineProblems } from '../model/return.model';

const item = (
  id: string,
  price: string,
  quantity: number,
  done: { cancelled?: number; returned?: number } = {},
): OrderItem => ({
  id,
  sellerOrderId: 'so',
  variantId: `v-${id}`,
  productId: `p-${id}`,
  productName: 'Thing',
  sku: 'SKU',
  attributes: [],
  unitPrice: Money.of(price),
  quantity,
  cancelledQuantity: done.cancelled ?? 0,
  returnedQuantity: done.returned ?? 0,
  lineTotal: Money.of(price).timesQuantity(quantity - (done.cancelled ?? 0)),
  imageMediaId: null,
});

const strings = (amounts: Record<string, Money>) =>
  Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, value.toString()]));

describe('returnLineProblems (spec 18 §1.2, OR-28)', () => {
  const items = [item('a', '50.00', 3, { cancelled: 1 }), item('b', '20.00', 2, { returned: 2 })];

  it('accepts lines within the kept units', () => {
    expect(returnLineProblems(items, [{ orderItemId: 'a', quantity: 2 }])).toEqual([]);
  });

  it('names every offending line: over the kept units, fully returned, foreign, listed twice, not positive', () => {
    const problems = returnLineProblems(items, [
      { orderItemId: 'a', quantity: 3 },
      { orderItemId: 'b', quantity: 1 },
      { orderItemId: 'x', quantity: 1 },
      { orderItemId: 'a', quantity: 1 },
    ]);
    expect(problems.map((p) => [p.value, p.constraint, p.message])).toEqual([
      ['a', 'returnable', 'returnable: 2'],
      ['b', 'returnable', 'returnable: 0'],
      ['x', 'part_of_seller_order', 'not an item of this seller order'],
      ['a', 'unique', 'listed twice'],
    ]);
    expect(returnLineProblems(items, [{ orderItemId: 'a', quantity: 0 }])).toHaveLength(1);
  });
});

describe('computeReturnAmounts (spec 09 §8.7, OR-27, OR-29)', () => {
  it('takes the subtotal share and reverses commission as round(before) − round(after)', () => {
    const items = [item('a', '33.33', 3), item('b', '10.05', 1)];
    // kept 109.04, rate 15 %: commission 16.36; after removing 33.33 → 75.71 → 11.36 (round 11.3565)
    const { amounts, lines } = computeReturnAmounts(
      { keptSubtotal: Money.of('109.04'), commissionRate: Rate.of('0.1500') },
      items,
      [{ orderItemId: 'a', quantity: 1 }],
    );
    expect(strings({ ...amounts })).toEqual({
      itemsSubtotal: '33.33',
      itemsPaid: '33.33',
      commissionReversed: '5.00',
      sellerNetReversed: '28.33',
      platformDiscountReversed: '0.00',
    });
    expect(
      lines.map((l) => [
        l.orderItemId,
        l.quantity,
        l.subtotal.toString(),
        l.paid.toString(),
        l.commission.toString(),
      ]),
    ).toEqual([['a', 1, '33.33', '33.33', '5.00']]);
  });

  it('splits commission per line in order-item id order, adding up to the total', () => {
    const items = [item('b', '10.05', 3), item('a', '0.15', 5)];
    const keptSubtotal = Money.of('30.90');
    const rate = Rate.of('0.1250');
    const { amounts, lines } = computeReturnAmounts({ keptSubtotal, commissionRate: rate }, items, [
      { orderItemId: 'b', quantity: 1 },
      { orderItemId: 'a', quantity: 3 },
    ]);
    expect(lines.map((l) => l.orderItemId)).toEqual(['a', 'b']);
    expect(Money.sum(lines.map((l) => l.commission)).equals(amounts.commissionReversed)).toBe(true);
    const after = keptSubtotal.minus(amounts.itemsSubtotal);
    expect(amounts.commissionReversed.equals(keptSubtotal.timesRate(rate).minus(after.timesRate(rate)))).toBe(
      true,
    );
  });

  it('several partial returns add up exactly to what was booked at delivery', () => {
    // Pseudo-random carts and return sequences (deterministic seed), each run until every unit is back.
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let run = 0; run < 200; run += 1) {
      const items = Array.from({ length: 1 + random(4) }, (_, i) =>
        item(`i${i}`, `${1 + random(500)}.${String(random(100)).padStart(2, '0')}`, 1 + random(5)),
      );
      const rate = Rate.of(`0.${String(random(3000)).padStart(4, '0')}`);
      const subtotal = Money.sum(items.map((i) => i.lineTotal));
      const commission = subtotal.timesRate(rate);
      let kept = subtotal;
      const reversed = { subtotal: Money.zero(), commission: Money.zero(), net: Money.zero() };
      while (items.some((i) => i.quantity - i.returnedQuantity > 0)) {
        const lines: ReturnLine[] = items
          .filter((i) => i.quantity - i.returnedQuantity > 0 && random(2) === 0)
          .map((i) => ({ orderItemId: i.id, quantity: 1 + random(i.quantity - i.returnedQuantity) }));
        if (lines.length === 0) continue;
        expect(returnLineProblems(items, lines)).toEqual([]);
        const { amounts } = computeReturnAmounts({ keptSubtotal: kept, commissionRate: rate }, items, lines);
        for (const line of lines) {
          const target = items.find((i) => i.id === line.orderItemId);
          if (target) target.returnedQuantity += line.quantity;
        }
        kept = kept.minus(amounts.itemsSubtotal);
        reversed.subtotal = reversed.subtotal.plus(amounts.itemsSubtotal);
        reversed.commission = reversed.commission.plus(amounts.commissionReversed);
        reversed.net = reversed.net.plus(amounts.sellerNetReversed);
      }
      expect(reversed.subtotal.toString()).toBe(subtotal.toString());
      expect(reversed.commission.toString()).toBe(commission.toString());
      expect(reversed.net.toString()).toBe(subtotal.minus(commission).toString());
    }
  });
});
