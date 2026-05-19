'use strict';

// lib/parsers/graphql-sdl.js — GraphQL SDL → apifier mapping IR. Pure JS, no external deps.

const path = require('node:path');
const { GraphQLParseError } = require('../errors');

const PARSER_NAME    = 'apifier-graphql-sdl-parser';
const PARSER_VERSION = '0.0.1';

// Built-in scalar → IR primitive mapping (no nested quantifiers — ReDoS safe).
const BUILTIN_SCALARS = {
  String:  'string',
  ID:      'string',
  Int:     'integer',
  Float:   'number',
  Boolean: 'boolean',
};

// ---------------------------------------------------------------------------
// Comment stripping + block description extraction
// ---------------------------------------------------------------------------

/**
 * Extract block descriptions and strip line comments from SDL text.
 * Block descriptions ("""...""") are preserved as metadata.
 * Returns { stripped: string, blockDescriptions: Map<number, string> }
 * where blockDescriptions maps the byte-offset after the description to the text.
 *
 * Strategy: do a single linear pass, character-by-character.
 * No regex with nested quantifiers — ReDoS safe.
 *
 * @param {string} sdl
 * @returns {{ stripped: string, descriptionMap: Map<number, string> }}
 */
function _stripComments(sdl) {
  const result = [];
  // Map: stripped-output-position → description text.
  // Key is the index in `result` array at the time the description ends.
  const descriptionMap = new Map();
  let i = 0;
  const len = sdl.length;

  while (i < len) {
    // Triple-quote block description ("""...""").
    if (sdl[i] === '"' && sdl[i + 1] === '"' && sdl[i + 2] === '"') {
      i += 3;
      const descStart = i;
      // Scan forward until we find the matching """.
      while (i < len) {
        if (sdl[i] === '"' && sdl[i + 1] === '"' && sdl[i + 2] === '"') {
          break;
        }
        i++;
      }
      const descText = sdl.slice(descStart, i).trim();
      i += 3; // skip closing """
      // Store the description keyed to current output position.
      descriptionMap.set(result.length, descText);
      // Replace the whole block with a single space to preserve token separation.
      result.push(' ');
      continue;
    }

    // Hash line comment — drop from current position to end of line.
    if (sdl[i] === '#') {
      while (i < len && sdl[i] !== '\n') i++;
      continue;
    }

    result.push(sdl[i]);
    i++;
  }

  return { stripped: result.join(''), descriptionMap };
}

// ---------------------------------------------------------------------------
// Tokeniser — split SDL into top-level declarations
// ---------------------------------------------------------------------------

/**
 * Find top-level declarations in stripped SDL text.
 * Each declaration starts at a keyword (type, input, interface, union, enum, scalar, schema, extend)
 * and ends at the matching closing brace (or end of line for scalar).
 *
 * Returns array of { keyword, name, body, fullText }.
 *
 * @param {string} stripped
 * @returns {Array<{keyword:string, name:string, body:string, start:number, end:number}>}
 */
function _tokeniseDeclarations(stripped) {
  const declarations = [];
  // Matches top-level keyword at the beginning of a word boundary.
  // Split by known keywords followed by whitespace + identifier.
  // We walk character-by-character to handle brace depth properly.
  const len = stripped.length;
  let i = 0;

  // Keywords that start declarations.
  const KEYWORDS = ['extend', 'schema', 'scalar', 'interface', 'union', 'input', 'enum', 'type'];

  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(stripped[i])) i++;
    if (i >= len) break;

    // Check if we are at a keyword.
    let matched = null;
    for (const kw of KEYWORDS) {
      if (stripped.slice(i, i + kw.length) === kw &&
          (i + kw.length >= len || /[\s{(]/.test(stripped[i + kw.length]))) {
        matched = kw;
        break;
      }
    }

    if (!matched) {
      // Not a keyword — skip to next whitespace or word boundary.
      while (i < len && !/\s/.test(stripped[i])) i++;
      continue;
    }

    const declStart = i;
    i += matched.length;

    // Skip whitespace after keyword.
    while (i < len && stripped[i] === ' ' || (i < len && stripped[i] === '\t')) i++;

    // For 'extend', consume 'type'/'interface' subkeyword if present.
    let keyword = matched;
    if (matched === 'extend') {
      for (const subkw of ['type', 'interface', 'input', 'enum']) {
        if (stripped.slice(i, i + subkw.length) === subkw &&
            (i + subkw.length >= len || /\s/.test(stripped[i + subkw.length]))) {
          keyword = 'extend_' + subkw;
          i += subkw.length;
          // Skip whitespace.
          while (i < len && /[ \t]/.test(stripped[i])) i++;
          break;
        }
      }
    }

    // Read the declaration name (identifier).
    let name = '';
    while (i < len && /[A-Za-z0-9_]/.test(stripped[i])) {
      name += stripped[i++];
    }

    // `schema` blocks have no name — treat as name='schema'.
    if (!name && matched === 'schema') {
      name = 'schema';
    } else if (!name) {
      // Malformed — skip line.
      while (i < len && stripped[i] !== '\n') i++;
      continue;
    }

    // Skip whitespace / implements clause.
    while (i < len && stripped[i] !== '{' && stripped[i] !== '\n' && stripped[i] !== '#') {
      i++;
    }

    // Scalar declarations have no body.
    if (matched === 'scalar') {
      declarations.push({ keyword: 'scalar', name, body: '', start: declStart, end: i });
      continue;
    }

    // Union: `union X = A | B | C` — parse until end of line.
    if (matched === 'union') {
      let unionBody = '';
      // Skip '=' sign.
      while (i < len && stripped[i] !== '=' && stripped[i] !== '\n') i++;
      if (i < len && stripped[i] === '=') {
        i++; // skip '='
        while (i < len && stripped[i] !== '\n' && stripped[i] !== '{') {
          unionBody += stripped[i++];
        }
      }
      declarations.push({ keyword: 'union', name, body: unionBody.trim(), start: declStart, end: i });
      continue;
    }

    // For other keywords, scan to the opening brace then track depth.
    if (i < len && stripped[i] === '{') {
      let depth = 1;
      i++; // skip opening brace
      const bodyStart = i;
      while (i < len && depth > 0) {
        if (stripped[i] === '{') depth++;
        else if (stripped[i] === '}') depth--;
        if (depth > 0) i++;
        else i++;
      }
      const body = stripped.slice(bodyStart, i - 1);
      declarations.push({ keyword, name, body, start: declStart, end: i });
    }
  }

  return declarations;
}

// ---------------------------------------------------------------------------
// Type reference parser
// ---------------------------------------------------------------------------

/**
 * Parse a GraphQL type expression into an IR TypeRef.
 * e.g. "String!" → { primitive: 'string' }
 *      "[Widget!]!" → { array: { $ref: 'Widget' } }
 *
 * @param {string} typeExpr  trimmed type expression
 * @param {Set<string>} customScalars  known custom scalar names
 * @returns {{ typeRef: object, required: boolean }}
 */
function _parseTypeExpr(typeExpr, customScalars) {
  const expr = typeExpr.trim();
  const required = expr.endsWith('!');
  const inner = required ? expr.slice(0, -1) : expr;

  // Array type: [T] or [T!]
  if (inner.startsWith('[') && inner.endsWith(']')) {
    const elementExpr = inner.slice(1, -1);
    const { typeRef: elementRef } = _parseTypeExpr(elementExpr, customScalars);
    return { typeRef: { array: elementRef }, required };
  }

  // Scalar / named type
  const typeName = inner.trim();
  if (BUILTIN_SCALARS[typeName]) {
    return { typeRef: { primitive: BUILTIN_SCALARS[typeName] }, required };
  }
  // Custom scalar → $ref
  return { typeRef: { $ref: typeName }, required };
}

// ---------------------------------------------------------------------------
// Field parser — parse `fieldName(args...): ReturnType @directives...`
// ---------------------------------------------------------------------------

/**
 * Parse a single field line from a type body.
 * Returns null for non-field lines (empty, directives, etc.).
 *
 * @param {string} line
 * @param {Set<string>} customScalars
 * @returns {object|null}
 */
function _parseField(line, customScalars) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Match field name (possibly with args) and return type.
  // Pattern: `fieldName[(args)]: TypeExpr [@directives]`
  // We need to handle args that may span the args section.
  // Since we receive a single logical field line, args are on the same line.

  // Find field name.
  const nameMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!nameMatch) return null;

  const fieldName = nameMatch[1];
  let rest = trimmed.slice(fieldName.length).trimStart();

  // Parse arguments if present — find matching closing paren.
  const args = [];
  if (rest.startsWith('(')) {
    const closeIdx = rest.indexOf(')');
    if (closeIdx < 0) return null; // malformed
    const argsStr = rest.slice(1, closeIdx);
    rest = rest.slice(closeIdx + 1).trimStart();
    // Parse individual args: `name: Type [= default]` separated by commas.
    // Args may also have descriptions but we handle those later.
    const argParts = argsStr.split(',');
    for (const ap of argParts) {
      const argTrimmed = ap.trim();
      if (!argTrimmed) continue;
      const argMatch = argTrimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^\s=![\]A-Za-z0-9_]*[^\s=]*(?:!?|\]!?))\s*(?:=\s*(.+))?$/);
      if (argMatch) {
        const argName = argMatch[1];
        const argTypeRaw = argMatch[2];
        const argDefault = argMatch[3] !== undefined ? argMatch[3].trim() : null;
        const { typeRef: argType, required: argRequired } = _parseTypeExpr(argTypeRaw, customScalars);
        args.push({
          name:        argName,
          type:        argType,
          required:    argRequired,
          description: null,
          default:     argDefault !== null ? _parseDefaultValue(argDefault) : null,
          example:     null,
          enum:        null,
          format:      null,
          deprecated:  false,
          style:       null,
          explode:     null,
        });
      } else {
        // Simpler fallback: just get name: type.
        const simpleMatch = argTrimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S+)/);
        if (simpleMatch) {
          const argName = simpleMatch[1];
          const argTypeRaw = simpleMatch[2];
          const { typeRef: argType, required: argRequired } = _parseTypeExpr(argTypeRaw, customScalars);
          args.push({
            name:        argName,
            type:        argType,
            required:    argRequired,
            description: null,
            default:     null,
            example:     null,
            enum:        null,
            format:      null,
            deprecated:  false,
            style:       null,
            explode:     null,
          });
        }
      }
    }
  }

  // Expect `:` for return type.
  if (!rest.startsWith(':')) return null;
  rest = rest.slice(1).trimStart();

  // Extract return type (before any @directive).
  // Type ends at whitespace followed by @ or end of string.
  const typeEnd = rest.search(/\s+@|\s*$/);
  const typeExprStr = typeEnd >= 0 ? rest.slice(0, typeEnd) : rest;
  rest = typeEnd >= 0 ? rest.slice(typeEnd).trimStart() : '';

  if (!typeExprStr) return null;

  const { typeRef: returnType, required: isRequired } = _parseTypeExpr(typeExprStr.trim(), customScalars);

  // Check for @deprecated directive.
  let deprecated = null;
  const deprecatedMatch = rest.match(/@deprecated(?:\(reason:\s*"([^"]*)"\))?/);
  if (deprecatedMatch) {
    deprecated = {
      is_deprecated:           true,
      reason:                  deprecatedMatch[1] || '',
      since:                   null,
      replacement_endpoint_id: null,
      sunset_at:               null,
    };
  }

  // Check for other directives (to emit warnings).
  const otherDirectives = [];
  const directiveRe = /@([A-Za-z_][A-Za-z0-9_]*)/g;
  let dm;
  while ((dm = directiveRe.exec(rest)) !== null) {
    if (dm[1] !== 'deprecated') {
      otherDirectives.push(dm[1]);
    }
  }

  return {
    name:           fieldName,
    type:           returnType,
    required:       isRequired,
    args,
    deprecated,
    otherDirectives,
  };
}

/**
 * Parse a GraphQL default value string to a JS primitive.
 * @param {string} raw
 * @returns {*}
 */
function _parseDefaultValue(raw) {
  const t = raw.trim();
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  const n = Number(t);
  if (!isNaN(n) && t !== '') return n;
  // Quoted string.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  // Enum value or other literal — keep as string.
  return t;
}

/**
 * Parse body of a type/input/interface declaration into fields.
 * Handles multi-line argument lists by pre-joining continuation lines.
 *
 * @param {string} body
 * @param {Set<string>} customScalars
 * @returns {object[]}
 */
function _parseTypeBody(body, customScalars) {
  // Normalise: collapse multi-line argument lists into single lines.
  // A line ending before ')' has been split — rejoin by scanning for unmatched parens.
  const rawLines = body.split('\n');
  const joinedLines = [];
  let pending = '';

  for (const line of rawLines) {
    const combined = pending ? pending + ' ' + line.trim() : line;
    // Count open/close parens.
    let depth = 0;
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === '(') depth++;
      else if (combined[i] === ')') depth--;
    }
    if (depth > 0) {
      // More opens than closes — args span multiple lines.
      pending = combined;
    } else {
      joinedLines.push(combined);
      pending = '';
    }
  }
  if (pending) joinedLines.push(pending);

  const fields = [];
  for (const line of joinedLines) {
    const field = _parseField(line, customScalars);
    if (field) fields.push(field);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Slug / ID helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable endpoint id from root type + field name.
 * Convention: lowercase snake_case of `<rootType>_<fieldName>`.
 * @param {string} rootType  'query'|'mutation'|'subscription'
 * @param {string} fieldName
 * @param {Set<string>} usedIds
 * @returns {string}
 */
function _deriveEndpointId(rootType, fieldName, usedIds) {
  let base = (rootType + '_' + fieldName).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 128);
  if (!/^[A-Za-z]/.test(base)) base = 'op_' + base.slice(0, 124);
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = base.slice(0, 120) + '_' + suffix++;
  }
  usedIds.add(id);
  return id;
}

/**
 * Derive a service slug from a display name or source URL.
 * @param {string|null} displayName
 * @param {string|null} sourceUrl
 * @returns {string}
 */
function _deriveServiceSlug(displayName, sourceUrl) {
  if (displayName) {
    const s = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
    if (s) return s;
  }
  if (sourceUrl) {
    try {
      const u = new URL(sourceUrl);
      const slug = u.hostname.replace(/\./g, '-').slice(0, 63);
      if (slug) return slug;
    } catch (_) {
      // File path.
      const base = path.basename(sourceUrl).replace(/\.(graphqls?|sdl)$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const slug = base.replace(/^-+|-+$/g, '').slice(0, 63);
      if (slug) return slug;
    }
  }
  return 'graphql-service';
}

// ---------------------------------------------------------------------------
// Build model from declaration
// ---------------------------------------------------------------------------

/**
 * Build an IR model entry from a parsed declaration.
 * @param {object} decl
 * @param {Set<string>} customScalars
 * @param {string[]} warnings mutable
 * @returns {object|null}
 */
function _buildModel(decl, customScalars, warnings) {
  const { keyword, name, body } = decl;

  if (keyword === 'scalar') {
    // Custom scalar → alias model coerced to string.
    warnings.push(`scalar_coerced_to_string: ${name}`);
    return {
      name,
      kind:   'alias',
      description: `Custom scalar ${name} (coerced to string by apifier)`,
      fields: [{ name: 'value', type: { primitive: 'string' }, required: true }],
    };
  }

  if (keyword === 'union') {
    // Parse union members: "A | B | C"
    const members = body.split('|').map(m => m.trim()).filter(Boolean);
    return {
      name,
      kind:   'union',
      fields: members.map(m => ({ name: m, type: { $ref: m }, required: false })),
    };
  }

  if (keyword === 'enum') {
    // Enum values: parse body for identifiers.
    const values = body.split(/[\s,]+/).map(v => v.trim()).filter(v => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v));
    return {
      name,
      kind:   'enum',
      fields: values.map(v => ({ name: v, type: { primitive: 'string' }, required: false })),
    };
  }

  if (keyword === 'interface') {
    // Treat as object with a warning.
    warnings.push(`interface_flattened: ${name}`);
    const rawFields = _parseTypeBody(body, customScalars);
    const modelFields = rawFields.map(f => ({
      name:        f.name,
      type:        f.type,
      required:    f.required,
      description: f.description || undefined,
      deprecated:  f.deprecated ? f.deprecated.is_deprecated : undefined,
    }));
    return {
      name,
      kind:   'object',
      fields: modelFields,
    };
  }

  if (keyword === 'input') {
    const rawFields = _parseTypeBody(body, customScalars);
    const modelFields = rawFields.map(f => ({
      name:        f.name,
      type:        f.type,
      required:    f.required,
      description: f.description || undefined,
    }));
    return {
      name,
      kind:       'object',
      fields:     modelFields,
      extensions: { 'x-graphql-kind': 'input' },
    };
  }

  if (keyword === 'type' || keyword === 'extend_type') {
    const rawFields = _parseTypeBody(body, customScalars);
    const modelFields = rawFields.map(f => ({
      name:        f.name,
      type:        f.type,
      required:    f.required,
      description: f.description || undefined,
      deprecated:  f.deprecated ? f.deprecated.is_deprecated : undefined,
    }));
    return {
      name,
      kind:   'object',
      fields: modelFields,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parse schema { ... } block to find root type names
// ---------------------------------------------------------------------------

/**
 * Parse a `schema { ... }` body to extract custom root type names.
 * Returns { query, mutation, subscription } defaulting to conventional names.
 * @param {string} body
 * @returns {{ query: string, mutation: string, subscription: string }}
 */
function _parseSchemaBlock(body) {
  const result = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };
  const lines = body.split('\n');
  for (const line of lines) {
    const m = line.trim().match(/^(query|mutation|subscription)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) {
      result[m[1]] = m[2];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Extract top-level description for service display name
// ---------------------------------------------------------------------------

/**
 * Extract the first block description from the description map.
 * Returns null if none.
 * @param {Map<number, string>} descriptionMap
 * @returns {string|null}
 */
function _extractServiceDescription(descriptionMap) {
  if (descriptionMap.size === 0) return null;
  // The first entry in iteration order is the earliest description.
  const [, text] = descriptionMap.entries().next().value;
  return text || null;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse GraphQL Schema Definition Language (SDL) text into an apifier mapping IR.
 * Mirrors parseOpenAPI / parseHTML / parseMarkdown / parsePostman signature.
 *
 * @param {object} params
 * @param {string} params.body
 * @param {string} params.content_type
 * @param {string|null} params.source_url
 * @returns {Promise<{ ir: object, warnings: string[], parser: {name:string,version:string} }>}
 */
async function parseGraphQLSDL({ body, content_type, source_url }) {
  const warnings = [];

  // Early refusal: body too small.
  if (!body || typeof body !== 'string' || body.length < 30) {
    throw new GraphQLParseError('GraphQL SDL body is too short (under 30 bytes)');
  }

  // Early refusal: no recognisable root type or schema block.
  const hasRoots = /type\s+Query[\s{]/i.test(body) ||
                   /type\s+Mutation[\s{]/i.test(body) ||
                   /type\s+Subscription[\s{]/i.test(body) ||
                   /schema\s*\{/.test(body) ||
                   /extend\s+type\s+Query[\s{]/i.test(body) ||
                   /extend\s+type\s+Mutation[\s{]/i.test(body) ||
                   /extend\s+type\s+Subscription[\s{]/i.test(body);

  if (!hasRoots) {
    throw new GraphQLParseError(
      'GraphQL SDL body has no recognisable root types (type Query / type Mutation / type Subscription / schema { ... })'
    );
  }

  // Strip comments and extract block descriptions.
  const { stripped, descriptionMap } = _stripComments(body);

  // Tokenise declarations.
  const declarations = _tokeniseDeclarations(stripped);

  // Collect custom scalar names first (needed for type parsing).
  const customScalars = new Set();
  for (const decl of declarations) {
    if (decl.keyword === 'scalar') {
      customScalars.add(decl.name);
    }
  }

  // Find schema block if present.
  const schemaDecl = declarations.find(d => d.keyword === 'schema');
  const rootTypeNames = schemaDecl
    ? _parseSchemaBlock(schemaDecl.body)
    : { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };

  // Build type registry.
  const typeRegistry = new Map(); // name → declaration
  for (const decl of declarations) {
    if (['type', 'input', 'interface', 'enum', 'union', 'scalar'].includes(decl.keyword)) {
      typeRegistry.set(decl.name, decl);
    }
    if (decl.keyword === 'extend_type') {
      typeRegistry.set(decl.name, decl);
    }
  }

  // Identify root type declarations.
  const rootTypes = {
    query:        typeRegistry.get(rootTypeNames.query),
    mutation:     typeRegistry.get(rootTypeNames.mutation),
    subscription: typeRegistry.get(rootTypeNames.subscription),
  };

  // Build endpoints from root fields.
  const usedIds   = new Set();
  const endpoints = [];
  const droppedDirectives = new Set();

  for (const [rootKind, rootDecl] of Object.entries(rootTypes)) {
    if (!rootDecl) continue;

    const rootFields = _parseTypeBody(rootDecl.body, customScalars);
    for (const field of rootFields) {
      // Emit warnings for non-deprecated directives.
      for (const dir of (field.otherDirectives || [])) {
        const key = `@${dir}`;
        if (!droppedDirectives.has(key)) {
          droppedDirectives.add(key);
          warnings.push(`directive_dropped: @${dir}`);
        }
      }

      const id = _deriveEndpointId(rootKind, field.name, usedIds);

      const endpoint = {
        id,
        transport:    'graphql',
        method:       rootKind,              // 'query'|'mutation'|'subscription'
        path:         `/${rootKind}/${field.name}`,
        summary:      field.description || null,
        description:  field.description || null,
        tags:         ['graphql', rootKind],
        path_params:  [],
        query_params: field.args || [],
        headers:      [],
        cookies:      [],
        body:         null,
        responses:    {
          '200': {
            description:  'GraphQL response data field',
            schema:       field.type,
          },
        },
        error_codes:  [],
        auth:         [],
        idempotency:  { method_intrinsic: rootKind === 'query', header: null, description: null },
        deprecated:   field.deprecated
          ? { is_deprecated: true, reason: field.deprecated.reason, since: null, replacement_endpoint_id: null, sunset_at: null }
          : { is_deprecated: false, since: null, replacement_endpoint_id: null, sunset_at: null },
        pagination:   null,
        rate_limit:   null,
        examples:     [],
      };

      endpoints.push(endpoint);
    }
  }

  // Build models from non-root types.
  const rootTypeNameSet = new Set([
    rootTypeNames.query,
    rootTypeNames.mutation,
    rootTypeNames.subscription,
  ]);

  const models = [];
  for (const decl of declarations) {
    // Skip schema block, root types, and extension keywords we can't model here.
    if (decl.keyword === 'schema') continue;
    if (rootTypeNameSet.has(decl.name)) continue;
    // Skip extend_type for root types — merging extensions is a future-wave feature.

    const model = _buildModel(decl, customScalars, warnings);
    if (model) models.push(model);
  }

  // Sort models by name for canonical output.
  models.sort((a, b) => a.name.localeCompare(b.name));

  // Sort endpoints by (method, path).
  endpoints.sort((a, b) => {
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });

  // Derive service metadata.
  const topDescription = _extractServiceDescription(descriptionMap);
  const serviceDisplayName = topDescription
    ? topDescription.split('\n')[0].trim().slice(0, 120) || null
    : null;
  const serviceSlug = _deriveServiceSlug(serviceDisplayName, source_url || null);

  // Build IR.
  const ir = {
    service: {
      name:         serviceSlug,
      display_name: serviceDisplayName || undefined,
      version:      '0.0.0',
      base_url:     '',
    },
    servers:    [],
    endpoints,
    models,
    auth:       [],
    errors:     [],
    examples:   [],
    extensions: {
      'x-source-format':        'graphql-sdl',
      'x-graphql-root-types':   {
        query:        rootTypeNames.query,
        mutation:     rootTypeNames.mutation,
        subscription: rootTypeNames.subscription,
      },
    },
  };

  return {
    ir,
    warnings,
    parser: {
      name:    PARSER_NAME,
      version: PARSER_VERSION,
    },
  };
}

module.exports = { parseGraphQLSDL, PARSER_NAME, PARSER_VERSION };
