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
import { type IPaymentDirectory, type PaymentMethod } from '../../payments';
import { type ISellerDirectory, SellerStatus } from '../../sellers';
import { ActorRole, OrderStatus, SellerOrderStatus } from '../enums';
import {
  cartEmpty,
  cartHasIssues,
  checkoutAddressNotFound,
  governorateNotDeliverable,
  orderTotalChanged,
} from '../errors';
import { type CheckoutMoney, computeCheckoutMoney, type PricedLine } from '../model/checkout-money.model';
import { type Order, type PickupSnapshot, type ShippingSnapshot } from '../model/order.model';
import { type OrderItemRepository } from '../repository/order-item.repository';
import { type OrderRepository } from '../repository/order.repository';
import { type SellerOrderRepository } from '../repository/seller-order.repository';
import { type StatusHistoryRepository } from '../repository/status-history.repository';

type CheckoutEnv = Pick<ApiEnv, 'SELLER_ACCEPT_TIMEOUT_HOURS'>;

export interface CheckoutInput {
  addressId: string;
  paymentMethod: PaymentMethod;
  /** Money string the client showed (S-8). */
  expectedTotal: string;
}

/** What the transaction reads from the other modules before it writes anything. */
interface CheckoutContext {
  shipping: ShippingSnapshot;
  deliveryFee: Money;
  agentFeeShareRate: Rate;
}

/**
 * UC-OR-1 checkout (spec 09 §3.1, architecture §7.1). Reads the address, fee and fee-share rate first,
 * then one transaction across modules in the lock order of spec 09 OR-3: cart → orders → seller
 * orders → inventory items → payments. Any failure rolls back everything, the cart included.
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
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderItemRepository) private readonly items: OrderItemRepository,
    @inject(TOKENS.StatusHistoryRepository) private readonly history: StatusHistoryRepository,
  ) {}

  /** Places a COD order (Kashier lands with PR b) and returns it. */
  async checkout(customerId: string, userId: string, input: CheckoutInput): Promise<Order> {
    const context = await this.readContext(customerId, input.addressId);
    const order = await this.tx.run((trx) => this.placeOrder(customerId, userId, input, context, trx));
    this.logger.info('order placed', {
      event: 'ORDER_PLACED',
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentMethod: order.paymentMethod,
      total: order.total.toString(),
    });
    return order;
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
    const { lines, commissionRates, pickups } = await this.priceLines(cartLines, trx);
    const money = computeCheckoutMoney(lines, commissionRates, context.deliveryFee);
    if (!Money.of(input.expectedTotal).equals(money.total)) throw orderTotalChanged(money.total.toString());

    const now = this.clock.now();
    const order = await this.orders.insert(
      {
        customerId,
        status: OrderStatus.PLACED,
        paymentMethod: input.paymentMethod,
        itemsTotal: money.itemsTotal,
        deliveryFee: money.deliveryFee,
        agentFeeShareRate: context.agentFeeShareRate,
        total: money.total,
        shipping: context.shipping,
        paymentExpiresAt: null,
        placedAt: now,
      },
      trx,
    );
    const sellerOrderIds = await this.insertSellerOrders(order, money, pickups, now, userId, trx);
    await this.history.addOrderEntries(
      [
        {
          subjectId: order.id,
          fromStatus: null,
          toStatus: OrderStatus.PLACED,
          actorRole: ActorRole.CUSTOMER,
          actorUserId: userId,
          reason: null,
        },
      ],
      trx,
    );

    await this.payments.createForOrder(
      { orderId: order.id, method: input.paymentMethod, amount: money.total },
      trx,
    );
    await this.cart.clear(customerId, trx);
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
        placedAt: now.toISOString(),
      },
    });
    return order;
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
        productName: variant.productName,
        sku: variant.sku,
        attributes: variant.attributes,
        unitPrice: Money.of(variant.price),
        quantity: line.quantity,
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
    now: Date,
    userId: string,
    trx: DbTransaction,
  ): Promise<string[]> {
    const acceptDeadlineAt = addDuration(now, this.env.SELLER_ACCEPT_TIMEOUT_HOURS, TimeUnit.HOUR);
    const sellerOrders = await this.sellerOrders.insertMany(
      money.sellers.map((split) => {
        const pickup = pickups.get(split.sellerId);
        if (!pickup) throw new Error(`no pickup snapshot for seller ${split.sellerId}`);
        return {
          orderId: order.id,
          sellerId: split.sellerId,
          status: SellerOrderStatus.PLACED,
          subtotal: split.subtotal,
          commissionRate: split.commissionRate,
          commission: split.commission,
          sellerNet: split.sellerNet,
          pickup,
          acceptDeadlineAt,
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
        })),
      ),
      trx,
    );
    await this.history.addSellerOrderEntries(
      sellerOrders.map((s) => ({
        subjectId: s.id,
        fromStatus: null,
        toStatus: SellerOrderStatus.PLACED,
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
