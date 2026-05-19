'use strict';

// tests/unit/parser-openapi.test.js — Unit tests for lib/parsers/openapi.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');

const { parseOpenAPI } = require(path.join(__dirname, '../../lib/parsers/openapi'));
const { UnsupportedFormatError } = require(path.join(__dirname, '../../lib/errors'));

const FIXTURE_30 = path.join(__dirname, '../fixtures/sample-openapi-3.0.json');

// ---------------------------------------------------------------------------
// OpenAPI 3.0 fixture → IR
// ---------------------------------------------------------------------------

test('parseOpenAPI 3.0 fixture produces correct endpoint count', async () => {
  const body = fs.readFileSync(FIXTURE_30, 'utf8');
  const { ir, warnings } = await parseOpenAPI({ body, content_type: 'application/json', source_url: null });

  assert.ok(Array.isArray(ir.endpoints), 'endpoints must be array');
  assert.equal(ir.endpoints.length, 3, 'fixture has 3 operations: GET /widgets, POST /widgets, DELETE /widgets/{id}');
  assert.ok(Array.isArray(warnings), 'warnings must be array');
});

test('parseOpenAPI 3.0 fixture endpoint shapes are correct', async () => {
  const body = fs.readFileSync(FIXTURE_30, 'utf8');
  const { ir } = await parseOpenAPI({ body, content_type: 'application/json', source_url: null });

  const methods = ir.endpoints.map(e => e.method);
  assert.ok(methods.includes('GET'),    'GET endpoint present');
  assert.ok(methods.includes('POST'),   'POST endpoint present');
  assert.ok(methods.includes('DELETE'), 'DELETE endpoint present');

  const get = ir.endpoints.find(e => e.method === 'GET');
  assert.equal(get.transport, 'http');
  assert.equal(get.path, '/widgets');
  assert.equal(get.id, 'listWidgets');
  assert.ok(Array.isArray(get.query_params), 'query_params is array');
  assert.equal(get.query_params.length, 1, 'has 1 query param (limit)');

  const del = ir.endpoints.find(e => e.method === 'DELETE');
  assert.equal(del.path, '/widgets/{id}');
  assert.ok(del.path_params.length >= 1, 'DELETE has path param id');
});

test('parseOpenAPI 3.0 fixture parses models', async () => {
  const body = fs.readFileSync(FIXTURE_30, 'utf8');
  const { ir } = await parseOpenAPI({ body, content_type: 'application/json', source_url: null });

  assert.ok(Array.isArray(ir.models), 'models must be array');
  assert.ok(ir.models.length >= 2, 'at least 2 models (Widget, ApiError)');
  const names = ir.models.map(m => m.name);
  assert.ok(names.includes('Widget'), 'Widget model present');
  assert.ok(names.includes('ApiError'), 'ApiError model present');
});

test('parseOpenAPI 3.0 fixture parses auth scheme', async () => {
  const body = fs.readFileSync(FIXTURE_30, 'utf8');
  const { ir } = await parseOpenAPI({ body, content_type: 'application/json', source_url: null });

  assert.ok(Array.isArray(ir.auth), 'auth must be array');
  assert.ok(ir.auth.length >= 1, 'at least 1 auth scheme');
  const bearer = ir.auth.find(a => a.type === 'http-bearer');
  assert.ok(bearer, 'bearer auth scheme present');
  assert.equal(bearer.id, 'bearerAuth');
});

// ---------------------------------------------------------------------------
// OpenAPI 3.1 inline → IR
// ---------------------------------------------------------------------------

test('parseOpenAPI 3.1 inline spec produces IR', async () => {
  const spec = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Test31', version: '0.1' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          summary: 'List items',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });
  const { ir, warnings } = await parseOpenAPI({ body: spec, content_type: 'application/json', source_url: null });
  assert.equal(ir.endpoints.length, 1);
  assert.equal(ir.endpoints[0].id, 'listItems');
  assert.ok(Array.isArray(warnings));
});

// ---------------------------------------------------------------------------
// Missing paths → warning + empty endpoints
// ---------------------------------------------------------------------------

test('parseOpenAPI missing paths produces warning and empty endpoints', async () => {
  const spec = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Empty', version: '1.0' },
  });
  const { ir, warnings } = await parseOpenAPI({ body: spec, content_type: 'application/json', source_url: null });
  assert.equal(ir.endpoints.length, 0);
  assert.ok(warnings.some(w => w.toLowerCase().includes('path')), 'should warn about missing paths');
});

// ---------------------------------------------------------------------------
// Swagger 2.0 → warning but still parses
// ---------------------------------------------------------------------------

test('parseOpenAPI Swagger 2.0 produces warning but parses endpoints', async () => {
  const spec = JSON.stringify({
    swagger: '2.0',
    info: { title: 'Petstore', version: '1.0' },
    host: 'petstore.swagger.io',
    basePath: '/v2',
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          summary: 'List pets',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });
  const { ir, warnings } = await parseOpenAPI({ body: spec, content_type: 'application/json', source_url: null });
  assert.ok(warnings.some(w => w.toLowerCase().includes('swagger')), 'must warn about Swagger 2.0');
  assert.ok(ir.endpoints.length >= 1, 'should still parse at least 1 endpoint');
  assert.equal(ir.endpoints[0].id, 'listPets');
});

// ---------------------------------------------------------------------------
// YAML → UnsupportedFormatError
// ---------------------------------------------------------------------------

test('parseOpenAPI YAML body throws UnsupportedFormatError', async () => {
  const yamlBody = 'openapi: "3.0.3"\ninfo:\n  title: Test\n  version: "1"\npaths: {}\n';
  await assert.rejects(
    () => parseOpenAPI({ body: yamlBody, content_type: 'application/json', source_url: null }),
    err => err instanceof UnsupportedFormatError
  );
});
