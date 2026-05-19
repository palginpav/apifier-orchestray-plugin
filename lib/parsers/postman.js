'use strict';

// lib/parsers/postman.js — Postman v2.1 collection JSON parser → IR. No external deps; pure JSON walk.

const { PostmanParseError } = require('../errors');

const PARSER_NAME    = 'apifier-postman-parser';
const PARSER_VERSION = '0.0.1';

// Postman schema URL substring — used for version detection.
const POSTMAN_SCHEMA_V2 = 'getpostman.com/json/collection/v2.';
const POSTMAN_SCHEMA_V21 = 'getpostman.com/json/collection/v2.1';

// Standard headers to skip — they are captured via content_type / body, not as header params.
const SKIP_HEADERS = new Set(['accept', 'content-type', 'authorization']);

/**
 * Slugify a string into a valid endpoint id.
 * Follows the same convention as openapi.js / markdown.js.
 * @param {string} raw
 * @returns {string}
 */
function _slugify(raw) {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return s || 'unknown';
}

/**
 * Derive a stable endpoint id from item name + method.
 * @param {string} name
 * @param {string} method uppercase
 * @param {Set<string>} usedIds
 * @returns {string}
 */
function _deriveId(name, method, usedIds) {
  const nameSlug = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let base = (method.toLowerCase() + '_' + nameSlug).slice(0, 128);
  // Ensure starts with letter.
  if (!/^[A-Za-z]/.test(base)) base = 'op_' + base.slice(0, 124);
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = base.slice(0, 120) + '_' + suffix++;
  }
  usedIds.add(id);
  return id;
}

/**
 * Determine idempotency from HTTP method (mirrors openapi.js).
 * @param {string} method uppercase
 * @returns {object}
 */
function _idempotency(method) {
  const intrinsic = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'].includes(method);
  return { method_intrinsic: intrinsic, header: null, description: null };
}

/**
 * Convert Postman {{varName}} placeholders to {varName} path-param form.
 * Also converts url.path segments (which use :varName form rarely) just in case.
 * @param {string} s
 * @returns {string}
 */
function _convertVarPlaceholders(s) {
  return s.replace(/\{\{(\w+)\}\}/g, '{$1}');
}

/**
 * Extract URL info from a Postman request.url field.
 * The url field can be a string or a structured object.
 * Returns { rawUrl, path, queryParams, pathVariables }.
 * @param {string|object|undefined} url
 * @returns {{ rawUrl: string, path: string, queryParams: Array, pathVariables: Array }}
 */
function _parseUrl(url) {
  if (!url) return { rawUrl: '', path: '/', queryParams: [], pathVariables: [] };

  if (typeof url === 'string') {
    // Raw string URL — extract path from it, convert Postman vars.
    const raw = _convertVarPlaceholders(url);
    let path = '/';
    try {
      // Try to parse as URL. May fail if it has Postman vars like {base}/path.
      const u = new URL(raw);
      path = u.pathname || '/';
    } catch (_) {
      // Fallback: extract path after scheme://host
      const match = raw.match(/^(?:https?:\/\/[^/]+)?(\/[^?#]*)/);
      if (match) path = match[1];
    }
    return { rawUrl: raw, path, queryParams: [], pathVariables: [] };
  }

  // Structured url object.
  const rawUrl = typeof url.raw === 'string' ? _convertVarPlaceholders(url.raw) : '';

  // Build path from url.path array if present; otherwise fall back to raw.
  let path = '/';
  if (Array.isArray(url.path) && url.path.length > 0) {
    const segments = url.path.map(seg => {
      // Postman represents path vars as :varName or {{varName}}.
      if (typeof seg === 'string') {
        return _convertVarPlaceholders(seg.replace(/^:(\w+)$/, '{$1}'));
      }
      return '';
    });
    path = '/' + segments.join('/');
  } else if (rawUrl) {
    // Fall back to extracting path from raw string.
    try {
      const u = new URL(rawUrl);
      path = u.pathname || '/';
    } catch (_) {
      const match = rawUrl.match(/^(?:https?:\/\/[^/]+)?(\/[^?#]*)/);
      if (match) path = match[1];
    }
  }

  // Query params from url.query[].
  const queryParams = Array.isArray(url.query)
    ? url.query.filter(q => q && !q.disabled).map(q => ({
        name:        q.key || '',
        type:        { primitive: 'string' },
        required:    false,
        description: q.description || null,
        default:     q.value || null,
        example:     null,
        enum:        null,
        format:      null,
        deprecated:  false,
        style:       null,
        explode:     null,
      }))
    : [];

  // Path variables declared in url.variable[].
  const pathVariables = Array.isArray(url.variable) ? url.variable : [];

  return { rawUrl, path, queryParams, pathVariables };
}

/**
 * Extract declared path param names from a path string (e.g. /widgets/{id}).
 * @param {string} path
 * @returns {string[]}
 */
function _extractPathParamNames(path) {
  const names = [];
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Build IR path_params[] from a path string and optional url.variable[] declarations.
 * @param {string} path
 * @param {Array} urlVariables  url.variable[] from Postman (may have .key/.value).
 * @returns {object[]}
 */
function _buildPathParams(path, urlVariables) {
  const names = _extractPathParamNames(path);
  const varMap = {};
  for (const v of (urlVariables || [])) {
    if (v && v.key) varMap[v.key] = v;
  }
  return names.map(name => {
    const decl = varMap[name] || {};
    return {
      name,
      type:        { primitive: 'string' },
      required:    true,
      description: decl.description || null,
      default:     decl.value || null,
      example:     null,
      enum:        null,
      format:      null,
      deprecated:  false,
      style:       null,
      explode:     null,
    };
  });
}

/**
 * Parse request.header[] into IR headers[]. Skips disabled and standard headers.
 * @param {Array} headers  Postman header array.
 * @param {object} counters  Mutable { disabledCount }.
 * @returns {object[]}
 */
function _parseHeaders(headers, counters) {
  if (!Array.isArray(headers)) return [];
  const result = [];
  for (const h of headers) {
    if (!h) continue;
    if (h.disabled) { counters.disabledCount++; continue; }
    if (SKIP_HEADERS.has((h.key || '').toLowerCase())) continue;
    result.push({
      name:        h.key || '',
      type:        { primitive: 'string' },
      required:    false,
      description: h.description || null,
      default:     h.value || null,
      example:     null,
      enum:        null,
      format:      null,
      deprecated:  false,
      style:       null,
      explode:     null,
    });
  }
  return result;
}

/**
 * Parse request.body into IR body object.
 * Per locked Q4: store request bodies as raw text in extensions, no typed inference.
 * @param {object|undefined} body  Postman request body.
 * @param {object} extensions  Mutable endpoint extensions object to store raw body.
 * @returns {object|null}
 */
function _parseRequestBody(body, extensions) {
  if (!body || body.mode === 'none' || !body.mode) return null;

  switch (body.mode) {
    case 'raw': {
      // Detect JSON language hint.
      const lang = (body.options && body.options.raw && body.options.raw.language) || '';
      const isJson = lang === 'json' || (body.raw && body.raw.trimStart().startsWith('{'));
      const contentType = isJson ? 'application/json' : 'text/plain';
      if (body.raw) extensions['x-body-example'] = body.raw;
      return {
        required:     true,
        content_type: contentType,
        schema:       { primitive: 'string' },
        encoding:     null,
      };
    }
    case 'urlencoded': {
      // Collect key-value pairs as raw text for extension.
      if (Array.isArray(body.urlencoded) && body.urlencoded.length > 0) {
        const pairs = body.urlencoded
          .filter(kv => kv && !kv.disabled)
          .map(kv => `${kv.key || ''}=${kv.value || ''}`)
          .join('&');
        if (pairs) extensions['x-body-example'] = pairs;
      }
      return {
        required:     true,
        content_type: 'application/x-www-form-urlencoded',
        schema:       { primitive: 'string' },
        encoding:     null,
      };
    }
    case 'formdata': {
      if (Array.isArray(body.formdata) && body.formdata.length > 0) {
        const pairs = body.formdata
          .filter(kv => kv && !kv.disabled)
          .map(kv => `${kv.key || ''}=${kv.value || ''}`)
          .join('&');
        if (pairs) extensions['x-body-example'] = pairs;
      }
      return {
        required:     true,
        content_type: 'multipart/form-data',
        schema:       { primitive: 'string' },
        encoding:     null,
      };
    }
    case 'file':
      return {
        required:     true,
        content_type: 'application/octet-stream',
        schema:       { primitive: 'binary' },
        encoding:     null,
      };
    default:
      return null;
  }
}

/**
 * Parse a Postman response[] array into IR responses{} object.
 * @param {Array} responses  Postman response array.
 * @param {object} extensions  Mutable endpoint extensions for example storage.
 * @returns {object}
 */
function _parseResponses(responses, extensions) {
  if (!Array.isArray(responses) || responses.length === 0) return {};
  const result = {};
  for (const resp of responses) {
    if (!resp) continue;
    const codeStr = String(resp.code || 'default');

    // Derive content-type from response headers or _postman_previewlanguage.
    let contentType = null;
    if (Array.isArray(resp.header)) {
      const ctHeader = resp.header.find(h => h && (h.key || '').toLowerCase() === 'content-type');
      if (ctHeader) contentType = ctHeader.value || null;
    }
    if (!contentType && resp._postman_previewlanguage) {
      const lang = resp._postman_previewlanguage.toLowerCase();
      if (lang === 'json') contentType = 'application/json';
      else if (lang === 'html') contentType = 'text/html';
      else if (lang === 'xml') contentType = 'application/xml';
      else if (lang === 'text') contentType = 'text/plain';
    }

    // Store body example in extensions keyed by status code.
    if (resp.body) {
      extensions[`x-response-example-${codeStr}`] = resp.body;
    }

    const entry = {
      description: resp.name || resp.status || null,
      headers:     [],
    };
    if (contentType) entry.content_type = contentType;
    entry.schema = { primitive: 'string' };

    result[codeStr] = entry;
  }
  return result;
}

/**
 * Parse a Postman auth object into an IR auth scheme object, or return null + warning.
 * @param {object|undefined} auth  Postman auth object.
 * @param {string} id  ID to assign to the resulting scheme.
 * @param {string[]} warnings  Mutable warnings array.
 * @returns {object|null}
 */
function _parseAuthScheme(auth, id, warnings) {
  if (!auth || !auth.type || auth.type === 'noauth') return null;

  switch (auth.type) {
    case 'bearer': {
      return {
        id,
        type:        'http-bearer',
        header_name: 'Authorization',
        scheme:      'Bearer',
      };
    }
    case 'basic': {
      return {
        id,
        type: 'http-basic',
      };
    }
    case 'apikey': {
      // Postman apikey[] array entries: [{key: "key", value: "..."}, {key: "in", value: "header|query"}, ...]
      const entries = Array.isArray(auth.apikey) ? auth.apikey : [];
      const keyEntry = entries.find(e => e && e.key === 'key');
      const inEntry  = entries.find(e => e && e.key === 'in');
      const keyName  = keyEntry ? keyEntry.value : 'X-API-Key';
      const keyIn    = inEntry  ? inEntry.value  : 'header';
      return {
        id,
        type: 'api-key',
        in:   keyIn,
        name: keyName,
      };
    }
    case 'oauth2': {
      // Best-effort OAuth2 extraction from oauth2[] array.
      const entries = Array.isArray(auth.oauth2) ? auth.oauth2 : [];
      const getVal = key => { const e = entries.find(e => e && e.key === key); return e ? e.value : null; };
      const tokenUrl = getVal('accessTokenUrl');
      const authUrl  = getVal('authUrl');
      return {
        id,
        type:              'oauth2',
        flow:              'authorization_code',
        token_url:         tokenUrl || null,
        authorization_url: authUrl || null,
        refresh_url:       null,
        scopes:            [],
      };
    }
    case 'oauth1':
    case 'awsv4':
    case 'digest':
    case 'ntlm':
    case 'hawk':
      warnings.push(`unsupported_auth_type_${auth.type}`);
      return null;
    default:
      warnings.push(`unsupported_auth_type_${auth.type}`);
      return null;
  }
}

/**
 * Extract the origin (scheme + host) from a URL string, or null on failure.
 * @param {string} raw
 * @returns {string|null}
 */
function _extractOrigin(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.origin !== 'null' ? u.origin : null;
  } catch (_) {
    return null;
  }
}

/**
 * Recursively walk Postman item[] array to extract leaf request items.
 * Folders have an `item` array; leaves have a `request` field.
 * @param {Array} items  Postman item array.
 * @param {string[]} folderPath  Current folder hierarchy (mutable accumulator, do not modify).
 * @param {Array} out  Mutable output array of { item, folderPath }.
 * @param {object} counters  Mutable { testScriptCount }.
 */
function _walkItems(items, folderPath, out, counters) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item) continue;
    // Count any event[] (test scripts) we drop.
    if (Array.isArray(item.event) && item.event.length > 0) {
      counters.testScriptCount += item.event.length;
    }
    if (Array.isArray(item.item)) {
      // This is a folder — recurse with updated folder path.
      _walkItems(item.item, [...folderPath, item.name || ''], out, counters);
    } else if (item.request) {
      // This is a leaf request item.
      out.push({ item, folderPath: [...folderPath] });
    }
  }
}

/**
 * Resolve Postman collection variables in a string.
 * Replaces {{varName}} if varName exists in the variable map.
 * @param {string} s
 * @param {object} varMap  Map of variable key → value.
 * @returns {string}
 */
function _resolveVars(s, varMap) {
  if (!s || !varMap || Object.keys(varMap).length === 0) return s;
  return s.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return varMap[key] !== undefined ? varMap[key] : match;
  });
}

/**
 * Parse Postman v2.1 collection JSON into an apifier mapping IR.
 * Mirrors parseOpenAPI / parseHTML / parseMarkdown signature.
 *
 * @param {object} params
 * @param {string} params.body          - The JSON text of the collection.
 * @param {string} params.content_type  - MIME hint (unused; we re-detect).
 * @param {string|null} params.source_url
 * @returns {Promise<{ ir: object, warnings: string[], parser: {name:string,version:string} }>}
 */
async function parsePostman({ body, content_type, source_url }) {
  const warnings = [];

  // Refuse on tiny/empty body.
  if (!body || typeof body !== 'string' || body.length < 50) {
    throw new PostmanParseError('Postman collection body is too short or empty (under 50 bytes)');
  }

  // Parse JSON.
  let collection;
  try {
    collection = JSON.parse(body);
  } catch (err) {
    throw new PostmanParseError(`Failed to parse Postman collection as JSON: ${err.message}`);
  }

  // Check for Postman v1 format (has "collections" key, not "info"/"item").
  if (collection.collections && !collection.info) {
    throw new PostmanParseError(
      'Postman v1 collection format is not supported. Please convert to v2.1 using the Postman app (Collection → Export → Collection v2.1).'
    );
  }

  // Require info and item fields.
  if (!collection.info || !Array.isArray(collection.item)) {
    throw new PostmanParseError(
      'Invalid Postman collection: missing required "info" or "item" fields.'
    );
  }

  const info = collection.info;

  // Schema version detection.
  const schemaUrl = info.schema || '';
  if (!schemaUrl.includes(POSTMAN_SCHEMA_V2)) {
    warnings.push('postman_schema_url_unrecognised: no valid Postman v2.x schema URL in info.schema; parsing best-effort');
  } else if (schemaUrl.includes('v2.0') && !schemaUrl.includes(POSTMAN_SCHEMA_V21)) {
    warnings.push('postman_collection_v2.0_detected: v2.0 schema detected; parsed best-effort (v2.1 is the primary supported version)');
  }

  // Build collection variable map for substitution.
  const varMap = {};
  if (Array.isArray(collection.variable)) {
    for (const v of collection.variable) {
      if (v && v.key) varMap[v.key] = v.value || '';
    }
  }

  // Service metadata.
  const rawName = info.name || 'Unknown Service';
  const serviceSlug = _slugify(rawName);
  const description = (typeof info.description === 'object' && info.description !== null)
    ? (info.description.content || '')
    : (info.description || '');

  // Walk items recursively.
  const counters = { testScriptCount: 0, disabledQueryCount: 0, disabledHeaderCount: 0 };
  const leafItems = [];
  _walkItems(collection.item, [], leafItems, counters);

  // Parse all endpoints.
  const usedIds   = new Set();
  const endpoints = [];
  const allOrigins = new Set();

  for (const { item, folderPath } of leafItems) {
    const req = item.request;
    if (!req) continue;

    const method = (req.method || 'GET').toUpperCase();

    // Count item-level test scripts.
    if (Array.isArray(item.event) && item.event.length > 0) {
      // Already counted in _walkItems, skip here to avoid double-count.
    }

    // Parse URL with variable substitution.
    const rawUrl = typeof req.url === 'string'
      ? _resolveVars(req.url, varMap)
      : req.url;
    const { rawUrl: resolvedRaw, path, queryParams, pathVariables } = _parseUrl(rawUrl);

    // Collect origin for base URL inference.
    const origin = _extractOrigin(resolvedRaw);
    if (origin) allOrigins.add(origin);

    // Build path params.
    const pathParams = _buildPathParams(path, pathVariables);

    // Headers — track disabled count.
    const headerCounters = { disabledCount: 0 };
    const headers = _parseHeaders(req.header, headerCounters);
    counters.disabledHeaderCount += headerCounters.disabledCount;

    // Query params — count disabled separately (they were already filtered in _parseUrl).
    if (Array.isArray(rawUrl && typeof rawUrl === 'object' ? rawUrl.query : [])) {
      const allQuery = (typeof rawUrl === 'object' && Array.isArray(rawUrl.query)) ? rawUrl.query : [];
      counters.disabledQueryCount += allQuery.filter(q => q && q.disabled).length;
    }

    // Description.
    const desc = (typeof req.description === 'object' && req.description !== null)
      ? (req.description.content || '')
      : (req.description || '');

    // Endpoint extensions.
    const epExtensions = {};

    // Body.
    const bodyObj = _parseRequestBody(req.body, epExtensions);

    // Responses.
    const responsesObj = _parseResponses(item.response, epExtensions);

    // Per-request auth override.
    const endpointAuth = [];
    if (req.auth && req.auth.type && req.auth.type !== 'noauth') {
      const authScheme = _parseAuthScheme(req.auth, `ep-auth-${_slugify(item.name || '')}`, warnings);
      // We don't add per-endpoint schemes to global auth[] — just note the override.
      // In the IR, we reference the global scheme id; for per-request overrides without a global,
      // we emit a placeholder that scrape consumers can recognize.
      if (authScheme) {
        endpointAuth.push(authScheme.id);
      }
    }

    const id = _deriveId(item.name || method + '_endpoint', method, usedIds);

    const endpoint = {
      id,
      transport:   'http',
      method,
      path,
      summary:     item.name || null,
      description: desc || null,
      tags:        folderPath.length > 0 ? [...folderPath] : [],
      path_params:  pathParams,
      query_params: queryParams,
      headers,
      cookies:     [],
      body:        bodyObj,
      responses:   responsesObj,
      error_codes: [],
      auth:        endpointAuth,
      idempotency: _idempotency(method),
      deprecated:  { is_deprecated: false, since: null, replacement_endpoint_id: null, sunset_at: null },
      pagination:  null,
      rate_limit:  null,
      examples:    [],
    };

    // Attach endpoint-level extensions if any.
    if (Object.keys(epExtensions).length > 0) {
      endpoint['x-extensions'] = epExtensions;
    }

    endpoints.push(endpoint);
  }

  // Warning counts.
  if (counters.disabledQueryCount > 0) {
    warnings.push(`disabled_query_params_skipped: ${counters.disabledQueryCount}`);
  }
  if (counters.disabledHeaderCount > 0) {
    warnings.push(`disabled_headers_skipped: ${counters.disabledHeaderCount}`);
  }
  if (counters.testScriptCount > 0) {
    warnings.push(`postman_test_scripts_dropped: ${counters.testScriptCount}`);
  }

  // Base URL inference: if all endpoints share the same origin, use it.
  const servers = [];
  if (allOrigins.size === 1) {
    const commonOrigin = [...allOrigins][0];
    servers.push({ url: commonOrigin, description: 'inferred from Postman collection' });
  }

  // Global auth scheme.
  const authSchemes = [];
  if (collection.auth) {
    const globalScheme = _parseAuthScheme(collection.auth, 'global-auth', warnings);
    if (globalScheme) {
      authSchemes.push(globalScheme);
      // Apply global auth to all endpoints that don't have per-endpoint auth.
      for (const ep of endpoints) {
        if (ep.auth.length === 0) {
          ep.auth.push('global-auth');
        }
      }
    }
  }

  // Build extensions.
  const extensions = {
    'x-source-format': 'postman',
    'x-postman-id':    info._postman_id || null,
  };

  const ir = {
    service: {
      name:         serviceSlug,
      display_name: rawName,
      version:      '0.0.0',
      description:  description || undefined,
    },
    servers,
    endpoints,
    models:     [],
    auth:       authSchemes,
    errors:     [],
    examples:   [],
    extensions,
  };

  return {
    ir,
    warnings,
    parser: {
      name:    PARSER_NAME,
      version: PARSER_VERSION,
    },
  };
}

module.exports = { parsePostman, PARSER_NAME, PARSER_VERSION };
