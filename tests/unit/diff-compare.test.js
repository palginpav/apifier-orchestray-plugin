'use strict';

// tests/unit/diff-compare.test.js — Pure-function unit tests for lib/diff/compare.js.
// Covers every change category in the SemVer classification table.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { compareMapping } = require(path.join(__dirname, '../../lib/diff/compare'));

// ---------------------------------------------------------------------------
// Helpers — minimal valid mapping skeletons
// ---------------------------------------------------------------------------

function baseMapping(overrides) {
  return Object.assign({
    schema_version: 1,
    apifier_version: '0.1.0',
    kind: 'apifier-mapping',
    service: { name: 'test-svc', version: '1.0' },
    source: { type: 'openapi', url: 'https://x.com', fetched_at: '2026-01-01T00:00:00Z', parser: { name: 'p', version: '1' } },
    endpoints: [],
    auth: [],
    models: [],
  }, overrides);
}

function endpoint(method, epPath, overrides) {
  return Object.assign({
    id: method + epPath.replace(/\W+/g, '_'),
    transport: 'http',
    method,
    path: epPath,
    summary: null,
    description: null,
    path_params: [],
    query_params: [],
    headers: [],
    cookies: [],
    body: null,
    responses: {},
  }, overrides);
}

function param(name, required, typeObj, overrides) {
  return Object.assign({ name, type: typeObj || { primitive: 'string' }, required }, overrides);
}

function authScheme(id, type) {
  return { id, type };
}

function model(name, fields) {
  return { name, kind: 'object', description: null, fields: fields || [] };
}

function field(name, required, typeObj, overrides) {
  return Object.assign({ name, type: typeObj || { primitive: 'string' }, required }, overrides);
}

// ---------------------------------------------------------------------------
// 1. Identical mappings → verdict "compatible" / counts all zero
// ---------------------------------------------------------------------------

test('identical mappings → compatible, all counts zero', () => {
  const a = baseMapping({ endpoints: [endpoint('GET', '/pets')], auth: [authScheme('jwt', 'http-bearer')], models: [model('Pet', [field('id', true)])] });
  const r = compareMapping(a, a);
  assert.equal(r.verdict, 'compatible');
  assert.equal(r.counts.breaking, 0);
  assert.equal(r.counts.non_breaking, 0);
  assert.equal(r.counts.patch, 0);
  assert.equal(r.counts.total, 0);
  assert.deepEqual(r.breaking, []);
  assert.deepEqual(r.non_breaking, []);
  assert.deepEqual(r.patch, []);
});

// ---------------------------------------------------------------------------
// 2. Endpoint removed → breaking
// ---------------------------------------------------------------------------

test('endpoint_removed → breaking', () => {
  const a = baseMapping({ endpoints: [endpoint('GET', '/pets')] });
  const b = baseMapping({ endpoints: [] });
  const r = compareMapping(a, b);
  assert.equal(r.verdict, 'major');
  assert.equal(r.counts.breaking, 1);
  const c = r.breaking[0];
  assert.equal(c.kind, 'endpoint_removed');
  assert.equal(c.impact, 'breaking');
  assert.ok(c.path.includes('/pets'));
});

// ---------------------------------------------------------------------------
// 3. Endpoint added → non_breaking
// ---------------------------------------------------------------------------

test('endpoint_added → non_breaking', () => {
  const a = baseMapping({ endpoints: [] });
  const b = baseMapping({ endpoints: [endpoint('POST', '/pets')] });
  const r = compareMapping(a, b);
  assert.equal(r.verdict, 'minor');
  assert.equal(r.counts.non_breaking, 1);
  const c = r.non_breaking[0];
  assert.equal(c.kind, 'endpoint_added');
  assert.equal(c.impact, 'non_breaking');
  assert.ok(c.path.includes('/pets'));
});

// ---------------------------------------------------------------------------
// 4. Required param removed → breaking
// ---------------------------------------------------------------------------

test('required param_removed → breaking', () => {
  const epA = endpoint('GET', '/pets', { query_params: [param('limit', true)] });
  const epB = endpoint('GET', '/pets', { query_params: [] });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'param_removed');
  assert.ok(c, 'should have a param_removed breaking change');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 5. Optional param removed → non_breaking
// ---------------------------------------------------------------------------

test('optional param_removed → non_breaking', () => {
  const epA = endpoint('GET', '/pets', { query_params: [param('tag', false)] });
  const epB = endpoint('GET', '/pets', { query_params: [] });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.non_breaking.find(x => x.kind === 'param_removed');
  assert.ok(c, 'optional param removed should be non_breaking');
  assert.equal(c.impact, 'non_breaking');
});

// ---------------------------------------------------------------------------
// 6. Required param added → breaking
// ---------------------------------------------------------------------------

test('required param_added → breaking', () => {
  const epA = endpoint('GET', '/pets', { query_params: [] });
  const epB = endpoint('GET', '/pets', { query_params: [param('version', true)] });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'param_added');
  assert.ok(c, 'required param added should be breaking');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 7. Optional param added → non_breaking
// ---------------------------------------------------------------------------

test('optional param_optional_added → non_breaking', () => {
  const epA = endpoint('GET', '/pets', { query_params: [] });
  const epB = endpoint('GET', '/pets', { query_params: [param('sort', false)] });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.non_breaking.find(x => x.kind === 'param_optional_added');
  assert.ok(c, 'optional param added should be non_breaking');
  assert.equal(c.impact, 'non_breaking');
});

// ---------------------------------------------------------------------------
// 8. Param type changed → breaking
// ---------------------------------------------------------------------------

test('param_type_changed → breaking', () => {
  const epA = endpoint('GET', '/pets', { query_params: [param('limit', false, { primitive: 'string' })] });
  const epB = endpoint('GET', '/pets', { query_params: [param('limit', false, { primitive: 'integer' })] });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'param_type_changed');
  assert.ok(c, 'param type change should be breaking');
  assert.equal(c.impact, 'breaking');
  assert.deepEqual(c.before, { primitive: 'string' });
  assert.deepEqual(c.after, { primitive: 'integer' });
});

// ---------------------------------------------------------------------------
// 9. Param made required (was optional) → breaking
// ---------------------------------------------------------------------------

test('param_required_added (was optional) → breaking', () => {
  const epA = endpoint('GET', '/pets', { query_params: [param('limit', false)] });
  const epB = endpoint('GET', '/pets', { query_params: [param('limit', true)] });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'param_required_added');
  assert.ok(c, 'making param required should be breaking');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 10. Param made optional (was required) → non_breaking
// ---------------------------------------------------------------------------

test('param_made_optional (was required) → non_breaking', () => {
  const epA = endpoint('GET', '/pets', { query_params: [param('limit', true)] });
  const epB = endpoint('GET', '/pets', { query_params: [param('limit', false)] });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.non_breaking.find(x => x.kind === 'param_made_optional');
  assert.ok(c, 'making param optional should be non_breaking');
  assert.equal(c.impact, 'non_breaking');
});

// ---------------------------------------------------------------------------
// 11. Response status removed → breaking
// ---------------------------------------------------------------------------

test('response_removed → breaking', () => {
  const epA = endpoint('GET', '/pets', { responses: { '200': { description: 'OK', schema: { primitive: 'string' } }, '404': { description: 'NF' } } });
  const epB = endpoint('GET', '/pets', { responses: { '200': { description: 'OK', schema: { primitive: 'string' } } } });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'response_removed');
  assert.ok(c, 'removing a response status should be breaking');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 12. Response status added → non_breaking
// ---------------------------------------------------------------------------

test('response_added → non_breaking', () => {
  const epA = endpoint('GET', '/pets', { responses: { '200': { description: 'OK', schema: { primitive: 'string' } } } });
  const epB = endpoint('GET', '/pets', { responses: { '200': { description: 'OK', schema: { primitive: 'string' } }, '429': { description: 'Rate limit' } } });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.non_breaking.find(x => x.kind === 'response_added');
  assert.ok(c, 'adding a response status should be non_breaking');
  assert.equal(c.impact, 'non_breaking');
});

// ---------------------------------------------------------------------------
// 13. Response schema changed → breaking
// ---------------------------------------------------------------------------

test('response_schema_changed → breaking', () => {
  const epA = endpoint('GET', '/pets', { responses: { '200': { description: 'OK', schema: { primitive: 'string' } } } });
  const epB = endpoint('GET', '/pets', { responses: { '200': { description: 'OK', schema: { primitive: 'integer' } } } });
  const a = baseMapping({ endpoints: [epA] });
  const b = baseMapping({ endpoints: [epB] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'response_schema_changed');
  assert.ok(c, 'response schema change should be breaking');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 14. Auth scheme removed → breaking
// ---------------------------------------------------------------------------

test('auth_removed → breaking', () => {
  const a = baseMapping({ auth: [authScheme('jwt', 'http-bearer')] });
  const b = baseMapping({ auth: [] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'auth_removed');
  assert.ok(c, 'removing auth scheme should be breaking');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 15. Auth scheme added → non_breaking
// ---------------------------------------------------------------------------

test('auth_added → non_breaking', () => {
  const a = baseMapping({ auth: [] });
  const b = baseMapping({ auth: [authScheme('apikey', 'api-key')] });
  const r = compareMapping(a, b);
  const c = r.non_breaking.find(x => x.kind === 'auth_added');
  assert.ok(c, 'adding auth scheme should be non_breaking');
  assert.equal(c.impact, 'non_breaking');
});

// ---------------------------------------------------------------------------
// 16. Auth scheme type changed → breaking
// ---------------------------------------------------------------------------

test('auth_scheme_changed → breaking', () => {
  const a = baseMapping({ auth: [authScheme('myauth', 'http-bearer')] });
  const b = baseMapping({ auth: [authScheme('myauth', 'api-key')] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'auth_scheme_changed');
  assert.ok(c, 'changing auth scheme type should be breaking');
  assert.equal(c.impact, 'breaking');
  assert.equal(c.before, 'http-bearer');
  assert.equal(c.after, 'api-key');
});

// ---------------------------------------------------------------------------
// 17. Model added → non_breaking
// ---------------------------------------------------------------------------

test('model_added → non_breaking', () => {
  const a = baseMapping({ models: [] });
  const b = baseMapping({ models: [model('Widget', [])] });
  const r = compareMapping(a, b);
  const c = r.non_breaking.find(x => x.kind === 'model_added');
  assert.ok(c, 'adding a model should be non_breaking');
  assert.equal(c.impact, 'non_breaking');
});

// ---------------------------------------------------------------------------
// 18. Model removed → breaking
// ---------------------------------------------------------------------------

test('model_removed → breaking', () => {
  const a = baseMapping({ models: [model('Widget', [])] });
  const b = baseMapping({ models: [] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'model_removed');
  assert.ok(c, 'removing a model should be breaking');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 19. Model field removed → breaking
// ---------------------------------------------------------------------------

test('model_field_removed → breaking', () => {
  const a = baseMapping({ models: [model('Pet', [field('id', true), field('name', true)])] });
  const b = baseMapping({ models: [model('Pet', [field('id', true)])] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'model_field_removed');
  assert.ok(c, 'removing a model field should be breaking');
  assert.equal(c.impact, 'breaking');
  assert.ok(c.path.includes('name'));
});

// ---------------------------------------------------------------------------
// 20. Model field added (required) → breaking
// ---------------------------------------------------------------------------

test('model_field_added required → breaking', () => {
  const a = baseMapping({ models: [model('Pet', [field('id', true)])] });
  const b = baseMapping({ models: [model('Pet', [field('id', true), field('species', true)])] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'model_field_added');
  assert.ok(c, 'adding required model field should be breaking');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 21. Model field added (optional) → non_breaking
// ---------------------------------------------------------------------------

test('model_field_added optional → non_breaking', () => {
  const a = baseMapping({ models: [model('Pet', [field('id', true)])] });
  const b = baseMapping({ models: [model('Pet', [field('id', true), field('nickname', false)])] });
  const r = compareMapping(a, b);
  const c = r.non_breaking.find(x => x.kind === 'model_field_added');
  assert.ok(c, 'adding optional model field should be non_breaking');
  assert.equal(c.impact, 'non_breaking');
});

// ---------------------------------------------------------------------------
// 22. Model field type changed → breaking
// ---------------------------------------------------------------------------

test('model_field_type_changed → breaking', () => {
  const a = baseMapping({ models: [model('Pet', [field('id', true, { primitive: 'string' })])] });
  const b = baseMapping({ models: [model('Pet', [field('id', true, { primitive: 'integer' })])] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'model_field_type_changed');
  assert.ok(c, 'changing model field type should be breaking');
  assert.equal(c.impact, 'breaking');
});

// ---------------------------------------------------------------------------
// 23. Enum value added → non_breaking
// ---------------------------------------------------------------------------

test('enum_value_added → non_breaking', () => {
  const a = baseMapping({ models: [model('Tag', [Object.assign(field('label', true), { enum: ['a', 'b'] })])] });
  const b = baseMapping({ models: [model('Tag', [Object.assign(field('label', true), { enum: ['a', 'b', 'c'] })])] });
  const r = compareMapping(a, b);
  const c = r.non_breaking.find(x => x.kind === 'enum_value_added');
  assert.ok(c, 'adding enum value should be non_breaking');
  assert.equal(c.impact, 'non_breaking');
  assert.equal(c.after, 'c');
});

// ---------------------------------------------------------------------------
// 24. Enum value removed → breaking
// ---------------------------------------------------------------------------

test('enum_value_removed → breaking', () => {
  const a = baseMapping({ models: [model('Tag', [Object.assign(field('label', true), { enum: ['a', 'b', 'c'] })])] });
  const b = baseMapping({ models: [model('Tag', [Object.assign(field('label', true), { enum: ['a', 'b'] })])] });
  const r = compareMapping(a, b);
  const c = r.breaking.find(x => x.kind === 'enum_value_removed');
  assert.ok(c, 'removing enum value should be breaking');
  assert.equal(c.impact, 'breaking');
  assert.equal(c.before, 'c');
});

// ---------------------------------------------------------------------------
// 25. Description / docs changed → patch
// ---------------------------------------------------------------------------

test('description_changed → patch', () => {
  const a = baseMapping({ endpoints: [endpoint('GET', '/pets', { description: 'Old description.' })] });
  const b = baseMapping({ endpoints: [endpoint('GET', '/pets', { description: 'New description.' })] });
  const r = compareMapping(a, b);
  assert.equal(r.verdict, 'patch');
  const c = r.patch.find(x => x.kind === 'description_changed');
  assert.ok(c, 'description change should be patch');
  assert.equal(c.impact, 'patch');
});

// ---------------------------------------------------------------------------
// 26. Verdict bubbles: any breaking → major
// ---------------------------------------------------------------------------

test('verdict = major when any breaking changes exist', () => {
  const a = baseMapping({ endpoints: [endpoint('GET', '/pets')], models: [model('Pet', [field('id', true)])] });
  const b = baseMapping({ endpoints: [], models: [model('Pet', [field('id', true)])] }); // endpoint removed
  const r = compareMapping(a, b);
  assert.equal(r.verdict, 'major');
  assert.ok(r.counts.breaking > 0);
});

// ---------------------------------------------------------------------------
// 27. Verdict = minor when only non_breaking changes (no breaking)
// ---------------------------------------------------------------------------

test('verdict = minor when only non_breaking changes', () => {
  const a = baseMapping({ endpoints: [] });
  const b = baseMapping({ endpoints: [endpoint('GET', '/new-endpoint')] }); // endpoint added
  const r = compareMapping(a, b);
  assert.equal(r.verdict, 'minor');
  assert.equal(r.counts.breaking, 0);
  assert.ok(r.counts.non_breaking > 0);
});

// ---------------------------------------------------------------------------
// 28. Realistic mixed delta → verdict major with multi-category counts
// ---------------------------------------------------------------------------

test('realistic mixed delta → verdict major, multiple categories', () => {
  const a = baseMapping({
    endpoints: [
      endpoint('GET', '/pets'),
      endpoint('DELETE', '/pets/{id}'),
    ],
    auth: [authScheme('jwt', 'http-bearer')],
    models: [
      model('Pet', [field('id', true), field('name', true)]),
    ],
  });
  const b = baseMapping({
    endpoints: [
      endpoint('GET', '/pets'),
      endpoint('POST', '/pets'), // added (non_breaking)
    ],
    auth: [authScheme('jwt', 'api-key')], // type changed (breaking)
    models: [
      model('Pet', [
        field('id', true),
        field('name', true),
        field('species', true),   // required field added (breaking)
        field('nickname', false),  // optional field added (non_breaking)
      ]),
    ],
  });
  const r = compareMapping(a, b);
  assert.equal(r.verdict, 'major');
  assert.ok(r.counts.breaking > 0, 'should have breaking changes');
  assert.ok(r.counts.non_breaking > 0, 'should have non_breaking changes');
  assert.ok(r.counts.total > 3, 'should have multiple changes');
  // Summary checks.
  assert.equal(r.summary.removed_endpoints, 1); // DELETE /pets/{id}
  assert.equal(r.summary.added_endpoints, 1);   // POST /pets
});

// ---------------------------------------------------------------------------
// 29. Sorted by path
// ---------------------------------------------------------------------------

test('breaking array is sorted by path', () => {
  const a = baseMapping({
    models: [
      model('Pet', [field('id', true), field('name', true), field('age', true)]),
    ],
  });
  const b = baseMapping({ models: [] }); // all models removed
  const r = compareMapping(a, b);
  // Should have model_removed only (one change).
  assert.ok(r.breaking.length >= 1);
  for (let i = 1; i < r.breaking.length; i++) {
    assert.ok(r.breaking[i - 1].path <= r.breaking[i].path, 'breaking array must be sorted by path');
  }
});

// ---------------------------------------------------------------------------
// 30. throws TypeError for non-object inputs
// ---------------------------------------------------------------------------

test('throws TypeError when a is null', () => {
  assert.throws(() => compareMapping(null, baseMapping()), /compareMapping: a must be an object/);
});

test('throws TypeError when b is not an object', () => {
  assert.throws(() => compareMapping(baseMapping(), 'string'), /compareMapping: b must be an object/);
});

// ---------------------------------------------------------------------------
// W34 follow-up: response_example_only_changed (patch impact)
// ---------------------------------------------------------------------------

function _epWithResponse(example) {
  return endpoint('GET', '/widget', {
    responses: {
      '200': {
        description:  'OK',
        schema:       { $ref: 'Widget' },
        example:      example,
      },
    },
  });
}

test('response_example_only_changed → patch (schema unchanged, example differs)', () => {
  const a = baseMapping({ endpoints: [_epWithResponse({ id: 1, name: 'before' })] });
  const b = baseMapping({ endpoints: [_epWithResponse({ id: 1, name: 'after'  })] });

  const report = compareMapping(a, b);
  const exampleChanges = [...report.breaking, ...report.non_breaking, ...report.patch]
    .filter(c => c.kind === 'response_example_only_changed');

  assert.equal(exampleChanges.length, 1, 'must emit exactly one example-only change');
  assert.equal(exampleChanges[0].impact, 'patch', 'impact must be patch');
  assert.ok(exampleChanges[0].path.includes('responses[200]'), 'path must scope to status 200');
});

test('response_example_only_changed NOT emitted when schema also changed (subsumed)', () => {
  const a = baseMapping({ endpoints: [endpoint('GET', '/w', {
    responses: { '200': { description: 'OK', schema: { primitive: 'string' }, example: 'foo' } },
  })] });
  const b = baseMapping({ endpoints: [endpoint('GET', '/w', {
    responses: { '200': { description: 'OK', schema: { primitive: 'integer' }, example: 42 } },
  })] });

  const report = compareMapping(a, b);
  const exampleChanges = [...report.breaking, ...report.non_breaking, ...report.patch]
    .filter(c => c.kind === 'response_example_only_changed');
  const schemaChanges  = report.breaking.filter(c => c.kind === 'response_schema_changed');

  assert.equal(schemaChanges.length,  1, 'schema change must still be emitted (breaking)');
  assert.equal(exampleChanges.length, 0, 'must NOT double-count example diff under schema change');
});

test('response_example_only_changed NOT emitted when neither response has an example', () => {
  const a = baseMapping({ endpoints: [endpoint('GET', '/x', {
    responses: { '200': { description: 'OK', schema: { $ref: 'X' } } },
  })] });
  const b = baseMapping({ endpoints: [endpoint('GET', '/x', {
    responses: { '200': { description: 'OK', schema: { $ref: 'X' } } },
  })] });

  const report = compareMapping(a, b);
  const exampleChanges = [...report.breaking, ...report.non_breaking, ...report.patch]
    .filter(c => c.kind === 'response_example_only_changed');
  assert.equal(exampleChanges.length, 0);
});
