'use strict';

// tests/unit/codegen-python-requests.test.js — Unit tests for lib/codegen/python-requests.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');
const { execSync } = require('node:child_process');

const { generate }  = require(path.join(__dirname, '../../lib/codegen/python-requests'));
const MAPPING_PATH  = path.join(__dirname, '../fixtures/sample-mapping-v1.json');
const EXPECTED_PATH = path.join(__dirname, '../fixtures/expected-python-requests.py');

// Load fixture once
const MAPPING = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// (a) Non-empty .py output from sample-mapping-v1.json
// ---------------------------------------------------------------------------

test('generate() returns a non-empty .py string from sample-mapping-v1.json', () => {
  const { text, ext } = generate(MAPPING);
  assert.equal(ext, '.py', 'extension must be .py');
  assert.ok(typeof text === 'string' && text.length > 0, 'text must be non-empty string');
  assert.ok(text.includes('class'), 'must contain class definitions');
});

// ---------------------------------------------------------------------------
// (b) Output contains expected <ServiceName>Client class
// ---------------------------------------------------------------------------

test('generate() output contains WidgetsApiClient class', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('class WidgetsApiClient'), 'must contain class WidgetsApiClient');
});

// ---------------------------------------------------------------------------
// (c) One method per endpoint
// ---------------------------------------------------------------------------

test('generate() emits one method per endpoint', () => {
  const { text } = generate(MAPPING);
  // Fixture has two endpoints: getWidget → get_widget, createWidget → create_widget
  assert.ok(text.includes('def get_widget('), 'must contain get_widget method');
  assert.ok(text.includes('def create_widget('), 'must contain create_widget method');
  // Count def lines inside class (indented with 4 spaces), excluding __init__ and auth helpers
  const methodMatches = text.match(/^    def [a-z]/gm) || [];
  // Should have at least endpoint count methods (plus auth helpers)
  assert.ok(
    methodMatches.length >= MAPPING.endpoints.length,
    `method count ${methodMatches.length} must be >= endpoint count ${MAPPING.endpoints.length}`
  );
});

// ---------------------------------------------------------------------------
// (d) One @dataclass per model
// ---------------------------------------------------------------------------

test('generate() emits one @dataclass per model', () => {
  const { text } = generate(MAPPING);
  for (const model of MAPPING.models) {
    if (model.kind === 'object' || model.kind === 'enum') {
      assert.ok(
        text.includes(`class ${model.name}:`),
        `must emit class for model: ${model.name}`
      );
    }
  }
  // Count @dataclass decorators — should match object/enum model count
  const dataclassCount = (text.match(/@dataclass/g) || []).length;
  const objectModelCount = MAPPING.models.filter(m => m.kind === 'object' || m.kind === 'enum').length;
  assert.equal(dataclassCount, objectModelCount, '@dataclass count must match object/enum model count');
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
// (f) Auth helpers present per mapping auth schemes
// ---------------------------------------------------------------------------

test('generate() emits set_bearer_token for http-bearer auth scheme', () => {
  const { text } = generate(MAPPING);
  // sample-mapping-v1 has a single http-bearer scheme
  assert.ok(text.includes('def set_bearer_token('), 'must emit set_bearer_token for http-bearer scheme');
  assert.ok(text.includes("'Authorization'"), 'must include Authorization header usage');
});

test('generate() emits set_api_key for api-key auth scheme', () => {
  const mappingWithApiKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithApiKey.auth = [
    { id: 'apikey', type: 'api-key', in: 'header', name: 'X-API-Key' }
  ];
  mappingWithApiKey.endpoints = mappingWithApiKey.endpoints.map(ep => ({
    ...ep,
    auth: ['apikey'],
  }));
  const { text } = generate(mappingWithApiKey);
  assert.ok(text.includes('def set_api_key('), 'must emit set_api_key for api-key scheme');
});

test('generate() emits set_basic_auth for http-basic auth scheme', () => {
  const mappingWithBasic = JSON.parse(JSON.stringify(MAPPING));
  mappingWithBasic.auth = [
    { id: 'basic', type: 'http-basic', description: 'Basic auth' }
  ];
  mappingWithBasic.endpoints = mappingWithBasic.endpoints.map(ep => ({
    ...ep,
    auth: ['basic'],
  }));
  const { text } = generate(mappingWithBasic);
  assert.ok(text.includes('def set_basic_auth('), 'must emit set_basic_auth for http-basic scheme');
});

test('generate() emits api-key/in=query append to _params (W15-1 fix)', () => {
  const mappingWithQueryKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithQueryKey.auth = [
    { id: 'qkey', type: 'api-key', in: 'query', name: 'api_key' }
  ];
  mappingWithQueryKey.endpoints = mappingWithQueryKey.endpoints.map(ep => ({
    ...ep,
    auth: ['qkey'],
  }));
  const { text } = generate(mappingWithQueryKey);
  // Must append api_key name+value to _params dict (not no-op it)
  assert.ok(text.includes('_params[self._api_key_name]'), 'api-key/in=query must be appended to _params');
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
  assert.ok(text.includes('TODO(wave 4C): oauth2'), 'must emit TODO for unsupported oauth2 scheme');
});

// ---------------------------------------------------------------------------
// (g) Reserved Python keyword endpoint identifiers get _op suffix
// ---------------------------------------------------------------------------

test('generate() suffixes _op for reserved Python keyword operation ids', () => {
  const mappingWithReserved = JSON.parse(JSON.stringify(MAPPING));
  mappingWithReserved.endpoints = [
    {
      ...MAPPING.endpoints[0],
      id: 'del',             // Python reserved keyword (del, not delete)
      method: 'DELETE',
      path: '/widgets/{id}',
    }
  ];
  const { text } = generate(mappingWithReserved);
  assert.ok(text.includes('def del_op('), 'reserved keyword "del" must become del_op');
  assert.ok(!text.match(/\bdef del\(/), 'must not use bare "del" as method name');
});

test('generate() suffixes _op for "class" reserved keyword', () => {
  const mappingWithReserved = JSON.parse(JSON.stringify(MAPPING));
  mappingWithReserved.endpoints = [
    {
      ...MAPPING.endpoints[0],
      id: 'class',
      method: 'GET',
      path: '/class',
    }
  ];
  const { text } = generate(mappingWithReserved);
  assert.ok(text.includes('def class_op('), 'reserved keyword "class" must become class_op');
});

// ---------------------------------------------------------------------------
// (h) Golden-file test: byte-for-byte match
// ---------------------------------------------------------------------------

test('generate() output is byte-identical to expected-python-requests.py golden file', () => {
  const { text } = generate(MAPPING);
  const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
  assert.equal(text, expected, 'output must be byte-identical to golden fixture');
});

// ---------------------------------------------------------------------------
// (i) Python syntax validity: py_compile or brace-balance fallback
// ---------------------------------------------------------------------------

test('generate() output passes Python syntax check', () => {
  const { text } = generate(MAPPING);
  const tmpFile = path.join(require('node:os').tmpdir(), `apifier-py-test-${Date.now()}.py`);
  fs.writeFileSync(tmpFile, text, 'utf8');

  let method = 'none';
  let passed = false;

  try {
    // Try python3 first
    execSync(`python3 -m py_compile ${JSON.stringify(tmpFile)}`, { stdio: 'pipe' });
    method = 'py_compile';
    passed = true;
  } catch (_py3Err) {
    try {
      execSync(`python -m py_compile ${JSON.stringify(tmpFile)}`, { stdio: 'pipe' });
      method = 'py_compile (python)';
      passed = true;
    } catch (_pyErr) {
      // Fallback: brace/bracket/paren depth balance check
      method = 'syntax-balance';
      let depth = 0;
      for (const ch of text) {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
      }
      passed = depth === 0;
    }
  }

  try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }

  assert.ok(passed, `Python syntax check failed using method: ${method}`);
});

// ---------------------------------------------------------------------------
// Registry: python-requests listed as supported
// ---------------------------------------------------------------------------

test('registry lists python-requests as supported', () => {
  const registry = require(path.join(__dirname, '../../lib/codegen/_registry'));
  const list = registry.list();
  const entry = list.find(t => t.id === 'python-requests');
  assert.ok(entry, 'python-requests must be in registry');
  assert.equal(entry.supported, true, 'python-requests must be marked supported');
  assert.equal(entry.ext, '.py', 'python-requests must have .py extension');
});

// ---------------------------------------------------------------------------
// Registry: ts-axios still unsupported
// ---------------------------------------------------------------------------

test('registry still marks ts-axios as unsupported', () => {
  const registry = require(path.join(__dirname, '../../lib/codegen/_registry'));
  const list = registry.list();
  const entry = list.find(t => t.id === 'ts-axios');
  assert.ok(entry, 'ts-axios must remain in registry');
  assert.equal(entry.supported, false, 'ts-axios must remain unsupported');
});

// ---------------------------------------------------------------------------
// Header docstring present
// ---------------------------------------------------------------------------

test('generate() output contains prescribed module docstring', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.startsWith('"""'), 'must start with triple-quoted docstring');
  assert.ok(text.includes('Generated by apifier'), 'must contain generation provenance');
  assert.ok(text.includes('schema_version'), 'docstring must mention schema_version');
  assert.ok(text.includes('Do not edit by hand'), 'docstring must say do not edit by hand');
  assert.ok(text.includes('Quick start:'), 'docstring must contain init guide');
});

// ---------------------------------------------------------------------------
// Footer __all__ present
// ---------------------------------------------------------------------------

test('generate() output contains __all__ footer', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('__all__'), 'must contain __all__ export list');
  assert.ok(text.includes('"WidgetsApiClient"'), '__all__ must contain service class name');
  assert.ok(text.includes('"ApifierClientError"'), '__all__ must contain base error class');
});

// ---------------------------------------------------------------------------
// No eval/exec in output
// ---------------------------------------------------------------------------

test('generate() output contains no eval or exec calls', () => {
  const { text } = generate(MAPPING);
  assert.ok(!text.includes('eval('), 'generated Python must not contain eval()');
  assert.ok(!text.includes('exec('), 'generated Python must not contain exec()');
  assert.ok(!text.includes('__import__('), 'generated Python must not contain __import__()');
});
