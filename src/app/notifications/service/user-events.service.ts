import { inject, injectable } from 'tsyringe';
import { afterCommit, type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type EventEnvelope, type IOutbox, NotificationPushRequested } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { type IRealtimeEmitter, RealtimeMessageType, RealtimeRoom } from '../../../lib/realtime';
import { type ICustomerDirectory } from '../../customers';
import { type IDeliveryAgentDirectory } from '../../delivery';
import { type IOrderingDirectory, type NotificationParty } from '../../ordering';
import { type ISellerDirectory } from '../../sellers';
import { DEFAULT_PUSH_ENABLED } from '../constants';
import { type NewUserNotification, type UserNotification } from '../model/user-notification.model';
import { type NotificationPreferenceRepository } from '../repository/notification-preference.repository';
import { type PushSubscriptionRepository } from '../repository/push-subscription.repository';
import { type UserNotificationRepository } from '../repository/user-notification.repository';
import {
  idOf,
  mapUserEvent,
  NEEDS_PARTY,
  type NotificationDraft,
  type RecipientKind,
  SESSION_END_EVENTS,
} from './user-event-mapping';

/** What `prepare` hands to `record`: rows to store, or a user whose push subscriptions go (NO-8). */
export type PreparedUserEvent = { rows: NewUserNotification[] } | { dropSubscriptionsOf: string };

/**
 * Consumer `notifications.user-events` (spec 13 UC-NO-2). `prepare` maps the event and resolves the
 * recipients through the owning modules (reads only, outside the transaction); `record` stores the
 * rows with the dedupe row, asks for a push per unmuted new row (NO-6), and announces the new rows on
 * the socket after the commit (best effort, spec 15).
 */
@injectable()
export class UserEventsService {
  constructor(
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.DeliveryAgentDirectory) private readonly agents: IDeliveryAgentDirectory,
    @inject(TOKENS.UserNotificationRepository) private readonly notifications: UserNotificationRepository,
    @inject(TOKENS.NotificationPreferenceRepository)
    private readonly preferences: NotificationPreferenceRepository,
    @inject(TOKENS.PushSubscriptionRepository) private readonly subscriptions: PushSubscriptionRepository,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.RealtimeEmitter) private readonly realtime: IRealtimeEmitter,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async prepare(envelope: EventEnvelope): Promise<PreparedUserEvent> {
    if (SESSION_END_EVENTS.has(envelope.eventType)) return { dropSubscriptionsOf: idOf(envelope, 'userId') };
    return { rows: await this.rowsOf(envelope) };
  }

  async record(prepared: PreparedUserEvent, trx: DbTransaction): Promise<void> {
    if ('dropSubscriptionsOf' in prepared) {
      await this.subscriptions.deleteAllForUser(prepared.dropSubscriptionsOf, trx);
      return;
    }
    await this.store(prepared.rows, trx);
  }

  private async rowsOf(envelope: EventEnvelope): Promise<NewUserNotification[]> {
    const party = NEEDS_PARTY.has(envelope.eventType) ? await this.partyOf(envelope) : undefined;
    if (NEEDS_PARTY.has(envelope.eventType) && !party) {
      // Orders are never deleted: a payload naming a missing order can't be notified.
      this.logger.warn('notification skipped: order not found', {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
      });
      return [];
    }
    const drafts = mapUserEvent(envelope, party);
    const userIds = await this.userIdsOf(drafts);
    return drafts.flatMap((draft) => {
      const userId = userIds[draft.recipient.kind].get(draft.recipient.id);
      if (userId === undefined) {
        this.logger.warn('notification skipped: recipient has no user', {
          eventId: envelope.eventId,
          recipientKind: draft.recipient.kind,
          recipientId: draft.recipient.id,
        });
        return [];
      }
      const { recipient: _recipient, ...row } = draft;
      return [{ ...row, userId, sourceEventId: envelope.eventId }];
    });
  }

  private async store(rows: readonly NewUserNotification[], trx: DbTransaction): Promise<void> {
    const inserted = await this.notifications.insertMany(rows, trx);
    if (inserted.length === 0) return;
    const pushable = await this.pushable(inserted, trx);
    await this.outbox.addMany(
      trx,
      pushable.map((notification) => ({
        contract: NotificationPushRequested,
        aggregateId: notification.id,
        payload: { notificationId: notification.id, userId: notification.userId },
      })),
    );
    afterCommit(trx, () => {
      for (const notification of inserted) this.announce(notification);
      return Promise.resolve();
    });
  }

  /** New rows whose category the recipient hasn't muted for push (a stored row, else the default). */
  private async pushable(
    inserted: readonly UserNotification[],
    trx: DbTransaction,
  ): Promise<UserNotification[]> {
    const stored = await this.preferences.findByUserIds(
      inserted.map((n) => n.userId),
      trx,
    );
    const choice = new Map(stored.map((p) => [`${p.userId}:${p.category}`, p.pushEnabled]));
    return inserted.filter(
      (n) => choice.get(`${n.userId}:${n.category}`) ?? DEFAULT_PUSH_ENABLED[n.category],
    );
  }

  private announce(notification: UserNotification): void {
    this.realtime.toRooms([RealtimeRoom.user(notification.userId)], {
      type: RealtimeMessageType.NOTIFICATION_CREATED,
      eventId: notification.sourceEventId,
      occurredAt: notification.createdAt.toISOString(),
      data: {
        notificationId: notification.id,
        category: notification.category,
        title: notification.title,
        body: notification.body,
        link: notification.link,
      },
    });
  }

  private async partyOf(envelope: EventEnvelope): Promise<NotificationParty | undefined> {
    const ids =
      'orderId' in envelope.payload && !('sellerOrderId' in envelope.payload)
        ? { orderIds: [idOf(envelope, 'orderId')] }
        : { sellerOrderIds: [idOf(envelope, 'sellerOrderId')] };
    const [party] = await this.ordering.getNotificationParties(ids);
    return party;
  }

  /** One batched lookup per recipient kind present (spec 02 §6.3). */
  private async userIdsOf(
    drafts: readonly NotificationDraft[],
  ): Promise<Record<RecipientKind, Map<string, string>>> {
    const idsOf = (kind: RecipientKind) =>
      drafts.filter((d) => d.recipient.kind === kind).map((d) => d.recipient.id);
    const lookup = (ids: string[], resolve: (ids: string[]) => Promise<Map<string, string>>) =>
      ids.length === 0 ? Promise.resolve(new Map<string, string>()) : resolve(ids);
    const [customer, seller, agent] = await Promise.all([
      lookup(idsOf('customer'), (ids) => this.customers.getUserIds(ids)),
      lookup(idsOf('seller'), (ids) => this.sellers.getUserIds(ids)),
      lookup(idsOf('agent'), (ids) => this.agents.getUserIds(ids)),
    ]);
    return { customer, seller, agent };
  }
}
