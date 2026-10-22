import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { SUPPORT_TABLES } from '../constants';
import { MessageKind, type SenderRole } from '../enums';
import { type NewSupportMessage, type SupportMessage } from '../model/support-message.model';

const T = SUPPORT_TABLES.MESSAGES;
const COLUMNS = ['id', 'ticket_id', 'kind', 'sender_user_id', 'sender_role', 'body', 'created_at'] as const;

interface SupportMessageRow {
  id: string;
  ticket_id: string;
  kind: MessageKind;
  sender_user_id: string | null;
  sender_role: SenderRole;
  body: string;
  created_at: Date;
}

function toModel(row: SupportMessageRow): SupportMessage {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: row.kind,
    senderUserId: row.sender_user_id,
    senderRole: row.sender_role,
    body: row.body,
    createdAt: row.created_at,
  };
}

/** All SQL of `support_messages` (spec 16). Append-only: no update or delete. */
@injectable()
export class SupportMessageRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** One multi-row insert, in the given order (a message, then its system line, share one `now()`). */
  async insertMany(messages: readonly NewSupportMessage[], trx: DbTransaction): Promise<SupportMessage[]> {
    if (messages.length === 0) return [];
    const rows = await trx<SupportMessageRow>(T)
      .insert(
        messages.map((m) => ({
          ticket_id: m.ticketId,
          kind: m.kind,
          sender_user_id: m.senderUserId,
          sender_role: m.senderRole,
          body: m.body,
        })),
      )
      .returning(COLUMNS);
    return rows.map(toModel);
  }

  /**
   * A keyset page of a ticket's timeline (idx_support_messages_ticket_id_created_at_id). Users never
   * get internal notes.
   */
  async listForTicket(
    ticketId: string,
    query: ParsedListQuery,
    includeInternalNotes: boolean,
  ): Promise<SupportMessage[]> {
    const qb = this.db
      .knex<SupportMessageRow>(T)
      .select(...COLUMNS)
      .where({ ticket_id: ticketId });
    if (!includeInternalNotes) qb.whereNot({ kind: MessageKind.INTERNAL_NOTE });
    const rows = (await applyListQuery(qb, query, 'id')) as SupportMessageRow[];
    return rows.map(toModel);
  }
}
