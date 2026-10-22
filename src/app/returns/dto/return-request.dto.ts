import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import {
  FieldType,
  FilterOp,
  IntField,
  type ListSpec,
  Optional,
  PhoneField,
  StrField,
  UuidField,
} from '../../../lib/http';
import { RETURN_LIMITS } from '../constants';
import { AdminReturnDecision, RefundPayoutMethod, ReturnReason, ReturnStatus } from '../enums';

const L = RETURN_LIMITS;
const STATUSES = Object.values(ReturnStatus);

export class ReturnIdParamsDto {
  @UuidField()
  returnId!: string;
}

export class ReturnableItemsParamsDto {
  @UuidField()
  orderId!: string;

  @UuidField()
  sellerOrderId!: string;
}

export class ReturnLineDto {
  @UuidField()
  orderItemId!: string;

  @IntField(1, L.MAX_ITEM_QUANTITY)
  quantity!: number;
}

/**
 * Where a COD refund goes (RE-8): `walletNumber` for `mobile_wallet`, `instapayAddress` for `instapay`.
 * The field of the other method is refused by the controller (`toRefundPayout`).
 */
export class RefundPayoutDto {
  @IsIn(Object.values(RefundPayoutMethod))
  method!: RefundPayoutMethod;

  @Optional()
  @PhoneField()
  walletNumber?: string;

  @Optional()
  @StrField(L.INSTAPAY_ADDRESS_MIN, L.INSTAPAY_ADDRESS_MAX)
  instapayAddress?: string;
}

/** `POST /returns` (spec 18 §4.1). Items of the seller order, each once. */
export class RequestReturnDto {
  @UuidField()
  sellerOrderId!: string;

  @IsIn(Object.values(ReturnReason))
  reason!: ReturnReason;

  @Optional()
  @StrField(L.DESCRIPTION_MIN, L.DESCRIPTION_MAX)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(L.MAX_ITEMS)
  @ArrayUnique((line: ReturnLineDto) => line.orderItemId)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items!: ReturnLineDto[];

  /** Private `return_photo` uploads of the caller; at least one for a seller-fault reason (RE-2). */
  @Optional()
  @IsArray()
  @ArrayMaxSize(L.MAX_PHOTOS)
  @ArrayUnique()
  @IsUUID('7', { each: true })
  photoMediaIds?: string[];

  /** Required for a COD order, refused for a Kashier one (400, RE-8). */
  @Optional()
  @ValidateNested()
  @Type(() => RefundPayoutDto)
  refundPayout?: RefundPayoutDto;
}

export class EscalateReturnDto {
  @StrField(L.NOTE_MIN, L.NOTE_MAX)
  note!: string;
}

export class RejectReturnDto {
  @StrField(L.NOTE_MIN, L.NOTE_MAX)
  reason!: string;
}

export class AdminDecideReturnDto {
  @IsIn(Object.values(AdminReturnDecision))
  decision!: AdminReturnDecision;

  @StrField(L.NOTE_MIN, L.NOTE_MAX)
  note!: string;
}

const statusField = {
  column: 'status',
  type: FieldType.ENUM,
  ops: [FilterOp.EQ, FilterOp.IN],
  enumValues: STATUSES,
} as const;
const createdAtField = {
  column: 'created_at',
  type: FieldType.DATE,
  ops: [FilterOp.GTE, FilterOp.LTE],
  sortable: true,
} as const;

/** Spec 18 §4.1 whitelist for `GET /returns`. */
export const CUSTOMER_RETURN_LIST_SPEC: ListSpec = {
  fields: { status: statusField, createdAt: createdAtField },
  defaultSort: '-createdAt',
};

/** Spec 18 §4.2: sorting on the decision deadline is the seller's queue (pair it with status=requested). */
export const SELLER_RETURN_LIST_SPEC: ListSpec = {
  fields: {
    status: statusField,
    createdAt: { ...createdAtField, ops: [] },
    sellerDecisionDeadlineAt: {
      column: 'seller_decision_deadline_at',
      type: FieldType.DATE,
      ops: [],
      sortable: true,
    },
  },
  defaultSort: '-createdAt',
};

/** Spec 18 §4.3 whitelist for `GET /admin/returns` (RE-10: a customer's return history by `customerId`). */
export const ADMIN_RETURN_LIST_SPEC: ListSpec = {
  fields: {
    status: statusField,
    reason: {
      column: 'reason',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(ReturnReason),
    },
    sellerId: { column: 'seller_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    customerId: { column: 'customer_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    createdAt: { ...createdAtField, ops: [] },
  },
  defaultSort: '-createdAt',
};
