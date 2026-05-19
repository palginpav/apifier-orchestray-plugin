'use strict';

// tests/unit/server-handshake.test.js — Integration smoke-test for server.js.
// Spawns `node server.js`, pipes initialize + tools/list frames, asserts responses
// match the manifest. Uses node:test and node:child_process — no npm install required.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');

const SERVER_JS = path.join(__dirname, '../../server.js');
const MANIFEST = require(path.join(__dirname, '../../orchestray-plugin.json'));

/**
 * Spawn server.js, send NDJSON frames, collect N response lines, then kill.
 * Rejects if the process exits before N responses arrive or exceeds 5 s.
 * @param {object[]} frames - Frames to send
 * @param {number} expectedCount - Number of response lines expected
 * @returns {Promise<object[]>} Parsed response frames
 */
function runHandshake(frames, expectedCount) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_JS], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = [];
    let buf = '';
    let done = false;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        proc.kill();
        reject(new Error(`server.js did not respond within 5 s (got ${responses.length}/${expectedCount} responses)`));
      }
    }, 5000);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); }
        catch (e) { /* ignore malformed lines */ continue; }
        responses.push(parsed);
        if (responses.length >= expectedCount && !done) {
          done = true;
          clearTimeout(timeout);
          proc.kill();
          resolve(responses);
        }
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', data => {
      // Don't fail on stderr; server.js should not write to stderr but we tolerate it.
    });

    proc.on('exit', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        if (responses.length >= expectedCount) {
          resolve(responses);
        } else {
          reject(new Error(`server.js exited early (code ${code}) with only ${responses.length}/${expectedCount} responses`));
        }
      }
    });

    proc.on('error', err => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    // Write frames as NDJSON lines.
    for (const frame of frames) {
      proc.stdin.write(JSON.stringify(frame) + '\n');
    }
    // Close stdin after all frames sent so server knows no more input is coming.
    // We do NOT close immediately — we want to receive responses first.
    // (stdin will be closed when proc is killed above or on timeout.)
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('server.js responds to initialize with correct serverInfo', async () => {
  const initFrame = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-runner', version: '0' },
    },
  };

  const [resp] = await runHandshake([initFrame], 1);

  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 1);
  assert.ok(resp.result, 'must have result');
  assert.ok(!resp.error, 'must not have error');
  assert.equal(resp.result.protocolVersion, '2025-03-26');
  assert.equal(resp.result.serverInfo.name, MANIFEST.name);
  assert.equal(resp.result.serverInfo.version, MANIFEST.version);
  assert.deepEqual(resp.result.capabilities, { tools: { listChanged: false } });
});

test('server.js responds to tools/list with manifest tools', async () => {
  const listFrame = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  };

  const [resp] = await runHandshake([listFrame], 1);

  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 2);
  assert.ok(resp.result, 'must have result');
  assert.ok(!resp.error, 'must not have error');
  assert.ok(Array.isArray(resp.result.tools));

  // Tool count must match manifest exactly.
  assert.equal(resp.result.tools.length, MANIFEST.tools.length,
    `tools/list count (${resp.result.tools.length}) must match manifest (${MANIFEST.tools.length})`);

  // Every tool name in manifest must appear in the response.
  const returnedNames = new Set(resp.result.tools.map(t => t.name));
  for (const manifestTool of MANIFEST.tools) {
    assert.ok(returnedNames.has(manifestTool.name),
      `manifest tool "${manifestTool.name}" must appear in tools/list response`);
  }
});

test('server.js full handshake: initialize then tools/list in one session', async () => {
  const frames = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    },
  ];

  const [initResp, listResp] = await runHandshake(frames, 2);

  // initialize response
  assert.equal(initResp.id, 1);
  assert.equal(initResp.result.serverInfo.name, 'apifier');

  // tools/list response — count auto-scales with the manifest.
  assert.equal(listResp.id, 2);
  assert.equal(listResp.result.tools.length, MANIFEST.tools.length);
});

test('server.js returns -32601 for unknown method', async () => {
  const frame = {
    jsonrpc: '2.0',
    id: 99,
    method: 'unknown/method',
    params: {},
  };

  const [resp] = await runHandshake([frame], 1);
  assert.equal(resp.id, 99);
  assert.ok(resp.error, 'must have error field');
  assert.equal(resp.error.code, -32601);
  assert.ok(!resp.result, 'must not have result field');
});
