import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { toMs, TimeUnit } from '../../../pkg/time';
import { DEFAULT_PUSH_ENABLED } from '../constants';
import { NotificationCategory } from '../enums';
import { notificationNotFound } from '../errors';
import { type NotificationPreference, type UserNotification } from '../model/user-notification.model';
import { type NotificationPreferenceRepository } from '../repository/notification-preference.repository';
import { type UserNotificationRepository } from '../repository/user-notification.repository';

/** The caller's notification centre and push preferences (spec 13 §8.4). Every read is the caller's own. */
@injectable()
export class NotificationCenterService {
  constructor(
    @inject(TOKENS.UserNotificationRepository) private readonly notifications: UserNotificationRepository,
    @inject(TOKENS.NotificationPreferenceRepository)
    private readonly preferences: NotificationPreferenceRepository,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async list(
    userId: string,
    query: ParsedListQuery,
    read: boolean | undefined,
  ): Promise<{ items: UserNotification[]; meta: PageMeta }> {
    return toPage(await this.notifications.listForUser(userId, query, read), query, (n) => n.createdAt);
  }

  unreadCount(userId: string): Promise<number> {
    return this.notifications.countUnread(userId);
  }

  /** NOTIFICATION_NOT_FOUND for an unknown id or another user's. Already read: nothing changes. */
  async markRead(userId: string, notificationId: string): Promise<void> {
    if (!(await this.notifications.markRead(userId, notificationId, this.clock.now()))) {
      throw notificationNotFound();
    }
  }

  markAllRead(userId: string): Promise<void> {
    return this.notifications.markAllRead(userId, this.clock.now());
  }

  /** All four categories, stored choices over the defaults. */
  async getPreferences(userId: string): Promise<NotificationPreference[]> {
    const stored = new Map(
      (await this.preferences.findByUserIds([userId])).map((p) => [p.category, p.pushEnabled]),
    );
    return Object.values(NotificationCategory).map((category) => ({
      category,
      pushEnabled: stored.get(category) ?? DEFAULT_PUSH_ENABLED[category],
    }));
  }

  /** Stores the categories sent; the others keep their value (NO-19). */
  async setPreferences(
    userId: string,
    changes: readonly NotificationPreference[],
  ): Promise<NotificationPreference[]> {
    await this.preferences.upsertMany(userId, changes);
    return this.getPreferences(userId);
  }
}

/** `notification-retention` (UC-NO-5, NO-7): deletes old rows in batches, one short statement each. */
@injectable()
export class NotificationRetentionJob {
  constructor(
    @inject(TOKENS.UserNotificationRepository) private readonly notifications: UserNotificationRepository,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  /** Returns the number of rows deleted. */
  async run(retentionDays: number, batchSize: number): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - toMs(retentionDays, TimeUnit.DAY));
    let total = 0;
    for (;;) {
      const deleted = await this.notifications.deleteOlderThan(cutoff, batchSize);
      total += deleted;
      if (deleted < batchSize) return total;
    }
  }
}
