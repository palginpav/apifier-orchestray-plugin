'use strict';

// lib/handlers/scrape.js — Handler for the apifier-scrape MCP tool.

const { fetchSource }  = require('../http/fetch');
const { parseOpenAPI } = require('../parsers/openapi');
const { parseHTML }    = require('../parsers/html');
const { buildMapping } = require('../mapping/build');
const { writeMapping } = require('../mapping/write');
const { BadParamsError } = require('../errors');

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
 * Sniff the first 256 bytes of a body to determine if it's HTML or OpenAPI.
 * Returns 'html' | 'openapi'.
 * @param {string} body
 * @returns {'html'|'openapi'}
 */
function _sniffSourceType(body) {
  const prefix = body.trimStart().slice(0, 256).toLowerCase();
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.startsWith('<!doctype')) {
    return 'html';
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

  // Determine whether to use HTML or OpenAPI parser.
  let useHtml = false;
  if (sourceType === 'html') {
    useHtml = true;
  } else if (sourceType === 'openapi' || sourceType === 'swagger') {
    useHtml = false;
  } else {
    // auto-sniff
    useHtml = _sniffSourceType(fetchResult.body) === 'html';
  }

  if (useHtml) {
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
        // Cross-origin: warn and skip auto-follow.
        allWarnings.push(`spec_redirect_skipped: ${originCheck.reason}. Re-invoke with the spec URL directly.`);
        // Fall through: treat original HTML as the content (will likely fail to extract endpoints).
        ir = null;
        warnings = allWarnings;
        sourceProvType = 'html';
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
