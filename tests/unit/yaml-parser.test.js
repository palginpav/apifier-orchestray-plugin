'use strict';

// tests/unit/yaml-parser.test.js — YAML parsing via lib/parsers/openapi.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');

const { parseOpenAPI }     = require(path.join(__dirname, '../../lib/parsers/openapi'));
const { OpenAPIParseError } = require(path.join(__dirname, '../../lib/errors'));

const YAML_FIXTURE = path.join(__dirname, '../fixtures/sample-openapi-3.0.yaml');

// ---------------------------------------------------------------------------
// YAML fixture parses successfully
// ---------------------------------------------------------------------------

test('parseOpenAPI accepts YAML body — openapi: 3.0.x', async () => {
  const body = fs.readFileSync(YAML_FIXTURE, 'utf8');
  const { ir, warnings } = await parseOpenAPI({ body, content_type: '', source_url: YAML_FIXTURE });

  assert.ok(Array.isArray(ir.endpoints), 'endpoints must be array');
  assert.equal(ir.endpoints.length, 3, 'fixture has 3 operations');
  assert.ok(Array.isArray(warnings));
});

test('parseOpenAPI detects YAML via content_type application/yaml', async () => {
  const body = fs.readFileSync(YAML_FIXTURE, 'utf8');
  const { ir } = await parseOpenAPI({ body, content_type: 'application/yaml', source_url: null });
  assert.equal(ir.endpoints.length, 3);
});

test('parseOpenAPI detects YAML via content_type text/yaml', async () => {
  const body = fs.readFileSync(YAML_FIXTURE, 'utf8');
  const { ir } = await parseOpenAPI({ body, content_type: 'text/yaml', source_url: null });
  assert.equal(ir.endpoints.length, 3);
});

test('parseOpenAPI detects YAML via .yaml file extension in source_url', async () => {
  const body = fs.readFileSync(YAML_FIXTURE, 'utf8');
  const { ir } = await parseOpenAPI({ body, content_type: '', source_url: 'https://example.com/spec.yaml' });
  assert.equal(ir.endpoints.length, 3);
});

test('parseOpenAPI detects YAML via .yml file extension in source_url', async () => {
  const body = fs.readFileSync(YAML_FIXTURE, 'utf8');
  const { ir } = await parseOpenAPI({ body, content_type: '', source_url: 'https://example.com/spec.yml' });
  assert.equal(ir.endpoints.length, 3);
});

test('parseOpenAPI YAML fixture endpoint operationIds match JSON fixture', async () => {
  const body = fs.readFileSync(YAML_FIXTURE, 'utf8');
  const { ir } = await parseOpenAPI({ body, content_type: 'application/yaml', source_url: null });
  const ids = ir.endpoints.map(e => e.id).sort();
  assert.deepEqual(ids, ['createWidget', 'deleteWidget', 'listWidgets']);
});

// ---------------------------------------------------------------------------
// Malformed YAML → OpenAPIParseError with data.format: "yaml"
// ---------------------------------------------------------------------------

test('malformed YAML body throws OpenAPIParseError with data.format: yaml', async () => {
  const malformed = 'openapi: 3.0.0\ninfo:\n  bad yaml: [unclosed';
  await assert.rejects(
    () => parseOpenAPI({ body: malformed, content_type: 'application/yaml', source_url: null }),
    (err) => {
      assert.ok(err instanceof OpenAPIParseError, `expected OpenAPIParseError, got ${err.constructor.name}`);
      assert.equal(err.data && err.data.format, 'yaml', 'data.format must be "yaml"');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// YAML with code-injection syntax is rejected by JSON_SCHEMA
// ---------------------------------------------------------------------------

test('YAML with !!js/function tag is rejected by JSON_SCHEMA', async () => {
  // !!js/function is a YAML-specific type; JSON_SCHEMA should reject it.
  const dangerous = 'openapi: "3.0.0"\nmalicious: !!js/function "function(){return process.env}"';
  await assert.rejects(
    () => parseOpenAPI({ body: dangerous, content_type: 'application/yaml', source_url: null }),
    (err) => {
      assert.ok(err instanceof OpenAPIParseError, `expected OpenAPIParseError, got ${err.constructor.name}`);
      return true;
    }
  );
});
