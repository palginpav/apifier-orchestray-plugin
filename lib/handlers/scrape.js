'use strict';

// lib/handlers/scrape.js — Handler for the apifier-scrape MCP tool.

const { fetchSource }  = require('../http/fetch');
const { parseOpenAPI } = require('../parsers/openapi');
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
 * Handle an apifier-scrape tool call.
 *
 * @param {object} params
 * @param {string}  params.source        - URL, file path, or inline spec text.
 * @param {string}  [params.service_name] - Output file slug.
 * @param {string}  [params.output_dir]  - Target directory.
 * @param {boolean} [params.overwrite]   - Allow overwrite.
 * @param {number}  [params.timeout_ms]  - Fetch timeout.
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
  // obey_robots_txt defaults to true per manifest declaration.
  const obey_robots_txt = params.obey_robots_txt !== false;
  const fetchResult = await fetchSource({
    source:          params.source,
    timeout_ms:      params.timeout_ms,
    obey_robots_txt,
  });

  // 2. Parse (OpenAPI only in v0.0.1).
  const { ir, warnings, parser } = await parseOpenAPI({
    body:         fetchResult.body,
    content_type: fetchResult.content_type,
    source_url:   fetchResult.source_url,
  });

  // 3. Build mapping.
  const serviceName = _resolveServiceName(params.service_name, ir, fetchResult);

  const sourceProvenance = {
    type:              'openapi',
    url:               fetchResult.source_url,
    file_path:         fetchResult.source_path,
    fetched_at:        fetchResult.fetched_at,
    sha256:            fetchResult.sha256,
    bytes:             fetchResult.bytes,
    robots_respected:  null,
    parser:            { name: parser.name, version: parser.version },
    parser_warnings:   warnings.map(w => ({ code: 'parser_warning', detail: w })),
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
    warnings,
    source: {
      url:        fetchResult.source_url,
      sha256:     fetchResult.sha256,
      fetched_at: fetchResult.fetched_at,
    },
  };
}

module.exports = { handleScrape };
