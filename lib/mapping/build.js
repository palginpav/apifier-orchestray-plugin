'use strict';

// lib/mapping/build.js — Builds a canonical mapping object from IR + provenance inputs.

const { version: APIFIER_VERSION } = require('../../package.json');

/**
 * Canonical sort key for an endpoint: (transport, method, path) ascending.
 * @param {object} ep
 * @returns {string}
 */
function endpointSortKey(ep) {
  return `${ep.transport || ''}\x00${ep.method || ''}\x00${ep.path || ''}`;
}

/**
 * Build a mapping object conforming to apifier-mapping v1 schema.
 * Fills schema-required provenance fields and sorts arrays to canonical order.
 *
 * @param {object} opts
 * @param {object} opts.ir        - Intermediate representation from a parser; must contain endpoints[].
 * @param {object} opts.source    - Provenance: { url?, file_path?, fetched_at, sha256?, bytes?, robots_respected?, parser, parser_warnings? }
 * @returns {object} Mapping object (not yet written to disk).
 */
function buildMapping({ ir, source }) {
  if (!ir || typeof ir !== 'object') throw new TypeError('ir must be an object');
  if (!source || typeof source !== 'object') throw new TypeError('source must be an object');
  if (!source.type) throw new TypeError('source.type is required');
  if (!source.fetched_at) throw new TypeError('source.fetched_at is required');
  if (!source.parser || !source.parser.name || !source.parser.version) {
    throw new TypeError('source.parser.name and source.parser.version are required');
  }

  // Endpoints sorted by canonical order: (transport, method, path).
  const endpoints = Array.isArray(ir.endpoints)
    ? [...ir.endpoints].sort((a, b) => endpointSortKey(a).localeCompare(endpointSortKey(b)))
    : [];

  // Models sorted by name.
  const models = Array.isArray(ir.models)
    ? [...ir.models].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    : undefined;

  // Errors sorted by (scope, status, code).
  const errors = Array.isArray(ir.errors)
    ? [...ir.errors].sort((a, b) => {
        const scopeA = `${a.scope || ''}\x00${a.status || 0}\x00${a.code || ''}`;
        const scopeB = `${b.scope || ''}\x00${b.status || 0}\x00${b.code || ''}`;
        return scopeA.localeCompare(scopeB);
      })
    : undefined;

  const mapping = {
    schema_version: 1,
    apifier_version: APIFIER_VERSION,
    kind: 'apifier-mapping',
    service: ir.service || {},
    source: {
      type: source.type,
      url: source.url != null ? source.url : null,
      file_path: source.file_path != null ? source.file_path : null,
      fetched_at: source.fetched_at,
      sha256: source.sha256 != null ? source.sha256 : null,
      bytes: source.bytes != null ? source.bytes : null,
      robots_respected: source.robots_respected != null ? source.robots_respected : null,
      parser: {
        name: source.parser.name,
        version: source.parser.version,
      },
      parser_warnings: source.parser_warnings || [],
    },
    endpoints,
  };

  // Optional top-level arrays — omit key if empty/absent.
  if (ir.auth && ir.auth.length > 0) mapping.auth = ir.auth;
  if (ir.servers && ir.servers.length > 0) mapping.servers = ir.servers;
  if (models && models.length > 0) mapping.models = models;
  if (errors && errors.length > 0) mapping.errors = errors;
  if (ir.examples && ir.examples.length > 0) mapping.examples = ir.examples;
  if (ir.extensions && Object.keys(ir.extensions).length > 0) mapping.extensions = ir.extensions;

  return mapping;
}

module.exports = { buildMapping };
