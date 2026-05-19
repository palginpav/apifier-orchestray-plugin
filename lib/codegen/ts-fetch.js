'use strict';

// lib/codegen/ts-fetch.js — TypeScript fetch-client generator from an apifier-mapping v1.
// Pure-string codegen. No external deps. Byte-deterministic for identical inputs.

/** Reserved JavaScript keywords that must not be used as method names. */
const JS_RESERVED = new Set([
  'abstract', 'arguments', 'await', 'boolean', 'break', 'byte', 'case', 'catch',
  'char', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'double', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'final',
  'finally', 'float', 'for', 'function', 'goto', 'if', 'implements', 'import',
  'in', 'instanceof', 'int', 'interface', 'let', 'long', 'native', 'new', 'null',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
  'true', 'try', 'typeof', 'undefined', 'var', 'void', 'volatile', 'while', 'with',
  'yield',
]);

/**
 * Sanitise a string into a valid JavaScript/TypeScript identifier.
 * Strips characters outside [A-Za-z0-9_$] and ensures the first char is letter or _.
 * @param {string} name
 * @returns {string}
 */
function _toIdentifier(name) {
  // Replace non-identifier chars with underscore
  let id = String(name).replace(/[^A-Za-z0-9_$]/g, '_');
  // Ensure first char is letter or underscore
  if (!/^[A-Za-z_$]/.test(id)) {
    id = '_' + id;
  }
  return id || '_unnamed';
}

/**
 * Sanitise a method name: convert to camelCase identifier and suffix _op for reserved words.
 * @param {string} name
 * @returns {string}
 */
function _toMethodName(name) {
  const id = _toIdentifier(name);
  return JS_RESERVED.has(id) ? id + '_op' : id;
}

/**
 * Convert a service name slug to PascalCase for the class name.
 * e.g. "widgets-api" → "WidgetsApiClient"
 * @param {string} serviceName
 * @returns {string}
 */
function _toClassName(serviceName) {
  const pascal = String(serviceName)
    .split(/[-_\s]+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
  return pascal + 'Client';
}

/**
 * Map a mapping type descriptor to a TypeScript type string.
 * @param {object} typeDesc - A type descriptor from the mapping schema.
 * @returns {string} TypeScript type string.
 */
function _typeToTs(typeDesc) {
  if (!typeDesc) return 'unknown';
  if (typeDesc.primitive !== undefined) {
    switch (typeDesc.primitive) {
      case 'string':  return 'string';
      case 'integer': return 'number';
      case 'number':  return 'number';
      case 'boolean': return 'boolean';
      case 'null':    return 'null';
      case 'binary':  return 'Blob';
      default:        return 'unknown';
    }
  }
  if (typeDesc.$ref !== undefined) {
    return _toIdentifier(typeDesc.$ref);
  }
  if (typeDesc.array !== undefined) {
    return `Array<${_typeToTs(typeDesc.array)}>`;
  }
  if (typeDesc.map !== undefined) {
    const valType = typeDesc.map && typeDesc.map.value ? _typeToTs(typeDesc.map.value) : 'unknown';
    return `Record<string, ${valType}>`;
  }
  if (typeDesc.union !== undefined && Array.isArray(typeDesc.union)) {
    return typeDesc.union.map(_typeToTs).join(' | ');
  }
  return 'unknown';
}

/**
 * Emit TypeScript type aliases for a single model.
 * @param {object} model - A model entry from mapping.models[].
 * @returns {string} TypeScript source lines for the type.
 */
function _emitModelType(model) {
  const lines = [];
  const name = _toIdentifier(model.name);
  if (model.description) {
    // Multi-line descriptions (e.g. JSON body examples from HTML scrape) must
    // be emitted as a proper JSDoc block to avoid TS syntax errors.
    const descLines = String(model.description).split('\n');
    if (descLines.length === 1) {
      lines.push(`/** ${descLines[0]} */`);
    } else {
      lines.push('/**');
      for (const descLine of descLines) {
        lines.push(` * ${descLine}`);
      }
      lines.push(' */');
    }
  }

  if (model.kind === 'object') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    if (fields.length === 0) {
      lines.push(`export interface ${name} {}`);
    } else {
      lines.push(`export interface ${name} {`);
      for (const field of fields) {
        const fieldName = _toIdentifier(field.name);
        const optional = field.required ? '' : '?';
        let tsType;
        if (field.enum && Array.isArray(field.enum) && field.enum.length > 0) {
          tsType = field.enum.map(v => JSON.stringify(v)).join(' | ');
        } else {
          tsType = _typeToTs(field.type);
        }
        if (field.description) {
          lines.push(`  /** ${field.description} */`);
        }
        lines.push(`  ${fieldName}${optional}: ${tsType};`);
      }
      lines.push('}');
    }
  } else if (model.kind === 'enum') {
    const values = Array.isArray(model.fields)
      ? model.fields.map(f => JSON.stringify(f.name)).join(' | ')
      : 'string';
    lines.push(`export type ${name} = ${values};`);
  } else if (model.kind === 'alias') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    const tsType = fields.length > 0 ? _typeToTs(fields[0].type) : 'unknown';
    lines.push(`export type ${name} = ${tsType};`);
  } else if (model.kind === 'union') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    const types = fields.map(f => _typeToTs(f.type)).join(' | ');
    lines.push(`export type ${name} = ${types || 'unknown'};`);
  } else {
    // Fallback: emit an empty interface
    lines.push(`export interface ${name} {}`);
  }

  return lines.join('\n');
}

/**
 * Determine the success response type for an endpoint.
 * Returns the TypeScript type string for the 2xx response.
 * @param {object} endpoint
 * @returns {string}
 */
function _responseType(endpoint) {
  const responses = endpoint.responses || {};
  // Look for 2xx status codes
  for (const code of Object.keys(responses).sort()) {
    const status = parseInt(code, 10);
    if (!isNaN(status) && status >= 200 && status < 300) {
      const resp = responses[code];
      if (resp && resp.schema) {
        return _typeToTs(resp.schema);
      }
      return 'void';
    }
  }
  return 'void';
}

/**
 * Build a path with interpolated parameters.
 * e.g. "/widgets/{id}" → "`${baseUrl}/widgets/${encodeURIComponent(args.id)}`"
 * @param {string} path - The endpoint path template.
 * @param {Array} pathParams - The path_params array.
 * @returns {string} Template literal expression for the URL.
 */
function _buildUrlExpr(path, pathParams) {
  const paramNames = new Set((pathParams || []).map(p => p.name));
  // Replace {paramName} with ${encodeURIComponent(args.paramName)}
  const pathExpr = path.replace(/\{([^}]+)\}/g, (_, paramName) => {
    if (paramNames.has(paramName)) {
      return `\${encodeURIComponent(String(args.${_toIdentifier(paramName)}))}`;
    }
    return `\${encodeURIComponent(String(args.${_toIdentifier(paramName)}))}`;
  });
  return '`${this._baseUrl}' + pathExpr + '`';
}

/**
 * Build the query string appending logic.
 * @param {Array} queryParams
 * @returns {string[]} Lines of code for building the query string.
 */
function _buildQueryLines(queryParams) {
  if (!queryParams || queryParams.length === 0) return [];
  const lines = [];
  lines.push('  const _query = new URLSearchParams();');
  for (const qp of queryParams) {
    const id = _toIdentifier(qp.name);
    if (qp.required) {
      lines.push(`  _query.set(${JSON.stringify(qp.name)}, String(args.${id}));`);
    } else {
      lines.push(`  if (args.${id} !== undefined) _query.set(${JSON.stringify(qp.name)}, String(args.${id}));`);
    }
  }
  lines.push('  const _qs = _query.toString();');
  return lines;
}

/**
 * Emit the request-headers setup lines.
 * @param {object} endpoint
 * @param {Set<string>} authTypes - Set of auth type strings used in this endpoint.
 * @param {Array} authSchemes - The mapping's auth[] array.
 * @returns {string[]} Lines of code.
 */
function _buildHeaderLines(endpoint, authSchemes) {
  const lines = [];
  lines.push("  const _headers: Record<string, string> = {};");

  // Add auth headers
  const endpointAuthIds = new Set(endpoint.auth || []);
  for (const schemeId of endpointAuthIds) {
    const scheme = (authSchemes || []).find(a => a.id === schemeId);
    if (!scheme) continue;
    if (scheme.type === 'http-bearer') {
      lines.push("  if (this._bearerToken) _headers['Authorization'] = `Bearer ${this._bearerToken}`;");
    } else if (scheme.type === 'api-key') {
      if (scheme.in === 'header' && scheme.name) {
        lines.push(`  if (this._apiKeyName && this._apiKeyValue) _headers[this._apiKeyName] = this._apiKeyValue;`);
      }
      // 'query'-position api-keys are appended to the URL by _buildAuthQueryLines.
      // 'cookie'-position is a TODO (Wave 4B).
    } else if (scheme.type === 'http-basic') {
      lines.push("  if (this._basicAuth) _headers['Authorization'] = `Basic ${this._basicAuth}`;");
    }
  }

  // Content-Type for JSON body
  if (endpoint.body && endpoint.body.content_type === 'application/json') {
    lines.push("  _headers['Content-Type'] = 'application/json';");
  }

  return lines;
}

/**
 * Emit lines that append query-position auth credentials to the _qs URLSearchParams.
 * Must be called AFTER _buildQueryLines (which initialises `_qs`) and BEFORE the
 * `if (_qs) _url += ...` line.
 * @param {object} endpoint
 * @param {Array} authSchemes
 * @returns {string[]}
 */
function _buildAuthQueryLines(endpoint, authSchemes) {
  const lines = [];
  const endpointAuthIds = new Set(endpoint.auth || []);
  for (const schemeId of endpointAuthIds) {
    const scheme = (authSchemes || []).find(a => a.id === schemeId);
    if (!scheme) continue;
    if (scheme.type === 'api-key' && scheme.in === 'query' && scheme.name) {
      lines.push(`  if (this._apiKeyName && this._apiKeyValue) _qs += (_qs ? '&' : '') + encodeURIComponent(this._apiKeyName) + '=' + encodeURIComponent(this._apiKeyValue);`);
    }
  }
  return lines;
}

/**
 * Emit the response-handling switch lines.
 * Maps status codes to appropriate error throws or success returns.
 * @param {object} endpoint
 * @returns {string[]} Lines of code.
 */
function _buildResponseLines(endpoint, responseType) {
  const lines = [];
  const responses = endpoint.responses || {};
  const sortedCodes = Object.keys(responses).sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    return na - nb;
  });

  for (const code of sortedCodes) {
    const status = parseInt(code, 10);
    if (isNaN(status)) continue;
    const resp = responses[code];

    if (status >= 200 && status < 300) {
      const hasBody = resp && resp.content_type && resp.content_type.includes('json');
      if (hasBody) {
        lines.push(`  if (_res.status === ${status}) return _res.json() as Promise<${_typeToTs(resp.schema)}>;`);
      } else {
        lines.push(`  if (_res.status === ${status}) return undefined as unknown as ${_responseType(endpoint)};`);
      }
    } else if (status === 400) {
      lines.push(`  if (_res.status === 400) throw new ApifierValidationError(await _res.text());`);
    } else if (status === 401) {
      lines.push(`  if (_res.status === 401) throw new ApifierAuthenticationError(await _res.text());`);
    } else if (status === 403) {
      lines.push(`  if (_res.status === 403) throw new ApifierAuthorizationError(await _res.text());`);
    } else if (status === 404) {
      lines.push(`  if (_res.status === 404) throw new ApifierNotFoundError(await _res.text());`);
    } else if (status === 409) {
      lines.push(`  if (_res.status === 409) throw new ApifierConflictError(await _res.text());`);
    } else if (status >= 400 && status < 500) {
      lines.push(`  if (_res.status === ${status}) throw new ApifierClientError(await _res.text(), _res.status);`);
    } else if (status >= 500) {
      lines.push(`  if (_res.status === ${status}) throw new ApifierServerError(await _res.text(), _res.status);`);
    }
  }

  // Generic fallback. `responseType` already represents the resolved (unwrapped)
  // success type — the surrounding `async` declaration wraps it in Promise<…>
  // automatically, so the assertion below must NOT wrap again.
  lines.push(`  if (_res.status >= 200 && _res.status < 300) return _res.json() as Promise<${responseType}>;`);
  lines.push('  if (_res.status >= 400 && _res.status < 500) throw new ApifierClientError(await _res.text(), _res.status);');
  lines.push('  throw new ApifierServerError(await _res.text(), _res.status);');

  return lines;
}

/**
 * Emit one client method for an endpoint.
 * @param {object} endpoint
 * @param {Array} authSchemes
 * @returns {string}
 */
function _emitMethod(endpoint, authSchemes) {
  const lines = [];
  const methodName = _toMethodName(endpoint.id);
  const responseType = _responseType(endpoint);

  // Build args type
  const argFields = [];
  for (const pp of (endpoint.path_params || [])) {
    const id = _toIdentifier(pp.name);
    const optional = pp.required ? '' : '?';
    argFields.push(`${id}${optional}: ${_typeToTs(pp.type)}`);
  }
  for (const qp of (endpoint.query_params || [])) {
    const id = _toIdentifier(qp.name);
    const optional = qp.required ? '' : '?';
    argFields.push(`${id}${optional}: ${_typeToTs(qp.type)}`);
  }
  if (endpoint.body) {
    const bodyType = endpoint.body.schema ? _typeToTs(endpoint.body.schema) : 'unknown';
    const optional = endpoint.body.required ? '' : '?';
    argFields.push(`body${optional}: ${bodyType}`);
  }

  const argsType = argFields.length > 0 ? `{ ${argFields.join('; ')} }` : 'Record<string, never>';

  if (endpoint.summary) {
    lines.push(`  /** ${endpoint.summary}${endpoint.deprecated && endpoint.deprecated.is_deprecated ? ' @deprecated' : ''} */`);
  }
  lines.push(`  async ${methodName}(args: ${argsType} = {} as ${argsType}): Promise<${responseType}> {`);

  // URL building
  const urlExpr = _buildUrlExpr(endpoint.path, endpoint.path_params);
  const hasQuery = endpoint.query_params && endpoint.query_params.length > 0;
  lines.push(`    let _url = ${urlExpr};`);

  // Determine if we need a query-string scratch buffer — either because the
  // endpoint declares query_params, or because an api-key/in=query scheme
  // applies to this endpoint.
  const authQueryLines = _buildAuthQueryLines(endpoint, authSchemes);
  const needsQs = hasQuery || authQueryLines.length > 0;

  if (needsQs) {
    if (hasQuery) {
      const queryLines = _buildQueryLines(endpoint.query_params);
      for (const l of queryLines) lines.push('  ' + l);
    } else {
      // No declared query_params, but we still need `_qs` for the auth append.
      lines.push("    let _qs = '';");
    }
    for (const l of authQueryLines) lines.push('  ' + l);
    lines.push('    if (_qs) _url += `?${_qs}`;');
  }

  // Headers
  const headerLines = _buildHeaderLines(endpoint, authSchemes);
  for (const l of headerLines) lines.push('  ' + l);

  // Fetch call
  const fetchArgs = [];
  fetchArgs.push(`method: ${JSON.stringify(endpoint.method)}`);
  fetchArgs.push('headers: _headers');
  if (endpoint.body) {
    if (endpoint.body.content_type === 'application/json') {
      fetchArgs.push('body: JSON.stringify(args.body)');
    } else {
      fetchArgs.push('body: args.body as BodyInit');
    }
  }
  lines.push(`    const _res = await fetch(_url, { ${fetchArgs.join(', ')} });`);

  // Response handling
  const respLines = _buildResponseLines(endpoint, responseType);
  for (const l of respLines) lines.push('  ' + l);

  lines.push('  }');
  return lines.join('\n');
}

/**
 * Determine which auth helper methods are needed based on the auth schemes used.
 * @param {Array} authSchemes - The mapping's top-level auth[] array.
 * @param {Array} endpoints - The endpoints array, to check which schemes are actually used.
 * @returns {{ types: Set<string>, schemes: Array }}
 */
function _collectUsedAuthTypes(authSchemes, endpoints) {
  const usedIds = new Set();
  for (const ep of (endpoints || [])) {
    for (const id of (ep.auth || [])) {
      usedIds.add(id);
    }
  }
  const usedSchemes = (authSchemes || []).filter(s => usedIds.has(s.id));
  const types = new Set(usedSchemes.map(s => s.type));
  return { types, schemes: usedSchemes };
}

/**
 * Emit auth helper methods for the client class.
 * @param {Set<string>} authTypes
 * @returns {string[]} Lines of auth methods.
 */
function _emitAuthMethods(authTypes) {
  const lines = [];
  if (authTypes.has('http-bearer')) {
    lines.push('  /** Set the Bearer token for HTTP bearer authentication. */');
    lines.push('  setBearerToken(token: string): void {');
    lines.push('    this._bearerToken = token;');
    lines.push('  }');
  }
  if (authTypes.has('api-key')) {
    lines.push('  /** Set an API key by header/query name and value. */');
    lines.push('  setApiKey(name: string, value: string): void {');
    lines.push('    this._apiKeyName = name;');
    lines.push('    this._apiKeyValue = value;');
    lines.push('  }');
  }
  if (authTypes.has('http-basic')) {
    lines.push('  /** Set HTTP Basic authentication credentials. */');
    lines.push('  setBasicAuth(user: string, password: string): void {');
    lines.push('    this._basicAuth = btoa(`${user}:${password}`);');
    lines.push('  }');
  }
  // Unsupported auth types get a TODO comment
  const unsupported = ['oauth2', 'cookie', 'signature', 'mutual-tls'];
  for (const type of unsupported) {
    if (authTypes.has(type)) {
      lines.push(`  // TODO(wave 4B): ${type} auth support not yet implemented`);
    }
  }
  return lines;
}

/**
 * Emit private field declarations for auth state.
 * @param {Set<string>} authTypes
 * @returns {string[]} Lines.
 */
function _emitAuthFields(authTypes) {
  const lines = [];
  if (authTypes.has('http-bearer')) {
    lines.push('  private _bearerToken: string | undefined;');
  }
  if (authTypes.has('api-key')) {
    lines.push('  private _apiKeyName: string | undefined;');
    lines.push('  private _apiKeyValue: string | undefined;');
  }
  if (authTypes.has('http-basic')) {
    lines.push('  private _basicAuth: string | undefined;');
  }
  return lines;
}

/**
 * Build the init guide example for the header comment.
 * @param {string} className
 * @param {string} baseUrl
 * @param {Set<string>} authTypes
 * @param {string} serviceName
 * @returns {string[]} Comment lines.
 */
function _buildInitGuide(className, baseUrl, authTypes, serviceName) {
  const slug = serviceName.toUpperCase().replace(/-/g, '_');
  const lines = [];
  lines.push(`//   const client = new ${className}({ baseUrl: ${JSON.stringify(baseUrl)} });`);
  // Emit ALL applicable auth examples (multi-auth mappings need every helper
  // shown). Order: bearer → api-key → basic for stable output.
  if (authTypes.has('http-bearer')) {
    lines.push(`//   client.setBearerToken(process.env.${slug}_TOKEN ?? '');`);
  }
  if (authTypes.has('api-key')) {
    lines.push(`//   client.setApiKey('X-API-Key', process.env.${slug}_API_KEY ?? '');`);
  }
  if (authTypes.has('http-basic')) {
    lines.push(`//   client.setBasicAuth(process.env.${slug}_USER ?? '', process.env.${slug}_PASS ?? '');`);
  }
  lines.push(`//   const result = await client.<methodName>(args);`);
  return lines;
}

/**
 * Generate a TypeScript fetch-based client from an apifier-mapping v1.
 *
 * @param {object} mapping  - Validated apifier-mapping v1 object.
 * @param {object} [opts]   - Optional generation options (reserved for future use).
 * @returns {{ text: string, ext: '.ts' }}
 */
function generate(mapping, opts) {
  // eslint-disable-next-line no-unused-vars
  const _opts = opts || {};

  const serviceName   = mapping.service.name;
  const displayName   = mapping.service.display_name || serviceName;
  const baseUrl       = (mapping.servers && mapping.servers.length > 0)
    ? mapping.servers[0].url
    : (mapping.service.base_url || '');
  const schemaVersion = mapping.schema_version;
  const apifierVer    = mapping.apifier_version;
  const sourceUrl     = (mapping.source && (mapping.source.url || mapping.source.file_path)) || '';
  const generatedAt   = (mapping.source && mapping.source.fetched_at) || '';
  const className     = _toClassName(serviceName);

  // Sort endpoints: (method ASC, path ASC) — canonical order per W2-mapping-schema §1
  const endpoints = [...(mapping.endpoints || [])].sort((a, b) => {
    const methodCmp = (a.method || '').localeCompare(b.method || '');
    if (methodCmp !== 0) return methodCmp;
    return (a.path || '').localeCompare(b.path || '');
  });

  // Sort models alphabetically by name
  const models = [...(mapping.models || [])].sort((a, b) => a.name.localeCompare(b.name));

  const authSchemes = mapping.auth || [];
  const { types: usedAuthTypes } = _collectUsedAuthTypes(authSchemes, endpoints);

  const parts = [];

  // -------------------------------------------------------------------------
  // 1. Header comment
  // -------------------------------------------------------------------------
  const initGuide = _buildInitGuide(className, baseUrl, usedAuthTypes, serviceName);
  parts.push([
    `// Generated by apifier ${apifierVer} on ${generatedAt} from ${sourceUrl}.`,
    `// Mapping schema_version: ${schemaVersion}. Do not edit by hand.`,
    `// Service: ${displayName}`,
    '// Init:',
    ...initGuide,
  ].join('\n'));

  parts.push('');

  // -------------------------------------------------------------------------
  // 2. Type aliases for models
  // -------------------------------------------------------------------------
  if (models.length > 0) {
    const modelParts = models.map(_emitModelType);
    parts.push(modelParts.join('\n\n'));
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 3. Error class hierarchy
  // -------------------------------------------------------------------------
  parts.push([
    '/** Base class for all apifier client errors. */',
    'export class ApifierClientError extends Error {',
    '  constructor(public readonly body: string, public readonly status?: number) {',
    '    super(`HTTP ${status ?? \'?\'}: ${body}`);',
    "    this.name = 'ApifierClientError';",
    '  }',
    '}',
    '',
    '/** Network or transport failure. */',
    'export class ApifierNetworkError extends ApifierClientError {',
    "  constructor(message: string) { super(message); this.name = 'ApifierNetworkError'; }",
    '}',
    '',
    '/** Request timeout. */',
    'export class ApifierTimeoutError extends ApifierClientError {',
    "  constructor(message: string) { super(message); this.name = 'ApifierTimeoutError'; }",
    '}',
    '',
    '/** Any non-2xx HTTP response (4xx or 5xx). */',
    'export class ApifierHttpError extends ApifierClientError {',
    "  constructor(body: string, status: number) { super(body, status); this.name = 'ApifierHttpError'; }",
    '}',
    '',
    '/** 4xx client error. */',
    'export class ApifierClientHttpError extends ApifierHttpError {',
    "  constructor(body: string, status: number) { super(body, status); this.name = 'ApifierClientHttpError'; }",
    '}',
    '',
    '/** 400 Validation error. */',
    'export class ApifierValidationError extends ApifierClientHttpError {',
    "  constructor(body: string) { super(body, 400); this.name = 'ApifierValidationError'; }",
    '}',
    '',
    '/** 401 Authentication error. */',
    'export class ApifierAuthenticationError extends ApifierClientHttpError {',
    "  constructor(body: string) { super(body, 401); this.name = 'ApifierAuthenticationError'; }",
    '}',
    '',
    '/** 403 Authorization error. */',
    'export class ApifierAuthorizationError extends ApifierClientHttpError {',
    "  constructor(body: string) { super(body, 403); this.name = 'ApifierAuthorizationError'; }",
    '}',
    '',
    '/** 404 Not found error. */',
    'export class ApifierNotFoundError extends ApifierClientHttpError {',
    "  constructor(body: string) { super(body, 404); this.name = 'ApifierNotFoundError'; }",
    '}',
    '',
    '/** 409 Conflict error. */',
    'export class ApifierConflictError extends ApifierClientHttpError {',
    "  constructor(body: string) { super(body, 409); this.name = 'ApifierConflictError'; }",
    '}',
    '',
    '/** 5xx server error. */',
    'export class ApifierServerError extends ApifierHttpError {',
    "  constructor(body: string, status: number) { super(body, status); this.name = 'ApifierServerError'; }",
    '}',
    '',
    '/** Response body did not match declared schema. */',
    'export class ApifierDecodeError extends ApifierClientError {',
    "  constructor(message: string) { super(message); this.name = 'ApifierDecodeError'; }",
    '}',
  ].join('\n'));

  parts.push('');

  // -------------------------------------------------------------------------
  // 4. Client class
  // -------------------------------------------------------------------------
  const classLines = [];
  classLines.push(`/** ${displayName} client generated from apifier-mapping v${schemaVersion}. */`);
  classLines.push(`export class ${className} {`);
  classLines.push(`  private _baseUrl: string;`);

  // Auth fields
  const authFields = _emitAuthFields(usedAuthTypes);
  for (const f of authFields) classLines.push(f);

  classLines.push('');
  classLines.push(`  constructor(opts: { baseUrl?: string } = {}) {`);
  classLines.push(`    this._baseUrl = opts.baseUrl ?? ${JSON.stringify(baseUrl)};`);
  classLines.push('    // Remove trailing slash for consistent URL construction');
  classLines.push("    if (this._baseUrl.endsWith('/')) this._baseUrl = this._baseUrl.slice(0, -1);");
  classLines.push('  }');

  // Auth methods
  const authMethods = _emitAuthMethods(usedAuthTypes);
  if (authMethods.length > 0) {
    classLines.push('');
    for (const l of authMethods) classLines.push(l);
  }

  // Endpoint methods
  for (const ep of endpoints) {
    classLines.push('');
    classLines.push(_emitMethod(ep, authSchemes));
  }

  classLines.push('}');
  parts.push(classLines.join('\n'));

  parts.push('');

  // -------------------------------------------------------------------------
  // 5. Footer export
  // -------------------------------------------------------------------------
  parts.push(`export default ${className};`);
  parts.push('');

  const text = parts.join('\n');
  return { text, ext: '.ts' };
}

module.exports = { generate };
