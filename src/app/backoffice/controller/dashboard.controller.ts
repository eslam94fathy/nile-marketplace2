import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, sendSuccess } from '../../../lib/http';
import { type DashboardService } from '../service/dashboard.service';

/** HTTP only (spec 20 §3.2). Admin-guarded in routes. */
@injectable()
export class DashboardController {
  constructor(@inject(TOKENS.DashboardService) private readonly dashboard: DashboardService) {}

  get = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, HTTP_STATUS.OK, await this.dashboard.get());
  };
}
