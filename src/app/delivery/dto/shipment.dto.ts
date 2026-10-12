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
import { FieldType, FilterOp, IsMoney, type ListSpec, UuidField } from '../../../lib/http';
import { AttemptFailureReason, DeliveryActorRole, ShipmentStatus } from '../enums';
import { amountToCollect } from '../model/shipment.model';
import { type ShipmentView } from '../service/shipment-view.service';

/* Spec 11 §4.2 / §4.3 shipment DTOs. Response classes describe the OpenAPI shape. */

export class ShipmentIdParamsDto {
  @UuidField()
  shipmentId!: string;
}

/** `POST /admin/shipments/:shipmentId/assign` (UC-DE-4). */
export class AssignShipmentDto {
  @UuidField()
  agentId!: string;
}

/** §4.3 whitelist for `GET /admin/shipments`. */
export const ADMIN_SHIPMENT_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(ShipmentStatus),
    },
    agentId: { column: 'agent_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    orderId: { column: 'order_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    createdAt: {
      column: 'created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
  },
  defaultSort: '-createdAt',
};

export class ShipmentPickupDto {
  @IsString()
  businessName!: string;

  @IsString()
  phone!: string;

  @IsUUID()
  governorateId!: string;

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
  landmark!: string | null;
}

export class ShipmentDropoffDto {
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

export class ShipmentAttemptDto {
  @IsInt()
  attemptNumber!: number;

  @IsIn(Object.values(AttemptFailureReason))
  reason!: AttemptFailureReason;

  @IsOptional()
  @IsString()
  note!: string | null;

  @IsDateString()
  createdAt!: string;
}

/** The agent's view of a shipment (spec 11 §4.2). */
export class AgentShipmentDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  sellerOrderId!: string;

  @IsString()
  orderNumber!: string;

  @IsIn(Object.values(ShipmentStatus))
  status!: ShipmentStatus;

  @IsIn(['cod', 'kashier'])
  paymentMethod!: 'cod' | 'kashier';

  @ValidateNested()
  @Type(() => ShipmentPickupDto)
  pickup!: ShipmentPickupDto;

  @ValidateNested()
  @Type(() => ShipmentDropoffDto)
  dropoff!: ShipmentDropoffDto;

  @IsMoney()
  codItemsAmount!: string;

  @IsMoney()
  codFeeAmount!: string;

  /** COD: items + fee if this shipment carries it. Kashier: "0.00". */
  @IsMoney()
  amountToCollect!: string;

  @IsInt()
  attemptCount!: number;

  @ValidateNested({ each: true })
  @Type(() => ShipmentAttemptDto)
  attempts!: ShipmentAttemptDto[];

  @IsOptional()
  @IsDateString()
  assignedAt!: string | null;

  @IsOptional()
  @IsDateString()
  pickedUpAt!: string | null;

  @IsOptional()
  @IsDateString()
  deliveredAt!: string | null;
}

export class ShipmentHistoryDto {
  @IsOptional()
  @IsString()
  fromStatus!: string | null;

  @IsString()
  toStatus!: string;

  @IsIn(Object.values(DeliveryActorRole))
  actorRole!: string;

  @IsOptional()
  @IsUUID()
  actorUserId!: string | null;

  @IsOptional()
  @IsString()
  reason!: string | null;

  @IsDateString()
  createdAt!: string;
}

/** The admin's view (spec 11 §4.3); the list leaves `history` out. */
export class AdminShipmentDto extends AgentShipmentDto {
  @IsUUID()
  orderId!: string;

  @IsOptional()
  @IsUUID()
  agentId!: string | null;

  @IsBoolean()
  carriesDeliveryFee!: boolean;

  @IsOptional()
  @IsMoney()
  codCollectedAmount!: string | null;

  /** The seller order was cancelled after pickup: the agent confirms the return (DE-6). */
  @IsOptional()
  @IsDateString()
  sellerOrderCancelledAt!: string | null;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ShipmentHistoryDto)
  history?: ShipmentHistoryDto[];

  @IsDateString()
  createdAt!: string;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function toAgentShipmentDto({ shipment, attempts }: ShipmentView): AgentShipmentDto {
  return {
    id: shipment.id,
    sellerOrderId: shipment.sellerOrderId,
    orderNumber: shipment.orderNumber,
    status: shipment.status,
    paymentMethod: shipment.paymentMethod,
    pickup: { ...shipment.pickup },
    dropoff: { ...shipment.dropoff },
    codItemsAmount: shipment.codItemsAmount.toString(),
    codFeeAmount: shipment.codFeeAmount.toString(),
    amountToCollect: amountToCollect(shipment).toString(),
    attemptCount: shipment.attemptCount,
    attempts: attempts.map((a) => ({
      attemptNumber: a.attemptNumber,
      reason: a.reason,
      note: a.note,
      createdAt: a.createdAt.toISOString(),
    })),
    assignedAt: iso(shipment.assignedAt),
    pickedUpAt: iso(shipment.pickedUpAt),
    deliveredAt: iso(shipment.deliveredAt),
  };
}

export function toAdminShipmentDto(view: ShipmentView, withHistory: boolean): AdminShipmentDto {
  const { shipment } = view;
  return {
    ...toAgentShipmentDto(view),
    orderId: shipment.orderId,
    agentId: shipment.agentId,
    carriesDeliveryFee: shipment.carriesDeliveryFee,
    codCollectedAmount: shipment.codCollectedAmount?.toString() ?? null,
    sellerOrderCancelledAt: iso(shipment.sellerOrderCancelledAt),
    ...(withHistory
      ? {
          history: view.history.map((h) => ({
            fromStatus: h.fromStatus,
            toStatus: h.toStatus,
            actorRole: h.actorRole,
            actorUserId: h.actorUserId,
            reason: h.reason,
            createdAt: h.createdAt.toISOString(),
          })),
        }
      : {}),
    createdAt: shipment.createdAt.toISOString(),
  };
}
