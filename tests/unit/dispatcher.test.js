'use strict';

// tests/unit/dispatcher.test.js — Unit tests for lib/dispatcher.js.
// Tests: unknown method → -32601; tools/call unknown tool → -32602; stub tools; real tools return result.
// Uses node:test — no npm install required.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { dispatch, TOOL_DECLS, STUB_TEXT } = require(
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
  assert.equal(resp.result.serverInfo.version, '0.0.1');
  assert.deepEqual(resp.result.capabilities, { tools: { listChanged: false } });
  assert.ok(!resp.error, 'should not have error field');
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('tools/list returns exactly 5 tools matching manifest', () => {
  const frame = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const resp = dispatch(frame);
  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 2);
  assert.ok(Array.isArray(resp.result.tools), 'result.tools must be an array');
  assert.equal(resp.result.tools.length, 5, 'must declare exactly 5 tools');
  const names = resp.result.tools.map(t => t.name);
  assert.ok(names.includes('apifier-scrape'),    'must include apifier-scrape');
  assert.ok(names.includes('apifier-list'),      'must include apifier-list');
  assert.ok(names.includes('apifier-generate'),  'must include apifier-generate');
  assert.ok(names.includes('apifier-validate'),  'must include apifier-validate');
  assert.ok(names.includes('apifier-doctor'),    'must include apifier-doctor');
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
// tools/call — stub tools (unimplemented in Wave 2A)
// ---------------------------------------------------------------------------

const STUB_TOOLS = [
  'apifier-list',
  'apifier-generate',
  'apifier-doctor',
];

for (const toolName of STUB_TOOLS) {
  test(`tools/call ${toolName} returns stub content`, () => {
    const frame = {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: toolName, arguments: {} },
    };
    const resp = dispatch(frame);
    assert.ok(!resp.error, `${toolName} must not return error in stub mode`);
    assert.ok(resp.result, `${toolName} must return result`);
    assert.ok(Array.isArray(resp.result.content), 'result.content must be array');
    assert.equal(resp.result.content.length, 1, 'content must have exactly 1 item');
    assert.equal(resp.result.content[0].type, 'text');
    assert.equal(resp.result.content[0].text, STUB_TEXT);
  });
}

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
