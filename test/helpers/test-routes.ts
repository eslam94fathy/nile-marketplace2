import { IsInt, IsString, Length, Max, Min } from 'class-validator';
import { Router } from 'express';
import { UserRole } from '../../src/lib/auth';
import { HTTP_STATUS, sendNoContent, sendSuccess, validateDto } from '../../src/lib/http';
import {
  authenticate,
  byIpAndEmail,
  RateLimitClass,
  requireIdempotency,
  requireRole,
} from '../../src/lib/middleware';
import { type Infrastructure } from '../../src/infrastructure';

export const TEST_ROUTES_PATH = '/__test';

class EchoDto {
  @IsString()
  @Length(1, 20)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}

/**
 * Routes that exist only in tests (mounted via createApp's `extraRouters`, never by server.ts),
 * to exercise the shared middlewares before any business endpoint exists.
 */
export function createTestRouter(infra: Infrastructure): Router {
  const router = Router();
  const auth = authenticate(infra.jwtVerifier);
  const idempotent = requireIdempotency(infra.cache, infra.env, infra.logger);
  let executions = 0;

  router.post('/echo', async (req, res) => {
    const dto = await validateDto(EchoDto, req.body);
    sendSuccess(res, HTTP_STATUS.OK, dto);
  });

  router.get('/boom', () => {
    throw new Error('database password=hunter2 leaked in message');
  });

  router.get('/admin-only', auth, requireRole(UserRole.ADMIN), (req, res) => {
    sendSuccess(res, HTTP_STATUS.OK, { userId: req.auth?.userId, role: req.auth?.role });
  });

  router.post(
    '/login-like',
    infra.rateLimiters.limit(RateLimitClass.STRICT_AUTH, byIpAndEmail),
    (_req, res) => {
      sendSuccess(res, HTTP_STATUS.OK, { ok: true });
    },
  );

  router.get(
    '/general-limited',
    infra.rateLimiters.limit(RateLimitClass.GENERAL, () => ['fixed']),
    (_req, res) => {
      sendSuccess(res, HTTP_STATUS.OK, { ok: true });
    },
  );

  router.post('/orders', auth, idempotent, async (req, res) => {
    const delayMs = Number((req.body as { delayMs?: unknown }).delayMs ?? 0);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    executions += 1;
    sendSuccess(res, HTTP_STATUS.CREATED, { execution: executions, body: req.body as unknown });
  });

  router.post('/orders-fail', auth, idempotent, () => {
    executions += 1;
    throw new Error('transient failure');
  });

  router.post('/orders-validated', auth, idempotent, async (req, res) => {
    executions += 1;
    const dto = await validateDto(EchoDto, req.body);
    sendSuccess(res, HTTP_STATUS.CREATED, dto);
  });

  router.post('/orders-empty', auth, idempotent, (_req, res) => {
    executions += 1;
    sendNoContent(res);
  });

  router.get('/executions', (_req, res) => {
    sendSuccess(res, HTTP_STATUS.OK, { executions });
  });

  return router;
}
