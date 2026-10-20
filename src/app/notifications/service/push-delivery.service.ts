import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type EventEnvelope } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { type IPushSender, isAllowedPushEndpoint, type PushResult } from '../../../pkg/push';
import { DEFAULT_PUSH_ENABLED, PUSH_TTL_SECONDS } from '../constants';
import { NotificationType } from '../enums';
import { type UserNotification } from '../model/user-notification.model';
import { type NotificationPreferenceRepository } from '../repository/notification-preference.repository';
import { type PushSubscriptionRepository } from '../repository/push-subscription.repository';
import { type UserNotificationRepository } from '../repository/user-notification.repository';
import { idOf } from './user-event-mapping';

/** What the send step learned; `record` applies it in the dedupe transaction. */
export interface PushDeliveryOutcome {
  notificationId: string;
  delivered: string[];
  /** Subscriptions to delete: gone (404 / 410) or no longer on the allow-list. */
  remove: string[];
}

const NOTHING_SENT = (notificationId: string): PushDeliveryOutcome => ({
  notificationId,
  delivered: [],
  remove: [],
});

type PushWorkerEnv = Pick<Env, 'PUSH_ENDPOINT_HOST_ALLOWLIST'>;

/**
 * Consumer `notifications.push` ← `notification.push_requested` (spec 13 UC-NO-3). `send` runs outside
 * the transaction (N-1); only when every subscription failed transiently does it throw, so the queue
 * retries (a partial success acks, so the devices that got it don't get it twice).
 */
@injectable()
export class PushDeliveryService {
  constructor(
    @inject(TOKENS.UserNotificationRepository) private readonly notifications: UserNotificationRepository,
    @inject(TOKENS.NotificationPreferenceRepository)
    private readonly preferences: NotificationPreferenceRepository,
    @inject(TOKENS.PushSubscriptionRepository) private readonly subscriptions: PushSubscriptionRepository,
    @inject(TOKENS.PushSender) private readonly sender: IPushSender,
    @inject(TOKENS.Env) private readonly env: PushWorkerEnv,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async send(envelope: EventEnvelope): Promise<PushDeliveryOutcome> {
    const notificationId = idOf(envelope, 'notificationId');
    const userId = idOf(envelope, 'userId');
    const notification = await this.notifications.findForUser(userId, notificationId);
    // Gone (retention) or muted since the request: nothing to send.
    if (!notification || !(await this.pushEnabled(notification))) return NOTHING_SENT(notificationId);
    const targets = await this.subscriptions.listForUser(userId);
    if (targets.length === 0) return NOTHING_SENT(notificationId);

    const allowed = targets.filter((t) =>
      isAllowedPushEndpoint(t.endpoint, this.env.PUSH_ENDPOINT_HOST_ALLOWLIST),
    );
    const disallowed = targets.filter((t) => !allowed.includes(t));
    const message = {
      payload: JSON.stringify({
        notificationId,
        title: notification.title,
        body: notification.body,
        link: notification.link,
        category: notification.category,
      }),
      ttlSeconds: PUSH_TTL_SECONDS,
      urgency: notification.type === NotificationType.SHIPMENT_ASSIGNED ? 'high' : 'normal',
    } as const;
    const results = await Promise.all(
      allowed.map(async (target) => ({ target, result: await this.sender.send(target, message) })),
    );

    const by = (outcome: PushResult['outcome']) => results.filter(({ result }) => result.outcome === outcome);
    const failed = results.filter(
      ({ result }) => result.outcome === 'rejected' || result.outcome === 'transient',
    );
    if (failed.length > 0 || disallowed.length > 0) {
      this.logger.warn('push not delivered to every device', {
        event: 'PUSH_SEND_FAILED',
        notificationId,
        userId,
        statusCodes: failed.map(({ result }) => result.statusCode ?? null),
        disallowed: disallowed.length,
      });
    }
    // Every device failed transiently: retry the whole message (UC-NO-3 step 4).
    if (results.length > 0 && by('transient').length === results.length) {
      throw new Error('every push subscription failed transiently');
    }
    return {
      notificationId,
      delivered: by('delivered').map(({ target }) => target.id),
      remove: [...by('gone'), ...disallowed.map((target) => ({ target }))].map(({ target }) => target.id),
    };
  }

  /** Step 3–5: forget gone subscriptions, note the successes and when the push went out. */
  async record(outcome: PushDeliveryOutcome, trx: DbTransaction): Promise<void> {
    const now = this.clock.now();
    await this.subscriptions.deleteByIds(outcome.remove, trx);
    await this.subscriptions.markSuccess(outcome.delivered, now, trx);
    if (outcome.delivered.length > 0) await this.notifications.markPushSent(outcome.notificationId, now, trx);
  }

  private async pushEnabled(notification: UserNotification): Promise<boolean> {
    const stored = (await this.preferences.findByUserIds([notification.userId])).find(
      (p) => p.category === notification.category,
    );
    return stored?.pushEnabled ?? DEFAULT_PUSH_ENABLED[notification.category];
  }
}
