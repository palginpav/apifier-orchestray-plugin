'use strict';

// lib/handlers/diff.js — Handler for the apifier-diff MCP tool.

const { readMapping } = require('../mapping/read');
const { compareMapping } = require('../diff/compare');
const { BadParamsError, MappingDiffError } = require('../errors');
const {
  resolveWithinAllowedRoots,
  defaultApifierAllowedRoots,
  PathTraversalError,
} = require('../path-guard');

/**
 * Handle an apifier-diff tool call.
 *
 * @param {object} params
 * @param {string}  params.mapping_a  - Absolute path to the baseline mapping (old version).
 * @param {string}  params.mapping_b  - Absolute path to the candidate mapping (new version).
 * @param {string}  [params.format]   - "structured" (default) or "summary".
 * @returns {Promise<object>} ChangeReport or summary-only object.
 */
async function handleDiff(params) {
  if (!params || typeof params !== 'object') throw new BadParamsError('params must be an object');

  const { mapping_a, mapping_b, format = 'structured' } = params;

  if (!mapping_a || typeof mapping_a !== 'string') {
    throw new BadParamsError('mapping_a is required and must be a string');
  }
  if (!mapping_b || typeof mapping_b !== 'string') {
    throw new BadParamsError('mapping_b is required and must be a string');
  }
  if (format !== 'structured' && format !== 'summary') {
    throw new BadParamsError('format must be "structured" or "summary"');
  }

  // Guard both paths — throws BadParamsError-compatible PathTraversalError if outside roots.
  const allowedRoots = defaultApifierAllowedRoots();
  try {
    resolveWithinAllowedRoots(mapping_a, { allowedRoots });
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new BadParamsError(`mapping_a: ${err.message}`);
    }
    throw err;
  }
  try {
    resolveWithinAllowedRoots(mapping_b, { allowedRoots });
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new BadParamsError(`mapping_b: ${err.message}`);
    }
    throw err;
  }

  // Read both mappings (readMapping throws on file I/O errors; returns validation report).
  const resultA = readMapping({ mapping_path: mapping_a });
  const resultB = readMapping({ mapping_path: mapping_b });

  if (!resultA.validation.ok) {
    throw new MappingDiffError(
      `mapping_a failed schema validation: ${resultA.validation.errors.join('; ')}`
    );
  }
  if (!resultB.validation.ok) {
    throw new MappingDiffError(
      `mapping_b failed schema validation: ${resultB.validation.errors.join('; ')}`
    );
  }

  const report = compareMapping(resultA.mapping, resultB.mapping);

  if (format === 'summary') {
    return {
      verdict: report.verdict,
      counts:  report.counts,
      summary: report.summary,
    };
  }

  return report;
}

module.exports = { handleDiff };
