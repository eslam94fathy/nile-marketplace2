import { describe, expect, it } from 'vitest';
import { type PurchasableVariant } from '../../catalog';
import { type StockDto } from '../../inventory';
import { type ImageView } from '../../media';
import { CartItemIssue } from '../enums';
import { type CartItem } from '../model/cart-item.model';
import {
  assembleCartView,
  availableQuantityOf,
  classifyIssue,
  type CartLookups,
  emptyCartView,
} from '../model/cart-view.model';

const variant = (
  variantId: string,
  sellerId: string,
  price: string,
  purchasable = true,
  imageMediaId: string | null = null,
): PurchasableVariant => ({
  variantId,
  productId: `product-${variantId}`,
  productName: `Product ${variantId}`,
  productSlug: `product-${variantId}`,
  sku: `SKU-${variantId}`,
  price,
  sellerId,
  attributes: [{ attribute: 'Color', value: 'Black' }],
  purchasable,
  imageMediaId,
});
const stock = (variantId: string, sellable: number): StockDto => ({
  variantId,
  onHand: sellable,
  reserved: 0,
  sellable,
});
const item = (id: string, variantId: string, quantity: number): CartItem => ({ id, variantId, quantity });

function lookups(
  variants: PurchasableVariant[],
  levels: StockDto[],
  names: Record<string, string> = { s1: 'Shop One', s2: 'Shop Two' },
  images: ImageView[] = [],
): CartLookups {
  return {
    variants: new Map(variants.map((v) => [v.variantId, v])),
    stock: new Map(levels.map((l) => [l.variantId, l])),
    businessNames: new Map(Object.entries(names)),
    images: new Map(images.map((image) => [image.id, image])),
  };
}

describe('classifyIssue (spec 08 UC-CT-1)', () => {
  it.each([
    { purchasable: true, sellable: 10, quantity: 3, issue: null },
    { purchasable: true, sellable: 3, quantity: 3, issue: null },
    { purchasable: true, sellable: 2, quantity: 3, issue: CartItemIssue.INSUFFICIENT_STOCK },
    { purchasable: true, sellable: 0, quantity: 3, issue: CartItemIssue.OUT_OF_STOCK },
    // UNAVAILABLE wins over stock problems, OUT_OF_STOCK over INSUFFICIENT_STOCK.
    { purchasable: false, sellable: 0, quantity: 3, issue: CartItemIssue.UNAVAILABLE },
    { purchasable: false, sellable: 10, quantity: 3, issue: CartItemIssue.UNAVAILABLE },
  ])('purchasable=$purchasable sellable=$sellable quantity=$quantity → $issue', (c) => {
    expect(classifyIssue(c.purchasable, c.sellable, c.quantity)).toBe(c.issue);
  });
});

describe('availableQuantityOf (CT-6)', () => {
  it('is 0 when unavailable, else min(sellable, 99), never negative', () => {
    expect(availableQuantityOf(CartItemIssue.UNAVAILABLE, 40)).toBe(0);
    expect(availableQuantityOf(null, 40)).toBe(40);
    expect(availableQuantityOf(null, 250)).toBe(99);
    expect(availableQuantityOf(CartItemIssue.OUT_OF_STOCK, 0)).toBe(0);
    expect(availableQuantityOf(CartItemIssue.OUT_OF_STOCK, -2)).toBe(0);
  });
});

describe('assembleCartView', () => {
  it('groups by seller in order of each group’s earliest line and keeps lines in cart order', () => {
    const { view } = assembleCartView(
      'cart-1',
      [item('i1', 'v1', 1), item('i2', 'v2', 1), item('i3', 'v3', 1)],
      lookups(
        [variant('v1', 's2', '10.00'), variant('v2', 's1', '20.00'), variant('v3', 's2', '30.00')],
        [stock('v1', 5), stock('v2', 5), stock('v3', 5)],
      ),
    );
    expect(view.sellers.map((g) => [g.sellerId, g.businessName, g.items.map((l) => l.id)])).toEqual([
      ['s2', 'Shop Two', ['i1', 'i3']],
      ['s1', 'Shop One', ['i2']],
    ]);
  });

  it('computes line totals with Money, and leaves issue lines out of every total', () => {
    const { view } = assembleCartView(
      'cart-1',
      [item('i1', 'v1', 3), item('i2', 'v2', 2), item('i3', 'v3', 4)],
      lookups(
        [variant('v1', 's1', '19.99'), variant('v2', 's1', '0.10'), variant('v3', 's1', '5.00')],
        [stock('v1', 10), stock('v2', 10), stock('v3', 1)],
      ),
    );
    const lines = view.sellers[0]?.items ?? [];
    expect(lines.map((l) => [l.lineTotal.toString(), l.issue])).toEqual([
      ['59.97', null],
      ['0.20', null],
      ['20.00', CartItemIssue.INSUFFICIENT_STOCK],
    ]);
    expect(lines[2]?.availableQuantity).toBe(1);
    expect(view.sellers[0]?.subtotal.toString()).toBe('60.17');
    expect(view.itemsTotal.toString()).toBe('60.17');
    expect(view.itemCount).toBe(5);
    expect(view.hasIssues).toBe(true);
  });

  it('shows a group whose lines all have issues, with a zero subtotal', () => {
    const { view } = assembleCartView(
      'cart-1',
      [item('i1', 'v1', 1), item('i2', 'v2', 2)],
      lookups(
        [variant('v1', 's1', '10.00'), variant('v2', 's2', '10.00', false)],
        [stock('v1', 5), stock('v2', 5)],
      ),
    );
    expect(view.sellers.map((g) => [g.sellerId, g.subtotal.toString()])).toEqual([
      ['s1', '10.00'],
      ['s2', '0.00'],
    ]);
    expect(view.sellers[1]?.items[0]).toMatchObject({
      issue: CartItemIssue.UNAVAILABLE,
      availableQuantity: 0,
    });
    expect(view.itemsTotal.toString()).toBe('10.00');
    expect(view.itemCount).toBe(1);
  });

  it('shows the variant image when media returned it, else null (spec 08 §8)', () => {
    const image: ImageView = {
      id: 'm1',
      urls: { thumb: 'https://cdn/t', medium: 'https://cdn/m', large: 'https://cdn/l' },
      width: 800,
      height: 600,
    };
    const { view } = assembleCartView(
      'cart-1',
      [item('i1', 'v1', 1), item('i2', 'v2', 1), item('i3', 'v3', 1)],
      lookups(
        [
          variant('v1', 's1', '10.00', true, 'm1'),
          variant('v2', 's1', '10.00'),
          // Not ready any more: left out rather than failing.
          variant('v3', 's1', '10.00', true, 'm-gone'),
        ],
        [stock('v1', 5), stock('v2', 5), stock('v3', 5)],
        undefined,
        [image],
      ),
    );
    expect(view.sellers[0]?.items.map((line) => line.image)).toEqual([image, null, null]);
  });

  it('a variant without a stock row is out of stock', () => {
    const { view } = assembleCartView(
      'cart-1',
      [item('i1', 'v1', 1)],
      lookups([variant('v1', 's1', '10.00')], []),
    );
    expect(view.sellers[0]?.items[0]?.issue).toBe(CartItemIssue.OUT_OF_STOCK);
  });

  it('returns lines with an unknown variant or seller as orphans, outside the view (CT-8)', () => {
    const { view, orphans } = assembleCartView(
      'cart-1',
      [item('i1', 'v1', 1), item('i2', 'gone', 1), item('i3', 'v3', 1)],
      lookups([variant('v1', 's1', '10.00'), variant('v3', 'unknown-seller', '10.00')], [stock('v1', 5)]),
    );
    expect(orphans.map((o) => o.id)).toEqual(['i2', 'i3']);
    expect(view.sellers.flatMap((g) => g.items.map((l) => l.id))).toEqual(['i1']);
  });

  it('the empty view has no id until the first add, and zero totals', () => {
    const empty = emptyCartView(null);
    expect(empty).toMatchObject({ id: null, sellers: [], itemCount: 0, hasIssues: false });
    expect(empty.itemsTotal.toString()).toBe('0.00');
  });
});
