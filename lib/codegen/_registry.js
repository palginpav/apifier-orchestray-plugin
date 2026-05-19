'use strict';

// lib/codegen/_registry.js — Codegen target registry. Maps target id → impl module.
// Wave 4A ships `ts-fetch`; wave 4B adds `python-requests`; wave 4D adds `go-net-http`; wave 4E adds `curl-shell`; wave 4F adds `ts-axios` + `python-httpx`.

const TS_FETCH        = require('./ts-fetch');
const TS_AXIOS        = require('./ts-axios');
const PYTHON_REQUESTS = require('./python-requests');
const PYTHON_HTTPX    = require('./python-httpx');
const OPENAPI_31      = require('./openapi-3.1');
const GO_NET_HTTP     = require('./go-net-http');
const CURL_SHELL      = require('./curl-shell');

const TARGETS = {
  'ts-fetch':        { generate: TS_FETCH.generate,        ext: '.ts',   wave: '4A' },
  'ts-axios':        { generate: TS_AXIOS.generate,        ext: '.ts',   wave: '4F' },
  'python-requests': { generate: PYTHON_REQUESTS.generate, ext: '.py',   wave: '4B' },
  'python-httpx':    { generate: PYTHON_HTTPX.generate,    ext: '.py',   wave: '4F' },
  'openapi-3.1':     { generate: OPENAPI_31.generate,      ext: '.yaml', wave: '4C' },
  'go-net-http':     { generate: GO_NET_HTTP.generate,     ext: '.go',   wave: '4D' },
  'curl-shell':      { generate: CURL_SHELL.generate,      ext: '.sh',   wave: '4E' },
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
