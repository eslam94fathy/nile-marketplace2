import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { NOTIFICATIONS_TABLES } from '../constants';

const T = NOTIFICATIONS_TABLES.PUSH_SUBSCRIPTIONS;
const COLUMNS = ['id', 'user_id', 'endpoint', 'p256dh', 'auth'] as const;

interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  last_success_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NewPushSubscription {
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
}

const toModel = (row: Pick<PushSubscriptionRow, (typeof COLUMNS)[number]>): PushSubscription => ({
  id: row.id,
  userId: row.user_id,
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
});

/** All SQL of `push_subscriptions` (spec 13 UC-NO-3, UC-NO-4). */
@injectable()
export class PushSubscriptionRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /**
   * Serialises one user's registrations, so the 10-per-user trim is exact. An advisory lock on the
   * user id: the users row belongs to identity and a first subscription has no row of its own to lock.
   */
  async lockUser(userId: string, trx: DbTransaction): Promise<void> {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`, [`${T}:${userId}`]);
  }

  /** Insert, or move an existing endpoint to this user with its new keys (uq_push_subscriptions_endpoint). */
  async upsert(subscription: NewPushSubscription, trx: DbTransaction): Promise<void> {
    await trx<PushSubscriptionRow>(T)
      .insert({
        user_id: subscription.userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        user_agent: subscription.userAgent,
        last_success_at: null,
      })
      .onConflict('endpoint')
      .merge({
        user_id: trx.raw('EXCLUDED.user_id'),
        p256dh: trx.raw('EXCLUDED.p256dh'),
        auth: trx.raw('EXCLUDED.auth'),
        user_agent: trx.raw('EXCLUDED.user_agent'),
        updated_at: trx.fn.now(),
      });
  }

  /** Keeps the user's newest `keep` subscriptions (idx_push_subscriptions_user_id_created_at). */
  async trimToNewest(userId: string, keep: number, trx: DbTransaction): Promise<void> {
    await trx.raw(
      `DELETE FROM ${T} WHERE id IN (
         SELECT id FROM ${T} WHERE user_id = ? ORDER BY created_at DESC, id DESC OFFSET ?)`,
      [userId, keep],
    );
  }

  /** Only the caller's own: another user's endpoint is left alone. */
  async deleteForUser(userId: string, endpoint: string): Promise<void> {
    await this.db.knex<PushSubscriptionRow>(T).where({ user_id: userId, endpoint }).del();
  }

  /** On suspension or a password reset (NO-8). */
  async deleteAllForUser(userId: string, trx: DbTransaction): Promise<number> {
    return trx<PushSubscriptionRow>(T).where({ user_id: userId }).del();
  }

  async listForUser(userId: string): Promise<PushSubscription[]> {
    const rows = await this.db
      .knex<PushSubscriptionRow>(T)
      .select(...COLUMNS)
      .where({ user_id: userId })
      .orderBy([{ column: 'created_at' }, { column: 'id' }]);
    return rows.map(toModel);
  }

  async deleteByIds(ids: readonly string[], trx: DbTransaction): Promise<void> {
    if (ids.length === 0) return;
    await trx<PushSubscriptionRow>(T)
      .whereIn('id', [...ids])
      .del();
  }

  async markSuccess(ids: readonly string[], at: Date, trx: DbTransaction): Promise<void> {
    if (ids.length === 0) return;
    await trx<PushSubscriptionRow>(T)
      .whereIn('id', [...ids])
      .update({ last_success_at: at, updated_at: trx.fn.now() });
  }
}
