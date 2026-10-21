import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ImageDto, toImageDto } from '../../media';
import { MessageKind, SenderRole, TicketCategory, TicketStatus } from '../enums';
import { type MessageView, type TicketView } from '../service/support-view.service';

/* Response DTOs for spec 16 §4 (decorators describe the OpenAPI shape only). */

export class TicketOrderDto {
  @IsUUID()
  id!: string;

  @IsString()
  orderNumber!: string;
}

export class TicketSummaryDto {
  @IsUUID()
  id!: string;

  @IsString()
  ticketNumber!: string;

  @IsIn(Object.values(TicketCategory))
  category!: TicketCategory;

  @IsString()
  subject!: string;

  @IsIn(Object.values(TicketStatus))
  status!: TicketStatus;

  // Nullable: no order link.
  @IsOptional()
  @ValidateNested()
  @Type(() => TicketOrderDto)
  order!: TicketOrderDto | null;

  // Nullable: no seller order link.
  @IsOptional()
  @IsUUID()
  sellerOrderId!: string | null;

  @IsISO8601()
  lastMessageAt!: string;

  /** For the caller: a reply from the other side since they last read the ticket. */
  @IsBoolean()
  hasUnread!: boolean;

  @IsISO8601()
  createdAt!: string;
}

export class TicketSenderDto {
  @IsIn(Object.values(SenderRole))
  role!: SenderRole;

  @IsBoolean()
  isMe!: boolean;

  /** Users see every admin and the server as "Nile Support" (SU-3); admins see admins by email (SU-7). */
  @IsString()
  displayName!: string;
}

export class TicketMessageDto {
  @IsUUID()
  id!: string;

  @IsIn(Object.values(MessageKind))
  kind!: MessageKind;

  @ValidateNested()
  @Type(() => TicketSenderDto)
  sender!: TicketSenderDto;

  @IsString()
  body!: string;

  /** Presigned, private, short-lived: refetch the messages instead of storing the URLs (ME-1). */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  attachments!: ImageDto[];

  @IsISO8601()
  createdAt!: string;
}

export function toTicketSummaryDto(view: TicketView): TicketSummaryDto {
  const { ticket } = view;
  return {
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    category: ticket.category,
    subject: ticket.subject,
    status: ticket.status,
    order: ticket.orderId && view.orderNumber ? { id: ticket.orderId, orderNumber: view.orderNumber } : null,
    sellerOrderId: ticket.sellerOrderId,
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    hasUnread: view.hasUnread,
    createdAt: ticket.createdAt.toISOString(),
  };
}

export function toTicketMessageDto(view: MessageView): TicketMessageDto {
  return {
    id: view.message.id,
    kind: view.message.kind,
    sender: { role: view.message.senderRole, isMe: view.isMe, displayName: view.displayName },
    body: view.message.body,
    attachments: view.attachments.map(toImageDto),
    createdAt: view.message.createdAt.toISOString(),
  };
}
