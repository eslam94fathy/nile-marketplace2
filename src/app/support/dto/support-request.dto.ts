import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsUUID, ValidateIf } from 'class-validator';
import {
  FieldType,
  FilterOp,
  type ListSpec,
  Nullable,
  Optional,
  StrField,
  UuidField,
} from '../../../lib/http';
import { SUPPORT_LIMITS } from '../constants';
import { TicketCategory, TicketOpenerRole, TicketStatus } from '../enums';

const CATEGORIES = Object.values(TicketCategory);
const STATUSES = Object.values(TicketStatus);

export class TicketIdParamsDto {
  @UuidField()
  ticketId!: string;
}

/** The body and up to 3 private images (spec 16 §1 limits, R-9). */
export class PostMessageDto {
  @StrField(SUPPORT_LIMITS.BODY_MIN, SUPPORT_LIMITS.BODY_MAX)
  body!: string;

  @Optional()
  @IsArray()
  @ArrayMaxSize(SUPPORT_LIMITS.MAX_ATTACHMENTS)
  @ArrayUnique()
  @IsUUID('7', { each: true })
  attachmentMediaIds?: string[];
}

abstract class OpenTicketDto extends PostMessageDto {
  /** `seller_onboarding` from a customer is a 422, decided by the service (SUPPORT_CATEGORY_NOT_ALLOWED). */
  @IsIn(CATEGORIES)
  category!: TicketCategory;

  @StrField(SUPPORT_LIMITS.SUBJECT_MIN, SUPPORT_LIMITS.SUBJECT_MAX)
  subject!: string;
}

/** `POST /support/tickets` as a customer: a `sellerOrderId` needs its `orderId` (spec 16 §4.1). */
export class CustomerOpenTicketDto extends OpenTicketDto {
  @ValidateIf((dto: CustomerOpenTicketDto) => dto.orderId !== undefined || dto.sellerOrderId !== undefined)
  @UuidField()
  orderId?: string;

  @Optional()
  @UuidField()
  sellerOrderId?: string;
}

/** `POST /support/tickets` as a seller: a seller order only; `orderId` is an unknown key (400). */
export class SellerOpenTicketDto extends OpenTicketDto {
  @Optional()
  @UuidField()
  sellerOrderId?: string;
}

/** Spec 16 §4.1 whitelist for `GET /support/tickets`. */
export const USER_TICKET_LIST_SPEC: ListSpec = {
  fields: {
    status: { column: 'status', type: FieldType.ENUM, ops: [FilterOp.EQ, FilterOp.IN], enumValues: STATUSES },
    category: {
      column: 'category',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: CATEGORIES,
    },
    lastMessageAt: { column: 'last_message_at', type: FieldType.DATE, ops: [], sortable: true },
    createdAt: {
      column: 'created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
  },
  defaultSort: '-lastMessageAt',
};

/** A ticket's timeline: newest first by default, the client reverses (spec 16 §4). */
export const MESSAGE_LIST_SPEC: ListSpec = {
  fields: { createdAt: { column: 'created_at', type: FieldType.DATE, ops: [], sortable: true } },
  defaultSort: '-createdAt',
};

/** `POST /admin/support/tickets/:ticketId/messages`: `internal` writes a note (absent = a public reply). */
export class AdminPostMessageDto extends PostMessageDto {
  @Optional()
  @IsBoolean()
  internal?: boolean;
}

/** `adminUserId` is required: an active admin, or `null` to unassign. */
export class AssignTicketDto {
  @Nullable()
  @UuidField()
  adminUserId!: string | null;
}

/**
 * Spec 16 §4.2 whitelist for `GET /admin/support/tickets`. `assigned` and `slaBreached` have no column
 * (custom filters); sorting on `awaitingAdminSince` lists only tickets waiting for an admin.
 */
export const ADMIN_TICKET_LIST_SPEC: ListSpec = {
  fields: {
    ...USER_TICKET_LIST_SPEC.fields,
    openerRole: {
      column: 'opener_role',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(TicketOpenerRole),
    },
    assignedAdminId: { column: 'assigned_admin_user_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    assigned: { type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
    slaBreached: { type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
    awaitingAdminSince: { column: 'awaiting_admin_since', type: FieldType.DATE, ops: [], sortable: true },
  },
  defaultSort: '-lastMessageAt',
};
