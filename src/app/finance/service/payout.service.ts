import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, PayoutRecorded } from '../../../lib/events';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ILogger } from '../../../lib/logger';
import { type Money } from '../../../lib/money';
import { type IDeliveryAgentDirectory } from '../../delivery';
import { type ISellerDirectory } from '../../sellers';
import { AccountType, EntryDirection, EntryType, PayeeType, ReferenceType } from '../enums';
import { paidAtInFuture, payeeNotFound, payoutExceedsBalance } from '../errors';
import { type Payout } from '../model/settlement.model';
import { type PayoutRepository } from '../repository/payout.repository';
import { InsufficientBalanceError, type LedgerService } from './ledger.service';

export interface RecordPayoutInput {
  payeeType: PayeeType;
  payeeId: string;
  amount: Money;
  externalReference: string;
  paidAt: Date;
}

/** Which account a payout debits, and how the entry is typed (spec 12 §1.3). */
const PAYOUT_ACCOUNT = {
  [PayeeType.SELLER]: { accountType: AccountType.SELLER_PAYABLE, entryType: EntryType.SELLER_PAYOUT },
  [PayeeType.AGENT]: { accountType: AccountType.AGENT_FEE_PAYABLE, entryType: EntryType.AGENT_PAYOUT },
} as const;

/** Payouts to sellers and agents, paid outside the system (spec 12 §1.3, Q-11, Q-38). */
@injectable()
export class PayoutService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.LedgerService) private readonly ledger: LedgerService,
    @inject(TOKENS.PayoutRepository) private readonly payouts: PayoutRepository,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.DeliveryAgentDirectory) private readonly agents: IDeliveryAgentDirectory,
  ) {}

  /**
   * One transaction: the payout row (uq on payee + external reference, FI-7), the debit of the
   * payable account (locked by the ledger) and `payout.recorded`. The payee is resolved first, in
   * any status (FI-6); `paidAt` may not be in the future (FI-9).
   */
  async record(input: RecordPayoutInput, adminUserId: string): Promise<Payout> {
    if (input.paidAt.getTime() > this.clock.now().getTime()) throw paidAtInFuture();
    if (!(await this.payeeExists(input.payeeType, input.payeeId))) throw payeeNotFound();
    const { accountType, entryType } = PAYOUT_ACCOUNT[input.payeeType];

    const payout = await this.tx
      .run(async (trx) => {
        const created = await this.payouts.insert({ ...input, recordedByUserId: adminUserId }, trx);
        await this.ledger.post(
          {
            referenceType: ReferenceType.PAYOUT,
            referenceId: created.id,
            sourceEventId: null,
            postings: [
              {
                account: { accountType, ownerId: input.payeeId },
                direction: EntryDirection.DEBIT,
                amount: input.amount,
                entryType,
              },
            ],
          },
          trx,
        );
        await this.outbox.add(trx, {
          contract: PayoutRecorded,
          aggregateId: created.id,
          payload: {
            payoutId: created.id,
            payeeType: created.payeeType,
            payeeId: created.payeeId,
            amount: created.amount.toString(),
            recordedByUserId: adminUserId,
          },
        });
        return created;
      })
      .catch((error: unknown) => {
        // No account yet reads as 0.00 (the ledger created it at 0 inside the rolled-back transaction).
        if (error instanceof InsufficientBalanceError) throw payoutExceedsBalance(error.balance.toString());
        throw error;
      });

    this.logger.info('payout recorded', {
      event: 'PAYOUT_RECORDED',
      payoutId: payout.id,
      payeeType: payout.payeeType,
      payeeId: payout.payeeId,
      amount: payout.amount.toString(),
      userId: adminUserId,
    });
    return payout;
  }

  /** Admin list, or one payee's own payouts when `payee` is given. */
  async list(
    query: ParsedListQuery,
    payee?: { payeeType: PayeeType; payeeId: string },
  ): Promise<{ items: Payout[]; meta: PageMeta }> {
    return toPage(await this.payouts.list(query, payee), query, (p) => p.createdAt);
  }

  private async payeeExists(payeeType: PayeeType, payeeId: string): Promise<boolean> {
    const found =
      payeeType === PayeeType.SELLER
        ? await this.sellers.getSummaries([payeeId])
        : await this.agents.getAgentSummaries([payeeId]);
    return found.length > 0;
  }
}
