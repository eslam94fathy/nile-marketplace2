import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { IsMoney, IsRate } from '../../../lib/http';
import { PaymentMethod, PaymentStatus } from '../../payments';
import { ActorRole, OrderStatus, SellerOrderCancelReason, SellerOrderStatus } from '../enums';
import { type OrderDetail, type SellerOrderDetail, type SellerOrderView } from '../model/order-view.model';
import { type OrderItem, type OrderListEntry, type StatusHistoryEntry } from '../model/order.model';

/* Response DTOs for spec 09 §4 (decorators describe the OpenAPI shape only). */

export class OrderItemAttributeDto {
  @IsString()
  attribute!: string;

  @IsString()
  value!: string;
}

export class OrderItemDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  productId!: string;

  @IsUUID()
  variantId!: string;

  /** Snapshot at checkout. */
  @IsString()
  productName!: string;

  @IsString()
  sku!: string;

  @ValidateNested({ each: true })
  @Type(() => OrderItemAttributeDto)
  attributes!: OrderItemAttributeDto[];

  @IsMoney()
  unitPrice!: string;

  @IsInt()
  quantity!: number;

  @IsInt()
  cancelledQuantity!: number;

  /** unitPrice × (quantity − cancelledQuantity). */
  @IsMoney()
  lineTotal!: string;
}

export class ShippingAddressDto {
  @IsString()
  recipientName!: string;

  @IsString()
  recipientPhone!: string;

  @IsUUID()
  governorateId!: string;

  @IsString()
  governorateName!: string;

  @IsString()
  city!: string;

  @IsString()
  area!: string;

  @IsString()
  street!: string;

  @IsString()
  building!: string;

  @IsOptional()
  @IsString()
  floor!: string | null;

  @IsOptional()
  @IsString()
  apartment!: string | null;

  @IsOptional()
  @IsString()
  landmark!: string | null;
}

export class TimelineEntryDto {
  @IsIn(Object.values(SellerOrderStatus))
  status!: SellerOrderStatus;

  @IsDateString()
  at!: string;
}

export class CustomerSellerOrderDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  sellerId!: string;

  @IsString()
  businessName!: string;

  @IsIn(Object.values(SellerOrderStatus))
  status!: SellerOrderStatus;

  @IsMoney()
  subtotal!: string;

  /** Only while `placed` (Q-31). */
  @IsBoolean()
  canCancel!: boolean;

  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @ValidateNested({ each: true })
  @Type(() => TimelineEntryDto)
  timeline!: TimelineEntryDto[];
}

export class OrderSummaryDto {
  @IsUUID()
  id!: string;

  @IsString()
  orderNumber!: string;

  @IsIn(Object.values(OrderStatus))
  status!: OrderStatus;

  @IsIn(Object.values(PaymentMethod))
  paymentMethod!: PaymentMethod;

  @IsMoney()
  total!: string;

  /** Units still to deliver (OR-9). */
  @IsInt()
  itemCount!: number;

  @IsInt()
  sellerOrderCount!: number;

  @IsDateString()
  createdAt!: string;
}

export class OrderDetailDto {
  @IsUUID()
  id!: string;

  @IsString()
  orderNumber!: string;

  @IsIn(Object.values(OrderStatus))
  status!: OrderStatus;

  @IsIn(Object.values(PaymentMethod))
  paymentMethod!: PaymentMethod;

  @IsIn(Object.values(PaymentStatus))
  paymentStatus!: PaymentStatus;

  @IsMoney()
  itemsTotal!: string;

  @IsMoney()
  deliveryFee!: string;

  @IsMoney()
  total!: string;

  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress!: ShippingAddressDto;

  @ValidateNested({ each: true })
  @Type(() => CustomerSellerOrderDto)
  sellerOrders!: CustomerSellerOrderDto[];

  @IsOptional()
  @IsDateString()
  paymentExpiresAt!: string | null;

  @IsOptional()
  @IsDateString()
  placedAt!: string | null;

  @IsOptional()
  @IsDateString()
  completedAt!: string | null;

  @IsOptional()
  @IsDateString()
  cancelledAt!: string | null;

  @IsDateString()
  createdAt!: string;
}

export class KashierCheckoutDto {
  @IsOptional()
  @IsString()
  checkoutUrl!: string | null;

  @IsDateString()
  expiresAt!: string;
}

export class CheckoutResultDto {
  @ValidateNested()
  @Type(() => OrderDetailDto)
  order!: OrderDetailDto;

  /** null for COD. */
  @IsOptional()
  @ValidateNested()
  @Type(() => KashierCheckoutDto)
  kashier!: KashierCheckoutDto | null;
}

export class DropoffGovernorateDto {
  @IsUUID()
  id!: string;

  @IsString()
  name!: string;
}

/** A seller's view (spec 09 §4.2): no customer name, phone or address (S-11). */
export class SellerOrderDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  orderId!: string;

  @IsString()
  orderNumber!: string;

  @IsIn(Object.values(SellerOrderStatus))
  status!: SellerOrderStatus;

  @IsIn(Object.values(PaymentMethod))
  paymentMethod!: PaymentMethod;

  @IsMoney()
  subtotal!: string;

  @IsRate()
  commissionRate!: string;

  @IsMoney()
  commission!: string;

  @IsMoney()
  sellerNet!: string;

  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @ValidateNested()
  @Type(() => DropoffGovernorateDto)
  dropoffGovernorate!: DropoffGovernorateDto;

  @IsOptional()
  @IsDateString()
  acceptDeadlineAt!: string | null;

  @IsOptional()
  @IsIn(Object.values(SellerOrderCancelReason))
  cancelReason!: SellerOrderCancelReason | null;

  @IsOptional()
  @IsDateString()
  acceptedAt!: string | null;

  @IsOptional()
  @IsDateString()
  readyAt!: string | null;

  @IsOptional()
  @IsDateString()
  pickedUpAt!: string | null;

  @IsOptional()
  @IsDateString()
  deliveredAt!: string | null;

  @IsOptional()
  @IsDateString()
  returnedAt!: string | null;

  @IsOptional()
  @IsDateString()
  cancelledAt!: string | null;

  @IsDateString()
  createdAt!: string;
}

export class AdminHistoryEntryDto {
  @IsOptional()
  @IsString()
  fromStatus!: string | null;

  @IsString()
  toStatus!: string;

  @IsIn(Object.values(ActorRole))
  actorRole!: ActorRole;

  @IsOptional()
  @IsUUID()
  actorUserId!: string | null;

  @IsOptional()
  @IsString()
  reason!: string | null;

  @IsDateString()
  at!: string;
}

export class AdminSellerOrderDto extends CustomerSellerOrderDto {
  @IsRate()
  commissionRate!: string;

  @IsMoney()
  commission!: string;

  @IsMoney()
  sellerNet!: string;

  @IsOptional()
  @IsIn(Object.values(SellerOrderCancelReason))
  cancelReason!: SellerOrderCancelReason | null;

  @ValidateNested({ each: true })
  @Type(() => AdminHistoryEntryDto)
  statusHistory!: AdminHistoryEntryDto[];
}

export class AdminOrderSummaryDto extends OrderSummaryDto {
  @IsUUID()
  customerId!: string;
}

/** Admin detail (spec 09 §4.3): the customer view plus money per seller order and the full histories. */
export class AdminOrderDetailDto extends OrderDetailDto {
  @IsUUID()
  customerId!: string;

  @ValidateNested({ each: true })
  @Type(() => AdminSellerOrderDto)
  declare sellerOrders: AdminSellerOrderDto[];

  @ValidateNested({ each: true })
  @Type(() => AdminHistoryEntryDto)
  statusHistory!: AdminHistoryEntryDto[];
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

function toOrderItemDto(item: OrderItem): OrderItemDto {
  return {
    id: item.id,
    productId: item.productId,
    variantId: item.variantId,
    productName: item.productName,
    sku: item.sku,
    attributes: item.attributes.map(({ attribute, value }) => ({ attribute, value })),
    unitPrice: item.unitPrice.toString(),
    quantity: item.quantity,
    cancelledQuantity: item.cancelledQuantity,
    lineTotal: item.lineTotal.toString(),
  };
}

function toCustomerSellerOrderDto(
  detail: SellerOrderDetail,
  orderAwaitsPayment: boolean,
): CustomerSellerOrderDto {
  const { sellerOrder } = detail;
  return {
    id: sellerOrder.id,
    sellerId: sellerOrder.sellerId,
    businessName: detail.businessName,
    status: sellerOrder.status,
    subtotal: sellerOrder.subtotal.toString(),
    canCancel: !orderAwaitsPayment && sellerOrder.status === SellerOrderStatus.PLACED,
    items: detail.items.map(toOrderItemDto),
    timeline: detail.history.map((entry) => ({ status: entry.toStatus, at: entry.createdAt.toISOString() })),
  };
}

export function toOrderDetailDto(detail: OrderDetail): OrderDetailDto {
  const { order, payment } = detail;
  if (!payment) throw new Error(`order ${order.id} has no payment`);
  const awaitsPayment = order.status === OrderStatus.PENDING_PAYMENT;
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: payment.status,
    itemsTotal: order.itemsTotal.toString(),
    deliveryFee: order.deliveryFee.toString(),
    total: order.total.toString(),
    shippingAddress: { ...order.shipping },
    sellerOrders: detail.sellerOrders.map((s) => toCustomerSellerOrderDto(s, awaitsPayment)),
    paymentExpiresAt: iso(order.paymentExpiresAt),
    placedAt: iso(order.placedAt),
    completedAt: iso(order.completedAt),
    cancelledAt: iso(order.cancelledAt),
    createdAt: order.createdAt.toISOString(),
  };
}

function toAdminHistoryDto<S extends string>(entry: StatusHistoryEntry<S>): AdminHistoryEntryDto {
  return {
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    actorRole: entry.actorRole,
    actorUserId: entry.actorUserId,
    reason: entry.reason,
    at: entry.createdAt.toISOString(),
  };
}

export function toAdminOrderDetailDto(detail: OrderDetail): AdminOrderDetailDto {
  const base = toOrderDetailDto(detail);
  return {
    ...base,
    customerId: detail.order.customerId,
    statusHistory: detail.history.map(toAdminHistoryDto),
    sellerOrders: detail.sellerOrders.map((s, i) => {
      const customerView = base.sellerOrders[i];
      if (!customerView) throw new Error('seller order views out of step');
      return {
        ...customerView,
        commissionRate: s.sellerOrder.commissionRate.toString(),
        commission: s.sellerOrder.commission.toString(),
        sellerNet: s.sellerOrder.sellerNet.toString(),
        cancelReason: s.sellerOrder.cancelReason,
        statusHistory: s.history.map(toAdminHistoryDto),
      };
    }),
  };
}

export function toOrderSummaryDto(entry: OrderListEntry): OrderSummaryDto {
  const { order } = entry;
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    total: order.total.toString(),
    itemCount: entry.itemCount,
    sellerOrderCount: entry.sellerOrderCount,
    createdAt: order.createdAt.toISOString(),
  };
}

export function toAdminOrderSummaryDto(entry: OrderListEntry): AdminOrderSummaryDto {
  return { ...toOrderSummaryDto(entry), customerId: entry.order.customerId };
}

export function toSellerOrderDto(view: SellerOrderView): SellerOrderDto {
  const { sellerOrder: s, order } = view;
  return {
    id: s.id,
    orderId: s.orderId,
    orderNumber: order.orderNumber,
    status: s.status,
    paymentMethod: order.paymentMethod,
    subtotal: s.subtotal.toString(),
    commissionRate: s.commissionRate.toString(),
    commission: s.commission.toString(),
    sellerNet: s.sellerNet.toString(),
    items: view.items.map(toOrderItemDto),
    dropoffGovernorate: order.dropoffGovernorate,
    acceptDeadlineAt: iso(s.acceptDeadlineAt),
    cancelReason: s.cancelReason,
    acceptedAt: iso(s.acceptedAt),
    readyAt: iso(s.readyAt),
    pickedUpAt: iso(s.pickedUpAt),
    deliveredAt: iso(s.deliveredAt),
    returnedAt: iso(s.returnedAt),
    cancelledAt: iso(s.cancelledAt),
    createdAt: s.createdAt.toISOString(),
  };
}
