/**
 * finance module (docs/spec/12-finance.md): account balances and the append-only ledger, booked from
 * ordering's delivery events; admin COD remittances and payouts; balance and statement views.
 * Owns tables: finance_accounts, ledger_entries, cod_remittances, payouts. No other module reads or
 * writes them. May call: sellers, delivery (profile resolution and display names). Reacts to
 * ordering's events and never calls ordering (architecture §2). This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type ApiEnv } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type EventHandlerDefinition, OrderClosed, SellerOrderDelivered } from '../../lib/events';
import { type OpenApiRegistry } from '../../lib/http';
import { type ILogger } from '../../lib/logger';
import { requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { LEDGER_QUEUE } from './constants';
import { FinanceAdminController } from './controller/finance-admin.controller';
import { AgentFinanceController, SellerFinanceController } from './controller/finance-self.controller';
import { registerFinanceConstraintErrors } from './errors';
import { CodRemittanceRepository } from './repository/cod-remittance.repository';
import { FinanceAccountRepository } from './repository/finance-account.repository';
import { LedgerEntryRepository } from './repository/ledger-entry.repository';
import { PayoutRepository } from './repository/payout.repository';
import { financeRoutes } from './routes';
import { CodRemittanceService } from './service/cod-remittance.service';
import { FinanceViewService } from './service/finance-view.service';
import { LedgerBookingService } from './service/ledger-booking.service';
import { LedgerService } from './service/ledger.service';
import { PayoutService } from './service/payout.service';

export { FinanceErrorCode } from './errors';

/** What both processes need: the account and entry repositories and the ledger writer. */
function registerFinanceCore(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.FinanceAccountRepository, FinanceAccountRepository);
  container.registerSingleton(TOKENS.LedgerEntryRepository, LedgerEntryRepository);
  container.registerSingleton(TOKENS.LedgerService, LedgerService);
}

/** worker process: the `finance.ledger` consumer only; it resolves no names (spec 12 FI-10). */
export function registerFinanceWorker(container: DependencyContainer): void {
  registerFinanceCore(container);
  container.registerSingleton(TOKENS.LedgerBookingService, LedgerBookingService);
}

/** Consumer `finance.ledger` (spec 12 §1.2, spec 02 §2). */
export function createFinanceHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const bookings = container.resolve<LedgerBookingService>(TOKENS.LedgerBookingService);
  return [
    {
      name: LEDGER_QUEUE,
      events: [SellerOrderDelivered, OrderClosed],
      handle: (envelope, trx) => bookings.handle(envelope, trx),
    },
  ];
}

/**
 * api process: every finance endpoint (FI-10). Register after sellers and delivery, whose public
 * directories it uses.
 */
export function registerFinanceModule(container: DependencyContainer): void {
  registerFinanceConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
  registerFinanceCore(container);
  container.registerSingleton(TOKENS.CodRemittanceRepository, CodRemittanceRepository);
  container.registerSingleton(TOKENS.PayoutRepository, PayoutRepository);
  container.registerSingleton(TOKENS.FinanceViewService, FinanceViewService);
  container.registerSingleton(TOKENS.CodRemittanceService, CodRemittanceService);
  container.registerSingleton(TOKENS.PayoutService, PayoutService);
  container.registerSingleton(TOKENS.FinanceAdminController, FinanceAdminController);
  container.registerSingleton(TOKENS.SellerFinanceController, SellerFinanceController);
  container.registerSingleton(TOKENS.AgentFinanceController, AgentFinanceController);
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createFinanceRouter(container: DependencyContainer, basePath: string): Router {
  return financeRoutes({
    admin: container.resolve<FinanceAdminController>(TOKENS.FinanceAdminController),
    seller: container.resolve<SellerFinanceController>(TOKENS.SellerFinanceController),
    agent: container.resolve<AgentFinanceController>(TOKENS.AgentFinanceController),
    idempotency: requireIdempotency(
      container.resolve<ICache>(TOKENS.Cache),
      container.resolve<ApiEnv>(TOKENS.Env),
      container.resolve<ILogger>(TOKENS.Logger),
    ),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
