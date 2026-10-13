import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendSuccess, validateDto } from '../../../lib/http';
import { Rate } from '../../../lib/money';
import { UpdateDeliverySettingsDto } from '../dto/delivery-request.dto';
import { toDeliverySettingsDto } from '../dto/delivery-response.dto';
import { type DeliverySettingsService } from '../service/delivery-settings.service';

/** HTTP only (spec 11 §4.3, settings). Admin-guarded. */
@injectable()
export class DeliverySettingsController {
  constructor(@inject(TOKENS.DeliverySettingsService) private readonly settings: DeliverySettingsService) {}

  get = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, HTTP_STATUS.OK, toDeliverySettingsDto(await this.settings.get()));
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { agentFeeShareRate } = await validateDto(UpdateDeliverySettingsDto, req.body);
    if (!req.auth) throw unauthenticated();
    const updated = await this.settings.updateAgentFeeShareRate(Rate.of(agentFeeShareRate), req.auth.userId);
    sendSuccess(res, HTTP_STATUS.OK, toDeliverySettingsDto(updated));
  };
}
