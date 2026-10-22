import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ICatalogDirectory, type ProductCard } from '../../catalog';
import { productNotFound, wishlistLimitReached } from '../errors';
import { type CustomerRepository } from '../repository/customer.repository';
import { type WishlistItem, type WishlistRepository } from '../repository/wishlist.repository';

export interface WishlistItemView {
  item: WishlistItem;
  /** Undefined only if catalog lost the product, which never happens (products are soft-deleted). */
  product: ProductCard | undefined;
}

/** The wishlist (spec 04 §8, R-12): products, not variants. */
@injectable()
export class WishlistService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'WISHLIST_MAX_ITEMS'>,
    @inject(TOKENS.CustomerRepository) private readonly customers: CustomerRepository,
    @inject(TOKENS.WishlistRepository) private readonly wishlist: WishlistRepository,
    @inject(TOKENS.CatalogDirectory) private readonly catalog: ICatalogDirectory,
  ) {}

  /**
   * UC-CU-3. Only a publicly visible product can be added (else 422 PRODUCT_NOT_FOUND). The customer
   * row is locked, so parallel adds can't pass the limit together (C-2 pattern); adding a product that
   * is already there is fine even at the limit.
   */
  async add(customerId: string, productId: string): Promise<void> {
    const card = (await this.catalog.getProductCards([productId])).get(productId);
    if (!card?.available) throw productNotFound();
    await this.tx.run(async (trx) => {
      if (!(await this.customers.lockById(customerId, trx))) {
        throw new Error(`customer ${customerId} is missing`);
      }
      if (await this.wishlist.contains(customerId, productId, trx)) return;
      if ((await this.wishlist.count(customerId, trx)) >= this.env.WISHLIST_MAX_ITEMS) {
        throw wishlistLimitReached(this.env.WISHLIST_MAX_ITEMS);
      }
      await this.wishlist.add(customerId, productId, trx);
    });
  }

  /** UC-CU-4: `204` whether or not it was there. */
  remove(customerId: string, productId: string): Promise<void> {
    return this.wishlist.remove(customerId, productId);
  }

  /**
   * UC-CU-5: newest first, one product-card call per page (no N+1). A product that stopped being
   * visible stays, with `available: false`, and still counts toward the limit (WL-2).
   */
  async list(
    customerId: string,
    query: ParsedListQuery,
  ): Promise<{ items: WishlistItemView[]; meta: PageMeta }> {
    const page = toPage(await this.wishlist.list(customerId, query), query, (item) => item.addedAt);
    const cards = await this.catalog.getProductCards(page.items.map((item) => item.productId));
    return {
      items: page.items.map((item) => ({ item, product: cards.get(item.productId) })),
      meta: page.meta,
    };
  }

  productIds(customerId: string): Promise<string[]> {
    return this.wishlist.productIds(customerId);
  }
}
