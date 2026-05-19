'use strict';

// tests/unit/handler-diff.test.js — Integration tests for lib/handlers/diff.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { handleDiff } = require(path.join(__dirname, '../../lib/handlers/diff'));
const { dispatch }   = require(path.join(__dirname, '../../lib/dispatcher'));

// Fixtures must live in /tmp (an allowed root) for path-guard to pass.
const FIXTURE_ORIGINAL_SRC = path.join(__dirname, '../fixtures/mapping-v1-original.json');
const FIXTURE_EVOLVED_SRC  = path.join(__dirname, '../fixtures/mapping-v1-evolved.json');
const FIXTURE_ORIGINAL = path.join(os.tmpdir(), 'diff-fixture-original.json');
const FIXTURE_EVOLVED  = path.join(os.tmpdir(), 'diff-fixture-evolved.json');

// Copy fixtures to /tmp once at module load time.
fs.copyFileSync(FIXTURE_ORIGINAL_SRC, FIXTURE_ORIGINAL);
fs.copyFileSync(FIXTURE_EVOLVED_SRC, FIXTURE_EVOLVED);

// ---------------------------------------------------------------------------
// Helper: write a minimal valid mapping to a temp file in /tmp (allowed root).
// ---------------------------------------------------------------------------

function writeTempMapping(obj) {
  const p = path.join(os.tmpdir(), `diff-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

function minimalMapping(overrides) {
  return Object.assign({
    schema_version: 1,
    apifier_version: '0.1.0',
    kind: 'apifier-mapping',
    service: { name: 'test-svc', version: '1.0' },
    source: { type: 'openapi', url: 'https://x.com', fetched_at: '2026-01-01T00:00:00Z', parser: { name: 'p', version: '1' } },
    endpoints: [],
  }, overrides);
}

// ---------------------------------------------------------------------------
// (a) Two real fixture files — assert full ChangeReport shape
// ---------------------------------------------------------------------------

test('handleDiff: real fixtures return correct ChangeReport shape', async () => {
  const result = await handleDiff({
    mapping_a: FIXTURE_ORIGINAL,
    mapping_b: FIXTURE_EVOLVED,
  });

  // Shape assertions.
  assert.ok(typeof result.verdict === 'string', 'verdict must be a string');
  assert.ok(['compatible', 'patch', 'minor', 'major'].includes(result.verdict), `unexpected verdict: ${result.verdict}`);
  assert.ok(typeof result.counts === 'object');
  assert.ok(typeof result.counts.breaking === 'number');
  assert.ok(typeof result.counts.non_breaking === 'number');
  assert.ok(typeof result.counts.patch === 'number');
  assert.ok(typeof result.counts.total === 'number');
  assert.ok(Array.isArray(result.breaking));
  assert.ok(Array.isArray(result.non_breaking));
  assert.ok(Array.isArray(result.patch));
  assert.ok(typeof result.summary === 'object');

  // The evolved fixture has breaking changes → verdict must be major. Use the
  // strict W33-brief thresholds (>= 4 / >= 4 / >= 2) so a regression that
  // silently drops a category is caught — not the loose > 0 check that would
  // let a 1-breaking-change regression slide through.
  assert.equal(result.verdict, 'major', 'evolved fixture must produce a major verdict');
  assert.ok(result.counts.breaking     >= 4, `must have >= 4 breaking changes (got ${result.counts.breaking})`);
  assert.ok(result.counts.non_breaking >= 4, `must have >= 4 non_breaking changes (got ${result.counts.non_breaking})`);
  assert.ok(result.counts.patch        >= 2, `must have >= 2 patch changes (got ${result.counts.patch})`);
});

// ---------------------------------------------------------------------------
// (b) format: 'summary' — returns top-line only, no full arrays
// ---------------------------------------------------------------------------

test('handleDiff: format=summary returns top-line only', async () => {
  const result = await handleDiff({
    mapping_a: FIXTURE_ORIGINAL,
    mapping_b: FIXTURE_EVOLVED,
    format: 'summary',
  });

  assert.ok(typeof result.verdict === 'string');
  assert.ok(typeof result.counts === 'object');
  assert.ok(typeof result.summary === 'object');
  // Must NOT have full arrays.
  assert.equal(result.breaking, undefined, 'summary format must not include breaking array');
  assert.equal(result.non_breaking, undefined, 'summary format must not include non_breaking array');
  assert.equal(result.patch, undefined, 'summary format must not include patch array');
});

// ---------------------------------------------------------------------------
// (c) Non-existent mapping_a → file-read error (Error thrown by readMapping)
// ---------------------------------------------------------------------------

test('handleDiff: non-existent mapping_a throws', async () => {
  const nonExistent = path.join(os.tmpdir(), 'does-not-exist-ever.json');
  await assert.rejects(
    () => handleDiff({ mapping_a: nonExistent, mapping_b: FIXTURE_EVOLVED }),
    (err) => {
      // readMapping throws a plain Error for ENOENT.
      assert.ok(err instanceof Error);
      assert.ok(err.message.toLowerCase().includes('not found') || err.code === 'ENOENT',
        `expected file-not-found error, got: ${err.message}`);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (d) Invalid mapping (schema-fail) → MappingDiffError
// ---------------------------------------------------------------------------

test('handleDiff: schema-invalid mapping_a → MappingDiffError', async () => {
  const invalid = writeTempMapping({ schema_version: 1, kind: 'apifier-mapping', service: { name: 'bad' } });
  try {
    await assert.rejects(
      () => handleDiff({ mapping_a: invalid, mapping_b: FIXTURE_EVOLVED }),
      (err) => {
        assert.equal(err.name, 'MappingDiffError', `expected MappingDiffError, got ${err.name}`);
        assert.equal(err.code, -32012);
        return true;
      }
    );
  } finally {
    try { fs.unlinkSync(invalid); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (e) mapping_a outside allowed roots → BadParamsError
// ---------------------------------------------------------------------------

test('handleDiff: mapping_a outside allowed roots → BadParamsError', async () => {
  // /etc/passwd is outside allowed roots and contains '..' check won't fire,
  // but /etc itself is not in the allowed list.
  await assert.rejects(
    () => handleDiff({ mapping_a: '/etc/passwd', mapping_b: FIXTURE_EVOLVED }),
    (err) => {
      assert.ok(err.name === 'BadParamsError' || err.name === 'PathTraversalError',
        `expected BadParamsError or PathTraversalError, got ${err.name}`);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (f) Integration with dispatcher — tools/call apifier-diff
// ---------------------------------------------------------------------------

test('handleDiff: dispatcher routes apifier-diff and returns non-stub response', async () => {
  const frame = {
    jsonrpc: '2.0',
    id: 42,
    method: 'tools/call',
    params: {
      name: 'apifier-diff',
      arguments: {
        mapping_a: FIXTURE_ORIGINAL,
        mapping_b: FIXTURE_EVOLVED,
        format: 'summary',
      },
    },
  };

  const resp = await dispatch(frame);
  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 42);
  assert.ok(resp.result, 'must have result, not error');
  assert.ok(!resp.error, 'must not have error');
  assert.ok(Array.isArray(resp.result.content), 'result.content must be an array');
  assert.ok(resp.result.content.length > 0, 'must have at least one content item');
  assert.equal(resp.result.content[0].type, 'text');

  const parsed = JSON.parse(resp.result.content[0].text);
  assert.ok(typeof parsed.verdict === 'string', 'dispatched result must include verdict');
  assert.equal(parsed.verdict, 'major', 'evolved fixture must produce major verdict via dispatcher');
});

// ---------------------------------------------------------------------------
// (g) Identical mappings → compatible verdict
// ---------------------------------------------------------------------------

test('handleDiff: identical mappings → compatible verdict', async () => {
  const tmpA = writeTempMapping(minimalMapping());
  const tmpB = writeTempMapping(minimalMapping());
  try {
    const result = await handleDiff({ mapping_a: tmpA, mapping_b: tmpB });
    assert.equal(result.verdict, 'compatible');
    assert.equal(result.counts.total, 0);
  } finally {
    try { fs.unlinkSync(tmpA); } catch (_) {}
    try { fs.unlinkSync(tmpB); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (h) Missing required params → BadParamsError
// ---------------------------------------------------------------------------

test('handleDiff: missing mapping_a → BadParamsError', async () => {
  await assert.rejects(
    () => handleDiff({ mapping_b: FIXTURE_EVOLVED }),
    (err) => {
      assert.equal(err.name, 'BadParamsError');
      return true;
    }
  );
});

test('handleDiff: missing mapping_b → BadParamsError', async () => {
  await assert.rejects(
    () => handleDiff({ mapping_a: FIXTURE_ORIGINAL }),
    (err) => {
      assert.equal(err.name, 'BadParamsError');
      return true;
    }
  );
});
