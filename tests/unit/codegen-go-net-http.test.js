'use strict';

// tests/unit/codegen-go-net-http.test.js — Unit tests for lib/codegen/go-net-http.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');
const os        = require('node:os');
const { execSync } = require('node:child_process');

const { generate }  = require(path.join(__dirname, '../../lib/codegen/go-net-http'));
const MAPPING_PATH  = path.join(__dirname, '../fixtures/sample-mapping-v1.json');
const EXPECTED_PATH = path.join(__dirname, '../fixtures/expected-go-net-http.go');

// Load fixture once
const MAPPING = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// (a) Non-empty .go output from sample-mapping-v1.json
// ---------------------------------------------------------------------------

test('generate() returns a non-empty .go string from sample-mapping-v1.json', () => {
  const { text, ext } = generate(MAPPING);
  assert.equal(ext, '.go', 'extension must be .go');
  assert.ok(typeof text === 'string' && text.length > 0, 'text must be non-empty string');
  assert.ok(text.includes('package '), 'must contain package declaration');
  assert.ok(text.includes('func '), 'must contain func declarations');
});

// ---------------------------------------------------------------------------
// (b) Output contains expected <ServiceName>Client struct name
// ---------------------------------------------------------------------------

test('generate() output contains WidgetsApiClient struct', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('type WidgetsApiClient struct'), 'must contain type WidgetsApiClient struct');
  assert.ok(text.includes('func NewWidgetsApiClient('), 'must contain NewWidgetsApiClient constructor');
});

// ---------------------------------------------------------------------------
// (c) One method per endpoint
// ---------------------------------------------------------------------------

test('generate() emits one method per endpoint', () => {
  const { text } = generate(MAPPING);
  // Fixture has two endpoints: getWidget → GetWidget, createWidget → CreateWidget
  assert.ok(text.includes('func (c *WidgetsApiClient) GetWidget('), 'must contain GetWidget method');
  assert.ok(text.includes('func (c *WidgetsApiClient) CreateWidget('), 'must contain CreateWidget method');
  // Count func (c *Client) occurrences (excluding constructor and builder)
  const methodMatches = text.match(/func \(c \*WidgetsApiClient\) [A-Z]/g) || [];
  // Must have at least endpoint count methods (plus auth helpers + WithHTTPClient)
  assert.ok(
    methodMatches.length >= MAPPING.endpoints.length,
    `method count ${methodMatches.length} must be >= endpoint count ${MAPPING.endpoints.length}`
  );
});

// ---------------------------------------------------------------------------
// (d) One struct/type per model
// ---------------------------------------------------------------------------

test('generate() emits one type definition per model', () => {
  const { text } = generate(MAPPING);
  for (const model of MAPPING.models) {
    const name = model.name;
    // All exported type names start with uppercase first letter
    const exportedName = name.charAt(0).toUpperCase() + name.slice(1);
    assert.ok(
      text.includes(`type ${exportedName} struct`) || text.includes(`type ${exportedName} = `) || text.includes(`type ${exportedName} interface`),
      `must emit type definition for model: ${model.name}`
    );
  }
  // Count type <Name> struct declarations — should match object model count
  const structCount = (text.match(/^type \w+ struct/gm) || []).length;
  const objectModelCount = MAPPING.models.filter(m => m.kind === 'object').length;
  // structCount includes error types and client struct, so it must be >= object model count
  assert.ok(
    structCount >= objectModelCount,
    `struct type count ${structCount} must be >= object model count ${objectModelCount}`
  );
});

// ---------------------------------------------------------------------------
// (e) Byte-determinism: two runs produce identical strings
// ---------------------------------------------------------------------------

test('generate() is byte-deterministic for the same input', () => {
  const { text: text1 } = generate(MAPPING);
  const { text: text2 } = generate(MAPPING);
  assert.equal(text1, text2, 'two runs over same mapping must produce identical output');
});

// ---------------------------------------------------------------------------
// (f) Auth helpers: SetBearerToken present per the mapping's auth schemes
// ---------------------------------------------------------------------------

test('generate() emits SetBearerToken for http-bearer auth scheme', () => {
  const { text } = generate(MAPPING);
  // sample-mapping-v1 has a single http-bearer scheme
  assert.ok(text.includes('func (c *WidgetsApiClient) SetBearerToken('), 'must emit SetBearerToken for http-bearer scheme');
  assert.ok(text.includes('"Authorization"'), 'must include Authorization header usage');
});

test('generate() emits SetApiKey for api-key auth scheme (header position)', () => {
  const mappingWithApiKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithApiKey.auth = [
    { id: 'apikey', type: 'api-key', in: 'header', name: 'X-API-Key' }
  ];
  mappingWithApiKey.endpoints = mappingWithApiKey.endpoints.map(ep => ({
    ...ep,
    auth: ['apikey'],
  }));
  const { text } = generate(mappingWithApiKey);
  assert.ok(text.includes('func (c *'), 'must contain receiver methods');
  assert.ok(text.includes('SetApiKey('), 'must emit SetApiKey for api-key scheme');
});

test('generate() emits SetBasicAuth for http-basic auth scheme', () => {
  const mappingWithBasic = JSON.parse(JSON.stringify(MAPPING));
  mappingWithBasic.auth = [
    { id: 'basic', type: 'http-basic', description: 'Basic auth' }
  ];
  mappingWithBasic.endpoints = mappingWithBasic.endpoints.map(ep => ({
    ...ep,
    auth: ['basic'],
  }));
  const { text } = generate(mappingWithBasic);
  assert.ok(text.includes('SetBasicAuth('), 'must emit SetBasicAuth for http-basic scheme');
  assert.ok(text.includes('SetBasicAuth(user, password string)'), 'SetBasicAuth must accept user and password');
});

test('generate() emits api-key/in=query append to URL query values (W15-1 fix)', () => {
  const mappingWithQueryKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithQueryKey.auth = [
    { id: 'qkey', type: 'api-key', in: 'query', name: 'api_key' }
  ];
  mappingWithQueryKey.endpoints = mappingWithQueryKey.endpoints.map(ep => ({
    ...ep,
    auth: ['qkey'],
  }));
  const { text } = generate(mappingWithQueryKey);
  // Must append api key name+value to url.Values (not no-op it)
  assert.ok(text.includes('_qv.Set(c.apiKeyName, c.apiKeyValue)'), 'api-key/in=query must be appended to query values');
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
  assert.ok(text.includes('TODO(wave 4E): oauth2'), 'must emit TODO for unsupported oauth2 scheme');
});

// ---------------------------------------------------------------------------
// (g) Reserved Go keyword endpoint identifiers get _op suffix
// ---------------------------------------------------------------------------

test('generate() suffixes _op for reserved Go keyword operation ids', () => {
  const mappingWithReserved = JSON.parse(JSON.stringify(MAPPING));
  mappingWithReserved.endpoints = [
    {
      ...MAPPING.endpoints[0],
      id: 'select',  // Go reserved keyword
      method: 'GET',
      path: '/widgets/{id}',
    }
  ];
  const { text } = generate(mappingWithReserved);
  // "select" → PascalCase "Select" which is reserved → "Select_op"
  assert.ok(text.includes('Select_op('), 'reserved keyword "select" must become Select_op');
});

test('generate() suffixes _op for "range" reserved keyword', () => {
  const mappingWithReserved = JSON.parse(JSON.stringify(MAPPING));
  mappingWithReserved.endpoints = [
    {
      ...MAPPING.endpoints[0],
      id: 'range',
      method: 'GET',
      path: '/range',
    }
  ];
  const { text } = generate(mappingWithReserved);
  assert.ok(text.includes('Range_op('), 'reserved keyword "range" must become Range_op');
});

// ---------------------------------------------------------------------------
// (h) Golden-file test: byte-for-byte match
// ---------------------------------------------------------------------------

test('generate() output is byte-identical to expected-go-net-http.go golden file', () => {
  const { text } = generate(MAPPING);
  const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
  assert.equal(text, expected, 'output must be byte-identical to golden fixture');
});

// ---------------------------------------------------------------------------
// (i) gofmt -e passes on the generated file
// ---------------------------------------------------------------------------

test('generate() output passes gofmt -e syntax check', () => {
  const { text } = generate(MAPPING);
  const tmpFile = path.join(os.tmpdir(), `apifier-go-test-${Date.now()}.go`);
  fs.writeFileSync(tmpFile, text, 'utf8');

  let passed = false;
  let errMsg = '';
  try {
    execSync(`/usr/bin/gofmt -e ${JSON.stringify(tmpFile)}`, { stdio: 'pipe' });
    passed = true;
  } catch (e) {
    errMsg = e.stderr ? e.stderr.toString() : String(e);
  }

  try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }

  assert.ok(passed, `gofmt -e failed: ${errMsg}`);
});

// ---------------------------------------------------------------------------
// (j) go vet passes in a temp Go module
// ---------------------------------------------------------------------------

test('generate() output passes go vet in a temp Go module', () => {
  const { text } = generate(MAPPING);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-go-vet-'));
  const goFile = path.join(tmpDir, 'client.go');
  const goModFile = path.join(tmpDir, 'go.mod');

  fs.writeFileSync(goFile, text, 'utf8');
  fs.writeFileSync(goModFile, 'module apifier-go-smoke\n\ngo 1.21\n', 'utf8');

  let passed = false;
  let errMsg = '';
  try {
    execSync('/usr/bin/go vet ./...', { cwd: tmpDir, stdio: 'pipe' });
    passed = true;
  } catch (e) {
    errMsg = e.stderr ? e.stderr.toString() : String(e);
    errMsg += e.stdout ? '\nstdout: ' + e.stdout.toString() : '';
  }

  try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) { /* ignore */ }

  assert.ok(passed, `go vet failed: ${errMsg}`);
});

// ---------------------------------------------------------------------------
// Registry: go-net-http listed as supported with wave 4D
// ---------------------------------------------------------------------------

test('registry lists go-net-http as supported with wave 4D', () => {
  const registry = require(path.join(__dirname, '../../lib/codegen/_registry'));
  const list = registry.list();
  const entry = list.find(t => t.id === 'go-net-http');
  assert.ok(entry, 'go-net-http must be in registry');
  assert.equal(entry.supported, true, 'go-net-http must be marked supported');
  assert.equal(entry.ext, '.go', 'go-net-http must have .go extension');
  assert.equal(entry.wave, '4D', 'go-net-http must be wave 4D');
});

// ---------------------------------------------------------------------------
// Registry: curl-shell now supported (wave 4E)
// ---------------------------------------------------------------------------

test('registry marks curl-shell as supported at wave 4E', () => {
  const registry = require(path.join(__dirname, '../../lib/codegen/_registry'));
  const list = registry.list();
  const entry = list.find(t => t.id === 'curl-shell');
  assert.ok(entry, 'curl-shell must be in registry');
  assert.equal(entry.supported, true, 'curl-shell must be supported (wave 4E)');
  assert.equal(entry.wave, '4E', 'curl-shell must be wave 4E');
});

// ---------------------------------------------------------------------------
// Header comment present with Go community convention
// ---------------------------------------------------------------------------

test('generate() output starts with Go generated file marker', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.startsWith('// Code generated by apifier; DO NOT EDIT.'), 'must start with Go generated file marker');
  assert.ok(text.includes('Generated by apifier'), 'must contain generation provenance');
  assert.ok(text.includes('schema_version'), 'header must mention schema_version');
  assert.ok(text.includes('DO NOT EDIT'), 'header must say DO NOT EDIT');
  assert.ok(text.includes('Init:'), 'header must contain init guide');
});

// ---------------------------------------------------------------------------
// Package name derived from service name
// ---------------------------------------------------------------------------

test('generate() derives package name from service name', () => {
  const { text } = generate(MAPPING);
  // widgets-api → widgetsapi
  assert.ok(text.includes('package widgetsapi'), 'must contain package widgetsapi declaration');
});

// ---------------------------------------------------------------------------
// No unsafe imports or exec in generated output
// ---------------------------------------------------------------------------

test('generate() output contains no unsafe imports or exec calls', () => {
  const { text } = generate(MAPPING);
  assert.ok(!text.includes('"unsafe"'), 'generated Go must not import unsafe');
  assert.ok(!text.includes('os/exec'), 'generated Go must not import os/exec');
  assert.ok(!text.includes('syscall'), 'generated Go must not import syscall');
});

// ---------------------------------------------------------------------------
// Error hierarchy present
// ---------------------------------------------------------------------------

test('generate() emits full error type hierarchy', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('type ApifierClientError struct'), 'must contain ApifierClientError');
  assert.ok(text.includes('ApifierBadRequestError'), 'must contain ApifierBadRequestError');
  assert.ok(text.includes('ApifierAuthenticationError'), 'must contain ApifierAuthenticationError');
  assert.ok(text.includes('ApifierAuthorizationError'), 'must contain ApifierAuthorizationError');
  assert.ok(text.includes('ApifierNotFoundError'), 'must contain ApifierNotFoundError');
  assert.ok(text.includes('ApifierConflictError'), 'must contain ApifierConflictError');
  assert.ok(text.includes('ApifierValidationError'), 'must contain ApifierValidationError');
  assert.ok(text.includes('ApifierServerError'), 'must contain ApifierServerError');
  assert.ok(text.includes('ErrApifierClientErr'), 'must contain ErrApifierClientErr sentinel');
});

// ---------------------------------------------------------------------------
// url.PathEscape used for path parameters (security: URL injection prevention)
// ---------------------------------------------------------------------------

test('generate() uses url.PathEscape for path parameter encoding', () => {
  const { text } = generate(MAPPING);
  // GetWidget has a path param {id}
  assert.ok(text.includes('url.PathEscape('), 'must use url.PathEscape for path params');
});

// ---------------------------------------------------------------------------
// WithHTTPClient builder present
// ---------------------------------------------------------------------------

test('generate() emits WithHTTPClient builder method', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('WithHTTPClient('), 'must emit WithHTTPClient builder');
  assert.ok(text.includes('*http.Client'), 'must accept *http.Client parameter');
});
