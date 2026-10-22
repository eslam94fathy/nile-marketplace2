import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { invalidQuery, unauthenticated } from '../../../lib/error';
import {
  HTTP_STATUS,
  type ListSpec,
  type ParsedListQuery,
  parseListQuery,
  sendSuccess,
} from '../../../lib/http';
import { Money } from '../../../lib/money';
import { type IDeliveryAgentDirectory } from '../../delivery';
import { type ISellerDirectory } from '../../sellers';
import {
  AGENT_ENTRY_LIST_SPEC,
  AgentStatementAccount,
  ENTRY_LIST_SPEC,
  HOLD_LIST_SPEC,
  OWN_SETTLEMENT_LIST_SPEC,
} from '../dto/finance-request.dto';
import {
  type AgentBalancesDto,
  type SellerBalanceDto,
  type SellerHoldDto,
  toLedgerEntryDto,
  toPayoutDto,
  toRemittanceDto,
} from '../dto/finance-response.dto';
import { AccountType, PayeeType } from '../enums';
import { profileMissing } from '../errors';
import { type AccountKey } from '../model/ledger.model';
import { type CodRemittanceService } from '../service/cod-remittance.service';
import { type FinanceViewService } from '../service/finance-view.service';
import { type PayoutService } from '../service/payout.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

function userIdOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}

function listQuery(req: Request, spec: ListSpec, env: ListEnv): ParsedListQuery {
  return parseListQuery(req.query, spec, {
    defaultLimit: env.PAGINATION_DEFAULT_LIMIT,
    maxLimit: env.PAGINATION_MAX_LIMIT,
  });
}

const balanceOrZero = (balance: Money | undefined): string => (balance ?? Money.zero()).toString();

/**
 * HTTP only (spec 12 §4.2): the seller's own money, read-only. Any seller status (FI-8); every read
 * is scoped to the caller's own account or id, so another seller's rows are unreachable.
 */
@injectable()
export class SellerFinanceController {
  constructor(
    @inject(TOKENS.FinanceViewService) private readonly views: FinanceViewService,
    @inject(TOKENS.PayoutService) private readonly payouts: PayoutService,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  private async sellerIdOf(req: Request): Promise<string> {
    const userId = userIdOf(req);
    const seller = await this.sellers.getSellerByUserId(userId);
    if (!seller) throw profileMissing('seller', userId);
    return seller.sellerId;
  }

  private readonly accountOf = (sellerId: string): AccountKey => ({
    accountType: AccountType.SELLER_PAYABLE,
    ownerId: sellerId,
  });

  /** Spec 12 §8.6: available (`seller_payable`, may be negative) and pending (`seller_pending`). */
  balance = async (req: Request, res: Response): Promise<void> => {
    const sellerId = await this.sellerIdOf(req);
    const accounts = await this.views.ownAccounts([
      this.accountOf(sellerId),
      { accountType: AccountType.SELLER_PENDING, ownerId: sellerId },
    ]);
    const of = (type: AccountType) => accounts.find((a) => a.accountType === type);
    const changed = accounts.map((a) => a.updatedAt.getTime());
    const body: SellerBalanceDto = {
      available: balanceOrZero(of(AccountType.SELLER_PAYABLE)?.balance),
      pending: balanceOrZero(of(AccountType.SELLER_PENDING)?.balance),
      updatedAt: changed.length > 0 ? new Date(Math.max(...changed)).toISOString() : null,
    };
    sendSuccess(res, HTTP_STATUS.OK, body);
  };

  holds = async (req: Request, res: Response): Promise<void> => {
    const sellerId = await this.sellerIdOf(req);
    const page = await this.views.sellerHolds(sellerId, listQuery(req, HOLD_LIST_SPEC, this.env));
    const body: SellerHoldDto[] = page.items.map(({ hold, orderNumber, blockedByReturn }) => ({
      sellerOrderId: hold.sellerOrderId,
      orderNumber,
      heldAmount: hold.heldAmount.toString(),
      releaseAfter: hold.releaseAfter.toISOString(),
      blockedByReturn,
    }));
    sendSuccess(res, HTTP_STATUS.OK, body, page.meta);
  };

  entries = async (req: Request, res: Response): Promise<void> => {
    const sellerId = await this.sellerIdOf(req);
    const page = await this.views.ownEntries(
      this.accountOf(sellerId),
      listQuery(req, ENTRY_LIST_SPEC, this.env),
    );
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toLedgerEntryDto), page.meta);
  };

  listPayouts = async (req: Request, res: Response): Promise<void> => {
    const payeeId = await this.sellerIdOf(req);
    const page = await this.payouts.list(listQuery(req, OWN_SETTLEMENT_LIST_SPEC, this.env), {
      payeeType: PayeeType.SELLER,
      payeeId,
    });
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toPayoutDto), page.meta);
  };
}

/** The agent's two accounts behind `?account=` (spec 12 §4.3). */
const AGENT_ACCOUNT_TYPES = {
  [AgentStatementAccount.FEE]: AccountType.AGENT_FEE_PAYABLE,
  [AgentStatementAccount.COD]: AccountType.AGENT_COD_CASH,
} as const;

/**
 * HTTP only (spec 12 §4.3): the agent's own money, read-only. Any agent status, inactive included
 * (FI-8): a deactivated agent may still hold cash to hand in.
 */
@injectable()
export class AgentFinanceController {
  constructor(
    @inject(TOKENS.FinanceViewService) private readonly views: FinanceViewService,
    @inject(TOKENS.CodRemittanceService) private readonly remittances: CodRemittanceService,
    @inject(TOKENS.DeliveryAgentDirectory) private readonly agents: IDeliveryAgentDirectory,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  private async agentIdOf(req: Request): Promise<string> {
    const userId = userIdOf(req);
    const agent = await this.agents.getAgentByUserId(userId);
    if (!agent) throw profileMissing('delivery_agent', userId);
    return agent.agentId;
  }

  balances = async (req: Request, res: Response): Promise<void> => {
    const agentId = await this.agentIdOf(req);
    const accounts = await this.views.ownAccounts(
      Object.values(AGENT_ACCOUNT_TYPES).map((accountType) => ({ accountType, ownerId: agentId })),
    );
    const balanceOf = (type: AccountType) =>
      balanceOrZero(accounts.find((a) => a.accountType === type)?.balance);
    const body: AgentBalancesDto = {
      feePayable: balanceOf(AccountType.AGENT_FEE_PAYABLE),
      codCashHeld: balanceOf(AccountType.AGENT_COD_CASH),
    };
    sendSuccess(res, HTTP_STATUS.OK, body);
  };

  /** `account` is required: `fee` or `cod`. */
  entries = async (req: Request, res: Response): Promise<void> => {
    const query = listQuery(req, AGENT_ENTRY_LIST_SPEC, this.env);
    const account = Object.values(AgentStatementAccount).find((a) => a === query.extra.account);
    if (!account) {
      throw invalidQuery([{ field: 'account', constraint: 'enum', message: 'account must be fee or cod' }]);
    }
    const agentId = await this.agentIdOf(req);
    const page = await this.views.ownEntries(
      { accountType: AGENT_ACCOUNT_TYPES[account], ownerId: agentId },
      query,
    );
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toLedgerEntryDto), page.meta);
  };

  listRemittances = async (req: Request, res: Response): Promise<void> => {
    const agentId = await this.agentIdOf(req);
    const page = await this.remittances.list(listQuery(req, OWN_SETTLEMENT_LIST_SPEC, this.env), agentId);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toRemittanceDto), page.meta);
  };
}
