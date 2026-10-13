import { type ClassConstructor } from 'class-transformer';
import { defaultMetadataStorage } from 'class-transformer/cjs/storage';
import { validationMetadatasToSchemas } from 'class-validator-jsonschema';
import {
  OpenApiBuilder,
  type OpenAPIObject,
  type OperationObject,
  type ParameterObject,
  type ReferenceObject,
  type ResponsesObject,
  type SchemaObject,
} from 'openapi3-ts/oas31';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ResponseDoc {
  description: string;
  /** Response DTO class (class-validator decorated) or an inline schema. Omit for 204. */
  body?: ClassConstructor<object> | SchemaObject;
  isArray?: boolean;
  /** Adds `meta: PageMeta` to the success envelope. */
  paginated?: boolean;
}

export interface RouteDoc {
  method: HttpMethod;
  /** Express-style path, e.g. `/api/v1/orders/:orderId`. */
  path: string;
  summary: string;
  tags: readonly string[];
  /** true = Bearer access token required. */
  auth: boolean;
  requestBody?: ClassConstructor<object>;
  query?: readonly ParameterObject[];
  idempotent?: boolean;
  /** Success responses by status code. Error responses are added automatically. */
  responses: Readonly<Record<number, ResponseDoc>>;
}

export interface ApiInfo {
  title: string;
  version: string;
}

const SCHEMA_PREFIX = '#/components/schemas/';
const ref = (name: string): ReferenceObject => ({ $ref: `${SCHEMA_PREFIX}${name}` });

function isDtoClass(body: ClassConstructor<object> | SchemaObject): body is ClassConstructor<object> {
  return typeof body === 'function';
}

const PAGE_META_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['nextCursor', 'hasMore', 'limit'],
  properties: {
    nextCursor: { type: ['string', 'null'] },
    hasMore: { type: 'boolean' },
    limit: { type: 'integer' },
  },
};

const ERROR_ENVELOPE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['success', 'error', 'correlationId'],
  properties: {
    success: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', examples: ['VALIDATION_FAILED'] },
        message: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            required: ['field', 'constraint', 'message'],
            properties: {
              field: { type: 'string' },
              constraint: { type: 'string' },
              message: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      },
    },
    correlationId: { type: ['string', 'null'], format: 'uuid' },
  },
};

/**
 * Collects route docs from every module and builds one OpenAPI 3.1 document from the
 * class-validator DTOs (CLAUDE.md §7: an endpoint is not done until it is documented).
 */
export class OpenApiRegistry {
  private readonly routes: RouteDoc[] = [];

  add(doc: RouteDoc): void {
    if (this.routes.some((route) => route.method === doc.method && route.path === doc.path)) {
      throw new Error(`OpenAPI route documented twice: ${doc.method.toUpperCase()} ${doc.path}`);
    }
    this.routes.push(doc);
  }

  build(info: ApiInfo): OpenAPIObject {
    const dtoSchemas = validationMetadatasToSchemas({
      classTransformerMetadataStorage: defaultMetadataStorage,
      refPointerPrefix: SCHEMA_PREFIX,
    }) as Record<string, SchemaObject>;

    const builder = OpenApiBuilder.create()
      .addOpenApiVersion('3.1.0')
      .addInfo({ title: info.title, version: info.version })
      .addSecurityScheme('bearerAuth', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addSchema('ErrorEnvelope', ERROR_ENVELOPE_SCHEMA)
      .addSchema('PageMeta', PAGE_META_SCHEMA);
    for (const [name, schema] of Object.entries(dtoSchemas)) builder.addSchema(name, schema);

    const byPath = new Map<string, Record<string, OperationObject>>();
    for (const route of this.routes) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const operations = byPath.get(path) ?? {};
      operations[route.method] = this.operation(route);
      byPath.set(path, operations);
    }
    for (const [path, operations] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
      builder.addPath(path, operations);
    }
    return builder.getSpec();
  }

  private operation(route: RouteDoc): OperationObject {
    const parameters: ParameterObject[] = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
      name: match[1] ?? '',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }));
    if (route.idempotent) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      });
    }
    parameters.push(...(route.query ?? []));

    const responses: ResponsesObject = {};
    for (const [status, response] of Object.entries(route.responses)) {
      responses[status] = response.body
        ? {
            description: response.description,
            content: { 'application/json': { schema: this.envelope(response) } },
          }
        : { description: response.description };
    }
    responses.default = {
      description: 'Error (see docs/spec/01-api-conventions.md §6 and the module error codes)',
      content: { 'application/json': { schema: ref('ErrorEnvelope') } },
    };

    return {
      summary: route.summary,
      tags: [...route.tags],
      ...(route.auth ? { security: [{ bearerAuth: [] }] } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.requestBody
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(route.requestBody.name) } },
            },
          }
        : {}),
      responses,
    };
  }

  private envelope(response: ResponseDoc): SchemaObject {
    const body = response.body;
    const item: SchemaObject | ReferenceObject = body && isDtoClass(body) ? ref(body.name) : (body ?? {});
    const data: SchemaObject = response.isArray ? { type: 'array', items: item } : { allOf: [item] };
    return {
      type: 'object',
      required: response.paginated ? ['success', 'data', 'meta'] : ['success', 'data'],
      properties: {
        success: { const: true },
        data,
        ...(response.paginated ? { meta: ref('PageMeta') } : {}),
      },
    };
  }
}
