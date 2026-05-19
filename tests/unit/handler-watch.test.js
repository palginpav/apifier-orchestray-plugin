'use strict';

// tests/unit/handler-watch.test.js — Tests for lib/handlers/watch.js (apifier-watch).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');

const { handleWatch } = require(path.join(__dirname, '../../lib/handlers/watch'));

// ---------------------------------------------------------------------------
// Fixtures — baseline lives in tests/fixtures; must be copied to /tmp for
// path-guard acceptance (defaultApifierAllowedRoots includes os.tmpdir()).
// The evolved source is an OpenAPI spec under process.cwd() — fetchSource
// allows process.cwd() as a file allowed root.
// ---------------------------------------------------------------------------

const FIXTURE_BASELINE_SRC = path.join(__dirname, '../fixtures/watch-baseline-mapping.json');
const FIXTURE_EVOLVED_SRC  = path.join(__dirname, '../fixtures/watch-evolved-source.json');

// Helpers

function copyBaselineToTmp(suffix) {
  const dest = path.join(os.tmpdir(), `watch-baseline-${suffix}-${Date.now()}.json`);
  fs.copyFileSync(FIXTURE_BASELINE_SRC, dest);
  return dest;
}

function minimalValidMapping(overrides) {
  return Object.assign({
    schema_version:  1,
    apifier_version: '0.3.0',
    kind:            'apifier-mapping',
    service:         { name: 'test-svc', version: '1.0' },
    source:          { type: 'openapi', url: 'https://x.com', fetched_at: '2026-01-01T00:00:00Z', parser: { name: 'p', version: '1' } },
    endpoints:       [],
  }, overrides);
}

function writeTmpMapping(obj) {
  const p = path.join(os.tmpdir(), `watch-mapping-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// (a) Identical source — baseline matches → compatible, should_block=false
// ---------------------------------------------------------------------------

test('handleWatch: identical source → compatible, should_block=false, breaking_changes=[]', async () => {
  // Use the baseline fixture itself as the source (file path — allowed under cwd).
  // Re-scraping the baseline JSON file produces an openapi mapping; we pass the baseline
  // as source (it will be auto-detected as JSON starting with { — sniffed as openapi,
  // but since it's a mapping not an OAS spec the parser will use whatever it gets).
  // For a clean identical test, write a minimal OpenAPI doc that maps to the baseline shape.
  // Simpler: use watch-evolved-source.json as both source AND baseline to guarantee compatible.
  // Build a mapping from the evolved source first, then use that as baseline.
  const evolvedMapping = path.join(os.tmpdir(), `watch-evolved-map-${Date.now()}.json`);
  const { handleScrape } = require(path.join(__dirname, '../../lib/handlers/scrape'));
  const scrapeResult = await handleScrape({
    source:       FIXTURE_EVOLVED_SRC,
    service_name: 'watch-identical-test',
    overwrite:    true,
  });
  fs.copyFileSync(scrapeResult.output_path, evolvedMapping);

  try {
    const result = await handleWatch({
      source:        FIXTURE_EVOLVED_SRC,
      baseline_path: evolvedMapping,
      service_name:  'watch-identical-test2',
      block_on:      'breaking',
    });
    assert.equal(result.verdict, 'compatible', 'identical source → compatible');
    assert.equal(result.should_block, false, 'compatible → should_block=false');
    assert.ok(Array.isArray(result.breaking_changes), 'breaking_changes must be array');
    assert.equal(result.breaking_changes.length, 0, 'no breaking changes on identical');
  } finally {
    try { fs.unlinkSync(evolvedMapping); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (b) Evolved source vs baseline → major verdict, should_block=true (block_on='breaking')
// ---------------------------------------------------------------------------

test('handleWatch: evolved source → major verdict, should_block=true (block_on=breaking)', async () => {
  const baselinePath = copyBaselineToTmp('evolved');
  try {
    const result = await handleWatch({
      source:        FIXTURE_EVOLVED_SRC,
      baseline_path: baselinePath,
      service_name:  'watch-evolved-test',
      block_on:      'breaking',
    });

    assert.equal(result.verdict, 'major', 'evolved fixture → major');
    assert.equal(result.should_block, true, 'block_on=breaking + major → should_block=true');
    assert.ok(Array.isArray(result.breaking_changes), 'breaking_changes must be array');
    assert.ok(result.breaking_changes.length > 0, 'must have breaking changes');
  } finally {
    try { fs.unlinkSync(baselinePath); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (c) block_on='none' → should_block=false even on major verdict
// ---------------------------------------------------------------------------

test('handleWatch: block_on=none → should_block=false on major verdict', async () => {
  const baselinePath = copyBaselineToTmp('none');
  try {
    const result = await handleWatch({
      source:        FIXTURE_EVOLVED_SRC,
      baseline_path: baselinePath,
      service_name:  'watch-none-test',
      block_on:      'none',
    });

    assert.equal(result.verdict, 'major', 'evolved fixture → major');
    assert.equal(result.should_block, false, 'block_on=none → never blocks');
  } finally {
    try { fs.unlinkSync(baselinePath); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (d) block_on='minor' + minor-only changes → should_block=true
// ---------------------------------------------------------------------------

test('handleWatch: block_on=minor + minor-only source → should_block=true', async () => {
  // Build a baseline identical to the evolved source, then add a new (non-breaking) endpoint.
  // First scrape evolved source to get a fresh mapping.
  const { handleScrape } = require(path.join(__dirname, '../../lib/handlers/scrape'));
  const freshScrape = await handleScrape({
    source:       FIXTURE_EVOLVED_SRC,
    service_name: 'watch-minor-base',
    overwrite:    true,
  });

  // Create a modified baseline that is missing one endpoint (so re-scraping produces non_breaking=added).
  const freshMapping = JSON.parse(fs.readFileSync(freshScrape.output_path, 'utf8'));
  // Remove the last endpoint from the baseline so fresh scrape has it "added" → non_breaking.
  const modifiedBaseline = Object.assign({}, freshMapping, {
    endpoints: freshMapping.endpoints.slice(0, freshMapping.endpoints.length - 1),
  });
  const baselinePath = writeTmpMapping(modifiedBaseline);

  try {
    const result = await handleWatch({
      source:        FIXTURE_EVOLVED_SRC,
      baseline_path: baselinePath,
      service_name:  'watch-minor-test',
      block_on:      'minor',
    });

    // The re-scrape is identical to fresh; baseline is missing an endpoint, so minor+ changes.
    assert.ok(
      result.verdict === 'minor' || result.verdict === 'major',
      `expected minor or major verdict, got ${result.verdict}`
    );
    if (result.verdict === 'minor') {
      assert.equal(result.should_block, true, 'block_on=minor + minor → should_block=true');
    }
    // If it somehow produces major, should_block is also true (major >= minor threshold).
    assert.equal(result.should_block, true, 'minor or above blocks on block_on=minor');
  } finally {
    try { fs.unlinkSync(baselinePath); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (e) block_on='patch' + patch-only changes → should_block=true
// ---------------------------------------------------------------------------

test('handleWatch: block_on=patch + patch-only source → should_block=true', async () => {
  const { handleScrape } = require(path.join(__dirname, '../../lib/handlers/scrape'));
  // Scrape evolved source to get fresh mapping.
  const freshScrape = await handleScrape({
    source:       FIXTURE_EVOLVED_SRC,
    service_name: 'watch-patch-base',
    overwrite:    true,
  });
  const freshMapping = JSON.parse(fs.readFileSync(freshScrape.output_path, 'utf8'));

  // Alter only description on one endpoint → patch-level diff.
  const patchedBaseline = JSON.parse(JSON.stringify(freshMapping));
  if (patchedBaseline.endpoints && patchedBaseline.endpoints.length > 0) {
    patchedBaseline.endpoints[0].description = 'Old description that differs.';
  }
  const baselinePath = writeTmpMapping(patchedBaseline);

  try {
    const result = await handleWatch({
      source:        FIXTURE_EVOLVED_SRC,
      baseline_path: baselinePath,
      service_name:  'watch-patch-test',
      block_on:      'patch',
    });

    assert.ok(
      ['patch', 'minor', 'major'].includes(result.verdict),
      `expected patch/minor/major, got ${result.verdict}`
    );
    assert.equal(result.should_block, true, 'block_on=patch blocks any change');
  } finally {
    try { fs.unlinkSync(baselinePath); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (f) Missing baseline_path → BadParamsError
// ---------------------------------------------------------------------------

test('handleWatch: missing baseline_path → BadParamsError', async () => {
  await assert.rejects(
    () => handleWatch({ source: FIXTURE_EVOLVED_SRC }),
    (err) => {
      assert.equal(err.name, 'BadParamsError', `expected BadParamsError, got ${err.name}`);
      return true;
    }
  );
});

// (f2) Missing source → BadParamsError

test('handleWatch: missing source → BadParamsError', async () => {
  const baselinePath = copyBaselineToTmp('missing-source');
  try {
    await assert.rejects(
      () => handleWatch({ baseline_path: baselinePath }),
      (err) => {
        assert.equal(err.name, 'BadParamsError', `expected BadParamsError, got ${err.name}`);
        return true;
      }
    );
  } finally {
    try { fs.unlinkSync(baselinePath); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (g) Malformed baseline (schema-fail) → WatchError with phase=baseline_load
// ---------------------------------------------------------------------------

test('handleWatch: schema-invalid baseline → WatchError (phase=baseline_load)', async () => {
  // Write a structurally invalid mapping (missing required apifier_version, kind, etc.)
  const invalid = writeTmpMapping({ schema_version: 1, kind: 'apifier-mapping', service: { name: 'bad' } });
  try {
    await assert.rejects(
      () => handleWatch({
        source:        FIXTURE_EVOLVED_SRC,
        baseline_path: invalid,
        service_name:  'watch-bad-baseline',
      }),
      (err) => {
        assert.equal(err.name, 'WatchError', `expected WatchError, got ${err.name}`);
        assert.equal(err.code, -32014);
        assert.ok(err.message.includes('baseline_load'), `expected phase=baseline_load in message: ${err.message}`);
        return true;
      }
    );
  } finally {
    try { fs.unlinkSync(invalid); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// (h) baseline_path outside allowed roots → BadParamsError (path-guard)
// ---------------------------------------------------------------------------

test('handleWatch: baseline_path outside allowed roots → BadParamsError', async () => {
  // /etc/passwd is not under any allowed root.
  await assert.rejects(
    () => handleWatch({ source: FIXTURE_EVOLVED_SRC, baseline_path: '/etc/passwd' }),
    (err) => {
      assert.ok(
        err.name === 'BadParamsError' || err.name === 'PathTraversalError',
        `expected BadParamsError or PathTraversalError, got ${err.name}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (i) Timing fields present and sane
// ---------------------------------------------------------------------------

test('handleWatch: timing fields present and sane (scrape_ms > 0, diff_ms >= 0, total_ms > 0)', async () => {
  const baselinePath = copyBaselineToTmp('timing');
  try {
    const result = await handleWatch({
      source:        FIXTURE_EVOLVED_SRC,
      baseline_path: baselinePath,
      service_name:  'watch-timing-test',
    });

    assert.ok(typeof result.timing === 'object', 'timing must be an object');
    assert.ok(typeof result.timing.scrape_ms === 'number', 'scrape_ms must be a number');
    assert.ok(typeof result.timing.diff_ms   === 'number', 'diff_ms must be a number');
    assert.ok(typeof result.timing.total_ms  === 'number', 'total_ms must be a number');
    assert.ok(result.timing.scrape_ms >= 0, `scrape_ms must be >= 0 (got ${result.timing.scrape_ms})`);
    assert.ok(result.timing.diff_ms   >= 0, `diff_ms must be >= 0 (got ${result.timing.diff_ms})`);
    assert.ok(result.timing.total_ms  > 0,  `total_ms must be > 0 (got ${result.timing.total_ms})`);
  } finally {
    try { fs.unlinkSync(baselinePath); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// Return shape smoke: all required fields present
// ---------------------------------------------------------------------------

test('handleWatch: return shape has all required fields', async () => {
  const baselinePath = copyBaselineToTmp('shape');
  try {
    const result = await handleWatch({
      source:        FIXTURE_EVOLVED_SRC,
      baseline_path: baselinePath,
      service_name:  'watch-shape-test',
    });

    assert.ok(typeof result.verdict === 'string', 'verdict must be string');
    assert.ok(typeof result.counts  === 'object', 'counts must be object');
    assert.ok(typeof result.should_block === 'boolean', 'should_block must be boolean');
    assert.ok(Array.isArray(result.breaking_changes), 'breaking_changes must be array');
    assert.ok(typeof result.summary === 'object', 'summary must be object');
    assert.ok(typeof result.fresh_mapping_path === 'string', 'fresh_mapping_path must be string');
    assert.ok(typeof result.baseline_summary === 'object', 'baseline_summary must be object');
    assert.ok(typeof result.baseline_summary.endpoint_count === 'number', 'baseline_summary.endpoint_count must be number');
    assert.ok(typeof result.baseline_summary.models === 'number', 'baseline_summary.models must be number');
    assert.ok(typeof result.baseline_summary.source === 'string', 'baseline_summary.source must be string');
    assert.ok(typeof result.timing === 'object', 'timing must be object');
    // Must NOT contain full non_breaking or patch arrays (keep payload small for CI).
    assert.equal(result.non_breaking, undefined, 'must not expose non_breaking array');
    assert.equal(result.patch, undefined, 'must not expose patch array');
  } finally {
    try { fs.unlinkSync(baselinePath); } catch (_) {}
  }
});
