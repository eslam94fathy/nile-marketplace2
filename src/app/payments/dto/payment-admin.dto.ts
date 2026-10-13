import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { FieldType, FilterOp, IsMoney, type ListSpec, StrField, UuidField } from '../../../lib/http';
import { PaymentMethod, PaymentStatus, RefundReason, RefundStatus } from '../enums';
import { type PaymentRefund } from '../model/refund.model';
import { type AdminPaymentView } from '../service/payment-admin.service';

/* Spec 10 §4.2. Request DTOs validate; response DTOs describe the OpenAPI shape. */

export const PROVIDER_REFUND_REF_MAX_LENGTH = 100;

export class PaymentIdParamsDto {
  @UuidField()
  paymentId!: string;
}

export class RefundIdParamsDto {
  @UuidField()
  refundId!: string;
}

export class OrderPaymentParamsDto {
  @UuidField()
  orderId!: string;
}

/** `POST /admin/payments/refunds/:refundId/record` (UC-PA-4). */
export class RecordRefundDto {
  /** Kashier's refund reference from its dashboard. */
  @StrField(1, PROVIDER_REFUND_REF_MAX_LENGTH)
  providerRefundRef!: string;
}

/** `GET /admin/payments/refunds`: a work queue, oldest first by default. */
export const REFUND_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'r.status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(RefundStatus),
    },
    reason: {
      column: 'r.reason',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(RefundReason),
    },
    createdAt: {
      column: 'r.created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
  },
  defaultSort: 'createdAt',
};

export class RefundDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  paymentId!: string;

  @IsUUID()
  orderId!: string;

  @IsOptional()
  @IsUUID()
  sellerOrderId!: string | null;

  @IsMoney()
  amount!: string;

  @IsIn(Object.values(RefundReason))
  reason!: RefundReason;

  @IsIn(Object.values(RefundStatus))
  status!: RefundStatus;

  @IsOptional()
  @IsString()
  providerRefundRef!: string | null;

  @IsOptional()
  @IsUUID()
  recordedByUserId!: string | null;

  @IsOptional()
  @IsDateString()
  recordedAt!: string | null;

  @IsDateString()
  createdAt!: string;
}

/** A webhook in the inbox, without its payload. */
export class PaymentEventDto {
  @IsUUID()
  id!: string;

  @IsString()
  eventType!: string;

  @IsBoolean()
  signatureValid!: boolean;

  @IsOptional()
  @IsDateString()
  processedAt!: string | null;

  @IsDateString()
  createdAt!: string;
}

export class AdminPaymentDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  orderId!: string;

  @IsIn(Object.values(PaymentMethod))
  method!: PaymentMethod;

  @IsIn(Object.values(PaymentStatus))
  status!: PaymentStatus;

  @IsMoney()
  amount!: string;

  @IsMoney()
  collectedAmount!: string;

  @IsMoney()
  refundedAmount!: string;

  /** The Kashier session id. */
  @IsOptional()
  @IsString()
  providerOrderRef!: string | null;

  @IsOptional()
  @IsString()
  providerTransactionRef!: string | null;

  @IsOptional()
  @IsDateString()
  paidAt!: string | null;

  @ValidateNested({ each: true })
  @Type(() => RefundDto)
  refunds!: RefundDto[];

  @ValidateNested({ each: true })
  @Type(() => PaymentEventDto)
  events!: PaymentEventDto[];

  @IsDateString()
  createdAt!: string;

  @IsDateString()
  updatedAt!: string;
}

/** Kashier only reads the status code; the body follows our envelope. */
export class WebhookReceivedDto {
  @IsBoolean()
  received!: boolean;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function toRefundDto(refund: PaymentRefund): RefundDto {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    orderId: refund.orderId,
    sellerOrderId: refund.sellerOrderId,
    amount: refund.amount.toString(),
    reason: refund.reason,
    status: refund.status,
    providerRefundRef: refund.providerRefundRef,
    recordedByUserId: refund.recordedByUserId,
    recordedAt: iso(refund.recordedAt),
    createdAt: refund.createdAt.toISOString(),
  };
}

export function toAdminPaymentDto({ payment, refunds, events }: AdminPaymentView): AdminPaymentDto {
  return {
    id: payment.id,
    orderId: payment.orderId,
    method: payment.method,
    status: payment.status,
    amount: payment.amount.toString(),
    collectedAmount: payment.collectedAmount.toString(),
    refundedAmount: payment.refundedAmount.toString(),
    providerOrderRef: payment.session?.id ?? null,
    providerTransactionRef: payment.providerTransactionRef,
    paidAt: iso(payment.paidAt),
    refunds: refunds.map(toRefundDto),
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      signatureValid: event.signatureValid,
      processedAt: iso(event.processedAt),
      createdAt: event.createdAt.toISOString(),
    })),
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}
