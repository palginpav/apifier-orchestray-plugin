'use strict';

// lib/parsers/html-strategies/_common.js — Shared cheerio helpers for HTML parser strategies.

const HTTP_METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/\S*)/i;
const PARAM_TABLE_HEADER_RE = /name|parameter|type|description|required/i;

/**
 * Find code blocks in a cheerio document under an optional parent element.
 * Returns [{language, text}].
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio|null} parent
 * @returns {{language: string, text: string}[]}
 */
function findCodeBlocks($, parent) {
  const container = parent ? parent : $.root();
  const results = [];
  container.find('pre code, code[class]').each((_, el) => {
    const classes = ($(el).attr('class') || '').split(/\s+/);
    let language = '';
    for (const cls of classes) {
      const m = cls.match(/^language-(.+)$/) || cls.match(/^lang-(.+)$/);
      if (m) { language = m[1]; break; }
    }
    if (!language) {
      language = $(el).attr('data-lang') || $(el).closest('[data-lang]').attr('data-lang') || '';
    }
    results.push({ language, text: $(el).text() });
  });
  return results;
}

/**
 * Extract prose text under el until the next sibling heading of equal or higher rank.
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio} el
 * @returns {string}
 */
function extractAnchorText($, el) {
  const tagName = el.prop('tagName') || '';
  const rank = parseInt(tagName.replace(/[^0-9]/g, ''), 10) || 99;
  const parts = [];
  let sibling = el.next();
  while (sibling.length) {
    const tag = sibling.prop('tagName') || '';
    if (/^h[1-6]$/i.test(tag)) {
      const sibRank = parseInt(tag.replace(/[^0-9]/g, ''), 10);
      if (sibRank <= rank) break;
    }
    parts.push(sibling.text().trim());
    sibling = sibling.next();
  }
  return parts.join('\n').trim().slice(0, 5000);
}

/**
 * Parse "METHOD /path" style string into {method, path} or null.
 * @param {string} raw
 * @returns {{method: string, path: string}|null}
 */
function normaliseMethodPath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(HTTP_METHOD_RE);
  if (!m) return null;
  return { method: m[1].toUpperCase(), path: m[2] };
}

/**
 * Parse a parameter <table> element into Param[].
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio} table
 * @returns {object[]}
 */
function parseParameterTable($, table) {
  const rows = [];
  // Detect column indices from header row.
  const headers = [];
  table.find('th').each((_, th) => {
    headers.push($(th).text().trim().toLowerCase());
  });
  if (headers.length === 0) return [];

  const nameIdx    = headers.findIndex(h => /^name|^parameter/.test(h));
  const typeIdx    = headers.findIndex(h => /^type/.test(h));
  const descIdx    = headers.findIndex(h => /^description|^desc/.test(h));
  const reqIdx     = headers.findIndex(h => /^required|^req/.test(h));

  if (nameIdx < 0) return [];

  table.find('tr').each((_, tr) => {
    const cells = [];
    $(tr).find('td').each((_, td) => cells.push($(td).text().trim()));
    if (cells.length === 0) return;
    const name = cells[nameIdx] || '';
    if (!name) return;
    const type = typeIdx >= 0 ? cells[typeIdx] || 'string' : 'string';
    const description = descIdx >= 0 ? cells[descIdx] || null : null;
    const requiredRaw = reqIdx >= 0 ? cells[reqIdx] || '' : '';
    const required = /true|yes|required/i.test(requiredRaw);

    // Map type string to TypeRef primitive.
    const primitiveMap = { string: 'string', integer: 'integer', int: 'integer', number: 'number', boolean: 'boolean', bool: 'boolean', object: 'string' };
    const primitive = primitiveMap[type.toLowerCase()] || 'string';

    rows.push({
      name,
      type: { primitive },
      required,
      description,
      default: null,
      example: null,
      enum: null,
      format: null,
      deprecated: false,
      style: null,
      explode: null,
    });
  });
  return rows;
}

/**
 * Extract path param names from a path string, return default Param objects.
 * @param {string} pathStr
 * @returns {object[]}
 */
function inferPathParams(pathStr) {
  const matches = pathStr.match(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g) || [];
  return matches.map(m => {
    const name = m.slice(1, -1);
    return {
      name,
      type: { primitive: 'string' },
      required: true,
      description: null,
      default: null,
      example: null,
      enum: null,
      format: null,
      deprecated: false,
      style: null,
      explode: null,
    };
  });
}

/**
 * Derive a stable endpoint id from method + path (mirrors openapi.js _deriveId logic).
 * @param {string} method
 * @param {string} pathStr
 * @param {Set<string>} usedIds
 * @returns {string}
 */
function slugifyId(method, pathStr, usedIds) {
  const pathSlug = pathStr.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let base = method.toLowerCase() + '_' + pathSlug;
  if (!/^[A-Za-z]/.test(base)) base = 'op_' + base;
  base = base.slice(0, 128);

  let id = base;
  let suffix = 2;
  while (usedIds && usedIds.has(id)) {
    id = base.slice(0, 120) + '_' + suffix++;
  }
  if (usedIds) usedIds.add(id);
  return id;
}

/**
 * Determine idempotency from HTTP method (mirrors openapi.js).
 * @param {string} method uppercase
 * @returns {object}
 */
function idempotency(method) {
  const intrinsic = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'].includes(method.toUpperCase());
  return { method_intrinsic: intrinsic, header: null, description: null };
}

/**
 * Scan a cheerio document for auth mentions near auth-related headings.
 * Returns [{id, type, ...}] zero or more auth scheme objects.
 * @param {import('cheerio').CheerioAPI} $
 * @returns {object[]}
 */
function extractAuthMentions($) {
  const auth = [];
  const authHeadings = [];

  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    if (/authentication|authorization|auth/i.test($(el).text())) {
      authHeadings.push(el);
    }
  });

  for (const heading of authHeadings) {
    // Collect up to 500 chars of text in the section.
    const sectionText = extractAnchorText($, $(heading)).slice(0, 500);
    const combined = $(heading).text() + ' ' + sectionText;

    if (/bearer/i.test(combined) && /token/i.test(combined)) {
      if (!auth.find(a => a.id === 'bearer-auth')) {
        auth.push({ id: 'bearer-auth', type: 'http-bearer', description: 'Bearer token authentication' });
      }
    } else if (/api[\s-]?key/i.test(combined)) {
      if (!auth.find(a => a.id === 'api-key')) {
        auth.push({ id: 'api-key', type: 'api-key', in: 'header', name: 'X-API-Key', description: 'API key authentication' });
      }
    } else if (/oauth/i.test(combined)) {
      if (!auth.find(a => a.id === 'oauth2-cc')) {
        auth.push({ id: 'oauth2-cc', type: 'oauth2', flow: 'client_credentials', description: 'OAuth2 authentication' });
      }
    } else if (/basic/i.test(combined) && /auth/i.test(combined)) {
      if (!auth.find(a => a.id === 'basic-auth')) {
        auth.push({ id: 'basic-auth', type: 'http-basic', description: 'Basic authentication' });
      }
    }
  }

  return auth;
}

/**
 * Check if a heading element text matches an HTTP endpoint pattern.
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio} el
 * @returns {boolean}
 */
function headingMatchesEndpoint($, el) {
  return normaliseMethodPath($(el).text()) !== null;
}

/**
 * Normalise an HTTP method string to uppercase.
 * @param {string} s
 * @returns {string}
 */
function normalizeMethod(s) {
  return (s || '').toUpperCase().trim();
}

/**
 * Build a full endpoint object with all required IR fields.
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.method
 * @param {string} opts.path
 * @param {string|null} opts.summary
 * @param {string|null} opts.description
 * @param {object[]} opts.path_params
 * @param {object[]} opts.query_params
 * @param {object[]} opts.headers
 * @param {object[]} opts.cookies
 * @param {object|null} opts.body
 * @param {object} opts.responses
 * @param {string[]} opts.auth
 * @param {string} opts.source_url
 * @param {string} opts.selector
 * @returns {object}
 */
function buildEndpoint({ id, method, path, summary, description, path_params, query_params, headers, cookies, body, responses, auth, source_url, selector }) {
  return {
    id,
    transport: 'http',
    method,
    path,
    summary: summary || null,
    description: description || null,
    tags: [],
    path_params:  path_params  || [],
    query_params: query_params || [],
    headers:      headers      || [],
    cookies:      cookies      || [],
    body:         body         || null,
    responses:    responses    || {},
    error_codes:  [],
    auth:         auth         || [],
    idempotency:  idempotency(method),
    deprecated:   { is_deprecated: false, since: null, replacement_endpoint_id: null, sunset_at: null },
    pagination:   null,
    rate_limit:   null,
    examples:     [],
    'x-origin':   { html_selector: selector || '', source_url: source_url || '' },
  };
}

module.exports = {
  findCodeBlocks,
  extractAnchorText,
  normaliseMethodPath,
  parseParameterTable,
  inferPathParams,
  slugifyId,
  idempotency,
  extractAuthMentions,
  headingMatchesEndpoint,
  normalizeMethod,
  buildEndpoint,
  HTTP_METHOD_RE,
  PARAM_TABLE_HEADER_RE,
};
