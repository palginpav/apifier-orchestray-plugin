'use strict';

// lib/handlers/scrape.js — Handler for the apifier-scrape MCP tool.

const { fetchSource }       = require('../http/fetch');
const { parseOpenAPI }      = require('../parsers/openapi');
const { parseHTML }         = require('../parsers/html');
const { parseMarkdown }     = require('../parsers/markdown');
const { parsePostman }      = require('../parsers/postman');
const { parseGraphQLSDL }   = require('../parsers/graphql-sdl');
const { buildMapping }      = require('../mapping/build');
const { writeMapping }      = require('../mapping/write');
const { BadParamsError }    = require('../errors');

/**
 * Derive a service name slug from a string (title or hostname).
 * @param {string} raw
 * @returns {string}
 */
function _slugify(raw) {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return s || 'unknown';
}

/**
 * Extract a service name from fetch result and parsed IR for use as the output file slug.
 * Priority: explicit param > ir.service.name > URL hostname > path stem.
 * @param {string|undefined} explicit  Param from user.
 * @param {object} ir                  Parsed IR.
 * @param {object} fetchResult         fetchSource result.
 * @returns {string}
 */
function _resolveServiceName(explicit, ir, fetchResult) {
  if (explicit) return explicit;
  if (ir && ir.service && ir.service.name) return ir.service.name;
  if (fetchResult.source_url) {
    try {
      const u = new URL(fetchResult.source_url);
      return _slugify(u.hostname.replace(/\./g, '-'));
    } catch (_) { /* ignore */ }
  }
  if (fetchResult.source_path) {
    const base = require('path').basename(fetchResult.source_path, '.json').replace(/\./g, '-');
    return _slugify(base);
  }
  return 'unknown';
}

/**
 * Sniff the first 512 bytes of a body to determine source type.
 * Returns 'html' | 'markdown' | 'postman' | 'openapi' | 'graphql-sdl'.
 * @param {string} body
 * @param {string} [contentType]
 * @param {string|null} [sourceUrl]
 * @returns {'html'|'markdown'|'postman'|'openapi'|'graphql-sdl'}
 */
function _sniffSourceType(body, contentType, sourceUrl) {
  const prefix = body.trimStart().slice(0, 512).toLowerCase();

  // HTML detection — check first to avoid misidentifying HTML as anything else.
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.startsWith('<!doctype')) {
    return 'html';
  }

  // GraphQL SDL detection — content-type or file extension or content sniff.
  if (contentType && /graphql/i.test(contentType)) return 'graphql-sdl';
  if (sourceUrl && /\.graphqls?$/i.test(sourceUrl)) return 'graphql-sdl';
  // Content sniff: has SDL root-type markers and no HTML/JSON prefix.
  if (!prefix.startsWith('{') && !prefix.startsWith('[') &&
      !prefix.startsWith('<!') && !prefix.startsWith('<html') &&
      (/\btype\s+query\s*\{/i.test(body) ||
       /\btype\s+mutation\s*\{/i.test(body) ||
       /\bschema\s*\{/.test(body) ||
       /\bextend\s+type\s+query\s*\{/i.test(body))) {
    return 'graphql-sdl';
  }

  // Markdown detection: content-type hint, .md/.markdown URL extension, or leading # heading.
  if (contentType && /markdown/i.test(contentType)) return 'markdown';
  if (sourceUrl && /\.(?:md|markdown)$/i.test(sourceUrl)) return 'markdown';
  // Leading ATX heading: one to six # followed by space and at least one word character.
  if (/^#{1,6} \w/.test(body.trimStart())) return 'markdown';

  // Postman detection (JSON body only).
  if (contentType && /postman/i.test(contentType)) return 'postman';
  if (sourceUrl && /\.postman_collection(?:\.json)?$/i.test(sourceUrl)) return 'postman';
  if (prefix.startsWith('{')) {
    // Try to parse and check for Postman indicators.
    try {
      const parsed = JSON.parse(body);
      // Priority 1: openapi field → openapi.
      if (parsed.openapi) return 'openapi';
      // Priority 2: swagger field → openapi (Swagger 2.0).
      if (parsed.swagger) return 'openapi';
      // Priority 3: Postman schema URL.
      if (parsed.info && parsed.info.schema && parsed.info.schema.includes('getpostman.com/json/collection/v2.')) {
        return 'postman';
      }
      // Priority 4: Postman heuristic — has info + item but no openapi/swagger.
      if (parsed.info && Array.isArray(parsed.item)) return 'postman';
      // Priority 5: Postman _postman_id fallback.
      if (parsed.info && parsed.info._postman_id) return 'postman';
    } catch (_) {
      // JSON parse failed — fall through to openapi (existing behaviour).
    }
  }

  return 'openapi';
}

/**
 * Check if a candidate URL is same-origin as the source URL.
 * Relative paths (no scheme) are always allowed.
 * @param {string} candidateUrl
 * @param {string|null} sourceUrl
 * @returns {{allowed: boolean, reason?: string}}
 */
function _checkSameOrigin(candidateUrl, sourceUrl) {
  // Relative paths are always allowed.
  if (!candidateUrl.startsWith('http://') && !candidateUrl.startsWith('https://')) {
    return { allowed: true };
  }
  if (!sourceUrl) {
    return { allowed: true }; // No source URL to compare against.
  }
  try {
    const candidate = new URL(candidateUrl);
    const source = new URL(sourceUrl);
    if (candidate.origin === source.origin) {
      return { allowed: true };
    }
    return { allowed: false, reason: `cross-origin redirect blocked: ${candidate.origin} vs ${source.origin}` };
  } catch (err) {
    return { allowed: false, reason: `invalid URL in redirect: ${err.message}` };
  }
}

/**
 * Handle an apifier-scrape tool call.
 *
 * @param {object} params
 * @param {string}  params.source        - URL, file path, or inline spec text.
 * @param {string}  [params.service_name] - Output file slug.
 * @param {string}  [params.output_dir]  - Target directory.
 * @param {boolean} [params.overwrite]   - Allow overwrite.
 * @param {number}  [params.timeout_ms]  - Fetch timeout.
 * @param {string}  [params.source_type] - Force parser: 'openapi', 'swagger', 'html', 'auto' (default).
 * @returns {Promise<{
 *   output_path: string,
 *   endpoint_count: number,
 *   head_sample: object[],
 *   warnings: string[],
 *   source: { url: string|null, sha256: string, fetched_at: string }
 * }>}
 */
async function handleScrape(params) {
  if (!params || typeof params !== 'object') throw new BadParamsError('params must be an object');
  if (!params.source || typeof params.source !== 'string') throw new BadParamsError('source is required');

  // 1. Fetch.
  const obey_robots_txt = params.obey_robots_txt !== false;
  const fetchResult = await fetchSource({
    source:          params.source,
    timeout_ms:      params.timeout_ms,
    obey_robots_txt,
  });

  // 2. Determine source type and parse accordingly.
  const sourceType = params.source_type || 'auto';
  let ir, warnings, parser, sourceProvType;
  const allWarnings = [];

  // Determine whether to use HTML, Markdown, Postman, GraphQL SDL, or OpenAPI parser.
  let sniffedType;
  if (sourceType === 'html') {
    sniffedType = 'html';
  } else if (sourceType === 'markdown') {
    sniffedType = 'markdown';
  } else if (sourceType === 'postman') {
    sniffedType = 'postman';
  } else if (sourceType === 'graphql-sdl') {
    sniffedType = 'graphql-sdl';
  } else if (sourceType === 'openapi' || sourceType === 'swagger') {
    sniffedType = 'openapi';
  } else {
    // auto-sniff
    sniffedType = _sniffSourceType(
      fetchResult.body,
      fetchResult.content_type,
      fetchResult.source_url || fetchResult.source_path
    );
  }

  if (sniffedType === 'graphql-sdl') {
    // Parse as GraphQL SDL.
    const gqlResult = await parseGraphQLSDL({
      body:         fetchResult.body,
      content_type: fetchResult.content_type,
      source_url:   fetchResult.source_url || fetchResult.source_path,
    });

    ir             = gqlResult.ir;
    warnings       = gqlResult.warnings;
    parser         = gqlResult.parser;
    sourceProvType = 'graphql-sdl';
    allWarnings.push(...(warnings || []));
  } else if (sniffedType === 'postman') {
    // Parse as Postman collection.
    const postmanResult = await parsePostman({
      body:         fetchResult.body,
      content_type: fetchResult.content_type,
      source_url:   fetchResult.source_url || fetchResult.source_path,
    });

    ir            = postmanResult.ir;
    warnings      = postmanResult.warnings;
    parser        = postmanResult.parser;
    sourceProvType = 'postman';
    allWarnings.push(...(warnings || []));
  } else if (sniffedType === 'markdown') {
    // Parse as Markdown.
    const mdResult = await parseMarkdown({
      body:         fetchResult.body,
      content_type: fetchResult.content_type,
      source_url:   fetchResult.source_url || fetchResult.source_path,
    });

    ir            = mdResult.ir;
    warnings      = mdResult.warnings;
    parser        = mdResult.parser;
    sourceProvType = 'markdown';
    allWarnings.push(...(warnings || []));
  } else if (sniffedType === 'html') {
    // Parse as HTML.
    const htmlResult = await parseHTML({
      body:         fetchResult.body,
      content_type: fetchResult.content_type,
      source_url:   fetchResult.source_url || fetchResult.source_path,
    });

    parser = htmlResult.parser;
    allWarnings.push(...(htmlResult.warnings || []));

    if (htmlResult.redirect_to_spec) {
      // Q1: Auto-follow same-origin redirect_to_spec.
      const { url: specUrl, source_archetype } = htmlResult.redirect_to_spec;
      const originCheck = _checkSameOrigin(specUrl, fetchResult.source_url);

      if (!originCheck.allowed) {
        // Cross-origin: refuse the follow. The original HTML body is a
        // viewer shell (Swagger UI / Redoc / etc.) — it has no extractable
        // endpoints on its own, so falling through to buildMapping() would
        // crash on the null IR. Surface a structured error instead.
        const { HTMLParseError } = require('../errors');
        throw new HTMLParseError(
          `cross-origin spec redirect blocked: detected ${source_archetype} viewer pointing to ${specUrl} which is not same-origin with the source page (${originCheck.reason}). Re-invoke apifier-scrape with source=${specUrl} directly.`,
        );
      } else {
        // Same-origin: fetch spec URL and parse as OpenAPI.
        allWarnings.push(`spec_redirect_followed: discovered OpenAPI spec at ${specUrl} (archetype: ${source_archetype})`);

        const specFetch = await fetchSource({
          source:          specUrl,
          timeout_ms:      params.timeout_ms,
          obey_robots_txt,
        });

        const openApiResult = await parseOpenAPI({
          body:         specFetch.body,
          content_type: specFetch.content_type,
          source_url:   specFetch.source_url,
        });

        ir = openApiResult.ir;
        warnings = openApiResult.warnings;
        parser = openApiResult.parser;
        allWarnings.push(...(warnings || []));
        sourceProvType = 'openapi';

        // Record original HTML URL in parser_warnings for provenance.
        allWarnings.push(`source_provenance: original HTML page was ${fetchResult.source_url || fetchResult.source_path}`);
      }
    } else {
      ir = htmlResult.ir;
      warnings = htmlResult.warnings;
      sourceProvType = 'html';
    }
  } else {
    // Parse as OpenAPI.
    const openApiResult = await parseOpenAPI({
      body:         fetchResult.body,
      content_type: fetchResult.content_type,
      source_url:   fetchResult.source_url,
    });
    ir = openApiResult.ir;
    warnings = openApiResult.warnings;
    parser = openApiResult.parser;
    allWarnings.push(...(warnings || []));
    sourceProvType = 'openapi';
  }

  // 3. Build mapping.
  const serviceName = _resolveServiceName(params.service_name, ir, fetchResult);

  const sourceProvenance = {
    type:             sourceProvType,
    url:              fetchResult.source_url,
    file_path:        fetchResult.source_path,
    fetched_at:       fetchResult.fetched_at,
    sha256:           fetchResult.sha256,
    bytes:            fetchResult.bytes,
    robots_respected: obey_robots_txt,
    parser:           { name: parser.name, version: parser.version },
    parser_warnings:  allWarnings.map(w => ({ code: 'parser_warning', detail: w })),
  };

  const mapping = buildMapping({ ir, source: sourceProvenance });

  // 4. Write.
  const { output_path } = writeMapping({
    mapping,
    service_name: serviceName,
    output_dir:   params.output_dir || undefined,
    overwrite:    params.overwrite === true,
  });

  // 5. Build response.
  const endpoints     = mapping.endpoints || [];
  const endpointCount = endpoints.length;
  const headSample    = endpoints.slice(0, 2).map(ep => ({
    method:  ep.method,
    path:    ep.path,
    summary: ep.summary || null,
  }));

  return {
    output_path,
    endpoint_count: endpointCount,
    head_sample:    headSample,
    warnings:       allWarnings,
    source: {
      url:        fetchResult.source_url,
      sha256:     fetchResult.sha256,
      fetched_at: fetchResult.fetched_at,
    },
  };
}

module.exports = { handleScrape };
