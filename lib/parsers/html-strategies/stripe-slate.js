'use strict';

// lib/parsers/html-strategies/stripe-slate.js — Three-column Stripe/Slate layout heuristics.

const {
  normaliseMethodPath, inferPathParams, parseParameterTable,
  findCodeBlocks, extractAnchorText, extractAuthMentions,
  slugifyId, buildEndpoint,
} = require('./_common');

/**
 * Check if this page looks like a Stripe/Slate three-column doc layout.
 * Cues: Slate .content class + h2 METHOD /path headings with code blocks,
 * OR Stripe-specific method+path span patterns (but NOT Docusaurus or generic pages).
 * @param {import('cheerio').CheerioAPI} $
 * @returns {boolean}
 */
function matches($) {
  // Reject Docusaurus pages (let docusaurus.js handle those).
  const bodyClass = $('body').attr('class') || '';
  if (/theme-doc/i.test(bodyClass)) return false;
  if ($('[class*="openapi__method"],[class*="openapi-tabs"]').length > 0) return false;
  if ($('.navbar--fixed-top,.navbar__inner').length > 0) return false;

  // Strong cue: Stripe-specific method+path span combo.
  if ($('[class*="http-method"],[class*="method-badge"],[class*="endpoint-method"]').length > 0) return true;

  // Slate three-column: .content div containing pre code blocks AND METHOD /path headings.
  if ($('.content').length > 0 && $('pre code').length > 0) {
    let hasEndpoint = false;
    $('h2,h3').each((_, el) => {
      if (hasEndpoint) return;
      const text = $(el).text().trim();
      if (normaliseMethodPath(text)) { hasEndpoint = true; }
    });
    if (hasEndpoint) return true;
  }

  return false;
}

/**
 * Extract endpoint data from a Stripe/Slate page.
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

  // Determine service name from title.
  const titleText = $('title').text().trim();
  let hostname = 'unknown-service';
  try { hostname = new URL(source_url).hostname.replace(/\./g, '-'); } catch (_) {}
  const rawServiceName = titleText || hostname;
  const serviceSlug = rawServiceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'unknown';

  // Detect auth schemes from the whole doc.
  const authSchemes = extractAuthMentions($);
  const authIds = authSchemes.map(a => a.id);

  // Find endpoint headings: h1-h4 whose text matches METHOD /path
  // Also look for sibling span.http-method + code.path patterns
  const endpointEls = [];

  $('h1,h2,h3,h4').each((_, el) => {
    const text = $(el).text().trim();
    const mp = normaliseMethodPath(text);
    if (mp) {
      endpointEls.push({ el: $(el), method: mp.method, path: mp.path, selector: `${el.tagName}:contains("${text.slice(0, 40)}")` });
      return;
    }

    // Stripe compound pattern: heading contains span.method + code.path
    const methodSpan = $(el).find('[class*="method"],[class*="verb"],[class*="http-method"]').first();
    const pathCode = $(el).find('[class*="path"],[class*="route"],[class*="endpoint"],[class*="url"]').first();
    if (methodSpan.length > 0 && pathCode.length > 0) {
      const method = normaliseMethodPath(methodSpan.text().trim() + ' ' + pathCode.text().trim());
      if (method) {
        endpointEls.push({ el: $(el), method: method.method, path: method.path, selector: `${el.tagName}` });
      }
    }
  });

  // Also check div/section containers with method+path structure
  $('[class*="endpoint"],[class*="operation"],[class*="api-method"]').each((_, el) => {
    const methodEl = $(el).find('[class*="method"],[class*="verb"]').first();
    const pathEl = $(el).find('[class*="path"],[class*="route"],[class*="url"]').first();
    if (methodEl.length && pathEl.length) {
      const combined = methodEl.text().trim() + ' ' + pathEl.text().trim();
      const mp = normaliseMethodPath(combined);
      if (mp) {
        endpointEls.push({ el: $(el), method: mp.method, path: mp.path, selector: '[class*="endpoint"]' });
      }
    }
  });

  if (endpointEls.length === 0) {
    warnings.push('stripe-slate: no endpoint headings found');
    return { ir: buildEmptyIR(serviceSlug), warnings };
  }

  for (const { el, method, path, selector } of endpointEls) {
    const id = slugifyId(method, path, usedIds);
    const description = extractAnchorText($, el).slice(0, 5000) || null;
    const summary = description ? description.split('\n')[0].slice(0, 200) : null;

    // Path parameters from path pattern.
    let pathParams = inferPathParams(path);

    // Find parameter tables between this heading and the next endpoint heading.
    const queryParams = [];
    let sibling = el.next();
    while (sibling.length) {
      const tag = sibling.prop('tagName') || '';
      // Stop at next heading of same or higher rank that's an endpoint
      if (/^h[1-4]$/i.test(tag) && normaliseMethodPath(sibling.text())) break;

      if (tag.toLowerCase() === 'table') {
        const headerText = sibling.find('th').map((_, th) => $(th).text()).toArray().join(' ');
        if (/query|parameter|param/i.test(headerText)) {
          queryParams.push(...parseParameterTable($, sibling));
        } else if (/path|variable/i.test(headerText)) {
          // Merge into path params by name
          const tblParams = parseParameterTable($, sibling);
          for (const tp of tblParams) {
            const existing = pathParams.find(p => p.name === tp.name);
            if (existing) {
              Object.assign(existing, { type: tp.type, description: tp.description, required: tp.required });
            }
          }
        }
      }
      sibling = sibling.next();
    }

    // Find body and response examples (code blocks in section)
    const codeBlocks = findCodeBlocks($, el.parent().length ? el.parent() : $.root());
    const bodyBlock = codeBlocks.find(b => /json/i.test(b.language) && b.text.trim().startsWith('{'));
    const curlBlock = codeBlocks.find(b => /shell|bash|curl/i.test(b.language));

    let body = null;
    if (bodyBlock) {
      const bodyModelName = id + 'Body';
      models.push({
        name: bodyModelName,
        kind: 'object',
        description: bodyBlock.text.slice(0, 500),
        'x-origin': { html_selector: selector, source_url },
      });
      body = {
        required: true,
        content_type: 'application/json',
        schema: { $ref: bodyModelName },
        encoding: null,
      };
      warnings.push(`low_confidence: ${id}.body — raw JSON text, typed schema not inferred`);
    }

    if (curlBlock) {
      examples.push({
        name: id + 'Example',
        endpoint: `${method} ${path}`,
        language: 'curl',
        code: curlBlock.text.slice(0, 2000),
        source_origin: 'scraped',
      });
    }

    const responses = {};
    const responseBlock = codeBlocks.find(b => /json/i.test(b.language) && b !== bodyBlock);
    if (responseBlock) {
      responses['200'] = { description: 'OK', content_type: 'application/json' };
    }

    if (queryParams.length > 0) {
      warnings.push(`low_confidence: ${id}.query_params — extracted from parameter table`);
    }

    endpoints.push(buildEndpoint({
      id, method, path, summary, description,
      path_params: pathParams, query_params: queryParams,
      headers: [], cookies: [], body, responses,
      auth: authIds, source_url, selector,
    }));
  }

  // Scan for servers.
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

function buildEmptyIR(serviceSlug) {
  return {
    service: { name: serviceSlug || 'unknown', version: new Date().toISOString().split('T')[0] },
    servers: [], endpoints: [], models: [], auth: [], errors: [], examples: [], extensions: {},
  };
}

module.exports = { matches, extract };
