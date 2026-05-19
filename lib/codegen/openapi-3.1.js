'use strict';

// lib/codegen/openapi-3.1.js — OpenAPI 3.1 YAML emitter from an apifier-mapping v1.
// Hand-rolled YAML emitter for byte-deterministic output (no js-yaml.dump calls).
// CommonJS only. No new runtime dependencies.

// ---------------------------------------------------------------------------
// HTTP method canonical order (OpenAPI spec ordering)
// ---------------------------------------------------------------------------
const METHOD_ORDER = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// ---------------------------------------------------------------------------
// Default status-code descriptions per RFC 7231 / common usage
// ---------------------------------------------------------------------------
const STATUS_DESCRIPTIONS = {
  '200': 'OK',
  '201': 'Created',
  '202': 'Accepted',
  '204': 'No Content',
  '301': 'Moved Permanently',
  '302': 'Found',
  '304': 'Not Modified',
  '400': 'Bad Request',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not Found',
  '405': 'Method Not Allowed',
  '409': 'Conflict',
  '410': 'Gone',
  '422': 'Unprocessable Entity',
  '429': 'Too Many Requests',
  '500': 'Internal Server Error',
  '501': 'Not Implemented',
  '502': 'Bad Gateway',
  '503': 'Service Unavailable',
  'default': 'Response',
};

// ---------------------------------------------------------------------------
// YAML scalar emitter
// ---------------------------------------------------------------------------

/**
 * Set of YAML 1.2 reserved tokens that must be quoted to avoid misinterpretation.
 * Covers booleans and null per the YAML 1.2 / YAML 1.1 subset used by most parsers.
 */
const YAML_RESERVED = new Set([
  'true', 'false', 'null', 'yes', 'no', 'on', 'off',
  'True', 'False', 'Null', 'Yes', 'No', 'On', 'Off',
  'TRUE', 'FALSE', 'NULL', 'YES', 'NO', 'ON', 'OFF',
]);

/**
 * Emit a YAML scalar value.
 * - Numbers and booleans are emitted bare (lowercase).
 * - null → null (bare).
 * - Strings: quoted with double quotes if they contain special characters,
 *   start with YAML special chars, or are reserved tokens.
 *
 * @param {*} value
 * @returns {string}
 */
function _yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);

  const str = String(value);

  // Empty string must be quoted
  if (str.length === 0) return '""';

  // Reserved YAML tokens must be quoted
  if (YAML_RESERVED.has(str)) return `"${_escapeYamlString(str)}"`;

  // Strings that look like numbers must be quoted
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(str)) return `"${_escapeYamlString(str)}"`;

  // Strings that look like YAML timestamps/dates must be quoted (e.g. 2026-05-19)
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?)?$/.test(str)) {
    return `"${_escapeYamlString(str)}"`;
  }

  // Strings starting with special YAML indicator characters must be quoted
  if (/^[{}\[\]#&*!|>'"%@`?,:\-]/.test(str)) return `"${_escapeYamlString(str)}"`;

  // Strings containing ': ' (mapping indicator) or ' #' (inline comment) must be quoted
  if (str.includes(': ') || str.includes(' #') || str.includes('\n') || str.includes('\r')) {
    return `"${_escapeYamlString(str)}"`;
  }

  // Strings ending with ':' must be quoted
  if (str.endsWith(':')) return `"${_escapeYamlString(str)}"`;

  // Plain scalar is safe
  return str;
}

/**
 * Escape a string for use inside double-quoted YAML scalars.
 * JSON-escapes the characters that matter in YAML double-quoted strings.
 * @param {string} str
 * @returns {string}
 */
function _escapeYamlString(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// ---------------------------------------------------------------------------
// (Removed in chore: dead-code cleanup) An earlier draft of this module
// contained _yamlList / _yamlObject / _yamlObjectInline / _emitYaml — a
// generic block-mode YAML emitter that was superseded by the specific
// _emitYamlDoc + _emit{Operation,Parameter,Schema,SecurityScheme} family
// driven by _buildOasDocument. The generic emitter never had any live
// callers post-merge and contributed ~170 LOC of dead surface. Removed
// here (W28-3); no behavioural change.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Type reference → JSON Schema object translation
// ---------------------------------------------------------------------------

/**
 * Convert a mapping TypeRef descriptor to a JSON Schema-compatible object.
 * Returns a plain JS object (to be serialised to YAML).
 *
 * @param {object} typeDesc
 * @returns {object}
 */
function _typeRefToSchema(typeDesc) {
  if (!typeDesc) return { type: 'string' };

  if (typeDesc.primitive !== undefined) {
    const primitiveMap = {
      string:  'string',
      integer: 'integer',
      number:  'number',
      boolean: 'boolean',
      null:    'null',
      binary:  'string', // binary → string (format: binary) per OAS convention
    };
    const result = { type: primitiveMap[typeDesc.primitive] || 'string' };
    if (typeDesc.primitive === 'binary') result.format = 'binary';
    return result;
  }

  if (typeDesc.$ref !== undefined) {
    return { $ref: `#/components/schemas/${typeDesc.$ref}` };
  }

  if (typeDesc.array !== undefined) {
    return { type: 'array', items: _typeRefToSchema(typeDesc.array) };
  }

  if (typeDesc.map !== undefined) {
    const valSchema = typeDesc.map && typeDesc.map.value
      ? _typeRefToSchema(typeDesc.map.value)
      : { type: 'string' };
    return { type: 'object', additionalProperties: valSchema };
  }

  if (typeDesc.union !== undefined && Array.isArray(typeDesc.union)) {
    return { oneOf: typeDesc.union.map(_typeRefToSchema) };
  }

  return { type: 'string' };
}

// ---------------------------------------------------------------------------
// Schema builder helpers
// ---------------------------------------------------------------------------

/**
 * Emit a JSON Schema object for a model field.
 * Handles enum, format, and type ref.
 *
 * @param {object} field - A model field from mapping.models[].fields[].
 * @returns {object}
 */
function _fieldToSchema(field) {
  const schema = _typeRefToSchema(field.type);
  if (field.format) schema.format = field.format;
  if (field.enum && Array.isArray(field.enum) && field.enum.length > 0) {
    schema.enum = field.enum;
    // If a primitive type was inferred, keep it; enum overrides effectively.
  }
  if (field.description) schema.description = field.description;
  return schema;
}

/**
 * Build a JSON Schema definition for a model.
 *
 * @param {object} model - A model from mapping.models[].
 * @returns {object}
 */
function _modelToSchema(model) {
  if (model.kind === 'object') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    const schema = { type: 'object' };
    if (model.description) schema.description = model.description;
    if (fields.length > 0) {
      schema.properties = {};
      const requiredFields = [];
      for (const field of fields) {
        schema.properties[field.name] = _fieldToSchema(field);
        if (field.required) requiredFields.push(field.name);
      }
      if (requiredFields.length > 0) schema.required = requiredFields;
    }
    return schema;
  }

  if (model.kind === 'enum') {
    const values = Array.isArray(model.fields)
      ? model.fields.map(f => f.name)
      : (Array.isArray(model.values) ? model.values : []);
    const schema = { type: 'string', enum: values };
    if (model.description) schema.description = model.description;
    return schema;
  }

  if (model.kind === 'alias') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    const base = fields.length > 0 ? _typeRefToSchema(fields[0].type) : { type: 'string' };
    if (model.description) base.description = model.description;
    return base;
  }

  if (model.kind === 'union') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    const schema = { oneOf: fields.map(f => _typeRefToSchema(f.type)) };
    if (schema.oneOf.length === 0) schema.oneOf = [{ type: 'string' }];
    if (model.description) schema.description = model.description;
    return schema;
  }

  // Fallback
  const schema = { type: 'object' };
  if (model.description) schema.description = model.description;
  return schema;
}

// ---------------------------------------------------------------------------
// Auth → securitySchemes translation
// ---------------------------------------------------------------------------

/**
 * Convert a mapping auth scheme to an OAS 3.1 security scheme object.
 * Unsupported scheme types emit a placeholder with a warning.
 *
 * @param {object} scheme - An entry from mapping.auth[].
 * @param {string[]} warnings - Mutable warnings array.
 * @returns {object}
 */
function _authToSecurityScheme(scheme, warnings) {
  if (scheme.type === 'http-bearer') {
    const result = { type: 'http', scheme: 'bearer' };
    if (scheme.bearer_format) result.bearerFormat = scheme.bearer_format;
    if (scheme.description) result.description = scheme.description;
    return result;
  }

  if (scheme.type === 'api-key') {
    const result = {
      type: 'apiKey',
      in:   scheme.in || 'header',
      name: scheme.name || 'X-API-Key',
    };
    if (scheme.description) result.description = scheme.description;
    return result;
  }

  if (scheme.type === 'http-basic') {
    const result = { type: 'http', scheme: 'basic' };
    if (scheme.description) result.description = scheme.description;
    return result;
  }

  if (scheme.type === 'oauth2') {
    // Map flow name from IR enum back to OAS camelCase
    const flowMap = {
      authorization_code: 'authorizationCode',
      implicit:           'implicit',
      password:           'password',
      client_credentials: 'clientCredentials',
    };
    const oasFlowName = flowMap[scheme.flow] || 'clientCredentials';
    const flowObj = {};
    if (scheme.authorization_url) flowObj.authorizationUrl = scheme.authorization_url;
    if (scheme.token_url)         flowObj.tokenUrl = scheme.token_url;
    if (scheme.refresh_url)       flowObj.refreshUrl = scheme.refresh_url;
    // Scopes are required by OAS even if empty
    const scopes = {};
    for (const s of (scheme.scopes || [])) {
      scopes[s.name] = s.description || '';
    }
    flowObj.scopes = scopes;
    const result = { type: 'oauth2', flows: { [oasFlowName]: flowObj } };
    if (scheme.description) result.description = scheme.description;
    return result;
  }

  // Unsupported: cookie, signature, mutual-tls → placeholder
  warnings.push(
    `auth scheme '${scheme.id}' (type: ${scheme.type}) has no direct OAS 3.1 equivalent; ` +
    `emitted as apiKey placeholder 'X-TODO-${scheme.type}'.`
  );
  return {
    type: 'apiKey',
    in:   'header',
    name: `X-TODO-${scheme.type}`,
    description: `TODO(wave 4D): ${scheme.type} scheme details lost in v0.x mapping schema`,
  };
}

// ---------------------------------------------------------------------------
// Parameter builder
// ---------------------------------------------------------------------------

/**
 * Build an OAS 3.1 parameter object from an IR Param.
 *
 * @param {object} param - IR Param shape.
 * @param {string} inLocation - 'path' | 'query' | 'header' | 'cookie'
 * @returns {object}
 */
function _buildParameter(param, inLocation) {
  const schema = _typeRefToSchema(param.type);
  if (param.format) schema.format = param.format;
  if (param.enum && Array.isArray(param.enum) && param.enum.length > 0) {
    schema.enum = param.enum;
  }
  if (param.default !== null && param.default !== undefined) {
    schema.default = param.default;
  }

  const result = {
    name:     param.name,
    in:       inLocation,
    required: param.required,
    schema,
  };
  if (param.description) result.description = param.description;
  if (param.deprecated) result.deprecated = true;

  return result;
}

// ---------------------------------------------------------------------------
// Response builder
// ---------------------------------------------------------------------------

/**
 * Build an OAS 3.1 response object from an IR response entry.
 *
 * @param {string} statusCode
 * @param {object} resp - IR response entry.
 * @returns {object}
 */
function _buildResponse(statusCode, resp) {
  const description = resp.description || STATUS_DESCRIPTIONS[statusCode] || 'Response';
  const result = { description };

  if (resp.content_type && resp.schema) {
    const mediaSchema = _typeRefToSchema(resp.schema);
    result.content = { [resp.content_type]: { schema: mediaSchema } };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main OAS document builder
// ---------------------------------------------------------------------------

/**
 * Build the full OAS 3.1 document object from a validated mapping.
 * Returns an object that _emitYamlDoc can serialise deterministically.
 *
 * @param {object} mapping
 * @param {string[]} warnings
 * @returns {object}
 */
function _buildOasDocument(mapping, warnings) {
  const service     = mapping.service || {};
  const source      = mapping.source  || {};
  const endpoints   = [...(mapping.endpoints || [])];
  const models      = [...(mapping.models    || [])];
  const auth        = [...(mapping.auth      || [])];
  const servers     = [...(mapping.servers   || [])];

  // -------------------------------------------------------------------------
  // info
  // -------------------------------------------------------------------------
  const info = {
    title:   service.display_name || service.name || 'API',
    version: service.version      || service.api_version || '0.0.0',
  };
  if (service.description || service.summary) {
    info.description = service.description || service.summary;
  }

  // -------------------------------------------------------------------------
  // servers
  // -------------------------------------------------------------------------
  const oasServers = servers
    .filter(s => s && s.url)
    .map(s => {
      const srv = { url: s.url };
      if (s.description) srv.description = s.description;
      return srv;
    });

  // -------------------------------------------------------------------------
  // paths — group endpoints by (path, method-canonical-order)
  // Filter to http transport only; non-http transports have no OAS 3.1 equivalent
  // -------------------------------------------------------------------------
  const httpEndpoints = endpoints.filter(ep => !ep.transport || ep.transport === 'http');

  // Surface dropped non-HTTP endpoints in the header `# Warnings:` block so
  // users can tell their graphql/grpc/ws/kafka/mqtt endpoints were silently
  // excluded from the OAS document (OpenAPI 3.1 has no paths equivalent for
  // those transports — they live in AsyncAPI / GraphQL SDL / .proto).
  const droppedEndpoints = endpoints.filter(ep => ep.transport && ep.transport !== 'http');
  if (droppedEndpoints.length > 0) {
    const droppedTransports = [...new Set(droppedEndpoints.map(ep => ep.transport))].sort();
    warnings.push(
      `${droppedEndpoints.length} non-http endpoint(s) dropped from OAS 3.1 output ` +
      `(transports: ${droppedTransports.join(', ')} have no OAS 3.1 paths equivalent — ` +
      `see AsyncAPI / GraphQL SDL / .proto for those).`
    );
  }

  // Sort endpoints: path ASC, then method in canonical OAS order
  httpEndpoints.sort((a, b) => {
    const pathCmp = (a.path || '').localeCompare(b.path || '');
    if (pathCmp !== 0) return pathCmp;
    const aIdx = METHOD_ORDER.indexOf((a.method || '').toLowerCase());
    const bIdx = METHOD_ORDER.indexOf((b.method || '').toLowerCase());
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  // Group by path
  const pathMap = {}; // path → { methodLower: endpoint }
  for (const ep of httpEndpoints) {
    const p = ep.path || '/';
    const m = (ep.method || 'get').toLowerCase();
    if (!pathMap[p]) pathMap[p] = {};
    pathMap[p][m] = ep;
  }

  // Build OAS paths object
  const paths = {};
  // Collect unique paths in sorted order for determinism
  const sortedPaths = Object.keys(pathMap).sort();
  for (const opPath of sortedPaths) {
    const pathItem = {};

    for (const method of METHOD_ORDER) {
      const ep = pathMap[opPath][method];
      if (!ep) continue;

      // Build operation
      const operation = _buildOperation(ep, mapping.auth || []);
      pathItem[method] = operation;
    }

    paths[opPath] = pathItem;
  }

  // -------------------------------------------------------------------------
  // components.schemas — sorted alphabetically by name
  // -------------------------------------------------------------------------
  const schemasObj = {};
  const sortedModels = [...models].sort((a, b) => a.name.localeCompare(b.name));
  for (const model of sortedModels) {
    schemasObj[model.name] = _modelToSchema(model);
  }

  // -------------------------------------------------------------------------
  // components.securitySchemes — sorted alphabetically by id
  // -------------------------------------------------------------------------
  const secSchemesObj = {};
  const sortedAuth = [...auth].sort((a, b) => a.id.localeCompare(b.id));
  for (const scheme of sortedAuth) {
    secSchemesObj[scheme.id] = _authToSecurityScheme(scheme, warnings);
  }

  // -------------------------------------------------------------------------
  // Build root document
  // -------------------------------------------------------------------------
  const doc = {
    openapi: '3.1.0',
    info,
  };

  if (oasServers.length > 0) doc.servers = oasServers;
  if (Object.keys(paths).length > 0) doc.paths = paths;

  const hasSchemas    = Object.keys(schemasObj).length > 0;
  const hasSecSchemes = Object.keys(secSchemesObj).length > 0;
  if (hasSchemas || hasSecSchemes) {
    doc.components = {};
    if (hasSchemas)    doc.components.schemas         = schemasObj;
    if (hasSecSchemes) doc.components.securitySchemes = secSchemesObj;
  }

  return doc;
}

/**
 * Build an OAS 3.1 operation object from an IR endpoint.
 *
 * @param {object} ep          - IR endpoint.
 * @param {object[]} authSchemes - Full auth[] from mapping.
 * @returns {object}
 */
function _buildOperation(ep, authSchemes) {
  // OperationId: sanitise to [A-Za-z][A-Za-z0-9_]*
  let operationId = String(ep.id || 'op');
  if (!/^[A-Za-z]/.test(operationId)) operationId = '_' + operationId;
  operationId = operationId.replace(/[^A-Za-z0-9_]/g, '_');

  const operation = { operationId };
  if (ep.summary)     operation.summary     = ep.summary;
  if (ep.description) operation.description = ep.description;
  if (ep.tags && ep.tags.length > 0) operation.tags = ep.tags;

  // Parameters
  const params = [];
  for (const pp of (ep.path_params  || [])) params.push(_buildParameter(pp, 'path'));
  for (const qp of (ep.query_params || [])) params.push(_buildParameter(qp, 'query'));
  for (const hp of (ep.headers      || [])) params.push(_buildParameter(hp, 'header'));
  // Note: cookie params are not standard OAS 3.1 path-level params; skip.
  if (params.length > 0) operation.parameters = params;

  // Request body
  if (ep.body) {
    const contentType = ep.body.content_type || 'application/json';
    const bodySchema  = _typeRefToSchema(ep.body.schema);
    operation.requestBody = {
      required: Boolean(ep.body.required),
      content:  { [contentType]: { schema: bodySchema } },
    };
  }

  // Responses (sorted by status code numerically, 'default' last)
  const responses = ep.responses || {};
  const responseObj = {};
  const statusCodes = Object.keys(responses).sort((a, b) => {
    if (a === 'default') return 1;
    if (b === 'default') return -1;
    return parseInt(a, 10) - parseInt(b, 10);
  });
  for (const code of statusCodes) {
    responseObj[code] = _buildResponse(code, responses[code]);
  }
  // Every operation must have at least one response
  if (Object.keys(responseObj).length === 0) {
    responseObj['200'] = { description: 'OK' };
  }
  operation.responses = responseObj;

  // Security — reference auth scheme ids
  if (ep.auth && ep.auth.length > 0) {
    operation.security = ep.auth.map(id => ({ [id]: [] }));
  }

  // Deprecated flag
  if (ep.deprecated && ep.deprecated.is_deprecated) {
    operation.deprecated = true;
  }

  return operation;
}

// ---------------------------------------------------------------------------
// Final YAML document serialiser
// ---------------------------------------------------------------------------

/**
 * Serialise the OAS document object to YAML string.
 * Uses a hand-rolled recursive emitter so key order is deterministic.
 *
 * @param {object} doc
 * @returns {string} YAML document string ending with '\n'.
 */
function _emitYamlDoc(doc) {
  const lines = [];

  // openapi version
  lines.push(`openapi: ${_yamlScalar(doc.openapi)}`);

  // info
  lines.push('info:');
  if (doc.info.title !== undefined)       lines.push(`  title: ${_yamlScalar(doc.info.title)}`);
  if (doc.info.version !== undefined)     lines.push(`  version: ${_yamlScalar(doc.info.version)}`);
  if (doc.info.description !== undefined) lines.push(`  description: ${_yamlScalar(doc.info.description)}`);

  // servers
  if (doc.servers && doc.servers.length > 0) {
    lines.push('servers:');
    for (const srv of doc.servers) {
      lines.push(`  - url: ${_yamlScalar(srv.url)}`);
      if (srv.description !== undefined) lines.push(`    description: ${_yamlScalar(srv.description)}`);
    }
  }

  // paths
  if (doc.paths && Object.keys(doc.paths).length > 0) {
    lines.push('paths:');
    for (const opPath of Object.keys(doc.paths).sort()) {
      lines.push(`  ${_yamlScalar(opPath)}:`);
      const pathItem = doc.paths[opPath];
      for (const method of METHOD_ORDER) {
        if (!pathItem[method]) continue;
        const op = pathItem[method];
        lines.push(`    ${method}:`);
        _emitOperation(op, lines, 6);
      }
    }
  }

  // components
  if (doc.components) {
    lines.push('components:');
    if (doc.components.schemas && Object.keys(doc.components.schemas).length > 0) {
      lines.push('  schemas:');
      for (const name of Object.keys(doc.components.schemas).sort()) {
        lines.push(`    ${_yamlScalar(name)}:`);
        _emitSchema(doc.components.schemas[name], lines, 6);
      }
    }
    if (doc.components.securitySchemes && Object.keys(doc.components.securitySchemes).length > 0) {
      lines.push('  securitySchemes:');
      for (const name of Object.keys(doc.components.securitySchemes).sort()) {
        lines.push(`    ${_yamlScalar(name)}:`);
        _emitSecurityScheme(doc.components.securitySchemes[name], lines, 6);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Emit an OAS operation object into lines array.
 * Canonical key order: operationId, summary, description, tags, parameters, requestBody, responses, security, deprecated.
 *
 * @param {object} op
 * @param {string[]} lines
 * @param {number} indent
 */
function _emitOperation(op, lines, indent) {
  const pad = ' '.repeat(indent);

  if (op.operationId !== undefined) lines.push(`${pad}operationId: ${_yamlScalar(op.operationId)}`);
  if (op.summary     !== undefined) lines.push(`${pad}summary: ${_yamlScalar(op.summary)}`);
  if (op.description !== undefined) lines.push(`${pad}description: ${_yamlScalar(op.description)}`);

  if (op.tags && op.tags.length > 0) {
    lines.push(`${pad}tags:`);
    for (const tag of op.tags) {
      lines.push(`${pad}  - ${_yamlScalar(tag)}`);
    }
  }

  if (op.parameters && op.parameters.length > 0) {
    lines.push(`${pad}parameters:`);
    for (const param of op.parameters) {
      _emitParameter(param, lines, indent + 2);
    }
  }

  if (op.requestBody) {
    lines.push(`${pad}requestBody:`);
    lines.push(`${pad}  required: ${op.requestBody.required ? 'true' : 'false'}`);
    lines.push(`${pad}  content:`);
    for (const ct of Object.keys(op.requestBody.content)) {
      lines.push(`${pad}    ${_yamlScalar(ct)}:`);
      lines.push(`${pad}      schema:`);
      _emitSchema(op.requestBody.content[ct].schema, lines, indent + 8);
    }
  }

  if (op.responses && Object.keys(op.responses).length > 0) {
    lines.push(`${pad}responses:`);
    const codes = Object.keys(op.responses).sort((a, b) => {
      if (a === 'default') return 1;
      if (b === 'default') return -1;
      return parseInt(a, 10) - parseInt(b, 10);
    });
    for (const code of codes) {
      const resp = op.responses[code];
      lines.push(`${pad}  ${_yamlScalar(String(code))}:`);
      lines.push(`${pad}    description: ${_yamlScalar(resp.description || 'Response')}`);
      if (resp.content) {
        lines.push(`${pad}    content:`);
        for (const ct of Object.keys(resp.content)) {
          lines.push(`${pad}      ${_yamlScalar(ct)}:`);
          lines.push(`${pad}        schema:`);
          _emitSchema(resp.content[ct].schema, lines, indent + 10);
        }
      }
    }
  }

  if (op.security && op.security.length > 0) {
    lines.push(`${pad}security:`);
    for (const secReq of op.security) {
      const keys = Object.keys(secReq);
      if (keys.length > 0) {
        lines.push(`${pad}  - ${_yamlScalar(keys[0])}: []`);
      }
    }
  }

  if (op.deprecated === true) {
    lines.push(`${pad}deprecated: true`);
  }
}

/**
 * Emit a single parameter into lines.
 * Canonical key order: name, in, required, description, schema.
 *
 * @param {object} param
 * @param {string[]} lines
 * @param {number} indent
 */
function _emitParameter(param, lines, indent) {
  const pad = ' '.repeat(indent);
  lines.push(`${pad}- name: ${_yamlScalar(param.name)}`);
  lines.push(`${pad}  in: ${_yamlScalar(param.in)}`);
  lines.push(`${pad}  required: ${param.required ? 'true' : 'false'}`);
  if (param.description !== undefined && param.description !== null) {
    lines.push(`${pad}  description: ${_yamlScalar(param.description)}`);
  }
  lines.push(`${pad}  schema:`);
  _emitSchema(param.schema, lines, indent + 4);
}

/**
 * Emit a JSON Schema object into lines.
 *
 * @param {object} schema
 * @param {string[]} lines
 * @param {number} indent
 */
function _emitSchema(schema, lines, indent) {
  const pad = ' '.repeat(indent);

  if (!schema || typeof schema !== 'object') {
    lines.push(`${pad}type: string`);
    return;
  }

  if (schema.$ref) {
    lines.push(`${pad}$ref: ${_yamlScalar(schema.$ref)}`);
    return;
  }

  if (schema.oneOf) {
    lines.push(`${pad}oneOf:`);
    for (const item of schema.oneOf) {
      // Each oneOf item as a list entry
      const subLines = [];
      _emitSchema(item, subLines, indent + 4);
      if (subLines.length === 0) {
        lines.push(`${pad}  - {}`);
      } else {
        lines.push(`${pad}  - ${subLines[0].trimStart()}`);
        for (let i = 1; i < subLines.length; i++) {
          lines.push(`${pad}    ${subLines[i].slice(indent + 4)}`);
        }
      }
    }
    return;
  }

  if (schema.type !== undefined) lines.push(`${pad}type: ${_yamlScalar(schema.type)}`);
  if (schema.format !== undefined) lines.push(`${pad}format: ${_yamlScalar(schema.format)}`);
  if (schema.description !== undefined) lines.push(`${pad}description: ${_yamlScalar(schema.description)}`);
  // Default values from path/query parameters (W28-4): _buildParameter copies
  // the IR `default` field into the schema object; emit it as a YAML scalar so
  // OAS consumers see the same default the IR had.
  if (schema.default !== undefined && schema.default !== null) {
    lines.push(`${pad}default: ${_yamlScalar(schema.default)}`);
  }

  if (schema.enum && schema.enum.length > 0) {
    lines.push(`${pad}enum:`);
    for (const v of schema.enum) {
      lines.push(`${pad}  - ${_yamlScalar(v)}`);
    }
  }

  if (schema.items) {
    lines.push(`${pad}items:`);
    _emitSchema(schema.items, lines, indent + 2);
  }

  if (schema.additionalProperties) {
    lines.push(`${pad}additionalProperties:`);
    _emitSchema(schema.additionalProperties, lines, indent + 2);
  }

  if (schema.properties && Object.keys(schema.properties).length > 0) {
    lines.push(`${pad}properties:`);
    for (const propName of Object.keys(schema.properties)) {
      lines.push(`${pad}  ${_yamlScalar(propName)}:`);
      _emitSchema(schema.properties[propName], lines, indent + 4);
    }
  }

  if (schema.required && schema.required.length > 0) {
    lines.push(`${pad}required:`);
    for (const r of schema.required) {
      lines.push(`${pad}  - ${_yamlScalar(r)}`);
    }
  }
}

/**
 * Emit a security scheme into lines.
 * Canonical key order: type, scheme, bearerFormat, in, name, description, flows.
 *
 * @param {object} ss
 * @param {string[]} lines
 * @param {number} indent
 */
function _emitSecurityScheme(ss, lines, indent) {
  const pad = ' '.repeat(indent);

  if (ss.type !== undefined)         lines.push(`${pad}type: ${_yamlScalar(ss.type)}`);
  if (ss.scheme !== undefined)       lines.push(`${pad}scheme: ${_yamlScalar(ss.scheme)}`);
  if (ss.bearerFormat !== undefined) lines.push(`${pad}bearerFormat: ${_yamlScalar(ss.bearerFormat)}`);
  if (ss.in !== undefined)           lines.push(`${pad}in: ${_yamlScalar(ss.in)}`);
  if (ss.name !== undefined)         lines.push(`${pad}name: ${_yamlScalar(ss.name)}`);
  if (ss.description !== undefined)  lines.push(`${pad}description: ${_yamlScalar(ss.description)}`);

  if (ss.flows) {
    lines.push(`${pad}flows:`);
    for (const flowName of Object.keys(ss.flows)) {
      const flow = ss.flows[flowName];
      lines.push(`${pad}  ${_yamlScalar(flowName)}:`);
      if (flow.authorizationUrl) lines.push(`${pad}    authorizationUrl: ${_yamlScalar(flow.authorizationUrl)}`);
      if (flow.tokenUrl)         lines.push(`${pad}    tokenUrl: ${_yamlScalar(flow.tokenUrl)}`);
      if (flow.refreshUrl)       lines.push(`${pad}    refreshUrl: ${_yamlScalar(flow.refreshUrl)}`);
      if (flow.scopes) {
        lines.push(`${pad}    scopes:`);
        for (const scopeName of Object.keys(flow.scopes)) {
          lines.push(`${pad}      ${_yamlScalar(scopeName)}: ${_yamlScalar(flow.scopes[scopeName])}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit an OpenAPI 3.1 YAML document from a validated apifier-mapping v1.
 *
 * Output is byte-deterministic for identical inputs.
 * Uses a hand-rolled YAML emitter — no js-yaml.dump call — for stable key ordering.
 *
 * @param {object} mapping  - Validated apifier-mapping v1.
 * @param {object} [opts]
 * @returns {{ text: string, ext: '.yaml' }}
 */
function generate(mapping, opts) {
  // eslint-disable-next-line no-unused-vars
  const _opts = opts || {};

  const source      = mapping.source  || {};
  const generatedAt = source.fetched_at || '';
  const sourceUrl   = source.url || source.file_path || '';
  const apifierVer  = mapping.apifier_version || '0.0.1';
  const schemaVer   = mapping.schema_version  || 1;

  const warnings = [];
  const doc = _buildOasDocument(mapping, warnings);

  // Header comment block (does not affect parsed YAML semantics)
  const headerLines = [
    `# Generated by apifier ${apifierVer} on ${generatedAt} from ${sourceUrl}.`,
    `# Mapping schema_version: ${schemaVer}. Do not edit by hand.`,
    `# Source: ${sourceUrl || '(unknown)'}`,
  ];
  if (warnings.length > 0) {
    headerLines.push('# Warnings:');
    for (const w of warnings) {
      headerLines.push(`#   - ${w}`);
    }
  }

  const header = headerLines.join('\n') + '\n';
  const body   = _emitYamlDoc(doc);

  return { text: header + body, ext: '.yaml' };
}

module.exports = { generate };
