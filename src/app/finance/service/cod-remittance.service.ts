import { inject, injectable } from 'tsyringe';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CodRemittanceConfirmed, type IOutbox } from '../../../lib/events';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ILogger } from '../../../lib/logger';
import { type Money } from '../../../lib/money';
import { type IDeliveryAgentDirectory } from '../../delivery';
import { AccountType, EntryDirection, EntryType, ReferenceType } from '../enums';
import { agentReferenceNotFound, remittanceExceedsBalance } from '../errors';
import { type CodRemittance } from '../model/settlement.model';
import { type CodRemittanceRepository } from '../repository/cod-remittance.repository';
import { InsufficientBalanceError, type LedgerService } from './ledger.service';

/** COD cash handed in by agents (spec 12 §1.3, Q-18). */
@injectable()
export class CodRemittanceService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.LedgerService) private readonly ledger: LedgerService,
    @inject(TOKENS.CodRemittanceRepository) private readonly remittances: CodRemittanceRepository,
    @inject(TOKENS.DeliveryAgentDirectory) private readonly agents: IDeliveryAgentDirectory,
  ) {}

  /**
   * One transaction: the remittance row, the debit of the agent's COD cash (account locked by the
   * ledger) and `cod.remittance_confirmed`. The agent is looked up first, so an unknown one is
   * AGENT_NOT_FOUND rather than "no balance" (FI-5); any agent status may remit.
   */
  async confirm(
    input: { agentId: string; amount: Money; note: string | null },
    adminUserId: string,
  ): Promise<CodRemittance> {
    const [agent] = await this.agents.getAgentSummaries([input.agentId]);
    if (!agent) throw agentReferenceNotFound();

    const remittance = await this.tx
      .run(async (trx) => {
        const created = await this.remittances.insert(
          { agentId: input.agentId, amount: input.amount, confirmedByUserId: adminUserId, note: input.note },
          trx,
        );
        await this.ledger.post(
          {
            referenceType: ReferenceType.COD_REMITTANCE,
            referenceId: created.id,
            sourceEventId: null,
            postings: [
              {
                account: { accountType: AccountType.AGENT_COD_CASH, ownerId: input.agentId },
                direction: EntryDirection.DEBIT,
                amount: input.amount,
                entryType: EntryType.COD_CASH_REMITTED,
              },
            ],
          },
          trx,
        );
        await this.outbox.add(trx, {
          contract: CodRemittanceConfirmed,
          aggregateId: created.id,
          payload: {
            remittanceId: created.id,
            agentId: created.agentId,
            amount: created.amount.toString(),
            confirmedByUserId: adminUserId,
          },
        });
        return created;
      })
      .catch((error: unknown) => {
        // No account yet reads as 0.00 (the ledger created it at 0 inside the rolled-back transaction).
        if (error instanceof InsufficientBalanceError)
          throw remittanceExceedsBalance(error.balance.toString());
        throw error;
      });

    this.logger.info('COD remittance confirmed', {
      event: 'COD_REMITTANCE_CONFIRMED',
      remittanceId: remittance.id,
      agentId: remittance.agentId,
      amount: remittance.amount.toString(),
      userId: adminUserId,
    });
    return remittance;
  }

  /** Admin list, or one agent's own remittances when `agentId` is given. */
  async list(query: ParsedListQuery, agentId?: string): Promise<{ items: CodRemittance[]; meta: PageMeta }> {
    return toPage(await this.remittances.list(query, agentId), query, (r) => r.createdAt);
  }
}
