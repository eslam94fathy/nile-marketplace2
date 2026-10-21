import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type SellerStatus } from '../enums';
import { type SellerRepository } from '../repository/seller.repository';

export interface SellerStatusSummary {
  sellerId: string;
  status: SellerStatus;
}

/** What ordering copies onto each seller order at checkout (spec 05 §2). */
export interface SellerCheckoutSnapshot {
  sellerId: string;
  status: SellerStatus;
  businessName: string;
  /** Rate string, e.g. "0.1000" (Q-6: the rate at checkout applies). */
  commissionRate: string;
  pickup: {
    governorateId: string;
    phone: string;
    city: string;
    area: string;
    street: string;
    building: string;
    landmark: string | null;
  };
}

export interface SellerLookupOptions {
  trx: DbTransaction;
  lockShared: boolean;
}

/** A seller as other modules show it (spec 05 §8.2): the name and the rating. */
export interface SellerSummary {
  sellerId: string;
  businessName: string;
  /** "4.30"; null without published reviews. */
  ratingAvg: string | null;
  ratingCount: number;
}

/** Public API of sellers (spec 05 §2). All lookups are batched; unknown ids are left out. */
export interface ISellerDirectory {
  /**
   * Profile resolution + the "is approved" guard (catalog, ordering). With `lockShared` the row is
   * read `FOR SHARE` in the caller's `trx`: a suspension then waits for the caller's write, and its
   * consumer sees the new rows (spec 05 SE-4).
   */
  getSellerByUserId(userId: string, options?: SellerLookupOptions): Promise<SellerStatusSummary | null>;
  getStatuses(sellerIds: readonly string[]): Promise<SellerStatusSummary[]>;
  /** Display names and the rating (catalog, cart, ordering; spec 05 §8.2). */
  getSummaries(sellerIds: readonly string[]): Promise<SellerSummary[]>;
  getCheckoutSnapshots(sellerIds: readonly string[], trx: DbTransaction): Promise<SellerCheckoutSnapshot[]>;
  /** Recipient resolution for realtime and notifications (spec 05 §8.2); unknown ids are left out. */
  getUserIds(sellerIds: readonly string[]): Promise<Map<string, string>>;
  /** By user id, any seller status, for support's admin views (spec 05 §8.3); unknown ids are left out. */
  getSummariesByUserIds(
    userIds: readonly string[],
  ): Promise<Map<string, { sellerId: string; businessName: string }>>;
}

@injectable()
export class SellerDirectory implements ISellerDirectory {
  constructor(@inject(TOKENS.SellerRepository) private readonly sellers: SellerRepository) {}

  async getSellerByUserId(
    userId: string,
    options?: SellerLookupOptions,
  ): Promise<SellerStatusSummary | null> {
    const seller = await this.sellers.findByUserId(userId, options?.trx, { forShare: options?.lockShared });
    return seller ? { sellerId: seller.id, status: seller.status } : null;
  }

  async getStatuses(sellerIds: readonly string[]): Promise<SellerStatusSummary[]> {
    return (await this.sellers.findByIds(sellerIds)).map((s) => ({ sellerId: s.id, status: s.status }));
  }

  async getSummaries(sellerIds: readonly string[]): Promise<SellerSummary[]> {
    return (await this.sellers.findByIds(sellerIds)).map((s) => ({
      sellerId: s.id,
      businessName: s.businessName,
      ratingAvg: s.ratingAvg,
      ratingCount: s.ratingCount,
    }));
  }

  async getCheckoutSnapshots(
    sellerIds: readonly string[],
    trx: DbTransaction,
  ): Promise<SellerCheckoutSnapshot[]> {
    return (await this.sellers.findByIds(sellerIds, trx)).map((s) => ({
      sellerId: s.id,
      status: s.status,
      businessName: s.businessName,
      commissionRate: s.commissionRate.toString(),
      pickup: { ...s.pickup, phone: s.contactPhone },
    }));
  }

  getUserIds(sellerIds: readonly string[]): Promise<Map<string, string>> {
    return this.sellers.findUserIds(sellerIds);
  }

  async getSummariesByUserIds(
    userIds: readonly string[],
  ): Promise<Map<string, { sellerId: string; businessName: string }>> {
    const sellers = await this.sellers.findByUserIds(userIds);
    return new Map(sellers.map((s) => [s.userId, { sellerId: s.id, businessName: s.businessName }]));
  }
}
