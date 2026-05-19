'use strict';

// lib/parsers/html-strategies/openapi-rendered.js — Detects Swagger UI, Redoc, Scalar, Stoplight, RapiDoc and returns redirect signal.

/**
 * Check if this page is an OpenAPI-rendered SPA viewer (Swagger UI, Redoc, Scalar, Stoplight, RapiDoc).
 * @param {import('cheerio').CheerioAPI} $
 * @returns {boolean}
 */
function matches($) {
  return extractRedirect($, {}) !== null || _hasViewerHints($);
}

/**
 * Internal: check structural cues without needing spec URL.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {boolean}
 */
function _hasViewerHints($) {
  if ($('#swagger-ui').length > 0) return true;
  if ($('redoc').length > 0 || $('[spec-url]').length > 0) return true;
  if ($('elements-api').length > 0) return true;
  if ($('rapi-doc').length > 0) return true;
  if ($('script[id="api-reference"]').length > 0) return true;
  if ($('script[data-url]').length > 0) return true;
  return false;
}

/**
 * Extract redirect URL from an OpenAPI-rendered viewer page.
 * Returns {redirect_to_spec, source_archetype, warnings} or null if not matched.
 * Same-origin check is NOT performed here — that happens in the scrape handler.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {{source_url?: string|null}} ctx
 * @returns {{redirect_to_spec: string, source_archetype: string, warnings: string[]}|null}
 */
function extractRedirect($, ctx) {
  const warnings = [];

  // 1. Swagger UI: SwaggerUIBundle({url: '...'}) in script text.
  let specUrl = null;
  let archetype = null;

  $('script').each((_, el) => {
    const text = $.text ? $(el).html() || '' : $(el).html() || '';
    if (specUrl) return; // already found

    // Swagger UI
    const swaggerMatch = text.match(/SwaggerUIBundle\s*\(\s*\{[^}]*?url\s*:\s*['"]([^'"]+)['"]/s);
    if (swaggerMatch) {
      specUrl = swaggerMatch[1];
      archetype = 'swagger-ui';
      return;
    }

    // Redoc.init('url', ...)
    const redocInitMatch = text.match(/Redoc\.init\s*\(\s*['"]([^'"]+)['"]/);
    if (redocInitMatch) {
      specUrl = redocInitMatch[1];
      archetype = 'redoc';
      return;
    }

    // Scalar data-configuration JSON with spec.url
    const scalarConfigMatch = text.match(/data-configuration\s*=\s*'([^']+)'/);
    if (scalarConfigMatch) {
      try {
        const config = JSON.parse(scalarConfigMatch[1]);
        if (config && config.spec && config.spec.url) {
          specUrl = config.spec.url;
          archetype = 'scalar';
          return;
        }
      } catch (_) { /* ignore */ }
    }
  });

  if (!specUrl) {
    // 2. Redoc element attribute: <redoc spec-url="...">
    const redocEl = $('redoc[spec-url]');
    if (redocEl.length > 0) {
      specUrl = redocEl.attr('spec-url') || null;
      archetype = 'redoc';
    }
  }

  if (!specUrl) {
    // 3. Scalar script element: <script id="api-reference" data-url="...">
    const scalarScript = $('script#api-reference[data-url]');
    if (scalarScript.length > 0) {
      specUrl = scalarScript.attr('data-url') || null;
      archetype = 'scalar';
    }
  }

  if (!specUrl) {
    // Scalar data-configuration attribute on script
    const scalarDataConfig = $('script#api-reference[data-configuration]');
    if (scalarDataConfig.length > 0) {
      try {
        const config = JSON.parse(scalarDataConfig.attr('data-configuration') || '{}');
        if (config && config.spec && config.spec.url) {
          specUrl = config.spec.url;
          archetype = 'scalar';
        }
      } catch (_) { /* ignore */ }
    }
  }

  if (!specUrl) {
    // 4. Stoplight Elements: <elements-api apiDescriptionUrl="...">
    const stoplightEl = $('elements-api[apiDescriptionUrl]');
    if (stoplightEl.length > 0) {
      specUrl = stoplightEl.attr('apiDescriptionUrl') || null;
      archetype = 'stoplight';
    }
  }

  if (!specUrl) {
    // 5. RapiDoc: <rapi-doc spec-url="...">
    const rapiDocEl = $('rapi-doc[spec-url]');
    if (rapiDocEl.length > 0) {
      specUrl = rapiDocEl.attr('spec-url') || null;
      archetype = 'rapidoc';
    }
  }

  if (!specUrl) {
    return null;
  }

  // Resolve relative URLs against source_url if provided.
  if (ctx && ctx.source_url && !specUrl.startsWith('http')) {
    try {
      specUrl = new URL(specUrl, ctx.source_url).href;
    } catch (_) {
      warnings.push(`Could not resolve relative spec URL: ${specUrl}`);
    }
  }

  return { redirect_to_spec: specUrl, source_archetype: archetype, warnings };
}

/**
 * Extract function (not used for this strategy — redirect short-circuits).
 * Returns empty IR since redirect is the primary signal.
 * @param {import('cheerio').CheerioAPI} $
 * @param {{source_url?: string|null}} ctx
 * @returns {{ir: object, warnings: string[]}}
 */
function extract($, ctx) {
  const redirectResult = extractRedirect($, ctx);
  const warnings = redirectResult ? redirectResult.warnings : ['openapi-rendered: no spec URL found'];
  return {
    ir: {
      service: { name: 'unknown', version: new Date().toISOString().split('T')[0] },
      servers: [],
      endpoints: [],
      models: [],
      auth: [],
      errors: [],
      examples: [],
      extensions: {},
    },
    warnings,
  };
}

module.exports = { matches, extract, extractRedirect };
