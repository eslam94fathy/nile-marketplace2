import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { AccountType } from '../enums';
import { type FinanceAccountRepository } from '../repository/finance-account.repository';

/** Finance's part of the dashboard (spec 20 §3.2). Money strings; "0.00" without accounts (FI-11). */
export interface FinanceDashboardStats {
  /** Σ `agent_cod_cash`: cash agents collected and haven't remitted yet. */
  codOutstanding: string;
  /** Σ `seller_payable`; may include negative balances (FI-12). */
  sellerPayable: string;
  agentFeePayable: string;
}

/** Public API of finance for the back-office (spec 20 §3.2). Reads without locks. */
export interface IFinanceDirectory {
  getDashboardStats(): Promise<FinanceDashboardStats>;
}

@injectable()
export class FinanceDirectory implements IFinanceDirectory {
  constructor(@inject(TOKENS.FinanceAccountRepository) private readonly accounts: FinanceAccountRepository) {}

  async getDashboardStats(): Promise<FinanceDashboardStats> {
    const sums = await this.accounts.sumBalances([
      AccountType.AGENT_COD_CASH,
      AccountType.SELLER_PAYABLE,
      AccountType.AGENT_FEE_PAYABLE,
    ]);
    const of = (type: AccountType) => (sums.get(type) ?? Money.zero()).toString();
    return {
      codOutstanding: of(AccountType.AGENT_COD_CASH),
      sellerPayable: of(AccountType.SELLER_PAYABLE),
      agentFeePayable: of(AccountType.AGENT_FEE_PAYABLE),
    };
  }
}
