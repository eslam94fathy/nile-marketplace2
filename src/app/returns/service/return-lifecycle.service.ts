import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, ReturnApproved, ReturnStatusChanged } from '../../../lib/events';
import { type IOrderingDirectory, type IOrderReturns, type ReturnLogistics } from '../../ordering';
import { type ReturnStatus } from '../enums';
import { returnInvalidStatusTransition } from '../errors';
import {
  type ReturnActor,
  type ReturnItem,
  type ReturnPatch,
  type ReturnRequest,
} from '../model/return-request.model';
import { type ReturnHistoryRepository } from '../repository/return-history.repository';
import { type ReturnItemRepository } from '../repository/return-item.repository';
import { type ReturnRequestRepository } from '../repository/return-request.repository';

/**
 * The shared write path of every return transition (spec 18 §1.1): a conditional update on the expected
 * status, a history row (actor, reason) and `return.status_changed`, all in the caller's transaction
 * with the request already locked. Used by the HTTP actions and (from step 5) the consumer and jobs.
 */
@injectable()
export class ReturnLifecycleService {
  constructor(
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
    @inject(TOKENS.ReturnItemRepository) private readonly items: ReturnItemRepository,
    @inject(TOKENS.ReturnHistoryRepository) private readonly history: ReturnHistoryRepository,
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.OrderReturns) private readonly orderReturns: IOrderReturns,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  /** The request's order number for the event (spec 18 §5): read before the transaction. */
  async orderNumberOf(orderId: string): Promise<string> {
    const number = (await this.ordering.getOrderNumbers([orderId])).get(orderId);
    // return_requests.order_id is a RESTRICT FK, so the order exists.
    if (number === undefined) throw new Error(`order ${orderId} not found`);
    return number;
  }

  /** The pickup and drop-off snapshots of an approval (UC-RE-4): read before the transaction. */
  async logisticsOf(sellerOrderId: string): Promise<ReturnLogistics> {
    const logistics = await this.orderReturns.getReturnLogistics(sellerOrderId);
    if (!logistics) throw new Error(`seller order ${sellerOrderId} not found`);
    return logistics;
  }

  /**
   * Moves `locked` on if it is in `from`, else `409 RETURN_INVALID_STATUS_TRANSITION` with its current
   * status. Writes the history row and the event.
   */
  async transition(
    locked: ReturnRequest,
    from: readonly ReturnStatus[],
    patch: ReturnPatch,
    actor: ReturnActor,
    reason: string | null,
    orderNumber: string,
    trx: DbTransaction,
  ): Promise<ReturnRequest> {
    if (!from.includes(locked.status)) throw returnInvalidStatusTransition(locked.status);
    const after = await this.requests.transition(locked.id, from, patch, trx);
    if (!after) throw new Error(`return ${locked.id} moved under its lock`);
    await this.history.insert(
      {
        returnId: after.id,
        fromStatus: locked.status,
        toStatus: after.status,
        actorRole: actor.role,
        actorUserId: actor.userId,
        reason,
      },
      trx,
    );
    await this.statusChanged(after, locked.status, actor, orderNumber, trx);
    return after;
  }

  /** `return.status_changed` (spec 18 §5); `from` is null for the request itself. */
  async statusChanged(
    request: ReturnRequest,
    from: ReturnStatus | null,
    actor: ReturnActor,
    orderNumber: string,
    trx: DbTransaction,
  ): Promise<void> {
    await this.outbox.add(trx, {
      contract: ReturnStatusChanged,
      aggregateId: request.id,
      payload: {
        returnId: request.id,
        returnNumber: request.returnNumber,
        orderId: request.orderId,
        orderNumber,
        sellerOrderId: request.sellerOrderId,
        customerId: request.customerId,
        sellerId: request.sellerId,
        from,
        to: request.status,
        actor: actor.role,
      },
    });
  }

  /** UC-RE-4: `return.approved` for delivery, with both snapshots and the fee snapshot. */
  async approved(request: ReturnRequest, logistics: ReturnLogistics, trx: DbTransaction): Promise<void> {
    const items: ReturnItem[] = await this.items.findByReturnIds([request.id], trx);
    const { pickup, dropoff } = logistics;
    await this.outbox.add(trx, {
      contract: ReturnApproved,
      aggregateId: request.id,
      payload: {
        returnId: request.id,
        returnNumber: request.returnNumber,
        sellerOrderId: request.sellerOrderId,
        orderId: request.orderId,
        sellerId: request.sellerId,
        pickup: {
          recipientName: pickup.recipientName,
          recipientPhone: pickup.recipientPhone,
          governorateId: pickup.governorateId,
          governorateName: pickup.governorateName,
          city: pickup.city,
          area: pickup.area,
          street: pickup.street,
          building: pickup.building,
          floor: pickup.floor,
          apartment: pickup.apartment,
          landmark: pickup.landmark,
        },
        dropoff: {
          businessName: dropoff.businessName,
          phone: dropoff.phone,
          governorateId: dropoff.governorateId,
          city: dropoff.city,
          area: dropoff.area,
          street: dropoff.street,
          building: dropoff.building,
          landmark: dropoff.landmark,
        },
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        returnFee: request.returnFee.toString(),
        agentShareRate: request.agentShareRate.toString(),
      },
    });
  }
}
