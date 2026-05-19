'use strict';

// lib/parsers/html-strategies/gitbook.js — GitBook rendered doc pages.

const {
  normaliseMethodPath, inferPathParams, parseParameterTable,
  findCodeBlocks, extractAnchorText, extractAuthMentions,
  slugifyId, buildEndpoint,
} = require('./_common');

/**
 * Check if this page is a GitBook-rendered doc page.
 * Cues: data-gitbook-component attr, hashed classnames, GitBook specific classes.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {boolean}
 */
function matches($) {
  // GitBook-specific data attributes
  if ($('[data-gitbook-component]').length > 0) return true;

  // GitBook meta tag or generator
  const generator = $('meta[name="generator"]').attr('content') || '';
  if (/gitbook/i.test(generator)) return true;

  // GitBook classic: .gitbook-root, .page-inner etc.
  if ($('.gitbook-root,.page-inner,.book-summary').length > 0) return true;

  // GitBook v2+: specific structure patterns
  if ($('[class*="gitbook"],[id*="gitbook"]').length > 0) return true;

  return false;
}

/**
 * Extract endpoint data from a GitBook page.
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

  // GitBook uses heading-based endpoint detection (less structured).
  // Primary: headings with METHOD /path text.
  $('h1,h2,h3,h4,h5').each((_, el) => {
    const text = $(el).text().trim();
    const mp = normaliseMethodPath(text);
    if (!mp) return;

    const { method, path } = mp;
    const id = slugifyId(method, path, usedIds);
    const description = extractAnchorText($, $(el)).slice(0, 5000) || null;
    const summary = description ? description.split('\n')[0].slice(0, 200) : null;
    const pathParams = inferPathParams(path);

    // Find parameter tables.
    const queryParams = [];
    let sibling = $(el).next();
    while (sibling.length) {
      const tag = sibling.prop('tagName') || '';
      if (/^h[1-5]$/i.test(tag) && normaliseMethodPath(sibling.text())) break;
      if (tag.toLowerCase() === 'table') {
        const parsed = parseParameterTable($, sibling);
        queryParams.push(...parsed);
      }
      sibling = sibling.next();
    }

    // GitBook code blocks: <pre><code class="lang-bash">
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

    if (queryParams.length > 0) {
      warnings.push(`low_confidence: ${id}.query_params — extracted from table`);
    } else {
      warnings.push(`low_confidence: ${id} — heading-only, no parameter table found`);
    }

    endpoints.push(buildEndpoint({
      id, method, path, summary, description,
      path_params: pathParams, query_params: queryParams,
      headers: [], cookies: [], body: null, responses: {},
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
