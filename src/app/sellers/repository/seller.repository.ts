import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Rate } from '../../../lib/money';
import { SELLERS_TABLES } from '../constants';
import { type SellerStatus } from '../enums';
import { type PickupAddress, Seller } from '../model/seller.model';

const T = SELLERS_TABLES.SELLERS;
const COLUMNS = [
  'id',
  'user_id',
  'business_name',
  'contact_phone',
  'pickup_governorate_id',
  'pickup_city',
  'pickup_area',
  'pickup_street',
  'pickup_building',
  'pickup_landmark',
  'status',
  'commission_rate',
  'rejection_reason',
  'approved_at',
  'rating_count',
  'rating_avg',
  'created_at',
  'updated_at',
] as const;

interface SellerRow {
  id: string;
  user_id: string;
  business_name: string;
  contact_phone: string;
  pickup_governorate_id: string;
  pickup_city: string;
  pickup_area: string;
  pickup_street: string;
  pickup_building: string;
  pickup_landmark: string | null;
  status: SellerStatus;
  /** NUMERIC comes back from pg as a string. */
  commission_rate: string;
  rejection_reason: string | null;
  approved_at: Date | null;
  rating_count: number;
  /** NUMERIC comes back from pg as a string; null until the first published review. */
  rating_avg: string | null;
  /** BIGINT comes back from pg as a string. */
  rating_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface NewSeller {
  userId: string;
  businessName: string;
  contactPhone: string;
  pickup: PickupAddress;
  status: SellerStatus;
  commissionRate: Rate;
}

export type SellerProfilePatch = Partial<Pick<NewSeller, 'businessName' | 'contactPhone' | 'pickup'>>;

export interface FindOptions {
  /** `SELECT … FOR UPDATE` (requires `trx`). */
  forUpdate?: boolean;
}

function toModel(row: Pick<SellerRow, (typeof COLUMNS)[number]>): Seller {
  return new Seller({
    id: row.id,
    userId: row.user_id,
    businessName: row.business_name,
    contactPhone: row.contact_phone,
    pickup: {
      governorateId: row.pickup_governorate_id,
      city: row.pickup_city,
      area: row.pickup_area,
      street: row.pickup_street,
      building: row.pickup_building,
      landmark: row.pickup_landmark,
    },
    status: row.status,
    commissionRate: Rate.of(row.commission_rate),
    rejectionReason: row.rejection_reason,
    approvedAt: row.approved_at,
    ratingCount: row.rating_count,
    ratingAvg: row.rating_avg,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function pickupColumns(pickup: PickupAddress): Partial<SellerRow> {
  return {
    pickup_governorate_id: pickup.governorateId,
    pickup_city: pickup.city,
    pickup_area: pickup.area,
    pickup_street: pickup.street,
    pickup_building: pickup.building,
    pickup_landmark: pickup.landmark,
  };
}

@injectable()
export class SellerRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async findById(id: string, trx?: DbTransaction, options: FindOptions = {}): Promise<Seller | undefined> {
    const query = this.exec(trx)<SellerRow>(T)
      .select(...COLUMNS)
      .where({ id })
      .first();
    if (options.forUpdate) void query.forUpdate();
    const row = await query;
    return row ? toModel(row) : undefined;
  }

  /** `forShare`: `SELECT … FOR SHARE` (requires `trx`), so a status change waits for the caller (SE-4). */
  async findByUserId(
    userId: string,
    trx?: DbTransaction,
    options: { forShare?: boolean } = {},
  ): Promise<Seller | undefined> {
    const query = this.exec(trx)<SellerRow>(T)
      .select(...COLUMNS)
      .where({ user_id: userId });
    if (options.forShare) void query.forShare();
    const row = await query.first();
    return row ? toModel(row) : undefined;
  }

  /** Batched lookup for other modules (no N+1, G20). Unknown ids are left out. */
  /** Profile id → user id, one batched query on the primary key; unknown ids are left out. */
  async findUserIds(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .knex<{ id: string; user_id: string }>(T)
      .select('id', 'user_id')
      .whereIn('id', [...new Set(ids)]);
    return new Map(rows.map((row) => [row.id, row.user_id]));
  }

  /** Batched lookup by user id (support admin views, spec 05 §8.3); unknown ids are left out. */
  async findByUserIds(userIds: readonly string[]): Promise<Seller[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .knex<SellerRow>(T)
      .select(...COLUMNS)
      .whereIn('user_id', [...new Set(userIds)]);
    return rows.map(toModel);
  }

  async findByIds(ids: readonly string[], trx?: DbTransaction): Promise<Seller[]> {
    if (ids.length === 0) return [];
    const rows = await this.exec(trx)<SellerRow>(T)
      .select(...COLUMNS)
      .whereIn('id', [...new Set(ids)]);
    return rows.map(toModel);
  }

  async insert(seller: NewSeller, trx: DbTransaction): Promise<Seller> {
    const [row] = await trx<SellerRow>(T)
      .insert({
        user_id: seller.userId,
        business_name: seller.businessName,
        contact_phone: seller.contactPhone,
        ...pickupColumns(seller.pickup),
        status: seller.status,
        commission_rate: seller.commissionRate.toString(),
        // No reviews yet; the rating projection fills them (spec 05 §8.1, no DB defaults, G13).
        rating_count: 0,
        rating_avg: null,
        rating_version: '0',
      })
      .returning(COLUMNS);
    if (!row) throw new Error('sellers insert returned no row');
    return toModel(row);
  }

  /** Profile edit, allowed in any status (UC-SE-2). The pickup address is replaced as a whole. */
  async updateProfile(
    id: string,
    patch: SellerProfilePatch,
    trx?: DbTransaction,
  ): Promise<Seller | undefined> {
    const executor = this.exec(trx);
    const [row] = await executor<SellerRow>(T)
      .where({ id })
      .update({
        ...(patch.businessName !== undefined ? { business_name: patch.businessName } : {}),
        ...(patch.contactPhone !== undefined ? { contact_phone: patch.contactPhone } : {}),
        ...(patch.pickup !== undefined ? pickupColumns(patch.pickup) : {}),
        updated_at: executor.fn.now(),
      })
      .returning(COLUMNS);
    return row ? toModel(row) : undefined;
  }

  /**
   * Conditional status change (no read-then-write race, CLAUDE.md §6.4). Returns the updated seller,
   * or undefined if its status wasn't `from` (or it doesn't exist).
   */
  async transitionStatus(
    id: string,
    from: SellerStatus,
    to: SellerStatus,
    trx: DbTransaction,
    /** `rejectionReason: null` clears it; `setApprovedAtIfNull` stamps the first approval only. */
    extra: { rejectionReason?: string | null; setApprovedAtIfNull?: boolean } = {},
  ): Promise<Seller | undefined> {
    const [row] = await trx<SellerRow>(T)
      .where({ id, status: from })
      .update({
        status: to,
        ...(extra.rejectionReason !== undefined ? { rejection_reason: extra.rejectionReason } : {}),
        ...(extra.setApprovedAtIfNull ? { approved_at: trx.raw('COALESCE(approved_at, now())') } : {}),
        updated_at: trx.fn.now(),
      })
      .returning(COLUMNS);
    return row ? toModel(row) : undefined;
  }

  async updateCommissionRate(id: string, rate: Rate, trx: DbTransaction): Promise<Seller | undefined> {
    const [row] = await trx<SellerRow>(T)
      .where({ id })
      .update({ commission_rate: rate.toString(), updated_at: trx.fn.now() })
      .returning(COLUMNS);
    return row ? toModel(row) : undefined;
  }

  /**
   * One page of the admin list (spec 05 §4.4). Filters and sort come from the endpoint whitelist.
   * Returns `limit + 1` rows at most (`toPage` trims and builds the cursor).
   */
  async list(query: ParsedListQuery, trx?: DbTransaction): Promise<Seller[]> {
    const qb = this.exec(trx)<SellerRow>(T).select(...COLUMNS);
    const rows = (await applyListQuery(qb, query, 'id')) as SellerRow[];
    return rows.map(toModel);
  }

  /**
   * The rating projection (spec 05 §8.1): applied only when newer than the stored version, so an older
   * or duplicate `review.rating_changed` changes nothing. False when it was not newer.
   */
  async applyRating(
    id: string,
    rating: { ratingCount: number; ratingAvg: string | null; version: number },
    trx: DbTransaction,
  ): Promise<boolean> {
    const updated = await trx<SellerRow>(T)
      .where({ id })
      .andWhere('rating_version', '<', rating.version)
      .update({
        rating_count: rating.ratingCount,
        rating_avg: rating.ratingAvg,
        rating_version: String(rating.version),
        updated_at: trx.fn.now(),
      });
    return updated > 0;
  }
}
