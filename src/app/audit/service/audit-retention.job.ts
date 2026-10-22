import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { TOKENS } from '../../../lib/di';
import { toMs, TimeUnit } from '../../../pkg/time';
import { type AuditLogRepository } from '../repository/audit-log.repository';

/**
 * `audit-retention` (spec 20 §2.4, R-19): deletes rows older than the retention period in batches,
 * one short statement each, until a batch comes back smaller than the batch size.
 */
@injectable()
export class AuditRetentionJob {
  constructor(
    @inject(TOKENS.AuditLogRepository) private readonly log: AuditLogRepository,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  /** Returns the number of rows deleted. */
  async run(retentionDays: number, batchSize: number): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - toMs(retentionDays, TimeUnit.DAY));
    let total = 0;
    for (;;) {
      const deleted = await this.log.deleteOlderThan(cutoff, batchSize);
      total += deleted;
      if (deleted < batchSize) return total;
    }
  }
}
