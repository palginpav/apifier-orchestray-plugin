'use strict';

// tests/unit/mapping-write.test.js — Unit tests for lib/mapping/write.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { writeMapping, _canonicalJson } = require('../../lib/mapping/write');
const { ValidatorRejectedError, BadParamsError } = require('../../lib/errors');
const FIXTURE = require('../fixtures/sample-mapping-v1.json');

// Use a tmpdir under os.tmpdir() — always in the allowed-roots list.
let TMP_DIR;

before(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-write-test-'));
});

after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

describe('writeMapping — atomic write', () => {
  it('writes file and returns output_path', () => {
    const { output_path } = writeMapping({
      mapping: FIXTURE,
      output_dir: TMP_DIR,
      service_name: 'widgets-api',
    });
    assert.ok(fs.existsSync(output_path), 'output file should exist');
    assert.ok(output_path.endsWith('widgets-api.apifier.json'));
    const written = JSON.parse(fs.readFileSync(output_path, 'utf8'));
    assert.equal(written.schema_version, 1);
  });
});

describe('writeMapping — overwrite:false rejects existing file', () => {
  it('throws ValidatorRejectedError when file exists and overwrite=false', () => {
    // First write.
    writeMapping({ mapping: FIXTURE, output_dir: TMP_DIR, service_name: 'dup-test', overwrite: true });
    // Second write without overwrite.
    assert.throws(
      () => writeMapping({ mapping: FIXTURE, output_dir: TMP_DIR, service_name: 'dup-test' }),
      (err) => err instanceof ValidatorRejectedError && /already exists/.test(err.message)
    );
  });

  it('succeeds when overwrite=true', () => {
    const { output_path } = writeMapping({
      mapping: FIXTURE,
      output_dir: TMP_DIR,
      service_name: 'dup-test',
      overwrite: true,
    });
    assert.ok(fs.existsSync(output_path));
  });
});

describe('writeMapping — path traversal rejection', () => {
  it('rejects output_dir containing ".."', () => {
    assert.throws(
      () => writeMapping({ mapping: FIXTURE, output_dir: '../etc', service_name: 'widgets-api' }),
      (err) => err instanceof ValidatorRejectedError && /traversal/.test(err.message)
    );
  });

  it('rejects output_dir outside allowed roots', () => {
    assert.throws(
      () => writeMapping({ mapping: FIXTURE, output_dir: '/not-an-allowed-root', service_name: 'widgets-api' }),
      (err) => err instanceof ValidatorRejectedError && /allowed root/.test(err.message)
    );
  });

  it('rejects service_name with ".." substring', () => {
    assert.throws(
      () => writeMapping({ mapping: FIXTURE, output_dir: TMP_DIR, service_name: '..foo' }),
      (err) => err instanceof BadParamsError
    );
  });

  it('rejects service_name with invalid characters', () => {
    assert.throws(
      () => writeMapping({ mapping: FIXTURE, output_dir: TMP_DIR, service_name: 'UPPER-CASE' }),
      (err) => err instanceof BadParamsError
    );
  });
});

describe('writeMapping — canonical / deterministic output', () => {
  it('produces byte-identical output for the same input (written twice)', () => {
    const { output_path: p1 } = writeMapping({
      mapping: FIXTURE,
      output_dir: TMP_DIR,
      service_name: 'determinism-test',
      overwrite: true,
    });
    const bytes1 = fs.readFileSync(p1, 'utf8');

    const { output_path: p2 } = writeMapping({
      mapping: FIXTURE,
      output_dir: TMP_DIR,
      service_name: 'determinism-test',
      overwrite: true,
    });
    const bytes2 = fs.readFileSync(p2, 'utf8');

    assert.equal(bytes1, bytes2, 'output must be byte-identical for the same input');
  });

  it('_canonicalJson output ends with newline and uses 2-space indent', () => {
    const s = _canonicalJson(FIXTURE);
    assert.ok(s.endsWith('\n'), 'must end with newline');
    assert.ok(s.includes('  "'), 'must use 2-space indent');
  });

  it('_canonicalJson puts schema_version first', () => {
    const s = _canonicalJson(FIXTURE);
    const firstKey = s.split('\n')[1].trim().replace(/^"/, '').replace(/".*/, '');
    assert.equal(firstKey, 'schema_version');
  });
});
