'use strict';

// lib/mapping/read.js — Read and validate an apifier-mapping file; never throws on schema mismatch.

const fs   = require('fs');
const { validate } = require('./schema');

/**
 * Read a mapping file from disk, parse JSON, and validate against MappingSchemaV1.
 * Does NOT throw on schema mismatch — returns a structured validation report.
 *
 * @param {object} opts
 * @param {string} opts.mapping_path - Absolute path to the .apifier.json file.
 * @returns {{ mapping: object|null, validation: { ok: boolean, errors: string[] } }}
 */
function readMapping({ mapping_path }) {
  if (!mapping_path || typeof mapping_path !== 'string') {
    throw new TypeError('mapping_path is required and must be a string');
  }

  // File existence / read errors surface as thrown errors (not validation errors).
  let raw;
  try {
    raw = fs.readFileSync(mapping_path, 'utf8');
  } catch (err) {
    const detail = err.code === 'ENOENT'
      ? `file not found: ${mapping_path}`
      : `could not read ${mapping_path}: ${err.message}`;
    throw Object.assign(new Error(detail), { code: err.code || 'ERR_READ' });
  }

  // JSON parse errors are reported as a validation failure, not thrown.
  let mapping;
  try {
    mapping = JSON.parse(raw);
  } catch (parseErr) {
    return {
      mapping: null,
      validation: { ok: false, errors: [`JSON parse error: ${parseErr.message}`] },
    };
  }

  const validation = validate(mapping);
  return { mapping, validation };
}

module.exports = { readMapping };
