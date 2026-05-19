'use strict';

// tests/unit/mapping-schema.test.js — Unit tests for lib/mapping/schema.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const { MappingSchemaV1, validate, JSON_SCHEMA } = require('../../lib/mapping/schema');
const FIXTURE = require('../fixtures/sample-mapping-v1.json');

describe('MappingSchemaV1 — accepts valid fixture', () => {
  it('fixture passes safeParse', () => {
    const result = MappingSchemaV1.safeParse(FIXTURE);
    assert.equal(result.success, true, JSON.stringify(result.error?.issues?.slice(0, 3)));
  });

  it('validate() returns ok:true for fixture', () => {
    const r = validate(FIXTURE);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });
});

describe('validate() — known-bad fixtures', () => {
  it('rejects mapping missing schema_version', () => {
    const bad = { ...FIXTURE };
    delete bad.schema_version;
    const r = validate(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0, 'expected at least one error');
    assert.ok(r.errors.some(e => /schema_version/i.test(e)), `errors: ${r.errors}`);
  });

  it('rejects mapping with wrong schema_version', () => {
    const bad = { ...FIXTURE, schema_version: 2 };
    const r = validate(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /schema_version/i.test(e) || /Invalid literal/i.test(e)), `errors: ${r.errors}`);
  });

  it('rejects invalid auth[].type', () => {
    const bad = {
      ...FIXTURE,
      auth: [{ id: 'bad', type: 'super-secret-auth' }],
    };
    const r = validate(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0, 'expected errors for invalid auth type');
  });

  it('rejects extra top-level field (strict mode)', () => {
    const bad = { ...FIXTURE, totally_unknown_field: 'oops' };
    const r = validate(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /unrecognized/i.test(e) || /unknown/i.test(e)), `errors: ${r.errors}`);
  });

  it('rejects missing required service.name', () => {
    const bad = { ...FIXTURE, service: { ...FIXTURE.service } };
    delete bad.service.name;
    const r = validate(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /name/i.test(e)), `errors: ${r.errors}`);
  });

  it('rejects missing required service.version', () => {
    const bad = { ...FIXTURE, service: { ...FIXTURE.service } };
    delete bad.service.version;
    const r = validate(bad);
    assert.equal(r.ok, false);
  });

  it('rejects source with neither url nor file_path', () => {
    const bad = {
      ...FIXTURE,
      source: { ...FIXTURE.source, url: null, file_path: null },
    };
    const r = validate(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /url|file_path/i.test(e)), `errors: ${r.errors}`);
  });
});

describe('JSON_SCHEMA', () => {
  it('exports a valid JSON Schema object with required fields listed', () => {
    assert.ok(JSON_SCHEMA && typeof JSON_SCHEMA === 'object');
    assert.equal(JSON_SCHEMA.type, 'object');
    assert.ok(Array.isArray(JSON_SCHEMA.required));
    assert.ok(JSON_SCHEMA.required.includes('schema_version'));
    assert.ok(JSON_SCHEMA.required.includes('endpoints'));
  });
});
