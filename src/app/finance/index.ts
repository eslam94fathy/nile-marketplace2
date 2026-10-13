/**
 * finance module (docs/spec/12-finance.md): account balances and the append-only ledger, booked from
 * ordering's delivery events; admin COD remittances and payouts; balance and statement views.
 * Owns tables: finance_accounts, ledger_entries, cod_remittances, payouts. No other module reads or
 * writes them. May call: sellers, delivery (profile resolution and display names). Reacts to
 * ordering's events and never calls ordering (architecture §2). This file is its only public surface.
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { type EventHandlerDefinition, OrderClosed, SellerOrderDelivered } from '../../lib/events';
import { LEDGER_QUEUE } from './constants';
import { FinanceAccountRepository } from './repository/finance-account.repository';
import { LedgerEntryRepository } from './repository/ledger-entry.repository';
import { LedgerBookingService } from './service/ledger-booking.service';
import { LedgerService } from './service/ledger.service';

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
