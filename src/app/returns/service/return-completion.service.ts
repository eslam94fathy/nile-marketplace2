import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, ReturnCompleted } from '../../../lib/events';
import { type IInventoryService, type RestockLine } from '../../inventory';
import { type IOrderReturns, type OrderItemSnapshot, type ReturnLogistics } from '../../ordering';
import { ReturnFeePayer, ReturnStatus } from '../enums';
import { returnInvalidStatusTransition } from '../errors';
import { type ReturnActor, type ReturnRequest } from '../model/return-request.model';
import { type ReturnItemRepository } from '../repository/return-item.repository';
import { type ReturnRequestRepository } from '../repository/return-request.repository';
import { type ReturnLifecycleService } from './return-lifecycle.service';

/** What a completion reads in other modules, before its transaction. */
export interface CompletionContext {
  logistics: ReturnLogistics;
  /** The return's order lines by order-item id: the variants to restock. */
  snapshots: ReadonlyMap<string, OrderItemSnapshot>;
}

/**
 * UC-RE-7: the seller confirms receipt, the inspection job runs out, or an admin resolves a dispute with
 * a refund. One transaction with the request already locked; lock order return_requests → orders →
 * seller_orders → inventory_items (ordering then inventory lock theirs).
 */
@injectable()
export class ReturnCompletionService {
  constructor(
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.ReturnLifecycleService) private readonly lifecycle: ReturnLifecycleService,
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
    @inject(TOKENS.ReturnItemRepository) private readonly items: ReturnItemRepository,
    @inject(TOKENS.OrderReturns) private readonly orderReturns: IOrderReturns,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
  ) {}

  /** The reads of a completion, outside any transaction. */
  async contextOf(request: ReturnRequest): Promise<CompletionContext> {
    const [logistics, items] = await Promise.all([
      this.lifecycle.logisticsOf(request.sellerOrderId),
      this.items.findByReturnIds([request.id]),
    ]);
    const snapshots = await this.orderReturns.getOrderItems(items.map((item) => item.orderItemId));
    return { logistics, snapshots: new Map(snapshots.map((s) => [s.orderItemId, s])) };
  }

  /**
   * Records the return in ordering, restocks the items marked `true` in `restock` (by return-item id;
   * missing = false), fixes the refund, completes the request and publishes `return.completed`, then
   * clears the payout details (RE-8). `locked` must be in `from`.
   */
  async complete(
    locked: ReturnRequest,
    from: readonly ReturnStatus[],
    restock: ReadonlyMap<string, boolean>,
    actor: ReturnActor,
    reason: string | null,
    context: CompletionContext,
    trx: DbTransaction,
  ): Promise<ReturnRequest> {
    if (!from.includes(locked.status)) throw returnInvalidStatusTransition(locked.status);
    const items = await this.items.findByReturnIds([locked.id], trx);
    const amounts = await this.orderReturns.recordReturn(
      {
        sellerOrderId: locked.sellerOrderId,
        returnId: locked.id,
        lines: items.map((item) => ({ orderItemId: item.orderItemId, quantity: item.quantity })),
      },
      trx,
    );

    const lines: RestockLine[] = items
      .filter((item) => restock.get(item.id) === true)
      .map((item) => {
        const snapshot = context.snapshots.get(item.orderItemId);
        if (!snapshot) throw new Error(`return item ${item.id} has no order item`);
        return { variantId: snapshot.variantId, quantity: item.quantity, returnId: locked.id };
      });
    await this.inventory.restock(lines, actor.userId, trx);
    await this.items.setRestock(
      locked.id,
      new Map(items.map((item) => [item.id, restock.get(item.id) === true])),
      trx,
    );

    // The original delivery fee is never refunded (RE-7); a changed mind carries the return fee (R-13).
    const refundAmount =
      locked.returnFeePayer === ReturnFeePayer.CUSTOMER
        ? amounts.itemsPaid.minus(locked.returnFee)
        : amounts.itemsPaid;
    const agentFeeShare = locked.returnFee.timesRate(locked.agentShareRate);
    const sealedPayout = await this.requests.findRefundPayout(locked.id, trx);

    const completed = await this.lifecycle.transition(
      locked,
      from,
      {
        status: ReturnStatus.COMPLETED,
        completedAt: this.lifecycle.now(),
        refundAmount,
        clearRefundPayout: true,
      },
      actor,
      reason,
      context.logistics.orderNumber,
      trx,
    );
    if (completed.agentId === null) throw new Error(`completed return ${completed.id} has no agent`);
    await this.outbox.add(trx, {
      contract: ReturnCompleted,
      aggregateId: completed.id,
      payload: {
        returnId: completed.id,
        sellerOrderId: completed.sellerOrderId,
        orderId: completed.orderId,
        customerId: completed.customerId,
        sellerId: completed.sellerId,
        paymentMethod: context.logistics.paymentMethod,
        itemsPaid: amounts.itemsPaid.toString(),
        itemsSubtotal: amounts.itemsSubtotal.toString(),
        commissionReversed: amounts.commissionReversed.toString(),
        sellerNetReversed: amounts.sellerNetReversed.toString(),
        platformDiscountReversed: amounts.platformDiscountReversed.toString(),
        returnFee: completed.returnFee.toString(),
        returnFeePayer: completed.returnFeePayer,
        agentId: completed.agentId,
        agentFeeShare: agentFeeShare.toString(),
        refundAmount: refundAmount.toString(),
        refundPayoutEncrypted: sealedPayout,
      },
    });
    return completed;
  }
}
