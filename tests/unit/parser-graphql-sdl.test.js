'use strict';

// tests/unit/parser-graphql-sdl.test.js — parseGraphQLSDL unit + end-to-end tests.

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('node:fs');
const path      = require('node:path');

const { parseGraphQLSDL, PARSER_NAME, PARSER_VERSION } = require(path.join(__dirname, '../../lib/parsers/graphql-sdl'));
const { GraphQLParseError } = require(path.join(__dirname, '../../lib/errors'));
const { handleScrape }      = require(path.join(__dirname, '../../lib/handlers/scrape'));

const FIXTURES = path.join(__dirname, '../fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// ---------------------------------------------------------------------------
// (a) simple-schema → >= 2 endpoints with transport='graphql'
// ---------------------------------------------------------------------------

test('parseGraphQLSDL simple-schema extracts >= 2 endpoints with transport=graphql', async () => {
  const body = readFixture('graphql-simple-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  assert.ok(result.ir, 'ir must be populated');
  assert.ok(result.ir.endpoints.length >= 2, `expected >= 2 endpoints, got ${result.ir.endpoints.length}`);
  assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
  assert.equal(result.parser.name,    PARSER_NAME);
  assert.equal(result.parser.version, PARSER_VERSION);

  for (const ep of result.ir.endpoints) {
    assert.equal(ep.transport, 'graphql', `endpoint ${ep.id} must have transport=graphql`);
    assert.equal(ep.method, 'query', `endpoint ${ep.id} must have method=query`);
    assert.ok(ep.path.startsWith('/query/'), `endpoint ${ep.id} path should start with /query/`);
    assert.ok(ep.id, 'endpoint must have id');
    assert.ok(/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(ep.id), `endpoint id ${ep.id} must match id regex`);
  }

  // Expect query_* endpoints from the simple schema.
  const ids = result.ir.endpoints.map(e => e.id);
  assert.ok(ids.some(id => id.includes('widget')), 'should have a widget endpoint');
  assert.ok(ids.some(id => id.includes('widgets')), 'should have a widgets endpoint');
});

// ---------------------------------------------------------------------------
// (b) complex-schema → endpoints across query + mutation + subscription roots
// ---------------------------------------------------------------------------

test('parseGraphQLSDL complex-schema extracts endpoints across all 3 root types', async () => {
  const body = readFixture('graphql-complex-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  assert.ok(result.ir, 'ir must be populated');
  assert.ok(result.ir.endpoints.length >= 6, `expected >= 6 endpoints, got ${result.ir.endpoints.length}`);

  const methods = [...new Set(result.ir.endpoints.map(e => e.method))];
  assert.ok(methods.includes('query'),        'should have query endpoints');
  assert.ok(methods.includes('mutation'),     'should have mutation endpoints');
  assert.ok(methods.includes('subscription'), 'should have subscription endpoints');

  for (const ep of result.ir.endpoints) {
    assert.equal(ep.transport, 'graphql', `endpoint ${ep.id} transport must be graphql`);
    assert.ok(ep.path, `endpoint ${ep.id} must have path`);
    assert.ok(/^\/(query|mutation|subscription)\//.test(ep.path), `endpoint ${ep.id} path format invalid: ${ep.path}`);
  }
});

// ---------------------------------------------------------------------------
// (c) empty / no roots → GraphQLParseError
// ---------------------------------------------------------------------------

test('parseGraphQLSDL throws GraphQLParseError on empty body', async () => {
  await assert.rejects(
    () => parseGraphQLSDL({ body: '', content_type: 'application/graphql', source_url: null }),
    (err) => {
      assert.ok(err instanceof GraphQLParseError, 'error must be GraphQLParseError');
      assert.equal(err.code, -32013);
      return true;
    }
  );
});

test('parseGraphQLSDL throws GraphQLParseError on body too short', async () => {
  await assert.rejects(
    () => parseGraphQLSDL({ body: 'type X', content_type: 'application/graphql', source_url: null }),
    (err) => {
      assert.ok(err instanceof GraphQLParseError);
      return true;
    }
  );
});

test('parseGraphQLSDL throws GraphQLParseError when no root types present', async () => {
  const sdl = `
type Widget {
  id: ID!
  name: String!
}

enum Status {
  ACTIVE
  ARCHIVED
}
`;
  await assert.rejects(
    () => parseGraphQLSDL({ body: sdl, content_type: 'application/graphql', source_url: null }),
    (err) => {
      assert.ok(err instanceof GraphQLParseError, 'error must be GraphQLParseError');
      assert.equal(err.code, -32013);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (d) @deprecated directive marks endpoint deprecated with reason
// ---------------------------------------------------------------------------

test('parseGraphQLSDL marks @deprecated fields with is_deprecated=true and reason', async () => {
  const body = readFixture('graphql-complex-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  const deprecated = result.ir.endpoints.filter(ep => ep.deprecated && ep.deprecated.is_deprecated);
  assert.ok(deprecated.length >= 1, `expected at least one deprecated endpoint, got ${deprecated.length}`);

  const deleteWidget = deprecated.find(ep => ep.id.includes('delete') || ep.id.includes('Delete'));
  assert.ok(deleteWidget, 'deleteWidget should be deprecated');
  assert.ok(deleteWidget.deprecated.reason, 'deprecated endpoint should have a reason');
  assert.ok(deleteWidget.deprecated.reason.includes('archiveWidget'), 'reason should reference archiveWidget');
});

// ---------------------------------------------------------------------------
// (e) custom scalars emit warning + alias model
// ---------------------------------------------------------------------------

test('parseGraphQLSDL emits scalar_coerced_to_string warning for custom scalars', async () => {
  const body = readFixture('graphql-simple-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  // Fixture has `scalar DateTime`.
  const scalarWarning = result.warnings.find(w => w.includes('scalar_coerced_to_string'));
  assert.ok(scalarWarning, `expected scalar_coerced_to_string warning, got: ${JSON.stringify(result.warnings)}`);
  assert.ok(scalarWarning.includes('DateTime'), 'warning should name the scalar DateTime');

  // The scalar should produce an alias model.
  const scalarModel = result.ir.models.find(m => m.name === 'DateTime');
  assert.ok(scalarModel, 'DateTime scalar model must exist');
  assert.equal(scalarModel.kind, 'alias', 'scalar model kind must be alias');
});

// ---------------------------------------------------------------------------
// (f) enum types → kind='enum' with values
// ---------------------------------------------------------------------------

test('parseGraphQLSDL produces enum models with kind=enum and value list', async () => {
  const body = readFixture('graphql-simple-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  const statusModel = result.ir.models.find(m => m.name === 'Status');
  assert.ok(statusModel, 'Status enum model must exist');
  assert.equal(statusModel.kind, 'enum');
  const valueNames = statusModel.fields.map(f => f.name);
  assert.ok(valueNames.includes('ACTIVE'),   'Status must include ACTIVE');
  assert.ok(valueNames.includes('PAUSED'),   'Status must include PAUSED');
  assert.ok(valueNames.includes('ARCHIVED'), 'Status must include ARCHIVED');
});

// ---------------------------------------------------------------------------
// (g) input types → kind='object' with x-graphql-kind extension
// ---------------------------------------------------------------------------

test('parseGraphQLSDL maps input types to kind=object with x-graphql-kind=input extension', async () => {
  const body = readFixture('graphql-complex-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  const inputModel = result.ir.models.find(m => m.name === 'WidgetCreateInput');
  assert.ok(inputModel, 'WidgetCreateInput model must exist');
  assert.equal(inputModel.kind, 'object');
  assert.ok(inputModel.extensions, 'input model must have extensions');
  assert.equal(inputModel.extensions['x-graphql-kind'], 'input', 'x-graphql-kind must be "input"');
  assert.ok(inputModel.fields.length >= 1, 'input model must have at least one field');
});

// ---------------------------------------------------------------------------
// (h) explicit schema { query: ... } block correctly identifies root types
// ---------------------------------------------------------------------------

test('parseGraphQLSDL handles explicit schema block to find non-conventional root type names', async () => {
  const body = readFixture('graphql-complex-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  // The fixture uses QueryRoot / MutationRoot / SubscriptionRoot.
  const rootTypes = result.ir.extensions['x-graphql-root-types'];
  assert.ok(rootTypes, 'x-graphql-root-types must be present');
  assert.equal(rootTypes.query,        'QueryRoot',        'query root should be QueryRoot');
  assert.equal(rootTypes.mutation,     'MutationRoot',     'mutation root should be MutationRoot');
  assert.equal(rootTypes.subscription, 'SubscriptionRoot', 'subscription root should be SubscriptionRoot');

  // Endpoints should still have method=query/mutation/subscription.
  const methods = [...new Set(result.ir.endpoints.map(e => e.method))];
  assert.ok(methods.includes('query'),        'should have query endpoints');
  assert.ok(methods.includes('mutation'),     'should have mutation endpoints');
  assert.ok(methods.includes('subscription'), 'should have subscription endpoints');
});

// ---------------------------------------------------------------------------
// (i) x-source-format and x-graphql-root-types populated
// ---------------------------------------------------------------------------

test('parseGraphQLSDL populates x-source-format and x-graphql-root-types extensions', async () => {
  const body = readFixture('graphql-simple-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  assert.equal(result.ir.extensions['x-source-format'], 'graphql-sdl');

  const rootTypes = result.ir.extensions['x-graphql-root-types'];
  assert.ok(rootTypes, 'x-graphql-root-types must be set');
  assert.ok(rootTypes.query,        'query root must be present');
  assert.ok(rootTypes.mutation     !== undefined, 'mutation root key must be present');
  assert.ok(rootTypes.subscription !== undefined, 'subscription root key must be present');
});

// ---------------------------------------------------------------------------
// (j) end-to-end via handleScrape against the complex fixture (file source)
// ---------------------------------------------------------------------------

test('handleScrape e2e: graphql-complex-schema.graphql produces valid mapping', async () => {
  const fixturePath = path.join(FIXTURES, 'graphql-complex-schema.graphql');
  const result = await handleScrape({
    source:       fixturePath,
    service_name: 'gql-e2e-test',
    overwrite:    true,
  });

  assert.ok(result.output_path, 'output_path must be set');
  assert.ok(result.endpoint_count >= 6, `expected >= 6 endpoints, got ${result.endpoint_count}`);

  const mapping = JSON.parse(fs.readFileSync(result.output_path, 'utf8'));
  assert.equal(mapping.extensions['x-source-format'], 'graphql-sdl');

  const transports = [...new Set(mapping.endpoints.map(e => e.transport))];
  assert.deepEqual(transports, ['graphql'], 'all endpoints must have transport=graphql');

  const methods = [...new Set(mapping.endpoints.map(e => e.method))];
  assert.ok(methods.includes('query'),        'should include query method');
  assert.ok(methods.includes('mutation'),     'should include mutation method');
  assert.ok(methods.includes('subscription'), 'should include subscription method');

  const rootTypes = mapping.extensions['x-graphql-root-types'];
  assert.ok(rootTypes, 'x-graphql-root-types must be populated');
  assert.equal(rootTypes.query,        'QueryRoot');
  assert.equal(rootTypes.mutation,     'MutationRoot');
  assert.equal(rootTypes.subscription, 'SubscriptionRoot');
});

// ---------------------------------------------------------------------------
// ReDoS sanity: 64 KB pathological body of # comments completes in <100 ms
// ---------------------------------------------------------------------------

test('parseGraphQLSDL ReDoS sanity: 64KB # comment body + valid SDL parses in <100ms', async () => {
  // 64 KB of # comments followed by a minimal valid schema.
  const commentBlock = '# this is a comment to test redos safety\n'.repeat(Math.ceil(64 * 1024 / 42));
  const validSdl = `\ntype Query {\n  hello: String\n}\n`;
  const body = commentBlock + validSdl;

  const start = Date.now();
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 100, `ReDoS safety: parse took ${elapsed}ms, expected <100ms`);
  assert.ok(result.ir.endpoints.length >= 1, 'should extract at least 1 endpoint');
});

// ---------------------------------------------------------------------------
// Field args → query_params with required + default
// ---------------------------------------------------------------------------

test('parseGraphQLSDL maps field args to query_params with required and default', async () => {
  const body = readFixture('graphql-simple-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  // The `widgets` field has `status: Status, limit: Int = 25`
  const widgetsEp = result.ir.endpoints.find(ep => ep.id.endsWith('_widgets') || ep.id === 'query_widgets');
  assert.ok(widgetsEp, 'widgets endpoint must exist');
  assert.ok(widgetsEp.query_params.length >= 1, `widgets should have query params, got ${widgetsEp.query_params.length}`);

  const limitParam = widgetsEp.query_params.find(p => p.name === 'limit');
  assert.ok(limitParam, 'limit param must exist');
  assert.equal(limitParam.required, false, 'limit param is not required (no !)');
  assert.equal(limitParam.default, 25, 'limit default should be 25');
});

// ---------------------------------------------------------------------------
// Interface handling → kind='object' with interface_flattened warning
// ---------------------------------------------------------------------------

test('parseGraphQLSDL flattens interface to object and emits interface_flattened warning', async () => {
  const sdl = `
type Query {
  node(id: ID!): Node
}

interface Node {
  id: ID!
  name: String
}
`;
  const result = await parseGraphQLSDL({ body: sdl, content_type: 'application/graphql', source_url: null });

  const nodeModel = result.ir.models.find(m => m.name === 'Node');
  assert.ok(nodeModel, 'Node model must exist');
  assert.equal(nodeModel.kind, 'object', 'interface should be flattened to object');

  const ifaceWarning = result.warnings.find(w => w.includes('interface_flattened'));
  assert.ok(ifaceWarning, `expected interface_flattened warning, got: ${JSON.stringify(result.warnings)}`);
});

// ---------------------------------------------------------------------------
// Parser name / version constants
// ---------------------------------------------------------------------------

test('parseGraphQLSDL returns correct parser name and version', async () => {
  const body = readFixture('graphql-simple-schema.graphql');
  const result = await parseGraphQLSDL({ body, content_type: 'application/graphql', source_url: null });

  assert.equal(result.parser.name,    'apifier-graphql-sdl-parser');
  assert.equal(result.parser.version, '0.0.1');
});

// ---------------------------------------------------------------------------
// W36 follow-up regression: union members must NOT be empty
// (GQL-001: the implements-skip loop was consuming the `= A | B | C` body
//  before the union-specific parser could read it, so SearchResult always
//  produced fields: []. The one-character fix STOPs the skip loop at '=';
//  this test pins that down so the regression cannot return silently.)
// ---------------------------------------------------------------------------

test('GQL-001 regression: union declarations capture all member types', async () => {
  const body = `
    type Widget   { id: ID! name: String! }
    type Category { id: ID! label: String! }
    type User     { id: ID! email: String! }

    union SearchResult = Widget | Category | User

    type Query {
      search(q: String!): [SearchResult!]!
    }
  `;
  const result = await parseGraphQLSDL({
    body,
    content_type: 'application/graphql',
    source_url:   null,
  });

  const union = result.ir.models.find(m => m.name === 'SearchResult');
  assert.ok(union, 'SearchResult union model must be present');
  assert.equal(union.kind, 'union', 'kind must be "union"');
  assert.ok(Array.isArray(union.fields) && union.fields.length >= 3,
    `union.fields must have >= 3 members (got ${union.fields ? union.fields.length : 'undefined'})`);

  const refs = union.fields.map(f => f.type && f.type.$ref).filter(Boolean);
  for (const expected of ['Widget', 'Category', 'User']) {
    assert.ok(refs.includes(expected),
      `union members must include $ref to ${expected} (got refs: ${JSON.stringify(refs)})`);
  }
});
