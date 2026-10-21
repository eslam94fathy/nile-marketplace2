import { IsIn, IsString, ValidateIf } from 'class-validator';
import {
  FieldType,
  FilterOp,
  IntField,
  IsMoney,
  type ListSpec,
  Optional,
  StrField,
  UuidField,
} from '../../../lib/http';
import { PaymentMethod } from '../../payments';
import { ADMIN_CANCEL_REASON_MIN, NOTE_MAX_LENGTH, ORDER_LINE_MAX_QUANTITY } from '../constants';
import { ItemCancelReason, OrderStatus, SellerOrderStatus } from '../enums';

/** Request DTOs for spec 09 §4. Notation: docs/spec/01-api-conventions.md §1.1. */

/** `POST /checkout` (spec 09 §4.1.1). */
export class CheckoutDto {
  @UuidField()
  addressId!: string;

  @IsIn(Object.values(PaymentMethod))
  paymentMethod!: PaymentMethod;

  /** The total the app showed (S-8). */
  @IsString()
  @IsMoney()
  expectedTotal!: string;
}

export class OrderIdParamsDto {
  @UuidField()
  orderId!: string;
}

export class SellerOrderIdParamsDto {
  @UuidField()
  sellerOrderId!: string;
}

const createdAt = {
  column: 'created_at',
  type: FieldType.DATE,
  ops: [FilterOp.GTE, FilterOp.LTE],
  sortable: true,
} as const;

/** §4.1.3 whitelist for `GET /orders`. */
export const CUSTOMER_ORDER_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(OrderStatus),
    },
    createdAt,
  },
  defaultSort: '-createdAt',
};

/** §4.3 whitelist for `GET /admin/orders`. */
export const ADMIN_ORDER_LIST_SPEC: ListSpec = {
  fields: {
    ...CUSTOMER_ORDER_LIST_SPEC.fields,
    orderNumber: { column: 'order_number', type: FieldType.TEXT, ops: [FilterOp.EQ] },
    customerId: { column: 'customer_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
  },
  defaultSort: '-createdAt',
};

/** §4.2 whitelist for `GET /seller/orders`; pending_payment seller orders are never shown. */
export const SELLER_ORDER_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(SellerOrderStatus).filter((s) => s !== SellerOrderStatus.PENDING_PAYMENT),
    },
    createdAt,
  },
  defaultSort: '-createdAt',
};

/** `POST /orders/:orderId/seller-orders/:sellerOrderId/cancel` (spec 09 §4.1.4). */
export class CustomerSellerOrderParamsDto {
  @UuidField()
  orderId!: string;

  @UuidField()
  sellerOrderId!: string;
}

export class SellerOrderItemParamsDto {
  @UuidField()
  sellerOrderId!: string;

  @UuidField()
  itemId!: string;
}

/** Admin cancellation (spec 09 §8.4): the reason is for admins only (OR-18, OR-19). */
export class AdminCancelDto {
  @StrField(ADMIN_CANCEL_REASON_MIN, NOTE_MAX_LENGTH)
  reason!: string;
}

/** Customer and seller cancellation of a whole seller order (spec 09 §4.1.4, §4.2). */
export class CancelSellerOrderDto {
  @Optional()
  @StrField(1, NOTE_MAX_LENGTH)
  note?: string;
}

/** `POST /seller/orders/:sellerOrderId/items/:itemId/cancel` (spec 09 §4.2). */
export class CancelOrderItemDto {
  @IntField(1, ORDER_LINE_MAX_QUANTITY)
  quantity!: number;

  @IsIn(Object.values(ItemCancelReason))
  reason!: ItemCancelReason;

  /** Required when the reason is `other`. */
  @ValidateIf((dto: CancelOrderItemDto) => dto.reason === ItemCancelReason.OTHER || dto.note !== undefined)
  @StrField(1, NOTE_MAX_LENGTH)
  note?: string;
}
