'use strict';

// lib/parsers/html-strategies/generic.js — Fallback: heading-based endpoint detection for any HTML page.

const {
  normaliseMethodPath, inferPathParams, parseParameterTable,
  findCodeBlocks, extractAnchorText, extractAuthMentions,
  slugifyId, buildEndpoint,
} = require('./_common');

/**
 * Generic strategy always matches (last-resort fallback per Q3 decision).
 * @param {import('cheerio').CheerioAPI} $
 * @returns {boolean}
 */
function matches($) {
  // Always true — this is the last-resort fallback.
  return true;
}

/**
 * Extract endpoint data from any HTML page using heading-based heuristics.
 * Confidence: low. Emits low_confidence warnings for all extracted fields.
 * @param {import('cheerio').CheerioAPI} $
 * @param {{source_url?: string|null}} ctx
 * @returns {{ir: object, warnings: string[]}}
 */
function extract($, ctx) {
  const warnings = [];
  const endpoints = [];
  const models = [];
  const examples = [];
  const usedIds = new Set();
  const source_url = (ctx && ctx.source_url) || '';

  // Service name from title.
  const titleText = $('title').text().trim();
  let hostname = 'unknown-service';
  try { hostname = new URL(source_url).hostname.replace(/\./g, '-'); } catch (_) {}
  const rawServiceName = titleText || hostname;
  const serviceSlug = rawServiceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'unknown';

  // Auth schemes.
  const authSchemes = extractAuthMentions($);
  const authIds = authSchemes.map(a => a.id);

  // Primary heuristic: <h2> or <h3> matching ^(GET|POST|...)\s+/...
  $('h1,h2,h3,h4').each((_, el) => {
    const text = $(el).text().trim();
    const mp = normaliseMethodPath(text);
    if (!mp) return;

    const { method, path } = mp;
    const id = slugifyId(method, path, usedIds);
    const description = extractAnchorText($, $(el)).slice(0, 5000) || null;
    const summary = description ? description.split('\n')[0].slice(0, 200) : null;
    const pathParams = inferPathParams(path);

    warnings.push(`low_confidence: ${id} — generic heading match, low-confidence extraction`);

    // Find parameter tables in section.
    const queryParams = [];
    let sibling = $(el).next();
    while (sibling.length) {
      const tag = sibling.prop('tagName') || '';
      if (/^h[1-4]$/i.test(tag) && normaliseMethodPath(sibling.text())) break;
      if (tag.toLowerCase() === 'table') {
        const parsed = parseParameterTable($, sibling);
        if (parsed.length > 0) {
          queryParams.push(...parsed);
          warnings.push(`low_confidence: ${id}.query_params — extracted from table`);
        }
      }
      sibling = sibling.next();
    }

    // Code examples.
    const parent = $(el).parent();
    const codeBlocks = findCodeBlocks($, parent.length ? parent : $.root());
    const curlBlock = codeBlocks.find(b => /shell|bash|curl/i.test(b.language));
    if (curlBlock) {
      examples.push({
        name: id + 'Example',
        endpoint: `${method} ${path}`,
        language: 'curl',
        code: curlBlock.text.slice(0, 2000),
        source_origin: 'scraped',
      });
    }

    const bodyBlock = codeBlocks.find(b => /json/i.test(b.language) && b.text.trim().startsWith('{'));
    let body = null;
    if (bodyBlock) {
      const bodyModelName = id + 'Body';
      models.push({
        name: bodyModelName,
        kind: 'object',
        description: bodyBlock.text.slice(0, 500),
        'x-origin': { html_selector: `h2:contains("${text.slice(0, 40)}")`, source_url },
      });
      body = {
        required: false,
        content_type: 'application/json',
        schema: { $ref: bodyModelName },
        encoding: null,
      };
      warnings.push(`low_confidence: ${id}.body — raw JSON text stored, typed schema not inferred`);
    }

    endpoints.push(buildEndpoint({
      id, method, path, summary, description,
      path_params: pathParams, query_params: queryParams,
      headers: [], cookies: [], body, responses: {},
      auth: authIds, source_url,
      selector: `${el.tagName}:contains("${text.slice(0, 40)}")`,
    }));
  });

  // Servers.
  const servers = [];
  $('code').each((_, el) => {
    const text = $(el).text().trim();
    if (/^https?:\/\//i.test(text) && !/[{}\s]/.test(text)) {
      if (!servers.find(s => s.url === text)) {
        servers.push({ url: text, description: 'scraped' });
      }
    }
  });

  return {
    ir: {
      service: { name: serviceSlug, version: new Date().toISOString().split('T')[0] },
      servers: servers.slice(0, 5),
      endpoints,
      models,
      auth: authSchemes,
      errors: [],
      examples,
      extensions: {},
    },
    warnings,
  };
}

module.exports = { matches, extract };
