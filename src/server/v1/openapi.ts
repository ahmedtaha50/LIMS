/**
 * The OpenAPI 3.1 document of /api/v1 (roadmap M22), generated from the route registry (./registry.ts): the same strict Zod schemas
 * that validate each request are turned into its JSON Schema with Zod's own z.toJSONSchema (draft 2020-12, which OpenAPI 3.1 uses).
 * The committed copy is docs/api/openapi.json (written by `npx tsx src/server/v1/openapi-cli.ts write`; tests/api/api-v1-openapi.test.ts
 * fails when it is stale), and the server serves the generated document at GET /api/v1/openapi.json.
 *
 * validateOpenApiDocument is a structural check of the document (operation ids, path parameters, responses, security, every $ref
 * resolves, JSON Schema keywords): there is no OpenAPI validator package in this offline build, so this is the repository's own check.
 */
import { z, type ZodType } from 'zod';
import { PROBLEM_CODES } from './problem';
import { defineRoute, v1Routes, type V1Route } from './registry';
import './routes';
import { API_SCOPES } from './scopes';

/** The contract version. A breaking change is a new major version under a new prefix (/api/v2), never an edit of this one. */
export const API_V1_VERSION = '1.0.0';

type Json = Record<string, any>;

function jsonSchema(schema: ZodType, io: 'input' | 'output'): Json {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Json;
  delete out.$schema;
  return out;
}

const accepts = (schema: ZodType) => schema.safeParse(undefined).success;

function parametersOf(obj: z.ZodObject<any> | undefined, where: 'path' | 'query'): Json[] {
  if (!obj) return [];
  return Object.entries(obj.shape as Record<string, ZodType>).map(([name, field]) => {
    const schema = jsonSchema(field, 'input');
    const description = schema.description;
    delete schema.description;
    return { name, in: where, required: where === 'path' ? true : !accepts(field), ...(description ? { description } : {}), schema };
  });
}

const TITLES: Record<number, string> = {
  400: 'The request is not valid (problem details name each error)', 401: 'No valid API token', 403: 'The token lacks the scope', 404: 'Not found',
  409: 'Conflict with the current state or version of a record', 422: 'Idempotency-Key reused for a different request', 423: 'The record is locked',
  500: 'Unexpected error',
};
const problemResponse = (status: number) => ({
  description: TITLES[status] ?? 'Error',
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

function operationOf(route: V1Route): Json {
  const parameters = [...parametersOf(route.params, 'path'), ...parametersOf(route.query, 'query')];
  if (route.idempotent) {
    parameters.push({
      name: 'Idempotency-Key', in: 'header', required: true,
      description: 'Unique per logical request. A repeat with the same key and body gets the stored answer and writes nothing; the same key with another body is 422.',
      schema: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[\\x21-\\x7E]+$' },
    });
  }
  const responses: Json = {};
  for (const [status, r] of Object.entries(route.responses)) {
    responses[status] = {
      description: r.description,
      ...(route.idempotent ? { headers: { 'Idempotent-Replayed': { description: '"true" when this is the stored answer of an earlier call with the same key', schema: { type: 'string', enum: ['true'] } } } } : {}),
      content: { 'application/json': { schema: jsonSchema(r.schema, 'output') } },
    };
  }
  const errors = new Set<number>(route.public ? [500] : [401, 403, 500]);
  for (const s of route.errors ?? []) errors.add(s);
  if (route.query || route.params || route.body) errors.add(400);
  for (const s of [...errors].sort((a, b) => a - b)) responses[String(s)] = problemResponse(s);
  if (!route.public) {
    responses['429'] = {
      description: 'Too many requests for this token (the rate limiter of the server; plain JSON, with a Retry-After header)',
      content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string', enum: ['RATE_LIMITED'] }, retryAfterSeconds: { type: 'integer' } }, required: ['error', 'code'] } } },
    };
  }
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(route.body, 'input') } } } } : {}),
    responses,
    security: route.public ? [] : [{ apiToken: [route.scope] }],
  };
}

const problemSchema = {
  type: 'object',
  description: 'RFC 9457 problem details. `code` is a stable machine code (see x-problem-codes); `errors` names each refused field or batch item.',
  properties: {
    type: { type: 'string', description: 'Link to the entry of `code` on the local docs page' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    requestId: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { pointer: { type: 'string', description: 'JSON pointer into the request, e.g. /items/3/value' }, detail: { type: 'string' }, index: { type: 'integer', description: 'The refused item of a batch' }, code: { type: 'string' } },
        required: ['pointer', 'detail'],
      },
    },
  },
  required: ['type', 'title', 'status', 'detail', 'code', 'requestId'],
};

export function buildOpenApiDocument(): Json {
  const paths: Json = {};
  for (const { route } of v1Routes()) {
    paths[route.path] ??= {};
    paths[route.path][route.method.toLowerCase()] = operationOf(route);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'B-Pharma LIMS machine integration API',
      version: API_V1_VERSION,
      description: 'For instruments, chromatography data systems and middleware. Authenticate with an API token issued by an Administrator ' +
        '(API clients screen); every record a client writes is attributed to its own service account in the audit trail. ' +
        'Writes are all-or-nothing batches of up to 500 items and need an Idempotency-Key. Errors are application/problem+json. ' +
        'Nothing in this API makes an electronic signature: review, approval and release stay with a person.',
    },
    servers: [{ url: '/api/v1' }],
    paths,
    components: {
      securitySchemes: {
        apiToken: {
          type: 'http', scheme: 'bearer', bearerFormat: 'lims_<8 characters>_<43 characters>',
          description: 'An API token. The scope an operation needs is listed in its security requirement. Scopes: ' +
            API_SCOPES.map(s => `${s.scope} (${s.description})`).join('; '),
        },
      },
      schemas: { Problem: problemSchema },
    },
    'x-scopes': API_SCOPES.map(s => ({ ...s })),
    'x-problem-codes': Object.entries(PROBLEM_CODES).map(([code, description]) => ({ code, description })),
  };
}

// GET /openapi.json: the contract itself, without a token (it holds no data).
defineRoute({
  method: 'GET', path: '/openapi.json', operationId: 'getOpenApiDocument', public: true,
  summary: 'This OpenAPI document',
  responses: { 200: { description: 'The OpenAPI 3.1 document of /api/v1', schema: z.record(z.string(), z.unknown()) } },
  async handler() { return { status: 200, body: buildOpenApiDocument() }; },
});

// ---- structural validation ----------------------------------------------------------------------------------------------------------

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function resolvePointer(doc: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: any = doc;
  for (const part of ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

function checkSchema(doc: Json, schema: any, at: string, out: string[]) {
  if (schema === true || schema === false) return;
  if (!schema || typeof schema !== 'object') { out.push(`${at}: a schema must be an object`); return; }
  if (typeof schema.$ref === 'string' && resolvePointer(doc, schema.$ref) === undefined) out.push(`${at}: $ref ${schema.$ref} does not resolve`);
  if (schema.type !== undefined) for (const t of [schema.type].flat()) if (!TYPES.has(t)) out.push(`${at}: unknown type "${t}"`);
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((k: unknown) => typeof k !== 'string')) out.push(`${at}: required must be a list of names`);
    else if (schema.properties) for (const k of schema.required) if (!(k in schema.properties)) out.push(`${at}: required "${k}" is not a property`);
  }
  for (const [k, v] of Object.entries(schema.properties ?? {})) checkSchema(doc, v, `${at}.properties.${k}`, out);
  if (schema.items !== undefined) checkSchema(doc, schema.items, `${at}.items`, out);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') checkSchema(doc, schema.additionalProperties, `${at}.additionalProperties`, out);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key] !== undefined) {
    if (!Array.isArray(schema[key])) out.push(`${at}: ${key} must be a list`);
    else schema[key].forEach((s: unknown, i: number) => checkSchema(doc, s, `${at}.${key}[${i}]`, out));
  }
}

/** Every problem found in `doc`; empty for a valid document. */
export function validateOpenApiDocument(doc: Json): string[] {
  const out: string[] = [];
  if (typeof doc?.openapi !== 'string' || !/^3\.1\.\d+$/.test(doc.openapi)) out.push('openapi must be 3.1.x');
  if (typeof doc?.info?.title !== 'string' || typeof doc?.info?.version !== 'string') out.push('info.title and info.version are required');
  if (!doc?.paths || typeof doc.paths !== 'object') { out.push('paths is required'); return out; }
  const schemes = doc.components?.securitySchemes ?? {};
  for (const [name, s] of Object.entries(schemes) as Array<[string, any]>) if (!['apiKey', 'http', 'mutualTLS', 'oauth2', 'openIdConnect'].includes(s?.type)) out.push(`securityScheme ${name}: unknown type`);
  for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) checkSchema(doc, s, `components.schemas.${name}`, out);
  const ids = new Map<string, string>();
  for (const [path, item] of Object.entries(doc.paths) as Array<[string, any]>) {
    if (!path.startsWith('/')) out.push(`path ${path} must start with /`);
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
    for (const [method, op] of Object.entries(item) as Array<[string, any]>) {
      const where = `${method.toUpperCase()} ${path}`;
      if (!METHODS.includes(method)) { out.push(`${where}: unknown method`); continue; }
      if (typeof op.operationId !== 'string' || !op.operationId) out.push(`${where}: operationId is required`);
      else if (ids.has(op.operationId)) out.push(`${where}: operationId ${op.operationId} is also used by ${ids.get(op.operationId)}`);
      else ids.set(op.operationId, where);
      const params: any[] = op.parameters ?? [];
      for (const p of params) {
        if (typeof p?.name !== 'string' || !['query', 'header', 'path', 'cookie'].includes(p?.in)) out.push(`${where}: a parameter needs a name and a valid "in"`);
        if (p?.in === 'path' && (p.required !== true || !templated.includes(p.name))) out.push(`${where}: path parameter ${p.name} must be required and appear in the path`);
        checkSchema(doc, p?.schema, `${where} parameter ${p?.name}`, out);
      }
      for (const name of templated) if (!params.some(p => p?.in === 'path' && p.name === name)) out.push(`${where}: path parameter {${name}} is not declared`);
      if (op.requestBody) for (const [type, media] of Object.entries(op.requestBody.content ?? {}) as Array<[string, any]>) checkSchema(doc, media.schema, `${where} requestBody ${type}`, out);
      const responses = Object.entries(op.responses ?? {}) as Array<[string, any]>;
      if (responses.length === 0) out.push(`${where}: responses are required`);
      for (const [status, r] of responses) {
        if (!/^([1-5]\d\d|[1-5]XX|default)$/.test(status)) out.push(`${where}: response key ${status} is not a status`);
        if (typeof r?.description !== 'string') out.push(`${where} ${status}: description is required`);
        for (const [type, media] of Object.entries(r?.content ?? {}) as Array<[string, any]>) checkSchema(doc, media.schema, `${where} ${status} ${type}`, out);
      }
      for (const req of op.security ?? []) for (const name of Object.keys(req)) if (!(name in schemes)) out.push(`${where}: security scheme ${name} is not declared`);
    }
  }
  return out;
}
