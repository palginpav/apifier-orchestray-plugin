'use strict';

// lib/mapping/write.js — Atomic, path-traversal-defended writer for apifier-mapping files.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { validate }            = require('./schema');
const { getMappingDir }       = require('../registry');
const { ValidatorRejectedError, BadParamsError } = require('../errors');
const {
  resolveWithinAllowedRoots,
  PathTraversalError,
  defaultApifierAllowedRoots,
} = require('../path-guard');

// Service name must be a safe slug.
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------
// Allowed roots — delegated to path-guard.defaultApifierAllowedRoots so the
// policy stays a single source of truth shared with lib/handlers/generate.js.
// ---------------------------------------------------------------------------

function _buildAllowedRoots(extraRoots) {
  try {
    return defaultApifierAllowedRoots(extraRoots);
  } catch (err) {
    // Preserve the public ValidatorRejectedError contract.
    if (err instanceof PathTraversalError) {
      throw new ValidatorRejectedError(err.message);
    }
    throw err;
  }
}

/**
 * Resolve and validate an output_dir against the allowed-roots list.
 * Delegates the path-traversal check to resolveWithinAllowedRoots (lib/path-guard.js)
 * then creates the directory if it does not exist.
 *
 * @param {string} dir
 * @param {string[]} allowed
 * @returns {string} Resolved, real absolute path.
 */
function _resolveOutputDir(dir, allowed) {
  // Delegate traversal and root checks to the shared path-guard module.
  // PathTraversalError is re-thrown as ValidatorRejectedError to preserve the
  // public error contract that write.js callers expect.
  let absDir;
  try {
    absDir = resolveWithinAllowedRoots(dir, { allowedRoots: allowed });
  } catch (err) {
    if (err instanceof PathTraversalError) {
      // Translate error message to match the expected patterns in existing tests.
      const msg = err.message
        .replace(/^path /, 'output_dir ')
        .replace('parent traversal segment', 'output_dir contains parent traversal segment')
        .replace('is not under any allowed root', 'is not under any allowed root');
      throw new ValidatorRejectedError(msg);
    }
    throw err;
  }

  // Create the directory now that we know it is safe to do so.
  if (!fs.existsSync(absDir)) {
    fs.mkdirSync(absDir, { recursive: true });
  }

  // realpath post-creation check — symlinks may have been created between check and create.
  const real = fs.realpathSync(absDir);
  for (const root of allowed) {
    if (real === root || real.startsWith(root + path.sep)) return real;
  }
  throw new ValidatorRejectedError(
    `output_dir ${dir} resolves via symlink to ${real} which is outside allowed roots`
  );
}

/**
 * Canonical JSON serialiser: sorted top-level keys, 2-space indent, trailing newline.
 * Byte-identical for the same input object.
 * @param {object} mapping
 * @returns {string}
 */
function _canonicalJson(mapping) {
  // Ordered top-level keys as specified in W2-mapping-schema §2.1.
  const KEY_ORDER = [
    'schema_version', 'apifier_version', 'kind', 'service', 'source',
    'auth', 'servers', 'endpoints', 'models', 'errors', 'examples', 'extensions',
  ];
  const ordered = {};
  for (const k of KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(mapping, k)) {
      ordered[k] = mapping[k];
    }
  }
  // Any extra keys not in the order list appended last (should not exist in strict schema).
  for (const k of Object.keys(mapping)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, k)) {
      ordered[k] = mapping[k];
    }
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

/**
 * Write a validated mapping to disk atomically.
 *
 * @param {object} opts
 * @param {object}  opts.mapping       - Mapping object to write.
 * @param {string}  [opts.output_dir]  - Target directory. Defaults to registry getMappingDir().
 * @param {string}  opts.service_name  - Slug used for the filename.
 * @param {boolean} [opts.overwrite]   - Allow overwrite of existing file. Default false.
 * @param {string[]} [opts.extra_allowed_roots] - Additional allowed root paths.
 * @returns {{ output_path: string }}
 */
function writeMapping({ mapping, output_dir, service_name, overwrite = false, extra_allowed_roots }) {
  // Validate service_name.
  if (!service_name || typeof service_name !== 'string') {
    throw new BadParamsError('service_name is required');
  }
  if (!SERVICE_NAME_RE.test(service_name)) {
    throw new BadParamsError(`service_name "${service_name}" does not match ^[a-z0-9][a-z0-9-]{0,63}$`);
  }

  // Validate mapping against schema before touching the filesystem.
  const schemaCheck = validate(mapping);
  if (!schemaCheck.ok) {
    throw new ValidatorRejectedError(
      `mapping failed schema validation: ${schemaCheck.errors.slice(0, 3).join('; ')}`
    );
  }

  // Resolve output directory with path-traversal defence.
  const resolvedDir = output_dir
    ? _resolveOutputDir(output_dir, _buildAllowedRoots(extra_allowed_roots))
    : getMappingDir();

  const filename    = `${service_name}.apifier.json`;
  const outputPath  = path.join(resolvedDir, filename);

  // Check overwrite policy.
  if (!overwrite && fs.existsSync(outputPath)) {
    throw new ValidatorRejectedError(
      `output file already exists: ${outputPath}. Pass overwrite:true to replace.`
    );
  }

  const content = _canonicalJson(mapping);

  // Atomic write: mkdtempSync → write → rename.
  const tmpDir = fs.mkdtempSync(path.join(resolvedDir, '.apifier-tmp-'));
  try {
    fs.chmodSync(tmpDir, 0o700);
    const tmpFile = path.join(tmpDir, filename);
    fs.writeFileSync(tmpFile, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpFile, outputPath);
  } catch (err) {
    // Best-effort cleanup.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
  // Remove empty tmp dir (rename moved the file out).
  try { fs.rmdirSync(tmpDir); } catch (_) { /* ignore if already gone */ }

  return { output_path: outputPath };
}

module.exports = { writeMapping, _resolveOutputDir, _canonicalJson };
