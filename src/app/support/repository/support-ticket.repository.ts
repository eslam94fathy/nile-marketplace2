import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { SUPPORT_TABLES } from '../constants';
import {
  type TicketCategory,
  type TicketOpenerRole,
  TicketStatus,
  WAITING_FOR_ADMIN_STATUSES,
} from '../enums';
import { type SupportStats, type SupportTicket } from '../model/support-ticket.model';

const T = SUPPORT_TABLES.TICKETS;
const COLUMNS = [
  'id',
  'ticket_number',
  'opener_user_id',
  'opener_role',
  'category',
  'subject',
  'status',
  'order_id',
  'seller_order_id',
  'assigned_admin_user_id',
  'last_message_at',
  'last_user_message_at',
  'last_admin_message_at',
  'awaiting_admin_since',
  'sla_breached_at',
  'resolved_at',
  'closed_at',
  'created_at',
] as const;

interface SupportTicketRow {
  id: string;
  ticket_number: string;
  opener_user_id: string;
  opener_role: TicketOpenerRole;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  order_id: string | null;
  seller_order_id: string | null;
  assigned_admin_user_id: string | null;
  last_message_at: Date;
  last_user_message_at: Date;
  last_admin_message_at: Date | null;
  awaiting_admin_since: Date | null;
  sla_breached_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toModel(row: Pick<SupportTicketRow, (typeof COLUMNS)[number]>): SupportTicket {
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    openerUserId: row.opener_user_id,
    openerRole: row.opener_role,
    category: row.category,
    subject: row.subject,
    status: row.status,
    orderId: row.order_id,
    sellerOrderId: row.seller_order_id,
    assignedAdminUserId: row.assigned_admin_user_id,
    lastMessageAt: row.last_message_at,
    lastUserMessageAt: row.last_user_message_at,
    lastAdminMessageAt: row.last_admin_message_at,
    awaitingAdminSince: row.awaiting_admin_since,
    slaBreachedAt: row.sla_breached_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

/** All SQL of `support_tickets` (spec 16). */
@injectable()
export class SupportTicketRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async findById(id: string, trx?: DbTransaction): Promise<SupportTicket | undefined> {
    const row = await this.exec(trx)<SupportTicketRow>(T)
      .select(...COLUMNS)
      .where({ id })
      .first();
    return row ? toModel(row) : undefined;
  }

  /** Existence on the primary key, optionally of one opener's ticket (G22). */
  async exists(id: string, openerUserId?: string): Promise<boolean> {
    const query = this.db.knex(T).select(this.db.knex.raw('1')).where({ id });
    if (openerUserId !== undefined) query.andWhere({ opener_user_id: openerUserId });
    const result = await this.db.knex.raw<{ rows: { exists: boolean }[] }>('SELECT EXISTS (?) AS "exists"', [
      query,
    ]);
    return result.rows[0]?.exists ?? false;
  }

  /**
   * One aggregate over the waiting tickets, served by the partial index on (awaiting_admin_since, id)
   * WHERE status IN ('open','awaiting_admin').
   */
  async getStats(): Promise<SupportStats> {
    const row = await this.db
      .knex(T)
      .whereIn('status', WAITING_FOR_ADMIN_STATUSES)
      .first<{ open: string; awaiting_admin: string; sla_breached: string }>(
        this.db.knex.raw('count(*) FILTER (WHERE status = ?) AS open', [TicketStatus.OPEN]),
        this.db.knex.raw('count(*) FILTER (WHERE status = ?) AS awaiting_admin', [
          TicketStatus.AWAITING_ADMIN,
        ]),
        this.db.knex.raw('count(*) FILTER (WHERE sla_breached_at IS NOT NULL) AS sla_breached'),
      );
    return {
      open: Number(row?.open ?? 0),
      awaitingAdmin: Number(row?.awaiting_admin ?? 0),
      slaBreached: Number(row?.sla_breached ?? 0),
    };
  }
}
