import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money, Rate } from '../../../lib/money';
import { PROMOTIONS_TABLES } from '../constants';
import { CouponStatus, DiscountType, type CouponFunding, type CouponScope } from '../enums';
import { type Coupon, type CouponDiscount, type CouponFields, type NewCoupon } from '../model/coupon.model';

const T = PROMOTIONS_TABLES.COUPONS;
const COLUMNS = [
  'id',
  'code',
  'funding',
  'seller_id',
  'discount_type',
  'discount_value',
  'max_discount',
  'min_items_subtotal',
  'scope',
  'scope_seller_id',
  'scope_category_id',
  'starts_at',
  'ends_at',
  'global_limit',
  'per_customer_limit',
  'redemption_count',
  'status',
  'first_redeemed_at',
  'admin_blocked_at',
  'admin_block_reason',
  'created_at',
  'updated_at',
] as const;

interface CouponTable {
  id: string;
  code: string;
  funding: CouponFunding;
  seller_id: string | null;
  discount_type: DiscountType;
  /** NUMERIC(12,4) as a string: a rate, or an amount with two trailing zeros (chk_coupons_discount_value). */
  discount_value: string;
  max_discount: string | null;
  min_items_subtotal: string;
  scope: CouponScope;
  scope_seller_id: string | null;
  scope_category_id: string | null;
  starts_at: Date;
  ends_at: Date;
  global_limit: number | null;
  per_customer_limit: number;
  redemption_count: number;
  status: CouponStatus;
  first_redeemed_at: Date | null;
  admin_blocked_at: Date | null;
  admin_block_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

type CouponRow = Pick<CouponTable, (typeof COLUMNS)[number]>;

/** The scale-4 column holds a fixed amount as e.g. "25.5000"; Money takes two decimals. */
const toMoneyString = (value: string): string => value.replace(/(\.\d{2})0{2}$/, '$1');

function toDiscount(row: CouponRow): CouponDiscount {
  return row.discount_type === DiscountType.PERCENT
    ? { type: DiscountType.PERCENT, rate: Rate.of(row.discount_value) }
    : { type: DiscountType.FIXED, amount: Money.of(toMoneyString(row.discount_value)) };
}

function toModel(row: CouponRow): Coupon {
  return {
    id: row.id,
    code: row.code,
    funding: row.funding,
    sellerId: row.seller_id,
    discount: toDiscount(row),
    maxDiscount: row.max_discount === null ? null : Money.of(row.max_discount),
    minItemsSubtotal: Money.of(row.min_items_subtotal),
    scope: row.scope,
    scopeSellerId: row.scope_seller_id,
    scopeCategoryId: row.scope_category_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    globalLimit: row.global_limit,
    perCustomerLimit: row.per_customer_limit,
    redemptionCount: row.redemption_count,
    status: row.status,
    firstRedeemedAt: row.first_redeemed_at,
    adminBlockedAt: row.admin_blocked_at,
    adminBlockReason: row.admin_block_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fieldColumns(fields: Partial<CouponFields>): Partial<CouponTable> {
  const columns: Partial<CouponTable> = {};
  if (fields.discount) {
    columns.discount_type = fields.discount.type;
    columns.discount_value =
      fields.discount.type === DiscountType.PERCENT
        ? fields.discount.rate.toString()
        : fields.discount.amount.toString();
  }
  if (fields.maxDiscount !== undefined) columns.max_discount = fields.maxDiscount?.toString() ?? null;
  if (fields.minItemsSubtotal) columns.min_items_subtotal = fields.minItemsSubtotal.toString();
  if (fields.scope) columns.scope = fields.scope;
  if (fields.scopeSellerId !== undefined) columns.scope_seller_id = fields.scopeSellerId;
  if (fields.scopeCategoryId !== undefined) columns.scope_category_id = fields.scopeCategoryId;
  if (fields.startsAt) columns.starts_at = fields.startsAt;
  if (fields.endsAt) columns.ends_at = fields.endsAt;
  if (fields.globalLimit !== undefined) columns.global_limit = fields.globalLimit;
  if (fields.perCustomerLimit !== undefined) columns.per_customer_limit = fields.perCustomerLimit;
  if (fields.status) columns.status = fields.status;
  return columns;
}

@injectable()
export class CouponRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** `uq_coupons_code` decides a taken code (COUPON_CODE_TAKEN through the PG error mapper). */
  async insert(coupon: NewCoupon, trx: DbTransaction): Promise<Coupon> {
    const [row] = await trx<CouponTable>(T)
      .insert({
        code: coupon.code,
        funding: coupon.funding,
        seller_id: coupon.sellerId,
        ...fieldColumns(coupon),
        redemption_count: 0,
        first_redeemed_at: null,
        admin_blocked_at: null,
        admin_block_reason: null,
      })
      .returning<CouponRow[]>(COLUMNS);
    if (!row) throw new Error('coupons insert returned no row');
    return toModel(row);
  }

  async findById(
    id: string,
    trx?: DbTransaction,
    options: { forUpdate?: boolean } = {},
  ): Promise<Coupon | null> {
    const qb = this.exec(trx)<CouponTable>(T)
      .select(...COLUMNS)
      .where({ id });
    if (options.forUpdate) void qb.forUpdate();
    const row = await qb.first();
    return row ? toModel(row) : null;
  }

  /** Codes are stored upper-case (PR-12). */
  async findByCode(code: string, trx?: DbTransaction): Promise<Coupon | null> {
    const row = await this.exec(trx)<CouponTable>(T)
      .select(...COLUMNS)
      .where({ code })
      .first();
    return row ? toModel(row) : null;
  }

  /** Keyset page (limit + 1); `sellerId` narrows to one seller's coupons (`GET /seller/coupons`). */
  async list(query: ParsedListQuery, sellerId: string | null): Promise<Coupon[]> {
    const qb = this.db.knex<CouponTable>(T).select(...COLUMNS);
    if (sellerId !== null) void qb.where({ seller_id: sellerId });
    const rows = (await applyListQuery(qb, query, 'id')) as CouponRow[];
    return rows.map(toModel);
  }

  async update(id: string, fields: Partial<CouponFields>, trx: DbTransaction): Promise<Coupon> {
    const [row] = await trx<CouponTable>(T)
      .where({ id })
      .update({ ...fieldColumns(fields), updated_at: trx.fn.now() })
      .returning<CouponRow[]>(COLUMNS);
    if (!row) throw new Error(`coupon ${id} vanished under its lock`);
    return toModel(row);
  }

  /** PR-20: a block also makes the coupon inactive; an unblock leaves the status for the seller. */
  async setAdminBlock(
    id: string,
    block: { reason: string; at: Date } | null,
    trx: DbTransaction,
  ): Promise<Coupon> {
    const [row] = await trx<CouponTable>(T)
      .where({ id })
      .update({
        admin_blocked_at: block?.at ?? null,
        admin_block_reason: block?.reason ?? null,
        ...(block ? { status: CouponStatus.INACTIVE } : {}),
        updated_at: trx.fn.now(),
      })
      .returning<CouponRow[]>(COLUMNS);
    if (!row) throw new Error(`coupon ${id} vanished under its lock`);
    return toModel(row);
  }

  /**
   * UC-PR-2 step 1: one use, only while the coupon is redeemable now and below its global limit.
   * The coupon's per-customer limit, or `null` when no row matched (the caller re-reads to tell why).
   */
  async takeUse(id: string, trx: DbTransaction): Promise<number | null> {
    const result = await trx.raw<{ rows: { per_customer_limit: number }[] }>(
      `UPDATE ${T}
          SET redemption_count = redemption_count + 1,
              first_redeemed_at = COALESCE(first_redeemed_at, now()),
              updated_at = now()
        WHERE id = ? AND status = ? AND now() >= starts_at AND now() < ends_at
          AND (global_limit IS NULL OR redemption_count < global_limit)
        RETURNING per_customer_limit`,
      [id, CouponStatus.ACTIVE],
    );
    return result.rows[0]?.per_customer_limit ?? null;
  }

  /** UC-PR-3: gives the use back (R-18). */
  async giveUseBack(id: string, trx: DbTransaction): Promise<void> {
    const count = await trx<CouponTable>(T)
      .where({ id })
      .where('redemption_count', '>', 0)
      .update({ redemption_count: trx.raw('redemption_count - 1'), updated_at: trx.fn.now() });
    if (count !== 1) throw new Error(`coupon ${id} has no active use to give back`);
  }
}
