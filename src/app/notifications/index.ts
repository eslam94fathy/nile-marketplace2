/**
 * notifications module: transactional email only (docs/spec/13-notifications.md). Worker only, no HTTP.
 * Owns table: notification_log. Depends on no other module: everything arrives in the event payload.
 * Public API: none besides the composition-root functions below.
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { type EventHandlerDefinition, NotificationEmailRequested } from '../../lib/events';
import { EMAIL_CONSUMER_QUEUE } from './constants';
import { NotificationLogRepository } from './repository/notification-log.repository';
import { EmailNotificationService, type SendOutcome } from './service/email-notification.service';

export function registerNotificationsModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.NotificationLogRepository, NotificationLogRepository);
  container.registerSingleton(TOKENS.EmailNotificationService, EmailNotificationService);
}

/** Consumer `notifications.email` ← `notification.email_requested` (UC-NO-1). */
export function createNotificationHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const service = container.resolve<EmailNotificationService>(TOKENS.EmailNotificationService);
  return [
    {
      name: EMAIL_CONSUMER_QUEUE,
      events: [NotificationEmailRequested],
      // The provider call happens outside the DB transaction (CLAUDE.md §6.4).
      beforeTransaction: (envelope) => service.send(envelope),
      handle: (envelope, trx, prepared) => service.record(envelope, prepared as SendOutcome, trx),
    },
  ];
}
