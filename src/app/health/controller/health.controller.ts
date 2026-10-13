import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { HTTP_STATUS, sendSuccess } from '../../../lib/http';
import { DependencyStatus } from '../enums';
import { dependenciesUnavailable } from '../errors';
import { type HealthService } from '../service/health.service';

@injectable()
export class HealthController {
  constructor(@inject(TOKENS.HealthService) private readonly health: HealthService) {}

  /** Process is up. No dependency checks (CLAUDE.md §12). */
  live = (_req: Request, res: Response): void => {
    sendSuccess(res, HTTP_STATUS.OK, { status: DependencyStatus.UP });
  };

  ready = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.health.readiness();
    if (report.status === DependencyStatus.UP) {
      sendSuccess(res, HTTP_STATUS.OK, report);
      return;
    }
    throw dependenciesUnavailable(
      Object.entries(report.checks)
        .filter(([, check]) => check.status === DependencyStatus.DOWN)
        .map(([dependency]) => ({
          field: dependency,
          constraint: 'available',
          message: `${dependency} is down`,
        })),
    );
  };
}
