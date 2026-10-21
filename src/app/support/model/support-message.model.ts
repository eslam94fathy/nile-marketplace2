import { type MessageKind, type SenderRole } from '../enums';

/** A row of `support_messages` (spec 16 §1). Append-only. */
export interface SupportMessage {
  id: string;
  ticketId: string;
  kind: MessageKind;
  /** Null exactly for system lines. */
  senderUserId: string | null;
  senderRole: SenderRole;
  body: string;
  createdAt: Date;
}

export type NewSupportMessage = Omit<SupportMessage, 'id' | 'createdAt'>;
