import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { AppError } from '../../../lib/error';
import { type IOutbox, OrderPlaced } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money, Rate } from '../../../lib/money';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { type ICartDirectory } from '../../cart';
import { type ICatalogDirectory } from '../../catalog';
import { CustomersErrorCode, type AddressSnapshot, type ICustomerDirectory } from '../../customers';
import { type IDeliveryReferenceService } from '../../delivery';
import { type IInventoryService } from '../../inventory';
import { type IPaymentDirectory, PaymentMethod } from '../../payments';
import { type CouponQuote, type IPromotions } from '../../promotions';
import { type ISellerDirectory, SellerStatus } from '../../sellers';
import { ActorRole, OrderStatus, SellerOrderStatus } from '../enums';
import {
  cartEmpty,
  cartHasIssues,
  checkoutAddressNotFound,
  governorateNotDeliverable,
  kashierTotalZero,
  orderNotAwaitingPayment,
  orderNotFound,
  orderPaymentPending,
  orderTotalChanged,
} from '../errors';
import { type CheckoutMoney, computeCheckoutMoney, type PricedLine } from '../model/checkout-money.model';
import { type Order, type PickupSnapshot, type ShippingSnapshot } from '../model/order.model';
import { type OrderItemRepository } from '../repository/order-item.repository';
import { type OrderRepository } from '../repository/order.repository';
import { type SellerOrderRepository } from '../repository/seller-order.repository';
import { type StatusHistoryRepository } from '../repository/status-history.repository';

type CheckoutEnv = Pick<ApiEnv, 'SELLER_ACCEPT_TIMEOUT_HOURS' | 'KASHIER_PAYMENT_TTL_MINUTES'>;

export interface CheckoutInput {
  addressId: string;
  paymentMethod: PaymentMethod;
  /** Money string the client showed (S-8). */
  expectedTotal: string;
  /** Spec 09 §8.8; the quote upper-cases it (PR-12). */
  couponCode?: string;
}

/** What checkout returns: the order, and for Kashier the payment page (null when it failed, SD-5). */
export interface CheckoutResult {
  order: Order;
  kashier: { checkoutUrl: string | null; expiresAt: Date } | null;
}

/**
 * Where a new order starts (spec 09 §3.1 step 6): COD is placed at once with the acceptance deadline;
 * Kashier waits for its payment inside the window, with no deadline yet.
 */
interface StartState {
  orderStatus: OrderStatus;
  sellerOrderStatus: SellerOrderStatus;
  placedAt: Date | null;
  acceptDeadlineAt: Date | null;
  paymentExpiresAt: Date | null;
}

/** What the transaction reads from the other modules before it writes anything. */
interface CheckoutContext {
  shipping: ShippingSnapshot;
  deliveryFee: Money;
  agentFeeShareRate: Rate;
}

/**
 * UC-OR-1 checkout (spec 09 §3.1, architecture §7.1). Reads the address, fee and fee-share rate first,
 * then one transaction across modules in the lock order of spec 09 OR-3 (extended by §8.8): cart → orders
 * → seller orders → inventory items → payments → coupons. Any failure rolls back everything, the cart
 * included.
 */
@injectable()
export class CheckoutService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Env) private readonly env: CheckoutEnv,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
    @inject(TOKENS.DeliveryReferenceService) private readonly delivery: IDeliveryReferenceService,
    @inject(TOKENS.CartDirectory) private readonly cart: ICartDirectory,
    @inject(TOKENS.CatalogDirectory) private readonly catalog: ICatalogDirectory,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
    @inject(TOKENS.PaymentDirectory) private readonly payments: IPaymentDirectory,
    @inject(TOKENS.Promotions) private readonly promotions: IPromotions,
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderItemRepository) private readonly items: OrderItemRepository,
    @inject(TOKENS.StatusHistoryRepository) private readonly history: StatusHistoryRepository,
  ) {}

  /** Places the order; for Kashier, asks payments for the payment page after the commit (step 11). */
  async checkout(customerId: string, userId: string, input: CheckoutInput): Promise<CheckoutResult> {
    const context = await this.readContext(customerId, input.addressId);
    const order = await this.tx.run((trx) => this.placeOrder(customerId, userId, input, context, trx));
    this.logger.info(order.paymentExpiresAt ? 'order awaiting payment' : 'order placed', {
      event: order.paymentExpiresAt ? 'ORDER_AWAITING_PAYMENT' : 'ORDER_PLACED',
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentMethod: order.paymentMethod,
      total: order.total.toString(),
    });
    if (!order.paymentExpiresAt) return { order, kashier: null };
    return { order, kashier: await this.kashierSession(order, order.paymentExpiresAt) };
  }

  /**
   * Step 11, outside any transaction: the payment page. A failure never fails the checkout: the order
   * is committed, `checkoutUrl` is null and the app asks again through §4.1.2 (SD-5).
   */
  private async kashierSession(
    order: Order,
    expiresAt: Date,
  ): Promise<NonNullable<CheckoutResult['kashier']>> {
    try {
      const session = await this.payments.createKashierSession(order.id, {
        expiresAt,
        description: `Nile order ${order.orderNumber}`,
      });
      if (session.kind === 'session')
        return { checkoutUrl: session.checkoutUrl, expiresAt: session.expiresAt };
    } catch (error) {
      this.logger.warn('kashier session not created at checkout; the app retries', {
        event: 'CHECKOUT_SESSION_FAILED',
        orderId: order.id,
        error,
      });
    }
    return { checkoutUrl: null, expiresAt };
  }

  /**
   * `POST /orders/:orderId/payment/kashier-session` (spec 09 §4.1.2, OR-7): the payment page of the
   * caller's Kashier order while its window is open; the stored session when there is one.
   */
  async paymentPage(customerId: string, orderId: string): Promise<{ checkoutUrl: string; expiresAt: Date }> {
    const order = await this.orders.findById(orderId);
    if (!order || order.customerId !== customerId) throw orderNotFound();
    const expiresAt = order.paymentExpiresAt;
    if (
      order.paymentMethod !== PaymentMethod.KASHIER ||
      order.status !== OrderStatus.PENDING_PAYMENT ||
      !expiresAt ||
      expiresAt <= this.clock.now()
    ) {
      throw orderNotAwaitingPayment();
    }
    const session = await this.payments.createKashierSession(order.id, {
      expiresAt,
      description: `Nile order ${order.orderNumber}`,
    });
    if (session.kind !== 'session') throw orderNotAwaitingPayment();
    return { checkoutUrl: session.checkoutUrl, expiresAt: session.expiresAt };
  }

  private startState(method: PaymentMethod, now: Date): StartState {
    if (method === PaymentMethod.COD) {
      return {
        orderStatus: OrderStatus.PLACED,
        sellerOrderStatus: SellerOrderStatus.PLACED,
        placedAt: now,
        acceptDeadlineAt: addDuration(now, this.env.SELLER_ACCEPT_TIMEOUT_HOURS, TimeUnit.HOUR),
        paymentExpiresAt: null,
      };
    }
    return {
      orderStatus: OrderStatus.PENDING_PAYMENT,
      sellerOrderStatus: SellerOrderStatus.PENDING_PAYMENT,
      placedAt: null,
      acceptDeadlineAt: null,
      paymentExpiresAt: addDuration(now, this.env.KASHIER_PAYMENT_TTL_MINUTES, TimeUnit.MINUTE),
    };
  }

  /** Steps 1–2: reads only, before the transaction. */
  private async readContext(customerId: string, addressId: string): Promise<CheckoutContext> {
    const address = await this.addressOf(customerId, addressId);
    const [governorate] = await this.delivery.getGovernorateFees([address.governorateId]);
    if (!governorate || governorate.deliveryFee === null) throw governorateNotDeliverable();
    return {
      shipping: { ...address, governorateName: governorate.name },
      deliveryFee: Money.of(governorate.deliveryFee),
      agentFeeShareRate: Rate.of(await this.delivery.getAgentFeeShareRate()),
    };
  }

  /** The address is a body reference here, so a missing one is 422, not customers' 404 (spec 09 §6). */
  private async addressOf(customerId: string, addressId: string): Promise<AddressSnapshot> {
    try {
      return await this.customers.getAddressSnapshot(customerId, addressId);
    } catch (error) {
      if (error instanceof AppError && error.code === CustomersErrorCode.ADDRESS_NOT_FOUND) {
        throw checkoutAddressNotFound();
      }
      throw error;
    }
  }

  /** Steps 3–10, in one transaction. */
  private async placeOrder(
    customerId: string,
    userId: string,
    input: CheckoutInput,
    context: CheckoutContext,
    trx: DbTransaction,
  ): Promise<Order> {
    const cartLines = await this.cart.getLinesForCheckout(customerId, trx); // locks the cart
    if (cartLines.length === 0) throw cartEmpty();
    if (input.paymentMethod === PaymentMethod.KASHIER) {
      // OR-16: no second unpaid Kashier order (it would hold more stock); the cart lock serialises this.
      const pending = await this.orders.findPendingPaymentIdOfCustomer(customerId, trx);
      if (pending) throw orderPaymentPending(pending);
    }
    const { lines, commissionRates, pickups } = await this.priceLines(cartLines, trx);
    const quote = input.couponCode ? await this.quote(input.couponCode, customerId, lines, trx) : null;
    const money = computeCheckoutMoney(
      lines,
      commissionRates,
      context.deliveryFee,
      quote && {
        funding: quote.funding,
        lineDiscounts: new Map(quote.lines.map((line) => [line.variantId, line.discount])),
      },
    );
    if (!Money.of(input.expectedTotal).equals(money.total)) throw orderTotalChanged(money.total.toString());
    if (input.paymentMethod === PaymentMethod.KASHIER && money.total.isZero()) throw kashierTotalZero();

    const now = this.clock.now();
    const start = this.startState(input.paymentMethod, now);
    const order = await this.orders.insert(
      {
        customerId,
        status: start.orderStatus,
        paymentMethod: input.paymentMethod,
        itemsTotal: money.itemsTotal,
        deliveryFee: money.deliveryFee,
        agentFeeShareRate: context.agentFeeShareRate,
        total: money.total,
        coupon: quote && { id: quote.couponId, code: quote.code },
        discountTotal: money.discountTotal,
        shipping: context.shipping,
        paymentExpiresAt: start.paymentExpiresAt,
        placedAt: start.placedAt,
      },
      trx,
    );
    const sellerOrderIds = await this.insertSellerOrders(order, money, pickups, start, userId, trx);
    await this.history.addOrderEntries(
      [
        {
          subjectId: order.id,
          fromStatus: null,
          toStatus: start.orderStatus,
          actorRole: ActorRole.CUSTOMER,
          actorUserId: userId,
          reason: null,
        },
      ],
      trx,
    );

    await this.payments.createForOrder(
      { orderId: order.id, customerId, method: input.paymentMethod, amount: money.total },
      trx,
    );
    // The last lock of the checkout (spec 19 UC-PR-2): a popular coupon's row is held the shortest time.
    if (quote) {
      await this.promotions.redeem(
        { couponId: quote.couponId, customerId, orderId: order.id, discountTotal: money.discountTotal },
        trx,
      );
    }
    await this.cart.clear(customerId, trx);
    // Kashier: `order.placed` is published when the payment arrives (spec 09 §3.11).
    if (!start.placedAt) return order;
    await this.outbox.add(trx, {
      contract: OrderPlaced,
      aggregateId: order.id,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId,
        paymentMethod: order.paymentMethod,
        sellerOrderIds,
        itemsTotal: money.itemsTotal.toString(),
        deliveryFee: money.deliveryFee.toString(),
        total: money.total.toString(),
        placedAt: start.placedAt.toISOString(),
      },
    });
    return order;
  }

  /** §8.8: after step 4, inside the transaction (PR-10); reads only. Its 422s abort the checkout. */
  private quote(
    code: string,
    customerId: string,
    lines: readonly PricedLine[],
    trx: DbTransaction,
  ): Promise<CouponQuote> {
    return this.promotions.quote(
      code,
      customerId,
      lines.map((line) => ({
        variantId: line.variantId,
        productId: line.productId,
        sellerId: line.sellerId,
        categoryId: line.categoryId,
        lineTotal: line.unitPrice.timesQuantity(line.quantity),
      })),
      trx,
    );
  }

  /** Step 4: live purchasability and seller status, then the snapshot each order line keeps. */
  private async priceLines(
    cartLines: readonly { variantId: string; quantity: number }[],
    trx: DbTransaction,
  ) {
    const variants = new Map(
      (
        await this.catalog.getVariantsForPurchase(
          cartLines.map((l) => l.variantId),
          trx,
        )
      ).map((v) => [v.variantId, v]),
    );
    const sellerIds = [...new Set([...variants.values()].map((v) => v.sellerId))];
    const snapshots = new Map(
      (await this.sellers.getCheckoutSnapshots(sellerIds, trx)).map((s) => [s.sellerId, s]),
    );

    const issues = cartLines.filter((line) => {
      const variant = variants.get(line.variantId);
      return !variant?.purchasable || snapshots.get(variant.sellerId)?.status !== SellerStatus.APPROVED;
    });
    if (issues.length > 0) throw cartHasIssues(issues.map((line) => line.variantId));

    const lines = cartLines.map((line): PricedLine => {
      const variant = variants.get(line.variantId);
      if (!variant) throw new Error(`variant ${line.variantId} vanished after the issue check`);
      return {
        variantId: variant.variantId,
        productId: variant.productId,
        sellerId: variant.sellerId,
        categoryId: variant.categoryId,
        productName: variant.productName,
        sku: variant.sku,
        attributes: variant.attributes,
        unitPrice: Money.of(variant.price),
        quantity: line.quantity,
        // Not claimed: catalog owns the claim, and media cleanup keeps an object this FK still uses.
        imageMediaId: variant.imageMediaId,
      };
    });
    return {
      lines,
      commissionRates: new Map([...snapshots.values()].map((s) => [s.sellerId, Rate.of(s.commissionRate)])),
      pickups: new Map([...snapshots.values()].map((s) => [s.sellerId, s.pickup])),
    };
  }

  /** Step 6–7: seller orders, their lines and history, then the stock reservation for every line. */
  private async insertSellerOrders(
    order: Order,
    money: CheckoutMoney,
    pickups: ReadonlyMap<string, PickupSnapshot>,
    start: StartState,
    userId: string,
    trx: DbTransaction,
  ): Promise<string[]> {
    const sellerOrders = await this.sellerOrders.insertMany(
      money.sellers.map((split) => {
        const pickup = pickups.get(split.sellerId);
        if (!pickup) throw new Error(`no pickup snapshot for seller ${split.sellerId}`);
        return {
          orderId: order.id,
          sellerId: split.sellerId,
          status: start.sellerOrderStatus,
          subtotal: split.subtotal,
          discountAmount: split.discountAmount,
          discountFunding: split.discountFunding,
          commissionRate: split.commissionRate,
          commission: split.commission,
          sellerNet: split.sellerNet,
          pickup,
          acceptDeadlineAt: start.acceptDeadlineAt,
        };
      }),
      trx,
    );
    // insertMany returns the seller orders in the order of money.sellers.
    const items = await this.items.insertMany(
      money.sellers.flatMap((split, i) =>
        split.lines.map((line) => ({
          sellerOrderId: sellerOrderAt(sellerOrders, i).id,
          variantId: line.variantId,
          productId: line.productId,
          productName: line.productName,
          sku: line.sku,
          attributes: line.attributes,
          unitPrice: line.unitPrice,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
          discountOriginal: line.discount,
          discountAmount: line.discount,
          imageMediaId: line.imageMediaId,
        })),
      ),
      trx,
    );
    await this.history.addSellerOrderEntries(
      sellerOrders.map((s) => ({
        subjectId: s.id,
        fromStatus: null,
        toStatus: start.sellerOrderStatus,
        actorRole: ActorRole.CUSTOMER,
        actorUserId: userId,
        reason: null,
      })),
      trx,
    );
    // A shortfall throws INSUFFICIENT_STOCK and rolls back the order rows too (A-3).
    await this.inventory.reserve(
      items.map((item) => ({ variantId: item.variantId, orderItemId: item.id, quantity: item.quantity })),
      trx,
    );
    return sellerOrders.map((s) => s.id);
  }
}

function sellerOrderAt<T>(sellerOrders: readonly T[], index: number): T {
  const sellerOrder = sellerOrders[index];
  if (!sellerOrder) throw new Error(`no seller order at ${index}`);
  return sellerOrder;
}
