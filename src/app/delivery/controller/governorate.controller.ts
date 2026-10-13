import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendSuccess, validateDto } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { GovernorateIdParamsDto, UpdateGovernorateDto } from '../dto/delivery-request.dto';
import { toGovernorateDto } from '../dto/delivery-response.dto';
import { type GovernorateService } from '../service/governorate.service';

/** HTTP only (spec 11 §4.1, §4.3). The admin routes are admin-guarded. */
@injectable()
export class GovernorateController {
  constructor(@inject(TOKENS.GovernorateService) private readonly governorates: GovernorateService) {}

  /** Public and admin list: same shape (spec 11 §4.3). */
  list = async (_req: Request, res: Response): Promise<void> => {
    const governorates = await this.governorates.list();
    sendSuccess(res, HTTP_STATUS.OK, governorates.map(toGovernorateDto));
  };

  updateFee = async (req: Request, res: Response): Promise<void> => {
    const { governorateId } = await validateDto(GovernorateIdParamsDto, req.params);
    const { deliveryFee } = await validateDto(UpdateGovernorateDto, req.body);
    const updated = await this.governorates.updateDeliveryFee(
      governorateId,
      deliveryFee === null ? null : Money.of(deliveryFee),
      actorOf(req),
    );
    sendSuccess(res, HTTP_STATUS.OK, toGovernorateDto(updated));
  };
}

function actorOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
