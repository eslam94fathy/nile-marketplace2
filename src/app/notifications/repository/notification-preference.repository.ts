import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { NOTIFICATIONS_TABLES } from '../constants';
import { type NotificationCategory } from '../enums';

const T = NOTIFICATIONS_TABLES.NOTIFICATION_PREFERENCES;

interface PreferenceRow {
  user_id: string;
  category: NotificationCategory;
  push_enabled: boolean;
  updated_at: Date;
}

/** A stored choice; categories without a row use the code default (spec 13 §8.1). */
export interface StoredPreference {
  userId: string;
  category: NotificationCategory;
  pushEnabled: boolean;
}

/** All SQL of `notification_preferences`. */
@injectable()
export class NotificationPreferenceRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** The stored rows of these users, one query on the primary key (G20). */
  async findByUserIds(userIds: readonly string[], trx?: DbTransaction): Promise<StoredPreference[]> {
    if (userIds.length === 0) return [];
    const rows = await (trx ?? this.db.knex)<PreferenceRow>(T)
      .select('user_id', 'category', 'push_enabled')
      .whereIn('user_id', [...new Set(userIds)]);
    return rows.map((row) => ({
      userId: row.user_id,
      category: row.category,
      pushEnabled: row.push_enabled,
    }));
  }

  /** One multi-row upsert of the categories sent (the others keep their row or default). */
  async upsertMany(
    userId: string,
    preferences: readonly { category: NotificationCategory; pushEnabled: boolean }[],
  ): Promise<void> {
    if (preferences.length === 0) return;
    await this.db
      .knex<PreferenceRow>(T)
      .insert(
        preferences.map((p) => ({ user_id: userId, category: p.category, push_enabled: p.pushEnabled })),
      )
      .onConflict(['user_id', 'category'])
      .merge({ push_enabled: this.db.knex.raw('EXCLUDED.push_enabled'), updated_at: this.db.knex.fn.now() });
  }
}
