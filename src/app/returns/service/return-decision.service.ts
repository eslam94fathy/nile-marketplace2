import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { UserRole } from '../../../lib/auth';
import { type Env } from '../../../lib/config';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { type ISellerDirectory } from '../../sellers';
import { AdminReturnDecision, ReturnActorRole, ReturnRefusalReason, ReturnStatus } from '../enums';
import { profileMissing, returnNotFound } from '../errors';
import { type ReturnActor, type ReturnRequest } from '../model/return-request.model';
import { type ReturnOwner, type ReturnRequestRepository } from '../repository/return-request.repository';
import { type ReturnLifecycleService } from './return-lifecycle.service';

/** An admin may approve or reject a request the seller hasn't answered, or an escalated one (UC-RE-3). */
const ADMIN_DECIDABLE: readonly ReturnStatus[] = [ReturnStatus.REQUESTED, ReturnStatus.ESCALATED];

/**
 * The seller's decision (UC-RE-2) and the admin's (UC-RE-3), both leading to UC-RE-4 on approval. The
 * logistics snapshots and the order number are read before the transaction; the request is locked
 * first inside it.
 */
@injectable()
export class ReturnDecisionService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'RETURN_ESCALATION_WINDOW_DAYS'>,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
    @inject(TOKENS.ReturnLifecycleService) private readonly lifecycle: ReturnLifecycleService,
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
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
      await this.auditDecision(locked, refused, note, trx);
      return refused;
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
    const { found, orderNumber } = await this.prepare(returnId, owner);
    const logistics = await this.lifecycle.logisticsOf(found.sellerOrderId);
    const now = this.lifecycle.now();
    return this.tx.run(async (trx) => {
      const locked = await this.lock(found.id, owner, trx);
      const approved = await this.lifecycle.transition(
        locked,
        from,
        { status: ReturnStatus.APPROVED, approvedAt: now },
        actor,
        note,
        orderNumber,
        trx,
      );
      await this.lifecycle.approved(approved, logistics, trx);
      if (actor.role === ReturnActorRole.ADMIN) await this.auditDecision(locked, approved, note, trx);
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
    before: ReturnRequest,
    after: ReturnRequest,
    note: string | null,
    trx: DbTransaction,
  ): Promise<void> {
    return this.audit.record(
      {
        action: 'return.admin_decided',
        targetId: after.id,
        before: { status: before.status },
        after: { status: after.status },
        reason: note,
      },
      trx,
    );
  }
}
