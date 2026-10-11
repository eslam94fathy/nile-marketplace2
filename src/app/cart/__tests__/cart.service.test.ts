import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type AppError } from '../../../lib/error';
import { type PurchasableVariant } from '../../catalog';
import { InventoryErrorCode } from '../../inventory';
import { CartErrorCode } from '../errors';
import { type CartItem } from '../model/cart-item.model';
import { CartService } from '../service/cart.service';

const TRX = {} as DbTransaction;
const MAX_LINES = 3;

interface Setup {
  existing?: CartItem | null;
  byId?: CartItem | null;
  lineCount?: number;
  purchasable?: boolean | 'unknown';
  sellable?: number;
  cartId?: string | null;
}

function setup(options: Setup = {}) {
  const carts = {
    upsertAndLock: vi.fn(() => Promise.resolve('cart-1')),
    lockByCustomerId: vi.fn(() => Promise.resolve(options.cartId === undefined ? 'cart-1' : options.cartId)),
  };
  const items = {
    findByVariantId: vi.fn(() => Promise.resolve(options.existing ?? null)),
    findById: vi.fn(() => Promise.resolve(options.byId ?? null)),
    countByCartId: vi.fn(() => Promise.resolve(options.lineCount ?? 0)),
    insert: vi.fn(() => Promise.resolve()),
    updateQuantity: vi.fn(() => Promise.resolve(options.byId ?? options.existing ?? null)),
    delete: vi.fn(() => Promise.resolve(true)),
    deleteByCartId: vi.fn(() => Promise.resolve()),
  };
  const purchasable = options.purchasable ?? true;
  const catalog = {
    getVariantsForPurchase: vi.fn(() =>
      Promise.resolve(
        purchasable === 'unknown' ? [] : [{ variantId: 'v1', purchasable } as unknown as PurchasableVariant],
      ),
    ),
  };
  const sellable = options.sellable ?? 50;
  const inventory = {
    getStockByVariantIds: vi.fn(() =>
      Promise.resolve([{ variantId: 'v1', onHand: sellable, reserved: 0, sellable }]),
    ),
  };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.CartRepository, { useValue: carts });
  container.register(TOKENS.CartItemRepository, { useValue: items });
  container.register(TOKENS.CatalogDirectory, { useValue: catalog });
  container.register(TOKENS.InventoryService, { useValue: inventory });
  container.register(TOKENS.TransactionRunner, {
    useValue: { run: <T>(work: (trx: DbTransaction) => Promise<T>) => work(TRX) },
  });
  container.register(TOKENS.Env, { useValue: { CART_MAX_LINES: MAX_LINES } });
  return { carts, items, catalog, inventory, service: container.resolve(CartService) };
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as AppError).code;
  }
  throw new Error('expected a rejection');
};

describe('CartService.addItem (spec 08 UC-CT-2)', () => {
  it('creates and locks the cart first, then inserts a new line', async () => {
    const { carts, items, service } = setup();
    await service.addItem('customer-1', 'v1', 2);
    expect(carts.upsertAndLock).toHaveBeenCalledWith('customer-1', TRX);
    expect(items.insert).toHaveBeenCalledWith('cart-1', 'v1', 2, TRX);
    expect(carts.upsertAndLock.mock.invocationCallOrder[0]).toBeLessThan(
      items.insert.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('adds to an existing line, checking the resulting quantity against stock (CT-4)', async () => {
    const existing = { id: 'i1', variantId: 'v1', quantity: 5 };
    const { items, inventory, service } = setup({ existing, sellable: 7 });
    await service.addItem('customer-1', 'v1', 2);
    expect(items.updateQuantity).toHaveBeenCalledWith('cart-1', 'i1', 7, TRX);
    expect(items.insert).not.toHaveBeenCalled();
    expect(inventory.getStockByVariantIds).toHaveBeenCalledWith(['v1'], TRX);

    expect(await codeOf(setup({ existing, sellable: 6 }).service.addItem('customer-1', 'v1', 2))).toBe(
      InventoryErrorCode.INSUFFICIENT_STOCK,
    );
  });

  it('refuses a resulting quantity over 99', async () => {
    const { service, items } = setup({
      existing: { id: 'i1', variantId: 'v1', quantity: 98 },
      sellable: 500,
    });
    expect(await codeOf(service.addItem('customer-1', 'v1', 2))).toBe(CartErrorCode.CART_ITEM_QUANTITY_LIMIT);
    expect(items.updateQuantity).not.toHaveBeenCalled();
  });

  it('refuses a new line once the cart has CART_MAX_LINES, but still adds to an existing one', async () => {
    expect(await codeOf(setup({ lineCount: MAX_LINES }).service.addItem('customer-1', 'v1', 1))).toBe(
      CartErrorCode.CART_LINE_LIMIT_REACHED,
    );
    const existing = { id: 'i1', variantId: 'v1', quantity: 1 };
    const { items, service } = setup({ lineCount: MAX_LINES, existing });
    await service.addItem('customer-1', 'v1', 1);
    expect(items.updateQuantity).toHaveBeenCalledWith('cart-1', 'i1', 2, TRX);
  });

  it.each([false, 'unknown'] as const)(
    'refuses a variant that is not purchasable (%s)',
    async (purchasable) => {
      const { items, service } = setup({ purchasable });
      expect(await codeOf(service.addItem('customer-1', 'v1', 1))).toBe(
        CartErrorCode.VARIANT_NOT_PURCHASABLE,
      );
      expect(items.insert).not.toHaveBeenCalled();
    },
  );

  it('INSUFFICIENT_STOCK names the variant and the available quantity', async () => {
    const { service } = setup({ sellable: 1 });
    await expect(service.addItem('customer-1', 'v1', 2)).rejects.toMatchObject({
      details: [{ field: 'variantId', value: 'v1', constraint: 'available', message: 'available: 1' }],
    });
  });
});

describe('CartService.changeQuantity / removeItem / clear', () => {
  const line = { id: 'i1', variantId: 'v1', quantity: 5 };

  it('sets the absolute quantity of the caller’s line', async () => {
    const { carts, items, service } = setup({ byId: line });
    await service.changeQuantity('customer-1', 'i1', 2);
    expect(carts.lockByCustomerId).toHaveBeenCalledWith('customer-1', TRX);
    expect(carts.upsertAndLock).not.toHaveBeenCalled();
    expect(items.findById).toHaveBeenCalledWith('cart-1', 'i1', TRX);
    expect(items.updateQuantity).toHaveBeenCalledWith('cart-1', 'i1', 2, TRX);
  });

  it('a missing line, or no cart at all, is CART_ITEM_NOT_FOUND', async () => {
    expect(await codeOf(setup({ byId: null }).service.changeQuantity('c', 'i1', 2))).toBe(
      CartErrorCode.CART_ITEM_NOT_FOUND,
    );
    expect(await codeOf(setup({ cartId: null }).service.changeQuantity('c', 'i1', 2))).toBe(
      CartErrorCode.CART_ITEM_NOT_FOUND,
    );
    expect(await codeOf(setup({ cartId: null }).service.removeItem('c', 'i1'))).toBe(
      CartErrorCode.CART_ITEM_NOT_FOUND,
    );
  });

  it('a non-purchasable line can’t be changed, even when decreasing (CT-4)', async () => {
    expect(await codeOf(setup({ byId: line, purchasable: false }).service.changeQuantity('c', 'i1', 1))).toBe(
      CartErrorCode.VARIANT_NOT_PURCHASABLE,
    );
  });

  it('removeItem reports a line that isn’t in the cart', async () => {
    const { items, service } = setup();
    items.delete.mockResolvedValueOnce(false);
    expect(await codeOf(service.removeItem('c', 'i1'))).toBe(CartErrorCode.CART_ITEM_NOT_FOUND);
  });

  it('clear empties the cart and is a no-op without one', async () => {
    const withCart = setup();
    await withCart.service.clear('c');
    expect(withCart.items.deleteByCartId).toHaveBeenCalledWith('cart-1', TRX);

    const noCart = setup({ cartId: null });
    await noCart.service.clear('c');
    expect(noCart.items.deleteByCartId).not.toHaveBeenCalled();
    expect(noCart.carts.upsertAndLock).not.toHaveBeenCalled();
  });
});
