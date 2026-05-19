'use strict';

// tests/unit/mapping-read.test.js — Unit tests for lib/mapping/read.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { writeMapping }  = require('../../lib/mapping/write');
const { readMapping }   = require('../../lib/mapping/read');
const { _canonicalJson } = require('../../lib/mapping/write');
const FIXTURE = require('../fixtures/sample-mapping-v1.json');

let TMP_DIR;
let WRITTEN_PATH;

before(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'apifier-read-test-'));
  const result = writeMapping({
    mapping: FIXTURE,
    output_dir: TMP_DIR,
    service_name: 'widgets-api',
    overwrite: true,
  });
  WRITTEN_PATH = result.output_path;
});

after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

describe('readMapping — round-trip', () => {
  it('reads the written mapping and returns validation.ok=true', () => {
    const { mapping, validation } = readMapping({ mapping_path: WRITTEN_PATH });
    assert.equal(validation.ok, true, `errors: ${validation.errors}`);
    assert.ok(mapping != null);
    assert.equal(mapping.schema_version, 1);
    assert.equal(mapping.kind, 'apifier-mapping');
  });

  it('round-trips: written JSON re-serialises to same bytes', () => {
    const { mapping } = readMapping({ mapping_path: WRITTEN_PATH });
    const reserialised = _canonicalJson(mapping);
    const original     = fs.readFileSync(WRITTEN_PATH, 'utf8');
    assert.equal(reserialised, original, 'round-trip must be byte-identical');
  });
});

describe('readMapping — invalid / corrupted mapping', () => {
  it('returns validation.ok=false with errors for schema-invalid mapping', () => {
    const corrupted = path.join(TMP_DIR, 'corrupted.apifier.json');
    fs.writeFileSync(corrupted, JSON.stringify({
      schema_version: 99,
      kind: 'wrong-kind',
      service: {},
      endpoints: [],
    }), 'utf8');

    const { mapping, validation } = readMapping({ mapping_path: corrupted });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.length > 0, 'expected schema errors');
    // mapping is still returned (the raw parsed object).
    assert.ok(mapping != null);
  });

  it('returns validation.ok=false for invalid JSON', () => {
    const broken = path.join(TMP_DIR, 'broken.json');
    fs.writeFileSync(broken, 'this is not json', 'utf8');

    const { mapping, validation } = readMapping({ mapping_path: broken });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some(e => /JSON parse error/i.test(e)), `errors: ${validation.errors}`);
    assert.equal(mapping, null);
  });
});

describe('readMapping — file not found', () => {
  it('throws an error with code ENOENT for missing file', () => {
    assert.throws(
      () => readMapping({ mapping_path: path.join(TMP_DIR, 'does-not-exist.json') }),
      (err) => err.code === 'ENOENT' && /file not found/.test(err.message)
    );
  });
});
