/**
 * audit module (docs/spec/20-backoffice.md §2): the append-only log of admin writes and CLI runs.
 * Owns tables: admin_audit_log. No other module reads or writes it.
 * Other modules write through `IAuditRecorder` (lib/audit, `TOKENS.AuditRecorder`), never by
 * importing this module. May call: identity (actor emails in the read endpoints).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type Env } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { type JobDefinition } from '../../lib/jobs';
import { AuditController } from './controller/audit.controller';
import { AuditLogRepository } from './repository/audit-log.repository';
import { auditRoutes } from './routes';
import { AuditRecorderService } from './service/audit-recorder.service';
import { AuditRetentionJob } from './service/audit-retention.job';
import { AuditViewService } from './service/audit-view.service';

export { AuditErrorCode } from './errors';

/** Every process that runs admin writes or the retention job (api, worker, seed-admin CLI). */
export function registerAuditRecorder(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.AuditLogRepository, AuditLogRepository);
  container.registerSingleton(TOKENS.AuditRecorder, AuditRecorderService);
}

/** api process: the read endpoints. Needs identity's AccountService. */
export function registerAuditModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.AuditViewService, AuditViewService);
  container.registerSingleton(TOKENS.AuditController, AuditController);
}

/** worker process. */
export function registerAuditWorker(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.AuditRetentionJob, AuditRetentionJob);
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createAuditRouter(container: DependencyContainer, basePath: string): Router {
  return auditRoutes({
    audit: container.resolve<AuditController>(TOKENS.AuditController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}

export function createAuditJobs(
  container: DependencyContainer,
  env: Pick<Env, 'JOB_AUDIT_RETENTION_INTERVAL_MS' | 'AUDIT_RETENTION_DAYS' | 'AUDIT_RETENTION_BATCH_SIZE'>,
): JobDefinition[] {
  const retention = container.resolve<AuditRetentionJob>(TOKENS.AuditRetentionJob);
  return [
    {
      name: 'audit-retention',
      intervalMs: env.JOB_AUDIT_RETENTION_INTERVAL_MS,
      run: () => retention.run(env.AUDIT_RETENTION_DAYS, env.AUDIT_RETENTION_BATCH_SIZE),
    },
  ];
}
