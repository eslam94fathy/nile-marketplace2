import { IsIn, IsString } from 'class-validator';
import { FieldType, FilterOp, IsMoney, type ListSpec, UuidField } from '../../../lib/http';
import { PaymentMethod } from '../../payments';
import { OrderStatus, SellerOrderStatus } from '../enums';

/** Request DTOs for spec 09 §4. Notation: docs/spec/01-api-conventions.md §1.1. */

/**
 * `POST /checkout` (spec 09 §4.1.1). Only COD until the Kashier flow lands (plan §7.5 PR b): Kashier
 * needs the payment session, the webhook and the expiry job, so it is refused here rather than
 * leaving stock reserved with nothing to release it.
 */
export class CheckoutDto {
  @UuidField()
  addressId!: string;

  @IsIn([PaymentMethod.COD])
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
