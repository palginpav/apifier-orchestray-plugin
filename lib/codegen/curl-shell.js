'use strict';

// lib/codegen/curl-shell.js — Bash/curl client generator from an apifier-mapping v1.
// Pure-string codegen. No external deps. Byte-deterministic for identical inputs.
// Targets bash 4+ (arrays, [[ ]], local scope). NOT POSIX-sh compatible.

/**
 * Convert a path + method into a safe bash function name.
 * Pattern: apifier__<method-lower>__<path-slug>
 * Path-slug: replace /{} and non-alphanumeric with _, lowercase, dedupe underscores.
 * If the resulting slug starts with a digit, prefix with op_.
 * @param {string} method
 * @param {string} urlPath
 * @returns {string}
 */
function _toFunctionName(method, urlPath) {
  const methodSlug = String(method).toLowerCase().replace(/[^a-z0-9]/g, '_');
  const pathSlug = String(urlPath)
    .toLowerCase()
    .replace(/[{}]/g, '_')
    .replace(/\//g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const slug = pathSlug || 'root';
  // If slug starts with a digit, prefix with op_
  const safePath = /^\d/.test(slug) ? 'op_' + slug : slug;
  return `apifier__${methodSlug}__${safePath}`;
}

/**
 * Convert a parameter name to a safe bash variable name.
 * @param {string} name
 * @returns {string}
 */
function _toVarName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^([0-9])/, '_$1');
}

/**
 * Determine which auth scheme types are actually used across all endpoints.
 * @param {Array} authSchemes
 * @param {Array} endpoints
 * @returns {{ types: Set<string>, hasHeaderKey: boolean, hasQueryKey: boolean }}
 */
function _collectUsedAuthTypes(authSchemes, endpoints) {
  const usedIds = new Set();
  for (const ep of (endpoints || [])) {
    for (const id of (ep.auth || [])) usedIds.add(id);
  }
  const usedSchemes = (authSchemes || []).filter(s => usedIds.has(s.id));
  const types = new Set(usedSchemes.map(s => s.type));
  const hasHeaderKey = usedSchemes.some(s => s.type === 'api-key' && s.in !== 'query');
  const hasQueryKey  = usedSchemes.some(s => s.type === 'api-key' && s.in === 'query');
  return { types, schemes: usedSchemes, hasHeaderKey, hasQueryKey };
}

/**
 * Emit the config-variable block at the top of the script.
 * Only emit variables relevant to auth schemes actually used.
 * @param {string} baseUrl
 * @param {{ types: Set<string>, hasHeaderKey: boolean, hasQueryKey: boolean }} authInfo
 * @returns {string[]}
 */
function _emitConfigVars(baseUrl, authInfo) {
  const lines = [];
  lines.push(`# ---------------------------------------------------------------------------`);
  lines.push(`# Configuration — override via environment before sourcing or calling functions`);
  lines.push(`# ---------------------------------------------------------------------------`);
  lines.push(`: "\${APIFIER_BASE_URL:=${baseUrl}}"`);
  if (authInfo.types.has('http-bearer')) {
    lines.push(': "${APIFIER_BEARER_TOKEN:=}"');
  }
  if (authInfo.types.has('api-key')) {
    lines.push(': "${APIFIER_API_KEY:=}"');
    const headerName = authInfo.schemes
      .filter(s => s.type === 'api-key')
      .map(s => s.name)
      .find(n => n) || 'X-API-Key';
    lines.push(`: "\${APIFIER_API_KEY_HEADER:=${headerName}}"`);
  }
  if (authInfo.types.has('http-basic')) {
    lines.push(': "${APIFIER_BASIC_USER:=}"');
    lines.push(': "${APIFIER_BASIC_PASS:=}"');
  }
  lines.push(': "${APIFIER_TIMEOUT_SEC:=30}"');
  lines.push(': "${APIFIER_CURL_OPTS:=--silent --show-error --fail}"');
  return lines;
}

/**
 * Emit auth helper function(s) when auth schemes use them.
 * Returns empty array if no auth used.
 * @param {{ types: Set<string>, hasHeaderKey: boolean, hasQueryKey: boolean, schemes: Array }} authInfo
 * @returns {string[]}
 */
function _emitAuthHelpers(authInfo) {
  if (authInfo.types.size === 0) return [];
  const lines = [];

  // Header-based auth helper
  const hasAnyHeaderAuth = authInfo.types.has('http-bearer') ||
    authInfo.hasHeaderKey || authInfo.types.has('http-basic');

  if (hasAnyHeaderAuth) {
    lines.push('# apifier__auth_headers — echo curl flags for header-based auth');
    lines.push('apifier__auth_headers() {');
    lines.push('  local _h=()');
    if (authInfo.types.has('http-bearer')) {
      lines.push('  [[ -n "${APIFIER_BEARER_TOKEN:-}" ]] && _h+=(-H "Authorization: Bearer ${APIFIER_BEARER_TOKEN}")');
    }
    if (authInfo.hasHeaderKey) {
      lines.push('  [[ -n "${APIFIER_API_KEY:-}" ]] && _h+=(-H "${APIFIER_API_KEY_HEADER}: ${APIFIER_API_KEY}")');
    }
    if (authInfo.types.has('http-basic')) {
      lines.push('  [[ -n "${APIFIER_BASIC_USER:-}" ]] && _h+=(--user "${APIFIER_BASIC_USER}:${APIFIER_BASIC_PASS:-}")');
    }
    lines.push('  if [[ ${#_h[@]} -gt 0 ]]; then printf \'%s\\n\' "${_h[@]}"; fi');
    lines.push('}');
  }

  // Query-string auth helper (api-key in:query)
  if (authInfo.hasQueryKey) {
    const queryScheme = authInfo.schemes.find(s => s.type === 'api-key' && s.in === 'query');
    const paramName = (queryScheme && queryScheme.name) ? queryScheme.name : 'api_key';
    lines.push('');
    lines.push('# apifier__auth_query_string — echo key=value fragment for query-string api-key auth');
    lines.push('apifier__auth_query_string() {');
    lines.push(`  if [[ -n "\${APIFIER_API_KEY:-}" ]]; then`);
    lines.push(`    printf '%s=%s' ${JSON.stringify(paramName)} "\${APIFIER_API_KEY}"`);
    lines.push('  fi');
    lines.push('}');
  }

  return lines;
}

/**
 * Emit one bash function for an endpoint.
 * @param {object} endpoint
 * @param {Array} authSchemes
 * @param {{ types: Set<string>, hasHeaderKey: boolean, hasQueryKey: boolean }} authInfo
 * @returns {string[]}
 */
function _emitEndpointFunction(endpoint, authSchemes, authInfo) {
  const funcName = _toFunctionName(endpoint.method, endpoint.path);
  const pathParams  = endpoint.path_params  || [];
  const queryParams = endpoint.query_params || [];
  const hasBody     = !!endpoint.body;
  const endpointAuthIds = new Set(endpoint.auth || []);

  // Determine which auth types this endpoint uses
  const epSchemes = (authSchemes || []).filter(s => endpointAuthIds.has(s.id));
  const epHasHeaderAuth = epSchemes.some(s =>
    s.type === 'http-bearer' || (s.type === 'api-key' && s.in !== 'query') || s.type === 'http-basic'
  );
  const epHasQueryKey = epSchemes.some(s => s.type === 'api-key' && s.in === 'query');

  const lines = [];

  // Comment header for the function
  const deprecated = (endpoint.deprecated && endpoint.deprecated.is_deprecated) ? ' [DEPRECATED]' : '';
  if (endpoint.summary) {
    lines.push(`# ${funcName} — ${endpoint.summary}${deprecated}`);
  } else {
    lines.push(`# ${funcName} — ${endpoint.method} ${endpoint.path}${deprecated}`);
  }
  lines.push(`# Usage: ${pathParams.map(p => `${_toVarName(p.name)}=<value>`).join(' ')}${pathParams.length && (queryParams.length || hasBody) ? ' ' : ''}${queryParams.map(p => `${_toVarName(p.name)}=<value>`).join(' ')}${hasBody ? ' apifier_body=<json>' : ''} ${funcName}`);

  lines.push(`${funcName}() {`);

  // Required path params with self-documenting error message
  for (const pp of pathParams) {
    const varName = _toVarName(pp.name);
    lines.push(`  : "\${${varName}:?${varName} is required for ${funcName}}"`);
  }

  // Optional query params (default empty)
  for (const qp of queryParams) {
    const varName = _toVarName(qp.name);
    lines.push(`  : "\${${varName}:=}"`);
  }

  // Build URL with path param substitution
  let urlTemplate = endpoint.path;
  for (const pp of pathParams) {
    const varName = _toVarName(pp.name);
    urlTemplate = urlTemplate.replace(
      new RegExp(`\\{${pp.name}\\}`, 'g'),
      `\${${varName}}`
    );
  }
  lines.push(`  local _url="\${APIFIER_BASE_URL}${urlTemplate}"`);

  // Append query-key to URL if needed
  if (epHasQueryKey) {
    lines.push('  local _qs');
    lines.push('  _qs="$(apifier__auth_query_string)"');
    lines.push('  [[ -n "${_qs:-}" ]] && _url="${_url}?${_qs}"');
  }

  // Build query string for regular query params
  if (queryParams.length > 0) {
    lines.push('  local _qparts=()');
    for (const qp of queryParams) {
      const varName = _toVarName(qp.name);
      lines.push(`  [[ -n "\${${varName}:-}" ]] && _qparts+=(--data-urlencode "${qp.name}=\${${varName}}")`);
    }
  }

  // Auth headers array (read from helper function output)
  lines.push('  local _auth_args=()');
  if (epHasHeaderAuth) {
    lines.push('  while IFS= read -r _line; do');
    lines.push('    [[ -n "${_line:-}" ]] && _auth_args+=("${_line}")');
    lines.push('  done < <(apifier__auth_headers)');
  }

  // Body flags
  lines.push('  local _body_args=()');
  if (hasBody) {
    if (endpoint.body.content_type === 'application/json') {
      lines.push('  _body_args+=(-H "Content-Type: application/json")');
    }
    lines.push('  if [[ -n "${apifier_body_file:-}" ]]; then');
    lines.push('    _body_args+=(--data "@${apifier_body_file}")');
    lines.push('  elif [[ -n "${apifier_body:-}" ]]; then');
    lines.push('    _body_args+=(--data "${apifier_body}")');
    lines.push('  fi');
  }

  // Build the curl call using a temporary _cmd array to avoid empty-array set -u issues.
  // We accumulate all flags into _cmd, then execute with "${_cmd[@]}".
  lines.push('  local _cmd=(curl --request ' + endpoint.method + ')');
  lines.push('  local _opts_arr');
  lines.push('  # shellcheck disable=SC2086');
  lines.push('  IFS=" " read -ra _opts_arr <<< "${APIFIER_CURL_OPTS}"');
  lines.push('  _cmd+=("${_opts_arr[@]}")');
  lines.push('  _cmd+=(--max-time "${APIFIER_TIMEOUT_SEC}")');
  lines.push('  if [[ ${#_auth_args[@]} -gt 0 ]]; then _cmd+=("${_auth_args[@]}"); fi');
  lines.push('  if [[ ${#_body_args[@]} -gt 0 ]]; then _cmd+=("${_body_args[@]}"); fi');
  if (queryParams.length > 0) {
    lines.push('  if [[ ${#_qparts[@]} -gt 0 ]]; then _cmd+=("${_qparts[@]}"); fi');
    lines.push('  _cmd+=(--get)');
  }
  lines.push('  _cmd+=("${_url}")');
  lines.push('  "${_cmd[@]}"');

  lines.push('}');
  return lines;
}

/**
 * Build the init guide comment block for the script header.
 * @param {string} serviceName
 * @param {{ types: Set<string> }} authInfo
 * @returns {string[]}
 */
function _buildInitGuide(serviceName, authInfo) {
  const lines = [];
  lines.push('# Quick start:');
  lines.push('#   source ./client.sh');
  if (authInfo.types.has('http-bearer')) {
    lines.push('#   export APIFIER_BEARER_TOKEN=<your-token>');
  }
  if (authInfo.types.has('api-key')) {
    lines.push('#   export APIFIER_API_KEY=<your-api-key>');
  }
  if (authInfo.types.has('http-basic')) {
    lines.push('#   export APIFIER_BASIC_USER=<user>');
    lines.push('#   export APIFIER_BASIC_PASS=<password>');
  }
  lines.push('#   # Call an endpoint (env-style parameter passing):');
  lines.push('#   #   widget_id=abc123 apifier__get__widgets__id');
  lines.push(`#   # Requires bash 4+. Not POSIX-sh compatible.`);
  return lines;
}

/**
 * Generate a bash/curl client script from an apifier-mapping v1.
 *
 * @param {object} mapping  - Validated apifier-mapping v1 object.
 * @param {object} [opts]   - Optional generation options (reserved for future use).
 * @returns {{ text: string, ext: '.sh' }}
 */
function generate(mapping, opts) {
  // eslint-disable-next-line no-unused-vars
  const _opts = opts || {};

  const serviceName   = mapping.service.name;
  const displayName   = mapping.service.display_name || serviceName;
  const baseUrl       = (mapping.servers && mapping.servers.length > 0)
    ? mapping.servers[0].url
    : (mapping.service.base_url || '');
  const schemaVersion = mapping.schema_version || 'unknown';
  const apifierVer    = mapping.apifier_version || 'unknown';
  const sourceUrl     = (mapping.source && (mapping.source.url || mapping.source.file_path)) || '';
  const generatedAt   = (mapping.source && mapping.source.fetched_at) || '';
  const sha256        = (mapping.source && mapping.source.sha256) || '';

  // Sort endpoints: (method ASC, path ASC) — byte-determinism requirement
  const endpoints = [...(mapping.endpoints || [])].sort((a, b) => {
    const methodCmp = (a.method || '').localeCompare(b.method || '');
    if (methodCmp !== 0) return methodCmp;
    return (a.path || '').localeCompare(b.path || '');
  });

  const authSchemes = mapping.auth || [];
  const authInfo    = _collectUsedAuthTypes(authSchemes, endpoints);

  // Sort models alphabetically for a deterministic model-reference comment
  const models = [...(mapping.models || [])].sort((a, b) => a.name.localeCompare(b.name));

  const initGuide = _buildInitGuide(serviceName, authInfo);
  const parts = [];

  // ---------------------------------------------------------------------------
  // 1. Shebang + provenance header
  // ---------------------------------------------------------------------------
  parts.push([
    '#!/usr/bin/env bash',
    '# ---------------------------------------------------------------------------',
    '# Generated by apifier; do not edit by hand.',
    '# ---------------------------------------------------------------------------',
    `# Service:        ${displayName}`,
    `# Source:         ${sourceUrl}`,
    `# sha256:         ${sha256}`,
    `# fetched_at:     ${generatedAt}`,
    `# schema_version: ${schemaVersion}`,
    `# apifier:        ${apifierVer}`,
    '#',
    ...initGuide,
    '# ---------------------------------------------------------------------------',
    'set -euo pipefail',
  ].join('\n'));

  parts.push('');

  // ---------------------------------------------------------------------------
  // 2. Config variables
  // ---------------------------------------------------------------------------
  const configLines = _emitConfigVars(baseUrl, authInfo);
  parts.push(configLines.join('\n'));
  parts.push('');

  // ---------------------------------------------------------------------------
  // 3. Auth helper functions (only when auth is used)
  // ---------------------------------------------------------------------------
  const authLines = _emitAuthHelpers(authInfo);
  if (authLines.length > 0) {
    parts.push(authLines.join('\n'));
    parts.push('');
  }

  // ---------------------------------------------------------------------------
  // 4. Model reference comment block (bash has no struct types)
  // ---------------------------------------------------------------------------
  if (models.length > 0) {
    const modelCommentLines = [
      '# ---------------------------------------------------------------------------',
      '# Model reference (bash has no struct types — shown for documentation only)',
      '# ---------------------------------------------------------------------------',
    ];
    for (const model of models) {
      modelCommentLines.push(`# ${model.name}${model.description ? (' — ' + model.description.replace(/\n/g, ' ')) : ''}`);
      if (model.fields && model.fields.length > 0) {
        for (const field of model.fields) {
          const req = field.required ? '(required)' : '(optional)';
          modelCommentLines.push(`#   .${field.name} ${req}${field.description ? (' — ' + field.description.replace(/\n/g, ' ')) : ''}`);
        }
      }
    }
    modelCommentLines.push('# ---------------------------------------------------------------------------');
    parts.push(modelCommentLines.join('\n'));
    parts.push('');
  }

  // ---------------------------------------------------------------------------
  // 5. One function per endpoint
  // ---------------------------------------------------------------------------
  for (const endpoint of endpoints) {
    const fnLines = _emitEndpointFunction(endpoint, authSchemes, authInfo);
    parts.push(fnLines.join('\n'));
    parts.push('');
  }

  // Join and normalise
  let text = parts.join('\n');
  // Collapse 3+ consecutive blank lines to 2
  text = text.replace(/\n{3,}/g, '\n\n');
  // Ensure single trailing newline
  text = text.trimEnd() + '\n';

  return { text, ext: '.sh' };
}

module.exports = { generate, PARSER_NAME: 'apifier-curl-shell-generator', PARSER_VERSION: '0.0.1' };
