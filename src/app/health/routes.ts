import { Router } from 'express';
import { type SchemaObject } from 'openapi3-ts/oas31';
import { type OpenApiRegistry } from '../../lib/http';
import { type HealthController } from './controller/health.controller';

export const HEALTH_BASE_PATH = '/health';

const DEPENDENCY_CHECK_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['status', 'durationMs'],
  properties: { status: { enum: ['up', 'down'] }, durationMs: { type: 'integer' } },
};

export function healthRoutes(controller: HealthController, docs: OpenApiRegistry): Router {
  const router = Router();
  router.get('/live', controller.live);
  router.get('/ready', controller.ready);

  docs.add({
    method: 'get',
    path: `${HEALTH_BASE_PATH}/live`,
    summary: 'Liveness probe (no dependency checks)',
    tags: ['health'],
    auth: false,
    responses: {
      200: {
        description: 'Process is up',
        body: { type: 'object', required: ['status'], properties: { status: { const: 'up' } } },
      },
    },
  });
  docs.add({
    method: 'get',
    path: `${HEALTH_BASE_PATH}/ready`,
    summary: 'Readiness probe: Postgres, Redis and RabbitMQ, each with a timeout (503 when any is down)',
    tags: ['health'],
    auth: false,
    responses: {
      200: {
        description: 'All dependencies are up',
        body: {
          type: 'object',
          required: ['status', 'checks'],
          properties: {
            status: { const: 'up' },
            checks: {
              type: 'object',
              required: ['postgres', 'redis', 'rabbitmq'],
              properties: {
                postgres: DEPENDENCY_CHECK_SCHEMA,
                redis: DEPENDENCY_CHECK_SCHEMA,
                rabbitmq: DEPENDENCY_CHECK_SCHEMA,
              },
            },
          },
        },
      },
    },
  });
  return router;
}
