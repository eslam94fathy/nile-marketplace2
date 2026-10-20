/**
 * notifications module (docs/spec/13-notifications.md): transactional email (worker), and from R2 the
 * notification centre (api endpoints, worker consumer and retention job; spec 13 §8).
 * Owns tables: notification_log, user_notifications, notification_preferences.
 * May call: customers, sellers, delivery (recipient user ids), ordering (parties; spec 02 §6.3).
 * Public API: none besides the composition-root functions below.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type Env } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type EventHandlerDefinition, NotificationEmailRequested } from '../../lib/events';
import { type OpenApiRegistry } from '../../lib/http';
import { type JobDefinition } from '../../lib/jobs';
import { EMAIL_CONSUMER_QUEUE, USER_EVENTS_QUEUE } from './constants';
import { NotificationController } from './controller/notification.controller';
import { type NewUserNotification } from './model/user-notification.model';
import { NotificationLogRepository } from './repository/notification-log.repository';
import { NotificationPreferenceRepository } from './repository/notification-preference.repository';
import { UserNotificationRepository } from './repository/user-notification.repository';
import { notificationRoutes } from './routes';
import { EmailNotificationService, type SendOutcome } from './service/email-notification.service';
import { NotificationCenterService, NotificationRetentionJob } from './service/notification-center.service';
import { USER_EVENTS } from './service/user-event-mapping';
import { UserEventsService } from './service/user-events.service';

export { NotificationsErrorCode } from './errors';

/**
 * worker process: email, the notification-centre consumer and the retention job. Needs ordering,
 * the customers / sellers / delivery lookups and TOKENS.RealtimeEmitter registered.
 */
export function registerNotificationsModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.NotificationLogRepository, NotificationLogRepository);
  container.registerSingleton(TOKENS.EmailNotificationService, EmailNotificationService);
  container.registerSingleton(TOKENS.UserNotificationRepository, UserNotificationRepository);
  container.registerSingleton(TOKENS.NotificationPreferenceRepository, NotificationPreferenceRepository);
  container.registerSingleton(TOKENS.UserEventsService, UserEventsService);
  container.registerSingleton(TOKENS.NotificationRetentionJob, NotificationRetentionJob);
}

/** api process: the notification-centre endpoints (spec 13 §8.4). */
export function registerNotificationsHttp(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.UserNotificationRepository, UserNotificationRepository);
  container.registerSingleton(TOKENS.NotificationPreferenceRepository, NotificationPreferenceRepository);
  container.registerSingleton(TOKENS.NotificationCenterService, NotificationCenterService);
  container.registerSingleton(TOKENS.NotificationController, NotificationController);
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createNotificationsRouter(container: DependencyContainer, basePath: string): Router {
  return notificationRoutes({
    notifications: container.resolve<NotificationController>(TOKENS.NotificationController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}

/**
 * Consumers `notifications.email` ← `notification.email_requested` (UC-NO-1) and
 * `notifications.user-events` ← spec 13 §8.2 events (UC-NO-2).
 */
export function createNotificationHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const email = container.resolve<EmailNotificationService>(TOKENS.EmailNotificationService);
  const userEvents = container.resolve<UserEventsService>(TOKENS.UserEventsService);
  return [
    {
      name: EMAIL_CONSUMER_QUEUE,
      events: [NotificationEmailRequested],
      // The provider call happens outside the DB transaction (CLAUDE.md §6.4).
      beforeTransaction: (envelope) => email.send(envelope),
      handle: (envelope, trx, prepared) => email.record(envelope, prepared as SendOutcome, trx),
    },
    {
      name: USER_EVENTS_QUEUE,
      events: USER_EVENTS,
      // Recipient lookups are reads in other modules: done before the transaction opens.
      beforeTransaction: (envelope) => userEvents.prepare(envelope),
      handle: (_envelope, trx, prepared) => userEvents.record(prepared as NewUserNotification[], trx),
    },
  ];
}

export function createNotificationJobs(
  container: DependencyContainer,
  env: Pick<
    Env,
    | 'JOB_NOTIFICATION_RETENTION_INTERVAL_MS'
    | 'NOTIFICATION_RETENTION_DAYS'
    | 'NOTIFICATION_RETENTION_BATCH_SIZE'
  >,
): JobDefinition[] {
  const retention = container.resolve<NotificationRetentionJob>(TOKENS.NotificationRetentionJob);
  return [
    {
      name: 'notification-retention',
      intervalMs: env.JOB_NOTIFICATION_RETENTION_INTERVAL_MS,
      run: () => retention.run(env.NOTIFICATION_RETENTION_DAYS, env.NOTIFICATION_RETENTION_BATCH_SIZE),
    },
  ];
}
