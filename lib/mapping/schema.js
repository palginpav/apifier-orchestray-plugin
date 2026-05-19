'use strict';

// lib/mapping/schema.js — Zod schema for apifier-mapping v1; exports MappingSchemaV1, validate(), JSON_SCHEMA.

const { z } = require('zod');

// ---------------------------------------------------------------------------
// Primitive / shared shapes
// ---------------------------------------------------------------------------

/** Recursive type reference — lazy to handle self-referential shapes. */
const TypeRef = z.lazy(() =>
  z.union([
    z.object({ primitive: z.enum(['string', 'integer', 'number', 'boolean', 'null', 'binary']) }).strict(),
    z.object({ $ref: z.string().min(1) }).strict(),
    z.object({ array: TypeRef }),
    z.object({ map: z.object({ key: TypeRef, value: TypeRef }) }),
    z.object({ union: z.array(TypeRef).min(1) }),
  ])
);

const ParamSchema = z.object({
  name: z.string().min(1),
  type: TypeRef,
  required: z.boolean(),
  description: z.string().nullable().optional(),
  default: z.unknown().nullable().optional(),
  example: z.unknown().nullable().optional(),
  enum: z.array(z.unknown()).nullable().optional(),
  format: z.string().nullable().optional(),
  deprecated: z.boolean().optional(),
  style: z.string().nullable().optional(),
  explode: z.boolean().nullable().optional(),
}).passthrough();

const ResponseObjectSchema = z.object({
  description: z.string().optional(),
  content_type: z.string().optional(),
  schema: TypeRef.optional(),
  headers: z.array(ParamSchema).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Auth schemes — discriminated by `type`
// ---------------------------------------------------------------------------

const AuthBearerSchema = z.object({
  id: z.string().min(1),
  type: z.literal('http-bearer'),
  description: z.string().optional(),
  header_name: z.string().optional(),
  scheme: z.string().optional(),
  bearer_format: z.string().optional(),
}).passthrough();

const AuthApiKeySchema = z.object({
  id: z.string().min(1),
  type: z.literal('api-key'),
  in: z.enum(['header', 'query', 'cookie']).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

const AuthHttpBasicSchema = z.object({
  id: z.string().min(1),
  type: z.literal('http-basic'),
  description: z.string().optional(),
}).passthrough();

const AuthOAuth2Schema = z.object({
  id: z.string().min(1),
  type: z.literal('oauth2'),
  flow: z.enum(['authorization_code', 'implicit', 'password', 'client_credentials']).optional(),
  token_url: z.string().nullable().optional(),
  authorization_url: z.string().nullable().optional(),
  refresh_url: z.string().nullable().optional(),
  scopes: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
  description: z.string().optional(),
}).passthrough();

const AuthCookieSchema = z.object({
  id: z.string().min(1),
  type: z.literal('cookie'),
  name: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

const AuthSignatureSchema = z.object({
  id: z.string().min(1),
  type: z.literal('signature'),
  algorithm: z.string().optional(),
  service: z.string().optional(),
  region_required: z.boolean().optional(),
  description: z.string().optional(),
}).passthrough();

const AuthMutualTlsSchema = z.object({
  id: z.string().min(1),
  type: z.literal('mutual-tls'),
  description: z.string().optional(),
}).passthrough();

const AuthNoneSchema = z.object({
  id: z.string().min(1),
  type: z.literal('none'),
  description: z.string().optional(),
}).passthrough();

const AuthSchemeSchema = z.discriminatedUnion('type', [
  AuthBearerSchema,
  AuthApiKeySchema,
  AuthHttpBasicSchema,
  AuthOAuth2Schema,
  AuthCookieSchema,
  AuthSignatureSchema,
  AuthMutualTlsSchema,
  AuthNoneSchema,
]);

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

const EndpointSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
  transport: z.enum(['http', 'graphql', 'grpc', 'ws', 'kafka', 'mqtt']),
  method: z.string().min(1),
  path: z.string().min(1),
  summary: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  path_params: z.array(ParamSchema).optional(),
  query_params: z.array(ParamSchema).optional(),
  headers: z.array(ParamSchema).optional(),
  cookies: z.array(ParamSchema).optional(),
  body: z.object({
    required: z.boolean().optional(),
    content_type: z.union([z.string(), z.array(z.string())]).optional(),
    schema: TypeRef.optional(),
    encoding: z.unknown().nullable().optional(),
  }).passthrough().nullable().optional(),
  responses: z.record(z.string(), ResponseObjectSchema).optional(),
  error_codes: z.array(z.string()).optional(),
  auth: z.array(z.string()).optional(),
  idempotency: z.object({
    method_intrinsic: z.boolean().optional(),
    header: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  deprecated: z.object({
    is_deprecated: z.boolean().optional(),
    since: z.string().nullable().optional(),
    replacement_endpoint_id: z.string().nullable().optional(),
    sunset_at: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  pagination: z.object({
    style: z.enum(['page', 'offset', 'cursor', 'link-header']).optional(),
    request: z.record(z.string(), z.unknown()).optional(),
    response: z.record(z.string(), z.unknown()).optional(),
  }).passthrough().nullable().optional(),
  rate_limit: z.object({
    requests_per_window: z.number().optional(),
    window_seconds: z.number().optional(),
    scope: z.enum(['global', 'per-token', 'per-ip']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }).passthrough().nullable().optional(),
  examples: z.array(z.string()).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Model field + model
// ---------------------------------------------------------------------------

const ModelFieldSchema = z.object({
  name: z.string().min(1),
  type: TypeRef,
  required: z.boolean().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
  example: z.unknown().optional(),
  enum: z.array(z.unknown()).nullable().optional(),
  format: z.string().optional(),
  deprecated: z.boolean().optional(),
}).passthrough();

const ModelSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['object', 'enum', 'alias', 'union']),
  description: z.string().nullable().optional(),
  fields: z.array(ModelFieldSchema).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Error registry entry
// ---------------------------------------------------------------------------

const ErrorEntrySchema = z.object({
  code: z.string().min(1),
  scope: z.string().optional(),
  status: z.number().int().optional(),
  body: TypeRef.optional(),
  description: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Example entry
// ---------------------------------------------------------------------------

const ExampleEntrySchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().optional(),
  language: z.string().optional(),
  code: z.string().optional(),
  source_origin: z.enum(['scraped', 'specified', 'synthesized']).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Server entry
// ---------------------------------------------------------------------------

const ServerSchema = z.object({
  url: z.string().min(1),
  description: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Source provenance
// ---------------------------------------------------------------------------

const SourceSchema = z.object({
  type: z.string().min(1),
  url: z.string().nullable().optional(),
  file_path: z.string().nullable().optional(),
  fetched_at: z.string().min(1),
  sha256: z.string().nullable().optional(),
  bytes: z.number().int().nullable().optional(),
  robots_respected: z.boolean().nullable().optional(),
  parser: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  parser_warnings: z.array(z.object({
    code: z.string(),
    pointer: z.string().optional(),
    detail: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough().refine(
  s => s.url != null || s.file_path != null,
  { message: 'source requires at least one of url or file_path' }
);

// ---------------------------------------------------------------------------
// Service metadata
// ---------------------------------------------------------------------------

const ServiceSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  display_name: z.string().optional(),
  vendor: z.string().optional(),
  homepage: z.string().optional(),
  summary: z.string().max(500).optional(),
  version: z.string().min(1),
  documentation_url: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Top-level mapping schema (v1)
// additionalProperties: false at top level; x- prefixed extensions allowed via `extensions`
// ---------------------------------------------------------------------------

const MappingSchemaV1 = z.object({
  schema_version: z.literal(1),
  apifier_version: z.string().min(1),
  kind: z.literal('apifier-mapping'),
  service: ServiceSchema,
  source: SourceSchema,
  auth: z.array(AuthSchemeSchema).optional(),
  servers: z.array(ServerSchema).optional(),
  endpoints: z.array(EndpointSchema).min(0),
  models: z.array(ModelSchema).optional(),
  errors: z.array(ErrorEntrySchema).optional(),
  examples: z.array(ExampleEntrySchema).optional(),
  extensions: z.record(
    z.string().regex(/^x-/),
    z.unknown()
  ).optional(),
}).strict();

// ---------------------------------------------------------------------------
// validate() — returns structured report; never throws
// ---------------------------------------------------------------------------

/**
 * Validate a mapping object against MappingSchemaV1.
 * @param {unknown} mapping
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validate(mapping) {
  const result = MappingSchemaV1.safeParse(mapping);
  if (result.success) return { ok: true, errors: [] };
  const errors = result.error.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') + ': ' : '';
    return path + issue.message;
  });
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// JSON_SCHEMA — constant JSON Schema for external tools / docs
// Simplified representative subset (Zod → JSON Schema without a converter lib)
// ---------------------------------------------------------------------------

const JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ApifierMappingV1',
  type: 'object',
  required: ['schema_version', 'apifier_version', 'kind', 'service', 'source', 'endpoints'],
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', const: 1 },
    apifier_version: { type: 'string', minLength: 1 },
    kind: { type: 'string', const: 'apifier-mapping' },
    service: {
      type: 'object',
      required: ['name', 'version'],
      properties: {
        name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
        version: { type: 'string', minLength: 1 },
      },
    },
    source: {
      type: 'object',
      required: ['type', 'fetched_at', 'parser'],
      properties: {
        type: { type: 'string' },
        url: { type: ['string', 'null'] },
        file_path: { type: ['string', 'null'] },
        fetched_at: { type: 'string' },
        sha256: { type: ['string', 'null'] },
        bytes: { type: ['integer', 'null'] },
        robots_respected: { type: ['boolean', 'null'] },
        parser: {
          type: 'object',
          required: ['name', 'version'],
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
          },
        },
      },
    },
    auth: { type: 'array', items: { type: 'object', required: ['id', 'type'] } },
    servers: { type: 'array', items: { type: 'object', required: ['url'] } },
    endpoints: { type: 'array', items: { type: 'object', required: ['id', 'transport', 'method', 'path'] } },
    models: { type: 'array', items: { type: 'object', required: ['name', 'kind'] } },
    errors: { type: 'array', items: { type: 'object', required: ['code'] } },
    examples: { type: 'array', items: { type: 'object', required: ['name'] } },
    extensions: { type: 'object', additionalProperties: true },
  },
};

module.exports = { MappingSchemaV1, validate, JSON_SCHEMA };
