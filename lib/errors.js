'use strict';

// lib/errors.js — JSON-RPC error helpers and ApifierError class hierarchy.
// Provides error codes -32601 (method_not_found), -32602 (invalid_params),
// -32603 (internal_error), and domain-specific codes for apifier operations.

/** Base class for all apifier errors. Maps to JSON-RPC -32603 internal_error. */
class ApifierError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApifierError';
    this.code = -32603;
  }
}

/** Zod argument validation failed. Maps to JSON-RPC -32602 invalid_params. */
class BadParamsError extends ApifierError {
  constructor(message) {
    super(message);
    this.name = 'BadParamsError';
    this.code = -32602;
  }
}

/** HTTP transport error: timeout, non-2xx, byte-cap exceeded, robots-blocked. */
class FetcherError extends ApifierError {
  constructor(message) {
    super(message);
    this.name = 'FetcherError';
    this.code = -32001;
  }
}

/** Source-type-specific parse failure. */
class ParserError extends ApifierError {
  constructor(message) {
    super(message);
    this.name = 'ParserError';
    this.code = -32002;
  }
}

/** Built mapping failed schema validation. */
class ValidatorRejectedError extends ApifierError {
  constructor(message) {
    super(message);
    this.name = 'ValidatorRejectedError';
    this.code = -32003;
  }
}

/** Method or tool name unknown. Maps to JSON-RPC -32601 method_not_found. */
class ToolNotFoundError extends ApifierError {
  constructor(message) {
    super(message);
    this.name = 'ToolNotFoundError';
    this.code = -32601;
  }
}

/** Fetched body exceeded the 5 MB size cap. Sub-class of FetcherError. */
class ScrapeSizeError extends FetcherError {
  constructor(message) {
    super(message);
    this.name = 'ScrapeSizeError';
  }
}

/** Remote returned 401 or 403; user must supply a local file. Sub-class of FetcherError. */
class AuthGatedError extends FetcherError {
  constructor(message) {
    super(message);
    this.name = 'AuthGatedError';
  }
}

/** Source format is not supported in this version (e.g. YAML in v0.0.1). Sub-class of ParserError. */
class UnsupportedFormatError extends ParserError {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

/** OpenAPI document failed to parse (malformed JSON, missing required fields). Sub-class of ParserError. */
class OpenAPIParseError extends ParserError {
  constructor(message) {
    super(message);
    this.name = 'OpenAPIParseError';
  }
}

/** robots.txt disallows crawling the target URL. Sub-class of FetcherError. */
class RobotsBlockedError extends FetcherError {
  constructor(message, data) {
    super(message);
    this.name = 'RobotsBlockedError';
    this.code = -32004;
    this.data = data || {};
  }
}

/** sitemap.xml returned 404 or 410. Sub-class of FetcherError. */
class SitemapNotFoundError extends FetcherError {
  constructor(message) {
    super(message);
    this.name = 'SitemapNotFoundError';
    this.code = -32005;
  }
}

/** sitemap body is not valid XML (no urlset or sitemapindex). Sub-class of ParserError. */
class SitemapParseError extends ParserError {
  constructor(message) {
    super(message);
    this.name = 'SitemapParseError';
    this.code = -32006;
  }
}

/** Codegen target is not yet supported; scheduled for a future wave. Maps to -32007. */
class CodegenNotSupportedError extends ApifierError {
  /**
   * @param {string} targetId - The requested codegen target id.
   * @param {string} wave     - The wave in which the target is scheduled.
   */
  constructor(targetId, wave) {
    super(`target '${targetId}' is not yet supported; scheduled for wave ${wave}`);
    this.name = 'CodegenNotSupportedError';
    this.code = -32007;
    this.data = { target: targetId, scheduled_wave: wave };
  }
}

/** HTML document failed to parse (no endpoints found, too short, or cheerio failure). Sub-class of ParserError. Maps to -32008. */
class HTMLParseError extends ParserError {
  constructor(message) {
    super(message);
    this.name = 'HTMLParseError';
    this.code = -32008;
  }
}

/** HTML archetype not supported in this version (reserved for post-Playwright unlock). Sub-class of ParserError. Maps to -32009. */
class HTMLArchetypeUnsupportedError extends ParserError {
  constructor(message) {
    super(message);
    this.name = 'HTMLArchetypeUnsupportedError';
    this.code = -32009;
  }
}

/** Markdown document failed to parse (too short, no detectable endpoints). Sub-class of ParserError. Maps to -32010. */
class MarkdownParseError extends ParserError {
  constructor(message) {
    super(message);
    this.name = 'MarkdownParseError';
    this.code = -32010;
  }
}

/** Postman collection failed to parse (malformed JSON, missing info/item, unsupported v1 format). Sub-class of ParserError. Maps to -32011. */
class PostmanParseError extends ParserError {
  constructor(message) {
    super(message);
    this.name = 'PostmanParseError';
    this.code = -32011;
  }
}

/** One or both mapping files supplied to apifier-diff failed schema validation. Maps to -32012. */
class MappingDiffError extends ApifierError {
  constructor(message) {
    super(message);
    this.name = 'MappingDiffError';
    this.code = -32012;
  }
}

/**
 * Build a JSON-RPC error frame.
 * @param {number|null} id - Request id (may be null for notifications)
 * @param {number} code - JSON-RPC error code
 * @param {string} message - Human-readable error message
 * @param {object} [data={}] - Optional structured data field (always present in output)
 * @returns {{ jsonrpc: '2.0', id: number|null, error: { code: number, message: string, data: object } }}
 */
function makeErrorFrame(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data: data !== undefined ? data : {} } };
}

/** Convenience: -32601 method not found. */
function methodNotFound(id, method) {
  return makeErrorFrame(id, -32601, `method not found: ${method}`);
}

/** Convenience: -32602 invalid params. */
function invalidParams(id, detail) {
  return makeErrorFrame(id, -32602, `invalid params: ${detail}`);
}

/** Convenience: -32603 internal error. */
function internalError(id, detail) {
  return makeErrorFrame(id, -32603, `internal error: ${detail}`);
}

module.exports = {
  ApifierError,
  BadParamsError,
  FetcherError,
  ParserError,
  ValidatorRejectedError,
  ToolNotFoundError,
  ScrapeSizeError,
  AuthGatedError,
  UnsupportedFormatError,
  OpenAPIParseError,
  RobotsBlockedError,
  SitemapNotFoundError,
  SitemapParseError,
  CodegenNotSupportedError,
  HTMLParseError,
  HTMLArchetypeUnsupportedError,
  MarkdownParseError,
  PostmanParseError,
  MappingDiffError,
  makeErrorFrame,
  methodNotFound,
  invalidParams,
  internalError,
};
