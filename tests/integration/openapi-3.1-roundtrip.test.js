'use strict';

// tests/integration/openapi-3.1-roundtrip.test.js
// Round-trip smoke: scrape realworld-petstore.yaml → mapping → generate openapi-3.1 YAML
// → re-parse via parseOpenAPI → assert endpoint set matches.
// NO network calls. All data comes from bundled fixtures.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('node:fs');
const os        = require('node:os');
const path      = require('node:path');
const crypto    = require('node:crypto');

const { handleScrape }   = require('../../lib/handlers/scrape');
const { handleGenerate } = require('../../lib/handlers/generate');
const { parseOpenAPI }   = require('../../lib/parsers/openapi');

const FIXTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'realworld-petstore.yaml');

test('openapi-3.1 round-trip: scrape petstore.yaml → generate openapi-3.1 → re-parse → endpoint match', async () => {
  const tmpYaml = path.join(os.tmpdir(), `apifier-oai31-roundtrip-${process.pid}.yaml`);

  let mappingPath;

  try {
    // ------------------------------------------------------------------
    // Step 1: Scrape the local YAML fixture (no network)
    // ------------------------------------------------------------------
    const scrapeResult = await handleScrape({
      source:       FIXTURE_PATH,
      service_name: 'oai31-roundtrip-test',
      overwrite:    true,
    });

    mappingPath = scrapeResult.output_path;
    assert.ok(typeof mappingPath === 'string' && mappingPath.length > 0, 'scrape must return output_path');
    assert.ok(scrapeResult.endpoint_count > 0, 'scrape must find at least one endpoint');

    // ------------------------------------------------------------------
    // Step 2: Generate openapi-3.1 YAML from the mapping
    // ------------------------------------------------------------------
    const genResult = await handleGenerate({
      mapping_path: mappingPath,
      target:       'openapi-3.1',
      out_path:     tmpYaml,
      overwrite:    true,
    });

    assert.ok(genResult.bytes_written > 0, 'generate must write non-zero bytes');
    assert.equal(path.extname(genResult.output_path), '.yaml', 'output file must have .yaml extension');

    // ------------------------------------------------------------------
    // Step 3: Read the generated YAML
    // ------------------------------------------------------------------
    const yamlText = fs.readFileSync(tmpYaml, 'utf8');
    assert.ok(yamlText.startsWith('#'), 'generated YAML must start with provenance comment');
    assert.ok(yamlText.includes('openapi: 3.1.0'), 'generated YAML must declare openapi: 3.1.0');
    assert.ok(yamlText.includes('paths:'), 'generated YAML must include paths: section');

    // ------------------------------------------------------------------
    // Step 4: Re-parse the generated YAML via parseOpenAPI
    // ------------------------------------------------------------------
    const { ir: reparsed, warnings } = await parseOpenAPI({
      body:         yamlText,
      content_type: 'application/yaml',
      source_url:   null,
    });

    // No hard parse errors (warnings are OK)
    assert.ok(
      Array.isArray(reparsed.endpoints),
      're-parsed IR must have an endpoints array'
    );

    // ------------------------------------------------------------------
    // Step 5: Assert non-zero endpoint count
    // ------------------------------------------------------------------
    assert.ok(
      reparsed.endpoints.length > 0,
      `re-parsed spec must have > 0 endpoints, got ${reparsed.endpoints.length}`
    );

    // ------------------------------------------------------------------
    // Step 6: Assert (method, path) set matches
    // ------------------------------------------------------------------
    // Load the mapping to get the original set
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    const httpEndpoints = mapping.endpoints.filter(ep => !ep.transport || ep.transport === 'http');

    const originalSet = new Set(httpEndpoints.map(ep => `${ep.method} ${ep.path}`));
    const reparsedSet = new Set(reparsed.endpoints.map(ep => `${ep.method} ${ep.path}`));

    // Every original endpoint must appear in the re-parsed set
    for (const key of originalSet) {
      assert.ok(
        reparsedSet.has(key),
        `re-parsed spec missing endpoint '${key}'. Re-parsed: ${[...reparsedSet].join(', ')}`
      );
    }

    // And re-parsed should not have spurious extra endpoints
    assert.equal(
      reparsedSet.size,
      originalSet.size,
      `endpoint count mismatch: original=${originalSet.size}, reparsed=${reparsedSet.size}`
    );

    // ------------------------------------------------------------------
    // Step 7: Byte-determinism check — generate twice and compare sha256
    // ------------------------------------------------------------------
    const tmpYaml2 = path.join(os.tmpdir(), `apifier-oai31-roundtrip2-${process.pid}.yaml`);
    try {
      await handleGenerate({
        mapping_path: mappingPath,
        target:       'openapi-3.1',
        out_path:     tmpYaml2,
        overwrite:    true,
      });
      const run1Hash = crypto.createHash('sha256').update(yamlText).digest('hex');
      const run2Text = fs.readFileSync(tmpYaml2, 'utf8');
      const run2Hash = crypto.createHash('sha256').update(run2Text).digest('hex');
      assert.equal(run1Hash, run2Hash, 'two generate runs must produce byte-identical output (same sha256)');
    } finally {
      try { fs.unlinkSync(tmpYaml2); } catch (_) { /* ignore */ }
    }

  } finally {
    // Clean up tmp files
    try { fs.unlinkSync(tmpYaml); } catch (_) { /* ignore */ }
  }
});

test('openapi-3.1 round-trip: curl-shell target is now supported (wave 4E)', async () => {
  const { handleGenerate: hg } = require('../../lib/handlers/generate');

  // Need a valid mapping to get past the mapping-read check
  const { handleScrape } = require('../../lib/handlers/scrape');
  const scrapeResult = await handleScrape({
    source:       FIXTURE_PATH,
    service_name: 'oai31-curl-check',
    overwrite:    true,
  });

  const outSh = path.join(os.tmpdir(), `apifier-curl-test-${process.pid}.sh`);
  const result = await hg({
    mapping_path: scrapeResult.output_path,
    target:       'curl-shell',
    out_path:     outSh,
    overwrite:    true,
  });

  assert.ok(result.output_path.endsWith('.sh'), 'output path must end with .sh');
  assert.ok(result.bytes_written > 0, 'must have written some bytes');

  // Verify the generated file passes bash -n
  const { execSync } = require('node:child_process');
  execSync(`bash -n ${JSON.stringify(outSh)}`, { stdio: 'pipe' });

  // Clean up
  try { fs.unlinkSync(outSh); } catch (_) { /* ignore */ }
});

// ---------------------------------------------------------------------------
// W40-R-02 regression guard: ts-axios + python-httpx are the only remaining
// unsupported codegen targets. They MUST throw CodegenNotSupportedError until
// their respective waves ship. Without this test, a future wave that
// accidentally registers a stub handler would have no integration safety net.
// ---------------------------------------------------------------------------

for (const stillUnsupportedTarget of ['ts-axios', 'python-httpx']) {
  test(`unsupported codegen guard: target '${stillUnsupportedTarget}' throws CodegenNotSupportedError`, async () => {
    const { handleGenerate: hg } = require('../../lib/handlers/generate');
    const { handleScrape }       = require('../../lib/handlers/scrape');
    const { CodegenNotSupportedError } = require('../../lib/errors');

    const scrapeResult = await handleScrape({
      source:       FIXTURE_PATH,
      service_name: `oai31-unsupported-${stillUnsupportedTarget}-check`,
      overwrite:    true,
    });

    const ext = stillUnsupportedTarget.startsWith('ts-') ? '.ts' : '.py';
    const outFile = path.join(os.tmpdir(),
      `apifier-unsupported-${stillUnsupportedTarget}-${process.pid}${ext}`);

    let thrown = null;
    try {
      await hg({
        mapping_path: scrapeResult.output_path,
        target:       stillUnsupportedTarget,
        out_path:     outFile,
        overwrite:    true,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, `must throw for ${stillUnsupportedTarget}`);
    assert.equal(thrown.constructor.name, 'CodegenNotSupportedError',
      `must be CodegenNotSupportedError (got ${thrown.constructor.name})`);
    assert.match(thrown.message, /\b(wave|not\s+(?:yet\s+)?supported)\b/i,
      'error message must reference the scheduled wave or unsupported state');

    // Cleanup (file shouldn't exist anyway).
    try { fs.unlinkSync(outFile); } catch (_) { /* ignore */ }
  });
}
