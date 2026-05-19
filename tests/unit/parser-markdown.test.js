'use strict';

// tests/unit/parser-markdown.test.js — parseMarkdown unit + end-to-end tests.

const { test }    = require('node:test');
const assert      = require('node:assert/strict');
const fs          = require('node:fs');
const path        = require('node:path');

const { parseMarkdown, PARSER_NAME, PARSER_VERSION } = require(path.join(__dirname, '../../lib/parsers/markdown'));
const { MarkdownParseError } = require(path.join(__dirname, '../../lib/errors'));
const { handleScrape } = require(path.join(__dirname, '../../lib/handlers/scrape'));

const FIXTURES = path.join(__dirname, '../fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------
// (a) readme-style fixture → >= 2 endpoints with method+path
// ---------------------------------------------------------------------------

test('parseMarkdown readme-style fixture extracts >= 2 endpoints with method+path', async () => {
  const body = readFixture('markdown-readme-style.md');
  const result = await parseMarkdown({ body, content_type: 'text/markdown', source_url: null });

  assert.ok(result.ir,                                'ir must be populated');
  assert.ok(result.ir.endpoints.length >= 2,          `expected >= 2 endpoints, got ${result.ir.endpoints.length}`);
  assert.ok(Array.isArray(result.warnings),           'warnings must be an array');
  assert.equal(result.parser.name,    PARSER_NAME);
  assert.equal(result.parser.version, PARSER_VERSION);

  for (const ep of result.ir.endpoints) {
    assert.ok(ep.method, `endpoint ${ep.id} must have method`);
    assert.ok(ep.path,   `endpoint ${ep.id} must have path`);
    assert.ok(ep.id,     `endpoint must have id`);
    assert.equal(ep.transport, 'http');
  }

  // Must include GET and DELETE endpoints from the fixture.
  const methods = result.ir.endpoints.map(e => e.method);
  assert.ok(methods.includes('GET'),    'should have GET endpoint');
  assert.ok(methods.includes('DELETE'), 'should have DELETE endpoint');
});

// ---------------------------------------------------------------------------
// (b) gitbook-style fixture → >= 1 endpoint
// ---------------------------------------------------------------------------

test('parseMarkdown gitbook-style fixture extracts >= 1 endpoint', async () => {
  const body = readFixture('markdown-gitbook-style.md');
  const result = await parseMarkdown({ body, content_type: 'text/markdown', source_url: null });

  assert.ok(result.ir,                                   'ir must be populated');
  assert.ok(result.ir.endpoints.length >= 1,             `expected >= 1 endpoint, got ${result.ir.endpoints.length}`);

  for (const ep of result.ir.endpoints) {
    assert.ok(ep.method, `endpoint must have method`);
    assert.ok(ep.path,   `endpoint must have path`);
  }
});

// ---------------------------------------------------------------------------
// (c) tiny / empty body → MarkdownParseError
// ---------------------------------------------------------------------------

test('parseMarkdown throws MarkdownParseError for empty body', async () => {
  await assert.rejects(
    () => parseMarkdown({ body: '', content_type: 'text/markdown', source_url: null }),
    (err) => {
      assert.ok(err instanceof MarkdownParseError, `expected MarkdownParseError, got ${err.constructor.name}`);
      assert.equal(err.code, -32010);
      return true;
    }
  );
});

test('parseMarkdown throws MarkdownParseError for short body (< 50 bytes)', async () => {
  await assert.rejects(
    () => parseMarkdown({ body: '# Hi\n', content_type: 'text/markdown', source_url: null }),
    (err) => {
      assert.ok(err instanceof MarkdownParseError);
      assert.equal(err.code, -32010);
      return true;
    }
  );
});

test('parseMarkdown throws MarkdownParseError for body with no endpoints', async () => {
  const body = '# API Documentation\n\nThis is a description with no endpoints or code blocks in this paragraph at all.\n';
  await assert.rejects(
    () => parseMarkdown({ body, content_type: 'text/markdown', source_url: null }),
    (err) => {
      assert.ok(err instanceof MarkdownParseError);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (d) x-source-format: "markdown" populated in extensions
// ---------------------------------------------------------------------------

test('parseMarkdown sets ir.extensions["x-source-format"] = "markdown"', async () => {
  const body = readFixture('markdown-readme-style.md');
  const result = await parseMarkdown({ body, content_type: 'text/markdown', source_url: null });

  assert.ok(result.ir.extensions,                             'extensions must exist');
  assert.equal(result.ir.extensions['x-source-format'], 'markdown', 'x-source-format must be "markdown"');
});

// ---------------------------------------------------------------------------
// (e) auth detection from top-level Authentication heading
// ---------------------------------------------------------------------------

test('parseMarkdown detects Bearer auth from Authentication heading', async () => {
  const body = readFixture('markdown-readme-style.md');
  const result = await parseMarkdown({ body, content_type: 'text/markdown', source_url: null });

  assert.ok(Array.isArray(result.ir.auth),                  'auth must be an array');
  assert.ok(result.ir.auth.length > 0,                      'should detect at least one auth scheme');

  const bearer = result.ir.auth.find(a => a.type === 'http-bearer');
  assert.ok(bearer, 'should detect http-bearer auth scheme');
});

test('parseMarkdown detects API key auth from API Keys heading', async () => {
  const body = readFixture('markdown-gitbook-style.md');
  const result = await parseMarkdown({ body, content_type: 'text/markdown', source_url: null });

  assert.ok(Array.isArray(result.ir.auth),                  'auth must be an array');
  assert.ok(result.ir.auth.length > 0,                      'should detect at least one auth scheme');

  const apiKey = result.ir.auth.find(a => a.type === 'api-key');
  assert.ok(apiKey, 'should detect api-key auth scheme');
});

// ---------------------------------------------------------------------------
// (f) end-to-end via handleScrape against the fixture file
// ---------------------------------------------------------------------------

test('handleScrape end-to-end: markdown-readme-style.md produces mapping with x-source-format=markdown', async () => {
  const fixturePath = path.join(FIXTURES, 'markdown-readme-style.md');
  const result = await handleScrape({
    source:       fixturePath,
    service_name: 'md-smoke-test',
    overwrite:    true,
  });

  assert.ok(result.output_path,                  'output_path must be set');
  assert.ok(result.endpoint_count >= 2,          `expected >= 2 endpoints, got ${result.endpoint_count}`);

  const mapping = JSON.parse(fs.readFileSync(result.output_path, 'utf8'));
  assert.equal(mapping.extensions['x-source-format'], 'markdown', 'x-source-format must be markdown');
  assert.equal(mapping.source.type, 'markdown', 'source.type must be markdown');
  assert.equal(mapping.source.parser.name,    'apifier-markdown-parser', 'source.parser.name must be apifier-markdown-parser');
  assert.equal(mapping.source.parser.version, '0.0.1',                   'source.parser.version must be 0.0.1');
  assert.ok(mapping.endpoints.length >= 2,       `expected >= 2 mapped endpoints`);

  // Multi-response coverage (W24-I-11 regression guard): GET /users/{id} in
  // the readme-style fixture has both a 200 and a 404 example. Both must
  // round-trip to distinct entries in endpoint.responses, NOT collapse to
  // whichever response heading was last seen during the forward scan.
  const getById = mapping.endpoints.find(e =>
    e.method === 'GET' && e.path.includes('/users/{id}'));
  if (getById) {
    assert.ok(getById.responses['200'], 'GET /users/{id} must have a 200 response entry');
    assert.ok(getById.responses['404'], 'GET /users/{id} must have a 404 response entry');
    const ex200 = getById.extensions && getById.extensions['x-response-example-200'];
    const ex404 = getById.extensions && getById.extensions['x-response-example-404'];
    assert.ok(ex200, 'GET /users/{id} must have x-response-example-200');
    assert.ok(ex404, 'GET /users/{id} must have x-response-example-404');
    assert.notEqual(ex200, ex404, '200 and 404 example bodies must differ');
  }

  // Cleanup output file.
  try { fs.unlinkSync(result.output_path); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Parser signature: returns {ir, warnings, parser}
// ---------------------------------------------------------------------------

test('parseMarkdown returns correct shape: {ir, warnings, parser}', async () => {
  const body = readFixture('markdown-readme-style.md');
  const result = await parseMarkdown({ body, content_type: 'text/markdown', source_url: 'file:///test.md' });

  assert.ok('ir'       in result, 'result must have ir');
  assert.ok('warnings' in result, 'result must have warnings');
  assert.ok('parser'   in result, 'result must have parser');
  assert.ok(typeof result.parser.name    === 'string', 'parser.name must be string');
  assert.ok(typeof result.parser.version === 'string', 'parser.version must be string');
  assert.ok(Array.isArray(result.warnings),             'warnings must be array');
});

// ---------------------------------------------------------------------------
// Path param extraction
// ---------------------------------------------------------------------------

test('parseMarkdown extracts path params from {param} in path', async () => {
  const body = readFixture('markdown-readme-style.md');
  const result = await parseMarkdown({ body, content_type: 'text/markdown', source_url: null });

  const getUsers = result.ir.endpoints.find(e => e.method === 'GET' && e.path.includes('{id}'));
  assert.ok(getUsers,                              'GET /users/{id} endpoint must exist');
  assert.ok(getUsers.path_params.length >= 1,     'should have at least 1 path param');
  assert.equal(getUsers.path_params[0].name, 'id', 'path param name must be id');
  assert.equal(getUsers.path_params[0].required, true, 'path param must be required');
});

// ---------------------------------------------------------------------------
// ReDoS safety: 64 KB of # characters finishes in < 100 ms
// ---------------------------------------------------------------------------

test('parseMarkdown: 64 KB of # characters finishes in < 100 ms (ReDoS safety)', async () => {
  const pathologicalBody = '#'.repeat(65536);
  const start = Date.now();
  try {
    await parseMarkdown({ body: pathologicalBody, content_type: 'text/plain', source_url: null });
  } catch (_) {
    // MarkdownParseError is expected here; we only care about timing.
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `expected < 100 ms, took ${elapsed} ms`);
});
