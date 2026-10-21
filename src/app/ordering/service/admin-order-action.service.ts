import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { type AuthContext } from '../../../lib/auth';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { ActorRole, SellerOrderCancelReason, SellerOrderStatus } from '../enums';
import {
  orderNotCancellable,
  orderNotFound,
  sellerOrderNotCancellable,
  sellerOrderNotFound,
} from '../errors';
import { type SellerOrder } from '../model/order.model';
import { isTerminal } from '../model/order-status.model';
import { type SellerOrderRepository } from '../repository/seller-order.repository';
import { type Actor, type LockedOrder, type OrderLifecycleService } from './order-lifecycle.service';

const S = SellerOrderStatus;
/** The seller's own window (Q-31): `pending_payment` is the expiry job's, picked up is too late. */
const ADMIN_CANCELLABLE: readonly SellerOrderStatus[] = [S.PLACED, S.ACCEPTED, S.READY_FOR_PICKUP];

/**
 * Admin cancellation (spec 09 §8.4, UC-OR-9, UC-OR-10): the effects of a seller cancel (UC-OR-4) with
 * `admin_cancelled`, the admin's free-text reason on the history (admins only, OR-19), and an audit row
 * in the same transaction. Money follows from `seller_order.cancelled` as for a seller cancel.
 */
@injectable()
export class AdminOrderActionService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderLifecycleService) private readonly lifecycle: OrderLifecycleService,
  ) {}

  /** UC-OR-9. Returns the order id, for the response. */
  async cancelSellerOrder(admin: AuthContext, sellerOrderId: string, reason: string): Promise<string> {
    const [found] = await this.sellerOrders.findByIds([sellerOrderId]);
    if (!found) throw sellerOrderNotFound();
    await this.tx.run(async (trx) => {
      const locked = await this.lifecycle.lock(found.orderId, trx);
      const target = locked?.sellerOrders.find((s) => s.id === sellerOrderId);
      if (!locked || !target) throw sellerOrderNotFound();
      if (!ADMIN_CANCELLABLE.includes(target.status)) throw sellerOrderNotCancellable(target.status);
      const actor = adminActor(admin);
      await this.cancel(locked, target, reason, actor, trx);
      await this.lifecycle.settle(locked, actor, trx);
      await this.audit.record(
        {
          action: 'seller_order.admin_cancelled',
          targetId: target.id,
          before: { status: target.status },
          after: { status: S.CANCELLED },
          reason,
        },
        trx,
      );
    });
    return found.orderId;
  }

  /**
   * UC-OR-10, all or nothing (OR-17): every open seller order must be cancellable, else 409 with the
   * blocking ids and nothing cancelled. The cancellable ones go in id order, then one close step.
   */
  async cancelOrder(admin: AuthContext, orderId: string, reason: string): Promise<void> {
    await this.tx.run(async (trx) => {
      const locked = await this.lifecycle.lock(orderId, trx);
      if (!locked) throw orderNotFound();
      const open = locked.sellerOrders.filter((s) => !isTerminal(s.status));
      const blocking = open.filter((s) => !ADMIN_CANCELLABLE.includes(s.status));
      if (open.length === 0 || blocking.length > 0) {
        throw orderNotCancellable(blocking.map((s) => ({ sellerOrderId: s.id, status: s.status })));
      }
      const actor = adminActor(admin);
      for (const sellerOrder of [...open].sort((a, b) => a.id.localeCompare(b.id))) {
        await this.cancel(locked, sellerOrder, reason, actor, trx);
      }
      const settled = await this.lifecycle.settle(locked, actor, trx);
      await this.audit.record(
        {
          action: 'order.admin_cancelled',
          targetId: locked.order.id,
          before: { status: locked.order.status },
          after: { status: settled.status },
          reason,
        },
        trx,
      );
    });
  }

  private async cancel(
    locked: LockedOrder,
    sellerOrder: SellerOrder,
    reason: string,
    actor: Actor,
    trx: DbTransaction,
  ): Promise<void> {
    const cancelled = await this.lifecycle.cancelSellerOrder(
      locked,
      sellerOrder.id,
      ADMIN_CANCELLABLE,
      { reason: SellerOrderCancelReason.ADMIN_CANCELLED, note: reason },
      actor,
      trx,
    );
    // Checked under the lock just before, so a miss is a defect, not a race.
    if (!cancelled) throw new Error(`seller order ${sellerOrder.id} could not be cancelled under its lock`);
  }
}

const adminActor = (admin: AuthContext): Actor => ({ role: ActorRole.ADMIN, userId: admin.userId });
