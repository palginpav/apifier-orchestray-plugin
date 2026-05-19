'use strict';

// tests/unit/handler-list.test.js — Unit tests for lib/handlers/list.js.

const { test, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const fs      = require('node:fs');
const os      = require('node:os');

const { handleList } = require(path.join(__dirname, '../../lib/handlers/list'));
const { BadParamsError } = require(path.join(__dirname, '../../lib/errors'));

// Use a temp dir under os.tmpdir() so path-guard allows it.
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-list-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Minimal valid mapping structure matching the schema.
const SAMPLE_FIXTURE = path.join(__dirname, '../fixtures/sample-mapping-v1.json');

function copyFixture(destName) {
  const dest = path.join(tmpDir, destName);
  fs.copyFileSync(SAMPLE_FIXTURE, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Empty dir
// ---------------------------------------------------------------------------

test('handleList: empty dir returns zero count', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-list-empty-'));
  try {
    const result = await handleList({ dir: emptyDir });
    assert.equal(result.mapping_count, 0);
    assert.deepEqual(result.mappings, []);
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('handleList: non-existent dir returns zero count', async () => {
  const nonExistent = path.join(os.tmpdir(), 'apifier-nonexistent-' + Date.now());
  const result = await handleList({ dir: nonExistent });
  assert.equal(result.mapping_count, 0);
  assert.deepEqual(result.mappings, []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// One valid mapping
// ---------------------------------------------------------------------------

test('handleList: one valid mapping returns correct metadata', async () => {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-list-one-'));
  try {
    copyFixture.toString(); // noop
    const dest = path.join(dir1, 'widgets-api.apifier.json');
    fs.copyFileSync(SAMPLE_FIXTURE, dest);

    const result = await handleList({ dir: dir1 });
    assert.equal(result.mapping_count, 1);
    assert.equal(result.errors.length, 0);
    const meta = result.mappings[0];
    assert.equal(meta.file, dest);
    assert.equal(meta.service_name, 'widgets-api');
    assert.equal(meta.schema_version, 1);
    assert.ok(typeof meta.endpoint_count === 'number' || meta.endpoint_count === null);
    assert.ok(meta.validation_ok === true);
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// One valid + one corrupted (include_invalid=false)
// ---------------------------------------------------------------------------

test('handleList: corrupted mapping goes to errors[] when include_invalid=false', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-list-corrupt-'));
  try {
    // Valid file.
    fs.copyFileSync(SAMPLE_FIXTURE, path.join(dir2, 'valid.apifier.json'));
    // Corrupted file.
    const badPath = path.join(dir2, 'corrupt.apifier.json');
    fs.writeFileSync(badPath, '{ not valid json {{', 'utf8');

    const result = await handleList({ dir: dir2, include_invalid: false });
    assert.equal(result.mappings.length, 1, 'only valid mapping returned');
    assert.equal(result.errors.length, 1, 'corrupted file in errors[]');
    assert.ok(result.errors[0].endsWith('corrupt.apifier.json'));
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('handleList: corrupted mapping included when include_invalid=true', async () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-list-corrupt2-'));
  try {
    fs.copyFileSync(SAMPLE_FIXTURE, path.join(dir3, 'valid.apifier.json'));
    const badPath = path.join(dir3, 'corrupt.apifier.json');
    fs.writeFileSync(badPath, '{ bad json', 'utf8');

    const result = await handleList({ dir: dir3, include_invalid: true });
    assert.equal(result.errors.length, 0, 'no errors when include_invalid=true');
    assert.equal(result.mappings.length, 2);
    const corrupt = result.mappings.find(m => m.file.endsWith('corrupt.apifier.json'));
    assert.ok(corrupt, 'corrupt entry present');
    assert.equal(corrupt.validation_ok, false);
  } finally {
    fs.rmSync(dir3, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// filter parameter
// ---------------------------------------------------------------------------

test('handleList: filter matches case-insensitively on service_name', async () => {
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-list-filter-'));
  try {
    // widgets-api.apifier.json matches "widget".
    fs.copyFileSync(SAMPLE_FIXTURE, path.join(dir4, 'widgets-api.apifier.json'));
    // Create another valid mapping with a different service_name.
    const rawMapping = JSON.parse(fs.readFileSync(SAMPLE_FIXTURE, 'utf8'));
    const altMapping = { ...rawMapping, service: { ...rawMapping.service, name: 'payments-api' } };
    fs.writeFileSync(path.join(dir4, 'payments-api.apifier.json'), JSON.stringify(altMapping, null, 2), 'utf8');

    const result = await handleList({ dir: dir4, filter: 'WIDGET' });
    assert.equal(result.mappings.length, 1);
    assert.equal(result.mappings[0].service_name, 'widgets-api');
  } finally {
    fs.rmSync(dir4, { recursive: true, force: true });
  }
});

test('handleList: filter with no match returns zero count', async () => {
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-list-filter2-'));
  try {
    fs.copyFileSync(SAMPLE_FIXTURE, path.join(dir5, 'widgets-api.apifier.json'));
    const result = await handleList({ dir: dir5, filter: 'xyznonexistent' });
    assert.equal(result.mapping_count, 0);
    assert.deepEqual(result.mappings, []);
  } finally {
    fs.rmSync(dir5, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

test('handleList: dir with ".." throws BadParamsError', async () => {
  await assert.rejects(
    () => handleList({ dir: '/tmp/../etc' }),
    (err) => {
      assert.ok(err instanceof BadParamsError, `expected BadParamsError, got ${err.constructor.name}`);
      return true;
    }
  );
});
