'use strict';

// lib/handlers/validate.js — Handler for the apifier-validate MCP tool.

const { readMapping } = require('../mapping/read');
const { BadParamsError } = require('../errors');

/**
 * Handle an apifier-validate tool call.
 *
 * @param {object} params
 * @param {string}  params.mapping_path - Absolute path to an apifier-mapping file.
 * @param {boolean} [params.strict]     - When true, treat warnings as errors.
 * @returns {Promise<{
 *   ok: boolean,
 *   schema_version: number|null,
 *   endpoint_count: number,
 *   errors: string[],
 *   warnings: string[]
 * }>}
 */
async function handleValidate(params) {
  if (!params || typeof params !== 'object') throw new BadParamsError('params must be an object');
  if (!params.mapping_path || typeof params.mapping_path !== 'string') {
    throw new BadParamsError('mapping_path is required');
  }

  // readMapping never throws on schema mismatch; throws on read/file errors.
  const { mapping, validation } = readMapping({ mapping_path: params.mapping_path });

  const schemaVersion = mapping ? (mapping.schema_version || null) : null;
  const endpointCount = mapping && Array.isArray(mapping.endpoints) ? mapping.endpoints.length : 0;

  // Collect parser_warnings from source if available.
  const warnings = [];
  if (mapping && mapping.source && Array.isArray(mapping.source.parser_warnings)) {
    for (const w of mapping.source.parser_warnings) {
      if (w.detail) warnings.push(w.detail);
    }
  }

  const strict = params.strict === true;
  const ok = validation.ok && (!strict || warnings.length === 0);

  return {
    ok,
    schema_version: schemaVersion,
    endpoint_count: endpointCount,
    errors:   validation.errors,
    warnings,
  };
}

module.exports = { handleValidate };
