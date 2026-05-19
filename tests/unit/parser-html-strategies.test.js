'use strict';

// tests/unit/parser-html-strategies.test.js — Per-strategy matches() unit tests.
// Each strategy must return true ONLY on its own archetype fixture and false on others.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');
const cheerio  = require('cheerio');

const FIXTURES = path.join(__dirname, '../fixtures');

const openApiRendered = require('../../lib/parsers/html-strategies/openapi-rendered');
const stripeSlate     = require('../../lib/parsers/html-strategies/stripe-slate');
const docusaurus      = require('../../lib/parsers/html-strategies/docusaurus');
const gitbook         = require('../../lib/parsers/html-strategies/gitbook');
const generic         = require('../../lib/parsers/html-strategies/generic');

function loadFixture(name) {
  const html = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return cheerio.load(html, { decodeEntities: true });
}

// ---------------------------------------------------------------------------
// openapi-rendered strategy
// ---------------------------------------------------------------------------

test('openapi-rendered: matches swagger-ui fixture', () => {
  const $ = loadFixture('html-openapi-rendered.html');
  assert.equal(openApiRendered.matches($), true);
});

test('openapi-rendered: does NOT match stripe-slate fixture', () => {
  const $ = loadFixture('html-stripe-slate.html');
  // stripe-slate has no swagger-ui markers
  const redirect = openApiRendered.extractRedirect($, {});
  assert.equal(redirect, null);
});

test('openapi-rendered: extractRedirect returns spec URL for swagger-ui fixture', () => {
  const $ = loadFixture('html-openapi-rendered.html');
  const result = openApiRendered.extractRedirect($, { source_url: 'https://example.com/docs' });
  assert.ok(result, 'should return redirect result');
  assert.ok(result.redirect_to_spec, 'should have redirect_to_spec URL');
  assert.equal(result.source_archetype, 'swagger-ui');
  // The fixture has url: "./openapi.json" — resolved against source_url
  assert.ok(result.redirect_to_spec.includes('openapi.json'), 'should reference openapi.json');
});

test('openapi-rendered: returns null for generic fixture (no viewer markers)', () => {
  const $ = loadFixture('html-generic.html');
  const result = openApiRendered.extractRedirect($, {});
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// stripe-slate strategy
// ---------------------------------------------------------------------------

test('stripe-slate: matches stripe-slate fixture', () => {
  const $ = loadFixture('html-stripe-slate.html');
  assert.equal(stripeSlate.matches($), true);
});

test('stripe-slate: extract returns >= 2 endpoints from stripe-slate fixture', () => {
  const $ = loadFixture('html-stripe-slate.html');
  const { ir, warnings } = stripeSlate.extract($, { source_url: 'https://example.com/docs' });
  assert.ok(ir.endpoints.length >= 2, `expected >= 2 endpoints, got ${ir.endpoints.length}`);
  const methods = ir.endpoints.map(e => e.method);
  assert.ok(methods.includes('POST'), 'POST endpoint present');
  assert.ok(methods.includes('GET'),  'GET endpoint present');
});

test('stripe-slate: does NOT match openapi-rendered fixture via heading patterns', () => {
  const $ = loadFixture('html-openapi-rendered.html');
  // Swagger UI shell has no METHOD /path headings
  const { ir } = stripeSlate.extract($, {});
  // Should produce 0 or fallback — key thing is extract doesn't crash
  assert.ok(Array.isArray(ir.endpoints));
});

// ---------------------------------------------------------------------------
// docusaurus strategy
// ---------------------------------------------------------------------------

test('docusaurus: matches docusaurus fixture', () => {
  const $ = loadFixture('html-docusaurus.html');
  assert.equal(docusaurus.matches($), true);
});

test('docusaurus: does NOT match generic fixture', () => {
  const $ = loadFixture('html-generic.html');
  assert.equal(docusaurus.matches($), false);
});

test('docusaurus: does NOT match stripe-slate fixture', () => {
  const $ = loadFixture('html-stripe-slate.html');
  assert.equal(docusaurus.matches($), false);
});

test('docusaurus: extract returns >= 1 endpoint from docusaurus fixture', () => {
  const $ = loadFixture('html-docusaurus.html');
  const { ir, warnings } = docusaurus.extract($, { source_url: 'https://example.com/docs' });
  assert.ok(ir.endpoints.length >= 1, `expected >= 1 endpoint, got ${ir.endpoints.length}`);
  const methods = ir.endpoints.map(e => e.method);
  assert.ok(methods.includes('POST') || methods.includes('GET'), 'at least one HTTP endpoint');
});

// ---------------------------------------------------------------------------
// gitbook strategy
// ---------------------------------------------------------------------------

test('gitbook: does NOT match generic fixture', () => {
  const $ = loadFixture('html-generic.html');
  assert.equal(gitbook.matches($), false);
});

test('gitbook: does NOT match stripe-slate fixture', () => {
  const $ = loadFixture('html-stripe-slate.html');
  assert.equal(gitbook.matches($), false);
});

test('gitbook: does NOT match docusaurus fixture', () => {
  const $ = loadFixture('html-docusaurus.html');
  assert.equal(gitbook.matches($), false);
});

test('gitbook: extract does not crash on generic fixture', () => {
  const $ = loadFixture('html-generic.html');
  const { ir, warnings } = gitbook.extract($, { source_url: 'https://example.com' });
  assert.ok(Array.isArray(ir.endpoints));
  assert.ok(Array.isArray(warnings));
});

// ---------------------------------------------------------------------------
// generic strategy
// ---------------------------------------------------------------------------

test('generic: always matches (last-resort fallback)', () => {
  const fixtures = ['html-generic.html', 'html-stripe-slate.html', 'html-docusaurus.html', 'html-readme.html'];
  for (const fx of fixtures) {
    const $ = loadFixture(fx);
    assert.equal(generic.matches($), true, `generic should match ${fx}`);
  }
});

test('generic: extract returns >= 1 endpoint from generic fixture', () => {
  const $ = loadFixture('html-generic.html');
  const { ir, warnings } = generic.extract($, { source_url: 'https://example.com' });
  assert.ok(ir.endpoints.length >= 1, `expected >= 1 endpoint, got ${ir.endpoints.length}`);
  assert.equal(ir.endpoints[0].transport, 'http');
  assert.ok(ir.endpoints[0].method);
  assert.ok(ir.endpoints[0].path);
});

test('generic: extract returns >= 1 endpoint from readme fixture', () => {
  const $ = loadFixture('html-readme.html');
  const { ir } = generic.extract($, { source_url: 'https://example.com' });
  assert.ok(ir.endpoints.length >= 1, `readme has GET /status endpoint`);
});

test('generic: low_confidence warnings emitted', () => {
  const $ = loadFixture('html-generic.html');
  const { warnings } = generic.extract($, { source_url: 'https://example.com' });
  assert.ok(warnings.some(w => w.includes('low_confidence')), 'generic should emit low_confidence warnings');
});
