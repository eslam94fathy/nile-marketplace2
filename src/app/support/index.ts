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
import { type ApiEnv, type Env } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { type JobDefinition } from '../../lib/jobs';
import { type ILogger } from '../../lib/logger';
import { type RateLimiters, requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { SupportAdminController } from './controller/support-admin.controller';
import { SupportTicketController } from './controller/support-ticket.controller';
import { SupportAttachmentRepository } from './repository/support-attachment.repository';
import { SupportMessageRepository } from './repository/support-message.repository';
import { SupportReadRepository } from './repository/support-read.repository';
import { SupportTicketRepository } from './repository/support-ticket.repository';
import { supportRoutes } from './routes';
import { SupportAdminService } from './service/support-admin.service';
import { SupportAttachmentService } from './service/support-attachment.service';
import { SupportDirectory } from './service/support-directory.service';
import { SupportJobs } from './service/support-jobs.job';
import { SupportTicketService } from './service/support-ticket.service';
import { SupportTimelineService } from './service/support-timeline.service';
import { SupportViewService } from './service/support-view.service';

export { SupportErrorCode } from './errors';
export { TicketCategory, TicketStatus, TicketOpenerRole, MessageKind } from './enums';
export type { SupportStats, TicketState } from './model/support-ticket.model';
/** Inject with `TOKENS.SupportDirectory`. */
export type { ISupportDirectory } from './service/support-directory.service';

/** The public lookups only (`ISupportDirectory`), for the realtime gateway and the back-office. */
export function registerSupportLookups(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.SupportTicketRepository, SupportTicketRepository);
  container.registerSingleton(TOKENS.SupportDirectory, SupportDirectory);
}

/**
 * api process: the ticket endpoints (spec 16 §4). Needs identity, ordering, media and the customers /
 * sellers directories registered.
 */
export function registerSupportModule(container: DependencyContainer): void {
  registerSupportLookups(container);
  container.registerSingleton(TOKENS.SupportMessageRepository, SupportMessageRepository);
  container.registerSingleton(TOKENS.SupportAttachmentRepository, SupportAttachmentRepository);
  container.registerSingleton(TOKENS.SupportReadRepository, SupportReadRepository);
  container.registerSingleton(TOKENS.SupportViewService, SupportViewService);
  container.registerSingleton(TOKENS.SupportTimelineService, SupportTimelineService);
  container.registerSingleton(TOKENS.SupportAttachmentService, SupportAttachmentService);
  container.registerSingleton(TOKENS.SupportTicketService, SupportTicketService);
  container.registerSingleton(TOKENS.SupportTicketController, SupportTicketController);
  container.registerSingleton(TOKENS.SupportAdminService, SupportAdminService);
  container.registerSingleton(TOKENS.SupportAdminController, SupportAdminController);
}

/** worker process: the support jobs (spec 16 UC-SU-5) and the public lookups; no media, no HTTP. */
export function registerSupportWorker(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.SupportTicketRepository, SupportTicketRepository);
  container.registerSingleton(TOKENS.SupportMessageRepository, SupportMessageRepository);
  container.registerSingleton(TOKENS.SupportTimelineService, SupportTimelineService);
  container.registerSingleton(TOKENS.SupportJobs, SupportJobs);
  // realtime.fanout re-reads ticket states through the public API (SU-19).
  container.registerSingleton(TOKENS.SupportDirectory, SupportDirectory);
}

/** `support-jobs`: auto-close and the SLA flag, one advisory-locked job (architecture §14 jobs). */
export function createSupportJobs(
  container: DependencyContainer,
  env: Pick<Env, 'JOB_SUPPORT_INTERVAL_MS'>,
): JobDefinition[] {
  const jobs = container.resolve<SupportJobs>(TOKENS.SupportJobs);
  return [{ name: 'support-jobs', intervalMs: env.JOB_SUPPORT_INTERVAL_MS, run: () => jobs.run() }];
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createSupportRouter(container: DependencyContainer, basePath: string): Router {
  return supportRoutes({
    tickets: container.resolve<SupportTicketController>(TOKENS.SupportTicketController),
    admin: container.resolve<SupportAdminController>(TOKENS.SupportAdminController),
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
