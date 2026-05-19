'use strict';

// tests/unit/handler-generate.test.js — Unit tests for lib/handlers/generate.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');
const os        = require('node:os');
const crypto    = require('node:crypto');

const { handleGenerate }          = require(path.join(__dirname, '../../lib/handlers/generate'));
const { handleScrape }            = require(path.join(__dirname, '../../lib/handlers/scrape'));
const { CodegenNotSupportedError, BadParamsError } = require(path.join(__dirname, '../../lib/errors'));

const FIXTURE_OPENAPI = path.join(__dirname, '../fixtures/sample-openapi-3.0.json');
const MAPPING_FIXTURE = path.join(__dirname, '../fixtures/sample-mapping-v1.json');

// ---------------------------------------------------------------------------
// Helper: create a fresh mapping file from the sample OpenAPI fixture
// ---------------------------------------------------------------------------

async function freshMapping(tag) {
  const result = await handleScrape({
    source:       FIXTURE_OPENAPI,
    service_name: `generate-test-${tag}`,
    overwrite:    true,
    output_dir:   os.tmpdir(),
  });
  return result.output_path;
}

// ---------------------------------------------------------------------------
// (a) target: 'ts-axios' throws CodegenNotSupportedError with wave info
// ---------------------------------------------------------------------------

test('handleGenerate throws CodegenNotSupportedError for ts-axios target', async () => {
  const mappingPath = await freshMapping('ts-axios');
  await assert.rejects(
    () => handleGenerate({ mapping_path: mappingPath, target: 'ts-axios', out_path: path.join(os.tmpdir(), 'test.ts') }),
    (err) => {
      assert.ok(err instanceof CodegenNotSupportedError, `expected CodegenNotSupportedError, got ${err.constructor.name}`);
      assert.equal(err.code, -32007, 'must have code -32007');
      assert.ok(err.message.includes('ts-axios'), 'message must include target name');
      assert.ok(err.message.includes('wave') || err.message.includes('Wave'), 'message must mention wave');
      assert.equal(err.data.target, 'ts-axios', 'data.target must be ts-axios');
      assert.ok(err.data.scheduled_wave, 'data.scheduled_wave must be set');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (b) target: 'ts-fetch' writes a file at out_path
// ---------------------------------------------------------------------------

test('handleGenerate writes a .ts file for ts-fetch target', async () => {
  const mappingPath = await freshMapping('ts-fetch-write');
  const outFile = path.join(os.tmpdir(), `generate-test-ts-fetch-${Date.now()}.ts`);
  try {
    const result = await handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     outFile,
      overwrite:    true,
    });
    assert.ok(fs.existsSync(outFile), 'output file must exist');
    assert.equal(result.output_path, outFile, 'output_path must match out_path');
    assert.equal(result.target, 'ts-fetch', 'target must be ts-fetch');
    assert.ok(result.bytes_written > 0, 'bytes_written must be positive');
    assert.ok(typeof result.fingerprint === 'string' && result.fingerprint.length === 64, 'fingerprint must be 64-char hex');
    const content = fs.readFileSync(outFile, 'utf8');
    assert.ok(content.includes('Client'), 'generated file must contain "Client"');
  } finally {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }
});

// ---------------------------------------------------------------------------
// (c) out_path ending in .py (extension mismatch) is rejected
// ---------------------------------------------------------------------------

test('handleGenerate rejects out_path with wrong extension for ts-fetch', async () => {
  const mappingPath = await freshMapping('ext-mismatch');
  await assert.rejects(
    () => handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     path.join(os.tmpdir(), 'wrong-ext.py'),
    }),
    (err) => {
      assert.ok(err instanceof BadParamsError, `expected BadParamsError, got ${err.constructor.name}`);
      assert.ok(err.message.includes('.ts'), 'error must mention the expected extension');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (d) out_path outside allowed roots is rejected
// ---------------------------------------------------------------------------

test('handleGenerate rejects out_path outside allowed roots', async () => {
  const mappingPath = await freshMapping('path-guard');
  await assert.rejects(
    () => handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     '/etc/not-allowed/output.ts',
    }),
    (err) => {
      assert.ok(err instanceof BadParamsError, `expected BadParamsError, got ${err.constructor.name}`);
      assert.ok(
        err.message.includes('security') || err.message.includes('allowed root') || err.message.includes('traversal'),
        `error message should indicate path security issue: ${err.message}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (e) overwrite: false against existing file is rejected
// ---------------------------------------------------------------------------

test('handleGenerate rejects overwrite of existing file when overwrite=false', async () => {
  const mappingPath = await freshMapping('overwrite-false');
  const outFile = path.join(os.tmpdir(), `generate-overwrite-test-${Date.now()}.ts`);
  try {
    // First write
    await handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     outFile,
      overwrite:    false,
    });
    assert.ok(fs.existsSync(outFile), 'first write must succeed');

    // Second write with overwrite=false must fail
    await assert.rejects(
      () => handleGenerate({
        mapping_path: mappingPath,
        target:       'ts-fetch',
        out_path:     outFile,
        overwrite:    false,
      }),
      (err) => {
        assert.ok(err instanceof BadParamsError, `expected BadParamsError, got ${err.constructor.name}`);
        assert.ok(err.message.includes('already exists'), 'message must say file already exists');
        return true;
      }
    );
  } finally {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }
});

// ---------------------------------------------------------------------------
// (f) Returned fingerprint is the sha256 of the file
// ---------------------------------------------------------------------------

test('handleGenerate fingerprint matches sha256 of the written file', async () => {
  const mappingPath = await freshMapping('fingerprint');
  const outFile = path.join(os.tmpdir(), `generate-fp-test-${Date.now()}.ts`);
  try {
    const result = await handleGenerate({
      mapping_path: mappingPath,
      target:       'ts-fetch',
      out_path:     outFile,
      overwrite:    true,
    });
    const fileBytes = fs.readFileSync(outFile);
    const expectedFp = crypto.createHash('sha256').update(fileBytes).digest('hex');
    assert.equal(result.fingerprint, expectedFp, 'fingerprint must be sha256 of written file bytes');
  } finally {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }
});

// ---------------------------------------------------------------------------
// (g) target: 'python-requests' also throws CodegenNotSupportedError
// ---------------------------------------------------------------------------

test('handleGenerate throws CodegenNotSupportedError for python-requests target', async () => {
  const mappingPath = await freshMapping('py-requests');
  await assert.rejects(
    () => handleGenerate({
      mapping_path: mappingPath,
      target:       'python-requests',
      out_path:     path.join(os.tmpdir(), 'test.py'),
    }),
    (err) => {
      assert.ok(err instanceof CodegenNotSupportedError, `expected CodegenNotSupportedError, got ${err.constructor.name}`);
      assert.equal(err.data.target, 'python-requests');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (h) Direct mapping path test using sample-mapping-v1.json fixture
// ---------------------------------------------------------------------------

test('handleGenerate can use sample-mapping-v1.json directly', async () => {
  const outFile = path.join(os.tmpdir(), `generate-direct-${Date.now()}.ts`);
  try {
    const result = await handleGenerate({
      mapping_path: MAPPING_FIXTURE,
      target:       'ts-fetch',
      out_path:     outFile,
      overwrite:    true,
    });
    assert.ok(fs.existsSync(outFile), 'output file must exist');
    const content = fs.readFileSync(outFile, 'utf8');
    assert.ok(content.includes('WidgetsApiClient'), 'must contain WidgetsApiClient class');
    assert.ok(result.bytes_written > 0);
  } finally {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }
});
