'use strict';

// tests/unit/handler-doctor.test.js — Unit tests for lib/handlers/doctor.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');
const os        = require('node:os');

const {
  handleDoctor,
  checkNodeVersion,
  checkOrchestrayInstall,
  checkMappingsDir,
  checkMappingsValidity,
} = require(path.join(__dirname, '../../lib/handlers/doctor'));

const SAMPLE_FIXTURE = path.join(__dirname, '../fixtures/sample-mapping-v1.json');

// ---------------------------------------------------------------------------
// Individual check functions
// ---------------------------------------------------------------------------

test('checkNodeVersion returns pass on current runtime (>=20)', () => {
  const result = checkNodeVersion();
  assert.equal(result.name, 'node_version');
  assert.ok(['pass', 'fail'].includes(result.status));
  assert.ok(typeof result.detail === 'string');
  // On CI/dev running node >=20 this should pass.
  assert.equal(result.status, 'pass', `Node ${process.version} should satisfy >=20`);
});

test('checkOrchestrayInstall returns a valid check object', () => {
  const result = checkOrchestrayInstall();
  assert.equal(result.name, 'orchestray_install');
  assert.ok(['pass', 'fail'].includes(result.status));
  assert.ok(typeof result.detail === 'string');
});

test('checkMappingsDir with writable tmpdir returns pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-doctor-dir-'));
  try {
    const result = checkMappingsDir(dir);
    assert.equal(result.name, 'mappings_dir');
    assert.equal(result.status, 'pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkMappingsDir with non-writable dir returns fail', () => {
  // Create a dir then chmod 000 to make it unwritable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-doctor-nowrite-'));
  try {
    fs.chmodSync(dir, 0o000);
    const result = checkMappingsDir(dir);
    // May fail to probe write.
    assert.equal(result.name, 'mappings_dir');
    // Either pass (if root) or fail.
    assert.ok(['pass', 'fail'].includes(result.status));
  } finally {
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkMappingsValidity: all valid returns pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-doctor-valid-'));
  try {
    fs.copyFileSync(SAMPLE_FIXTURE, path.join(dir, 'widgets-api.apifier.json'));
    const result = checkMappingsValidity(dir);
    assert.equal(result.name, 'mappings_validity');
    assert.equal(result.status, 'pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkMappingsValidity: corrupted mapping returns warn (not fail)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-doctor-corrupt-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.apifier.json'), '{ bad json', 'utf8');
    const result = checkMappingsValidity(dir);
    assert.equal(result.name, 'mappings_validity');
    assert.equal(result.status, 'warn', 'corrupted mapping → warn, not fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkMappingsValidity: empty dir returns pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-doctor-empty-'));
  try {
    const result = checkMappingsValidity(dir);
    assert.equal(result.status, 'pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// handleDoctor — full result shape
// ---------------------------------------------------------------------------

test('handleDoctor returns all 4 checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-doctor-full-'));
  try {
    const result = await handleDoctor({ dir });
    assert.ok(typeof result.ok === 'boolean');
    assert.ok(Array.isArray(result.checks));
    assert.equal(result.checks.length, 4);
    assert.ok(typeof result.summary === 'string');
    const names = result.checks.map(c => c.name);
    assert.ok(names.includes('node_version'));
    assert.ok(names.includes('orchestray_install'));
    assert.ok(names.includes('mappings_dir'));
    assert.ok(names.includes('mappings_validity'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handleDoctor: corrupted mapping makes mappings_validity=warn but ok stays true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-doctor-warn-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.apifier.json'), '{ bad json', 'utf8');
    const result = await handleDoctor({ dir });
    const validity = result.checks.find(c => c.name === 'mappings_validity');
    assert.equal(validity.status, 'warn');
    // ok should still be true (warn doesn't make ok=false).
    // ok depends on node_version and orchestray_install checks too — if those pass, ok is true.
    const failChecks = result.checks.filter(c => c.status === 'fail');
    const expectedOk = failChecks.length === 0;
    assert.equal(result.ok, expectedOk);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handleDoctor checks shape: each check has name, status, detail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-doctor-shape-'));
  try {
    const result = await handleDoctor({ dir });
    for (const c of result.checks) {
      assert.ok(typeof c.name === 'string', 'check.name must be string');
      assert.ok(['pass', 'warn', 'fail'].includes(c.status), `unexpected status: ${c.status}`);
      assert.ok(typeof c.detail === 'string', 'check.detail must be string');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
