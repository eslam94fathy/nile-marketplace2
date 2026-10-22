import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { TOKENS } from '../../../lib/di';
import { type ReturnRequestRepository } from '../repository/return-request.repository';

/** Public API of returns (spec 18 §2) for finance (holding release) and the back-office. Reads without locks. */
export interface IReturnsDirectory {
  /**
   * The given seller orders that have an open return, a rejected one still inside its escalation window
   * included (spec 12 §8.3: their holds wait). One query.
   */
  getOpenReturnSellerOrderIds(sellerOrderIds: readonly string[]): Promise<Set<string>>;
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
}
