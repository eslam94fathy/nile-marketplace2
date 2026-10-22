import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { NOTIFICATIONS_TABLES, UNREAD_COUNT_CAP } from '../constants';
import { type NotificationCategory, type NotificationType } from '../enums';
import { type NewUserNotification, type UserNotification } from '../model/user-notification.model';

const T = NOTIFICATIONS_TABLES.USER_NOTIFICATIONS;
const COLUMNS = [
  'id',
  'user_id',
  'category',
  'type',
  'title',
  'body',
  'link',
  'source_event_id',
  'read_at',
  'created_at',
] as const;

interface UserNotificationRow {
  id: string;
  user_id: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  source_event_id: string;
  read_at: Date | null;
  push_sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toModel(row: Pick<UserNotificationRow, (typeof COLUMNS)[number]>): UserNotification {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    sourceEventId: row.source_event_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** All SQL of `user_notifications` (spec 13 §8). */
@injectable()
export class UserNotificationRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /**
   * One multi-row insert; rows already there for (user, event) are skipped (UC-NO-2). Returns only the
   * rows this call inserted, so a redelivered event announces nothing twice.
   */
  async insertMany(rows: readonly NewUserNotification[], trx: DbTransaction): Promise<UserNotification[]> {
    if (rows.length === 0) return [];
    const inserted = await trx<UserNotificationRow>(T)
      .insert(
        rows.map((row) => ({
          user_id: row.userId,
          category: row.category,
          type: row.type,
          title: row.title,
          body: row.body,
          link: row.link,
          source_event_id: row.sourceEventId,
          read_at: null,
          push_sent_at: null,
        })),
      )
      .onConflict(['user_id', 'source_event_id'])
      .ignore()
      .returning(COLUMNS);
    return inserted.map(toModel);
  }

  /**
   * A keyset page of the user's notifications (idx_user_notifications_user_id_created_at_id, or the
   * unread partial index with `read=false`). `read` is a custom field: it filters on `read_at`.
   */
  async listForUser(
    userId: string,
    query: ParsedListQuery,
    read: boolean | undefined,
  ): Promise<UserNotification[]> {
    const qb = this.db
      .knex<UserNotificationRow>(T)
      .select(...COLUMNS)
      .where({ user_id: userId });
    if (read === true) qb.whereNotNull('read_at');
    if (read === false) qb.whereNull('read_at');
    const rows = (await applyListQuery(qb, query, 'id')) as UserNotificationRow[];
    return rows.map(toModel);
  }

  /** Counts up to the cap only (idx_user_notifications_user_id_unread): a badge, not an exact total. */
  async countUnread(userId: string): Promise<number> {
    const result = await this.db.knex.raw<{ rows: { count: number }[] }>(
      `SELECT count(*)::int AS count FROM (
         SELECT 1 FROM ${T} WHERE user_id = ? AND read_at IS NULL LIMIT ?) AS unread`,
      [userId, UNREAD_COUNT_CAP],
    );
    return result.rows[0]?.count ?? 0;
  }

  /** One notification of a user (the push sender, UC-NO-3); null when gone (retention) or another user's. */
  async findForUser(userId: string, id: string): Promise<UserNotification | null> {
    const row = await this.db
      .knex<UserNotificationRow>(T)
      .select(...COLUMNS)
      .where({ id, user_id: userId })
      .first();
    return row ? toModel(row) : null;
  }

  async markPushSent(id: string, at: Date, trx: DbTransaction): Promise<void> {
    await trx<UserNotificationRow>(T).where({ id }).update({ push_sent_at: at, updated_at: trx.fn.now() });
  }

  /** False when the user has no such notification. Reading it again changes nothing. */
  async markRead(userId: string, id: string, readAt: Date): Promise<boolean> {
    const found = await this.db.knex.raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE id = ? AND user_id = ?) AS "exists"`,
      [id, userId],
    );
    if (found.rows[0]?.exists !== true) return false;
    await this.db
      .knex<UserNotificationRow>(T)
      .where({ id, user_id: userId })
      .whereNull('read_at')
      .update({ read_at: readAt, updated_at: this.db.knex.fn.now() });
    return true;
  }

  async markAllRead(userId: string, readAt: Date): Promise<void> {
    await this.db
      .knex<UserNotificationRow>(T)
      .where({ user_id: userId })
      .whereNull('read_at')
      .update({ read_at: readAt, updated_at: this.db.knex.fn.now() });
  }

  /** One batch of the retention job (UC-NO-5), oldest first. Returns the rows deleted. */
  async deleteOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    const result = await this.db.knex.raw<{ rowCount: number }>(
      `DELETE FROM ${T} WHERE id IN (
         SELECT id FROM ${T} WHERE created_at < ? ORDER BY created_at, id LIMIT ?)`,
      [cutoff, batchSize],
    );
    return result.rowCount;
  }
}
