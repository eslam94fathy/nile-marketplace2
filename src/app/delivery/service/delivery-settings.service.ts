import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { type Rate } from '../../../lib/money';
import { type DeliverySettings } from '../model/delivery-settings.model';
import { type DeliverySettingsRepository } from '../repository/delivery-settings.repository';

/** The global agent fee-share setting (spec 11 UC-DE-7, Q-34). Not cached: a one-row lookup (DE-3). */
@injectable()
export class DeliverySettingsService {
  constructor(
    @inject(TOKENS.DeliverySettingsRepository) private readonly settings: DeliverySettingsRepository,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
  ) {}

  get(): Promise<DeliverySettings> {
    return this.settings.get();
  }

  /** Affects new checkouts only (the rate is snapshotted on `orders`). */
  async updateAgentFeeShareRate(rate: Rate, actorUserId: string): Promise<DeliverySettings> {
    const updated = await this.tx.run(async (trx) => {
      const current = await this.settings.get(trx, { forUpdate: true });
      const next = await this.settings.updateAgentFeeShareRate(rate, trx);
      await this.audit.record(
        {
          action: 'setting.delivery_changed',
          targetId: null,
          before: { agentFeeShareRate: current.agentFeeShareRate.toString() },
          after: { agentFeeShareRate: next.agentFeeShareRate.toString() },
        },
        trx,
      );
      return next;
    });
    this.logger.info('agent fee share rate changed', {
      event: 'AGENT_FEE_SHARE_RATE_CHANGED',
      agentFeeShareRate: updated.agentFeeShareRate.toString(),
      actorUserId,
    });
    return updated;
  }
}
