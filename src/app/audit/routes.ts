import { Router } from 'express';
import { AUDIT_ACTION_NAMES, AuditTargetType } from '../../lib/audit';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { AUDIT_ADMIN_PATHS as A } from './constants';
import { type AuditController } from './controller/audit.controller';
import { AuditEntryDto } from './dto/audit-response.dto';

const TAGS = ['admin: audit'] as const;

export interface AuditRouteDeps {
  audit: AuditController;
  jwtVerifier: JwtVerifier;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 20 §2.5: admin only, general rate limit (applied globally). Every admin may read it (BO-4). */
export function auditRoutes(deps: AuditRouteDeps): Router {
  const { audit, docs, basePath } = deps;
  const router = Router();
  const adminOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];

  router.get(A.LOG, ...adminOnly, audit.list);
  router.get(A.ENTRY, ...adminOnly, audit.get);

  const common = { tags: TAGS, auth: true } as const;
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${A.LOG}`,
    summary:
      'The audit log of admin writes. Filters: actorUserId[eq], action[eq|in], targetType[eq], targetId[eq] (needs targetType), createdAt[gte|lte]. Sort: createdAt (default -createdAt) (INVALID_QUERY)',
    query: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
      { name: 'actorUserId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'action[eq]', in: 'query', schema: { enum: AUDIT_ACTION_NAMES } },
      { name: 'action[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'targetType[eq]', in: 'query', schema: { enum: Object.values(AuditTargetType) } },
      { name: 'targetId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: {
      200: { description: 'One page of audit entries', body: AuditEntryDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${A.ENTRY}`,
    summary: 'One audit entry (AUDIT_ENTRY_NOT_FOUND)',
    responses: { 200: { description: 'The entry', body: AuditEntryDto } },
  });
  return router;
}
