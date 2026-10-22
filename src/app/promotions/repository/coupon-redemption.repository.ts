import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { PROMOTIONS_TABLES } from '../constants';
import { RedemptionStatus } from '../enums';
import { type Redemption } from '../model/coupon.model';

const T = PROMOTIONS_TABLES.REDEMPTIONS;
const COLUMNS = [
  'id',
  'coupon_id',
  'customer_id',
  'order_id',
  'discount_total',
  'status',
  'created_at',
] as const;

interface RedemptionTable {
  id: string;
  coupon_id: string;
  customer_id: string;
  order_id: string;
  discount_total: string;
  status: RedemptionStatus;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type RedemptionRow = Pick<RedemptionTable, (typeof COLUMNS)[number]>;

function toModel(row: RedemptionRow): Redemption {
  return {
    id: row.id,
    couponId: row.coupon_id,
    customerId: row.customer_id,
    orderId: row.order_id,
    discountTotal: Money.of(row.discount_total),
    status: row.status,
    createdAt: row.created_at,
  };
}

@injectable()
export class CouponRedemptionRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** The per-customer limit (§3.1, UC-PR-2 step 2); `idx_coupon_redemptions_coupon_id_customer_id`. */
  async countActive(couponId: string, customerId: string, trx?: DbTransaction): Promise<number> {
    const row = await this.exec(trx)<RedemptionTable>(T)
      .where({ coupon_id: couponId, customer_id: customerId, status: RedemptionStatus.ACTIVE })
      .count<{ count: string }[]>({ count: '*' })
      .first();
    return Number(row?.count ?? 0);
  }

  async insert(
    redemption: { couponId: string; customerId: string; orderId: string; discountTotal: Money },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<RedemptionTable>(T).insert({
      coupon_id: redemption.couponId,
      customer_id: redemption.customerId,
      order_id: redemption.orderId,
      discount_total: redemption.discountTotal.toString(),
      status: RedemptionStatus.ACTIVE,
      released_at: null,
    });
  }

  /** UC-PR-3: the order's active redemption, locked; `null` when it has none or it was released. */
  async findActiveByOrderId(orderId: string, trx: DbTransaction): Promise<Redemption | null> {
    const row = await trx<RedemptionTable>(T)
      .select(...COLUMNS)
      .where({ order_id: orderId, status: RedemptionStatus.ACTIVE })
      .forUpdate()
      .first();
    return row ? toModel(row) : null;
  }

  async markReleased(id: string, trx: DbTransaction): Promise<void> {
    await trx<RedemptionTable>(T).where({ id }).update({
      status: RedemptionStatus.RELEASED,
      released_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
  }

  /** The admin coupon detail (spec 19 §4.3), newest first. */
  async listRecent(couponId: string, limit: number): Promise<Redemption[]> {
    const rows = (await this.db
      .knex<RedemptionTable>(T)
      .select(...COLUMNS)
      .where({ coupon_id: couponId })
      .orderBy('created_at', 'desc')
      .limit(limit)) as RedemptionRow[];
    return rows.map(toModel);
  }
}
