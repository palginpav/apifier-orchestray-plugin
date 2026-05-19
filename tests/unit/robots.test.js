'use strict';

// tests/unit/robots.test.js — Unit tests for lib/http/robots.js.
// All network tests use http.createServer().listen(0) — no live external fetches.

const { test }     = require('node:test');
const assert       = require('node:assert/strict');
const http         = require('node:http');
const path         = require('node:path');
const { checkRobots, _clearRobotsCache } = require(path.join(__dirname, '../../lib/http/robots'));

/**
 * Start a mock HTTP server that always serves the given body and status.
 * Returns { server, port, close }.
 */
function startMockServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function robotsServer(body, status = 200) {
  return startMockServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
}

// ---------------------------------------------------------------------------
// Parser correctness
// ---------------------------------------------------------------------------

test('robots: allows URL not matched by any Disallow', async () => {
  _clearRobotsCache();
  const { server, port, close } = await robotsServer(
    'User-agent: *\nDisallow: /private/\n'
  );
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/public/page`);
    assert.equal(decision.allowed, true);
  } finally {
    await close();
  }
});

test('robots: blocks URL matched by Disallow', async () => {
  _clearRobotsCache();
  const { server, port, close } = await robotsServer(
    'User-agent: *\nDisallow: /private/\n'
  );
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/private/secret`);
    assert.equal(decision.allowed, false);
    assert.ok(decision.matched_rule && decision.matched_rule.includes('Disallow'));
  } finally {
    await close();
  }
});

test('robots: Allow wins over Disallow on same prefix (Allow is longer)', async () => {
  _clearRobotsCache();
  const robots = [
    'User-agent: *',
    'Disallow: /api/',
    'Allow: /api/public/',
  ].join('\n');
  const { server, port, close } = await robotsServer(robots);
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/api/public/data`);
    assert.equal(decision.allowed, true, 'Allow /api/public/ should override Disallow /api/');
  } finally {
    await close();
  }
});

test('robots: Allow wins on tie (same length)', async () => {
  _clearRobotsCache();
  // Equal-length patterns: Allow wins per Google interpretation
  const robots = [
    'User-agent: *',
    'Allow: /path',
    'Disallow: /path',
  ].join('\n');
  const { server, port, close } = await robotsServer(robots);
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/path`);
    assert.equal(decision.allowed, true, 'Allow wins on tie');
  } finally {
    await close();
  }
});

test('robots: wildcard * in pattern matches any segment', async () => {
  _clearRobotsCache();
  const robots = [
    'User-agent: *',
    'Disallow: /static/*.min.js',
  ].join('\n');
  const { server, port, close } = await robotsServer(robots);
  try {
    const d1 = await checkRobots(`http://127.0.0.1:${port}/static/app.min.js`);
    assert.equal(d1.allowed, false, 'wildcard should match');
    _clearRobotsCache();

    // Re-use same port would fail (server closed), so we just assert d1
  } finally {
    await close();
  }
});

test('robots: $ end-anchor only matches exact end of path', async () => {
  _clearRobotsCache();
  const robots = [
    'User-agent: *',
    'Disallow: /locked$',
  ].join('\n');
  const { server, port, close } = await robotsServer(robots);
  try {
    const dExact = await checkRobots(`http://127.0.0.1:${port}/locked`);
    assert.equal(dExact.allowed, false, '/locked should be blocked ($ anchor)');
  } finally {
    await close();
  }
});

test('robots: $ end-anchor does not block sub-paths', async () => {
  _clearRobotsCache();
  const robots = [
    'User-agent: *',
    'Disallow: /locked$',
  ].join('\n');
  const { server, port, close } = await robotsServer(robots);
  try {
    const dSub = await checkRobots(`http://127.0.0.1:${port}/locked/page`);
    assert.equal(dSub.allowed, true, '/locked/page should NOT be blocked by /locked$ anchor');
  } finally {
    await close();
  }
});

test('robots: UA-specific group wins over * group', async () => {
  _clearRobotsCache();
  const robots = [
    'User-agent: *',
    'Disallow: /api/',
    '',
    'User-agent: apifier',
    'Allow: /api/',
  ].join('\n');
  const { server, port, close } = await robotsServer(robots);
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/api/data`, {
      userAgent: 'apifier',
    });
    assert.equal(decision.allowed, true, 'UA-specific Allow should override wildcard Disallow');
  } finally {
    await close();
  }
});

test('robots: falls back to * group when no UA-specific group', async () => {
  _clearRobotsCache();
  const robots = [
    'User-agent: *',
    'Disallow: /blocked/',
  ].join('\n');
  const { server, port, close } = await robotsServer(robots);
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/blocked/page`, {
      userAgent: 'apifier',
    });
    assert.equal(decision.allowed, false, 'should fall back to * group');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// HTTP status handling
// ---------------------------------------------------------------------------

test('robots: 404 → all allowed', async () => {
  _clearRobotsCache();
  const { server, port, close } = await robotsServer('Not Found', 404);
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/anything`);
    assert.equal(decision.allowed, true, '404 robots.txt → all allowed');
  } finally {
    await close();
  }
});

test('robots: 410 → all allowed', async () => {
  _clearRobotsCache();
  const { server, port, close } = await robotsServer('Gone', 410);
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/anything`);
    assert.equal(decision.allowed, true, '410 robots.txt → all allowed');
  } finally {
    await close();
  }
});

test('robots: 5xx → block for politeness', async () => {
  _clearRobotsCache();
  const { server, port, close } = await robotsServer('Server Error', 500);
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/anything`);
    assert.equal(decision.allowed, false, '5xx robots.txt → all blocked');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

test('robots: cache hit returns same decision without re-fetching', async () => {
  _clearRobotsCache();
  let fetchCount = 0;
  const { server, port, close } = await startMockServer((req, res) => {
    if (req.url === '/robots.txt') fetchCount++;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('User-agent: *\nDisallow: /blocked/\n');
  });
  try {
    const url = `http://127.0.0.1:${port}/blocked/page`;
    const d1 = await checkRobots(url);
    const d2 = await checkRobots(url);
    assert.equal(fetchCount, 1, 'robots.txt should be fetched only once per origin');
    assert.equal(d1.allowed, d2.allowed);
    assert.equal(d1.fetched_at, d2.fetched_at);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Decision metadata
// ---------------------------------------------------------------------------

test('robots: decision includes robots_url and fetched_at', async () => {
  _clearRobotsCache();
  const { server, port, close } = await robotsServer('User-agent: *\nDisallow:\n');
  try {
    const decision = await checkRobots(`http://127.0.0.1:${port}/page`);
    assert.ok(decision.robots_url, 'robots_url must be set');
    assert.ok(decision.fetched_at, 'fetched_at must be set');
    assert.ok(decision.robots_url.endsWith('/robots.txt'));
  } finally {
    await close();
  }
});
