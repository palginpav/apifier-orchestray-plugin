'use strict';

// lib/handlers/list.js — Handler for the apifier-list MCP tool.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { getMappingDir }                                = require('../registry');
const { readMapping }                                  = require('../mapping/read');
const { resolveWithinAllowedRoots, PathTraversalError } = require('../path-guard');
const { BadParamsError }                               = require('../errors');

/**
 * Build the allowed-roots list for dir validation.
 * Mirrors the approach in mapping/write.js.
 * @returns {string[]}
 */
function _buildAllowedRoots() {
  return [
    path.resolve(os.homedir()),
    path.resolve(process.cwd()),
    path.resolve(os.tmpdir()),
    path.resolve(getMappingDir()),
  ];
}

/**
 * List mappings in a directory, returning lightweight metadata per file.
 *
 * @param {object} [params]
 * @param {string}  [params.dir]             Directory to scan. Defaults to registry getMappingDir().
 * @param {string}  [params.filter]          Case-insensitive substring match against service_name.
 * @param {boolean} [params.include_invalid] When false (default), invalid mappings go to errors[].
 * @returns {{ mapping_count: number, mappings: object[], errors: string[] }}
 */
async function handleList({ dir, filter, include_invalid = false } = {}) {
  // Resolve target directory.
  let targetDir;
  if (dir) {
    try {
      targetDir = resolveWithinAllowedRoots(dir, { allowedRoots: _buildAllowedRoots() });
    } catch (err) {
      if (err instanceof PathTraversalError) {
        throw new BadParamsError(`dir is outside allowed roots: ${err.message}`);
      }
      throw err;
    }
  } else {
    targetDir = getMappingDir();
  }

  // Empty / non-existent directory → empty result.
  if (!fs.existsSync(targetDir)) {
    return { mapping_count: 0, mappings: [], errors: [] };
  }

  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.apifier.json'));
  if (files.length === 0) {
    return { mapping_count: 0, mappings: [], errors: [] };
  }

  const mappings = [];
  const errors   = [];

  for (const filename of files) {
    const filePath = path.join(targetDir, filename);
    let mapping, validation;
    try {
      ({ mapping, validation } = readMapping({ mapping_path: filePath }));
    } catch (readErr) {
      // Hard read errors (ENOENT, permissions).
      errors.push(filePath);
      continue;
    }

    if (!validation.ok) {
      if (include_invalid) {
        mappings.push(_toMeta(filePath, mapping, validation));
      } else {
        errors.push(filePath);
      }
      continue;
    }

    const meta = _toMeta(filePath, mapping, validation);

    // Apply filter.
    if (filter) {
      const hay = (meta.service_name || '').toLowerCase();
      if (!hay.includes(filter.toLowerCase())) continue;
    }

    mappings.push(meta);
  }

  return { mapping_count: mappings.length, mappings, errors };
}

/**
 * Convert a mapping + validation to lightweight metadata.
 * @param {string} filePath
 * @param {object|null} mapping
 * @param {{ ok: boolean, errors: string[] }} validation
 * @returns {object}
 */
function _toMeta(filePath, mapping, validation) {
  if (!mapping) {
    return {
      file:           filePath,
      service_name:   null,
      schema_version: null,
      endpoint_count: null,
      source_url:     null,
      fetched_at:     null,
      validation_ok:  false,
    };
  }
  const service = mapping.service || {};
  const source  = mapping.source  || {};
  return {
    file:           filePath,
    service_name:   service.name   || null,
    schema_version: mapping.schema_version || null,
    endpoint_count: Array.isArray(mapping.endpoints) ? mapping.endpoints.length : null,
    source_url:     source.url       || null,
    fetched_at:     source.fetched_at || null,
    validation_ok:  validation.ok,
  };
}

module.exports = { handleList };
