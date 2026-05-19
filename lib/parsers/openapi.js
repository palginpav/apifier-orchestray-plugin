'use strict';

// lib/parsers/openapi.js — OpenAPI 3.0/3.1 (and best-effort Swagger 2.0) parser → IR. JSON only in v0.0.1.

const { UnsupportedFormatError, OpenAPIParseError } = require('../errors');

const PARSER_NAME    = 'apifier-openapi-parser';
const PARSER_VERSION = '0.0.1';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

/**
 * Derive a stable endpoint id from operationId or method+path.
 * @param {string} method
 * @param {string} opPath
 * @param {string|undefined} operationId
 * @param {Set<string>} usedIds
 * @returns {string}
 */
function _deriveId(method, opPath, operationId, usedIds) {
  let base;
  if (operationId && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(operationId)) {
    base = operationId;
  } else {
    // slugify: method + path segments
    const pathSlug = opPath.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    base = method.toLowerCase() + '_' + pathSlug;
    // Ensure starts with letter
    if (!/^[A-Za-z]/.test(base)) base = 'op_' + base;
    // Truncate to 128
    base = base.slice(0, 128);
  }
  // Deduplicate
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = base.slice(0, 120) + '_' + suffix++;
  }
  usedIds.add(id);
  return id;
}

/**
 * Convert an OAS schema ref or inline schema to a TypeRef.
 * @param {object|undefined} schema
 * @returns {object}
 */
function _schemaToTypeRef(schema) {
  if (!schema) return { primitive: 'string' };
  if (schema.$ref) {
    // Extract last segment as model name
    const ref = schema.$ref;
    const name = ref.split('/').pop() || ref;
    return { $ref: name };
  }
  const t = schema.type;
  if (t === 'array') {
    return { array: _schemaToTypeRef(schema.items) };
  }
  if (t === 'object' || schema.properties) {
    return { primitive: 'string' }; // inline objects collapsed
  }
  const primitiveMap = {
    string:  'string',
    integer: 'integer',
    number:  'number',
    boolean: 'boolean',
    'null':  'null',
  };
  return { primitive: primitiveMap[t] || 'string' };
}

/**
 * Parse an OAS parameter object into IR Param shape.
 * @param {object} param
 * @returns {object}
 */
function _parseParam(param) {
  return {
    name:        param.name || '',
    type:        _schemaToTypeRef(param.schema),
    required:    Boolean(param.required),
    description: param.description || null,
    default:     param.schema && param.schema.default !== undefined ? param.schema.default : null,
    example:     param.example !== undefined ? param.example : (param.schema && param.schema.example !== undefined ? param.schema.example : null),
    enum:        (param.schema && param.schema.enum) || null,
    format:      (param.schema && param.schema.format) || null,
    deprecated:  Boolean(param.deprecated),
    style:       param.style || null,
    explode:     param.explode !== undefined ? param.explode : null,
  };
}

/**
 * Map OAS requestBody → IR body.
 * @param {object|undefined} requestBody
 * @returns {object|null}
 */
function _parseBody(requestBody) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  const contentType = Object.keys(content)[0] || 'application/json';
  const mediaObj = content[contentType] || {};
  return {
    required:     Boolean(requestBody.required),
    content_type: contentType,
    schema:       _schemaToTypeRef(mediaObj.schema),
    encoding:     null,
  };
}

/**
 * Map OAS responses object → IR responses record.
 * @param {object|undefined} responses
 * @returns {object}
 */
function _parseResponses(responses) {
  if (!responses) return {};
  const result = {};
  for (const [status, resp] of Object.entries(responses)) {
    if (!resp) continue;
    const content = resp.content || {};
    const contentType = Object.keys(content)[0] || null;
    const mediaObj = contentType ? (content[contentType] || {}) : {};
    const entry = {
      description: resp.description || null,
      headers:     [],
    };
    if (contentType) entry.content_type = contentType;
    if (mediaObj.schema) entry.schema = _schemaToTypeRef(mediaObj.schema);
    result[status] = entry;
  }
  return result;
}

/**
 * Determine idempotency from HTTP method.
 * @param {string} method uppercase
 * @returns {object}
 */
function _idempotency(method) {
  const intrinsic = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'].includes(method);
  return { method_intrinsic: intrinsic, header: null, description: null };
}

/**
 * Map a single OAS path-item operation to an IR endpoint.
 * @param {string} method  lowercase
 * @param {string} opPath
 * @param {object} operation
 * @param {object[]} pathLevelParams  parameters at path item level
 * @param {Set<string>} usedIds
 * @param {string[]} warnings mutable
 * @returns {object}
 */
function _parseOperation(method, opPath, operation, pathLevelParams, usedIds, warnings) {
  const upperMethod = method.toUpperCase();
  const id = _deriveId(method, opPath, operation.operationId, usedIds);

  // Merge path-level params with operation-level params (operation wins on name collision).
  const allParams = [...(pathLevelParams || [])];
  for (const p of (operation.parameters || [])) {
    const idx = allParams.findIndex(x => x.name === p.name && x.in === p.in);
    if (idx >= 0) allParams[idx] = p; else allParams.push(p);
  }

  const pathParams  = allParams.filter(p => p.in === 'path').map(_parseParam);
  const queryParams = allParams.filter(p => p.in === 'query').map(_parseParam);
  const headerParams = allParams.filter(p => p.in === 'header').map(_parseParam);
  const cookieParams = allParams.filter(p => p.in === 'cookie').map(_parseParam);

  if (operation.deprecated) {
    warnings.push(`deprecated operation: ${upperMethod} ${opPath}`);
  }

  return {
    id,
    transport:    'http',
    method:       upperMethod,
    path:         opPath,
    summary:      operation.summary || null,
    description:  operation.description || null,
    tags:         operation.tags || [],
    path_params:  pathParams,
    query_params: queryParams,
    headers:      headerParams,
    cookies:      cookieParams,
    body:         _parseBody(operation.requestBody),
    responses:    _parseResponses(operation.responses),
    error_codes:  [],
    auth:         [],
    idempotency:  _idempotency(upperMethod),
    deprecated:   {
      is_deprecated:            Boolean(operation.deprecated),
      since:                    null,
      replacement_endpoint_id:  null,
      sunset_at:                null,
    },
    pagination:   null,
    rate_limit:   null,
    examples:     [],
    'x-origin':   { spec_pointer: `#/paths/${opPath.replace(/\//g, '~1')}/${method}` },
  };
}

/**
 * Map OAS components.schemas → IR models[].
 * @param {object} schemas
 * @returns {object[]}
 */
function _parseModels(schemas) {
  if (!schemas || typeof schemas !== 'object') return [];
  return Object.entries(schemas).map(([name, schema]) => {
    const kind = schema.enum ? 'enum'
      : (schema.type === 'object' || schema.properties) ? 'object'
      : schema.oneOf || schema.anyOf ? 'union'
      : 'alias';

    const fields = [];
    if (schema.properties) {
      const required = new Set(schema.required || []);
      for (const [fname, fschema] of Object.entries(schema.properties)) {
        fields.push({
          name:        fname,
          type:        _schemaToTypeRef(fschema),
          required:    required.has(fname),
          description: fschema.description || undefined,
          format:      fschema.format || undefined,
          enum:        fschema.enum || undefined,
          deprecated:  Boolean(fschema.deprecated),
        });
      }
    }

    return {
      name,
      kind,
      description: schema.description || null,
      fields:      fields.length ? fields : undefined,
      'x-origin':  { spec_pointer: `#/components/schemas/${name}` },
    };
  });
}

/**
 * Map OAS securitySchemes → IR auth[].
 * @param {object} securitySchemes
 * @returns {object[]}
 */
function _parseAuth(securitySchemes) {
  if (!securitySchemes || typeof securitySchemes !== 'object') return [];
  const result = [];
  for (const [id, scheme] of Object.entries(securitySchemes)) {
    if (scheme.type === 'http') {
      if (scheme.scheme && scheme.scheme.toLowerCase() === 'bearer') {
        result.push({
          id,
          type:          'http-bearer',
          description:   scheme.description || undefined,
          header_name:   'Authorization',
          scheme:        'Bearer',
          bearer_format: scheme.bearerFormat || undefined,
        });
      } else if (scheme.scheme && scheme.scheme.toLowerCase() === 'basic') {
        result.push({ id, type: 'http-basic', description: scheme.description || undefined });
      } else {
        result.push({ id, type: 'http-bearer', description: scheme.description || undefined });
      }
    } else if (scheme.type === 'apiKey') {
      result.push({
        id,
        type:        'api-key',
        in:          scheme.in || 'header',
        name:        scheme.name || undefined,
        description: scheme.description || undefined,
      });
    } else if (scheme.type === 'oauth2') {
      const flows = scheme.flows || {};
      const flowName = Object.keys(flows)[0] || 'client_credentials';
      const flowObj = flows[flowName] || {};
      const flowEnum = {
        authorizationCode: 'authorization_code',
        implicit:          'implicit',
        password:          'password',
        clientCredentials: 'client_credentials',
      };
      result.push({
        id,
        type:              'oauth2',
        flow:              flowEnum[flowName] || flowName,
        token_url:         flowObj.tokenUrl || null,
        authorization_url: flowObj.authorizationUrl || null,
        refresh_url:       flowObj.refreshUrl || null,
        scopes:            Object.entries(flowObj.scopes || {}).map(([n, d]) => ({ name: n, description: d })),
        description:       scheme.description || undefined,
      });
    } else if (scheme.type === 'openIdConnect') {
      result.push({ id, type: 'http-bearer', description: scheme.description || undefined });
    } else if (scheme.type === 'mutualTLS') {
      result.push({ id, type: 'mutual-tls', description: scheme.description || undefined });
    }
  }
  return result;
}

/**
 * Resolve endpoint-level security refs to auth id arrays.
 * @param {object[]|undefined} security operation-level security array
 * @param {object[]|undefined} globalSecurity top-level security array
 * @returns {string[]}
 */
function _resolveEndpointAuth(security, globalSecurity) {
  const src = security !== undefined ? security : (globalSecurity || []);
  const ids = [];
  for (const req of src) {
    if (req && typeof req === 'object') {
      for (const k of Object.keys(req)) {
        if (!ids.includes(k)) ids.push(k);
      }
    }
  }
  return ids;
}

/**
 * Parse servers array → IR servers[].
 * @param {object[]|undefined} servers
 * @returns {object[]}
 */
function _parseServers(servers) {
  if (!Array.isArray(servers)) return [];
  return servers
    .filter(s => s && s.url)
    .map(s => ({ url: s.url, description: s.description || undefined }));
}

/**
 * Detect if body is YAML by trying JSON parse; if it fails and looks like YAML, throw UnsupportedFormatError.
 * @param {string} body
 * @param {string} contentType
 * @returns {object} Parsed JSON object
 */
function _parseJsonBody(body, contentType) {
  // Try JSON parse first
  try {
    return JSON.parse(body);
  } catch (_) {
    // Check if it looks like YAML
    if (/^---\s*\n|^openapi\s*:/m.test(body) || /application\/yaml|text\/yaml/.test(contentType)) {
      throw new UnsupportedFormatError(
        'YAML spec detected. YAML support is deferred to Wave 2B. ' +
        'Convert your spec to JSON first: https://editor.swagger.io/ → File → Convert and save as JSON.'
      );
    }
    throw new OpenAPIParseError(`Failed to parse spec as JSON: ${_.message}`);
  }
}

/**
 * Parse an OpenAPI 3.0/3.1 (or Swagger 2.0) document into IR.
 *
 * @param {object} opts
 * @param {string}       opts.body         - Raw spec body string.
 * @param {string}       opts.content_type - MIME type hint from fetch.
 * @param {string|null}  opts.source_url   - Original URL (for context in warnings).
 * @returns {{ ir: object, warnings: string[] }}
 */
async function parseOpenAPI({ body, content_type, source_url }) {
  const warnings = [];

  const doc = _parseJsonBody(body, content_type || '');

  // Detect format version.
  let formatVersion = null;
  let isSwagger2 = false;
  if (typeof doc.openapi === 'string') {
    formatVersion = doc.openapi;
    if (!formatVersion.startsWith('3.')) {
      warnings.push(`Unsupported openapi version "${formatVersion}"; expected 3.x. Parsing best-effort.`);
    }
  } else if (typeof doc.swagger === 'string' && doc.swagger.startsWith('2.')) {
    isSwagger2 = true;
    formatVersion = doc.swagger;
    warnings.push(`Swagger 2.0 detected (version "${formatVersion}"). Full support deferred to Wave 2B; parsing best-effort.`);
  } else {
    warnings.push('No recognisable openapi or swagger version field found. Parsing best-effort.');
  }

  const paths   = doc.paths || {};
  const components = doc.components || {};
  const schemas = isSwagger2 ? (doc.definitions || {}) : (components.schemas || {});
  const securitySchemes = isSwagger2 ? (doc.securityDefinitions || {}) : (components.securitySchemes || {});
  const globalSecurity  = doc.security;

  // Parse endpoints.
  const usedIds   = new Set();
  const endpoints = [];

  if (!doc.paths || Object.keys(doc.paths).length === 0) {
    warnings.push('No paths found in spec; producing empty endpoints array.');
  }

  for (const [opPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathLevelParams = pathItem.parameters || [];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;

      const ep = _parseOperation(method, opPath, operation, pathLevelParams, usedIds, warnings);

      // Attach resolved auth ids.
      ep.auth = _resolveEndpointAuth(operation.security, globalSecurity);

      endpoints.push(ep);
    }
  }

  // Parse models.
  const models = _parseModels(schemas);

  // Parse auth schemes.
  const auth = _parseAuth(securitySchemes);

  // Parse servers.
  let servers = [];
  if (isSwagger2) {
    const scheme = (doc.schemes || ['https'])[0];
    if (doc.host) {
      servers = [{ url: `${scheme}://${doc.host}${doc.basePath || ''}`, description: 'default' }];
    }
  } else {
    servers = _parseServers(doc.servers);
  }

  // Build service metadata.
  const info = doc.info || {};
  // Wrap new URL() — source_url may be a file path (not a valid URL), which throws TypeError.
  let hostname = 'unknown-service';
  try { hostname = new URL(source_url).hostname; } catch (_) {}
  const rawTitle = (info.title || hostname).toLowerCase();
  const serviceSlug = rawTitle.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'unknown';

  const service = {
    name:              serviceSlug,
    display_name:      info.title || undefined,
    version:           info.version || '0.0.0',
    summary:           info.description ? info.description.slice(0, 500) : undefined,
    documentation_url: (info.externalDocs && info.externalDocs.url) || undefined,
  };

  return {
    ir: {
      service,
      servers,
      endpoints,
      models,
      auth,
      errors:     [],
      examples:   [],
      extensions: {},
    },
    warnings,
    parser: {
      name:    PARSER_NAME,
      version: PARSER_VERSION,
    },
  };
}

module.exports = { parseOpenAPI, PARSER_NAME, PARSER_VERSION };
