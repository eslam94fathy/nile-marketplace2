import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ICartDirectory } from '../../src/app/cart';
import { type CartRepository } from '../../src/app/cart/repository/cart.repository';
import { type ITransactionRunner } from '../../src/lib/db';
import { TOKENS } from '../../src/lib/di';
import { cartFixtures } from '../helpers/cart-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

/** Time a blocked transaction is given to prove it is still waiting on the cart row lock. */
const LOCK_WAIT_PROBE_MS = 300;

describe('cart public API and cart row lock (spec 08 §2, CT-2, real Postgres)', () => {
  let t: TestApp;
  let directory: ICartDirectory;
  let carts: CartRepository;
  let tx: ITransactionRunner;
  let fx: ReturnType<typeof cartFixtures>;

  const knex = () => t.infra.db.knex;
  const countCarts = async (customerId: string) =>
    Number(
      (await knex()('carts').where({ customer_id: customerId }).count<{ count: string }[]>('*'))[0]?.count,
    );
  /** A customer with a cart holding `quantities.length` lines, added in that order. */
  const customerWithLines = async (...quantities: number[]) => {
    const { customerId } = await fx.insertCustomer();
    const cartId = await fx.insertCart(customerId);
    const variantIds: string[] = [];
    for (const quantity of quantities) {
      const { variantId } = await fx.insertVariantChain();
      await fx.insertCartItem(cartId, variantId, quantity);
      variantIds.push(variantId);
    }
    return { customerId, cartId, variantIds };
  };

  beforeAll(async () => {
    t = await startTestApp();
    directory = t.container.resolve<ICartDirectory>(TOKENS.CartDirectory);
    carts = t.container.resolve<CartRepository>(TOKENS.CartRepository);
    tx = t.container.resolve<ITransactionRunner>(TOKENS.TransactionRunner);
    fx = cartFixtures(knex());
  });
  afterAll(async () => {
    await t.close();
  });

  it('getLinesForCheckout returns the lines in the order they were added, and [] with no cart', async () => {
    const { customerId, variantIds } = await customerWithLines(2, 5, 1);
    expect(await tx.run((trx) => directory.getLinesForCheckout(customerId, trx))).toEqual([
      { variantId: variantIds[0], quantity: 2 },
      { variantId: variantIds[1], quantity: 5 },
      { variantId: variantIds[2], quantity: 1 },
    ]);

    const { customerId: noCart } = await fx.insertCustomer();
    expect(await tx.run((trx) => directory.getLinesForCheckout(noCart, trx))).toEqual([]);
    expect(await countCarts(noCart)).toBe(0);
  });

  it('getLinesForCheckout blocks a second transaction on the same cart until the first commits', async () => {
    const { customerId, cartId } = await customerWithLines(1);
    const { variantId: added } = await fx.insertVariantChain();
    let releaseFirst: () => void = () => undefined;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });

    const first = tx.run(async (trx) => {
      await directory.getLinesForCheckout(customerId, trx);
      firstLocked();
      await firstHolds;
      await trx('cart_items').insert({ cart_id: cartId, variant_id: added, quantity: 3 });
    });
    await locked;

    let secondDone = false;
    const second = tx
      .run((trx) => directory.getLinesForCheckout(customerId, trx))
      .finally(() => {
        secondDone = true;
      });
    await delay(LOCK_WAIT_PROBE_MS);
    expect(secondDone).toBe(false);

    releaseFirst();
    await first;
    // The second checkout sees what the first committed.
    expect(await second).toHaveLength(2);
  });

  it('clear deletes every line inside the caller transaction and rolls back with it', async () => {
    const { customerId, cartId } = await customerWithLines(1, 2);
    const lines = () => knex()('cart_items').where({ cart_id: cartId }).select('id');

    await expect(
      tx.run(async (trx) => {
        await directory.clear(customerId, trx);
        expect(await trx('cart_items').where({ cart_id: cartId }).select('id')).toEqual([]);
        throw new Error('checkout failed later');
      }),
    ).rejects.toThrow('checkout failed later');
    expect(await lines()).toHaveLength(2);

    await tx.run((trx) => directory.clear(customerId, trx));
    expect(await lines()).toEqual([]);
    // The cart row stays; only its lines go.
    expect(await countCarts(customerId)).toBe(1);

    const { customerId: noCart } = await fx.insertCustomer();
    await tx.run((trx) => directory.clear(noCart, trx));
    expect(await countCarts(noCart)).toBe(0);
  });

  it('upsertAndLock: two parallel first adds create one cart', async () => {
    const { customerId } = await fx.insertCustomer();
    const ids = await Promise.all([
      tx.run((trx) => carts.upsertAndLock(customerId, trx)),
      tx.run((trx) => carts.upsertAndLock(customerId, trx)),
    ]);
    expect(ids[0]).toBe(ids[1]);
    expect(await countCarts(customerId)).toBe(1);
  });
});
