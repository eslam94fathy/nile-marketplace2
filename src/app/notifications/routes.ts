import { Router } from 'express';
import { type JwtVerifier } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate } from '../../lib/middleware';
import { NOTIFICATION_PATHS as P } from './constants';
import { type NotificationController } from './controller/notification.controller';
import { type PushController } from './controller/push.controller';
import {
  RegisterPushSubscriptionDto,
  UnregisterPushSubscriptionDto,
  UpdatePreferencesDto,
} from './dto/notification-request.dto';
import {
  NotificationPreferenceDto,
  PushConfigDto,
  UnreadCountDto,
  UserNotificationDto,
} from './dto/notification-response.dto';
import { NotificationCategory } from './enums';

const TAGS = ['notifications'] as const;

export interface NotificationRouteDeps {
  notifications: NotificationController;
  push: PushController;
  jwtVerifier: JwtVerifier;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 13 §8.4: any authenticated role, general rate limit (applied globally). */
export function notificationRoutes(deps: NotificationRouteDeps): Router {
  const { notifications: c, docs, basePath } = deps;
  const router = Router();
  const auth = authenticate(deps.jwtVerifier);

  // `unread-count` and `read-all` before `:notificationId`.
  router.get(P.UNREAD_COUNT, auth, c.unreadCount);
  router.post(P.READ_ALL, auth, c.markAllRead);
  router.get(P.LIST, auth, c.list);
  router.post(P.READ, auth, c.markRead);
  router.get(P.PREFERENCES, auth, c.getPreferences);
  router.put(P.PREFERENCES, auth, c.setPreferences);
  router.get(P.PUSH_CONFIG, auth, deps.push.config);
  router.post(P.PUSH_UNREGISTER, auth, deps.push.unregister);
  router.post(P.PUSH_SUBSCRIPTIONS, auth, deps.push.register);

  const common = { tags: TAGS, auth: true } as const;
  const preferences = {
    200: {
      description: 'All four categories, defaults filled in',
      body: NotificationPreferenceDto,
      isArray: true,
    },
  };
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.LIST}`,
    summary:
      'My notifications, newest first. Filters: read[eq], category[eq|in]. Sort: createdAt (default -createdAt)',
    query: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
      { name: 'read[eq]', in: 'query', schema: { type: 'boolean' } },
      { name: 'category[eq]', in: 'query', schema: { enum: Object.values(NotificationCategory) } },
      { name: 'category[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
    ],
    responses: {
      200: {
        description: 'One page of notifications',
        body: UserNotificationDto,
        isArray: true,
        paginated: true,
      },
    },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.UNREAD_COUNT}`,
    summary: 'How many notifications are unread, counted up to 100',
    responses: { 200: { description: 'The count', body: UnreadCountDto } },
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.READ}`,
    summary: 'Mark one notification read (NOTIFICATION_NOT_FOUND)',
    responses: { 204: { description: 'Read' } },
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.READ_ALL}`,
    summary: 'Mark every notification read',
    responses: { 204: { description: 'All read' } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.PREFERENCES}`,
    summary: 'My push preferences per category',
    responses: preferences,
  });
  docs.add({
    ...common,
    method: 'put',
    path: `${basePath}${P.PREFERENCES}`,
    summary: 'Change push for some categories; the others keep their value',
    requestBody: UpdatePreferencesDto,
    responses: preferences,
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.PUSH_CONFIG}`,
    summary: 'The VAPID public key for pushManager.subscribe',
    responses: { 200: { description: 'Push configuration', body: PushConfigDto } },
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.PUSH_SUBSCRIPTIONS}`,
    summary:
      "Register this browser for push (an upsert by endpoint; the 11th deletes the user's oldest) (PUSH_ENDPOINT_NOT_ALLOWED)",
    requestBody: RegisterPushSubscriptionDto,
    responses: { 201: { description: 'Registered' } },
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.PUSH_UNREGISTER}`,
    summary: 'Stop push to this browser (before logout; an unknown endpoint is fine)',
    requestBody: UnregisterPushSubscriptionDto,
    responses: { 204: { description: 'Unregistered' } },
  });
  return router;
}
