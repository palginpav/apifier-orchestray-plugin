'use strict';

// tests/integration/real-world-formats.test.js
// Real-world format integration tests: three hand-trimmed fixtures exercise
// YAML, HTML (Stripe-style), and Markdown parsers through the full pipeline:
// scrape → validate → ts-fetch codegen → python-requests codegen.
// NO network calls. All data comes from local fixture files.

const { test }     = require('node:test');
const assert       = require('node:assert/strict');
const fs           = require('node:fs');
const os           = require('node:os');
const path         = require('node:path');
const { execSync } = require('node:child_process');

const { handleScrape }   = require('../../lib/handlers/scrape');
const { handleValidate } = require('../../lib/handlers/validate');
const { handleGenerate } = require('../../lib/handlers/generate');

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

// ---------------------------------------------------------------------------
// Helper: run node --check and (optionally) py_compile; clean up tmp files.
// ---------------------------------------------------------------------------
function checkSyntax(tmpTs, tmpPy) {
  execSync(`node --check ${tmpTs}`, { stdio: 'pipe' });

  let python3Available = false;
  try {
    execSync('python3 --version', { stdio: 'pipe' });
    python3Available = true;
  } catch (_) {
    console.log('[real-world-formats] python3 not found on PATH — skipping py_compile check');
  }
  if (python3Available) {
    execSync(`python3 -m py_compile ${tmpPy}`, { stdio: 'pipe' });
  }
}

// ---------------------------------------------------------------------------
// Sub-test 1: Petstore OpenAPI YAML
// ---------------------------------------------------------------------------
test('real-world YAML fixture: scrape → validate → ts-fetch → python-requests', async () => {
  const fixturePath = path.join(FIXTURES, 'realworld-petstore.yaml');
  const tmpTs = path.join(os.tmpdir(), `apifier-rw-yaml-${process.pid}.ts`);
  const tmpPy = path.join(os.tmpdir(), `apifier-rw-yaml-${process.pid}.py`);
  let mappingPath;

  try {
    // Step 1: Scrape
    const scrapeResult = await handleScrape({
      source:       fixturePath,
      service_name: 'realworld-yaml-rw',
      overwrite:    true,
    });

    mappingPath = scrapeResult.output_path;
    assert.ok(typeof mappingPath === 'string' && mappingPath.length > 0, 'scrape must return output_path');
    assert.ok(scrapeResult.endpoint_count >= 3, `expected >= 3 endpoints, got ${scrapeResult.endpoint_count}`);
    assert.strictEqual(scrapeResult.head_sample.length, 2, 'head_sample must contain exactly 2 entries');

    // YAML fixture should be detected as openapi
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    assert.strictEqual(mapping.source.type, 'openapi', 'YAML fixture source.type must be "openapi"');

    // Step 2: Validate
    const validateResult = await handleValidate({ mapping_path: mappingPath });
    assert.strictEqual(validateResult.ok, true, `validate must return ok=true; errors: ${JSON.stringify(validateResult.errors)}`);

    // Step 3: ts-fetch codegen
    const tsResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     tmpTs,
      overwrite:    true,
    });
    assert.ok(fs.existsSync(tmpTs), 'ts-fetch output file must exist');
    assert.ok(tsResult.bytes_written > 0, 'ts-fetch output must be non-empty');

    // Step 4: python-requests codegen
    const pyResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'python-requests',
      out_path:     tmpPy,
      overwrite:    true,
    });
    assert.ok(fs.existsSync(tmpPy), 'python-requests output file must exist');
    assert.ok(pyResult.bytes_written > 0, 'python-requests output must be non-empty');

    // Step 5: Syntax checks
    checkSyntax(tmpTs, tmpPy);

  } finally {
    for (const f of [tmpTs, tmpPy]) {
      try { fs.unlinkSync(f); } catch (_) { /* ignore missing */ }
    }
  }
});

// ---------------------------------------------------------------------------
// Sub-test 2: Stripe-style HTML fixture
// ---------------------------------------------------------------------------
test('real-world HTML fixture (Stripe-style): scrape → validate → ts-fetch → python-requests', async () => {
  const fixturePath = path.join(FIXTURES, 'realworld-stripe-style.html');
  const tmpTs = path.join(os.tmpdir(), `apifier-rw-html-${process.pid}.ts`);
  const tmpPy = path.join(os.tmpdir(), `apifier-rw-html-${process.pid}.py`);
  let mappingPath;

  try {
    // Step 1: Scrape
    const scrapeResult = await handleScrape({
      source:       fixturePath,
      service_name: 'realworld-html-rw',
      overwrite:    true,
    });

    mappingPath = scrapeResult.output_path;
    assert.ok(typeof mappingPath === 'string' && mappingPath.length > 0, 'scrape must return output_path');
    assert.ok(scrapeResult.endpoint_count >= 3, `expected >= 3 endpoints, got ${scrapeResult.endpoint_count}`);
    assert.strictEqual(scrapeResult.head_sample.length, 2, 'head_sample must contain exactly 2 entries');

    // HTML fixture: mapping must have x-html-archetype extension
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    const archetype = mapping.extensions && mapping.extensions['x-html-archetype'];
    assert.ok(
      typeof archetype === 'string' && archetype.length > 0,
      `mapping.extensions["x-html-archetype"] must be populated; got ${JSON.stringify(archetype)}`
    );
    const validArchetypes = ['stripe-slate', 'docusaurus', 'gitbook', 'generic', 'openapi-rendered'];
    assert.ok(
      validArchetypes.includes(archetype),
      `x-html-archetype must be one of ${validArchetypes.join(', ')}; got "${archetype}"`
    );

    // Step 2: Validate
    const validateResult = await handleValidate({ mapping_path: mappingPath });
    assert.strictEqual(validateResult.ok, true, `validate must return ok=true; errors: ${JSON.stringify(validateResult.errors)}`);

    // Step 3: ts-fetch codegen
    const tsResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     tmpTs,
      overwrite:    true,
    });
    assert.ok(fs.existsSync(tmpTs), 'ts-fetch output file must exist');
    assert.ok(tsResult.bytes_written > 0, 'ts-fetch output must be non-empty');

    // Step 4: python-requests codegen
    const pyResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'python-requests',
      out_path:     tmpPy,
      overwrite:    true,
    });
    assert.ok(fs.existsSync(tmpPy), 'python-requests output file must exist');
    assert.ok(pyResult.bytes_written > 0, 'python-requests output must be non-empty');

    // Step 5: Syntax checks
    checkSyntax(tmpTs, tmpPy);

  } finally {
    for (const f of [tmpTs, tmpPy]) {
      try { fs.unlinkSync(f); } catch (_) { /* ignore missing */ }
    }
  }
});

// ---------------------------------------------------------------------------
// Sub-test 3: GitHub-style Markdown fixture
// ---------------------------------------------------------------------------
test('real-world Markdown fixture (GitHub-style): scrape → validate → ts-fetch → python-requests', async () => {
  const fixturePath = path.join(FIXTURES, 'realworld-github-style.md');
  const tmpTs = path.join(os.tmpdir(), `apifier-rw-md-${process.pid}.ts`);
  const tmpPy = path.join(os.tmpdir(), `apifier-rw-md-${process.pid}.py`);
  let mappingPath;

  try {
    // Step 1: Scrape
    const scrapeResult = await handleScrape({
      source:       fixturePath,
      service_name: 'realworld-md-rw',
      overwrite:    true,
    });

    mappingPath = scrapeResult.output_path;
    assert.ok(typeof mappingPath === 'string' && mappingPath.length > 0, 'scrape must return output_path');
    assert.ok(scrapeResult.endpoint_count >= 3, `expected >= 3 endpoints, got ${scrapeResult.endpoint_count}`);
    assert.strictEqual(scrapeResult.head_sample.length, 2, 'head_sample must contain exactly 2 entries');

    // Markdown fixture: mapping must have x-source-format === "markdown"
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    const sourceFormat = mapping.extensions && mapping.extensions['x-source-format'];
    assert.strictEqual(
      sourceFormat,
      'markdown',
      `mapping.extensions["x-source-format"] must be "markdown"; got ${JSON.stringify(sourceFormat)}`
    );

    // Step 2: Validate
    const validateResult = await handleValidate({ mapping_path: mappingPath });
    assert.strictEqual(validateResult.ok, true, `validate must return ok=true; errors: ${JSON.stringify(validateResult.errors)}`);

    // Step 3: ts-fetch codegen
    const tsResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     tmpTs,
      overwrite:    true,
    });
    assert.ok(fs.existsSync(tmpTs), 'ts-fetch output file must exist');
    assert.ok(tsResult.bytes_written > 0, 'ts-fetch output must be non-empty');

    // Step 4: python-requests codegen
    const pyResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'python-requests',
      out_path:     tmpPy,
      overwrite:    true,
    });
    assert.ok(fs.existsSync(tmpPy), 'python-requests output file must exist');
    assert.ok(pyResult.bytes_written > 0, 'python-requests output must be non-empty');

    // Step 5: Syntax checks
    checkSyntax(tmpTs, tmpPy);

  } finally {
    for (const f of [tmpTs, tmpPy]) {
      try { fs.unlinkSync(f); } catch (_) { /* ignore missing */ }
    }
  }
});
