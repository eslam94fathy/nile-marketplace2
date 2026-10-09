import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, type OutboxEvent, SellerApproved, SellerSuspended } from '../../../lib/events';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ILogger } from '../../../lib/logger';
import { type Rate } from '../../../lib/money';
import { type IAccountService, type UserSummary } from '../../identity';
import { ADMIN_HISTORY_LIMIT } from '../constants';
import { SellerStatus } from '../enums';
import {
  commissionRateUnchanged,
  sellerEmailNotVerified,
  sellerInvalidStatusTransition,
  sellerNotFound,
} from '../errors';
import { type Seller } from '../model/seller.model';
import {
  type CommissionChangeEntry,
  type SellerCommissionHistoryRepository,
} from '../repository/seller-commission-history.repository';
import { type SellerSettings, type SellerSettingsRepository } from '../repository/seller-settings.repository';
import {
  type SellerStatusHistoryRepository,
  type StatusChangeEntry,
} from '../repository/seller-status-history.repository';
import { type SellerRepository } from '../repository/seller.repository';

export interface AdminSellerListItem {
  seller: Seller;
  email: string;
}

export interface AdminSellerDetail extends AdminSellerListItem {
  emailVerified: boolean;
  statusHistory: StatusChangeEntry[];
  commissionHistory: CommissionChangeEntry[];
}

interface Transition {
  from: SellerStatus;
  to: SellerStatus;
  actorUserId: string;
  reason: string | null;
  rejectionReason?: string | null;
  setApprovedAtIfNull?: boolean;
  event?: (seller: Seller) => OutboxEvent<object>;
}

/** Admin decisions on sellers (spec 05 UC-SE-3, §4.4). */
@injectable()
export class SellerAdminService {
  constructor(
    @inject(TOKENS.SellerRepository) private readonly sellers: SellerRepository,
    @inject(TOKENS.SellerStatusHistoryRepository)
    private readonly statusHistory: SellerStatusHistoryRepository,
    @inject(TOKENS.SellerCommissionHistoryRepository)
    private readonly commissionHistory: SellerCommissionHistoryRepository,
    @inject(TOKENS.SellerSettingsRepository) private readonly settings: SellerSettingsRepository,
    @inject(TOKENS.AccountService) private readonly accounts: IAccountService,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /** The emails come from one batched identity call (G20). */
  async list(query: ParsedListQuery): Promise<{ items: AdminSellerListItem[]; meta: PageMeta }> {
    const page = toPage(await this.sellers.list(query), query, (seller) => seller.createdAt);
    const users = await this.usersById(page.items.map((seller) => seller.userId));
    return {
      items: page.items.map((seller) => ({ seller, email: requireUser(users, seller).email })),
      meta: page.meta,
    };
  }

  async getDetail(sellerId: string): Promise<AdminSellerDetail> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw sellerNotFound();
    const [user, statusHistory, commissionHistory] = await Promise.all([
      this.userOf(seller),
      this.statusHistory.listBySeller(seller.id, ADMIN_HISTORY_LIMIT),
      this.commissionHistory.listBySeller(seller.id, ADMIN_HISTORY_LIMIT),
    ]);
    return {
      seller,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      statusHistory,
      commissionHistory,
    };
  }

  /** `pending_approval → approved`. Needs a verified email (Q-40). Clears the old rejection reason. */
  async approve(sellerId: string, actorUserId: string): Promise<AdminSellerDetail> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw sellerNotFound();
    if (seller.status !== SellerStatus.PENDING_APPROVAL) throw sellerInvalidStatusTransition();
    if ((await this.userOf(seller)).emailVerifiedAt === null) throw sellerEmailNotVerified();

    await this.transition(sellerId, {
      from: SellerStatus.PENDING_APPROVAL,
      to: SellerStatus.APPROVED,
      actorUserId,
      reason: null,
      rejectionReason: null,
      setApprovedAtIfNull: true,
      event: (s) => ({
        contract: SellerApproved,
        aggregateId: s.id,
        payload: { sellerId: s.id, userId: s.userId, previousStatus: SellerStatus.PENDING_APPROVAL },
      }),
    });
    return this.getDetail(sellerId);
  }

  /** `pending_approval → rejected`. The reason is shown to the seller until the next decision. */
  async reject(sellerId: string, reason: string, actorUserId: string): Promise<AdminSellerDetail> {
    await this.transition(sellerId, {
      from: SellerStatus.PENDING_APPROVAL,
      to: SellerStatus.REJECTED,
      actorUserId,
      reason,
      rejectionReason: reason,
    });
    return this.getDetail(sellerId);
  }

  /** `approved → suspended`. Catalog hides the products; open orders continue (Q-36). */
  async suspend(sellerId: string, reason: string, actorUserId: string): Promise<AdminSellerDetail> {
    await this.transition(sellerId, {
      from: SellerStatus.APPROVED,
      to: SellerStatus.SUSPENDED,
      actorUserId,
      reason,
      event: (s) => ({
        contract: SellerSuspended,
        aggregateId: s.id,
        payload: { sellerId: s.id, userId: s.userId, reason },
      }),
    });
    return this.getDetail(sellerId);
  }

  /** `suspended → approved`, published as `seller.approved` with `previousStatus = suspended`. */
  async reinstate(sellerId: string, reason: string | null, actorUserId: string): Promise<AdminSellerDetail> {
    await this.transition(sellerId, {
      from: SellerStatus.SUSPENDED,
      to: SellerStatus.APPROVED,
      actorUserId,
      reason,
      event: (s) => ({
        contract: SellerApproved,
        aggregateId: s.id,
        payload: { sellerId: s.id, userId: s.userId, previousStatus: SellerStatus.SUSPENDED },
      }),
    });
    return this.getDetail(sellerId);
  }

  /** New checkouts only (Q-6). The row lock makes the old/new pair in the history exact. */
  async changeCommissionRate(sellerId: string, rate: Rate, actorUserId: string): Promise<AdminSellerDetail> {
    const oldRate = await this.transactions.run(async (trx) => {
      const seller = await this.sellers.findById(sellerId, trx, { forUpdate: true });
      if (!seller) throw sellerNotFound();
      // Rate.toString() is normalised to 4 decimals, so "0.1" equals "0.1000".
      if (seller.commissionRate.toString() === rate.toString()) throw commissionRateUnchanged();
      await this.sellers.updateCommissionRate(sellerId, rate, trx);
      await this.commissionHistory.insert(
        sellerId,
        { oldRate: seller.commissionRate, newRate: rate, changedByUserId: actorUserId },
        trx,
      );
      return seller.commissionRate;
    });
    this.logger.info('seller commission rate changed', {
      event: 'SELLER_COMMISSION_RATE_CHANGED',
      sellerId,
      oldRate: oldRate.toString(),
      newRate: rate.toString(),
      actorUserId,
    });
    return this.getDetail(sellerId);
  }

  getCommissionSettings(): Promise<SellerSettings> {
    return this.settings.get();
  }

  /** Applies to sellers who register afterwards; existing sellers keep their own rate (UC-SE-3). */
  async updateDefaultCommissionRate(rate: Rate, actorUserId: string): Promise<SellerSettings> {
    const updated = await this.settings.updateDefaultCommissionRate(rate);
    this.logger.info('default commission rate changed', {
      event: 'DEFAULT_COMMISSION_RATE_CHANGED',
      defaultCommissionRate: updated.defaultCommissionRate.toString(),
      actorUserId,
    });
    return updated;
  }

  /**
   * Conditional update + history row + outbox event in one transaction (spec 05 §1).
   * 0 rows updated → SELLER_NOT_FOUND if the seller is gone, else SELLER_INVALID_STATUS_TRANSITION.
   */
  private async transition(sellerId: string, change: Transition): Promise<Seller> {
    const seller = await this.transactions.run(async (trx) => {
      const updated = await this.sellers.transitionStatus(sellerId, change.from, change.to, trx, {
        ...(change.rejectionReason !== undefined ? { rejectionReason: change.rejectionReason } : {}),
        ...(change.setApprovedAtIfNull ? { setApprovedAtIfNull: true } : {}),
      });
      if (!updated) throw await this.whyNotUpdated(sellerId, trx);
      await this.statusHistory.insert(
        sellerId,
        {
          fromStatus: change.from,
          toStatus: change.to,
          reason: change.reason,
          actorUserId: change.actorUserId,
        },
        trx,
      );
      if (change.event) await this.outbox.add(trx, change.event(updated));
      return updated;
    });
    this.logger.info('seller status changed', {
      event: 'SELLER_STATUS_CHANGED',
      sellerId,
      fromStatus: change.from,
      toStatus: change.to,
      actorUserId: change.actorUserId,
    });
    return seller;
  }

  private async whyNotUpdated(sellerId: string, trx: DbTransaction): Promise<Error> {
    return (await this.sellers.findById(sellerId, trx)) ? sellerInvalidStatusTransition() : sellerNotFound();
  }

  private async userOf(seller: Seller): Promise<UserSummary> {
    return requireUser(await this.usersById([seller.userId]), seller);
  }

  private async usersById(userIds: readonly string[]): Promise<Map<string, UserSummary>> {
    const users = await this.accounts.getUsersByIds(userIds);
    return new Map(users.map((user) => [user.id, user]));
  }
}

function requireUser(users: ReadonlyMap<string, UserSummary>, seller: Seller): UserSummary {
  const user = users.get(seller.userId);
  // sellers.user_id is a FK to users, so the user always exists.
  if (!user) throw new Error(`user ${seller.userId} of seller ${seller.id} is missing`);
  return user;
}
