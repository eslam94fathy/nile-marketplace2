/**
 * support module (docs/spec/16-support.md): tickets between customers / sellers and the admins.
 * Owns tables: support_tickets, support_messages, support_message_attachments, support_ticket_reads.
 * No other module reads or writes them.
 * May call: ordering (order links), customers, sellers (names in admin views), identity (assignees,
 * admin emails), media (attachments); audit rows go through lib/audit. Read by realtime (`canView`)
 * and from R2-P5 the back-office (`getStats`).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type ApiEnv } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { type ILogger } from '../../lib/logger';
import { type RateLimiters, requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { SupportTicketController } from './controller/support-ticket.controller';
import { SupportAttachmentRepository } from './repository/support-attachment.repository';
import { SupportMessageRepository } from './repository/support-message.repository';
import { SupportReadRepository } from './repository/support-read.repository';
import { SupportTicketRepository } from './repository/support-ticket.repository';
import { supportRoutes } from './routes';
import { SupportDirectory } from './service/support-directory.service';
import { SupportTicketService } from './service/support-ticket.service';
import { SupportViewService } from './service/support-view.service';

export { SupportErrorCode } from './errors';
export { TicketCategory, TicketStatus, TicketOpenerRole, MessageKind } from './enums';
export type { SupportStats } from './model/support-ticket.model';
/** Inject with `TOKENS.SupportDirectory`. */
export type { ISupportDirectory } from './service/support-directory.service';

/** The public lookups only (`ISupportDirectory`), for the realtime gateway and the back-office. */
export function registerSupportLookups(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.SupportTicketRepository, SupportTicketRepository);
  container.registerSingleton(TOKENS.SupportDirectory, SupportDirectory);
}

/**
 * api process: the ticket endpoints (spec 16 §4). Needs ordering, media and the customers / sellers
 * directories registered.
 */
export function registerSupportModule(container: DependencyContainer): void {
  registerSupportLookups(container);
  container.registerSingleton(TOKENS.SupportMessageRepository, SupportMessageRepository);
  container.registerSingleton(TOKENS.SupportAttachmentRepository, SupportAttachmentRepository);
  container.registerSingleton(TOKENS.SupportReadRepository, SupportReadRepository);
  container.registerSingleton(TOKENS.SupportViewService, SupportViewService);
  container.registerSingleton(TOKENS.SupportTicketService, SupportTicketService);
  container.registerSingleton(TOKENS.SupportTicketController, SupportTicketController);
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createSupportRouter(container: DependencyContainer, basePath: string): Router {
  return supportRoutes({
    tickets: container.resolve<SupportTicketController>(TOKENS.SupportTicketController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    rateLimiters: container.resolve<RateLimiters>(TOKENS.RateLimiters),
    idempotency: requireIdempotency(
      container.resolve<ICache>(TOKENS.Cache),
      container.resolve<ApiEnv>(TOKENS.Env),
      container.resolve<ILogger>(TOKENS.Logger),
    ),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
