'use strict';

// tests/unit/codegen-ts-axios.test.js — Unit tests for lib/codegen/ts-axios.js.

const { test }      = require('node:test');
const assert        = require('node:assert/strict');
const path          = require('node:path');
const fs            = require('node:fs');
const os            = require('node:os');
const { execSync }  = require('node:child_process');

const { generate }  = require(path.join(__dirname, '../../lib/codegen/ts-axios'));
const MAPPING_PATH  = path.join(__dirname, '../fixtures/sample-mapping-v1.json');
const EXPECTED_PATH = path.join(__dirname, '../fixtures/expected-ts-axios.ts');

const MAPPING = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// (a) Non-empty .ts output
// ---------------------------------------------------------------------------

test('ts-axios generate() returns a non-empty .ts string', () => {
  const { text, ext } = generate(MAPPING);
  assert.equal(ext, '.ts', 'extension must be .ts');
  assert.ok(typeof text === 'string' && text.length > 0, 'text must be non-empty string');
});

// ---------------------------------------------------------------------------
// (b) Byte-determinism
// ---------------------------------------------------------------------------

test('ts-axios generate() is byte-deterministic for the same input', () => {
  const { text: text1 } = generate(MAPPING);
  const { text: text2 } = generate(MAPPING);
  assert.equal(text1, text2, 'two runs over same mapping must produce identical output');
});

// ---------------------------------------------------------------------------
// (c) `import axios` present
// ---------------------------------------------------------------------------

test('ts-axios generate() includes axios import', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes("import axios from 'axios'"), 'must import axios');
  assert.ok(text.includes('npm install axios'), 'must have install comment');
});

// ---------------------------------------------------------------------------
// (d) One method per endpoint
// ---------------------------------------------------------------------------

test('ts-axios generate() emits one method per endpoint', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('async getWidget('), 'must contain getWidget method');
  assert.ok(text.includes('async createWidget('), 'must contain createWidget method');
  const methodCount = (text.match(/async \w+\(/g) || []).length;
  assert.equal(methodCount, MAPPING.endpoints.length, 'method count must equal endpoint count');
});

// ---------------------------------------------------------------------------
// (e) One type per model
// ---------------------------------------------------------------------------

test('ts-axios generate() emits one type per model', () => {
  const { text } = generate(MAPPING);
  for (const model of MAPPING.models) {
    assert.ok(
      text.includes(`export interface ${model.name}`) || text.includes(`export type ${model.name}`),
      `must emit type for model: ${model.name}`
    );
  }
});

// ---------------------------------------------------------------------------
// (f) Reserved-keyword sanitisation
// ---------------------------------------------------------------------------

test('ts-axios generate() suffixes _op for reserved-keyword operation ids', () => {
  const mappingWithReserved = JSON.parse(JSON.stringify(MAPPING));
  mappingWithReserved.endpoints = [
    {
      ...MAPPING.endpoints[0],
      id: 'delete',
      method: 'DELETE',
      path: '/widgets/{id}',
    }
  ];
  const { text } = generate(mappingWithReserved);
  assert.ok(text.includes('async delete_op('), 'reserved keyword "delete" must become delete_op');
  assert.ok(!text.includes('async delete('), 'must not use bare "delete" as method name');
});

// ---------------------------------------------------------------------------
// (g) Golden-file byte match
// ---------------------------------------------------------------------------

test('ts-axios generate() output is byte-identical to expected-ts-axios.ts golden file', () => {
  const { text } = generate(MAPPING);
  const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
  assert.equal(text, expected, 'output must be byte-identical to golden fixture');
});

// ---------------------------------------------------------------------------
// (h) node --check passes on generated output
// ---------------------------------------------------------------------------

test('ts-axios generate() produces output that passes node --check', () => {
  const { text } = generate(MAPPING);
  const tmpFile = path.join(os.tmpdir(), `apifier-ts-axios-check-${process.pid}.ts`);
  try {
    fs.writeFileSync(tmpFile, text, 'utf8');
    execSync(`node --check ${JSON.stringify(tmpFile)}`, { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

test('ts-axios generate() emits setBearerToken for http-bearer auth scheme', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('setBearerToken'), 'must emit setBearerToken');
});

test('ts-axios generate() emits setApiKey for api-key auth scheme', () => {
  const mappingWithApiKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithApiKey.auth = [{ id: 'apikey', type: 'api-key', in: 'header', name: 'X-API-Key' }];
  mappingWithApiKey.endpoints = mappingWithApiKey.endpoints.map(ep => ({ ...ep, auth: ['apikey'] }));
  const { text } = generate(mappingWithApiKey);
  assert.ok(text.includes('setApiKey'), 'must emit setApiKey');
});

test('ts-axios generate() emits setBasicAuth for http-basic auth scheme', () => {
  const mappingWithBasic = JSON.parse(JSON.stringify(MAPPING));
  mappingWithBasic.auth = [{ id: 'basic', type: 'http-basic', description: 'Basic auth' }];
  mappingWithBasic.endpoints = mappingWithBasic.endpoints.map(ep => ({ ...ep, auth: ['basic'] }));
  const { text } = generate(mappingWithBasic);
  assert.ok(text.includes('setBasicAuth'), 'must emit setBasicAuth');
});

// ---------------------------------------------------------------------------
// api-key in:query appends to _params (regression guard)
// ---------------------------------------------------------------------------

test('ts-axios generate() appends api-key/in:query to _params', () => {
  const mappingWithQueryKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithQueryKey.auth = [{ id: 'qkey', type: 'api-key', in: 'query', name: 'api_key' }];
  mappingWithQueryKey.endpoints = mappingWithQueryKey.endpoints.map(ep => ({ ...ep, auth: ['qkey'] }));
  const { text } = generate(mappingWithQueryKey);
  assert.ok(text.includes('_params[this._apiKeyName]'), 'must append api-key to _params for in:query');
});

// ---------------------------------------------------------------------------
// Header comment
// ---------------------------------------------------------------------------

test('ts-axios generate() output contains the prescribed header comment', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.startsWith('// Generated by apifier'), 'must start with header comment');
  assert.ok(text.includes('Do not edit by hand'), 'header must say do not edit by hand');
  assert.ok(text.includes('// Init:'), 'header must contain init guide');
});

// ---------------------------------------------------------------------------
// Footer export
// ---------------------------------------------------------------------------

test('ts-axios generate() output ends with default export', () => {
  const { text } = generate(MAPPING);
  const trimmed = text.trimEnd();
  assert.ok(trimmed.endsWith('export default WidgetsApiClient;'), 'must end with default export');
});

// ---------------------------------------------------------------------------
// AxiosInstance type used
// ---------------------------------------------------------------------------

test('ts-axios generate() uses AxiosInstance type', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('AxiosInstance'), 'must reference AxiosInstance type');
});
