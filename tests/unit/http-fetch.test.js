'use strict';

// tests/unit/http-fetch.test.js — Unit tests for lib/http/fetch.js.

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const http       = require('node:http');
const fs         = require('node:fs');
const os         = require('node:os');
const path       = require('node:path');
const { fetchSource } = require(path.join(__dirname, '../../lib/http/fetch'));
const { ScrapeSizeError, AuthGatedError } = require(path.join(__dirname, '../../lib/errors'));

// ---------------------------------------------------------------------------
// File-path read
// ---------------------------------------------------------------------------

test('fetchSource reads file path and returns body + sha256', async () => {
  const tmp = path.join(os.tmpdir(), `apifier-fetch-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{"openapi":"3.0.3"}', 'utf8');
  try {
    const result = await fetchSource({ source: tmp });
    assert.equal(result.body, '{"openapi":"3.0.3"}');
    assert.equal(typeof result.sha256, 'string');
    assert.equal(result.sha256.length, 64, 'sha256 must be 64 hex chars');
    assert.equal(result.source_path, path.resolve(tmp));
    assert.equal(result.source_url, null);
    assert.ok(result.fetched_at, 'fetched_at must be set');
    assert.ok(result.bytes > 0, 'bytes must be positive');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('fetchSource throws on missing file', async () => {
  await assert.rejects(
    () => fetchSource({ source: '/tmp/totally-nonexistent-apifier-test-file.json' }),
    err => err.message.includes('not found') || err.message.includes('could not read')
  );
});

// ---------------------------------------------------------------------------
// Inline-text read
// ---------------------------------------------------------------------------

test('fetchSource reads inline JSON text', async () => {
  const spec = '{"openapi":"3.1.0","info":{"title":"T","version":"1"}}';
  const result = await fetchSource({ source: spec });
  assert.equal(result.body, spec);
  assert.equal(result.source_url, null);
  assert.equal(result.source_path, null);
  assert.equal(result.content_type, 'application/json');
});

test('fetchSource reads inline JSON array', async () => {
  const spec = '[{"x":1}]';
  const result = await fetchSource({ source: spec });
  assert.equal(result.body, spec);
  assert.equal(result.source_url, null);
  assert.equal(result.source_path, null);
});

// ---------------------------------------------------------------------------
// URL fetch (mock HTTP server)
// ---------------------------------------------------------------------------

function startMockServer(statusCode, body, contentType) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { 'Content-Type': contentType || 'application/json' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('fetchSource fetches URL and returns body', async () => {
  const payload = '{"openapi":"3.0.3","info":{"title":"Mock","version":"1"}}';
  const { server, port } = await startMockServer(200, payload, 'application/json');
  try {
    const result = await fetchSource({ source: `http://127.0.0.1:${port}/spec.json` });
    assert.equal(result.body, payload);
    assert.ok(result.source_url.startsWith('http://'), 'source_url must be the URL');
    assert.equal(result.source_path, null);
    assert.equal(result.content_type, 'application/json');
  } finally {
    await new Promise(r => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// Size cap rejection (>5 MB)
// ---------------------------------------------------------------------------

test('fetchSource throws ScrapeSizeError when file exceeds 5 MB', async () => {
  const tmp = path.join(os.tmpdir(), `apifier-big-test-${Date.now()}.json`);
  // Write 5 MB + 1 byte
  const bigBuf = Buffer.alloc(5 * 1024 * 1024 + 1, 'x');
  fs.writeFileSync(tmp, bigBuf);
  try {
    await assert.rejects(
      () => fetchSource({ source: tmp }),
      err => err instanceof ScrapeSizeError
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('fetchSource throws ScrapeSizeError when inline text exceeds 5 MB', async () => {
  // Make a >5MB JSON string: { "x": "..." }
  const padding = 'x'.repeat(5 * 1024 * 1024 + 100);
  const inline = `{"openapi":"3.0.3","x":"${padding}"}`;
  await assert.rejects(
    () => fetchSource({ source: inline }),
    err => err instanceof ScrapeSizeError
  );
});

// ---------------------------------------------------------------------------
// 401 → AuthGatedError
// ---------------------------------------------------------------------------

test('fetchSource throws AuthGatedError on HTTP 401', async () => {
  const { server, port } = await startMockServer(401, 'Unauthorized', 'text/plain');
  try {
    await assert.rejects(
      () => fetchSource({ source: `http://127.0.0.1:${port}/private` }),
      err => err instanceof AuthGatedError && err.message.includes('401')
    );
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('fetchSource throws AuthGatedError on HTTP 403', async () => {
  const { server, port } = await startMockServer(403, 'Forbidden', 'text/plain');
  try {
    await assert.rejects(
      () => fetchSource({ source: `http://127.0.0.1:${port}/forbidden` }),
      err => err instanceof AuthGatedError && err.message.includes('403')
    );
  } finally {
    await new Promise(r => server.close(r));
  }
});
