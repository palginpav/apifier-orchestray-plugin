'use strict';

// lib/handlers/generate.js — Handler for the apifier-generate MCP tool.
// Reads an apifier-mapping, runs the requested codegen target, and writes the output atomically.

const crypto = require('node:crypto');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { readMapping }                         = require('../mapping/read');
const { resolveWithinAllowedRoots, PathTraversalError } = require('../path-guard');
const { BadParamsError, CodegenNotSupportedError }      = require('../errors');
const registry                                = require('../codegen/_registry');

// ---------------------------------------------------------------------------
// Allowed output roots — same set as lib/mapping/write.js _buildAllowedRoots.
// ---------------------------------------------------------------------------

function _buildAllowedRoots() {
  return [
    path.resolve(os.homedir(), '.orchestray', 'apifier', 'mappings'),
    path.resolve(os.homedir(), '.orchestray', 'apifier', 'generated'),
    path.resolve(process.cwd(), 'out'),
    path.resolve(process.cwd(), 'apifier-out'),
    path.resolve(os.tmpdir()),
  ];
}

/**
 * Compute SHA-256 hex digest of a Buffer or string.
 * @param {Buffer|string} data
 * @returns {string} Lowercase hex digest.
 */
function _sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Handle the apifier-generate tool call.
 *
 * @param {object} opts
 * @param {string}  opts.mapping_path  - Absolute path to the .apifier.json mapping file.
 * @param {string}  opts.target        - Codegen target id (e.g. 'ts-fetch').
 * @param {string}  [opts.out_path]    - Absolute path for the output file (must be inside allowed roots).
 * @param {boolean} [opts.overwrite]   - Allow overwriting an existing output file. Default false.
 * @returns {Promise<{ output_path: string, target: string, bytes_written: number, fingerprint: string }>}
 */
async function handleGenerate({ mapping_path, target, out_path, overwrite = false }) {
  // ------------------------------------------------------------------
  // 1. Validate target against registry
  // ------------------------------------------------------------------
  const entry = registry.resolve(target);
  if (!entry) {
    throw new BadParamsError(
      `unknown target '${target}'. Supported: ${Object.keys(registry.TARGETS).join(', ')}`
    );
  }

  // ------------------------------------------------------------------
  // 2. Unsupported targets return structured CodegenNotSupportedError
  // ------------------------------------------------------------------
  if (!entry.generate) {
    throw new CodegenNotSupportedError(target, entry.wave);
  }

  // ------------------------------------------------------------------
  // 3. Read and validate mapping
  // ------------------------------------------------------------------
  const { mapping, validation } = readMapping({ mapping_path });
  if (!validation.ok) {
    throw new BadParamsError(
      `mapping at '${mapping_path}' failed validation: ${(validation.errors || []).slice(0, 3).join('; ')}`
    );
  }

  // ------------------------------------------------------------------
  // 4. Run codegen
  // ------------------------------------------------------------------
  const { text, ext } = entry.generate(mapping);

  // ------------------------------------------------------------------
  // 5. Validate out_path
  // ------------------------------------------------------------------
  if (!out_path || typeof out_path !== 'string') {
    throw new BadParamsError('out_path is required and must be a non-empty string');
  }

  // Extension must match the target's declared extension
  if (!out_path.endsWith(ext)) {
    throw new BadParamsError(
      `out_path must end with '${ext}' for target '${target}' (got: '${out_path}')`
    );
  }

  // Route through path-guard (same allowed roots as mapping writer)
  let resolvedOutPath;
  try {
    resolvedOutPath = resolveWithinAllowedRoots(out_path, { allowedRoots: _buildAllowedRoots() });
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new BadParamsError(`out_path security violation: ${err.message}`);
    }
    throw err;
  }

  // ------------------------------------------------------------------
  // 6. Overwrite check
  // ------------------------------------------------------------------
  if (!overwrite && fs.existsSync(resolvedOutPath)) {
    throw new BadParamsError(
      `output file already exists: ${resolvedOutPath}. Pass overwrite:true to replace.`
    );
  }

  // ------------------------------------------------------------------
  // 7. Atomic write: mkdtempSync → write → rename
  // ------------------------------------------------------------------
  const outputDir = path.dirname(resolvedOutPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const contentBuf = Buffer.from(text, 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(outputDir, '.apifier-codegen-tmp-'));
  try {
    fs.chmodSync(tmpDir, 0o700);
    const tmpFile = path.join(tmpDir, path.basename(resolvedOutPath));
    fs.writeFileSync(tmpFile, contentBuf, { mode: 0o600 });
    fs.renameSync(tmpFile, resolvedOutPath);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
  try { fs.rmdirSync(tmpDir); } catch (_) { /* ignore if already gone */ }

  // ------------------------------------------------------------------
  // 8. Compute fingerprint
  // ------------------------------------------------------------------
  const fingerprint = _sha256(contentBuf);

  return {
    output_path:   resolvedOutPath,
    target,
    bytes_written: contentBuf.length,
    fingerprint,
  };
}

module.exports = { handleGenerate };
