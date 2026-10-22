import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsMoney } from '../../../lib/http';
import { ImageDto, toImageDto } from '../../media';
import {
  RefundPayoutMethod,
  ReturnActorRole,
  ReturnFeePayer,
  ReturnReason,
  ReturnRefusalReason,
  ReturnStatus,
} from '../enums';
import { type ReturnableItemsView } from '../service/return-request.service';
import { type ReturnView } from '../service/return-view.service';

/* Response DTOs for spec 18 §4 (decorators describe the OpenAPI shape only). */

const STATUSES = Object.values(ReturnStatus);

export class ReturnItemAttributeDto {
  @IsString()
  attribute!: string;

  @IsString()
  value!: string;
}

export class ReturnItemDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  orderItemId!: string;

  /** Snapshot at checkout. */
  @IsString()
  productName!: string;

  @ValidateNested({ each: true })
  @Type(() => ReturnItemAttributeDto)
  attributes!: ReturnItemAttributeDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageDto)
  image!: ImageDto | null;

  @IsInt()
  quantity!: number;

  /** What the customer paid for these units: their price less their coupon share (indicative per line). */
  @IsMoney()
  paidAmount!: string;

  /** The seller's choice at receipt; null until the return completes. */
  @IsOptional()
  @IsBoolean()
  restock!: boolean | null;
}

export class ReturnTimelineEntryDto {
  @IsIn(STATUSES)
  status!: ReturnStatus;

  @IsDateString()
  at!: string;
}

/** The customer's refund for this return (payments, spec 10 §8.5); null until there is one. */
export class ReturnRefundDto {
  @IsIn(['pending', 'processing', 'succeeded', 'manual'])
  status!: 'pending' | 'processing' | 'succeeded' | 'manual';

  @IsMoney()
  amount!: string;

  @IsOptional()
  @IsDateString()
  refundedAt!: string | null;
}

/** The seller's view (spec 18 §4.2): no refund, no customer contact, no payout method (S-11). */
export class SellerReturnDto {
  @IsUUID()
  id!: string;

  @IsString()
  returnNumber!: string;

  @IsUUID()
  orderId!: string;

  @IsString()
  orderNumber!: string;

  @IsUUID()
  sellerOrderId!: string;

  @IsIn(STATUSES)
  status!: ReturnStatus;

  @IsIn(Object.values(ReturnReason))
  reason!: ReturnReason;

  @IsOptional()
  @IsString()
  description!: string | null;

  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items!: ReturnItemDto[];

  /** Private images, short-lived URLs (spec 14 ME-1). */
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  photos!: ImageDto[];

  @IsMoney()
  returnFee!: string;

  @IsIn(Object.values(ReturnFeePayer))
  returnFeePayer!: ReturnFeePayer;

  /** Estimated until completed, then final. */
  @IsMoney()
  refundAmount!: string;

  @IsOptional()
  @IsDateString()
  sellerDecisionDeadlineAt!: string | null;

  @IsOptional()
  @IsDateString()
  escalationDeadlineAt!: string | null;

  @IsOptional()
  @IsDateString()
  inspectionDeadlineAt!: string | null;

  @IsOptional()
  @IsString()
  rejectionReason!: string | null;

  @IsOptional()
  @IsIn(Object.values(ReturnRefusalReason))
  refusalReason!: ReturnRefusalReason | null;

  @ValidateNested({ each: true })
  @Type(() => ReturnTimelineEntryDto)
  timeline!: ReturnTimelineEntryDto[];

  @IsDateString()
  createdAt!: string;
}

/** The customer's view (spec 18 §4.1). */
export class ReturnDto extends SellerReturnDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ReturnRefundDto)
  refund!: ReturnRefundDto | null;
}

export class ReturnHistoryEntryDto {
  @IsOptional()
  @IsIn(STATUSES)
  from!: ReturnStatus | null;

  @IsIn(STATUSES)
  to!: ReturnStatus;

  @IsIn(Object.values(ReturnActorRole))
  actorRole!: ReturnActorRole;

  @IsOptional()
  @IsUUID()
  actorUserId!: string | null;

  @IsOptional()
  @IsString()
  reason!: string | null;

  @IsDateString()
  at!: string;
}

/** The admin view (spec 18 §4.3): the payout details themselves live in the payments refund queue. */
export class AdminReturnDto extends ReturnDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  sellerId!: string;

  @IsOptional()
  @IsUUID()
  agentId!: string | null;

  @IsOptional()
  @IsIn(Object.values(RefundPayoutMethod))
  payoutMethod!: RefundPayoutMethod | null;

  @ValidateNested({ each: true })
  @Type(() => ReturnHistoryEntryDto)
  history!: ReturnHistoryEntryDto[];
}

export class ReturnableItemDto {
  @IsUUID()
  orderItemId!: string;

  @IsInt()
  returnable!: number;

  /** Indicative: the exact share of `k` units comes from the amount rule (spec 09 §8.7). */
  @IsMoney()
  paidUnitAmount!: string;
}

/** `GET /orders/:orderId/seller-orders/:sellerOrderId/returnable-items` (spec 18 §4.1). */
export class ReturnableItemsDto {
  @IsDateString()
  windowEndsAt!: string;

  @ValidateNested({ each: true })
  @Type(() => ReturnableItemDto)
  items!: ReturnableItemDto[];

  /** The current fee of the customer's governorate: the seller pays it for a seller-fault reason. */
  @IsMoney()
  returnFee!: string;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function toSellerReturnDto(view: ReturnView): SellerReturnDto {
  const { request } = view;
  return {
    id: request.id,
    returnNumber: request.returnNumber,
    orderId: request.orderId,
    orderNumber: view.orderNumber,
    sellerOrderId: request.sellerOrderId,
    status: request.status,
    reason: request.reason,
    description: request.description,
    items: view.items.map(({ item, snapshot, image }) => ({
      id: item.id,
      orderItemId: item.orderItemId,
      productName: snapshot.productName,
      attributes: snapshot.attributes.map(({ attribute, value }) => ({ attribute, value })),
      image: image ? toImageDto(image) : null,
      quantity: item.quantity,
      paidAmount: snapshot.unitPrice
        .timesQuantity(item.quantity)
        .minus(snapshot.discountOriginal.timesRatio(item.quantity, snapshot.quantity))
        .toString(),
      restock: item.restock,
    })),
    photos: view.photos.map(toImageDto),
    returnFee: request.returnFee.toString(),
    returnFeePayer: request.returnFeePayer,
    refundAmount: request.refundAmount.toString(),
    sellerDecisionDeadlineAt: iso(request.sellerDecisionDeadlineAt),
    escalationDeadlineAt: iso(request.escalationDeadlineAt),
    inspectionDeadlineAt: iso(request.inspectionDeadlineAt),
    rejectionReason: request.rejectionReason,
    refusalReason: request.refusalReason,
    timeline: view.history.map((entry) => ({ status: entry.toStatus, at: entry.createdAt.toISOString() })),
    createdAt: request.createdAt.toISOString(),
  };
}

/** `refund` comes from payments.getRefundsByReturnIds (spec 10 §8.5). */
export function toReturnDto(view: ReturnView): ReturnDto {
  const { refund } = view;
  return {
    ...toSellerReturnDto(view),
    refund: refund
      ? { status: refund.status, amount: refund.amount.toString(), refundedAt: iso(refund.refundedAt) }
      : null,
  };
}

export function toAdminReturnDto(view: ReturnView): AdminReturnDto {
  const { request } = view;
  return {
    ...toReturnDto(view),
    customerId: request.customerId,
    sellerId: request.sellerId,
    agentId: request.agentId,
    payoutMethod: request.refundPayoutMethod,
    history: view.history.map((entry) => ({
      from: entry.fromStatus,
      to: entry.toStatus,
      actorRole: entry.actorRole,
      actorUserId: entry.actorUserId,
      reason: entry.reason,
      at: entry.createdAt.toISOString(),
    })),
  };
}

export function toReturnableItemsDto(view: ReturnableItemsView): ReturnableItemsDto {
  return {
    windowEndsAt: view.windowEndsAt.toISOString(),
    items: view.items.map((item) => ({
      orderItemId: item.orderItemId,
      returnable: item.returnable,
      paidUnitAmount: item.paidUnitAmount.toString(),
    })),
    returnFee: view.returnFee.toString(),
  };
}
