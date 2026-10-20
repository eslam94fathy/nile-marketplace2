import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import { RegisterPushSubscriptionDto, UnregisterPushSubscriptionDto } from '../dto/notification-request.dto';
import { type PushConfigDto } from '../dto/notification-response.dto';
import { type PushSubscriptionService } from '../service/push-subscription.service';

/** HTTP only (spec 13 §8.4 push rows). */
@injectable()
export class PushController {
  constructor(@inject(TOKENS.PushSubscriptionService) private readonly push: PushSubscriptionService) {}

  config = (_req: Request, res: Response): void => {
    sendSuccess<PushConfigDto>(res, HTTP_STATUS.OK, { vapidPublicKey: this.push.vapidPublicKey() });
  };

  /** `201` also on an upsert of a known endpoint. */
  register = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(RegisterPushSubscriptionDto, req.body);
    await this.push.register({
      userId: userOf(req),
      endpoint: dto.endpoint,
      keys: { p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      userAgent: dto.userAgent ?? null,
    });
    sendSuccess(res, HTTP_STATUS.CREATED, {});
  };

  unregister = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(UnregisterPushSubscriptionDto, req.body);
    await this.push.unregister(userOf(req), dto.endpoint);
    sendNoContent(res);
  };
}

function userOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
