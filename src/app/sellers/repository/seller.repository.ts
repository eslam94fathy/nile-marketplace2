import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
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

function toModel(row: SellerRow): Seller {
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

  async findByUserId(userId: string, trx?: DbTransaction): Promise<Seller | undefined> {
    const row = await this.exec(trx)<SellerRow>(T)
      .select(...COLUMNS)
      .where({ user_id: userId })
      .first();
    return row ? toModel(row) : undefined;
  }

  /** Batched lookup for other modules (no N+1, G20). Unknown ids are left out. */
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
    extra: { rejectionReason?: string; setApprovedAtIfNull?: boolean } = {},
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
}
