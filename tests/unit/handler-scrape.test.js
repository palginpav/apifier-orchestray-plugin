'use strict';

// tests/unit/handler-scrape.test.js — Unit tests for lib/handlers/scrape.js.

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const path       = require('node:path');
const fs         = require('node:fs');
const os         = require('node:os');

const { handleScrape } = require(path.join(__dirname, '../../lib/handlers/scrape'));
const { readMapping }  = require(path.join(__dirname, '../../lib/mapping/read'));

const FIXTURE = path.join(__dirname, '../fixtures/sample-openapi-3.0.json');

// ---------------------------------------------------------------------------
// End-to-end: file source → handler → mapping on disk
// ---------------------------------------------------------------------------

test('handleScrape with file source returns correct shape', async () => {
  const result = await handleScrape({
    source:       FIXTURE,
    service_name: 'scrape-test',
    overwrite:    true,
    output_dir:   os.tmpdir(),
  });

  assert.ok(typeof result.output_path === 'string', 'output_path must be a string');
  assert.ok(result.output_path.endsWith('.apifier.json'), 'output_path must end with .apifier.json');
  assert.ok(typeof result.endpoint_count === 'number', 'endpoint_count must be a number');
  assert.ok(result.endpoint_count >= 3, 'fixture has at least 3 endpoints');
  assert.ok(Array.isArray(result.head_sample), 'head_sample must be an array');
  assert.ok(result.head_sample.length <= 2, 'head_sample has at most 2 entries');
  assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
  assert.ok(result.source && typeof result.source.sha256 === 'string', 'source.sha256 must be present');
  assert.ok(result.source.fetched_at, 'source.fetched_at must be present');
});

test('handleScrape head_sample entries have method, path, summary', async () => {
  const result = await handleScrape({
    source:       FIXTURE,
    service_name: 'scrape-test-sample',
    overwrite:    true,
    output_dir:   os.tmpdir(),
  });

  for (const entry of result.head_sample) {
    assert.ok(typeof entry.method === 'string', 'head_sample entry must have method');
    assert.ok(typeof entry.path === 'string',   'head_sample entry must have path');
    assert.ok('summary' in entry,               'head_sample entry must have summary key');
  }
});

test('handleScrape output file exists and validates', async () => {
  const result = await handleScrape({
    source:       FIXTURE,
    service_name: 'scrape-validate',
    overwrite:    true,
    output_dir:   os.tmpdir(),
  });

  assert.ok(fs.existsSync(result.output_path), 'output file must exist on disk');

  const { mapping, validation } = readMapping({ mapping_path: result.output_path });
  assert.ok(validation.ok, `mapping must pass schema validation; errors: ${validation.errors.join(', ')}`);
  assert.equal(mapping.schema_version, 1);
  assert.ok(Array.isArray(mapping.endpoints));
  assert.ok(mapping.endpoints.length >= 3);
});

test('handleScrape throws BadParamsError when source is missing', async () => {
  const { BadParamsError } = require(path.join(__dirname, '../../lib/errors'));
  await assert.rejects(
    () => handleScrape({}),
    err => err instanceof BadParamsError
  );
});
