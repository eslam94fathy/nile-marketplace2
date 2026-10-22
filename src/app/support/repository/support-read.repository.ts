import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { SUPPORT_TABLES } from '../constants';

const T = SUPPORT_TABLES.TICKET_READS;

/** All SQL of `support_ticket_reads` (spec 16 §1.2 unread, UC-SU-4). */
@injectable()
export class SupportReadRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** An upsert that only moves forward: a late, older read never undoes a newer one. */
  async markRead(ticketId: string, userId: string, at: Date, trx?: DbTransaction): Promise<void> {
    await this.exec(trx).raw(
      `INSERT INTO ${T} (ticket_id, user_id, last_read_at) VALUES (?, ?, ?)
       ON CONFLICT (ticket_id, user_id)
       DO UPDATE SET last_read_at = GREATEST(${T}.last_read_at, EXCLUDED.last_read_at)`,
      [ticketId, userId, at],
    );
  }

  /** The user's read times for a page of tickets (the primary key); tickets never read are left out. */
  async findLastReads(userId: string, ticketIds: readonly string[]): Promise<Map<string, Date>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await this.db
      .knex<{ ticket_id: string; last_read_at: Date }>(T)
      .select('ticket_id', 'last_read_at')
      .whereIn('ticket_id', [...new Set(ticketIds)])
      .where('user_id', userId);
    return new Map(rows.map((row) => [row.ticket_id, row.last_read_at]));
  }
}
