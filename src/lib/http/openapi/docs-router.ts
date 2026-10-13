import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { type ApiInfo, type OpenApiRegistry } from './openapi-registry';

export const OPENAPI_JSON_PATH = '/openapi.json';

/** `GET <mount>/openapi.json` + Swagger UI at `<mount>/`. Mounted only when API_DOCS_ENABLED (P0-Q4). */
export function createDocsRouter(registry: OpenApiRegistry, info: ApiInfo): Router {
  const router = Router();
  let cached: ReturnType<OpenApiRegistry['build']> | undefined;
  router.get(OPENAPI_JSON_PATH, (_req, res) => {
    cached ??= registry.build(info);
    res.json(cached);
  });
  router.use(
    '/',
    swaggerUi.serve,
    swaggerUi.setup(undefined, { swaggerOptions: { url: `.${OPENAPI_JSON_PATH}` } }),
  );
  return router;
}
