import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ILogger } from '../../../lib/logger';
import { type IDeliveryAgentDirectory } from '../../delivery';
import { type ISellerDirectory } from '../../sellers';
import { AccountType, type ReferenceType } from '../enums';
import { accountNotFound } from '../errors';
import { type AccountKey, type FinanceAccount, type LedgerEntry } from '../model/ledger.model';
import { type FinanceAccountRepository } from '../repository/finance-account.repository';
import { type LedgerEntryRepository } from '../repository/ledger-entry.repository';

/** An account with its owner's display name (spec 12 §4, FI-11). */
export interface AccountView {
  account: FinanceAccount;
  ownerName: string | null;
}

export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

const SELLER_ACCOUNTS: readonly AccountType[] = [AccountType.SELLER_PAYABLE];
const AGENT_ACCOUNTS: readonly AccountType[] = [AccountType.AGENT_FEE_PAYABLE, AccountType.AGENT_COD_CASH];

/** Balance and statement reads (spec 12 §4.1). No locks: the ledger is append-only. */
@injectable()
export class FinanceViewService {
  constructor(
    @inject(TOKENS.FinanceAccountRepository) private readonly accounts: FinanceAccountRepository,
    @inject(TOKENS.LedgerEntryRepository) private readonly entries: LedgerEntryRepository,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.DeliveryAgentDirectory) private readonly agents: IDeliveryAgentDirectory,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async listAccounts(query: ParsedListQuery): Promise<Page<AccountView>> {
    const page = toPage(await this.accounts.list(query), query, (account) =>
      query.sort.field === 'balance' ? account.balance.toString() : account.updatedAt,
    );
    return { items: await this.viewsOf(page.items), meta: page.meta };
  }

  async getAccount(accountId: string): Promise<AccountView> {
    const [view] = await this.viewsOf([await this.existing(accountId)]);
    if (!view) throw new Error(`no view for account ${accountId}`);
    return view;
  }

  async listEntries(accountId: string, query: ParsedListQuery): Promise<Page<LedgerEntry>> {
    await this.existing(accountId);
    return toPage(await this.entries.listForAccount(accountId, query), query, (entry) => entry.createdAt);
  }

  /** Every entry of one reference (at most 6, so not paginated: spec 12 FI-9). */
  entriesByReference(referenceType: ReferenceType, referenceId: string): Promise<LedgerEntry[]> {
    return this.entries.findByReference(referenceType, referenceId);
  }

  /** The caller's own accounts that exist yet (seller / agent balances, FI-11). */
  ownAccounts(keys: readonly AccountKey[]): Promise<FinanceAccount[]> {
    return this.accounts.findByKeys(keys);
  }

  /** The caller's own statement; an account that doesn't exist yet has no entries (FI-11). */
  async ownEntries(key: AccountKey, query: ParsedListQuery): Promise<Page<LedgerEntry>> {
    const [account] = await this.accounts.findByKeys([key]);
    const rows = account ? await this.entries.listForAccount(account.id, query) : [];
    return toPage(rows, query, (entry) => entry.createdAt);
  }

  private async existing(accountId: string): Promise<FinanceAccount> {
    const account = await this.accounts.findById(accountId);
    if (!account) throw accountNotFound();
    return account;
  }

  /** Owner names with one batched lookup per owning module (G20). */
  private async viewsOf(accounts: readonly FinanceAccount[]): Promise<AccountView[]> {
    const ownersOf = (types: readonly AccountType[]) => [
      ...new Set(
        accounts.flatMap((a) => (types.includes(a.accountType) && a.ownerId !== null ? [a.ownerId] : [])),
      ),
    ];
    const sellerIds = ownersOf(SELLER_ACCOUNTS);
    const agentIds = ownersOf(AGENT_ACCOUNTS);
    const [sellers, agents] = await Promise.all([
      sellerIds.length > 0 ? this.sellers.getSummaries(sellerIds) : [],
      agentIds.length > 0 ? this.agents.getAgentSummaries(agentIds) : [],
    ]);
    const sellerNames = new Map(sellers.map((s) => [s.sellerId, s.businessName]));
    const agentNames = new Map(agents.map((a) => [a.agentId, a.fullName]));

    return accounts.map((account) => {
      if (account.ownerId === null) return { account, ownerName: null };
      const names = SELLER_ACCOUNTS.includes(account.accountType) ? sellerNames : agentNames;
      const ownerName = names.get(account.ownerId) ?? null;
      if (ownerName === null) {
        this.logger.warn('finance account owner not found', {
          event: 'FINANCE_ACCOUNT_OWNER_MISSING',
          accountId: account.id,
          accountType: account.accountType,
          ownerId: account.ownerId,
        });
      }
      return { account, ownerName };
    });
  }
}
