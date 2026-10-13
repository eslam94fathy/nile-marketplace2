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
  validateDto,
} from '../../../lib/http';
import { Money } from '../../../lib/money';
import { ReferenceType } from '../enums';
import {
  ACCOUNT_LIST_SPEC,
  AccountIdParamsDto,
  CreatePayoutDto,
  CreateRemittanceDto,
  ENTRIES_BY_REFERENCE_SPEC,
  ENTRY_LIST_SPEC,
  PAYOUT_LIST_SPEC,
  REMITTANCE_LIST_SPEC,
} from '../dto/finance-request.dto';
import {
  toAccountDto,
  toLedgerEntryDto,
  toPayoutDto,
  toReferenceEntryDto,
  toRemittanceDto,
} from '../dto/finance-response.dto';
import { type CodRemittanceService } from '../service/cod-remittance.service';
import { type FinanceViewService } from '../service/finance-view.service';
import { type PayoutService } from '../service/payout.service';

type ListEnv = Pick<ApiEnv, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

function userIdOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}

/** HTTP only (spec 12 §4.1). Routes are admin-guarded. */
@injectable()
export class FinanceAdminController {
  constructor(
    @inject(TOKENS.FinanceViewService) private readonly views: FinanceViewService,
    @inject(TOKENS.CodRemittanceService) private readonly remittances: CodRemittanceService,
    @inject(TOKENS.PayoutService) private readonly payouts: PayoutService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  private listQuery(req: Request, spec: ListSpec): ParsedListQuery {
    return parseListQuery(req.query, spec, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
  }

  listAccounts = async (req: Request, res: Response): Promise<void> => {
    const page = await this.views.listAccounts(this.listQuery(req, ACCOUNT_LIST_SPEC));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAccountDto), page.meta);
  };

  getAccount = async (req: Request, res: Response): Promise<void> => {
    const { accountId } = await validateDto(AccountIdParamsDto, req.params);
    sendSuccess(res, HTTP_STATUS.OK, toAccountDto(await this.views.getAccount(accountId)));
  };

  listAccountEntries = async (req: Request, res: Response): Promise<void> => {
    const { accountId } = await validateDto(AccountIdParamsDto, req.params);
    const page = await this.views.listEntries(accountId, this.listQuery(req, ENTRY_LIST_SPEC));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toLedgerEntryDto), page.meta);
  };

  /** Both filters are required (spec 12 §4.1); the result is complete, so no page meta (FI-9). */
  entriesByReference = async (req: Request, res: Response): Promise<void> => {
    const { filters } = this.listQuery(req, ENTRIES_BY_REFERENCE_SPEC);
    const valueOf = (field: string) => filters.find((f) => f.field === field)?.value;
    // The whitelist already restricted it to the enum values.
    const referenceType = Object.values(ReferenceType).find((t) => t === valueOf('referenceType'));
    const referenceId = valueOf('referenceId');
    if (typeof referenceType !== 'string' || typeof referenceId !== 'string') {
      throw invalidQuery(
        [
          ...(typeof referenceType === 'string' ? [] : ['referenceType']),
          ...(typeof referenceId === 'string' ? [] : ['referenceId']),
        ].map((field) => ({ field, constraint: 'required', message: `${field} is required` })),
      );
    }
    const entries = await this.views.entriesByReference(referenceType, referenceId);
    sendSuccess(res, HTTP_STATUS.OK, entries.map(toReferenceEntryDto));
  };

  createRemittance = async (req: Request, res: Response): Promise<void> => {
    const input = await validateDto(CreateRemittanceDto, req.body);
    const remittance = await this.remittances.confirm(
      { agentId: input.agentId, amount: Money.of(input.amount), note: input.note ?? null },
      userIdOf(req),
    );
    sendSuccess(res, HTTP_STATUS.CREATED, toRemittanceDto(remittance));
  };

  listRemittances = async (req: Request, res: Response): Promise<void> => {
    const page = await this.remittances.list(this.listQuery(req, REMITTANCE_LIST_SPEC));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toRemittanceDto), page.meta);
  };

  createPayout = async (req: Request, res: Response): Promise<void> => {
    const input = await validateDto(CreatePayoutDto, req.body);
    const payout = await this.payouts.record(
      {
        payeeType: input.payeeType,
        payeeId: input.payeeId,
        amount: Money.of(input.amount),
        externalReference: input.externalReference,
        paidAt: new Date(input.paidAt),
      },
      userIdOf(req),
    );
    sendSuccess(res, HTTP_STATUS.CREATED, toPayoutDto(payout));
  };

  listPayouts = async (req: Request, res: Response): Promise<void> => {
    const page = await this.payouts.list(this.listQuery(req, PAYOUT_LIST_SPEC));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toPayoutDto), page.meta);
  };
}
