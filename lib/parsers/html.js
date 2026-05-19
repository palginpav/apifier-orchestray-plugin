'use strict';

// lib/parsers/html.js — HTML doc-site parser. Entry point for all HTML-based documentation scraping.
// cheerio is loaded ONLY here and in lib/parsers/html-strategies/*.js (import discipline enforced by no-cheerio-leak test).

const cheerio = require('cheerio');
const { HTMLParseError } = require('../errors');

const openApiRendered = require('./html-strategies/openapi-rendered');
const stripeSlate     = require('./html-strategies/stripe-slate');
const docusaurus      = require('./html-strategies/docusaurus');
const gitbook         = require('./html-strategies/gitbook');
const generic         = require('./html-strategies/generic');

const PARSER_NAME    = 'apifier-html-parser';
const PARSER_VERSION = '0.1.0';

/** Ordered list of named strategies (before generic fallback). */
const NAMED_STRATEGIES = [
  { id: 'stripe-slate', strategy: stripeSlate },
  { id: 'docusaurus',   strategy: docusaurus },
  { id: 'gitbook',      strategy: gitbook },
];

/**
 * Parse an HTML doc-site body into IR (or return a redirect signal for OpenAPI-rendered pages).
 *
 * Signature mirrors parseOpenAPI in lib/parsers/openapi.js.
 *
 * @param {object} opts
 * @param {string}      opts.body         - Raw HTML body string.
 * @param {string}      opts.content_type - MIME type hint from fetch.
 * @param {string|null} opts.source_url   - Original URL (for context and relative URL resolution).
 * @returns {Promise<{
 *   ir: object|null,
 *   warnings: string[],
 *   parser: {name: string, version: string},
 *   redirect_to_spec?: {url: string, source_archetype: string}
 * }>}
 */
async function parseHTML({ body, content_type, source_url }) {
  const warnings = [];
  const PARSER_META = { name: PARSER_NAME, version: PARSER_VERSION };
  const ctx = { source_url: source_url || null };

  // Refusal: empty or too short body.
  if (!body || typeof body !== 'string' || body.trim().length < 200) {
    throw new HTMLParseError('HTML body is empty or too short (under 200 bytes)');
  }

  // Load document with cheerio (single load site for the entire pipeline).
  let $;
  try {
    $ = cheerio.load(body, { decodeEntities: true });
  } catch (err) {
    throw new HTMLParseError(`cheerio.load failed: ${err.message}`);
  }

  // Step 1: Check for OpenAPI-rendered SPA viewers (redirect short-circuit).
  const redirectResult = openApiRendered.extractRedirect($, ctx);
  if (redirectResult) {
    return {
      ir: null,
      warnings: redirectResult.warnings || [],
      parser: PARSER_META,
      redirect_to_spec: {
        url: redirectResult.redirect_to_spec,
        source_archetype: redirectResult.source_archetype,
      },
    };
  }

  // Step 2: Try named strategies in order (first match wins).
  let strategyId = null;
  let extractResult = null;

  for (const { id, strategy } of NAMED_STRATEGIES) {
    if (strategy.matches($)) {
      strategyId = id;
      extractResult = strategy.extract($, ctx);
      break;
    }
  }

  // Step 3: Generic fallback (always tried per Q3 decision).
  if (!extractResult) {
    strategyId = 'generic';
    extractResult = generic.extract($, ctx);
  }

  const { ir, warnings: strategyWarnings } = extractResult;
  warnings.push(...(strategyWarnings || []));

  // Refusal: zero endpoints with both method AND path.
  const validEndpoints = (ir && ir.endpoints || []).filter(ep => ep.method && ep.path);
  if (validEndpoints.length === 0) {
    throw new HTMLParseError(
      `No endpoints with method+path found after trying strategies: ${NAMED_STRATEGIES.map(s => s.id).join(', ')}, generic`
    );
  }

  // Write archetype extension per Q5 decision.
  if (ir.extensions) {
    ir.extensions['x-html-archetype'] = strategyId;
  } else {
    ir.extensions = { 'x-html-archetype': strategyId };
  }

  // Emit version-not-detected warning if service version is a date placeholder.
  if (ir.service && ir.service.version && /^\d{4}-\d{2}-\d{2}$/.test(ir.service.version)) {
    warnings.push('low_confidence: service.version — not detected from page, using today\'s date');
  }

  return {
    ir,
    warnings,
    parser: PARSER_META,
  };
}

module.exports = { parseHTML, PARSER_NAME, PARSER_VERSION };
