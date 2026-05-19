'use strict';

// tests/unit/codegen-ts-fetch.test.js — Unit tests for lib/codegen/ts-fetch.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');

const { generate }  = require(path.join(__dirname, '../../lib/codegen/ts-fetch'));
const MAPPING_PATH  = path.join(__dirname, '../fixtures/sample-mapping-v1.json');
const EXPECTED_PATH = path.join(__dirname, '../fixtures/expected-ts-fetch.ts');

// Load fixture once
const MAPPING = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// (a) Non-empty TypeScript output from sample-mapping-v1.json
// ---------------------------------------------------------------------------

test('generate() returns a non-empty .ts string from sample-mapping-v1.json', () => {
  const { text, ext } = generate(MAPPING);
  assert.equal(ext, '.ts', 'extension must be .ts');
  assert.ok(typeof text === 'string' && text.length > 0, 'text must be non-empty string');
  assert.ok(text.includes('export'), 'must contain export statements');
});

// ---------------------------------------------------------------------------
// (b) Output contains the expected <ServiceName>Client class
// ---------------------------------------------------------------------------

test('generate() output contains WidgetsApiClient class', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('class WidgetsApiClient'), 'must contain class WidgetsApiClient');
  assert.ok(text.includes('export class WidgetsApiClient'), 'class must be exported');
});

// ---------------------------------------------------------------------------
// (c) Emits one method per endpoint
// ---------------------------------------------------------------------------

test('generate() emits one method per endpoint', () => {
  const { text } = generate(MAPPING);
  // The fixture has two endpoints: getWidget and createWidget
  assert.ok(text.includes('async getWidget('), 'must contain getWidget method');
  assert.ok(text.includes('async createWidget('), 'must contain createWidget method');
  // Count endpoint methods — each endpoint corresponds to one async method
  const methodCount = (text.match(/async \w+\(/g) || []).length;
  assert.equal(methodCount, MAPPING.endpoints.length, 'method count must equal endpoint count');
});

// ---------------------------------------------------------------------------
// (d) Byte-deterministic: two runs produce identical strings
// ---------------------------------------------------------------------------

test('generate() is byte-deterministic for the same input', () => {
  const { text: text1 } = generate(MAPPING);
  const { text: text2 } = generate(MAPPING);
  assert.equal(text1, text2, 'two runs over same mapping must produce identical output');
});

// ---------------------------------------------------------------------------
// (e) Auth helpers match the mapping's auth schemes
// ---------------------------------------------------------------------------

test('generate() emits setBearerToken for http-bearer auth scheme', () => {
  const { text } = generate(MAPPING);
  // sample-mapping-v1 has a single http-bearer scheme
  assert.ok(text.includes('setBearerToken'), 'must emit setBearerToken for http-bearer scheme');
  assert.ok(text.includes("Authorization"), 'must include Authorization header usage');
});

test('generate() emits setApiKey for api-key auth scheme', () => {
  const mappingWithApiKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithApiKey.auth = [
    { id: 'apikey', type: 'api-key', in: 'header', name: 'X-API-Key' }
  ];
  mappingWithApiKey.endpoints = mappingWithApiKey.endpoints.map(ep => ({
    ...ep,
    auth: ['apikey'],
  }));
  const { text } = generate(mappingWithApiKey);
  assert.ok(text.includes('setApiKey'), 'must emit setApiKey for api-key scheme');
});

test('generate() emits setBasicAuth for http-basic auth scheme', () => {
  const mappingWithBasic = JSON.parse(JSON.stringify(MAPPING));
  mappingWithBasic.auth = [
    { id: 'basic', type: 'http-basic', description: 'Basic auth' }
  ];
  mappingWithBasic.endpoints = mappingWithBasic.endpoints.map(ep => ({
    ...ep,
    auth: ['basic'],
  }));
  const { text } = generate(mappingWithBasic);
  assert.ok(text.includes('setBasicAuth'), 'must emit setBasicAuth for http-basic scheme');
});

test('generate() emits TODO comment for unsupported auth scheme (oauth2)', () => {
  const mappingWithOAuth = JSON.parse(JSON.stringify(MAPPING));
  mappingWithOAuth.auth = [
    { id: 'oauth2-cc', type: 'oauth2', flow: 'client_credentials' }
  ];
  mappingWithOAuth.endpoints = mappingWithOAuth.endpoints.map(ep => ({
    ...ep,
    auth: ['oauth2-cc'],
  }));
  const { text } = generate(mappingWithOAuth);
  assert.ok(text.includes('TODO(wave 4B): oauth2'), 'must emit TODO for unsupported oauth2 scheme');
});

// ---------------------------------------------------------------------------
// (f) Reserved-keyword endpoint names get _op suffix
// ---------------------------------------------------------------------------

test('generate() suffixes _op for reserved-keyword operation ids', () => {
  const mappingWithReserved = JSON.parse(JSON.stringify(MAPPING));
  mappingWithReserved.endpoints = [
    {
      ...MAPPING.endpoints[0],
      id: 'delete',            // JS reserved keyword
      method: 'DELETE',
      path: '/widgets/{id}',
    }
  ];
  const { text } = generate(mappingWithReserved);
  assert.ok(text.includes('async delete_op('), 'reserved keyword "delete" must become delete_op');
  assert.ok(!text.includes('async delete('), 'must not use bare "delete" as method name');
});

// ---------------------------------------------------------------------------
// Determinism against golden file
// ---------------------------------------------------------------------------

test('generate() output is byte-identical to expected-ts-fetch.ts golden file', () => {
  const { text } = generate(MAPPING);
  const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
  assert.equal(text, expected, 'output must be byte-identical to golden fixture');
});

// ---------------------------------------------------------------------------
// Type aliases: one per model
// ---------------------------------------------------------------------------

test('generate() emits one interface per model', () => {
  const { text } = generate(MAPPING);
  for (const model of MAPPING.models) {
    assert.ok(
      text.includes(`export interface ${model.name}`) || text.includes(`export type ${model.name}`),
      `must emit type for model: ${model.name}`
    );
  }
});

// ---------------------------------------------------------------------------
// Header comment is present
// ---------------------------------------------------------------------------

test('generate() output contains the prescribed header comment', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.startsWith('// Generated by apifier'), 'must start with header comment');
  assert.ok(text.includes('schema_version'), 'header must mention schema_version');
  assert.ok(text.includes('Do not edit by hand'), 'header must say do not edit by hand');
  assert.ok(text.includes('// Init:'), 'header must contain init guide');
});

// ---------------------------------------------------------------------------
// Footer export
// ---------------------------------------------------------------------------

test('generate() output ends with default export', () => {
  const { text } = generate(MAPPING);
  const trimmed = text.trimEnd();
  assert.ok(trimmed.endsWith('export default WidgetsApiClient;'), 'must end with default export');
});
