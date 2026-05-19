'use strict';

// lib/http/fetch.js — HTTP/file/inline source fetcher with size cap, timeout, sha256, and auth-gate detection.

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { ScrapeSizeError, AuthGatedError } = require('../errors');
const { resolveWithinAllowedRoots, PathTraversalError } = require('../path-guard');

const MAX_BODY_BYTES   = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT  = 30_000;
const MAX_TIMEOUT      = 55_000;
const MAX_REDIRECTS    = 5;
const USER_AGENT       = 'apifier/0.0.1';

/**
 * Detect source kind from the value string.
 * Returns 'url' | 'file' | 'inline'.
 * @param {string} source
 * @returns {'url'|'file'|'inline'}
 */
function _detectKind(source) {
  const trimmed = source.trimStart();
  if (/^https?:\/\//i.test(trimmed)) return 'url';
  // Inline heuristics: starts with { (JSON object), [ (JSON array), < (XML/HTML), or openapi: (YAML)
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<') || /^openapi\s*:/i.test(trimmed)) {
    return 'inline';
  }
  return 'file';
}

/**
 * Compute sha256 hex of a Buffer or string.
 * @param {Buffer|string} data
 * @returns {string} lowercase hex
 */
function _sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Fetch a source (URL, file path, or inline text) and return a normalised descriptor.
 *
 * @param {object} opts
 * @param {string}  opts.source      - URL, absolute file path, or inline spec text.
 * @param {number}  [opts.timeout_ms=30000] - Fetch timeout in ms (capped at 55 000).
 * @returns {Promise<{
 *   body: string,
 *   content_type: string,
 *   sha256: string,
 *   fetched_at: string,
 *   source_url: string|null,
 *   source_path: string|null,
 *   bytes: number
 * }>}
 */
async function fetchSource({ source, timeout_ms }) {
  if (!source || typeof source !== 'string') {
    throw new TypeError('source is required and must be a string');
  }

  const timeout = Math.min(typeof timeout_ms === 'number' ? timeout_ms : DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const kind    = _detectKind(source);
  const fetched_at = new Date().toISOString();

  if (kind === 'inline') {
    const buf = Buffer.from(source, 'utf8');
    if (buf.length > MAX_BODY_BYTES) {
      throw new ScrapeSizeError(`inline spec exceeds 5 MB limit (${buf.length} bytes)`);
    }
    return {
      body:        source,
      content_type: 'application/json',
      sha256:      _sha256(buf),
      fetched_at,
      source_url:  null,
      source_path: null,
      bytes:       buf.length,
    };
  }

  if (kind === 'file') {
    // Enforce allowed-roots policy: only read files under home dir, cwd, or system tmpdir.
    // Both os.tmpdir() and /tmp are included because on some Linux systems os.tmpdir()
    // returns a user-scoped path (e.g. /tmp/.private/$USER) while /tmp itself is the
    // canonical system temp root that tests and tools may use directly.
    const fetchAllowedRoots = [os.homedir(), process.cwd(), os.tmpdir(), '/tmp'];
    const absPath = resolveWithinAllowedRoots(source, { allowedRoots: fetchAllowedRoots });
    let buf;
    try {
      buf = fs.readFileSync(absPath);
    } catch (err) {
      if (err instanceof PathTraversalError) throw err;
      const msg = err.code === 'ENOENT'
        ? `file not found: ${absPath}`
        : `could not read file: ${err.message}`;
      throw Object.assign(new Error(msg), { code: err.code || 'ERR_READ' });
    }
    if (buf.length > MAX_BODY_BYTES) {
      throw new ScrapeSizeError(`file exceeds 5 MB limit (${buf.length} bytes): ${absPath}`);
    }
    const body = buf.toString('utf8');
    return {
      body,
      content_type: 'application/json',
      sha256:      _sha256(buf),
      fetched_at,
      source_url:  null,
      source_path: absPath,
      bytes:       buf.length,
    };
  }

  // kind === 'url'
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(source, {
      signal:   controller.signal,
      redirect: 'follow',
      headers:  { 'User-Agent': USER_AGENT },
      // Node 20 fetch follows redirects natively; maxRedirects not a standard option
      // but we check via redirect count heuristic if needed.
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`fetch timed out after ${timeout} ms: ${source}`);
    }
    throw new Error(`fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // Auth gate detection.
  if (response.status === 401 || response.status === 403) {
    throw new AuthGatedError(
      `HTTP ${response.status} from ${source}. This documentation page requires authentication. ` +
      'Download the spec to a local file and pass it as `source=/absolute/path/to/spec.json`.'
    );
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${source}`);
  }

  // Stream body with size cap.
  const chunks = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reader.cancel();
        throw new ScrapeSizeError(`response body exceeds 5 MB limit from ${source}`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ScrapeSizeError) throw err;
    throw new Error(`stream read error: ${err.message}`);
  }

  const buf = Buffer.concat(chunks);
  const body = buf.toString('utf8');
  const content_type = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();

  return {
    body,
    content_type,
    sha256:      _sha256(buf),
    fetched_at,
    source_url:  source,
    source_path: null,
    bytes:       buf.length,
  };
}

module.exports = { fetchSource, _detectKind, PathTraversalError };
