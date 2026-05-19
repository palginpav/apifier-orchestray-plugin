'use strict';

// tests/unit/handler-validate.test.js — Unit tests for lib/handlers/validate.js.

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const path       = require('node:path');
const fs         = require('node:fs');
const os         = require('node:os');

const { handleValidate } = require(path.join(__dirname, '../../lib/handlers/validate'));
const { handleScrape }   = require(path.join(__dirname, '../../lib/handlers/scrape'));

const FIXTURE = path.join(__dirname, '../fixtures/sample-openapi-3.0.json');

// ---------------------------------------------------------------------------
// Helper: create a fresh mapping file via handleScrape
// ---------------------------------------------------------------------------

async function freshMapping(tag) {
  const result = await handleScrape({
    source:       FIXTURE,
    service_name: `validate-test-${tag}`,
    overwrite:    true,
    output_dir:   os.tmpdir(),
  });
  return result.output_path;
}

// ---------------------------------------------------------------------------
// Valid mapping → ok=true
// ---------------------------------------------------------------------------

test('handleValidate returns ok=true for a freshly written mapping', async () => {
  const mappingPath = await freshMapping('ok');
  const result = await handleValidate({ mapping_path: mappingPath });

  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 1);
  assert.ok(result.endpoint_count >= 3, 'endpoint_count must reflect the fixture');
  assert.ok(Array.isArray(result.errors), 'errors must be array');
  assert.equal(result.errors.length, 0, 'no errors for valid mapping');
  assert.ok(Array.isArray(result.warnings), 'warnings must be array');
});

// ---------------------------------------------------------------------------
// Corrupted JSON → ok=false with error array
// ---------------------------------------------------------------------------

test('handleValidate returns ok=false for corrupted JSON', async () => {
  const tmp = path.join(os.tmpdir(), `apifier-corrupt-${Date.now()}.apifier.json`);
  fs.writeFileSync(tmp, '{ this is not valid json }', 'utf8');
  try {
    const result = await handleValidate({ mapping_path: tmp });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, 'errors must be non-empty for corrupt JSON');
    assert.ok(result.errors[0].toLowerCase().includes('parse') || result.errors[0].toLowerCase().includes('json'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ---------------------------------------------------------------------------
// Missing file → throws (readMapping throws on ENOENT)
// ---------------------------------------------------------------------------

test('handleValidate throws when file does not exist', async () => {
  await assert.rejects(
    () => handleValidate({ mapping_path: '/tmp/apifier-totally-nonexistent.apifier.json' }),
    err => err.code === 'ENOENT' || err.message.includes('not found')
  );
});

// ---------------------------------------------------------------------------
// strict=true with warnings → ok=false
// ---------------------------------------------------------------------------

test('handleValidate strict=true with parser warnings sets ok=false', async () => {
  // Create a mapping that has parser_warnings in source.
  const mappingPath = await freshMapping('strict');

  // Patch the mapping file to inject a parser_warning.
  const raw  = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  raw.source.parser_warnings = [{ code: 'test_warn', detail: 'injected warning for test' }];
  fs.writeFileSync(mappingPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');

  const resultStrict = await handleValidate({ mapping_path: mappingPath, strict: true });
  assert.equal(resultStrict.ok, false, 'strict mode must set ok=false when there are warnings');
  assert.ok(resultStrict.warnings.length > 0, 'warnings must be non-empty');

  const resultLenient = await handleValidate({ mapping_path: mappingPath, strict: false });
  assert.equal(resultLenient.ok, true, 'lenient mode must still be ok=true');
});

// ---------------------------------------------------------------------------
// BadParamsError when mapping_path is missing
// ---------------------------------------------------------------------------

test('handleValidate throws BadParamsError when mapping_path is missing', async () => {
  const { BadParamsError } = require(path.join(__dirname, '../../lib/errors'));
  await assert.rejects(
    () => handleValidate({}),
    err => err instanceof BadParamsError
  );
});
