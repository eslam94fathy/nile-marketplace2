import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';
import {
  EmailField,
  FieldType,
  FilterOp,
  type ListSpec,
  Optional,
  PatchDto,
  PhoneField,
  StrField,
  UuidField,
} from '../../../lib/http';
import { AgentStatus } from '../enums';
import { type AgentView } from '../model/delivery-agent.model';

/* Spec 11 §4.2 (agent) and §4.3 (admin) agent DTOs. Response classes describe the OpenAPI shape. */

export const AGENT_FULL_NAME_MAX_LENGTH = 100;

/** `POST /admin/delivery-agents` (UC-DE-6). */
export class CreateAgentDto {
  @EmailField()
  email!: string;

  @StrField(1, AGENT_FULL_NAME_MAX_LENGTH)
  fullName!: string;

  @PhoneField()
  phone!: string;

  @UuidField()
  homeGovernorateId!: string;
}

/** `PATCH /admin/delivery-agents/:agentId`: at least one field. */
export class UpdateAgentDto extends PatchDto {
  @Optional()
  @StrField(1, AGENT_FULL_NAME_MAX_LENGTH)
  fullName?: string;

  @Optional()
  @PhoneField()
  phone?: string;

  @Optional()
  @UuidField()
  homeGovernorateId?: string;
}

/** `PATCH /agent/availability` (UC-DE-2). */
export class AvailabilityDto {
  @IsBoolean()
  onShift!: boolean;
}

export class AgentIdParamsDto {
  @UuidField()
  agentId!: string;
}

/** §4.3 whitelist for `GET /admin/delivery-agents`. */
export const ADMIN_AGENT_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(AgentStatus),
    },
    onShift: { column: 'on_shift', type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
    homeGovernorateId: { column: 'home_governorate_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    fullName: { column: 'full_name', type: FieldType.TEXT, ops: [FilterOp.LIKE] },
    createdAt: {
      column: 'created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
  },
  defaultSort: '-createdAt',
};

export class AgentProfileDto {
  @IsUUID()
  id!: string;

  @IsEmail()
  email!: string;

  @IsString()
  fullName!: string;

  @IsString()
  phone!: string;

  @IsUUID()
  homeGovernorateId!: string;

  @IsIn(Object.values(AgentStatus))
  status!: AgentStatus;

  @IsBoolean()
  onShift!: boolean;

  @IsInt()
  activeShipmentCount!: number;
}

export class AdminAgentDto extends AgentProfileDto {
  @IsOptional()
  @IsDateString()
  lastAssignedAt!: string | null;

  /** The login's status in identity (invited, active, suspended). */
  @IsString()
  userStatus!: string;

  @IsDateString()
  createdAt!: string;
}

export function toAgentProfileDto(view: AgentView): AgentProfileDto {
  const { agent } = view;
  return {
    id: agent.id,
    email: view.email,
    fullName: agent.fullName,
    phone: agent.phone,
    homeGovernorateId: agent.homeGovernorateId,
    status: agent.status,
    onShift: agent.onShift,
    activeShipmentCount: view.activeShipmentCount,
  };
}

export function toAdminAgentDto(view: AgentView): AdminAgentDto {
  return {
    ...toAgentProfileDto(view),
    lastAssignedAt: view.agent.lastAssignedAt?.toISOString() ?? null,
    userStatus: view.userStatus,
    createdAt: view.agent.createdAt.toISOString(),
  };
}
