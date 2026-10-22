import { inject, injectable } from 'tsyringe';
import { UserRole } from '../../../lib/auth';
import { type Env } from '../../../lib/config';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { validationFailed } from '../../../lib/error';
import { Money, Rate } from '../../../lib/money';
import { type ISecretBox } from '../../../pkg/crypto';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { type ICustomerDirectory } from '../../customers';
import { type IDeliveryReferenceService, type IShipmentDirectory, ShipmentStatus } from '../../delivery';
import { MediaPurpose, type MediaService } from '../../media';
import {
  type IOrderingDirectory,
  type IOrderReturns,
  type ReturnableItem,
  type ReturnableSellerOrder,
  type ReturnLine,
  SellerOrderStatus,
} from '../../ordering';
import { PaymentMethod } from '../../payments';
import { refundPayoutAad } from '../constants';
import {
  PhotoUploader,
  ReturnActorRole,
  ReturnFeePayer,
  type ReturnReason,
  ReturnStatus,
  SELLER_FAULT_REASONS,
} from '../enums';
import {
  orderNotFound,
  profileMissing,
  returnAmountTooLow,
  returnEscalationWindowClosed,
  returnInvalidStatusTransition,
  returnNotAllowed,
  returnNotFound,
  returnPhotosRequired,
  returnPickupUnavailable,
  returnWindowClosed,
  sellerOrderNotFound,
} from '../errors';
import { type RefundPayout, type ReturnRequest } from '../model/return-request.model';
import { type ReturnHistoryRepository } from '../repository/return-history.repository';
import { type ReturnItemRepository } from '../repository/return-item.repository';
import { type ReturnPhotoRepository } from '../repository/return-photo.repository';
import { type ReturnRequestRepository } from '../repository/return-request.repository';
import { type ReturnLifecycleService } from './return-lifecycle.service';

type ReturnsEnv = Pick<Env, 'RETURN_WINDOW_DAYS' | 'RETURN_SELLER_DECISION_HOURS'>;

export interface RequestReturnInput {
  sellerOrderId: string;
  reason: ReturnReason;
  description: string | null;
  items: readonly ReturnLine[];
  photoMediaIds: readonly string[];
  refundPayout: RefundPayout | null;
}

/** `GET …/returnable-items` (spec 18 §4.1). */
export interface ReturnableItemsView {
  windowEndsAt: Date;
  items: ReturnableItem[];
  returnFee: Money;
}

/**
 * The customer's writes (spec 18 UC-RE-1, UC-RE-3 escalation, UC-RE-5). Reads in other modules
 * (profile, returnable items, quote, fees, order number) happen before the transaction; inside it the
 * request is locked first, then the media rows (in `claim`).
 */
@injectable()
export class ReturnRequestService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Env) private readonly env: ReturnsEnv,
    @inject(TOKENS.SecretBox) private readonly secretBox: ISecretBox,
    @inject(TOKENS.ReturnLifecycleService) private readonly lifecycle: ReturnLifecycleService,
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
    @inject(TOKENS.ReturnItemRepository) private readonly items: ReturnItemRepository,
    @inject(TOKENS.ReturnPhotoRepository) private readonly photos: ReturnPhotoRepository,
    @inject(TOKENS.ReturnHistoryRepository) private readonly history: ReturnHistoryRepository,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.OrderReturns) private readonly orderReturns: IOrderReturns,
    @inject(TOKENS.DeliveryReferenceService) private readonly delivery: IDeliveryReferenceService,
    @inject(TOKENS.ShipmentDirectory) private readonly shipments: IShipmentDirectory,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
  ) {}

  /** The customer's id behind the account: a customer without its profile is a data defect (500). */
  async customerIdOf(userId: string): Promise<string> {
    const customerId = await this.customers.getCustomerIdByUserId(userId);
    if (customerId === null) throw profileMissing(UserRole.CUSTOMER, userId);
    return customerId;
  }

  /** What may be returned, until when, and the current fee (spec 18 §4.1). */
  async returnableItems(
    userId: string,
    orderId: string,
    sellerOrderId: string,
  ): Promise<ReturnableItemsView> {
    const customerId = await this.customerIdOf(userId);
    if (!(await this.ordering.getCustomerOrderLink(customerId, orderId))) throw orderNotFound();
    const sellerOrder = await this.orderReturns.getReturnableItems(customerId, sellerOrderId);
    if (sellerOrder?.orderId !== orderId) throw sellerOrderNotFound();
    const windowEndsAt = this.checkReturnable(sellerOrder);
    const { fee } = await this.feeOf(sellerOrder.dropoffGovernorateId);
    return { windowEndsAt, items: sellerOrder.items, returnFee: fee };
  }

  /** UC-RE-1. */
  async request(userId: string, input: RequestReturnInput): Promise<ReturnRequest> {
    const customerId = await this.customerIdOf(userId);
    const sellerOrder = await this.orderReturns.getReturnableItems(customerId, input.sellerOrderId);
    if (!sellerOrder) throw sellerOrderNotFound();
    this.checkReturnable(sellerOrder);
    // RETURN_QUANTITY_INVALID (details per line) comes from ordering's rule (OR-28).
    const amounts = await this.orderReturns.quoteReturn(sellerOrder.sellerOrderId, input.items);
    checkRefundPayout(sellerOrder, input.refundPayout);
    const sellerFault = SELLER_FAULT_REASONS.includes(input.reason);
    if (sellerFault && input.photoMediaIds.length === 0) throw returnPhotosRequired();

    const { fee, agentShareRate } = await this.feeOf(sellerOrder.dropoffGovernorateId);
    const returnFeePayer = sellerFault ? ReturnFeePayer.SELLER : ReturnFeePayer.CUSTOMER;
    // The original delivery fee is never refunded (RE-7); a changed mind pays the return fee (R-13).
    const refundAmount =
      returnFeePayer === ReturnFeePayer.CUSTOMER ? amounts.itemsPaid.minus(fee) : amounts.itemsPaid;
    if (!refundAmount.greaterThan(Money.zero())) throw returnAmountTooLow();

    const now = this.lifecycle.now();
    const actor = { role: ReturnActorRole.CUSTOMER, userId };
    return this.tx.run(async (trx) => {
      const request = await this.requests.insert(
        {
          sellerOrderId: sellerOrder.sellerOrderId,
          orderId: sellerOrder.orderId,
          customerId,
          sellerId: sellerOrder.sellerId,
          reason: input.reason,
          description: input.description,
          returnFee: fee,
          returnFeePayer,
          agentShareRate,
          refundAmount,
          refundPayoutMethod: input.refundPayout?.method ?? null,
          sellerDecisionDeadlineAt: addDuration(now, this.env.RETURN_SELLER_DECISION_HOURS, TimeUnit.HOUR),
        },
        trx,
      );
      await this.items.insertMany(request.id, input.items, trx);
      await this.history.insert(
        {
          returnId: request.id,
          fromStatus: null,
          toStatus: request.status,
          actorRole: actor.role,
          actorUserId: userId,
          reason: null,
        },
        trx,
      );
      await this.media.claim(
        input.photoMediaIds,
        { purpose: MediaPurpose.RETURN_PHOTO, ownerUserId: userId },
        trx,
      );
      await this.photos.insertMany(request.id, PhotoUploader.CUSTOMER, input.photoMediaIds, trx);
      if (input.refundPayout) {
        const sealed = this.secretBox.seal(JSON.stringify(input.refundPayout), refundPayoutAad(request.id));
        await this.requests.setRefundPayout(request.id, sealed, trx);
      }
      await this.lifecycle.statusChanged(request, null, actor, sellerOrder.orderNumber, trx);
      return { ...request, hasRefundPayout: input.refundPayout !== null };
    });
  }

  /**
   * UC-RE-5: before pickup only; an agent who already picked it up wins the race (409). Delivery is asked
   * first, so a pickup not yet consumed by returns still blocks the cancel (RE-24).
   */
  async cancel(userId: string, returnId: string): Promise<ReturnRequest> {
    const customerId = await this.customerIdOf(userId);
    const found = await this.requests.findById(returnId, { customerId });
    if (!found) throw returnNotFound();
    if (found.status === ReturnStatus.APPROVED) {
      const shipment = await this.shipments.getReturnShipmentStatus(found.id);
      if (shipment === ShipmentStatus.PICKED_UP || shipment === ShipmentStatus.DELIVERED) {
        throw returnInvalidStatusTransition(ReturnStatus.PICKED_UP);
      }
    }
    const orderNumber = await this.lifecycle.orderNumberOf(found.orderId);
    return this.tx.run(async (trx) => {
      const locked = await this.requests.lockById(returnId, trx, { customerId });
      if (!locked) throw returnNotFound();
      const cancelled = await this.lifecycle.transition(
        locked,
        [ReturnStatus.REQUESTED, ReturnStatus.APPROVED],
        { status: ReturnStatus.CANCELLED, clearRefundPayout: true },
        { role: ReturnActorRole.CUSTOMER, userId },
        null,
        orderNumber,
        trx,
      );
      // media.release expects the reference rows gone (spec 14 §2).
      await this.media.release(await this.photos.deleteByReturnId(cancelled.id, trx), trx);
      return cancelled;
    });
  }

  /** UC-RE-3: a rejected request, before its escalation deadline, with a note for the admin (RE-3). */
  async escalate(userId: string, returnId: string, note: string): Promise<ReturnRequest> {
    const customerId = await this.customerIdOf(userId);
    const found = await this.requests.findById(returnId, { customerId });
    if (!found) throw returnNotFound();
    const orderNumber = await this.lifecycle.orderNumberOf(found.orderId);
    const now = this.lifecycle.now();
    return this.tx.run(async (trx) => {
      const locked = await this.requests.lockById(returnId, trx, { customerId });
      if (!locked) throw returnNotFound();
      if (locked.status !== ReturnStatus.REJECTED) throw returnInvalidStatusTransition(locked.status);
      if (locked.escalationDeadlineAt === null || now >= locked.escalationDeadlineAt) {
        throw returnEscalationWindowClosed();
      }
      return this.lifecycle.transition(
        locked,
        [ReturnStatus.REJECTED],
        { status: ReturnStatus.ESCALATED, escalationNote: note },
        { role: ReturnActorRole.CUSTOMER, userId },
        note,
        orderNumber,
        trx,
      );
    });
  }

  /** Delivered, and inside the window (R-13); returns when the window ends. */
  private checkReturnable(sellerOrder: ReturnableSellerOrder): Date {
    if (sellerOrder.status !== SellerOrderStatus.DELIVERED || sellerOrder.deliveredAt === null)
      throw returnNotAllowed();
    const windowEndsAt = addDuration(sellerOrder.deliveredAt, this.env.RETURN_WINDOW_DAYS, TimeUnit.DAY);
    if (this.lifecycle.now() >= windowEndsAt) throw returnWindowClosed();
    return windowEndsAt;
  }

  /** The current fee of the customer's governorate and the agent share rate (RE-5). */
  private async feeOf(governorateId: string): Promise<{ fee: Money; agentShareRate: Rate }> {
    const [[governorate], rate] = await Promise.all([
      this.delivery.getGovernorateFees([governorateId]),
      this.delivery.getAgentFeeShareRate(),
    ]);
    if (governorate?.deliveryFee === null || governorate === undefined) throw returnPickupUnavailable();
    return { fee: Money.of(governorate.deliveryFee), agentShareRate: Rate.of(rate) };
  }
}

/** A COD order must say where the refund goes; a Kashier one must not (RE-8): 400 like any body error. */
function checkRefundPayout(sellerOrder: ReturnableSellerOrder, payout: RefundPayout | null): void {
  const cod = sellerOrder.paymentMethod === PaymentMethod.COD;
  if (cod === (payout !== null)) return;
  throw validationFailed([
    {
      field: 'refundPayout',
      constraint: cod ? 'required_for_cod' : 'not_allowed_for_online_payment',
      message: cod
        ? 'refundPayout is required for a cash-on-delivery order'
        : 'refundPayout is only for cash-on-delivery orders',
    },
  ]);
}
