import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { NOTIFICATIONS_TABLES } from '../constants';
import { type NotificationLogEntry } from '../model/notification-log.model';

const T = NOTIFICATIONS_TABLES.NOTIFICATION_LOG;

@injectable()
export class NotificationLogRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** EXISTS on `uq_notification_log_source_event_id` (G22): this event's email already has a final outcome. */
  async existsForEvent(sourceEventId: string, trx?: DbTransaction): Promise<boolean> {
    const result = await this.exec(trx).raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE source_event_id = ?) AS "exists"`,
      [sourceEventId],
    );
    return result.rows[0]?.exists === true;
  }

  /** Idempotent on `source_event_id`: false if a row for this event already existed. */
  async insert(entry: NotificationLogEntry, trx: DbTransaction): Promise<boolean> {
    const inserted = await trx(T)
      .insert({
        user_id: entry.userId,
        template: entry.template,
        to_email: entry.toEmail,
        status: entry.status,
        provider_message_id: entry.providerMessageId,
        error: entry.error,
        source_event_id: entry.sourceEventId,
      })
      .onConflict('source_event_id')
      .ignore()
      .returning<{ id: string }[]>('id');
    return inserted.length === 1;
  }
}
