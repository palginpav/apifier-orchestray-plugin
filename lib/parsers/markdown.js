'use strict';

// lib/parsers/markdown.js — Pure-regex Markdown -> IR parser. No external deps. Mirrors parseOpenAPI signature.

const { MarkdownParseError } = require('../errors');

const PARSER_NAME    = 'apifier-markdown-parser';
const PARSER_VERSION = '0.0.1';

// HTTP methods recognised in headings and code blocks (no nested quantifiers).
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// Pattern A: heading with bare method + path  e.g. "## GET /users/{id}"
// Pattern B: heading with backtick method + path  e.g. "## `GET /users/{id}`"
// These are tested line-by-line so anchoring at ^ is relative to the individual line.
const ENDPOINT_HEADING_A = /^(#{1,3})\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/i;
const ENDPOINT_HEADING_B = /^(#{1,3})\s+`(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)`/i;

// Fenced code block opening fence (three or more backticks with optional language tag).
// No nested quantifiers — safe from ReDoS.
const FENCE_OPEN  = /^(`{3,})(\w*)/;
const FENCE_CLOSE = /^(`{3,})/;

// Auth-related headings for whole-document scan.
const AUTH_HEADING_RE = /^#{1,4}\s+(Authentication|Authorization|API\s+Keys?|Bearer|OAuth)/i;

// Path param pattern: {paramName}
const PATH_PARAM_RE = /\{(\w+)\}/g;

// Markdown table row pattern (single regex, no nesting).
const TABLE_ROW_RE = /^\|(.+)\|$/;

/**
 * Determine idempotency from HTTP method (mirrors openapi.js).
 * @param {string} method uppercase
 * @returns {object}
 */
function _idempotency(method) {
  const intrinsic = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(method);
  return { method_intrinsic: intrinsic, header: null, description: null };
}

/**
 * Derive a stable endpoint id from method + path.
 * @param {string} method
 * @param {string} pathStr
 * @param {Set<string>} usedIds
 * @returns {string}
 */
function _slugifyId(method, pathStr, usedIds) {
  const pathSlug = pathStr.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let base = method.toLowerCase() + '_' + pathSlug;
  if (!/^[A-Za-z]/.test(base)) base = 'op_' + base;
  base = base.slice(0, 128);

  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = base.slice(0, 120) + '_' + suffix++;
  }
  usedIds.add(id);
  return id;
}

/**
 * Build a minimal Param object.
 * @param {string} name
 * @param {string|null} description
 * @param {boolean} required
 * @param {string} primitiveType
 * @returns {object}
 */
function _buildParam(name, description, required, primitiveType) {
  const primitiveMap = {
    string: 'string', integer: 'integer', int: 'integer',
    number: 'number', boolean: 'boolean', bool: 'boolean',
  };
  const primitive = primitiveMap[(primitiveType || '').toLowerCase()] || 'string';
  return {
    name,
    type:        { primitive },
    required:    Boolean(required),
    description: description || null,
    default:     null,
    example:     null,
    enum:        null,
    format:      null,
    deprecated:  false,
    style:       null,
    explode:     null,
  };
}

/**
 * Split document body into lines and find all fenced code blocks.
 * Returns an array of {startLine, endLine, language, content} objects.
 * @param {string[]} lines
 * @returns {Array<{startLine:number, endLine:number, language:string, content:string}>}
 */
function _findFencedBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const openMatch = lines[i].match(FENCE_OPEN);
    if (openMatch) {
      const fence = openMatch[1];        // the backtick sequence (```)
      const language = openMatch[2] || '';
      const startLine = i;
      const contentLines = [];
      i++;
      while (i < lines.length) {
        const closeMatch = lines[i].match(FENCE_CLOSE);
        if (closeMatch && closeMatch[1].length >= fence.length) {
          break;
        }
        contentLines.push(lines[i]);
        i++;
      }
      blocks.push({
        startLine,
        endLine:  i,
        language: language.toLowerCase(),
        content:  contentLines.join('\n'),
      });
    }
    i++;
  }
  return blocks;
}

/**
 * Parse a Markdown table section into rows.
 * Returns [{name, type, description, required, inQuery}] for matched table rows.
 * @param {string[]} lines
 * @param {number} start  first line index of the table
 * @returns {Array<{name:string, type:string, description:string, required:boolean, inQuery:boolean}>}
 */
function _parseMarkdownTable(lines, start) {
  const rows = [];
  // Read header row.
  if (start >= lines.length) return rows;
  const headerLine = lines[start];
  if (!TABLE_ROW_RE.test(headerLine)) return rows;

  const headers = headerLine.split('|').slice(1, -1).map(h => h.trim().toLowerCase());
  const nameIdx  = headers.findIndex(h => h === 'name' || h === 'parameter');
  const typeIdx  = headers.findIndex(h => h === 'type');
  const descIdx  = headers.findIndex(h => h === 'description' || h === 'desc');
  const reqIdx   = headers.findIndex(h => h === 'required' || h === 'req');
  const inIdx    = headers.findIndex(h => h === 'in' || h === 'location');

  if (nameIdx < 0) return rows;

  // Skip separator row.
  let lineIdx = start + 1;
  if (lineIdx < lines.length && /^\|[\s\-|]+\|$/.test(lines[lineIdx])) {
    lineIdx++;
  }

  while (lineIdx < lines.length && TABLE_ROW_RE.test(lines[lineIdx])) {
    const cells = lines[lineIdx].split('|').slice(1, -1).map(c => c.trim());
    const name  = nameIdx >= 0 ? (cells[nameIdx] || '') : '';
    if (name) {
      const type        = typeIdx >= 0 ? (cells[typeIdx] || 'string') : 'string';
      const description = descIdx >= 0 ? (cells[descIdx] || null) : null;
      const reqRaw      = reqIdx >= 0  ? (cells[reqIdx] || '')    : '';
      const required    = /true|yes|required/i.test(reqRaw);
      const inVal       = inIdx >= 0   ? (cells[inIdx] || '').toLowerCase() : '';
      rows.push({ name, type, description, required, inQuery: inVal === 'query' });
    }
    lineIdx++;
  }
  return rows;
}

/**
 * Detect auth scheme from text (mirrors HTML _common.js extractAuthMentions logic).
 * @param {string} text
 * @returns {string} 'http-bearer'|'api-key'|'http-basic'|'oauth2'|''
 */
function _detectAuthScheme(text) {
  if (/bearer/i.test(text))            return 'http-bearer';
  if (/api[\s-]?key/i.test(text))     return 'api-key';
  if (/oauth/i.test(text))             return 'oauth2';
  if (/basic/i.test(text))             return 'http-basic';
  return '';
}

/**
 * Build an auth scheme entry from scheme type.
 * @param {string} schemeType
 * @returns {object}
 */
function _buildAuthEntry(schemeType) {
  if (schemeType === 'http-bearer') {
    return { id: 'bearer-auth', type: 'http-bearer', description: 'Bearer token authentication', header_name: 'Authorization', scheme: 'Bearer' };
  }
  if (schemeType === 'api-key') {
    return { id: 'api-key', type: 'api-key', in: 'header', name: 'X-API-Key', description: 'API key authentication' };
  }
  if (schemeType === 'oauth2') {
    return { id: 'oauth2-cc', type: 'oauth2', flow: 'client_credentials', description: 'OAuth2 authentication' };
  }
  if (schemeType === 'http-basic') {
    return { id: 'basic-auth', type: 'http-basic', description: 'Basic authentication' };
  }
  return null;
}

/**
 * Scan the whole document for auth-related headings and extract scheme entries.
 * @param {string[]} lines
 * @returns {object[]}
 */
function _extractAuth(lines) {
  const auth = [];
  const seenIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (!AUTH_HEADING_RE.test(lines[i])) continue;

    // Collect up to 10 lines of section text after the heading.
    const sectionLines = [];
    for (let j = i + 1; j < lines.length && j <= i + 10; j++) {
      if (/^#{1,4}\s/.test(lines[j])) break;
      sectionLines.push(lines[j]);
    }
    const combined = lines[i] + ' ' + sectionLines.join(' ');
    const schemeType = _detectAuthScheme(combined);
    if (schemeType) {
      const entry = _buildAuthEntry(schemeType);
      if (entry && !seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        auth.push(entry);
      }
    }
  }
  return auth;
}

/**
 * Parse an endpoint section (array of lines) and enrich an endpoint object.
 * @param {object} endpoint  mutable endpoint object
 * @param {string[]} lines   lines in the section (excluding the heading line)
 * @param {Array<{startLine:number, endLine:number, language:string, content:string}>} allBlocks
 * @param {number} sectionOffset  line index of the FIRST line of the section body
 * @param {string[]} warnings  mutable
 */
function _parseEndpointSection(endpoint, sectionLines, allBlocks, sectionLineOffset, warnings) {
  // Locate path params from the path itself.
  const pathParamNames = new Set();
  const pathParamMatches = endpoint.path.match(PATH_PARAM_RE) || [];
  for (const m of pathParamMatches) {
    pathParamNames.add(m.slice(1, -1));
  }

  // Sub-heading patterns for body/response/query sections.
  const BODY_H3_RE    = /^#{3,4}\s+(Request|Body|Payload)/i;
  const RESPONSE_H3_RE = /^#{3,4}\s+(Response|Returns|Example\s+response)/i;
  const PARAMS_H3_RE  = /^#{3,4}\s+(Parameters?|Path\s+Parameters?)/i;
  const QUERY_H3_RE   = /^#{3,4}\s+(Query\s+Parameters?)/i;
  const CURL_H3_RE    = /^#{3,4}\s+(curl|Example\s+request|Request\s+example)/i;

  // Map each code block's startLine to blocks array index for quick lookup.
  // We work with sectionLineOffset to translate absolute→section indices.
  const blocksInSection = allBlocks.filter(
    b => b.startLine >= sectionLineOffset && b.startLine < sectionLineOffset + sectionLines.length
  );

  // Track which sub-section we are in.
  let currentSubsection = null;
  let responseHeadingText = '';
  let responseBlocksCount = 0;

  // Build path_params from path variable extraction first (default, no description).
  const pathParamMap = new Map();
  for (const pn of pathParamNames) {
    pathParamMap.set(pn, _buildParam(pn, null, true, 'string'));
  }

  // Track query_params separately; merge tables.
  const queryParamMap = new Map();

  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    const absLine = sectionLineOffset + i;

    // Check sub-heading changes.
    if (/^#{3,4}\s/.test(line)) {
      if (PARAMS_H3_RE.test(line)) {
        currentSubsection = 'params';
      } else if (QUERY_H3_RE.test(line)) {
        currentSubsection = 'query';
      } else if (BODY_H3_RE.test(line)) {
        currentSubsection = 'body';
      } else if (RESPONSE_H3_RE.test(line)) {
        currentSubsection = 'response';
        responseHeadingText = line;
      } else if (CURL_H3_RE.test(line)) {
        currentSubsection = 'curl';
      } else {
        currentSubsection = null;
      }
      continue;
    }

    // Parse Markdown tables.
    if (TABLE_ROW_RE.test(line)) {
      const tableRows = _parseMarkdownTable(sectionLines, i);
      if (tableRows.length > 0) {
        if (currentSubsection === 'query') {
          for (const row of tableRows) {
            queryParamMap.set(row.name, _buildParam(row.name, row.description, row.required, row.type));
          }
        } else if (currentSubsection === 'params') {
          for (const row of tableRows) {
            // Enrich path params OR treat as query params if not in path.
            if (pathParamMap.has(row.name)) {
              pathParamMap.set(row.name, _buildParam(row.name, row.description, row.required, row.type));
            } else if (row.inQuery) {
              queryParamMap.set(row.name, _buildParam(row.name, row.description, row.required, row.type));
            } else {
              // Name not in path and not explicitly query — default to query unless path.
              if (!pathParamNames.has(row.name)) {
                queryParamMap.set(row.name, _buildParam(row.name, row.description, row.required, row.type));
              }
            }
          }
        } else {
          // Unlabelled table — guess from header content.
          const headerLine = sectionLines[i];
          const isQueryTable = /query/i.test(headerLine);
          for (const row of tableRows) {
            if (isQueryTable || (row.inQuery && !pathParamNames.has(row.name))) {
              queryParamMap.set(row.name, _buildParam(row.name, row.description, row.required, row.type));
            } else if (pathParamMap.has(row.name)) {
              pathParamMap.set(row.name, _buildParam(row.name, row.description, row.required, row.type));
            } else if (!pathParamNames.has(row.name)) {
              queryParamMap.set(row.name, _buildParam(row.name, row.description, row.required, row.type));
            }
          }
        }
        // Skip past the table lines we just parsed.
        let skip = i + 1;
        while (skip < sectionLines.length && TABLE_ROW_RE.test(sectionLines[skip])) skip++;
        i = skip - 1;
      }
      continue;
    }
  }

  // Apply path params (warn on any that have no table row).
  for (const [pn, param] of pathParamMap) {
    if (!param.description) {
      warnings.push(`incomplete_parameters: path param {${pn}} in ${endpoint.method} ${endpoint.path} has no matching table row`);
    }
  }
  endpoint.path_params  = Array.from(pathParamMap.values());
  endpoint.query_params = Array.from(queryParamMap.values());

  // Process code blocks in the section.
  for (const block of blocksInSection) {
    const relLine = block.startLine - sectionLineOffset;
    // Identify which sub-section this block falls under.
    let blockSubsection = null;
    for (let k = relLine - 1; k >= 0; k--) {
      if (/^#{3,4}\s/.test(sectionLines[k])) {
        if (BODY_H3_RE.test(sectionLines[k]))     { blockSubsection = 'body'; break; }
        if (RESPONSE_H3_RE.test(sectionLines[k])) { blockSubsection = 'response'; break; }
        if (CURL_H3_RE.test(sectionLines[k]))     { blockSubsection = 'curl'; break; }
        if (PARAMS_H3_RE.test(sectionLines[k]))   { blockSubsection = null; break; }
        if (QUERY_H3_RE.test(sectionLines[k]))    { blockSubsection = null; break; }
        break;
      }
    }

    const isJson = (block.language === 'json' || block.language === '') &&
                   /^\s*[\[{]/.test(block.content);
    const isBash = ['bash', 'shell', 'curl'].includes(block.language);

    if (blockSubsection === 'body' && isJson && !endpoint.body) {
      // Per locked Q4: store raw JSON sample as text in extensions; schema collapses to string.
      endpoint.body = {
        required:     true,
        content_type: 'application/json',
        schema:       { primitive: 'string' },
        encoding:     null,
      };
      if (!endpoint.extensions) endpoint.extensions = {};
      endpoint.extensions['x-body-example'] = block.content.trim();
    } else if (blockSubsection === 'response' || (blockSubsection === null && isJson)) {
      // Determine status code from heading text.
      let status = '200';
      const statusMatch = responseHeadingText.match(/(\d{3})/);
      if (statusMatch) status = statusMatch[1];

      if (!endpoint.responses[status]) {
        // description must be string (not null) per schema; use undefined when unknown.
        endpoint.responses[status] = {
          content_type: 'application/json',
          schema:       { primitive: 'string' },
          headers:      [],
        };
        // Store the raw example text in extensions per Q4.
        if (!endpoint.extensions) endpoint.extensions = {};
        const exKey = `x-response-example-${status}`;
        if (!endpoint.extensions[exKey]) {
          endpoint.extensions[exKey] = block.content.trim();
        }
        responseBlocksCount++;
        if (responseBlocksCount > 3) {
          warnings.push(`multiple_response_examples_under_same_heading: ${endpoint.method} ${endpoint.path} has >3 response code blocks`);
        }
      }
    } else if (isBash) {
      // Store curl example in extensions.
      if (!endpoint.extensions) endpoint.extensions = {};
      if (!endpoint.extensions['x-curl-example']) {
        endpoint.extensions['x-curl-example'] = block.content.trim();
      }
    }
  }
}

/**
 * Parse a Markdown document into IR.
 *
 * @param {object} params
 * @param {string}       params.body          - Raw Markdown body.
 * @param {string}       params.content_type  - MIME type hint.
 * @param {string|null}  params.source_url    - Original URL or file path.
 * @returns {Promise<{ ir: object, warnings: string[], parser: {name:string,version:string} }>}
 */
async function parseMarkdown({ body, content_type, source_url }) {
  const warnings = [];

  // Early refusal: body too short.
  if (!body || typeof body !== 'string' || body.length < 50) {
    throw new MarkdownParseError('Markdown body is too short (under 50 bytes)');
  }

  // Split into lines for processing.
  const lines = body.split('\n');

  // Early refusal: no fenced code blocks AND no bare endpoint heading lines.
  const hasFencedBlock = lines.some(l => FENCE_OPEN.test(l));
  const hasEndpointHeading = lines.some(l => ENDPOINT_HEADING_A.test(l) || ENDPOINT_HEADING_B.test(l));
  // Also check for Pattern C: bare HTTP method lines (used in refusal check only).
  const hasPatternC = lines.some(l => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S/.test(l));

  if (!hasFencedBlock && !hasEndpointHeading && !hasPatternC) {
    throw new MarkdownParseError('Markdown body has no fenced code blocks and no endpoint heading lines');
  }

  // Extract top-level service title (first # heading) and description (first paragraph after).
  let serviceDisplayName = null;
  let serviceDescription = null;
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('# ')) i++;
  if (i < lines.length) {
    serviceDisplayName = lines[i].replace(/^#\s+/, '').trim();
    i++;
    // Collect first non-empty paragraph.
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i < lines.length && !/^#{1,6}\s/.test(lines[i]) && !FENCE_OPEN.test(lines[i])) {
      const descLines = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^#{1,6}\s/.test(lines[i])) {
        descLines.push(lines[i]);
        i++;
      }
      serviceDescription = descLines.join(' ').trim().slice(0, 500) || null;
    }
  }

  // Derive a service name slug.
  let serviceName = 'unknown';
  if (serviceDisplayName) {
    serviceName = serviceDisplayName.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63) || 'unknown';
  } else if (source_url) {
    try {
      const u = new URL(source_url);
      serviceName = u.hostname.replace(/\./g, '-').slice(0, 63);
    } catch (_) {
      // file path — use basename
      const base = require('path').basename(source_url, '.md').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      serviceName = base.slice(0, 63) || 'unknown';
    }
  }

  // Find all fenced code blocks for later use (single pass).
  const allBlocks = _findFencedBlocks(lines);

  // Extract auth from whole document.
  const auth = _extractAuth(lines);

  // Find all endpoint headings (Pattern A and B). Record their line index and properties.
  const endpointHeadings = [];
  for (let j = 0; j < lines.length; j++) {
    const lineA = lines[j].match(ENDPOINT_HEADING_A);
    if (lineA) {
      endpointHeadings.push({ lineIdx: j, method: lineA[2].toUpperCase(), path: lineA[3], pattern: 'A' });
      continue;
    }
    const lineB = lines[j].match(ENDPOINT_HEADING_B);
    if (lineB) {
      endpointHeadings.push({ lineIdx: j, method: lineB[2].toUpperCase(), path: lineB[3], pattern: 'B' });
    }
  }

  // Pattern C: bare code lines inside fenced blocks (medium confidence).
  const PATTERN_C_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/;
  for (const block of allBlocks) {
    // Only check first non-empty line in the block at the top of a section.
    const firstContentLine = block.content.split('\n').find(l => l.trim() !== '');
    if (!firstContentLine) continue;
    const mC = firstContentLine.match(PATTERN_C_RE);
    if (!mC) continue;
    // Check if this block is already associated with an existing endpoint heading section.
    const alreadyCovered = endpointHeadings.some(eh => {
      const nextEh = endpointHeadings.find(e => e.lineIdx > eh.lineIdx);
      return block.startLine > eh.lineIdx && (!nextEh || block.startLine < nextEh.lineIdx);
    });
    if (!alreadyCovered) {
      endpointHeadings.push({ lineIdx: block.startLine, method: mC[1].toUpperCase(), path: mC[2], pattern: 'C' });
      warnings.push(`low_confidence: Pattern C endpoint detected: ${mC[1].toUpperCase()} ${mC[2]}`);
    }
  }

  // Sort headings by line number.
  endpointHeadings.sort((a, b) => a.lineIdx - b.lineIdx);

  if (endpointHeadings.length === 0) {
    throw new MarkdownParseError('No endpoint headings found in Markdown body');
  }

  // Build endpoints.
  const usedIds = new Set();
  const endpoints = [];

  for (let k = 0; k < endpointHeadings.length; k++) {
    const eh = endpointHeadings[k];
    const nextEh = endpointHeadings[k + 1];
    const sectionStart = eh.lineIdx + 1;
    const sectionEnd   = nextEh ? nextEh.lineIdx : lines.length;
    const sectionLines = lines.slice(sectionStart, sectionEnd);

    const id = _slugifyId(eh.method, eh.path, usedIds);

    const endpoint = {
      id,
      transport:    'http',
      method:       eh.method,
      path:         eh.path,
      summary:      null,
      description:  null,
      tags:         [],
      path_params:  [],
      query_params: [],
      headers:      [],
      cookies:      [],
      body:         null,
      responses:    {},
      error_codes:  [],
      auth:         auth.length > 0 ? [auth[0].id] : [],
      idempotency:  _idempotency(eh.method),
      deprecated:   { is_deprecated: false, since: null, replacement_endpoint_id: null, sunset_at: null },
      pagination:   null,
      rate_limit:   null,
      examples:     [],
      'x-origin':   { source_url: source_url || null, line: eh.lineIdx + 1 },
    };

    // First non-empty, non-heading, non-table, non-fence line → summary.
    for (const sl of sectionLines) {
      if (sl.trim() === '') continue;
      if (/^#{1,6}\s/.test(sl)) break;
      if (TABLE_ROW_RE.test(sl)) break;
      if (FENCE_OPEN.test(sl)) break;
      endpoint.summary = sl.trim().slice(0, 200);
      break;
    }

    _parseEndpointSection(endpoint, sectionLines, allBlocks, sectionStart, warnings);
    endpoints.push(endpoint);
  }

  // Build IR.
  const ir = {
    service: {
      name:         serviceName,
      display_name: serviceDisplayName || undefined,
      version:      '0.0.0',
      summary:      serviceDescription || undefined,
    },
    servers:    [],
    endpoints,
    models:     [],
    auth,
    errors:     [],
    examples:   [],
    extensions: { 'x-source-format': 'markdown' },
  };

  return {
    ir,
    warnings,
    parser: { name: PARSER_NAME, version: PARSER_VERSION },
  };
}

module.exports = { parseMarkdown, PARSER_NAME, PARSER_VERSION };
