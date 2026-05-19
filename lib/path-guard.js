'use strict';

// lib/path-guard.js — Shared path-traversal guard for file-system operations.
// Provides a single resolveWithinAllowedRoots() used by both fetch.js (file mode)
// and mapping/write.js to ensure user-supplied paths stay inside known-safe roots.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

/**
 * Thrown when a user-supplied path resolves outside the allowed-roots list.
 * Not a sub-class of ApifierError to avoid a circular-dependency with errors.js.
 */
class PathTraversalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathTraversalError';
    this.code = 'ERR_PATH_TRAVERSAL';
  }
}

/**
 * Canonical apifier allowed-roots list. Single source of truth — both
 * lib/mapping/write.js and lib/handlers/generate.js consume this so the policy
 * cannot drift between mapping persistence and generated-client persistence.
 *
 * @param {string[]} [extraRoots] - Optional additional roots; each is path.resolve()d
 *   and rejected if it contains a literal '..' segment.
 * @returns {string[]} Absolute resolved paths.
 */
function defaultApifierAllowedRoots(extraRoots) {
  const roots = [
    path.resolve(os.homedir(), '.orchestray', 'apifier', 'mappings'),
    path.resolve(os.homedir(), '.orchestray', 'apifier', 'generated'),
    path.resolve(process.cwd(), 'out'),
    path.resolve(process.cwd(), 'apifier-out'),
    path.resolve(os.tmpdir()),
  ];
  if (Array.isArray(extraRoots)) {
    for (const r of extraRoots) {
      if (typeof r !== 'string') continue;
      if (r.includes('..')) {
        throw new PathTraversalError('extra_allowed_root contains parent traversal segment');
      }
      roots.push(path.resolve(r));
    }
  }
  return roots;
}

/**
 * Resolve a user-supplied path and verify it falls inside one of the allowed roots.
 *
 * Two-check stack:
 *   1. Literal ".." substring — fast reject before any FS call.
 *   2. realpath — resolve symlinks and re-check (only when path exists on disk).
 *
 * @param {string} userPath - The path supplied by the caller.
 * @param {object} opts
 * @param {string[]} opts.allowedRoots   - Absolute paths that are permitted root directories.
 * @param {string}  [opts.defaultRoot]   - Fallback root used only for error messages; not applied here.
 * @returns {string} The resolved absolute path (not necessarily realpath — caller may not have created the file yet).
 * @throws {PathTraversalError} When the path is outside all allowed roots.
 */
function resolveWithinAllowedRoots(userPath, { allowedRoots }) {
  if (typeof userPath !== 'string' || !userPath) {
    throw new PathTraversalError('path must be a non-empty string');
  }

  // 1. Literal traversal segment — fast reject before any filesystem call.
  if (userPath.includes('..')) {
    throw new PathTraversalError(`path contains parent traversal segment: ${userPath}`);
  }

  // 2. Resolve to absolute path.
  const absPath = path.resolve(userPath);

  // 3. Check absolute path against allowlist.
  function _isUnderRoot(p, roots) {
    for (const root of roots) {
      if (p === root || p.startsWith(root + path.sep)) return true;
    }
    return false;
  }

  if (!_isUnderRoot(absPath, allowedRoots)) {
    throw new PathTraversalError(
      `path ${absPath} is not under any allowed root (${allowedRoots.join(', ')})`
    );
  }

  // 4. realpath defence against symlinks pointing outside allowed roots (only when file exists).
  try {
    const real = fs.realpathSync(absPath);
    if (!_isUnderRoot(real, allowedRoots)) {
      throw new PathTraversalError(
        `path ${userPath} resolves via symlink to ${real} which is outside allowed roots`
      );
    }
  } catch (err) {
    // ENOENT means the file doesn't exist yet — that is fine (caller will create it).
    if (err instanceof PathTraversalError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }

  return absPath;
}

module.exports = {
  resolveWithinAllowedRoots,
  PathTraversalError,
  defaultApifierAllowedRoots,
};
