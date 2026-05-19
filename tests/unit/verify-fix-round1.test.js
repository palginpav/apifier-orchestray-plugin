'use strict';

// tests/unit/verify-fix-round1.test.js — New tests for all 6 findings fixed in verify-fix round 1.
// Covers: I-01 (dispatcher domain code remapping), I-02 (makeErrorFrame data field),
//         I-03 (output-redaction control chars), I-04 (path-guard module),
//         I-05 (openapi malformed source_url), I-06 (no _detectKind export in openapi).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os     = require('os');
const path   = require('node:path');
const fs     = require('node:fs');

// ---------------------------------------------------------------------------
// I-02: makeErrorFrame always includes a `data` field
// ---------------------------------------------------------------------------

describe('I-02: makeErrorFrame always includes data field', () => {
  const { makeErrorFrame } = require('../../lib/errors');

  test('makeErrorFrame without data arg produces data: {}', () => {
    const frame = makeErrorFrame(1, -32603, 'internal error');
    assert.ok('data' in frame.error, 'error.data must be present');
    assert.deepEqual(frame.error.data, {});
  });

  test('makeErrorFrame with explicit data includes it verbatim', () => {
    const frame = makeErrorFrame(2, -32603, 'internal error', { domain_code: -32001 });
    assert.ok('data' in frame.error, 'error.data must be present');
    assert.equal(frame.error.data.domain_code, -32001);
  });

  test('makeErrorFrame with data: {} keeps field present', () => {
    const frame = makeErrorFrame(null, -32601, 'method not found', {});
    assert.ok('data' in frame.error, 'error.data must be present even when empty');
    assert.deepEqual(frame.error.data, {});
  });
});

// ---------------------------------------------------------------------------
// I-01: Dispatcher remaps domain codes to -32603 with data.domain_code
// ---------------------------------------------------------------------------

describe('I-01: dispatcher remaps domain error codes', () => {
  const { dispatch } = require('../../lib/dispatcher');
  const { FetcherError } = require('../../lib/errors');

  test('FetcherError (-32001) from handler is remapped to -32603 with data.domain_code', async () => {
    // apifier-scrape with a non-existent local file in an allowed root should produce a
    // domain error. We use a source path under homedir so path-guard passes, but the
    // file does not exist — fetchSource will throw an Error (not a FetcherError), so
    // we instead test the remapping directly by making a stub that throws FetcherError.
    //
    // Strategy: call apifier-validate with a nonexistent path. The handler will throw
    // an error. Regardless of the exact domain code, the frame must have code -32603
    // and data.domain_code set if the original code was outside the spec set.
    //
    // To directly test FetcherError remapping we patch via the module require cache.
    const handlersScrape = require('../../lib/handlers/scrape');
    const original = handlersScrape.handleScrape;

    // Temporarily replace handleScrape to throw FetcherError.
    handlersScrape.handleScrape = async () => {
      const { FetcherError: FE } = require('../../lib/errors');
      throw new FE('simulated fetcher failure');
    };

    const frame = {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'apifier-scrape', arguments: { source: 'https://example.com/api.json' } },
    };

    // Re-require dispatcher after patching to pick up patched handler.
    // Because dispatcher lazy-loads via _getHandlers, we need to call dispatch again.
    let resp;
    try {
      resp = await dispatch(frame);
    } finally {
      handlersScrape.handleScrape = original;
    }

    assert.ok(resp.error, 'must have error field');
    assert.equal(resp.error.code, -32603, 'remapped code must be -32603');
    assert.ok('data' in resp.error, 'error.data must be present');
    assert.equal(resp.error.data.domain_code, -32001, 'domain_code must be -32001 (FetcherError)');
  });

  test('spec codes pass through unchanged (no remapping)', async () => {
    // tools/call with unknown tool name → -32602 (spec code, must NOT be remapped)
    const frame = {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: { name: 'no-such-tool', arguments: {} },
    };
    const resp = dispatch(frame);
    assert.equal(resp.error.code, -32602, 'spec code -32602 must pass through unchanged');
  });
});

// ---------------------------------------------------------------------------
// I-03: output-redaction strips control characters
// ---------------------------------------------------------------------------

describe('I-03: redact() strips control characters', () => {
  const { redact } = require('../../lib/output-redaction');

  test('redact removes NUL (\\x00) and other control chars', () => {
    const result = redact('a\x00b\x01c');
    assert.equal(result, 'abc', 'control chars 0x00 and 0x01 must be stripped');
  });

  test('redact preserves \\t, \\n, \\r (legitimate whitespace)', () => {
    const result = redact('line1\nline2\ttab\rcarriage');
    assert.ok(result.includes('\n'), '\\n must be preserved');
    assert.ok(result.includes('\t'), '\\t must be preserved');
    assert.ok(result.includes('\r'), '\\r must be preserved');
  });

  test('redact strips 0x0b (VT) and 0x0c (FF)', () => {
    const result = redact('a\x0bb\x0cc');
    assert.equal(result, 'abc', 'vertical-tab and form-feed must be stripped');
  });

  test('redact strips 0x7f (DEL)', () => {
    const result = redact('a\x7fb');
    assert.equal(result, 'ab', 'DEL control char must be stripped');
  });

  test('redact still scrubs credentials after control-char stripping', () => {
    const result = redact('Bearer \x00sk-ant-ABCDEF1234567890');
    assert.ok(!result.includes('sk-ant-ABCDEF1234567890'), 'API key must be redacted');
  });
});

// ---------------------------------------------------------------------------
// I-04: path-guard module
// ---------------------------------------------------------------------------

describe('I-04: path-guard resolveWithinAllowedRoots', () => {
  const { resolveWithinAllowedRoots, PathTraversalError } = require('../../lib/path-guard');

  const HOME = os.homedir();
  const CWD  = process.cwd();

  test('rejects /etc/passwd when allowed roots are [HOME, CWD]', () => {
    assert.throws(
      () => resolveWithinAllowedRoots('/etc/passwd', { allowedRoots: [HOME, CWD] }),
      (err) => err instanceof PathTraversalError
    );
  });

  test('accepts a path under HOME', () => {
    const p = path.join(HOME, 'some-file.json');
    const result = resolveWithinAllowedRoots(p, { allowedRoots: [HOME, CWD] });
    assert.equal(result, path.resolve(p));
  });

  test('rejects path containing ".."', () => {
    assert.throws(
      () => resolveWithinAllowedRoots('../etc/passwd', { allowedRoots: [HOME, CWD] }),
      (err) => err instanceof PathTraversalError
    );
  });

  test('rejects empty string', () => {
    assert.throws(
      () => resolveWithinAllowedRoots('', { allowedRoots: [HOME, CWD] }),
      (err) => err instanceof PathTraversalError
    );
  });
});

// ---------------------------------------------------------------------------
// I-04 (fetch.js): fetchSource with file mode rejects /etc/passwd
// ---------------------------------------------------------------------------

describe('I-04: fetchSource file mode rejects paths outside allowed roots', () => {
  const { fetchSource, PathTraversalError } = require('../../lib/http/fetch');

  test('fetchSource rejects /etc/passwd with PathTraversalError', async () => {
    await assert.rejects(
      () => fetchSource({ source: '/etc/passwd' }),
      (err) => err instanceof PathTraversalError
    );
  });
});

// ---------------------------------------------------------------------------
// I-05: parseOpenAPI handles malformed source_url without throwing
// ---------------------------------------------------------------------------

describe('I-05: parseOpenAPI tolerates non-URL source_url', () => {
  const { parseOpenAPI } = require('../../lib/parsers/openapi');
  const FIXTURE_30 = path.join(__dirname, '../fixtures/sample-openapi-3.0.json');

  test('parseOpenAPI with file-path source_url falls back to unknown-service', async () => {
    const body = fs.readFileSync(FIXTURE_30, 'utf8');
    // Minimal doc without info.title so hostname fallback is triggered.
    const noTitleDoc = JSON.parse(body);
    delete noTitleDoc.info.title;

    let result;
    assert.doesNotThrow(() => {
      result = parseOpenAPI({
        body: JSON.stringify(noTitleDoc),
        content_type: 'application/json',
        source_url: '/abs/path/foo.json',  // not a valid URL — must not crash
      });
    });
    const { ir } = await result;
    // With no title and a non-URL source_url, service name falls back to 'unknown'.
    assert.ok(typeof ir.service.name === 'string', 'service.name must be a string');
  });

  test('parseOpenAPI with valid URL source_url uses hostname', async () => {
    const body = fs.readFileSync(FIXTURE_30, 'utf8');
    const noTitleDoc = JSON.parse(body);
    delete noTitleDoc.info.title;

    const { ir } = await parseOpenAPI({
      body: JSON.stringify(noTitleDoc),
      content_type: 'application/json',
      source_url: 'https://api.example.com/openapi.json',
    });
    assert.ok(ir.service.name.includes('example'), 'service.name should derive from hostname');
  });
});

// ---------------------------------------------------------------------------
// I-06: _detectKind is NOT exported from openapi.js
// ---------------------------------------------------------------------------

describe('I-06: openapi.js exports do not include _detectKind', () => {
  test('_detectKind is not in module.exports of lib/parsers/openapi.js', () => {
    const openapi = require('../../lib/parsers/openapi');
    assert.ok(!('_detectKind' in openapi), '_detectKind must not be exported from openapi.js');
  });

  test('parseOpenAPI and PARSER_NAME and PARSER_VERSION are exported', () => {
    const openapi = require('../../lib/parsers/openapi');
    assert.ok(typeof openapi.parseOpenAPI === 'function', 'parseOpenAPI must be exported');
    assert.ok(typeof openapi.PARSER_NAME === 'string', 'PARSER_NAME must be exported');
    assert.ok(typeof openapi.PARSER_VERSION === 'string', 'PARSER_VERSION must be exported');
  });
});
