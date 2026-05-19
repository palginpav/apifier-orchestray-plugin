'use strict';

// tests/unit/parser-html.test.js — parseHTML end-to-end tests against each fixture.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('node:fs');
const path      = require('node:path');

const { parseHTML, PARSER_NAME, PARSER_VERSION } = require(path.join(__dirname, '../../lib/parsers/html'));
const { HTMLParseError } = require(path.join(__dirname, '../../lib/errors'));

const FIXTURES = path.join(__dirname, '../fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------
// openapi-rendered: returns redirect_to_spec with same-origin URL
// ---------------------------------------------------------------------------

test('parseHTML openapi-rendered fixture returns redirect_to_spec', async () => {
  const body = readFixture('html-openapi-rendered.html');
  const result = await parseHTML({
    body,
    content_type: 'text/html',
    source_url: 'https://example.com/docs',
  });

  assert.equal(result.ir, null, 'ir should be null for redirect');
  assert.ok(result.redirect_to_spec, 'redirect_to_spec should be present');
  assert.ok(result.redirect_to_spec.url, 'redirect_to_spec.url should be set');
  assert.ok(result.redirect_to_spec.url.includes('openapi.json'), 'should reference openapi.json');
  assert.equal(result.redirect_to_spec.source_archetype, 'swagger-ui');
  assert.ok(result.parser);
  assert.equal(result.parser.name, PARSER_NAME);
  assert.equal(result.parser.version, PARSER_VERSION);
});

// ---------------------------------------------------------------------------
// stripe-slate: >= 2 endpoints with method+path
// ---------------------------------------------------------------------------

test('parseHTML stripe-slate fixture extracts >= 2 endpoints', async () => {
  const body = readFixture('html-stripe-slate.html');
  const result = await parseHTML({
    body,
    content_type: 'text/html',
    source_url: 'https://api.example.com/docs',
  });

  assert.ok(result.ir, 'ir should be populated');
  assert.ok(result.ir.endpoints.length >= 2, `expected >= 2 endpoints, got ${result.ir.endpoints.length}`);

  const methods = result.ir.endpoints.map(e => e.method);
  assert.ok(methods.includes('POST'), 'POST endpoint');
  assert.ok(methods.includes('GET'),  'GET endpoint');

  // Each endpoint must have method + path
  for (const ep of result.ir.endpoints) {
    assert.ok(ep.method, 'endpoint.method required');
    assert.ok(ep.path,   'endpoint.path required');
    assert.ok(ep['x-origin'], 'x-origin provenance required');
    assert.ok(ep['x-origin'].source_url, 'x-origin.source_url required');
  }

  // x-html-archetype extension recorded
  assert.equal(result.ir.extensions['x-html-archetype'], 'stripe-slate');
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.parser.name, PARSER_NAME);
});

// ---------------------------------------------------------------------------
// docusaurus: >= 1 endpoint
// ---------------------------------------------------------------------------

test('parseHTML docusaurus fixture extracts >= 1 endpoint', async () => {
  const body = readFixture('html-docusaurus.html');
  const result = await parseHTML({
    body,
    content_type: 'text/html',
    source_url: 'https://docs.example.com/api',
  });

  assert.ok(result.ir, 'ir should be populated');
  assert.ok(result.ir.endpoints.length >= 1, `expected >= 1 endpoint, got ${result.ir.endpoints.length}`);
  assert.equal(result.ir.extensions['x-html-archetype'], 'docusaurus');
});

// ---------------------------------------------------------------------------
// generic: >= 1 endpoint
// ---------------------------------------------------------------------------

test('parseHTML generic fixture extracts >= 1 endpoint', async () => {
  const body = readFixture('html-generic.html');
  const result = await parseHTML({
    body,
    content_type: 'text/html',
    source_url: 'https://example.com/api-docs',
  });

  assert.ok(result.ir, 'ir should be populated');
  assert.ok(result.ir.endpoints.length >= 1, `expected >= 1 endpoint`);
  assert.equal(result.ir.extensions['x-html-archetype'], 'generic');
  assert.ok(result.warnings.some(w => w.includes('low_confidence')), 'generic should have low_confidence warnings');
});

// ---------------------------------------------------------------------------
// readme: >= 1 endpoint (generic fallback handles it)
// ---------------------------------------------------------------------------

test('parseHTML readme fixture extracts >= 1 endpoint or throws HTMLParseError', async () => {
  const body = readFixture('html-readme.html');
  try {
    const result = await parseHTML({
      body,
      content_type: 'text/html',
      source_url: 'https://example.com/readme',
    });
    // If it succeeds, must have endpoints
    assert.ok(result.ir.endpoints.length >= 1, 'readme has GET /status');
  } catch (err) {
    // HTMLParseError is acceptable if no endpoints found
    assert.ok(err instanceof HTMLParseError, `expected HTMLParseError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, -32008);
  }
});

// ---------------------------------------------------------------------------
// Refusal: empty body
// ---------------------------------------------------------------------------

test('parseHTML throws HTMLParseError on empty body', async () => {
  await assert.rejects(
    () => parseHTML({ body: '', content_type: 'text/html', source_url: null }),
    err => {
      assert.ok(err instanceof HTMLParseError);
      assert.equal(err.code, -32008);
      return true;
    }
  );
});

test('parseHTML throws HTMLParseError on too-short body', async () => {
  await assert.rejects(
    () => parseHTML({ body: '<html><body>hi</body></html>', content_type: 'text/html', source_url: null }),
    err => {
      assert.ok(err instanceof HTMLParseError);
      assert.equal(err.code, -32008);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Refusal: no endpoints found
// ---------------------------------------------------------------------------

test('parseHTML throws HTMLParseError on page with no API endpoints', async () => {
  const body = `<!DOCTYPE html>
<html><head><title>Blog Post</title></head>
<body>
  <h1>My Blog Post</h1>
  <p>This is a blog post about cats. It has nothing to do with APIs.</p>
  <p>Cats are great. Here is some content that makes the body long enough to pass the 200-byte check.</p>
  <p>More content here to ensure we exceed the minimum body size threshold.</p>
</body></html>`;

  await assert.rejects(
    () => parseHTML({ body, content_type: 'text/html', source_url: 'https://example.com/blog' }),
    err => {
      assert.ok(err instanceof HTMLParseError);
      assert.equal(err.code, -32008);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Parser metadata
// ---------------------------------------------------------------------------

test('parseHTML exports PARSER_NAME and PARSER_VERSION', () => {
  assert.equal(typeof PARSER_NAME, 'string');
  assert.equal(typeof PARSER_VERSION, 'string');
  assert.ok(PARSER_NAME.length > 0);
  assert.ok(PARSER_VERSION.length > 0);
});

// ---------------------------------------------------------------------------
// x-html-archetype extension on all successful parses
// ---------------------------------------------------------------------------

test('parseHTML records x-html-archetype on every successful parse', async () => {
  const fixtures = [
    { file: 'html-stripe-slate.html', url: 'https://example.com/docs' },
    { file: 'html-docusaurus.html',   url: 'https://docs.example.com/api' },
    { file: 'html-generic.html',      url: 'https://example.com/api' },
  ];

  for (const { file, url } of fixtures) {
    const body = readFixture(file);
    const result = await parseHTML({ body, content_type: 'text/html', source_url: url });
    if (result.ir) {
      assert.ok(
        result.ir.extensions && result.ir.extensions['x-html-archetype'],
        `x-html-archetype missing for ${file}`
      );
    }
  }
});
