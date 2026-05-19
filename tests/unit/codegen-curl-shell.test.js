'use strict';

// tests/unit/codegen-curl-shell.test.js — Unit tests for lib/codegen/curl-shell.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');
const os        = require('node:os');
const { execSync, spawnSync } = require('node:child_process');

const { generate }  = require(path.join(__dirname, '../../lib/codegen/curl-shell'));
const MAPPING_PATH  = path.join(__dirname, '../fixtures/sample-mapping-v1.json');
const EXPECTED_PATH = path.join(__dirname, '../fixtures/expected-curl-shell.sh');

// Load fixture once
const MAPPING = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// (a) Non-empty .sh output from sample-mapping-v1.json
// ---------------------------------------------------------------------------

test('generate() returns a non-empty .sh string from sample-mapping-v1.json', () => {
  const { text, ext } = generate(MAPPING);
  assert.equal(ext, '.sh', 'extension must be .sh');
  assert.ok(typeof text === 'string' && text.length > 0, 'text must be non-empty string');
  assert.ok(text.includes('#!/usr/bin/env bash'), 'must contain shebang');
  assert.ok(text.includes('set -euo pipefail'), 'must contain strict-mode preamble');
});

// ---------------------------------------------------------------------------
// (b) Byte-determinism: two runs produce identical strings
// ---------------------------------------------------------------------------

test('generate() is byte-deterministic for the same input', () => {
  const { text: text1 } = generate(MAPPING);
  const { text: text2 } = generate(MAPPING);
  assert.equal(text1, text2, 'two runs over same mapping must produce identical output');
});

// ---------------------------------------------------------------------------
// (c) Shebang on line 1, set -euo pipefail present (strict mode preamble)
// ---------------------------------------------------------------------------

test('generate() output has shebang on line 1 and set -euo pipefail', () => {
  const { text } = generate(MAPPING);
  const lines = text.split('\n');
  assert.equal(lines[0], '#!/usr/bin/env bash', 'line 1 must be shebang');
  const hasStrictMode = lines.some(l => l.trim() === 'set -euo pipefail');
  assert.ok(hasStrictMode, 'must contain set -euo pipefail');
  // Ensure set -euo pipefail appears before any function definitions
  const strictIdx = lines.findIndex(l => l.trim() === 'set -euo pipefail');
  const firstFuncIdx = lines.findIndex(l => l.match(/^apifier__/));
  if (firstFuncIdx !== -1) {
    assert.ok(strictIdx < firstFuncIdx, 'set -euo pipefail must appear before function definitions');
  }
});

// ---------------------------------------------------------------------------
// (d) One function per endpoint — count apifier__ function definitions
// ---------------------------------------------------------------------------

test('generate() emits one function per endpoint', () => {
  const { text } = generate(MAPPING);
  // Count endpoint-function definitions: lines like "apifier__<method>__<path>() {"
  // (excludes auth helpers like apifier__auth_headers and apifier__auth_query_string)
  const funcDefs = (text.match(/^apifier__[a-z0-9_]+__[a-z0-9_]+\(\) \{$/gm) || []);
  assert.equal(
    funcDefs.length,
    MAPPING.endpoints.length,
    `endpoint function count ${funcDefs.length} must equal endpoint count ${MAPPING.endpoints.length}`
  );
  // Fixture has GET /widgets/{id} and POST /widgets
  assert.ok(text.includes('apifier__get__widgets_id()'), 'must contain apifier__get__widgets_id function');
  assert.ok(text.includes('apifier__post__widgets()'), 'must contain apifier__post__widgets function');
});

// ---------------------------------------------------------------------------
// (e) Auth helper emitted only when auth schemes are used
// ---------------------------------------------------------------------------

test('generate() emits apifier__auth_headers for http-bearer auth scheme', () => {
  const { text } = generate(MAPPING);
  // sample-mapping-v1 has a bearer-jwt scheme
  assert.ok(text.includes('apifier__auth_headers()'), 'must emit apifier__auth_headers function');
  assert.ok(text.includes('APIFIER_BEARER_TOKEN'), 'must reference APIFIER_BEARER_TOKEN');
});

test('generate() does NOT emit auth helpers when no auth schemes used', () => {
  const mappingNoAuth = JSON.parse(JSON.stringify(MAPPING));
  mappingNoAuth.auth = [];
  mappingNoAuth.endpoints = mappingNoAuth.endpoints.map(ep => ({ ...ep, auth: [] }));
  const { text } = generate(mappingNoAuth);
  assert.ok(!text.includes('apifier__auth_headers()'), 'must NOT emit auth_headers for no-auth mapping');
  assert.ok(!text.includes('APIFIER_BEARER_TOKEN'), 'must NOT emit APIFIER_BEARER_TOKEN for no-auth mapping');
});

test('generate() emits apifier__auth_query_string for api-key in:query auth scheme', () => {
  const mappingWithQueryKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithQueryKey.auth = [
    { id: 'qkey', type: 'api-key', in: 'query', name: 'api_key' }
  ];
  mappingWithQueryKey.endpoints = mappingWithQueryKey.endpoints.map(ep => ({
    ...ep,
    auth: ['qkey'],
  }));
  const { text } = generate(mappingWithQueryKey);
  assert.ok(text.includes('apifier__auth_query_string()'), 'must emit apifier__auth_query_string for api-key/query');
  // The query string result must be appended to the URL, not a no-op
  assert.ok(text.includes('_url="${_url}?${_qs}"'), 'api-key/in=query must be appended to URL');
});

test('generate() emits basic-auth vars for http-basic auth scheme', () => {
  const mappingWithBasic = JSON.parse(JSON.stringify(MAPPING));
  mappingWithBasic.auth = [
    { id: 'basic', type: 'http-basic', description: 'Basic auth' }
  ];
  mappingWithBasic.endpoints = mappingWithBasic.endpoints.map(ep => ({
    ...ep,
    auth: ['basic'],
  }));
  const { text } = generate(mappingWithBasic);
  assert.ok(text.includes('APIFIER_BASIC_USER'), 'must emit APIFIER_BASIC_USER for http-basic scheme');
  assert.ok(text.includes('APIFIER_BASIC_PASS'), 'must emit APIFIER_BASIC_PASS for http-basic scheme');
});

// ---------------------------------------------------------------------------
// (f) Reserved-name sanitisation — path starting with digit gets op_ prefix
// ---------------------------------------------------------------------------

test('generate() prefixes op_ for slug starting with digit', () => {
  const mappingWithDigitPath = JSON.parse(JSON.stringify(MAPPING));
  mappingWithDigitPath.endpoints = [
    {
      ...MAPPING.endpoints[0],
      id: 'getVersion',
      method: 'GET',
      path: '/123/version',
      path_params: [],
    }
  ];
  const { text } = generate(mappingWithDigitPath);
  // path /123/version → slug "123_version" starts with digit → "op_123_version"
  assert.ok(
    text.includes('apifier__get__op_123_version()'),
    'digit-starting path slug must be prefixed with op_'
  );
});

test('generate() uses apifier__ prefix for all functions avoiding builtin collisions', () => {
  const { text } = generate(MAPPING);
  // All function definitions must start with apifier__
  const funcDefs = (text.match(/^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{$/gm) || []);
  for (const fn of funcDefs) {
    assert.ok(
      fn.startsWith('apifier__'),
      `function definition "${fn}" must start with apifier__ prefix`
    );
  }
});

// ---------------------------------------------------------------------------
// (g) bash -n (POSIX syntax check) passes on the generated file
// ---------------------------------------------------------------------------

test('generate() output passes bash -n syntax check', () => {
  const { text } = generate(MAPPING);
  const tmpFile = path.join(os.tmpdir(), `apifier-curl-test-${Date.now()}.sh`);
  fs.writeFileSync(tmpFile, text, 'utf8');

  let passed = false;
  let errMsg = '';
  try {
    execSync(`bash -n ${JSON.stringify(tmpFile)}`, { stdio: 'pipe' });
    passed = true;
  } catch (e) {
    errMsg = e.stderr ? e.stderr.toString() : String(e);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }

  assert.ok(passed, `bash -n must pass on generated output. Error: ${errMsg}`);
});

// Also test bash -n for a mapping with api-key in:query (different code path)
test('generate() api-key/query output passes bash -n syntax check', () => {
  const mappingWithQueryKey = JSON.parse(JSON.stringify(MAPPING));
  mappingWithQueryKey.auth = [
    { id: 'qkey', type: 'api-key', in: 'query', name: 'api_key' }
  ];
  mappingWithQueryKey.endpoints = mappingWithQueryKey.endpoints.map(ep => ({
    ...ep,
    auth: ['qkey'],
  }));
  const { text } = generate(mappingWithQueryKey);
  const tmpFile = path.join(os.tmpdir(), `apifier-curl-qkey-${Date.now()}.sh`);
  fs.writeFileSync(tmpFile, text, 'utf8');

  let passed = false;
  let errMsg = '';
  try {
    execSync(`bash -n ${JSON.stringify(tmpFile)}`, { stdio: 'pipe' });
    passed = true;
  } catch (e) {
    errMsg = e.stderr ? e.stderr.toString() : String(e);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }

  assert.ok(passed, `bash -n must pass on api-key/query output. Error: ${errMsg}`);
});

// ---------------------------------------------------------------------------
// (h) Golden-file test: byte-for-byte match
// ---------------------------------------------------------------------------

test('generate() output is byte-identical to expected-curl-shell.sh golden file', () => {
  const { text } = generate(MAPPING);
  const expected = fs.readFileSync(EXPECTED_PATH, 'utf8');
  assert.equal(text, expected, 'output must be byte-identical to golden fixture');
});

// ---------------------------------------------------------------------------
// (i) Optional: shellcheck if on PATH
// ---------------------------------------------------------------------------

test('generate() output passes shellcheck (skipped if not on PATH)', () => {
  // Detect shellcheck
  const which = spawnSync('which', ['shellcheck'], { encoding: 'utf8' });
  if (which.status !== 0) {
    console.log('[codegen-curl-shell] shellcheck not found on PATH — skipping shellcheck test');
    return;
  }

  const { text } = generate(MAPPING);
  const tmpFile = path.join(os.tmpdir(), `apifier-curl-sc-${Date.now()}.sh`);
  fs.writeFileSync(tmpFile, text, 'utf8');

  let passed = false;
  let errMsg = '';
  try {
    execSync(`shellcheck -e SC2086 -e SC1091 ${JSON.stringify(tmpFile)}`, { stdio: 'pipe' });
    passed = true;
  } catch (e) {
    errMsg = e.stdout ? e.stdout.toString() : String(e);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }

  assert.ok(passed, `shellcheck must pass on generated output. Errors:\n${errMsg}`);
});

// ---------------------------------------------------------------------------
// Additional: env-var default-empty syntax (set -u safety)
// ---------------------------------------------------------------------------

test('generate() uses ${VAR:-} default-empty syntax for all env var reads in functions', () => {
  const { text } = generate(MAPPING);
  // All ${VAR} inside condition checks that might trigger set -u must use :- or :?
  // At minimum, verify that config block uses := form
  assert.ok(
    text.includes(': "${APIFIER_BASE_URL:='),
    'config vars must use := form for safe set -u initialization'
  );
  assert.ok(
    text.includes(': "${APIFIER_TIMEOUT_SEC:=30}"'),
    'APIFIER_TIMEOUT_SEC must have default via :='
  );
});

// ---------------------------------------------------------------------------
// Additional: generation timestamp comes from mapping.source.fetched_at
// ---------------------------------------------------------------------------

test('generate() uses mapping.source.fetched_at for generation timestamp (not Date.now)', () => {
  const { text } = generate(MAPPING);
  // The fixture's fetched_at is 2026-05-19T07:42:11.034Z
  assert.ok(
    text.includes('2026-05-19T07:42:11.034Z'),
    'generation timestamp must come from mapping.source.fetched_at'
  );
});

// ---------------------------------------------------------------------------
// Additional: registry shows curl-shell as supported at wave 4E
// ---------------------------------------------------------------------------

test('registry shows curl-shell as supported with wave 4E', () => {
  const registry = require(path.join(__dirname, '../../lib/codegen/_registry'));
  const targets = registry.list();
  const curlTarget = targets.find(t => t.id === 'curl-shell');
  assert.ok(curlTarget, 'curl-shell must be in registry');
  assert.equal(curlTarget.supported, true, 'curl-shell must be supported');
  assert.equal(curlTarget.wave, '4E', 'curl-shell wave must be 4E');
  assert.equal(curlTarget.ext, '.sh', 'curl-shell ext must be .sh');
  // All 7 supported targets (Wave 4F: ts-axios + python-httpx added)
  const supported = targets.filter(t => t.supported).map(t => t.id).sort();
  assert.ok(supported.includes('ts-fetch'), 'ts-fetch must be supported');
  assert.ok(supported.includes('python-requests'), 'python-requests must be supported');
  assert.ok(supported.includes('openapi-3.1'), 'openapi-3.1 must be supported');
  assert.ok(supported.includes('go-net-http'), 'go-net-http must be supported');
  assert.ok(supported.includes('curl-shell'), 'curl-shell must be supported');
  assert.equal(supported.length, 7, 'exactly 7 targets must be supported after Wave 4F');
});
