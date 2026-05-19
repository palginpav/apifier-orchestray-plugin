'use strict';

// lib/codegen/go-net-http.js — Go net/http client generator from an apifier-mapping v1.
// Pure-string codegen. No external deps. Byte-deterministic for identical inputs.

/** Reserved Go keywords that must not be used as method/identifier names. */
const GO_RESERVED = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
  'var',
]);

/**
 * Sanitise a string into a valid Go identifier.
 * Strips characters outside [A-Za-z0-9_] and ensures first char is a letter or _.
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
 * Convert a service name slug to a Go package name (lowercase, no hyphens).
 * e.g. "widgets-api" → "widgetsapi". Reserved Go keywords get _pkg suffix.
 * @param {string} serviceName
 * @returns {string}
 */
function _toPackageName(serviceName) {
  let pkg = String(serviceName)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!pkg) pkg = 'apiclient';
  if (GO_RESERVED.has(pkg)) pkg = pkg + '_pkg';
  return pkg;
}

/**
 * Convert an operation id (camelCase/PascalCase) to a PascalCase Go method name.
 * Ensures it starts with uppercase, strips non-identifier chars, appends _op for reserved words.
 * @param {string} name
 * @returns {string}
 */
function _toMethodName(name) {
  // Convert camelCase/PascalCase to PascalCase
  const id = _toIdentifier(name);
  // Ensure first letter is uppercase
  const pascal = id.charAt(0).toUpperCase() + id.slice(1);
  return GO_RESERVED.has(pascal.toLowerCase()) ? pascal + '_op' : pascal;
}

/**
 * Convert a service name slug to PascalCase for the struct/class name.
 * e.g. "widgets-api" → "WidgetsApiClient"
 * @param {string} serviceName
 * @returns {string}
 */
function _toStructName(serviceName) {
  const pascal = String(serviceName)
    .split(/[-_\s]+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
  return pascal + 'Client';
}

/**
 * Map a mapping type descriptor to a Go type string.
 * @param {object} typeDesc - A type descriptor from the mapping schema.
 * @param {boolean} [optional] - If true, emit pointer type for primitives.
 * @returns {string} Go type string.
 */
function _typeToGo(typeDesc, optional) {
  if (!typeDesc) return 'interface{}';
  if (typeDesc.primitive !== undefined) {
    let goType;
    switch (typeDesc.primitive) {
      case 'string':  goType = 'string';  break;
      case 'integer': goType = 'int64';   break;
      case 'number':  goType = 'float64'; break;
      case 'boolean': goType = 'bool';    break;
      case 'null':    return '*string';
      case 'binary':  return '[]byte';
      default:        return 'interface{}';
    }
    return optional ? '*' + goType : goType;
  }
  if (typeDesc.$ref !== undefined) {
    const refName = _toIdentifier(typeDesc.$ref);
    return optional ? '*' + refName : refName;
  }
  if (typeDesc.array !== undefined) {
    return '[]' + _typeToGo(typeDesc.array, false);
  }
  if (typeDesc.map !== undefined) {
    return 'map[string]interface{}';
  }
  if (typeDesc.union !== undefined && Array.isArray(typeDesc.union)) {
    return 'interface{}';
  }
  return 'interface{}';
}

/**
 * Emit Go struct fields for a model with object kind.
 * @param {Array} fields
 * @returns {string[]} Lines for struct fields.
 */
function _emitStructFields(fields) {
  const lines = [];
  for (const field of (fields || [])) {
    const fieldName = _toIdentifier(field.name);
    // Ensure exported (PascalCase) field names
    const exportedName = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
    const isOptional = !field.required;
    let goType;
    if (field.enum && Array.isArray(field.enum) && field.enum.length > 0) {
      // Inline enums on struct fields: use the base type
      const baseType = field.type ? _typeToGo(field.type, false) : 'string';
      goType = isOptional ? '*' + baseType : baseType;
    } else {
      goType = _typeToGo(field.type, isOptional);
    }
    const jsonTag = `\`json:"${field.name}${isOptional ? ',omitempty' : ''}"\``;
    if (field.description) {
      lines.push(`\t// ${field.description.replace(/\n/g, ' ')}`);
    }
    lines.push(`\t${exportedName} ${goType} ${jsonTag}`);
  }
  return lines;
}

/**
 * Emit Go type definition for a single model.
 * @param {object} model - A model entry from mapping.models[].
 * @returns {string} Go source lines for the type.
 */
function _emitModelType(model) {
  const lines = [];
  const name = _toIdentifier(model.name);
  // Ensure exported type name
  const exportedName = name.charAt(0).toUpperCase() + name.slice(1);

  if (model.description) {
    const descLines = String(model.description).split('\n');
    for (const dl of descLines) {
      lines.push(`// ${dl}`);
    }
  }

  if (model.kind === 'object') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    if (fields.length === 0) {
      lines.push(`type ${exportedName} struct{}`);
    } else {
      lines.push(`type ${exportedName} struct {`);
      const fieldLines = _emitStructFields(fields);
      for (const fl of fieldLines) lines.push(fl);
      lines.push('}');
    }
  } else if (model.kind === 'enum') {
    // type <Name> string + const (...) block
    lines.push(`type ${exportedName} string`);
    lines.push('');
    const values = Array.isArray(model.values) ? model.values
      : (Array.isArray(model.fields) ? model.fields.map(f => f.name) : []);
    if (values.length > 0) {
      // Sort enum values alphabetically for byte-determinism
      const sortedValues = [...values].sort((a, b) => String(a).localeCompare(String(b)));
      lines.push('const (');
      for (const v of sortedValues) {
        const memberName = exportedName + '_' + _toIdentifier(String(v)).toUpperCase();
        lines.push(`\t${memberName} ${exportedName} = ${JSON.stringify(String(v))}`);
      }
      lines.push(')');
    }
  } else if (model.kind === 'alias') {
    const fields = Array.isArray(model.fields) ? model.fields : [];
    const goType = fields.length > 0 ? _typeToGo(fields[0].type, false) : 'interface{}';
    lines.push(`type ${exportedName} = ${goType}`);
  } else if (model.kind === 'union') {
    lines.push(`type ${exportedName} interface{}`);
  } else {
    lines.push(`type ${exportedName} struct{}`);
  }

  return lines.join('\n');
}

/**
 * Determine the success response Go type for an endpoint.
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
        return _typeToGo(resp.schema, false);
      }
      return '';
    }
  }
  return '';
}

// (Removed in W30 nits: _buildUrlLines was a dead wrapper that delegated to
// _buildUrlLinesDirect. _emitMethod calls _buildUrlLinesDirect directly, so
// the wrapper had no live callers and contained a dead `_rawURL` assignment
// that would silently discard the computed value if ever re-wired.)

/**
 * Build URL lines using fmt.Sprintf for cleaner output.
 * @param {string} urlPath
 * @param {Array} pathParams
 * @param {string} baseUrlVar
 * @returns {string[]}
 */
function _buildUrlLinesDirect(urlPath, pathParams, baseUrlVar) {
  const lines = [];

  // If no path params, simple string concat
  if (!pathParams || pathParams.length === 0) {
    lines.push(`\t_rawURL := c.baseURL + ${JSON.stringify(urlPath)}`);
    return lines;
  }

  // Build using fmt.Sprintf
  const paramNames = (pathParams || []).map(p => p.name);
  let fmtStr = urlPath;
  const fmtArgs = [];
  for (const paramName of paramNames) {
    const fieldName = _toIdentifier(paramName);
    const exportedField = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
    fmtStr = fmtStr.replace(new RegExp(`\\{${paramName}\\}`, 'g'), '%s');
    fmtArgs.push(`url.PathEscape(fmt.Sprintf("%v", args.${exportedField}))`);
  }
  lines.push(`\t_rawURL := c.baseURL + fmt.Sprintf(${JSON.stringify(fmtStr)}, ${fmtArgs.join(', ')})`);
  return lines;
}

/**
 * Build query params handling lines.
 * @param {Array} queryParams
 * @param {object} endpoint
 * @param {Array} authSchemes
 * @returns {{ lines: string[], needsQueryValues: boolean }}
 */
function _buildQuerySection(queryParams, endpoint, authSchemes) {
  const lines = [];
  const hasQuery = queryParams && queryParams.length > 0;
  const authQuerySchemes = _getAuthQuerySchemes(endpoint, authSchemes);
  const hasAuthQuery = authQuerySchemes.length > 0;

  if (!hasQuery && !hasAuthQuery) {
    return { lines, needsQueryValues: false };
  }

  lines.push('\t_qv := url.Values{}');

  for (const qp of (queryParams || [])) {
    const fieldName = _toIdentifier(qp.name);
    const exportedField = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
    const isOptional = !qp.required;
    const goType = _typeToGo(qp.type, isOptional);
    const isSlice = goType.startsWith('[]');
    const isPointer = !isSlice && isOptional;
    if (qp.required) {
      lines.push(`\t_qv.Set(${JSON.stringify(qp.name)}, fmt.Sprintf("%v", args.${exportedField}))`);
    } else if (isSlice) {
      // Slices use len() == 0 as "absent" check
      lines.push(`\tif len(args.${exportedField}) > 0 {`);
      lines.push(`\t\t_qv.Set(${JSON.stringify(qp.name)}, fmt.Sprintf("%v", args.${exportedField}))`);
      lines.push('\t}');
    } else if (isPointer) {
      lines.push(`\tif args.${exportedField} != nil {`);
      lines.push(`\t\t_qv.Set(${JSON.stringify(qp.name)}, fmt.Sprintf("%v", *args.${exportedField}))`);
      lines.push('\t}');
    } else {
      lines.push(`\t_qv.Set(${JSON.stringify(qp.name)}, fmt.Sprintf("%v", args.${exportedField}))`);
    }
  }

  // api-key/in=query — W15-1 fix: actually append to URL
  for (const scheme of authQuerySchemes) {
    lines.push('\tif c.apiKeyName != "" && c.apiKeyValue != "" {');
    lines.push('\t\t_qv.Set(c.apiKeyName, c.apiKeyValue)');
    lines.push('\t}');
  }

  lines.push('\tif len(_qv) > 0 {');
  lines.push('\t\t_rawURL += "?" + _qv.Encode()');
  lines.push('\t}');

  return { lines, needsQueryValues: true };
}

/**
 * Get auth schemes that use query-position keys for this endpoint.
 * @param {object} endpoint
 * @param {Array} authSchemes
 * @returns {Array}
 */
function _getAuthQuerySchemes(endpoint, authSchemes) {
  const endpointAuthIds = new Set(endpoint.auth || []);
  return (authSchemes || []).filter(s =>
    endpointAuthIds.has(s.id) && s.type === 'api-key' && s.in === 'query'
  );
}

/**
 * Emit request header setup lines.
 * @param {object} endpoint
 * @param {Array} authSchemes
 * @returns {string[]}
 */
function _buildHeaderLines(endpoint, authSchemes) {
  const lines = [];
  const endpointAuthIds = new Set(endpoint.auth || []);

  for (const schemeId of endpointAuthIds) {
    const scheme = (authSchemes || []).find(a => a.id === schemeId);
    if (!scheme) continue;
    if (scheme.type === 'http-bearer') {
      lines.push('\tif c.bearerToken != "" {');
      lines.push('\t\treq.Header.Set("Authorization", "Bearer "+c.bearerToken)');
      lines.push('\t}');
    } else if (scheme.type === 'api-key' && scheme.in === 'header') {
      lines.push('\tif c.apiKeyName != "" && c.apiKeyValue != "" {');
      lines.push('\t\treq.Header.Set(c.apiKeyName, c.apiKeyValue)');
      lines.push('\t}');
    } else if (scheme.type === 'http-basic') {
      lines.push('\tif c.basicUser != "" {');
      lines.push('\t\treq.SetBasicAuth(c.basicUser, c.basicPass)');
      lines.push('\t}');
    }
  }

  if (endpoint.body && endpoint.body.content_type === 'application/json') {
    lines.push('\treq.Header.Set("Content-Type", "application/json")');
  }

  return lines;
}

/**
 * Determine which auth helper types are used across all endpoints.
 * @param {Array} authSchemes
 * @param {Array} endpoints
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
 * Emit Go auth helper methods for the client struct.
 * @param {Set<string>} authTypes
 * @param {string} structName
 * @returns {string[]}
 */
function _emitAuthMethods(authTypes, structName) {
  const lines = [];
  if (authTypes.has('http-bearer')) {
    lines.push(`// SetBearerToken sets the Bearer token for HTTP bearer authentication.`);
    lines.push(`func (c *${structName}) SetBearerToken(token string) {`);
    lines.push('\tc.bearerToken = token');
    lines.push('}');
  }
  if (authTypes.has('api-key')) {
    lines.push(`// SetApiKey sets an API key by header/query name and value.`);
    lines.push(`func (c *${structName}) SetApiKey(name, value string) {`);
    lines.push('\tc.apiKeyName = name');
    lines.push('\tc.apiKeyValue = value');
    lines.push('}');
  }
  if (authTypes.has('http-basic')) {
    lines.push(`// SetBasicAuth sets HTTP Basic authentication credentials.`);
    lines.push(`func (c *${structName}) SetBasicAuth(user, password string) {`);
    lines.push('\tc.basicUser = user');
    lines.push('\tc.basicPass = password');
    lines.push('}');
  }
  // Unsupported auth types
  const unsupported = ['oauth2', 'cookie', 'signature', 'mutual-tls'];
  for (const type of unsupported) {
    if (authTypes.has(type)) {
      lines.push(`// TODO(wave 4E): ${type} auth support not yet implemented`);
    }
  }
  return lines;
}

/**
 * Emit the Args struct for an endpoint (if it has parameters or body).
 * @param {object} endpoint
 * @param {string} methodName
 * @returns {{ structDef: string, hasArgs: boolean }}
 */
function _emitArgsStruct(endpoint, methodName) {
  const pathParams = endpoint.path_params || [];
  const queryParams = endpoint.query_params || [];
  const hasBody = !!endpoint.body;
  const totalParams = pathParams.length + queryParams.length + (hasBody ? 1 : 0);

  if (totalParams === 0) {
    return { structDef: '', hasArgs: false };
  }

  const lines = [];
  lines.push(`// ${methodName}Args holds parameters for the ${methodName} operation.`);
  lines.push(`type ${methodName}Args struct {`);

  const emittedNames = new Set();

  for (const pp of pathParams) {
    const fieldName = _toIdentifier(pp.name);
    const exportedField = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
    emittedNames.add(exportedField);
    const goType = _typeToGo(pp.type, false); // path params always required
    const jsonTag = `\`json:"${pp.name}"\``;
    if (pp.description) {
      lines.push(`\t// ${pp.description.replace(/\n/g, ' ')}`);
    }
    lines.push(`\t${exportedField} ${goType} ${jsonTag}`);
  }

  for (const qp of queryParams) {
    const fieldName = _toIdentifier(qp.name);
    const exportedField = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
    if (emittedNames.has(exportedField)) continue;
    emittedNames.add(exportedField);
    const isOptional = !qp.required;
    // Arrays/slices are not pointer-wrapped even when optional (slices are nil-able natively).
    const rawType = _typeToGo(qp.type, false);
    const isSlice = rawType.startsWith('[]');
    const goType = isSlice ? rawType : _typeToGo(qp.type, isOptional);
    const jsonTag = `\`json:"${qp.name}${isOptional ? ',omitempty' : ''}"\``;
    if (qp.description) {
      lines.push(`\t// ${qp.description.replace(/\n/g, ' ')}`);
    }
    lines.push(`\t${exportedField} ${goType} ${jsonTag}`);
  }

  if (hasBody) {
    const bodyType = endpoint.body.schema ? _typeToGo(endpoint.body.schema, false) : 'interface{}';
    const isOptional = !endpoint.body.required;
    const bodyGoType = isOptional ? '*' + bodyType : bodyType;
    const jsonTag = `\`json:"body${isOptional ? ',omitempty' : ''}"\``;
    lines.push(`\tBody ${bodyGoType} ${jsonTag}`);
  }

  lines.push('}');
  return { structDef: lines.join('\n'), hasArgs: true };
}

/**
 * Emit the response handling switch for an endpoint.
 * @param {object} endpoint
 * @param {string} responseType
 * @param {boolean} hasResponseBody - Whether 2xx response has a decodable JSON body.
 * @returns {string[]}
 */
function _buildResponseLines(endpoint, responseType, hasResponseBody) {
  const lines = [];
  const responses = endpoint.responses || {};
  const sortedCodes = Object.keys(responses).sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    return na - nb;
  });

  lines.push('\tdefer resp.Body.Close()');
  lines.push('\t_body, _readErr := io.ReadAll(resp.Body)');
  lines.push('\tif _readErr != nil {');
  lines.push('\t\treturn _zero, fmt.Errorf("apifier: read response body: %w", _readErr)');
  lines.push('\t}');
  lines.push('\tswitch resp.StatusCode {');

  for (const code of sortedCodes) {
    const status = parseInt(code, 10);
    if (isNaN(status)) continue;
    const resp = responses[code];

    if (status >= 200 && status < 300) {
      lines.push(`\tcase ${status}:`);
      if (responseType && resp && resp.content_type && resp.content_type.includes('json')) {
        lines.push(`\t\tvar _result ${responseType}`);
        lines.push('\t\tif _jsonErr := json.Unmarshal(_body, &_result); _jsonErr != nil {');
        lines.push('\t\t\treturn _zero, fmt.Errorf("apifier: decode response: %w", _jsonErr)');
        lines.push('\t\t}');
        lines.push('\t\treturn _result, nil');
      } else {
        lines.push('\t\treturn _zero, nil');
      }
    } else if (status === 400) {
      lines.push('\tcase 400:');
      lines.push('\t\treturn _zero, &ApifierBadRequestError{ApifierClientError{StatusCode: 400, Body: string(_body)}}');
    } else if (status === 401) {
      lines.push('\tcase 401:');
      lines.push('\t\treturn _zero, &ApifierAuthenticationError{ApifierClientError{StatusCode: 401, Body: string(_body)}}');
    } else if (status === 403) {
      lines.push('\tcase 403:');
      lines.push('\t\treturn _zero, &ApifierAuthorizationError{ApifierClientError{StatusCode: 403, Body: string(_body)}}');
    } else if (status === 404) {
      lines.push('\tcase 404:');
      lines.push('\t\treturn _zero, &ApifierNotFoundError{ApifierClientError{StatusCode: 404, Body: string(_body)}}');
    } else if (status === 409) {
      lines.push('\tcase 409:');
      lines.push('\t\treturn _zero, &ApifierConflictError{ApifierClientError{StatusCode: 409, Body: string(_body)}}');
    } else if (status >= 400 && status < 500) {
      lines.push(`\tcase ${status}:`);
      lines.push(`\t\treturn _zero, &ApifierValidationError{ApifierClientError{StatusCode: ${status}, Body: string(_body)}}`);
    } else if (status >= 500) {
      lines.push(`\tcase ${status}:`);
      lines.push(`\t\treturn _zero, &ApifierServerError{ApifierClientError{StatusCode: ${status}, Body: string(_body)}}`);
    }
  }

  lines.push('\t}');
  lines.push('\t// Generic fallback');
  lines.push('\tif resp.StatusCode >= 200 && resp.StatusCode < 300 {');
  if (responseType && hasResponseBody) {
    lines.push(`\t\tvar _result ${responseType}`);
    lines.push('\t\tif _jsonErr := json.Unmarshal(_body, &_result); _jsonErr != nil {');
    lines.push('\t\t\treturn _zero, fmt.Errorf("apifier: decode response: %w", _jsonErr)');
    lines.push('\t\t}');
    lines.push('\t\treturn _result, nil');
  } else {
    lines.push('\t\treturn _zero, nil');
  }
  lines.push('\t}');
  lines.push('\tif resp.StatusCode >= 400 && resp.StatusCode < 500 {');
  lines.push('\t\treturn _zero, &ApifierClientError{StatusCode: resp.StatusCode, Body: string(_body)}');
  lines.push('\t}');
  lines.push('\treturn _zero, &ApifierServerError{ApifierClientError{StatusCode: resp.StatusCode, Body: string(_body)}}');

  return lines;
}

/**
 * Determine if a 2xx response has a JSON body to decode.
 * @param {object} endpoint
 * @returns {boolean}
 */
function _has2xxJsonBody(endpoint) {
  const responses = endpoint.responses || {};
  for (const code of Object.keys(responses).sort()) {
    const status = parseInt(code, 10);
    if (!isNaN(status) && status >= 200 && status < 300) {
      const resp = responses[code];
      return !!(resp && resp.content_type && resp.content_type.includes('json') && resp.schema);
    }
  }
  return false;
}

/**
 * Emit one client method for an endpoint.
 * @param {object} endpoint
 * @param {Array} authSchemes
 * @param {string} structName
 * @returns {{ argsStruct: string, methodCode: string, importsNeeded: Set<string> }}
 */
function _emitMethod(endpoint, authSchemes, structName) {
  const importsNeeded = new Set();
  const methodName = _toMethodName(endpoint.id);
  const responseType = _responseType(endpoint);
  const hasResponseBody = _has2xxJsonBody(endpoint);

  // Emit args struct
  const { structDef, hasArgs } = _emitArgsStruct(endpoint, methodName);

  const lines = [];

  if (endpoint.summary) {
    const deprecated = (endpoint.deprecated && endpoint.deprecated.is_deprecated) ? ' (deprecated)' : '';
    lines.push(`// ${methodName} ${endpoint.summary}${deprecated}`);
  } else {
    lines.push(`// ${methodName} calls ${endpoint.method} ${endpoint.path}`);
  }

  // Return type: responseType or struct{} for void
  const returnType = responseType || 'struct{}';
  const argsParam = hasArgs ? `args ${methodName}Args` : '';

  lines.push(`func (c *${structName}) ${methodName}(ctx context.Context${argsParam ? ', ' + argsParam : ''}) (${returnType}, error) {`);

  // Zero value for return on error
  if (responseType) {
    lines.push(`\tvar _zero ${responseType}`);
  } else {
    lines.push('\tvar _zero struct{}');
  }

  importsNeeded.add('context');

  // URL building
  const urlLines = _buildUrlLinesDirect(endpoint.path, endpoint.path_params, 'c.baseURL');
  for (const l of urlLines) lines.push(l);
  importsNeeded.add('net/url');
  importsNeeded.add('fmt');

  // Query params
  const hasQuery = endpoint.query_params && endpoint.query_params.length > 0;
  const { lines: queryLines, needsQueryValues } = _buildQuerySection(
    endpoint.query_params, endpoint, authSchemes
  );
  if (needsQueryValues) {
    for (const l of queryLines) lines.push(l);
  }

  // Body
  let bodyArg = 'nil';
  if (endpoint.body) {
    if (endpoint.body.content_type === 'application/json') {
      lines.push('\tvar _bodyBuf bytes.Buffer');
      lines.push('\tif _encErr := json.NewEncoder(&_bodyBuf).Encode(args.Body); _encErr != nil {');
      lines.push('\t\treturn _zero, fmt.Errorf("apifier: encode request body: %w", _encErr)');
      lines.push('\t}');
      bodyArg = '&_bodyBuf';
      importsNeeded.add('bytes');
      importsNeeded.add('encoding/json');
    } else {
      lines.push('\tvar _bodyBuf bytes.Buffer');
      bodyArg = '&_bodyBuf';
      importsNeeded.add('bytes');
    }
  }

  // Create request
  lines.push(`\treq, _reqErr := http.NewRequestWithContext(ctx, ${JSON.stringify(endpoint.method)}, _rawURL, ${bodyArg})`);
  lines.push('\tif _reqErr != nil {');
  lines.push('\t\treturn _zero, fmt.Errorf("apifier: create request: %w", _reqErr)');
  lines.push('\t}');
  importsNeeded.add('net/http');

  // Auth and content-type headers
  const headerLines = _buildHeaderLines(endpoint, authSchemes);
  for (const l of headerLines) lines.push(l);

  // Execute request
  lines.push('\tresp, _doErr := c.httpClient.Do(req)');
  lines.push('\tif _doErr != nil {');
  lines.push('\t\treturn _zero, fmt.Errorf("apifier: do request: %w", _doErr)');
  lines.push('\t}');

  // Response handling
  const respLines = _buildResponseLines(endpoint, responseType, hasResponseBody);
  for (const l of respLines) lines.push(l);
  importsNeeded.add('io');

  if (hasResponseBody) {
    importsNeeded.add('encoding/json');
  }

  lines.push('}');

  return {
    argsStruct: structDef,
    methodCode: lines.join('\n'),
    importsNeeded,
  };
}

/**
 * Build the init guide comment for the header.
 * @param {string} structName
 * @param {string} baseUrl
 * @param {Set<string>} authTypes
 * @param {string} serviceName
 * @returns {string[]}
 */
function _buildInitGuide(structName, baseUrl, authTypes, serviceName) {
  const slug = serviceName.toUpperCase().replace(/-/g, '_');
  const lines = [];
  lines.push(`//   client := New${structName}(${JSON.stringify(baseUrl)})`);
  if (authTypes.has('http-bearer')) {
    lines.push(`//   client.SetBearerToken(os.Getenv("${slug}_TOKEN"))`);
  }
  if (authTypes.has('api-key')) {
    lines.push(`//   client.SetApiKey("X-API-Key", os.Getenv("${slug}_API_KEY"))`);
  }
  if (authTypes.has('http-basic')) {
    lines.push(`//   client.SetBasicAuth(os.Getenv("${slug}_USER"), os.Getenv("${slug}_PASS"))`);
  }
  lines.push('//   result, err := client.<MethodName>(ctx, ...)');
  return lines;
}

/**
 * Generate a Go net/http client from an apifier-mapping v1.
 *
 * @param {object} mapping  - Validated apifier-mapping v1 object.
 * @param {object} [opts]   - Optional generation options (reserved for future use).
 * @returns {{ text: string, ext: '.go' }}
 */
function generate(mapping, opts) {
  // eslint-disable-next-line no-unused-vars
  const _opts = opts || {};

  const serviceName   = mapping.service.name;
  const displayName   = mapping.service.display_name || serviceName;
  const baseUrl       = (mapping.servers && mapping.servers.length > 0)
    ? mapping.servers[0].url
    : (mapping.service.base_url || '');
  // Defensive fallbacks — when generate() is called on a raw parser IR (no
  // schema_version/apifier_version/source), avoid emitting literal "undefined"
  // tokens into the generated Go header.
  const schemaVersion = mapping.schema_version || 'unknown';
  const apifierVer    = mapping.apifier_version || 'unknown';
  const sourceUrl     = (mapping.source && (mapping.source.url || mapping.source.file_path)) || '';
  const generatedAt   = (mapping.source && mapping.source.fetched_at) || '';
  const sha256        = (mapping.source && mapping.source.sha256) || '';
  const packageName   = _toPackageName(serviceName);
  const structName    = _toStructName(serviceName);
  // Constructor function name
  const ctorName      = 'New' + structName;

  // Sort endpoints: (method ASC, path ASC)
  const endpoints = [...(mapping.endpoints || [])].sort((a, b) => {
    const methodCmp = (a.method || '').localeCompare(b.method || '');
    if (methodCmp !== 0) return methodCmp;
    return (a.path || '').localeCompare(b.path || '');
  });

  // Sort models alphabetically by name
  const models = [...(mapping.models || [])].sort((a, b) => a.name.localeCompare(b.name));

  const authSchemes = mapping.auth || [];
  const { types: usedAuthTypes } = _collectUsedAuthTypes(authSchemes, endpoints);

  // Track which imports are actually needed. Start with the minimum that's
  // always referenced (errors → ErrApifierClientErr sentinel; fmt → error
  // formatting; time → http.Client.Timeout in the constructor; net/http →
  // *http.Client field). Endpoint-dependent imports (context / io / net/url)
  // are added below only when an endpoint actually references them — empty-
  // endpoint mappings would otherwise emit unused imports and fail `go vet`.
  const neededImports = new Set([
    'errors',
    'fmt',
    'net/http',
    'time',
  ]);
  // Endpoint-dependent imports: only add when endpoints exist. Each method
  // body uses ctx (context), reads resp.Body (io), and builds the URL
  // (net/url for url.PathEscape / url.Values).
  if (endpoints.length > 0) {
    neededImports.add('context');
    neededImports.add('io');
    neededImports.add('net/url');
  }

  // Process all methods to determine imports
  const methodResults = endpoints.map(ep => _emitMethod(ep, authSchemes, structName));
  for (const mr of methodResults) {
    for (const imp of mr.importsNeeded) {
      neededImports.add(imp);
    }
  }

  // If no path params anywhere, fmt might only be needed for query params or body encoding
  // Keep fmt if we have path params, query params, or body encoding
  const hasFmtUse = endpoints.some(ep =>
    (ep.path_params && ep.path_params.length > 0) ||
    (ep.query_params && ep.query_params.length > 0)
  );
  if (!hasFmtUse) {
    // fmt is still used in error messages via fmt.Errorf — keep it
  }

  // strconv is only needed if we have integer/float query params; skip for now since
  // we use fmt.Sprintf for all conversions. Remove strconv from imports.
  neededImports.delete('strconv');
  // strings is not used in current codegen
  neededImports.delete('strings');

  // Sort imports into stdlib groups
  const allStdlibImports = [
    'bytes', 'context', 'encoding/json', 'errors', 'fmt', 'io',
    'net/http', 'net/url', 'strconv', 'strings', 'time',
  ];
  const sortedImports = allStdlibImports.filter(imp => neededImports.has(imp));

  const parts = [];

  // -------------------------------------------------------------------------
  // 1. Go community convention: generated file marker + header comment
  // -------------------------------------------------------------------------
  const initGuide = _buildInitGuide(structName, baseUrl, usedAuthTypes, serviceName);
  parts.push([
    '// Code generated by apifier; DO NOT EDIT.',
    '//',
    `// Generated by apifier ${apifierVer} on ${generatedAt} from ${sourceUrl}.`,
    `// Mapping schema_version: ${schemaVersion}. sha256: ${sha256}.`,
    `// Service: ${displayName}`,
    '//',
    '// Init:',
    ...initGuide,
  ].join('\n'));

  parts.push('');

  // -------------------------------------------------------------------------
  // 2. Package declaration
  // -------------------------------------------------------------------------
  parts.push(`package ${packageName}`);
  parts.push('');

  // -------------------------------------------------------------------------
  // 3. Imports
  // -------------------------------------------------------------------------
  if (sortedImports.length > 0) {
    const importLines = ['import ('];
    for (const imp of sortedImports) {
      importLines.push(`\t${JSON.stringify(imp)}`);
    }
    importLines.push(')');
    parts.push(importLines.join('\n'));
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 4. Error types
  // -------------------------------------------------------------------------
  parts.push([
    '// ApifierClientError is the base error type for all apifier client errors.',
    'type ApifierClientError struct {',
    '\tStatusCode int',
    '\tBody       string',
    '}',
    '',
    'func (e *ApifierClientError) Error() string {',
    '\treturn fmt.Sprintf("apifier: HTTP %d: %s", e.StatusCode, e.Body)',
    '}',
    '',
    '// ErrApifierClientErr is a sentinel error for errors.Is consumers.',
    'var ErrApifierClientErr = errors.New("apifier client error")',
    '',
    '// ApifierBadRequestError represents a 400 Bad Request response.',
    'type ApifierBadRequestError struct{ ApifierClientError }',
    '',
    '// ApifierAuthenticationError represents a 401 Unauthorized response.',
    'type ApifierAuthenticationError struct{ ApifierClientError }',
    '',
    '// ApifierAuthorizationError represents a 403 Forbidden response.',
    'type ApifierAuthorizationError struct{ ApifierClientError }',
    '',
    '// ApifierNotFoundError represents a 404 Not Found response.',
    'type ApifierNotFoundError struct{ ApifierClientError }',
    '',
    '// ApifierConflictError represents a 409 Conflict response.',
    'type ApifierConflictError struct{ ApifierClientError }',
    '',
    '// ApifierValidationError represents a 4xx validation/client error.',
    'type ApifierValidationError struct{ ApifierClientError }',
    '',
    '// ApifierServerError represents a 5xx server error.',
    'type ApifierServerError struct{ ApifierClientError }',
  ].join('\n'));

  parts.push('');

  // -------------------------------------------------------------------------
  // 5. Model type definitions
  // -------------------------------------------------------------------------
  if (models.length > 0) {
    const modelParts = models.map(_emitModelType);
    parts.push(modelParts.join('\n\n'));
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 6. Client struct and constructor
  // -------------------------------------------------------------------------
  const structLines = [];
  structLines.push(`// ${structName} is the ${displayName} client generated from apifier-mapping v${schemaVersion}.`);
  structLines.push(`type ${structName} struct {`);
  structLines.push('\tbaseURL    string');
  structLines.push('\thttpClient *http.Client');

  // Auth fields
  if (usedAuthTypes.has('http-bearer')) {
    structLines.push('\tbearerToken string');
  }
  if (usedAuthTypes.has('api-key')) {
    structLines.push('\tapiKeyName  string');
    structLines.push('\tapiKeyValue string');
  }
  if (usedAuthTypes.has('http-basic')) {
    structLines.push('\tbasicUser string');
    structLines.push('\tbasicPass string');
  }
  structLines.push('}');

  parts.push(structLines.join('\n'));
  parts.push('');

  // Constructor
  parts.push([
    `// ${ctorName} creates a new ${structName} with the given base URL.`,
    `// If baseURL is empty, defaults to ${JSON.stringify(baseUrl)}.`,
    `func ${ctorName}(baseURL string) *${structName} {`,
    '\tif baseURL == "" {',
    `\t\tbaseURL = ${JSON.stringify(baseUrl)}`,
    '\t}',
    '\t// Remove trailing slash for consistent URL construction',
    '\tfor len(baseURL) > 0 && baseURL[len(baseURL)-1] == \'/\' {',
    '\t\tbaseURL = baseURL[:len(baseURL)-1]',
    '\t}',
    `\treturn &${structName}{`,
    '\t\tbaseURL:    baseURL,',
    '\t\thttpClient: &http.Client{Timeout: 30 * time.Second},',
    '\t}',
    '}',
  ].join('\n'));
  parts.push('');

  // WithHTTPClient builder
  parts.push([
    `// WithHTTPClient returns a new ${structName} using the provided *http.Client.`,
    `func (c *${structName}) WithHTTPClient(hc *http.Client) *${structName} {`,
    '\tc.httpClient = hc',
    '\treturn c',
    '}',
  ].join('\n'));
  parts.push('');

  // Auth helper methods
  const authMethodLines = _emitAuthMethods(usedAuthTypes, structName);
  if (authMethodLines.length > 0) {
    parts.push(authMethodLines.join('\n'));
    parts.push('');
  }

  // -------------------------------------------------------------------------
  // 7. Per-endpoint Args structs and methods
  // -------------------------------------------------------------------------
  for (let i = 0; i < endpoints.length; i++) {
    const mr = methodResults[i];
    if (mr.argsStruct) {
      parts.push(mr.argsStruct);
      parts.push('');
    }
    parts.push(mr.methodCode);
    parts.push('');
  }

  // Join and ensure single trailing newline
  let text = parts.join('\n');
  // Normalise: collapse 3+ consecutive blank lines to 2
  text = text.replace(/\n{3,}/g, '\n\n');
  // Ensure single trailing newline
  text = text.trimEnd() + '\n';

  return { text, ext: '.go' };
}

module.exports = { generate, PARSER_NAME: 'apifier-go-net-http-generator', PARSER_VERSION: '0.0.1' };
