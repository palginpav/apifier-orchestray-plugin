#!/usr/bin/env node
'use strict';

/**
 * server.js — APIfier orchestray-plugin NDJSON JSON-RPC 2.0 dispatcher.
 *
 * Implements the MCP server contract for orchestray plugins (plugin-authoring-guide.md):
 *   - initialize    → capabilities + serverInfo
 *   - tools/list    → 5 tools matching orchestray-plugin.json verbatim
 *   - tools/call    → stub response for every tool in v0.0.1
 *   - (anything else) → -32601 method not found
 *
 * Routing logic lives in lib/dispatcher.js for unit-testability without stdio.
 */

const { dispatch } = require('./lib/dispatcher');

// ---------------------------------------------------------------------------
// NDJSON framing: one JSON object per line, no pretty-printing.
// Per-line stdout cap is 1 MB (plugin-authoring-guide.md line 73).
// ---------------------------------------------------------------------------

/**
 * Write a single JSON-RPC response frame as one NDJSON line to stdout.
 * @param {object} frame
 */
function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

// ---------------------------------------------------------------------------
// stdin NDJSON reader — accumulates chunks, splits on newline, dispatches.
// ---------------------------------------------------------------------------

let _buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  _buffer += chunk;
  let nl;
  while ((nl = _buffer.indexOf('\n')) !== -1) {
    const line = _buffer.slice(0, nl);
    _buffer = _buffer.slice(nl + 1);
    if (line.length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (_e) {
      // Malformed line — silently skip per MCP convention.
      continue;
    }
    // dispatch() is synchronous in v0.0.1; wrap in Promise.resolve for future
    // async tool handlers without changing the call site.
    Promise.resolve(dispatch(frame)).then(send);
  }
});

process.stdin.on('end', () => process.exit(0));
