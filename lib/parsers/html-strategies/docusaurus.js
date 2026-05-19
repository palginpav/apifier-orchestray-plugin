'use strict';

// lib/parsers/html-strategies/docusaurus.js — Docusaurus (esp. docusaurus-plugin-openapi-docs) strategy.

const {
  normaliseMethodPath, inferPathParams, parseParameterTable,
  findCodeBlocks, extractAnchorText, extractAuthMentions,
  slugifyId, buildEndpoint, normalizeMethod,
} = require('./_common');

/**
 * Check if this page is a Docusaurus-rendered doc page.
 * Cues: body class theme-doc-*, .openapi__method-endpoint, .openapi-tabs__schema-table.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {boolean}
 */
function matches($) {
  // Strong cue: Docusaurus theme body classes
  const bodyClass = $('body').attr('class') || '';
  if (/theme-doc/i.test(bodyClass)) return true;

  // Docusaurus OpenAPI plugin elements
  if ($('[class*="openapi__method"],[class*="openapi-tabs"]').length > 0) return true;
  if ($('.openapi__method-endpoint,.openapi-method-endpoint').length > 0) return true;

  // Docusaurus navbar structure
  if ($('.navbar--fixed-top,.navbar__inner').length > 0) {
    // Check for API-doc-like content
    if ($('h2,h3').filter((_, el) => normaliseMethodPath($(el).text()) !== null).length > 0) return true;
    if ($('[class*="method-badge"],[class*="http-method"]').length > 0) return true;
  }

  // docusaurus-plugin-openapi-docs specific
  if ($('[class*="openapi"]').length > 2) return true;

  return false;
}

/**
 * Extract endpoint data from a Docusaurus page.
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

  // Strategy 1: docusaurus-plugin-openapi-docs specific elements.
  // Pattern: <div class="openapi__method-endpoint"><span class="openapi__method-badge">POST</span><code>/widgets</code></div>
  const openApiEndpoints = $('[class*="openapi__method-endpoint"],[class*="openapi-method-endpoint"]');
  if (openApiEndpoints.length > 0) {
    openApiEndpoints.each((_, el) => {
      const methodBadge = $(el).find('[class*="method-badge"],[class*="method-label"]').first();
      const pathCode = $(el).find('code').first();

      if (methodBadge.length && pathCode.length) {
        const method = normalizeMethod(methodBadge.text().trim());
        const path = pathCode.text().trim();
        if (!method || !path.startsWith('/')) return;

        const id = slugifyId(method, path, usedIds);

        // Look for schema table nearby (parent section or next sibling)
        const section = $(el).closest('section,.theme-api-markdown-item,.col');
        const queryParams = [];
        section.find('table,[class*="schema-table"]').each((_, table) => {
          const parsed = parseParameterTable($, $(table));
          queryParams.push(...parsed);
        });

        const pathParams = inferPathParams(path);
        const description = extractAnchorText($, $(el)).slice(0, 5000) || null;
        const summary = description ? description.split('\n')[0].slice(0, 200) : null;

        if (queryParams.length > 0) {
          warnings.push(`low_confidence: ${id}.query_params — extracted from schema table`);
        }

        endpoints.push(buildEndpoint({
          id, method, path, summary, description,
          path_params: pathParams, query_params: queryParams,
          headers: [], cookies: [], body: null, responses: {},
          auth: authIds, source_url,
          selector: '[class*="openapi__method-endpoint"]',
        }));
      }
    });
  }

  // Strategy 2: headings with METHOD /path pattern (fallback within Docusaurus pages).
  if (endpoints.length === 0) {
    $('h1,h2,h3,h4').each((_, el) => {
      const text = $(el).text().trim();
      const mp = normaliseMethodPath(text);
      if (!mp) return;

      const { method, path } = mp;
      const id = slugifyId(method, path, usedIds);
      const description = extractAnchorText($, $(el)).slice(0, 5000) || null;
      const summary = description ? description.split('\n')[0].slice(0, 200) : null;
      const pathParams = inferPathParams(path);

      // Find parameter tables in the section.
      const queryParams = [];
      let sibling = $(el).next();
      while (sibling.length) {
        const tag = sibling.prop('tagName') || '';
        if (/^h[1-4]$/i.test(tag) && normaliseMethodPath(sibling.text())) break;
        if (tag.toLowerCase() === 'table') {
          queryParams.push(...parseParameterTable($, sibling));
        }
        sibling = sibling.next();
      }

      // Code examples.
      const codeBlocks = findCodeBlocks($, $(el).parent());
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
        warnings.push(`low_confidence: ${id}.query_params — heading-only fallback`);
      }

      endpoints.push(buildEndpoint({
        id, method, path, summary, description,
        path_params: pathParams, query_params: queryParams,
        headers: [], cookies: [], body: null, responses: {},
        auth: authIds, source_url,
        selector: `${el.tagName}:contains("${text.slice(0, 40)}")`,
      }));
    });
  }

  // Note Docusaurus sidebar links (Q6: not followed, but record as warnings).
  const sidebarLinks = [];
  $('[class*="sidebar"] a, nav a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('/') || href.startsWith('./')) {
      sidebarLinks.push(href);
    }
  });
  if (sidebarLinks.length > 1) {
    warnings.push(`docusaurus: sidebar has ${sidebarLinks.length} links — multi-page not followed (Q6 deferred)`);
  }

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
