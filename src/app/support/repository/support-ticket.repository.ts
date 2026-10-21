import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { SUPPORT_TABLES, TICKET_NUMBER } from '../constants';
import {
  type TicketCategory,
  type TicketOpenerRole,
  TicketStatus,
  UNFINISHED_STATUSES,
  WAITING_FOR_ADMIN_STATUSES,
} from '../enums';
import { type NewSupportTicket, type SupportStats, type SupportTicket } from '../model/support-ticket.model';
import { type TicketPatch } from '../service/ticket-transitions';

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

export interface AdminTicketFilters {
  assigned?: boolean;
  slaBreached?: boolean;
  waitingOnly: boolean;
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

  /** UC-SU-1: a new `open` ticket, numbered from the sequence in the INSERT (SU-16). */
  async insert(ticket: NewSupportTicket, trx: DbTransaction): Promise<SupportTicket> {
    const [row] = await trx<SupportTicketRow>(T)
      .insert({
        ticket_number: trx.raw(`? || lpad(nextval(?)::text, ?, '0')`, [
          TICKET_NUMBER.PREFIX,
          TICKET_NUMBER.SEQUENCE,
          TICKET_NUMBER.DIGITS,
        ]),
        opener_user_id: ticket.openerUserId,
        opener_role: ticket.openerRole,
        category: ticket.category,
        subject: ticket.subject,
        status: TicketStatus.OPEN,
        order_id: ticket.orderId,
        seller_order_id: ticket.sellerOrderId,
        assigned_admin_user_id: null,
        last_message_at: ticket.at,
        last_user_message_at: ticket.at,
        last_admin_message_at: null,
        awaiting_admin_since: ticket.at,
        sla_breached_at: null,
        resolved_at: null,
        closed_at: null,
      })
      .returning(COLUMNS);
    if (!row) throw new Error('support ticket insert returned no row');
    return toModel(row);
  }

  /**
   * The ticket row `FOR UPDATE` (UC-SU-2, UC-SU-3: lock order ticket → media rows). With
   * `openerUserId`, another user's ticket reads as missing; with `skipLocked`, a held one too.
   */
  async lockById(
    id: string,
    trx: DbTransaction,
    options: { openerUserId?: string; skipLocked?: boolean } = {},
  ): Promise<SupportTicket | undefined> {
    const query = trx<SupportTicketRow>(T)
      .select(...COLUMNS)
      .where({ id })
      .forUpdate();
    if (options.openerUserId !== undefined) query.andWhere({ opener_user_id: options.openerUserId });
    // Jobs skip a ticket another transaction holds: the next run picks it up (P5-Q5 pattern).
    if (options.skipLocked) query.skipLocked();
    const row = await query.first();
    return row ? toModel(row) : undefined;
  }

  async update(id: string, patch: TicketPatch, trx: DbTransaction): Promise<SupportTicket> {
    const columns: Partial<Record<keyof SupportTicketRow, unknown>> = {
      status: patch.status,
      assigned_admin_user_id: patch.assignedAdminUserId,
      last_message_at: patch.lastMessageAt,
      last_user_message_at: patch.lastUserMessageAt,
      last_admin_message_at: patch.lastAdminMessageAt,
      awaiting_admin_since: patch.awaitingAdminSince,
      sla_breached_at: patch.slaBreachedAt,
      resolved_at: patch.resolvedAt,
      closed_at: patch.closedAt,
    };
    const set = Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
    const [row] = await trx<SupportTicketRow>(T)
      .where({ id })
      .update({ ...set, updated_at: trx.fn.now() })
      .returning(COLUMNS);
    if (!row) throw new Error(`support ticket ${id} vanished under its lock`);
    return toModel(row);
  }

  /**
   * The opener's tickets neither resolved nor closed (the open-ticket limit, UC-SU-1). A soft check
   * without a lock (SU-4); few rows per user on idx_support_tickets_opener_user_id_last_message_at_id.
   */
  async countUnfinished(openerUserId: string, trx: DbTransaction): Promise<number> {
    const row = await trx(T)
      .where({ opener_user_id: openerUserId })
      .whereIn('status', UNFINISHED_STATUSES)
      .first<{ count: string }>(trx.raw('count(*) AS count'));
    return Number(row?.count ?? 0);
  }

  /** A keyset page of one opener's tickets (idx_support_tickets_opener_user_id_last_message_at_id). */
  async listForOpener(openerUserId: string, query: ParsedListQuery): Promise<SupportTicket[]> {
    const qb = this.db
      .knex<SupportTicketRow>(T)
      .select(...COLUMNS)
      .where({ opener_user_id: openerUserId });
    const rows = (await applyListQuery(qb, query, 'id')) as SupportTicketRow[];
    return rows.map(toModel);
  }

  /**
   * A keyset page of the admin queue (spec 16 §4.2). `assigned` and `slaBreached` are custom filters;
   * `waitingOnly` restricts to open / awaiting_admin, where `awaiting_admin_since` is set (the sort of the
   * oldest-waiting queue, idx_support_tickets_awaiting_admin_since_id).
   */
  async listForAdmin(query: ParsedListQuery, filters: AdminTicketFilters): Promise<SupportTicket[]> {
    const qb = this.db.knex<SupportTicketRow>(T).select(...COLUMNS);
    if (filters.waitingOnly) qb.whereIn('status', WAITING_FOR_ADMIN_STATUSES);
    if (filters.assigned === true) qb.whereNotNull('assigned_admin_user_id');
    if (filters.assigned === false) qb.whereNull('assigned_admin_user_id');
    // Breached = waiting now with the flag of the current wait set (SU-11).
    if (filters.slaBreached === true) {
      qb.whereIn('status', WAITING_FOR_ADMIN_STATUSES).whereNotNull('sla_breached_at');
    }
    if (filters.slaBreached === false) {
      qb.where((w) => {
        void w.whereNull('sla_breached_at').orWhereNotIn('status', WAITING_FOR_ADMIN_STATUSES);
      });
    }
    const rows = (await applyListQuery(qb, query, 'id')) as SupportTicketRow[];
    return rows.map(toModel);
  }

  /** One ticket of an opener; another user's reads as missing (conventions §3). */
  async findForOpener(id: string, openerUserId: string): Promise<SupportTicket | undefined> {
    const row = await this.db
      .knex<SupportTicketRow>(T)
      .select(...COLUMNS)
      .where({ id, opener_user_id: openerUserId })
      .first();
    return row ? toModel(row) : undefined;
  }

  /**
   * Auto-close candidates (UC-SU-5), read without locks: resolved before the cutoff, oldest first
   * (idx_support_tickets_resolved_at).
   */
  async findResolvedBefore(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .knex<SupportTicketRow>(T)
      .select('id')
      .where({ status: TicketStatus.RESOLVED })
      .andWhere('resolved_at', '<', cutoff)
      .orderBy([{ column: 'resolved_at' }, { column: 'id' }])
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * SLA candidates (UC-SU-5), read without locks: waiting for an admin since before the cutoff and not
   * flagged in this wait yet, longest wait first (idx_support_tickets_awaiting_admin_since_id).
   */
  async findWaitingSince(cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .knex<SupportTicketRow>(T)
      .select('id')
      .whereIn('status', WAITING_FOR_ADMIN_STATUSES)
      .andWhere('awaiting_admin_since', '<', cutoff)
      .whereNull('sla_breached_at')
      .orderBy([{ column: 'awaiting_admin_since' }, { column: 'id' }])
      .limit(limit);
    return rows.map((row) => row.id);
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
