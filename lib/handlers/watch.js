'use strict';

// lib/handlers/watch.js — Handler for the apifier-watch MCP tool.
// Fuses apifier-scrape + apifier-diff into a single atomic call for CI gates.

const { handleScrape }   = require('./scrape');
const { readMapping }    = require('../mapping/read');
const { compareMapping } = require('../diff/compare');
const { BadParamsError, WatchError } = require('../errors');
const {
  resolveWithinAllowedRoots,
  defaultApifierAllowedRoots,
  PathTraversalError,
} = require('../path-guard');

// Map user-facing block_on enum → internal verdict string.
const BLOCK_ON_VERDICT = {
  breaking: 'major',
  minor:    'minor',
  patch:    'patch',
  none:     null, // never blocks
};

// Ordered severity for comparison (ascending).
const SEVERITY_ORDER = ['compatible', 'patch', 'minor', 'major'];

/**
 * Re-scrape an API doc source and diff the result against a committed baseline.
 *
 * @param {object} params
 * @param {string}  params.source           - URL, file path, or inline text (same as apifier-scrape).
 * @param {string}  params.baseline_path    - Absolute path to the baseline mapping.
 * @param {string}  [params.service_name]   - Slug for the fresh-scrape output filename.
 * @param {string}  [params.output_dir]     - Where to write the fresh scrape.
 * @param {string}  [params.block_on]       - 'breaking' | 'minor' | 'patch' | 'none' (default 'breaking').
 * @param {boolean} [params.obey_robots_txt]
 * @param {number}  [params.timeout_ms]
 * @param {string}  [params.source_type]
 * @returns {Promise<{
 *   verdict: 'major' | 'minor' | 'patch' | 'compatible',
 *   counts: { breaking: number, non_breaking: number, patch: number, total: number },
 *   should_block: boolean,
 *   breaking_changes: object[],
 *   summary: object,
 *   fresh_mapping_path: string,
 *   baseline_summary: { endpoint_count: number, models: number, source: string },
 *   timing: { scrape_ms: number, diff_ms: number, total_ms: number }
 * }>}
 */
async function handleWatch(params) {
  if (!params || typeof params !== 'object') throw new BadParamsError('params must be an object');

  const {
    source,
    baseline_path,
    service_name,
    output_dir,
    block_on = 'breaking',
    obey_robots_txt,
    timeout_ms,
    source_type,
  } = params;

  // --- Input validation ---
  if (!source || typeof source !== 'string') {
    throw new BadParamsError('source is required and must be a string');
  }
  if (source.length > 4096) {
    throw new BadParamsError('source must be <= 4096 characters');
  }
  if (!baseline_path || typeof baseline_path !== 'string') {
    throw new BadParamsError('baseline_path is required and must be a string');
  }
  if (!Object.prototype.hasOwnProperty.call(BLOCK_ON_VERDICT, block_on)) {
    throw new BadParamsError('block_on must be one of: breaking, minor, patch, none');
  }

  // --- Path-guard baseline_path ---
  const allowedRoots = defaultApifierAllowedRoots();
  try {
    resolveWithinAllowedRoots(baseline_path, { allowedRoots });
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new BadParamsError(`baseline_path: ${err.message}`);
    }
    throw err;
  }

  const totalStart = process.hrtime.bigint();

  // --- Phase: fresh scrape ---
  const scrapeStart = process.hrtime.bigint();
  let scrapeResult;
  try {
    scrapeResult = await handleScrape({
      source,
      service_name,
      output_dir,
      overwrite: true,
      obey_robots_txt,
      timeout_ms,
      source_type,
    });
  } catch (err) {
    throw new WatchError(`[phase=scrape] ${err.message}`);
  }
  const scrapeMs = Number(process.hrtime.bigint() - scrapeStart) / 1e6;

  // --- Load fresh mapping ---
  let freshResult;
  try {
    freshResult = readMapping({ mapping_path: scrapeResult.output_path });
  } catch (err) {
    throw new WatchError(`[phase=scrape] failed to read fresh mapping: ${err.message}`);
  }
  if (!freshResult.validation.ok) {
    throw new WatchError(
      `[phase=scrape] fresh mapping failed schema validation: ${freshResult.validation.errors.join('; ')}`
    );
  }

  // --- Load baseline mapping ---
  let baselineResult;
  try {
    baselineResult = readMapping({ mapping_path: baseline_path });
  } catch (err) {
    throw new WatchError(`[phase=baseline_load] ${err.message}`);
  }
  if (!baselineResult.validation.ok) {
    throw new WatchError(
      `[phase=baseline_load] baseline mapping failed schema validation: ${baselineResult.validation.errors.join('; ')}`
    );
  }

  // --- Diff (pure, no I/O) ---
  const diffStart = process.hrtime.bigint();
  const report = compareMapping(baselineResult.mapping, freshResult.mapping);
  const diffMs = Number(process.hrtime.bigint() - diffStart) / 1e6;
  const totalMs = Number(process.hrtime.bigint() - totalStart) / 1e6;

  // --- Block decision ---
  const blockOnVerdictStr = BLOCK_ON_VERDICT[block_on];
  let should_block;
  if (blockOnVerdictStr === null) {
    // block_on='none' — never block
    should_block = false;
  } else {
    const blockOnIdx = SEVERITY_ORDER.indexOf(blockOnVerdictStr);
    const verdictIdx = SEVERITY_ORDER.indexOf(report.verdict);
    should_block = verdictIdx >= blockOnIdx;
  }

  // --- Baseline summary ---
  const bm = baselineResult.mapping;
  const baseline_summary = {
    endpoint_count: Array.isArray(bm.endpoints) ? bm.endpoints.length : 0,
    models:         Array.isArray(bm.models) ? bm.models.length : 0,
    source:         (bm.source && (bm.source.url || bm.source.file_path)) || '',
  };

  return {
    verdict:            report.verdict,
    counts:             report.counts,
    should_block,
    breaking_changes:   report.breaking,       // empty array when verdict !== 'major'
    summary:            report.summary,
    fresh_mapping_path: scrapeResult.output_path,
    baseline_summary,
    timing: {
      scrape_ms: Math.round(scrapeMs),
      diff_ms:   Math.round(diffMs),
      total_ms:  Math.round(totalMs),
    },
  };
}

module.exports = { handleWatch };
