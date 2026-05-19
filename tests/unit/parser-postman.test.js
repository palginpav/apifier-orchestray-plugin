'use strict';

// tests/unit/parser-postman.test.js — Unit tests for lib/parsers/postman.js.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const fs        = require('node:fs');

const { parsePostman }     = require(path.join(__dirname, '../../lib/parsers/postman'));
const { PostmanParseError } = require(path.join(__dirname, '../../lib/errors'));

const SIMPLE_FIXTURE  = path.join(__dirname, '../fixtures/postman-simple-collection.json');
const NESTED_FIXTURE  = path.join(__dirname, '../fixtures/postman-folder-nested-collection.json');

// ---------------------------------------------------------------------------
// (a) Parse simple-collection fixture → ≥ 2 endpoints with method+path
// ---------------------------------------------------------------------------

test('parsePostman simple-collection produces ≥ 2 endpoints', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir, warnings, parser } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  assert.ok(Array.isArray(ir.endpoints), 'endpoints must be array');
  assert.ok(ir.endpoints.length >= 2, `expected ≥ 2 endpoints, got ${ir.endpoints.length}`);

  for (const ep of ir.endpoints) {
    assert.ok(ep.method, `endpoint ${ep.id} must have method`);
    assert.ok(ep.path, `endpoint ${ep.id} must have path`);
    assert.equal(ep.transport, 'http', 'transport must be http');
  }

  assert.ok(Array.isArray(warnings), 'warnings must be array');
  assert.equal(typeof parser.name, 'string', 'parser.name must be string');
  assert.equal(typeof parser.version, 'string', 'parser.version must be string');
});

test('parsePostman simple-collection has correct methods', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  const methods = ir.endpoints.map(ep => ep.method);
  assert.ok(methods.includes('GET'),    'GET endpoint present');
  assert.ok(methods.includes('POST'),   'POST endpoint present');
  assert.ok(methods.includes('DELETE'), 'DELETE endpoint present');
});

// ---------------------------------------------------------------------------
// (b) Parse folder-nested fixture → ≥ 1 endpoint per folder
// ---------------------------------------------------------------------------

test('parsePostman nested-collection walks folders recursively', async () => {
  const body = fs.readFileSync(NESTED_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  assert.ok(ir.endpoints.length >= 3, `expected ≥ 3 endpoints (2 in Users folder + 1 top-level), got ${ir.endpoints.length}`);

  // Endpoints inside the Users folder should have tags.
  const folderEndpoints = ir.endpoints.filter(ep => ep.tags && ep.tags.includes('Users'));
  assert.ok(folderEndpoints.length >= 1, 'at least 1 endpoint has Users folder tag');
});

test('parsePostman nested-collection folder path → tags array', async () => {
  const body = fs.readFileSync(NESTED_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  // Get User and List Users are inside the Users folder.
  const usersEndpoints = ir.endpoints.filter(ep => Array.isArray(ep.tags) && ep.tags.includes('Users'));
  assert.ok(usersEndpoints.length >= 2, 'both Users endpoints have folder tag');

  // Health Check is top-level — should have empty tags.
  const healthEp = ir.endpoints.find(ep => ep.path === '/health');
  assert.ok(healthEp, 'health endpoint exists');
  assert.deepEqual(healthEp.tags, [], 'top-level endpoint has no folder tags');
});

// ---------------------------------------------------------------------------
// (c) Empty / non-JSON body → PostmanParseError
// ---------------------------------------------------------------------------

test('parsePostman throws PostmanParseError on empty body', async () => {
  await assert.rejects(
    () => parsePostman({ body: '', content_type: 'application/json', source_url: null }),
    (err) => {
      assert.ok(err instanceof PostmanParseError, 'should be PostmanParseError');
      assert.equal(err.code, -32011, 'code must be -32011');
      return true;
    }
  );
});

test('parsePostman throws PostmanParseError on short body', async () => {
  await assert.rejects(
    () => parsePostman({ body: '{}', content_type: 'application/json', source_url: null }),
    (err) => err instanceof PostmanParseError
  );
});

test('parsePostman throws PostmanParseError on non-JSON body', async () => {
  await assert.rejects(
    () => parsePostman({ body: 'this is definitely not json and is long enough to pass the 50 byte check easily', content_type: 'text/plain', source_url: null }),
    (err) => {
      assert.ok(err instanceof PostmanParseError, 'should be PostmanParseError');
      assert.ok(err.message.includes('JSON'), 'error mentions JSON');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (d) JSON without info/item → PostmanParseError
// ---------------------------------------------------------------------------

test('parsePostman throws PostmanParseError when info is missing', async () => {
  const body = JSON.stringify({ item: [{ name: 'test', request: { method: 'GET', url: 'http://example.com' } }] });
  await assert.rejects(
    () => parsePostman({ body, content_type: 'application/json', source_url: null }),
    (err) => err instanceof PostmanParseError
  );
});

test('parsePostman throws PostmanParseError when item is missing', async () => {
  const body = JSON.stringify({ info: { name: 'Test', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' } });
  await assert.rejects(
    () => parsePostman({ body, content_type: 'application/json', source_url: null }),
    (err) => err instanceof PostmanParseError
  );
});

test('parsePostman throws PostmanParseError on Postman v1 format', async () => {
  const v1body = JSON.stringify({
    id: 'old-id',
    name: 'Old Collection',
    collections: [{ name: 'col' }],
    requests: [],
  });
  await assert.rejects(
    () => parsePostman({ body: v1body, content_type: 'application/json', source_url: null }),
    (err) => {
      assert.ok(err instanceof PostmanParseError);
      assert.ok(err.message.includes('v1'), 'error mentions v1');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (e) {{var}} in path → path_params entry
// ---------------------------------------------------------------------------

test('parsePostman converts {{var}} in path to path_params', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  const getEp = ir.endpoints.find(ep => ep.method === 'GET' && ep.path.includes('{widgetId}'));
  assert.ok(getEp, 'GET /widgets/{widgetId} endpoint exists');
  assert.ok(getEp.path.includes('{widgetId}'), 'path contains {widgetId} not {{widgetId}}');

  const param = getEp.path_params.find(p => p.name === 'widgetId');
  assert.ok(param, 'widgetId path param declared');
  assert.equal(param.required, true, 'path params are required');
  assert.deepEqual(param.type, { primitive: 'string' }, 'type is string (Postman has no type info)');
});

// ---------------------------------------------------------------------------
// (f) collection.auth bearer → mapping.auth[] entry
// ---------------------------------------------------------------------------

test('parsePostman maps collection-level bearer auth to mapping.auth[]', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  assert.ok(Array.isArray(ir.auth), 'ir.auth must be array');
  assert.ok(ir.auth.length >= 1, 'at least one auth scheme');

  const bearer = ir.auth.find(a => a.type === 'http-bearer');
  assert.ok(bearer, 'bearer auth scheme present');
  assert.equal(bearer.id, 'global-auth', 'global auth id is global-auth');
  assert.equal(bearer.scheme, 'Bearer');
});

test('parsePostman applies global auth to endpoints without per-request auth', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  for (const ep of ir.endpoints) {
    assert.ok(ep.auth.includes('global-auth'), `endpoint ${ep.id} should inherit global-auth`);
  }
});

// ---------------------------------------------------------------------------
// (g) Disabled query param emits warning + is skipped
// ---------------------------------------------------------------------------

test('parsePostman skips disabled query params and emits warning', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir, warnings } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  // The GET /widgets/{{widgetId}} has a disabled query param "debug".
  const getEp = ir.endpoints.find(ep => ep.method === 'GET' && ep.path.includes('widgetId'));
  assert.ok(getEp, 'GET endpoint exists');

  const debugParam = getEp.query_params.find(p => p.name === 'debug');
  assert.equal(debugParam, undefined, 'disabled query param "debug" must not appear in query_params');

  const disabledWarning = warnings.find(w => w.startsWith('disabled_query_params_skipped'));
  assert.ok(disabledWarning, 'warning about disabled query params emitted');
});

// ---------------------------------------------------------------------------
// (h) x-source-format: "postman" extension populated
// ---------------------------------------------------------------------------

test('parsePostman populates x-source-format extension', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  assert.ok(ir.extensions, 'extensions object exists');
  assert.equal(ir.extensions['x-source-format'], 'postman', 'x-source-format must be "postman"');
});

test('parsePostman populates x-postman-id extension', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  assert.ok(ir.extensions, 'extensions object exists');
  assert.equal(
    ir.extensions['x-postman-id'],
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'x-postman-id matches fixture _postman_id'
  );
});

// ---------------------------------------------------------------------------
// Additional: service metadata
// ---------------------------------------------------------------------------

test('parsePostman sets service.display_name from info.name', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  assert.equal(ir.service.display_name, 'Widget API', 'display_name from info.name');
  assert.equal(ir.service.name, 'widget-api', 'slugified service.name');
});

// ---------------------------------------------------------------------------
// Additional: base URL inference
// ---------------------------------------------------------------------------

test('parsePostman infers server base URL when all endpoints share same origin', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  // All 3 endpoints use https://api.example.com
  assert.ok(Array.isArray(ir.servers), 'servers must be array');
  assert.ok(ir.servers.length >= 1, 'at least one server inferred');
  assert.equal(ir.servers[0].url, 'https://api.example.com', 'server URL is the common origin');
});

// ---------------------------------------------------------------------------
// Additional: response examples stored in extensions
// ---------------------------------------------------------------------------

test('parsePostman stores response body examples in endpoint x-extensions', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  const getEp = ir.endpoints.find(ep => ep.method === 'GET');
  assert.ok(getEp, 'GET endpoint exists');
  assert.ok(getEp['x-extensions'], 'x-extensions present on GET endpoint');
  assert.ok(getEp['x-extensions']['x-response-example-200'], 'response example for 200 stored');
});

// ---------------------------------------------------------------------------
// Additional: POST body stored as raw in extensions
// ---------------------------------------------------------------------------

test('parsePostman stores raw request body in x-body-example extension', async () => {
  const body = fs.readFileSync(SIMPLE_FIXTURE, 'utf8');
  const { ir } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  const postEp = ir.endpoints.find(ep => ep.method === 'POST');
  assert.ok(postEp, 'POST endpoint exists');
  assert.ok(postEp.body, 'POST endpoint has body');
  assert.equal(postEp.body.content_type, 'application/json', 'body content_type is JSON');
  assert.ok(postEp['x-extensions'] && postEp['x-extensions']['x-body-example'], 'x-body-example present');
});

// ---------------------------------------------------------------------------
// Additional: test script drop warning
// ---------------------------------------------------------------------------

test('parsePostman emits warning for dropped test scripts', async () => {
  const body = fs.readFileSync(NESTED_FIXTURE, 'utf8');
  const { warnings } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  // The nested fixture has an event[] on "Get User" request.
  const scriptWarning = warnings.find(w => w.startsWith('postman_test_scripts_dropped'));
  assert.ok(scriptWarning, 'warning emitted for dropped test scripts');
});

// ---------------------------------------------------------------------------
// Additional: auth type warnings for unsupported schemes
// ---------------------------------------------------------------------------

test('parsePostman emits warning for unsupported auth types', async () => {
  const unsupportedAuth = {
    info: {
      name: 'Test',
      _postman_id: 'test-id',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Test Endpoint',
        request: {
          method: 'GET',
          url: { raw: 'https://api.example.com/test', path: ['test'], host: ['api', 'example', 'com'] },
        },
        response: [],
      },
    ],
    auth: { type: 'oauth1' },
  };
  const body = JSON.stringify(unsupportedAuth);
  const { warnings } = await parsePostman({ body, content_type: 'application/json', source_url: null });

  const authWarning = warnings.find(w => w.includes('unsupported_auth_type_oauth1'));
  assert.ok(authWarning, 'warning emitted for oauth1 auth type');
});

// ---------------------------------------------------------------------------
// (i) End-to-end via handleScrape against fixture
// ---------------------------------------------------------------------------

test('handleScrape auto-detects and parses Postman collection fixture', async () => {
  const { handleScrape } = require(path.join(__dirname, '../../lib/handlers/scrape'));

  const result = await handleScrape({
    source:       SIMPLE_FIXTURE,
    service_name: 'postman-e2e-test',
    overwrite:    true,
  });

  assert.ok(result.output_path, 'output_path present');
  assert.ok(result.endpoint_count >= 2, `expected ≥ 2 endpoints, got ${result.endpoint_count}`);

  // Read and verify the mapping.
  const mapping = JSON.parse(fs.readFileSync(result.output_path, 'utf8'));
  assert.equal(mapping.extensions['x-source-format'], 'postman', 'x-source-format is postman');
  assert.equal(mapping.source.type, 'postman', 'source.type is postman');
  assert.ok(mapping.extensions['x-postman-id'], 'x-postman-id is populated');
  assert.equal(mapping.kind, 'apifier-mapping', 'kind is apifier-mapping');

  // Clean up.
  try { fs.unlinkSync(result.output_path); } catch (_) {}
});
