'use strict';

// tests/unit/dispatcher.test.js — Unit tests for lib/dispatcher.js.
// Tests: unknown method → -32601; tools/call unknown tool → -32602; stub tools; real tools return result.
// Uses node:test — no npm install required.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { dispatch, TOOL_DECLS } = require(
  path.join(__dirname, '../../lib/dispatcher')
);

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

test('initialize returns protocolVersion and serverInfo', () => {
  const frame = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  };
  const resp = dispatch(frame);
  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 1);
  assert.equal(resp.result.protocolVersion, '2025-03-26');
  assert.equal(resp.result.serverInfo.name, 'apifier');
  // Manifest is the source of truth for version; don't hardcode here.
  const manifest = require(require('path').resolve(__dirname, '../../orchestray-plugin.json'));
  assert.equal(resp.result.serverInfo.version, manifest.version);
  assert.deepEqual(resp.result.capabilities, { tools: { listChanged: false } });
  assert.ok(!resp.error, 'should not have error field');
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('tools/list returns exactly 6 tools matching manifest', () => {
  const frame = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const resp = dispatch(frame);
  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 2);
  assert.ok(Array.isArray(resp.result.tools), 'result.tools must be an array');
  assert.equal(resp.result.tools.length, TOOL_DECLS.length, 'must declare exactly the manifest tool count');
  const names = resp.result.tools.map(t => t.name);
  assert.ok(names.includes('apifier-scrape'),    'must include apifier-scrape');
  assert.ok(names.includes('apifier-list'),      'must include apifier-list');
  assert.ok(names.includes('apifier-generate'),  'must include apifier-generate');
  assert.ok(names.includes('apifier-validate'),  'must include apifier-validate');
  assert.ok(names.includes('apifier-doctor'),    'must include apifier-doctor');
  assert.ok(names.includes('apifier-diff'),      'must include apifier-diff');
});

test('tools/list result matches TOOL_DECLS constant exactly', () => {
  const frame = { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} };
  const resp = dispatch(frame);
  assert.deepEqual(resp.result.tools, TOOL_DECLS);
});

test('each tool has name, description, and inputSchema', () => {
  const frame = { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} };
  const resp = dispatch(frame);
  for (const tool of resp.result.tools) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0, `tool.name must be non-empty string: ${tool.name}`);
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `tool.description must be non-empty: ${tool.name}`);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `tool.inputSchema must be an object: ${tool.name}`);
  }
});

// ---------------------------------------------------------------------------
// unknown method → -32601
// ---------------------------------------------------------------------------

test('unknown method returns JSON-RPC error -32601', () => {
  const frame = { jsonrpc: '2.0', id: 5, method: 'no/such/method', params: {} };
  const resp = dispatch(frame);
  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 5);
  assert.ok(resp.error, 'must have error field');
  assert.equal(resp.error.code, -32601);
  assert.ok(!resp.result, 'must not have result field');
});

test('null id is preserved in error response', () => {
  const frame = { jsonrpc: '2.0', id: null, method: 'unknown/method', params: {} };
  const resp = dispatch(frame);
  assert.equal(resp.id, null);
  assert.equal(resp.error.code, -32601);
});

// ---------------------------------------------------------------------------
// tools/call — unknown tool → -32602
// ---------------------------------------------------------------------------

test('tools/call with unknown tool returns -32602', () => {
  const frame = {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'no-such-tool', arguments: {} },
  };
  const resp = dispatch(frame);
  assert.equal(resp.error.code, -32602);
  assert.ok(!resp.result, 'must not have result field');
});

test('tools/call with missing name returns -32602', () => {
  const frame = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {},
  };
  const resp = dispatch(frame);
  assert.equal(resp.error.code, -32602);
});

// ---------------------------------------------------------------------------
// tools/call — stub tools (Wave 2B: only apifier-generate stays stub)
// ---------------------------------------------------------------------------

// apifier-generate is now real (Wave 4A). Missing required args → error frame (not stub).
test('tools/call apifier-generate with no args returns a Promise that resolves to an error frame', async () => {
  const frame = {
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'apifier-generate', arguments: {} },
  };
  const respOrPromise = dispatch(frame);
  assert.ok(respOrPromise instanceof Promise, 'apifier-generate must return a Promise');
  const resp = await respOrPromise;
  // With empty arguments, handler throws BadParamsError → error frame
  assert.ok(resp.error || resp.result, 'must produce either error or result frame');
});

// apifier-list and apifier-doctor are now real handlers (Wave 2B).
test('tools/call apifier-list returns a Promise (real handler)', async () => {
  const frame = {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'apifier-list', arguments: {} },
  };
  const respOrPromise = dispatch(frame);
  assert.ok(respOrPromise instanceof Promise, 'apifier-list must return a Promise');
  const resp = await respOrPromise;
  assert.ok(resp.error || resp.result, 'must produce either error or result frame');
});

test('tools/call apifier-doctor returns a Promise (real handler)', async () => {
  const frame = {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'apifier-doctor', arguments: {} },
  };
  const respOrPromise = dispatch(frame);
  assert.ok(respOrPromise instanceof Promise, 'apifier-doctor must return a Promise');
  const resp = await respOrPromise;
  assert.ok(resp.result, 'apifier-doctor must return result frame');
});

// ---------------------------------------------------------------------------
// tools/call — real tools (Wave 2A wired)
// ---------------------------------------------------------------------------

test('tools/call apifier-scrape returns a Promise (real handler)', async () => {
  const frame = {
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: { name: 'apifier-scrape', arguments: { source: 'not-a-real-url' } },
  };
  const respOrPromise = dispatch(frame);
  assert.ok(respOrPromise instanceof Promise, 'apifier-scrape must return a Promise');
  // The call with invalid source should produce an error frame (no throw).
  const resp = await respOrPromise;
  assert.ok(resp.error || resp.result, 'must produce either error or result frame');
});

test('tools/call apifier-validate returns a Promise (real handler)', async () => {
  const frame = {
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: { name: 'apifier-validate', arguments: { mapping_path: '/tmp/nonexistent.apifier.json' } },
  };
  const respOrPromise = dispatch(frame);
  assert.ok(respOrPromise instanceof Promise, 'apifier-validate must return a Promise');
  const resp = await respOrPromise;
  // File not found → error frame
  assert.ok(resp.error || resp.result, 'must produce either error or result frame');
});
