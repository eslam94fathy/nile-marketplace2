import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import {
  NOTIFICATION_LIST_SPEC,
  NotificationIdParamsDto,
  UpdatePreferencesDto,
} from '../dto/notification-request.dto';
import {
  toNotificationPreferenceDto,
  toUserNotificationDto,
  type UnreadCountDto,
} from '../dto/notification-response.dto';
import { type NotificationCenterService } from '../service/notification-center.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 13 §8.4). Every route acts on the authenticated caller's own notifications. */
@injectable()
export class NotificationController {
  constructor(
    @inject(TOKENS.NotificationCenterService) private readonly center: NotificationCenterService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, NOTIFICATION_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const read = query.filters.find((filter) => filter.field === 'read')?.value;
    const page = await this.center.list(userOf(req), query, typeof read === 'boolean' ? read : undefined);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toUserNotificationDto), page.meta);
  };

  unreadCount = async (req: Request, res: Response): Promise<void> => {
    sendSuccess<UnreadCountDto>(res, HTTP_STATUS.OK, { count: await this.center.unreadCount(userOf(req)) });
  };

  markRead = async (req: Request, res: Response): Promise<void> => {
    const { notificationId } = await validateDto(NotificationIdParamsDto, req.params);
    await this.center.markRead(userOf(req), notificationId);
    sendNoContent(res);
  };

  markAllRead = async (req: Request, res: Response): Promise<void> => {
    await this.center.markAllRead(userOf(req));
    sendNoContent(res);
  };

  getPreferences = async (req: Request, res: Response): Promise<void> => {
    const preferences = await this.center.getPreferences(userOf(req));
    sendSuccess(res, HTTP_STATUS.OK, preferences.map(toNotificationPreferenceDto));
  };

  setPreferences = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(UpdatePreferencesDto, req.body);
    const preferences = await this.center.setPreferences(userOf(req), dto.preferences);
    sendSuccess(res, HTTP_STATUS.OK, preferences.map(toNotificationPreferenceDto));
  };
}

function userOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
