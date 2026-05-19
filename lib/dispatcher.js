'use strict';

// lib/dispatcher.js — Pure JSON-RPC 2.0 request dispatcher.
// Accepts a parsed frame object and returns a response frame object (or a Promise thereof).
// Isolated from stdio so it can be unit-tested without spawning a process.
//
// Wave 4A tool status:
//   apifier-scrape   — REAL (lib/handlers/scrape.js)
//   apifier-validate — REAL (lib/handlers/validate.js)
//   apifier-list     — REAL (lib/handlers/list.js)
//   apifier-generate — REAL (lib/handlers/generate.js) — ts-fetch live; others return CodegenNotSupportedError
//   apifier-doctor   — REAL (lib/handlers/doctor.js)

const { makeErrorFrame } = require('./errors');
const { redact }          = require('./output-redaction');
const manifest            = require('../orchestray-plugin.json');

// ---------------------------------------------------------------------------
// Tool declarations — source of truth; mirrors orchestray-plugin.json verbatim.
// The manifest and this list MUST stay in sync (divergence → plugin dead state).
// ---------------------------------------------------------------------------

const TOOL_DECLS = manifest.tools;

// Build a name-set for fast lookup.
const TOOL_NAME_SET = new Set(TOOL_DECLS.map(t => t.name));

// ---------------------------------------------------------------------------
// Stub response returned for stub tool calls in v0.0.1
// ---------------------------------------------------------------------------

const STUB_TEXT = 'unimplemented in v0.0.1; see ROADMAP.md';

// Lazy-load real handlers to avoid circular deps at module load time.
function _getHandlers() {
  return {
    'apifier-scrape':    require('./handlers/scrape').handleScrape,
    'apifier-validate':  require('./handlers/validate').handleValidate,
    'apifier-list':      require('./handlers/list').handleList,
    'apifier-doctor':    require('./handlers/doctor').handleDoctor,
    'apifier-generate':  require('./handlers/generate').handleGenerate,
  };
}

/**
 * Sanitise an error message: redact credentials and strip internal stack details.
 * @param {Error|unknown} err
 * @returns {string}
 */
function _safeMessage(err) {
  if (!err) return 'unknown error';
  const raw = err.message || String(err);
  return redact(raw);
}

/**
 * Handle a tools/call frame. Returns a result frame or an error frame (may be a Promise).
 * @param {number|null} id
 * @param {{ name: string, arguments?: object }} params
 * @returns {object|Promise<object>} JSON-RPC response frame
 */
function handleToolsCall(id, params) {
  const toolName = params && params.name;
  if (!toolName || !TOOL_NAME_SET.has(toolName)) {
    return makeErrorFrame(id, -32602, `unknown tool: ${toolName}`);
  }

  const handlers = _getHandlers();
  if (handlers[toolName]) {
    const handler = handlers[toolName];
    const args    = (params && params.arguments) || {};
    return Promise.resolve()
      .then(() => handler(args))
      .then(result => ({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        },
      }))
      .catch(err => {
        // JSON-RPC spec codes that may pass through unchanged.
        const SPEC_CODES = new Set([-32700, -32600, -32601, -32602, -32603]);
        const rawCode = (err && err.code) ? err.code : -32603;
        const message = _safeMessage(err);
        if (SPEC_CODES.has(rawCode)) {
          return makeErrorFrame(id, rawCode, message);
        }
        // Domain-specific codes (e.g. -32001, -32002, -32003) must not leak to callers.
        // Remap to internal_error and surface the original code in data.domain_code.
        return makeErrorFrame(id, -32603, message, { domain_code: rawCode });
      });
  }

  // Stub path for unimplemented tools.
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: STUB_TEXT }],
    },
  };
}

/**
 * Dispatch a parsed JSON-RPC 2.0 frame and return the response frame (or a Promise).
 * All frame ids are passed through unchanged (including null/undefined for notifications).
 *
 * Handled methods:
 *   initialize  → capabilities + serverInfo
 *   tools/list  → TOOL_DECLS array
 *   tools/call  → real handler or stub, or -32602 for unknown tool
 *   (other)     → -32601 method not found
 *
 * @param {{ id?: number|null, method: string, params?: object }} frame
 * @returns {object|Promise<object>} JSON-RPC 2.0 response frame
 */
function dispatch(frame) {
  const id     = frame.id !== undefined ? frame.id : null;
  const method = frame.method;
  const params = frame.params || {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: manifest.name, version: manifest.version },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOL_DECLS },
    };
  }

  if (method === 'tools/call') {
    return handleToolsCall(id, params);
  }

  return makeErrorFrame(id, -32601, `method not found: ${method}`);
}

module.exports = { dispatch, TOOL_DECLS, STUB_TEXT };
