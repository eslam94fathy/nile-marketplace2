import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, CouponBlocked } from '../../../lib/events';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ICatalogDirectory } from '../../catalog';
import { type ISellerDirectory, SellerStatus, sellerNotApproved } from '../../sellers';
import { COUPON_LIMITS } from '../constants';
import { CouponFunding, CouponScope, CouponStatus, DiscountType } from '../enums';
import {
  couponBlocked,
  couponBlockInvalidStatus,
  couponInvalid,
  couponLocked,
  couponNotFound,
  couponSellerFunded,
  scopeCategoryNotFound,
  scopeSellerNotFound,
} from '../errors';
import { type Coupon, type Redemption } from '../model/coupon.model';
import {
  auditValuesOf,
  changedFields,
  couponDraftProblems,
  type CouponDraft,
  draftOf,
  fieldsOf,
  lockedChanges,
} from '../model/coupon-rules.model';
import { type CouponRedemptionRepository } from '../repository/coupon-redemption.repository';
import { type CouponRepository } from '../repository/coupon.repository';

/** `CreateCouponDto` as plain values (spec 19 §4); dates already parsed. */
export interface CouponCreateInput {
  code: string;
  discountType: DiscountType;
  discountValue: string;
  maxDiscount?: string | null;
  minItemsSubtotal: string;
  scope: CouponScope;
  /** Admin only (a seller's coupon always covers its own products). */
  scopeSellerId?: string;
  scopeCategoryId?: string;
  startsAt: Date;
  endsAt: Date;
  globalLimit?: number | null;
  perCustomerLimit: number;
}

/** A patch: the create fields except `code`, all optional, plus `status`; `null` clears a scope id. */
export type CouponPatchInput = Partial<
  Omit<CouponCreateInput, 'code' | 'scopeSellerId' | 'scopeCategoryId'>
> & {
  status?: CouponStatus;
  scopeSellerId?: string | null;
  scopeCategoryId?: string | null;
};

/**
 * Coupon management (spec 19 UC-PR-4, PR-13, PR-17, PR-20): sellers write their own seller-funded
 * coupons, admins the platform-funded ones, and admins block or unblock seller coupons. Every write locks
 * the coupon row; admin writes are audited in the same transaction (spec 20 §2, BO-27).
 */
@injectable()
export class CouponManagementService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
    @inject(TOKENS.CouponRepository) private readonly coupons: CouponRepository,
    @inject(TOKENS.CouponRedemptionRepository) private readonly redemptions: CouponRedemptionRepository,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.CatalogDirectory) private readonly catalog: ICatalogDirectory,
  ) {}

  /* ---------- seller (spec 19 §4.2) ---------- */

  createForSeller(userId: string, input: CouponCreateInput): Promise<Coupon> {
    return this.tx.run(async (trx) => {
      const sellerId = await this.approvedSellerId(userId, trx);
      const draft = createDraft({ ...input, scopeSellerId: sellerId });
      await this.check(draft, {
        funding: CouponFunding.SELLER,
        sellerId,
        endsAtChanged: true,
        redemptionCount: 0,
      });
      return this.coupons.insert(
        { code: input.code, funding: CouponFunding.SELLER, sellerId, ...fieldsOf(draft) },
        trx,
      );
    });
  }

  async listForSeller(userId: string, query: ParsedListQuery): Promise<{ items: Coupon[]; meta: PageMeta }> {
    const sellerId = await this.sellerId(userId);
    return toPage(await this.coupons.list(query, sellerId), query, (c) => c.createdAt);
  }

  async getForSeller(userId: string, couponId: string): Promise<Coupon> {
    const sellerId = await this.sellerId(userId);
    const coupon = await this.coupons.findById(couponId);
    if (!coupon || coupon.sellerId !== sellerId) throw couponNotFound();
    return coupon;
  }

  updateForSeller(userId: string, couponId: string, patch: CouponPatchInput): Promise<Coupon> {
    return this.tx.run(async (trx) => {
      const sellerId = await this.approvedSellerId(userId, trx);
      const coupon = await this.coupons.findById(couponId, trx, { forUpdate: true });
      if (!coupon || coupon.sellerId !== sellerId) throw couponNotFound();
      const { next, changed } = mergePatch(coupon, { ...patch, scopeSellerId: sellerId });
      if (coupon.adminBlockedAt && changed.includes('status') && next.status === CouponStatus.ACTIVE) {
        throw couponBlocked();
      }
      return this.applyPatch(coupon, next, changed, trx);
    });
  }

  /* ---------- admin (spec 19 §4.3) ---------- */

  createForAdmin(input: CouponCreateInput): Promise<Coupon> {
    return this.tx.run(async (trx) => {
      const draft = createDraft(input);
      await this.check(draft, {
        funding: CouponFunding.PLATFORM,
        sellerId: null,
        endsAtChanged: true,
        redemptionCount: 0,
      });
      const coupon = await this.coupons.insert(
        { code: input.code, funding: CouponFunding.PLATFORM, sellerId: null, ...fieldsOf(draft) },
        trx,
      );
      await this.audit.record(
        { action: 'coupon.created', targetId: coupon.id, after: auditValuesOf(coupon) },
        trx,
      );
      return coupon;
    });
  }

  async listForAdmin(query: ParsedListQuery): Promise<{ items: Coupon[]; meta: PageMeta }> {
    return toPage(await this.coupons.list(query, null), query, (c) => c.createdAt);
  }

  async getForAdmin(couponId: string): Promise<{ coupon: Coupon; redemptions: Redemption[] }> {
    const coupon = await this.coupons.findById(couponId);
    if (!coupon) throw couponNotFound();
    return {
      coupon,
      redemptions: await this.redemptions.listRecent(couponId, COUPON_LIMITS.RECENT_REDEMPTIONS),
    };
  }

  /** Platform coupons only: a seller's coupon is blocked or unblocked instead (PR-20). */
  updateForAdmin(couponId: string, patch: CouponPatchInput): Promise<Coupon> {
    return this.tx.run(async (trx) => {
      const coupon = await this.coupons.findById(couponId, trx, { forUpdate: true });
      if (!coupon) throw couponNotFound();
      if (coupon.funding === CouponFunding.SELLER) throw couponSellerFunded();
      const { next, changed } = mergePatch(coupon, patch);
      const updated = await this.applyPatch(coupon, next, changed, trx);
      if (changed.length > 0) {
        await this.audit.record(
          {
            action: 'coupon.updated',
            targetId: coupon.id,
            before: auditValuesOf(coupon),
            after: auditValuesOf(updated),
          },
          trx,
        );
      }
      return updated;
    });
  }

  /** PR-20: the coupon becomes inactive and the seller can't switch it back on; the seller is told. */
  block(couponId: string, reason: string): Promise<Coupon> {
    return this.tx.run(async (trx) => {
      const coupon = await this.coupons.findById(couponId, trx, { forUpdate: true });
      if (!coupon) throw couponNotFound();
      if (coupon.funding !== CouponFunding.SELLER || coupon.sellerId === null || coupon.adminBlockedAt) {
        throw couponBlockInvalidStatus();
      }
      const at = this.clock.now();
      const blocked = await this.coupons.setAdminBlock(coupon.id, { reason, at }, trx);
      await this.outbox.add(trx, {
        contract: CouponBlocked,
        aggregateId: coupon.id,
        payload: { couponId: coupon.id, sellerId: coupon.sellerId, at: at.toISOString() },
      });
      await this.audit.record(
        {
          action: 'coupon.blocked',
          targetId: coupon.id,
          before: { status: coupon.status, adminBlocked: false },
          after: { status: blocked.status, adminBlocked: true },
          reason,
        },
        trx,
      );
      return blocked;
    });
  }

  /** Clears the block and leaves the coupon inactive for the seller to re-activate (PR-20). */
  unblock(couponId: string): Promise<Coupon> {
    return this.tx.run(async (trx) => {
      const coupon = await this.coupons.findById(couponId, trx, { forUpdate: true });
      if (!coupon) throw couponNotFound();
      if (!coupon.adminBlockedAt) throw couponBlockInvalidStatus();
      const unblocked = await this.coupons.setAdminBlock(coupon.id, null, trx);
      await this.audit.record(
        {
          action: 'coupon.unblocked',
          targetId: coupon.id,
          before: { adminBlocked: true },
          after: { adminBlocked: false },
        },
        trx,
      );
      return unblocked;
    });
  }

  /* ---------- shared ---------- */

  /** PR-8, PR-14: after the first redemption only endsAt, globalLimit and status may change. */
  private async applyPatch(
    coupon: Coupon,
    next: CouponDraft,
    changed: readonly (keyof CouponDraft)[],
    trx: DbTransaction,
  ): Promise<Coupon> {
    if (changed.length === 0) return coupon;
    if (coupon.firstRedeemedAt) {
      const locked = lockedChanges(changed);
      if (locked.length > 0) throw couponLocked(locked);
    }
    await this.check(next, {
      funding: coupon.funding,
      sellerId: coupon.sellerId,
      endsAtChanged: changed.includes('endsAt'),
      redemptionCount: coupon.redemptionCount,
      references: {
        category: changed.includes('scopeCategoryId'),
        seller: changed.includes('scopeSellerId'),
      },
    });
    return this.coupons.update(coupon.id, fieldsOf(next), trx);
  }

  /** The cross-field rules, then the referenced category and seller (422s, spec 19 §4). */
  private async check(
    draft: CouponDraft,
    context: {
      funding: CouponFunding;
      sellerId: string | null;
      endsAtChanged: boolean;
      redemptionCount: number;
      references?: { category: boolean; seller: boolean };
    },
  ): Promise<void> {
    const problems = couponDraftProblems(draft, { ...context, now: this.clock.now() });
    if (problems.length > 0) throw couponInvalid(problems);
    const references = context.references ?? { category: true, seller: true };
    if (references.category && draft.scopeCategoryId !== null) {
      if ((await this.catalog.getCategorySubtreeIds(draft.scopeCategoryId)).length === 0) {
        throw scopeCategoryNotFound();
      }
    }
    // A platform coupon may target any existing seller, whatever its status (its quote then decides).
    if (references.seller && context.funding === CouponFunding.PLATFORM && draft.scopeSellerId !== null) {
      if ((await this.sellers.getStatuses([draft.scopeSellerId])).length === 0) throw scopeSellerNotFound();
    }
  }

  /** Every seller write (SE-4): approved, read `FOR SHARE` in the write transaction. */
  private async approvedSellerId(userId: string, trx: DbTransaction): Promise<string> {
    const seller = await this.sellers.getSellerByUserId(userId, { trx, lockShared: true });
    if (seller?.status !== SellerStatus.APPROVED) throw sellerNotApproved();
    return seller.sellerId;
  }

  /** Seller reads work in any status (PR-17). */
  private async sellerId(userId: string): Promise<string> {
    const seller = await this.sellers.getSellerByUserId(userId);
    if (!seller) throw sellerNotApproved();
    return seller.sellerId;
  }
}

function createDraft(input: CouponCreateInput): CouponDraft {
  return {
    discountType: input.discountType,
    discountValue: input.discountValue,
    maxDiscount: input.maxDiscount ?? null,
    minItemsSubtotal: input.minItemsSubtotal,
    scope: input.scope,
    scopeSellerId: input.scopeSellerId ?? null,
    scopeCategoryId: input.scopeCategoryId ?? null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    globalLimit: input.globalLimit ?? null,
    perCustomerLimit: input.perCustomerLimit,
    status: CouponStatus.ACTIVE,
  };
}

/**
 * The coupon after the patch. A patch that changes `scope` drops the ids it doesn't send (they belong
 * to the old scope); one that makes the coupon fixed drops `maxDiscount` unless it sends one.
 */
function mergePatch(
  coupon: Coupon,
  patch: CouponPatchInput,
): { next: CouponDraft; changed: (keyof CouponDraft)[] } {
  const current = draftOf(coupon);
  const scopeChanges = patch.scope !== undefined && patch.scope !== current.scope;
  const becomesFixed =
    patch.discountType === DiscountType.FIXED && current.discountType !== DiscountType.FIXED;
  const next: CouponDraft = {
    discountType: patch.discountType ?? current.discountType,
    discountValue: patch.discountValue ?? current.discountValue,
    maxDiscount:
      patch.maxDiscount !== undefined ? patch.maxDiscount : becomesFixed ? null : current.maxDiscount,
    minItemsSubtotal: patch.minItemsSubtotal ?? current.minItemsSubtotal,
    scope: patch.scope ?? current.scope,
    scopeSellerId:
      patch.scopeSellerId !== undefined
        ? patch.scopeSellerId
        : scopeChanges && coupon.funding === CouponFunding.PLATFORM
          ? null
          : current.scopeSellerId,
    scopeCategoryId:
      patch.scopeCategoryId !== undefined
        ? patch.scopeCategoryId
        : scopeChanges
          ? null
          : current.scopeCategoryId,
    startsAt: patch.startsAt ?? current.startsAt,
    endsAt: patch.endsAt ?? current.endsAt,
    globalLimit: patch.globalLimit !== undefined ? patch.globalLimit : current.globalLimit,
    perCustomerLimit: patch.perCustomerLimit ?? current.perCustomerLimit,
    status: patch.status ?? current.status,
  };
  return { next, changed: changedFields(current, next) };
}
