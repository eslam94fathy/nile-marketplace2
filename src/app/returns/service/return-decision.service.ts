import { inject, injectable } from 'tsyringe';
import { type AuditAction, type IAuditRecorder } from '../../../lib/audit';
import { UserRole } from '../../../lib/auth';
import { type Env } from '../../../lib/config';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { MediaPurpose, type MediaService } from '../../media';
import { type ISellerDirectory } from '../../sellers';
import {
  AdminReturnDecision,
  DisputeResolution,
  PhotoUploader,
  ReturnActorRole,
  ReturnRefusalReason,
  ReturnStatus,
} from '../enums';
import {
  profileMissing,
  returnInspectionWindowClosed,
  returnInvalidStatusTransition,
  returnItemsMismatch,
  returnNotFound,
} from '../errors';
import { type ReturnActor, type ReturnRequest } from '../model/return-request.model';
import { type ReturnItemRepository } from '../repository/return-item.repository';
import { type ReturnPhotoRepository } from '../repository/return-photo.repository';
import { type ReturnOwner, type ReturnRequestRepository } from '../repository/return-request.repository';
import { type ReturnCompletionService } from './return-completion.service';
import { type ReturnLifecycleService } from './return-lifecycle.service';

/** An admin may approve or reject a request the seller hasn't answered, or an escalated one (UC-RE-3). */
const ADMIN_DECIDABLE: readonly ReturnStatus[] = [ReturnStatus.REQUESTED, ReturnStatus.ESCALATED];

/**
 * The seller's decisions (UC-RE-2, receipt UC-RE-7, dispute UC-RE-8) and the admin's (UC-RE-3, the
 * dispute resolution). Reads in other modules (order number, logistics, line snapshots) happen before
 * the transaction; the request is locked first inside it.
 */
@injectable()
export class ReturnDecisionService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'RETURN_ESCALATION_WINDOW_DAYS'>,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
    @inject(TOKENS.ReturnLifecycleService) private readonly lifecycle: ReturnLifecycleService,
    @inject(TOKENS.ReturnCompletionService) private readonly completion: ReturnCompletionService,
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
    @inject(TOKENS.ReturnItemRepository) private readonly items: ReturnItemRepository,
    @inject(TOKENS.ReturnPhotoRepository) private readonly photos: ReturnPhotoRepository,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
  ) {}

  /** The seller's id behind the account, whatever the seller's status (spec 18 UC-RE-2, Q-36). */
  async sellerIdOf(userId: string): Promise<string> {
    const seller = await this.sellers.getSellerByUserId(userId);
    if (!seller) throw profileMissing(UserRole.SELLER, userId);
    return seller.sellerId;
  }

  /** UC-RE-2 approve → UC-RE-4. A request the deadline job already approved answers 409. */
  async sellerApprove(userId: string, returnId: string): Promise<ReturnRequest> {
    const sellerId = await this.sellerIdOf(userId);
    return this.approve(
      returnId,
      { sellerId },
      [ReturnStatus.REQUESTED],
      { role: ReturnActorRole.SELLER, userId },
      null,
    );
  }

  /** UC-RE-2 reject: the customer may escalate until `escalation_deadline_at` (RE-3). */
  async sellerReject(userId: string, returnId: string, reason: string): Promise<ReturnRequest> {
    const sellerId = await this.sellerIdOf(userId);
    const { found, orderNumber } = await this.prepare(returnId, { sellerId });
    const deadline = addDuration(this.lifecycle.now(), this.env.RETURN_ESCALATION_WINDOW_DAYS, TimeUnit.DAY);
    return this.tx.run(async (trx) => {
      const locked = await this.lock(found.id, { sellerId }, trx);
      return this.lifecycle.transition(
        locked,
        [ReturnStatus.REQUESTED],
        { status: ReturnStatus.REJECTED, rejectionReason: reason, escalationDeadlineAt: deadline },
        { role: ReturnActorRole.SELLER, userId },
        reason,
        orderNumber,
        trx,
      );
    });
  }

  /**
   * UC-RE-7 by the seller: each item of the return exactly once with its restock choice, else
   * `422 RETURN_ITEMS_MISMATCH`. Allowed while the return is still `received` (RE-25).
   */
  async confirmReceipt(
    userId: string,
    returnId: string,
    choices: readonly { returnItemId: string; restock: boolean }[],
  ): Promise<ReturnRequest> {
    const sellerId = await this.sellerIdOf(userId);
    const found = await this.requests.findById(returnId, { sellerId });
    if (!found) throw returnNotFound();
    const items = await this.items.findByReturnIds([found.id]);
    const restock = new Map(choices.map((choice) => [choice.returnItemId, choice.restock]));
    if (
      restock.size !== choices.length ||
      restock.size !== items.length ||
      items.some((i) => !restock.has(i.id))
    ) {
      throw returnItemsMismatch();
    }
    const context = await this.completion.contextOf(found);
    return this.tx.run(async (trx) => {
      const locked = await this.lock(found.id, { sellerId }, trx);
      return this.completion.complete(
        locked,
        [ReturnStatus.RECEIVED],
        restock,
        { role: ReturnActorRole.SELLER, userId },
        null,
        context,
        trx,
      );
    });
  }

  /** UC-RE-8: the seller disputes a received return before its inspection deadline, with its own photos. */
  async sellerDispute(
    userId: string,
    returnId: string,
    reason: string,
    photoMediaIds: readonly string[],
  ): Promise<ReturnRequest> {
    const sellerId = await this.sellerIdOf(userId);
    const { found, orderNumber } = await this.prepare(returnId, { sellerId });
    const now = this.lifecycle.now();
    return this.tx.run(async (trx) => {
      const locked = await this.lock(found.id, { sellerId }, trx);
      if (locked.status !== ReturnStatus.RECEIVED) throw returnInvalidStatusTransition(locked.status);
      if (locked.inspectionDeadlineAt === null || now >= locked.inspectionDeadlineAt) {
        throw returnInspectionWindowClosed();
      }
      await this.media.claim(photoMediaIds, { purpose: MediaPurpose.RETURN_PHOTO, ownerUserId: userId }, trx);
      await this.photos.insertMany(locked.id, PhotoUploader.SELLER, photoMediaIds, trx);
      return this.lifecycle.transition(
        locked,
        [ReturnStatus.RECEIVED],
        { status: ReturnStatus.DISPUTED, disputeReason: reason },
        { role: ReturnActorRole.SELLER, userId },
        reason,
        orderNumber,
        trx,
      );
    });
  }

  /** UC-RE-3 admin decision, final (R-14); audited with the note as the reason. */
  async adminDecide(
    adminUserId: string,
    returnId: string,
    decision: AdminReturnDecision,
    note: string,
  ): Promise<ReturnRequest> {
    const actor = { role: ReturnActorRole.ADMIN, userId: adminUserId };
    if (decision === AdminReturnDecision.APPROVE) {
      return this.approve(returnId, {}, ADMIN_DECIDABLE, actor, note);
    }
    const { found, orderNumber } = await this.prepare(returnId, {});
    return this.tx.run(async (trx) => {
      const locked = await this.lock(found.id, {}, trx);
      const refused = await this.lifecycle.transition(
        locked,
        ADMIN_DECIDABLE,
        {
          status: ReturnStatus.REFUSED,
          refusalReason: ReturnRefusalReason.ADMIN_REJECTED,
          clearRefundPayout: true,
        },
        actor,
        note,
        orderNumber,
        trx,
      );
      await this.auditDecision('return.admin_decided', locked, refused, { reason: note }, trx);
      return refused;
    });
  }

  /**
   * UC-RE-8 by an admin, final: `refund` completes the return restocking nothing (the seller adjusts
   * stock by hand); `no_refund` refuses it (`dispute_upheld`). Audited with the note as the reason.
   */
  async adminResolveDispute(
    adminUserId: string,
    returnId: string,
    decision: DisputeResolution,
    note: string,
  ): Promise<ReturnRequest> {
    const actor = { role: ReturnActorRole.ADMIN, userId: adminUserId };
    const found = await this.requests.findById(returnId);
    if (!found) throw returnNotFound();
    const context = await this.completion.contextOf(found);
    return this.tx.run(async (trx) => {
      const locked = await this.lock(found.id, {}, trx);
      const resolved =
        decision === DisputeResolution.REFUND
          ? await this.completion.complete(
              locked,
              [ReturnStatus.DISPUTED],
              new Map(),
              actor,
              note,
              context,
              trx,
            )
          : await this.lifecycle.transition(
              locked,
              [ReturnStatus.DISPUTED],
              {
                status: ReturnStatus.REFUSED,
                refusalReason: ReturnRefusalReason.DISPUTE_UPHELD,
                clearRefundPayout: true,
              },
              actor,
              note,
              context.logistics.orderNumber,
              trx,
            );
      await this.auditDecision('return.dispute_resolved', locked, resolved, { reason: note, decision }, trx);
      return resolved;
    });
  }

  /** `requested | escalated → approved` with `return.approved` (UC-RE-4); an admin's is audited. */
  private async approve(
    returnId: string,
    owner: ReturnOwner,
    from: readonly ReturnStatus[],
    actor: ReturnActor,
    note: string | null,
  ): Promise<ReturnRequest> {
    const found = await this.requests.findById(returnId, owner);
    if (!found) throw returnNotFound();
    const logistics = await this.lifecycle.logisticsOf(found.sellerOrderId);
    return this.tx.run(async (trx) => {
      const locked = await this.lock(found.id, owner, trx);
      const approved = await this.lifecycle.approve(locked, from, actor, note, logistics, trx);
      if (actor.role === ReturnActorRole.ADMIN) {
        await this.auditDecision('return.admin_decided', locked, approved, { reason: note }, trx);
      }
      return approved;
    });
  }

  private async prepare(returnId: string, owner: ReturnOwner) {
    const found = await this.requests.findById(returnId, owner);
    if (!found) throw returnNotFound();
    return { found, orderNumber: await this.lifecycle.orderNumberOf(found.orderId) };
  }

  private async lock(returnId: string, owner: ReturnOwner, trx: DbTransaction) {
    const locked = await this.requests.lockById(returnId, trx, owner);
    if (!locked) throw returnNotFound();
    return locked;
  }

  private auditDecision(
    action: Extract<AuditAction, 'return.admin_decided' | 'return.dispute_resolved'>,
    before: ReturnRequest,
    after: ReturnRequest,
    extra: { reason: string | null; decision?: DisputeResolution },
    trx: DbTransaction,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        targetId: after.id,
        before: { status: before.status },
        after: { status: after.status, ...(extra.decision ? { decision: extra.decision } : {}) },
        reason: extra.reason,
      },
      trx,
    );
  }
}
