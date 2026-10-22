import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { TOKENS } from '../../../lib/di';
import { OPEN_RETURN_STATUSES, type OpenReturnStatus } from '../enums';
import { type ReturnRequestRepository } from '../repository/return-request.repository';

/** Returns' part of the dashboard (spec 18 §2, spec 20 BO-24): every open status is present. */
export interface ReturnsDashboardStats {
  byStatus: Record<OpenReturnStatus, number>;
}

/** Public API of returns (spec 18 §2) for finance (holding release) and the back-office. Reads without locks. */
export interface IReturnsDirectory {
  /**
   * The given seller orders that have an open return, a rejected one still inside its escalation window
   * included (spec 12 §8.3: their holds wait). One query.
   */
  getOpenReturnSellerOrderIds(sellerOrderIds: readonly string[]): Promise<Set<string>>;
  getDashboardStats(): Promise<ReturnsDashboardStats>;
}

@injectable()
export class ReturnsDirectory implements IReturnsDirectory {
  constructor(
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async getOpenReturnSellerOrderIds(sellerOrderIds: readonly string[]): Promise<Set<string>> {
    return new Set(await this.requests.findOpenSellerOrderIds(sellerOrderIds, this.clock.now()));
  }

  async getDashboardStats(): Promise<ReturnsDashboardStats> {
    const counts = await this.requests.countOpenByStatus(this.clock.now());
    const byStatus = Object.fromEntries(
      OPEN_RETURN_STATUSES.map((status) => [status, counts.get(status) ?? 0]),
    ) as Record<OpenReturnStatus, number>;
    return { byStatus };
  }
}
