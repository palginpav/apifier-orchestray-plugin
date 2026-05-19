'use strict';

// lib/codegen/python-requests.js — Python requests client generator from an apifier-mapping v1.
// Pure-string codegen. No external deps. Byte-deterministic for identical inputs.

/** Reserved Python keywords that must not be used as method names. */
const PY_RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]);

/**
 * Sanitise a string into a valid Python identifier.
 * Strips characters outside [A-Za-z0-9_] and ensures first char is letter or _.
 * @param {string} name
 * @returns {string}
 */
function _toIdentifier(name) {
  let id = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(id)) {
    id = '_' + id;
  }
  return id || '_unnamed';
}

/**
 * Convert an enum value (any JSON value) into an UPPER_SNAKE_CASE Python
 * identifier suitable for use as an `enum.Enum` member name. Non-identifier
 * characters are replaced with `_`; reserved words get an `_M` suffix; empty
 * or numeric-only results fall back to `MEMBER_<idx>`.
 *
 * @param {*} value
 * @param {number} idx  Stable ordinal fallback for unrenderable values.
 * @returns {string}
 */
function _toEnumMemberName(value, idx) {
  const raw = String(value).trim();
  let name = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  // Collapse runs of underscores.
  name = name.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!name || /^[0-9]/.test(name)) {
    name = `MEMBER_${idx}`;
  }
  if (PY_RESERVED.has(name.toLowerCase())) {
    name = name + '_M';
  }
  return name;
}

/**
 * Sanitise a method name: convert to snake_case identifier and suffix _op for reserved words.
 * @param {string} name
 * @returns {string}
 */
function _toMethodName(name) {
  // Convert camelCase/PascalCase to snake_case then sanitise
  const snake = String(name)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
  const id = _toIdentifier(snake);
  return PY_RESERVED.has(id) ? id + '_op' : id;
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
 * Map a mapping type descriptor to a Python type string.
 * Uses Optional[T] / Union[T, U] from typing (Python 3.8+ compatible).
 * @param {object} typeDesc - A type descriptor from the mapping schema.
 * @returns {string} Python type string.
 */
function _typeToPy(typeDesc) {
  if (!typeDesc) return 'Any';
  if (typeDesc.primitive !== undefined) {
    switch (typeDesc.primitive) {
      case 'string':  return 'str';
      case 'integer': return 'int';
      case 'number':  return 'float';
      case 'boolean': return 'bool';
      case 'null':    return 'None';
      case 'binary':  return 'bytes';
      default:        return 'Any';
    }
  }
  if (typeDesc.$ref !== undefined) {
    return _toIdentifier(typeDesc.$ref);
  }
  if (typeDesc.array !== undefined) {
    return `List[${_typeToPy(typeDesc.array)}]`;
  }
  if (typeDesc.map !== undefined) {
    return 'Dict[str, Any]';
  }
  if (typeDesc.union !== undefined && Array.isArray(typeDesc.union)) {
    const types = typeDesc.union.map(_typeToPy);
    return `Union[${types.join(', ')}]`;
  }
  return 'Any';
}

/**
 * Emit Python @dataclass for a single model.
 * @param {object} model - A model entry from mapping.models[].
 * @returns {string} Python source lines for the dataclass.
 */
function _emitModelType(model) {
  const lines = [];
  const name = _toIdentifier(model.name);

  if (model.description) {
    // Multi-line descriptions (e.g. JSON body examples from HTML scrape) must
    // be emitted as one `# ` prefix per line to avoid Python IndentationError.
    for (const descLine of String(model.description).split('\n')) {
      lines.push(`# ${descLine}`);
    }
  }

  if (model.kind === 'object') {
    lines.push('@dataclass');
    lines.push(`class ${name}:`);
    const fields = Array.isArray(model.fields) ? model.fields : [];
    if (fields.length === 0) {
      lines.push('    pass');
    } else {
      // Required fields first (no default), then optional (= None)
      const requiredFields = fields.filter(f => f.required);
      const optionalFields = fields.filter(f => !f.required);
      for (const field of requiredFields) {
        const fieldName = _toIdentifier(field.name);
        let pyType;
        if (field.enum && Array.isArray(field.enum) && field.enum.length > 0) {
          // enum → str (Python dataclasses don't have inline literal types without typing_extensions)
          pyType = 'str';
        } else {
          pyType = _typeToPy(field.type);
        }
        if (field.description) {
          lines.push(`    # ${field.description}`);
        }
        lines.push(`    ${fieldName}: ${pyType}`);
      }
      for (const field of optionalFields) {
        const fieldName = _toIdentifier(field.name);
        let pyType;
        if (field.enum && Array.isArray(field.enum) && field.enum.length > 0) {
          pyType = 'str';
        } else {
          pyType = _typeToPy(field.type);
        }
        if (field.description) {
          lines.push(`    # ${field.description}`);
        }
        lines.push(`    ${fieldName}: Optional[${pyType}] = None`);
      }
    }
  } else if (model.kind === 'enum') {
    // Use stdlib enum.Enum so callers can reference named members
    // (e.g. Status.ACTIVE) instead of losing the value set entirely.
    // Multi-base `str, enum.Enum` keeps JSON serialisation as the underlying
    // string value, which is what the API expects on the wire.
    const values = Array.isArray(model.values) ? model.values : [];
    lines.push(`class ${name}(str, enum.Enum):`);
    if (values.length === 0) {
      // Defensive: a malformed mapping with kind=enum and no values still
      // produces a syntactically valid class.
      lines.push('    pass');
    } else {
      for (const v of values) {
        // Member name: upper-snake-case of the value, sanitised. Falls back
        // to MEMBER_<index> if the value can't be coerced into an identifier.
        const memberName = _toEnumMemberName(v, values.indexOf(v));
        lines.push(`    ${memberName} = ${JSON.stringify(String(v))}`);
      }
    }
  } else if (model.kind === 'alias') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    const pyType = fields.length > 0 ? _typeToPy(fields[0].type) : 'Any';
    lines.push(`${name} = ${pyType}`);
  } else if (model.kind === 'union') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    const types = fields.map(f => _typeToPy(f.type));
    const unionType = types.length > 0 ? `Union[${types.join(', ')}]` : 'Any';
    lines.push(`${name} = ${unionType}`);
  } else {
    // Fallback: emit empty dataclass
    lines.push('@dataclass');
    lines.push(`class ${name}:`);
    lines.push('    pass');
  }

  return lines.join('\n');
}

/**
 * Determine the success response type for an endpoint.
 * Returns the Python type string for the 2xx response.
 * @param {object} endpoint
 * @returns {string}
 */
function _responseType(endpoint) {
  const responses = endpoint.responses || {};
  for (const code of Object.keys(responses).sort()) {
    const status = parseInt(code, 10);
    if (!isNaN(status) && status >= 200 && status < 300) {
      const resp = responses[code];
      if (resp && resp.schema) {
        return _typeToPy(resp.schema);
      }
      return 'None';
    }
  }
  return 'None';
}

/**
 * Build a URL expression with path parameter substitution using urllib.parse.quote.
 * e.g. "/widgets/{id}" → f"{self._base_url}/widgets/{urllib.parse.quote(str(id), safe='')}"
 * @param {string} urlPath - The endpoint path template.
 * @param {Array} pathParams - The path_params array.
 * @returns {string} Python f-string expression for the URL.
 */
function _buildUrlExpr(urlPath, pathParams) {
  const paramNames = new Set((pathParams || []).map(p => p.name));
  const pathExpr = urlPath.replace(/\{([^}]+)\}/g, (_, paramName) => {
    const id = _toIdentifier(paramName);
    return `{urllib.parse.quote(str(${id}), safe='')}`;
  });
  return `f"{self._base_url}${pathExpr}"`;
}

/**
 * Build query string lines using urllib.parse.urlencode.
 * @param {Array} queryParams
 * @returns {string[]} Python lines for building _params dict.
 */
function _buildQueryLines(queryParams) {
  if (!queryParams || queryParams.length === 0) return [];
  const lines = [];
  lines.push('        _params: Dict[str, Any] = {}');
  for (const qp of queryParams) {
    const id = _toIdentifier(qp.name);
    if (qp.required) {
      lines.push(`        _params[${JSON.stringify(qp.name)}] = ${id}`);
    } else {
      lines.push(`        if ${id} is not None:`);
      lines.push(`            _params[${JSON.stringify(qp.name)}] = ${id}`);
    }
  }
  return lines;
}

/**
 * Collect auth query lines for api-key/in=query schemes.
 * Mirrors the W15-1 fix from ts-fetch — appends key=value to query params.
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
    if (scheme.type === 'api-key' && scheme.in === 'query') {
      lines.push('        if self._api_key_name and self._api_key_value:');
      lines.push('            _params[self._api_key_name] = self._api_key_value');
    }
  }
  return lines;
}

/**
 * Emit request headers setup lines.
 * @param {object} endpoint
 * @param {Array} authSchemes
 * @returns {string[]}
 */
function _buildHeaderLines(endpoint, authSchemes) {
  const lines = [];
  lines.push('        _headers: Dict[str, str] = {}');

  const endpointAuthIds = new Set(endpoint.auth || []);
  for (const schemeId of endpointAuthIds) {
    const scheme = (authSchemes || []).find(a => a.id === schemeId);
    if (!scheme) continue;
    if (scheme.type === 'http-bearer') {
      lines.push("        if self._bearer_token:");
      lines.push("            _headers['Authorization'] = f'Bearer {self._bearer_token}'");
    } else if (scheme.type === 'api-key' && scheme.in === 'header') {
      lines.push('        if self._api_key_name and self._api_key_value:');
      lines.push('            _headers[self._api_key_name] = self._api_key_value');
    } else if (scheme.type === 'http-basic') {
      lines.push('        if self._basic_auth:');
      lines.push("            _headers['Authorization'] = f'Basic {self._basic_auth}'");
    }
  }

  if (endpoint.body && endpoint.body.content_type === 'application/json') {
    lines.push("        _headers['Content-Type'] = 'application/json'");
  }

  return lines;
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
 * Emit Python auth helper methods.
 * @param {Set<string>} authTypes
 * @param {Array} authSchemes - Full schemes to detect api-key position
 * @returns {string[]}
 */
function _emitAuthMethods(authTypes, authSchemes) {
  const lines = [];
  if (authTypes.has('http-bearer')) {
    lines.push('    def set_bearer_token(self, token: str) -> None:');
    lines.push('        """Set the Bearer token for HTTP bearer authentication."""');
    lines.push('        self._bearer_token = token');
  }
  if (authTypes.has('api-key')) {
    lines.push('    def set_api_key(self, name: str, value: str) -> None:');
    lines.push('        """Set an API key by header/query name and value."""');
    lines.push('        self._api_key_name = name');
    lines.push('        self._api_key_value = value');
  }
  if (authTypes.has('http-basic')) {
    // `import base64` lives at module top now (added conditionally by generate()
    // when http-basic auth is used) — keeps PEP-8 happy and avoids re-importing
    // on every call.
    lines.push('    def set_basic_auth(self, user: str, password: str) -> None:');
    lines.push('        """Set HTTP Basic authentication credentials."""');
    lines.push('        self._basic_auth = base64.b64encode(f"{user}:{password}".encode()).decode()');
  }
  // Unsupported auth types get a TODO comment
  const unsupported = ['oauth2', 'cookie', 'signature', 'mutual-tls'];
  for (const type of unsupported) {
    if (authTypes.has(type)) {
      lines.push(`    # TODO(wave 4C): ${type} auth support not yet implemented`);
    }
  }
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

  // Build parameter list; track emitted names to avoid duplicate arguments
  // (HTML-scraped mappings can produce a path_param + a query_param with the
  // same name when the parser also finds it in a parameter table).
  const sigParams = [];
  const emittedParamNames = new Set();
  for (const pp of (endpoint.path_params || [])) {
    const id = _toIdentifier(pp.name);
    const pyType = _typeToPy(pp.type);
    sigParams.push(`${id}: ${pyType}`);
    emittedParamNames.add(id);
  }
  for (const qp of (endpoint.query_params || [])) {
    const id = _toIdentifier(qp.name);
    if (emittedParamNames.has(id)) continue; // skip duplicate from path_params
    emittedParamNames.add(id);
    const pyType = _typeToPy(qp.type);
    if (qp.required) {
      sigParams.push(`${id}: ${pyType}`);
    } else {
      sigParams.push(`${id}: Optional[${pyType}] = None`);
    }
  }
  if (endpoint.body) {
    const bodyType = endpoint.body.schema ? _typeToPy(endpoint.body.schema) : 'Any';
    if (endpoint.body.required) {
      sigParams.push(`body: ${bodyType}`);
    } else {
      sigParams.push(`body: Optional[${bodyType}] = None`);
    }
  }

  // Method signature
  const selfPart = 'self';
  const paramStr = sigParams.length > 0
    ? `${selfPart}, *, ${sigParams.join(', ')}`
    : selfPart;

  if (endpoint.summary) {
    const deprecated = (endpoint.deprecated && endpoint.deprecated.is_deprecated) ? ' (deprecated)' : '';
    lines.push(`    def ${methodName}(${paramStr}) -> ${responseType}:`);
    lines.push(`        """${endpoint.summary}${deprecated}"""`);
  } else {
    lines.push(`    def ${methodName}(${paramStr}) -> ${responseType}:`);
  }

  // URL building
  const urlExpr = _buildUrlExpr(endpoint.path, endpoint.path_params);
  lines.push(`        _url = ${urlExpr}`);

  // Query params
  const hasQuery = endpoint.query_params && endpoint.query_params.length > 0;
  const authQueryLines = _buildAuthQueryLines(endpoint, authSchemes);
  const needsParams = hasQuery || authQueryLines.length > 0;

  if (needsParams) {
    if (hasQuery) {
      const queryLines = _buildQueryLines(endpoint.query_params);
      for (const l of queryLines) lines.push(l);
    } else {
      lines.push('        _params: Dict[str, Any] = {}');
    }
    for (const l of authQueryLines) lines.push(l);
  }

  // Headers
  const headerLines = _buildHeaderLines(endpoint, authSchemes);
  for (const l of headerLines) lines.push(l);

  // Build requests.request call
  const requestKwargs = [];
  requestKwargs.push(`method=${JSON.stringify(endpoint.method)}`);
  requestKwargs.push('url=_url');
  requestKwargs.push('headers=_headers');
  if (needsParams) {
    requestKwargs.push('params=_params');
  }
  if (endpoint.body) {
    if (endpoint.body.content_type === 'application/json') {
      requestKwargs.push('json=body');
    } else {
      requestKwargs.push('data=body');
    }
  }
  lines.push(`        _resp = requests.request(${requestKwargs.join(', ')})`);

  // Response handling
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
        lines.push(`        if _resp.status_code == ${status}:`);
        lines.push(`            return _resp.json()`);
      } else {
        lines.push(`        if _resp.status_code == ${status}:`);
        lines.push(`            return None`);
      }
    } else if (status === 400) {
      lines.push(`        if _resp.status_code == 400:`);
      lines.push(`            raise ApifierBadRequestError(_resp.text, 400)`);
    } else if (status === 401) {
      lines.push(`        if _resp.status_code == 401:`);
      lines.push(`            raise ApifierAuthenticationError(_resp.text, 401)`);
    } else if (status === 403) {
      lines.push(`        if _resp.status_code == 403:`);
      lines.push(`            raise ApifierAuthorizationError(_resp.text, 403)`);
    } else if (status === 404) {
      lines.push(`        if _resp.status_code == 404:`);
      lines.push(`            raise ApifierNotFoundError(_resp.text, 404)`);
    } else if (status === 409) {
      lines.push(`        if _resp.status_code == 409:`);
      lines.push(`            raise ApifierConflictError(_resp.text, 409)`);
    } else if (status >= 400 && status < 500) {
      lines.push(`        if _resp.status_code == ${status}:`);
      lines.push(`            raise ApifierValidationError(_resp.text, ${status})`);
    } else if (status >= 500) {
      lines.push(`        if _resp.status_code == ${status}:`);
      lines.push(`            raise ApifierServerError(_resp.text, ${status})`);
    }
  }

  // Generic fallbacks. The 2xx case must guard against non-JSON bodies
  // (e.g. 202 Accepted with empty body, 200 text/plain) — calling .json() on
  // those raises ValueError. Return _resp.text in that case.
  lines.push('        if 200 <= _resp.status_code < 300:');
  lines.push('            if "json" in _resp.headers.get("content-type", "").lower():');
  lines.push('                return _resp.json()');
  lines.push('            return _resp.text');
  lines.push('        if 400 <= _resp.status_code < 500:');
  lines.push('            raise ApifierClientError(_resp.text, _resp.status_code)');
  lines.push('        raise ApifierServerError(_resp.text, _resp.status_code)');

  return lines.join('\n');
}

/**
 * Build the init guide example for the module docstring.
 * @param {string} className
 * @param {string} baseUrl
 * @param {Set<string>} authTypes
 * @param {string} serviceName
 * @returns {string[]} Docstring lines.
 */
function _buildInitGuide(className, baseUrl, authTypes, serviceName) {
  const slug = serviceName.toUpperCase().replace(/-/g, '_');
  const lines = [];
  lines.push(`    client = ${className}(base_url=${JSON.stringify(baseUrl)})`);
  if (authTypes.has('http-bearer')) {
    lines.push(`    import os; client.set_bearer_token(os.environ.get('${slug}_TOKEN', ''))`);
  }
  if (authTypes.has('api-key')) {
    lines.push(`    import os; client.set_api_key('X-API-Key', os.environ.get('${slug}_API_KEY', ''))`);
  }
  if (authTypes.has('http-basic')) {
    lines.push(`    import os; client.set_basic_auth(os.environ.get('${slug}_USER', ''), os.environ.get('${slug}_PASS', ''))`);
  }
  lines.push('    result = client.<method_name>(...)');
  return lines;
}

/**
 * Generate a Python requests-based client from an apifier-mapping v1.
 *
 * @param {object} mapping  - Validated apifier-mapping v1 object.
 * @param {object} [opts]   - Optional generation options (reserved for future use).
 * @returns {{ text: string, ext: '.py' }}
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
  // 1. Module docstring (PEP-257)
  // -------------------------------------------------------------------------
  const initGuide = _buildInitGuide(className, baseUrl, usedAuthTypes, serviceName);
  const docstringLines = [
    '"""',
    `Generated by apifier ${apifierVer} on ${generatedAt} from ${sourceUrl}.`,
    `Mapping schema_version: ${schemaVersion}. Do not edit by hand.`,
    `Service: ${displayName}`,
    '',
    'Quick start:',
    ...initGuide,
    '"""',
  ];
  parts.push(docstringLines.join('\n'));

  parts.push('');

  // -------------------------------------------------------------------------
  // 2. Imports (PEP-8: stdlib then third-party, alphabetically within groups)
  // Conditionally include `base64` (when http-basic auth is used) and `enum`
  // (when any model has kind: 'enum') so the imports list stays minimal.
  // -------------------------------------------------------------------------
  const needsBase64 = usedAuthTypes.has('http-basic');
  const needsEnum   = models.some(m => m && m.kind === 'enum');

  const stdlibImports = [];
  if (needsBase64) stdlibImports.push('import base64');
  if (needsEnum)   stdlibImports.push('import enum');
  stdlibImports.push('import urllib.parse');
  stdlibImports.push('from dataclasses import dataclass');
  stdlibImports.push('from typing import Any, Dict, List, Optional, Union');

  parts.push([
    '# Requires: pip install requests',
    ...stdlibImports,
    '',
    'import requests',
  ].join('\n'));

  parts.push('');

  // -------------------------------------------------------------------------
  // 3. Type definitions (one @dataclass per model, sorted alphabetically)
  // -------------------------------------------------------------------------
  if (models.length > 0) {
    const modelParts = models.map(_emitModelType);
    parts.push(modelParts.join('\n\n'));
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 4. Error class hierarchy
  // -------------------------------------------------------------------------
  parts.push([
    'class ApifierClientError(Exception):',
    '    """Base class for all apifier client errors."""',
    '',
    '    def __init__(self, message: str, status_code: Optional[int] = None) -> None:',
    '        super().__init__(message)',
    '        self.status_code = status_code',
    '',
    '',
    'class ApifierBadRequestError(ApifierClientError):',
    '    """400 Bad request error."""',
    '',
    '',
    'class ApifierAuthenticationError(ApifierClientError):',
    '    """401 Authentication error."""',
    '',
    '',
    'class ApifierAuthorizationError(ApifierClientError):',
    '    """403 Authorization error."""',
    '',
    '',
    'class ApifierNotFoundError(ApifierClientError):',
    '    """404 Not found error."""',
    '',
    '',
    'class ApifierConflictError(ApifierClientError):',
    '    """409 Conflict error."""',
    '',
    '',
    'class ApifierValidationError(ApifierClientError):',
    '    """4xx fallback validation error."""',
    '',
    '',
    'class ApifierServerError(ApifierClientError):',
    '    """5xx server error."""',
  ].join('\n'));

  parts.push('');

  // -------------------------------------------------------------------------
  // 5. Client class
  // -------------------------------------------------------------------------
  const classLines = [];
  classLines.push('');
  classLines.push(`class ${className}:`);
  classLines.push(`    """${displayName} client generated from apifier-mapping v${schemaVersion}."""`);
  classLines.push('');

  // Constructor
  classLines.push(`    def __init__(self, base_url: Optional[str] = None) -> None:`);
  classLines.push(`        self._base_url: str = base_url if base_url is not None else ${JSON.stringify(baseUrl)}`);
  classLines.push('        # Remove trailing slash for consistent URL construction');
  classLines.push("        if self._base_url.endswith('/'):");
  classLines.push("            self._base_url = self._base_url[:-1]");

  // Auth field initialisers
  if (usedAuthTypes.has('http-bearer')) {
    classLines.push('        self._bearer_token: Optional[str] = None');
  }
  if (usedAuthTypes.has('api-key')) {
    classLines.push('        self._api_key_name: Optional[str] = None');
    classLines.push('        self._api_key_value: Optional[str] = None');
  }
  if (usedAuthTypes.has('http-basic')) {
    classLines.push('        self._basic_auth: Optional[str] = None');
  }

  // Auth helper methods
  const authMethods = _emitAuthMethods(usedAuthTypes, authSchemes);
  if (authMethods.length > 0) {
    classLines.push('');
    for (const l of authMethods) classLines.push(l);
  }

  // Endpoint methods
  for (const ep of endpoints) {
    classLines.push('');
    classLines.push(_emitMethod(ep, authSchemes));
  }

  parts.push(classLines.join('\n'));
  parts.push('');

  // -------------------------------------------------------------------------
  // 6. Footer __all__
  // -------------------------------------------------------------------------
  const publicSymbols = [
    className,
    'ApifierAuthenticationError',
    'ApifierAuthorizationError',
    'ApifierBadRequestError',
    'ApifierClientError',
    'ApifierConflictError',
    'ApifierNotFoundError',
    'ApifierServerError',
    'ApifierValidationError',
  ].sort();
  // Add model class names (only object/enum kinds produce classes)
  for (const model of models) {
    if (model.kind === 'object' || model.kind === 'enum') {
      publicSymbols.push(_toIdentifier(model.name));
    }
  }
  publicSymbols.sort();
  const allList = publicSymbols.map(s => JSON.stringify(s)).join(', ');
  parts.push(`__all__ = [${allList}]`);
  parts.push('');

  const text = parts.join('\n');
  return { text, ext: '.py' };
}

module.exports = { generate };
