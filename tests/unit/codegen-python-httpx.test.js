'use strict';

// tests/unit/codegen-python-httpx.test.js — Unit tests for lib/codegen/python-httpx.js.

const { test }      = require('node:test');
const assert        = require('node:assert/strict');
const path          = require('node:path');
const fs            = require('node:fs');
const os            = require('node:os');
const { execSync }  = require('node:child_process');

const { generate }  = require(path.join(__dirname, '../../lib/codegen/python-httpx'));
const MAPPING_PATH  = path.join(__dirname, '../fixtures/sample-mapping-v1.json');
const EXPECTED_PATH = path.join(__dirname, '../fixtures/expected-python-httpx.py');

const MAPPING = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// (a) Non-empty .py output
// ---------------------------------------------------------------------------

test('python-httpx generate() returns a non-empty .py string', () => {
  const { text, ext } = generate(MAPPING);
  assert.equal(ext, '.py', 'extension must be .py');
  assert.ok(typeof text === 'string' && text.length > 0, 'text must be non-empty string');
});

// ---------------------------------------------------------------------------
// (b) Byte-determinism
// ---------------------------------------------------------------------------

test('python-httpx generate() is byte-deterministic for the same input', () => {
  const { text: text1 } = generate(MAPPING);
  const { text: text2 } = generate(MAPPING);
  assert.equal(text1, text2, 'two runs over same mapping must produce identical output');
});

// ---------------------------------------------------------------------------
// (c) `import httpx` present and `import requests` NOT present
// ---------------------------------------------------------------------------

test('python-httpx generate() includes httpx import and not requests import', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('import httpx'), 'must import httpx');
  assert.ok(text.includes('pip install httpx'), 'must have install comment');
  assert.ok(!text.includes('import requests'), 'must NOT import requests');
});

// ---------------------------------------------------------------------------
// (d) One method per endpoint
// ---------------------------------------------------------------------------

test('python-httpx generate() emits one method per endpoint', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('def get_widget('), 'must contain get_widget method');
  assert.ok(text.includes('def create_widget('), 'must contain create_widget method');
  // Count only endpoint methods by matching method names from the mapping
  for (const ep of MAPPING.endpoints) {
    // Convert endpoint id to snake_case (same logic as _toMethodName)
    const snake = ep.id
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase();
    assert.ok(text.includes(`def ${snake}(`), `must contain def ${snake}() method`);
  }
});

// ---------------------------------------------------------------------------
// (e) One @dataclass per model
// ---------------------------------------------------------------------------

test('python-httpx generate() emits one @dataclass per model', () => {
  const { text } = generate(MAPPING);
  for (const model of MAPPING.models) {
    if (model.kind === 'object') {
      assert.ok(text.includes(`class ${model.name}:`), `must emit class for model: ${model.name}`);
    }
  }
  const dataclassCount = (text.match(/@dataclass/g) || []).length;
  const objectModels = MAPPING.models.filter(m => m.kind === 'object').length;
  assert.equal(dataclassCount, objectModels, '@dataclass count must match object model count');
});

// ---------------------------------------------------------------------------
// (f) Reserved-keyword sanitisation
// ---------------------------------------------------------------------------

test('python-httpx generate() suffixes _op for reserved-keyword operation ids', () => {
  const mappingWithReserved = JSON.parse(JSON.stringify(MAPPING));
  mappingWithReserved.endpoints = [
    {
      ...MAPPING.endpoints[0],
      id: 'return',     // Python reserved keyword
      method: 'GET',
      path: '/widgets/{id}',
    }
  ];
  const { text } = generate(mappingWithReserved);
  assert.ok(text.includes('def return_op('), 'reserved keyword "return" must become return_op');
  assert.ok(!text.match(/def return\b/), 'must not use bare "return" as method name');
});

// ---------------------------------------------------------------------------
// (g) Golden-file byte match
// ---------------------------------------------------------------------------

test('python-httpx generate() output is byte-identical to expected-python-httpx.py golden file', () => {
  const { text } = generate(MAPPING);
  const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
  assert.equal(text, expected, 'output must be byte-identical to golden fixture');
});

// ---------------------------------------------------------------------------
// (h) python3 -m py_compile passes on generated output
// ---------------------------------------------------------------------------

test('python-httpx generate() produces output that passes python3 -m py_compile', () => {
  let python3Available = true;
  try {
    execSync('python3 --version', { stdio: 'pipe' });
  } catch (_) {
    python3Available = false;
  }

  if (!python3Available) {
    // Skip gracefully — python3 not available in this environment
    console.log('NOTICE: python3 not found, skipping py_compile check');
    return;
  }

  const { text } = generate(MAPPING);
  const tmpFile = path.join(os.tmpdir(), `apifier-python-httpx-check-${process.pid}.py`);
  try {
    fs.writeFileSync(tmpFile, text, 'utf8');
    execSync(`python3 -m py_compile ${JSON.stringify(tmpFile)}`, { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

test('python-httpx generate() emits set_bearer_token for http-bearer auth scheme', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('def set_bearer_token('), 'must emit set_bearer_token');
});

test('python-httpx generate() emits set_api_key for api-key auth scheme', () => {
  const mappingWithApiKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithApiKey.auth = [{ id: 'apikey', type: 'api-key', in: 'header', name: 'X-API-Key' }];
  mappingWithApiKey.endpoints = mappingWithApiKey.endpoints.map(ep => ({ ...ep, auth: ['apikey'] }));
  const { text } = generate(mappingWithApiKey);
  assert.ok(text.includes('def set_api_key('), 'must emit set_api_key');
});

test('python-httpx generate() emits set_basic_auth that uses httpx tuple auth (no base64)', () => {
  const mappingWithBasic = JSON.parse(JSON.stringify(MAPPING));
  mappingWithBasic.auth = [{ id: 'basic', type: 'http-basic', description: 'Basic auth' }];
  mappingWithBasic.endpoints = mappingWithBasic.endpoints.map(ep => ({ ...ep, auth: ['basic'] }));
  const { text } = generate(mappingWithBasic);
  assert.ok(text.includes('def set_basic_auth('), 'must emit set_basic_auth');
  assert.ok(!text.includes('import base64'), 'must NOT import base64 (httpx handles auth tuple)');
  assert.ok(text.includes('self._client.auth = (user, password)'), 'must use httpx auth tuple');
});

// ---------------------------------------------------------------------------
// api-key in:query appends to _params (regression guard)
// ---------------------------------------------------------------------------

test('python-httpx generate() appends api-key/in:query to _params', () => {
  const mappingWithQueryKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithQueryKey.auth = [{ id: 'qkey', type: 'api-key', in: 'query', name: 'api_key' }];
  mappingWithQueryKey.endpoints = mappingWithQueryKey.endpoints.map(ep => ({ ...ep, auth: ['qkey'] }));
  const { text } = generate(mappingWithQueryKey);
  assert.ok(text.includes('_params[self._api_key_name] = self._api_key_value'), 'must append api-key to _params for in:query');
});

// ---------------------------------------------------------------------------
// No base64 import ever (httpx does not need it)
// ---------------------------------------------------------------------------

test('python-httpx generate() never emits `import base64`', () => {
  const { text } = generate(MAPPING);
  assert.ok(!text.includes('import base64'), 'must never import base64');
});

// ---------------------------------------------------------------------------
// httpx.Client created with base_url and timeout
// ---------------------------------------------------------------------------

test('python-httpx generate() creates httpx.Client with base_url and timeout', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('httpx.Client(base_url='), 'must create httpx.Client with base_url');
  assert.ok(text.includes('timeout=30.0'), 'must set timeout=30.0');
});

// ---------------------------------------------------------------------------
// Module docstring present
// ---------------------------------------------------------------------------

test('python-httpx generate() output starts with module docstring', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.startsWith('"""'), 'must start with docstring');
  assert.ok(text.includes('Do not edit by hand'), 'docstring must say do not edit by hand');
  assert.ok(text.includes('Quick start:'), 'docstring must contain init guide');
});

// ---------------------------------------------------------------------------
// __all__ present
// ---------------------------------------------------------------------------

test('python-httpx generate() emits __all__', () => {
  const { text } = generate(MAPPING);
  assert.ok(text.includes('__all__ = ['), 'must emit __all__');
});
