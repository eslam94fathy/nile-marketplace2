import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { FINANCE_TABLES } from '../constants';
import { type SellerOrderHold } from '../model/hold.model';

const T = FINANCE_TABLES.SELLER_ORDER_HOLDS;
const COLUMNS = ['seller_order_id', 'seller_id', 'held_amount', 'release_after', 'released_at'] as const;

interface HoldTable {
  seller_order_id: string;
  seller_id: string;
  held_amount: string;
  release_after: Date;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toModel = (row: Pick<HoldTable, (typeof COLUMNS)[number]>): SellerOrderHold => ({
  sellerOrderId: row.seller_order_id,
  sellerId: row.seller_id,
  heldAmount: Money.of(row.held_amount),
  releaseAfter: row.release_after,
  releasedAt: row.released_at,
});

/** All SQL of `seller_order_holds` (spec 12 §8.1). Lock order inside finance: the hold, then the accounts. */
@injectable()
export class SellerOrderHoldRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** §8.2: the hold of a delivered seller order; a replay finds it there and changes nothing. */
  async insertIfNew(
    hold: { sellerOrderId: string; sellerId: string; heldAmount: Money; releaseAfter: Date },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<HoldTable>(T)
      .insert({
        seller_order_id: hold.sellerOrderId,
        seller_id: hold.sellerId,
        held_amount: hold.heldAmount.toString(),
        release_after: hold.releaseAfter,
        released_at: null,
      })
      .onConflict('seller_order_id')
      .ignore();
  }

  /** The hold `FOR UPDATE` (null when the seller order has none); `skipLocked` for the release job. */
  async lock(
    sellerOrderId: string,
    trx: DbTransaction,
    options: { skipLocked?: boolean } = {},
  ): Promise<SellerOrderHold | null> {
    const qb = trx<HoldTable>(T)
      .select(...COLUMNS)
      .where({ seller_order_id: sellerOrderId })
      .forUpdate();
    if (options.skipLocked) void qb.skipLocked();
    const row = await qb.first();
    return row ? toModel(row) : null;
  }

  /** FI-18: what a return took from pending leaves the hold. */
  async setHeldAmount(sellerOrderId: string, heldAmount: Money, trx: DbTransaction): Promise<void> {
    await trx<HoldTable>(T)
      .update({ held_amount: heldAmount.toString(), updated_at: trx.fn.now() })
      .where({ seller_order_id: sellerOrderId });
  }

  async markReleased(sellerOrderId: string, at: Date, trx: DbTransaction): Promise<void> {
    await trx<HoldTable>(T)
      .update({ released_at: at, updated_at: trx.fn.now() })
      .where({ seller_order_id: sellerOrderId })
      .whereNull('released_at');
  }

  /** §8.3 candidates, oldest first, read without locks: idx_seller_order_holds_release_after. */
  async findDueIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .knex<HoldTable>(T)
      .select('seller_order_id')
      .whereNull('released_at')
      .where('release_after', '<=', now)
      .orderBy('release_after')
      .limit(limit);
    return rows.map((row) => row.seller_order_id);
  }

  /**
   * `GET /seller/finance/holds`: the seller's unreleased holds, keyset page (`limit + 1` rows) over
   * idx_seller_order_holds_seller_id_release_after (D-24).
   */
  async listForSeller(sellerId: string, query: ParsedListQuery): Promise<SellerOrderHold[]> {
    const qb = this.db
      .knex<HoldTable>(T)
      .select(...COLUMNS)
      .where({ seller_id: sellerId })
      .whereNull('released_at');
    const rows = (await applyListQuery(qb, query, 'seller_order_id')) as Pick<
      HoldTable,
      (typeof COLUMNS)[number]
    >[];
    return rows.map(toModel);
  }
}
