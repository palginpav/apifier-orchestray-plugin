'use strict';

// tests/integration/real-world-petstore.test.js
// Real-world smoke test: ingest petstore-openapi-3.0.json fixture → validate →
// generate ts-fetch → node --check → generate python-requests → py_compile.
// NO network calls. All data comes from the bundled fixture.

const { test }    = require('node:test');
const assert      = require('node:assert/strict');
const fs          = require('node:fs');
const os          = require('node:os');
const path        = require('node:path');
const { execSync } = require('node:child_process');

const { handleScrape }   = require('../../lib/handlers/scrape');
const { handleValidate } = require('../../lib/handlers/validate');
const { handleGenerate } = require('../../lib/handlers/generate');

const FIXTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'petstore-openapi-3.0.json');

test('petstore real-world smoke: scrape → validate → ts-fetch → python-requests', async (t) => {
  // Paths for tmp output files — os.tmpdir() is in path-guard allowed roots.
  const tmpTs = path.join(os.tmpdir(), `apifier-petstore-test-${process.pid}.ts`);
  const tmpPy = path.join(os.tmpdir(), `apifier-petstore-test-${process.pid}.py`);

  let mappingPath;

  try {
    // ------------------------------------------------------------------
    // Step 1: Scrape the local fixture (no network)
    // ------------------------------------------------------------------
    const scrapeResult = await handleScrape({
      source:       FIXTURE_PATH,
      service_name: 'petstore-test',
      overwrite:    true,
    });

    mappingPath = scrapeResult.output_path;

    assert.ok(
      typeof mappingPath === 'string' && mappingPath.length > 0,
      'scrape must return output_path'
    );

    // Step 2: Verify scrape result fields
    assert.ok(
      scrapeResult.endpoint_count >= 5,
      `expected >= 5 endpoints, got ${scrapeResult.endpoint_count}`
    );

    assert.strictEqual(
      scrapeResult.head_sample.length,
      2,
      'head_sample must contain exactly 2 entries'
    );

    assert.ok(
      typeof scrapeResult.source.sha256 === 'string' && scrapeResult.source.sha256.length === 64,
      'source.sha256 must be a 64-char hex string'
    );

    // ------------------------------------------------------------------
    // Step 3: Validate the produced mapping
    // ------------------------------------------------------------------
    const validateResult = await handleValidate({ mapping_path: mappingPath });

    assert.strictEqual(validateResult.ok, true, `validate must return ok=true; errors: ${JSON.stringify(validateResult.errors)}`);

    // ------------------------------------------------------------------
    // Step 4: Generate ts-fetch client
    // ------------------------------------------------------------------
    const tsResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     tmpTs,
      overwrite:    true,
    });

    assert.ok(fs.existsSync(tmpTs), 'ts-fetch output file must exist');
    assert.ok(
      tsResult.bytes_written > 2000,
      `ts-fetch output must be > 2000 bytes, got ${tsResult.bytes_written}`
    );

    // Step 5: Syntax-check the emitted TypeScript
    execSync(`node --check ${tmpTs}`, { stdio: 'pipe' });

    // ------------------------------------------------------------------
    // Step 6: Generate python-requests client
    // ------------------------------------------------------------------
    const pyResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'python-requests',
      out_path:     tmpPy,
      overwrite:    true,
    });

    assert.ok(fs.existsSync(tmpPy), 'python-requests output file must exist');
    assert.ok(
      pyResult.bytes_written > 0,
      'python-requests output must be non-empty'
    );

    // Step 7: py_compile check (skip if python3 not on PATH)
    let python3Available = false;
    try {
      execSync('python3 --version', { stdio: 'pipe' });
      python3Available = true;
    } catch (_) {
      console.log('[smoke] python3 not found on PATH — skipping py_compile check');
    }

    if (python3Available) {
      execSync(`python3 -m py_compile ${tmpPy}`, { stdio: 'pipe' });
    }

  } finally {
    // Cleanup tmp files regardless of pass/fail
    for (const f of [tmpTs, tmpPy]) {
      try { fs.unlinkSync(f); } catch (_) { /* ignore missing */ }
    }
  }
});
