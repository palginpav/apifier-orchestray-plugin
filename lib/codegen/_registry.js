'use strict';

// lib/codegen/_registry.js — Codegen target registry. Maps target id → impl module.
// Wave 4A ships `ts-fetch`; wave 4B adds `python-requests`; wave 4D adds `go-net-http`.

const TS_FETCH        = require('./ts-fetch');
const PYTHON_REQUESTS = require('./python-requests');
const OPENAPI_31      = require('./openapi-3.1');
const GO_NET_HTTP     = require('./go-net-http');

const TARGETS = {
  'ts-fetch':        { generate: TS_FETCH.generate,        ext: '.ts',   wave: '4A' },
  'ts-axios':        { generate: null,                     ext: '.ts',   wave: '4C' },
  'python-requests': { generate: PYTHON_REQUESTS.generate, ext: '.py',   wave: '4B' },
  'python-httpx':    { generate: null,                     ext: '.py',   wave: '4C' },
  'openapi-3.1':     { generate: OPENAPI_31.generate,      ext: '.yaml', wave: '4C' },
  'go-net-http':     { generate: GO_NET_HTTP.generate,     ext: '.go',   wave: '4D' },
  'curl-shell':      { generate: null,                     ext: '.sh',   wave: '6+' },
};

/**
 * Resolve a target id to its registry entry, or null if not found.
 * @param {string} targetId
 * @returns {{ generate: Function|null, ext: string, wave: string }|null}
 */
function resolve(targetId) {
  return TARGETS[targetId] || null;
}

/**
 * List all registered targets with support status.
 * @returns {Array<{ id: string, ext: string, wave: string, supported: boolean }>}
 */
function list() {
  return Object.entries(TARGETS).map(([id, t]) => ({
    id,
    ext: t.ext,
    wave: t.wave,
    supported: !!t.generate,
  }));
}

module.exports = { resolve, list, TARGETS };
