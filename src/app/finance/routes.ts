import { type RequestHandler, Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type ParameterObject } from 'openapi3-ts/oas31';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { AGENT_FINANCE_PATHS as AG, FINANCE_ADMIN_PATHS as A, SELLER_FINANCE_PATHS as S } from './constants';
import { type FinanceAdminController } from './controller/finance-admin.controller';
import {
  type AgentFinanceController,
  type SellerFinanceController,
} from './controller/finance-self.controller';
import { CreatePayoutDto, CreateRemittanceDto } from './dto/finance-request.dto';
import {
  AccountDto,
  AgentBalancesDto,
  LedgerEntryDto,
  PayoutDto,
  ReferenceEntryDto,
  RemittanceDto,
  SellerBalanceDto,
} from './dto/finance-response.dto';
import { AccountType, EntryType, PayeeType, ReferenceType } from './enums';

export interface FinanceRouteDeps {
  admin: FinanceAdminController;
  seller: SellerFinanceController;
  agent: AgentFinanceController;
  /** Required `Idempotency-Key` (remittances and payouts: spec 12 §1.3). */
  idempotency: RequestHandler;
  jwtVerifier: JwtVerifier;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 12 §4.1–§4.3. General rate limit (global). */
export function financeRoutes(deps: FinanceRouteDeps): Router {
  const { admin } = deps;
  const router = Router();
  const adminOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];

  router.get(A.ACCOUNTS, ...adminOnly, admin.listAccounts);
  router.get(A.ACCOUNT, ...adminOnly, admin.getAccount);
  router.get(A.ACCOUNT_ENTRIES, ...adminOnly, admin.listAccountEntries);
  router.get(A.ENTRIES, ...adminOnly, admin.entriesByReference);
  router.post(A.COD_REMITTANCES, ...adminOnly, deps.idempotency, admin.createRemittance);
  router.get(A.COD_REMITTANCES, ...adminOnly, admin.listRemittances);
  router.post(A.PAYOUTS, ...adminOnly, deps.idempotency, admin.createPayout);
  router.get(A.PAYOUTS, ...adminOnly, admin.listPayouts);
  documentAdminRoutes(deps.docs, deps.basePath);

  // Read-only views of the caller's own money, in any profile status (FI-8).
  const sellerOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.SELLER)];
  router.get(S.BALANCE, ...sellerOnly, deps.seller.balance);
  router.get(S.ENTRIES, ...sellerOnly, deps.seller.entries);
  router.get(S.PAYOUTS, ...sellerOnly, deps.seller.listPayouts);
  const agentOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.DELIVERY_AGENT)];
  router.get(AG.BALANCES, ...agentOnly, deps.agent.balances);
  router.get(AG.ENTRIES, ...agentOnly, deps.agent.entries);
  router.get(AG.REMITTANCES, ...agentOnly, deps.agent.listRemittances);
  documentSelfRoutes(deps.docs, deps.basePath);

  return router;
}

const page: ParameterObject[] = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
];
const createdAtRange: ParameterObject[] = [
  { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
  { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
];
const newestFirst: ParameterObject = {
  name: 'sort',
  in: 'query',
  schema: { enum: ['createdAt', '-createdAt'] },
};

/** Statements: admin, seller and agent. */
const ENTRY_LIST_QUERY: ParameterObject[] = [
  ...page,
  newestFirst,
  { name: 'entryType[eq]', in: 'query', schema: { enum: Object.values(EntryType) } },
  { name: 'entryType[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
  ...createdAtRange,
];

/** OpenAPI for spec 12 §4.1. */
function documentAdminRoutes(docs: OpenApiRegistry, basePath: string): void {
  const admin = { tags: ['admin: finance'], auth: true } as const;
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.ACCOUNTS}`,
    summary:
      'Finance accounts with their balance and owner name. Filters: accountType[eq|in], ownerId[eq], balance[gt|gte]. Sort: balance, updatedAt (default -balance)',
    query: [
      ...page,
      {
        name: 'sort',
        in: 'query',
        schema: { enum: ['balance', '-balance', 'updatedAt', '-updatedAt'] },
      },
      { name: 'accountType[eq]', in: 'query', schema: { enum: Object.values(AccountType) } },
      { name: 'accountType[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'ownerId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'balance[gt]', in: 'query', schema: { type: 'string' }, description: 'money' },
      { name: 'balance[gte]', in: 'query', schema: { type: 'string' }, description: 'money' },
    ],
    responses: {
      200: { description: 'One page of accounts', body: AccountDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.ACCOUNT}`,
    summary: 'A finance account (ACCOUNT_NOT_FOUND)',
    responses: { 200: { description: 'The account', body: AccountDto } },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.ACCOUNT_ENTRIES}`,
    summary:
      "An account's statement. Filters: entryType[eq|in], createdAt[gte|lte]. Sort: createdAt (default -createdAt) (ACCOUNT_NOT_FOUND)",
    query: [...ENTRY_LIST_QUERY],
    responses: {
      200: { description: 'One page of entries', body: LedgerEntryDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.ENTRIES}`,
    summary:
      'Every ledger entry of one reference, e.g. a seller order; both filters required, not paginated (INVALID_QUERY 400)',
    query: [
      { name: 'referenceType', in: 'query', required: true, schema: { enum: Object.values(ReferenceType) } },
      { name: 'referenceId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
    ],
    responses: { 200: { description: 'The entries, oldest first', body: ReferenceEntryDto, isArray: true } },
  });
  docs.add({
    ...admin,
    method: 'post',
    path: `${basePath}${A.COD_REMITTANCES}`,
    summary:
      "Confirm COD cash an agent handed in; debits the agent's COD cash (AGENT_NOT_FOUND 422, REMITTANCE_EXCEEDS_BALANCE 422)",
    requestBody: CreateRemittanceDto,
    idempotent: true,
    responses: { 201: { description: 'The remittance', body: RemittanceDto } },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.COD_REMITTANCES}`,
    summary:
      'COD remittances. Filters: agentId[eq], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: [
      ...page,
      newestFirst,
      { name: 'agentId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      ...createdAtRange,
    ],
    responses: {
      200: { description: 'One page of remittances', body: RemittanceDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...admin,
    method: 'post',
    path: `${basePath}${A.PAYOUTS}`,
    summary:
      'Record a payout made outside the system; debits what the payee is owed (PAYEE_NOT_FOUND 422, PAYOUT_EXCEEDS_BALANCE 422, PAID_AT_IN_FUTURE 422, PAYOUT_ALREADY_RECORDED 409)',
    requestBody: CreatePayoutDto,
    idempotent: true,
    responses: { 201: { description: 'The payout', body: PayoutDto } },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${A.PAYOUTS}`,
    summary:
      'Payouts. Filters: payeeType[eq], payeeId[eq], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: [
      ...page,
      newestFirst,
      { name: 'payeeType[eq]', in: 'query', schema: { enum: Object.values(PayeeType) } },
      { name: 'payeeId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      ...createdAtRange,
    ],
    responses: {
      200: { description: 'One page of payouts', body: PayoutDto, isArray: true, paginated: true },
    },
  });
}

/** OpenAPI for spec 12 §4.2 (seller) and §4.3 (agent). */
function documentSelfRoutes(docs: OpenApiRegistry, basePath: string): void {
  const own = [...page, newestFirst, ...createdAtRange];
  const seller = { tags: ['seller: finance'], auth: true } as const;
  docs.add({
    ...seller,
    method: 'get',
    path: `${basePath}${S.BALANCE}`,
    summary: 'What the platform owes me; 0.00 and no updatedAt before my first delivery',
    responses: { 200: { description: 'My balance', body: SellerBalanceDto } },
  });
  docs.add({
    ...seller,
    method: 'get',
    path: `${basePath}${S.ENTRIES}`,
    summary:
      'My statement. Filters: entryType[eq|in], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: ENTRY_LIST_QUERY,
    responses: {
      200: { description: 'One page of my entries', body: LedgerEntryDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...seller,
    method: 'get',
    path: `${basePath}${S.PAYOUTS}`,
    summary: 'Payouts made to me. Filters: createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: own,
    responses: {
      200: { description: 'One page of my payouts', body: PayoutDto, isArray: true, paginated: true },
    },
  });

  const agent = { tags: ['agent'], auth: true } as const;
  docs.add({
    ...agent,
    method: 'get',
    path: `${basePath}${AG.BALANCES}`,
    summary: 'Fee shares the platform owes me, and the COD cash I still have to hand in',
    responses: { 200: { description: 'My balances', body: AgentBalancesDto } },
  });
  docs.add({
    ...agent,
    method: 'get',
    path: `${basePath}${AG.ENTRIES}`,
    summary:
      'My statement of one account (account=fee or cod, required). Filters: entryType[eq|in], createdAt[gte|lte]. Sort: createdAt (default -createdAt) (INVALID_QUERY 400)',
    query: [
      { name: 'account', in: 'query', required: true, schema: { enum: ['fee', 'cod'] } },
      ...ENTRY_LIST_QUERY,
    ],
    responses: {
      200: { description: 'One page of my entries', body: LedgerEntryDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...agent,
    method: 'get',
    path: `${basePath}${AG.REMITTANCES}`,
    summary: 'COD cash I handed in. Filters: createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: own,
    responses: {
      200: { description: 'One page of my remittances', body: RemittanceDto, isArray: true, paginated: true },
    },
  });
}
