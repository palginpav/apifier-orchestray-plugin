# Changelog
All notable changes to this project will be documented in this file.
The format is based on Keep a Changelog (https://keepachangelog.com/en/1.1.0/).

## [0.2.0] — 2026-05-19

### Added
- (Wave 2E) Markdown doc parser — ingest API docs published as Markdown
  (`docs/api.md`, README sections, wiki exports). Pure-regex parser, no
  external deps. Three endpoint-detection patterns (heading w/ METHOD path,
  backticked heading, bare line in fenced block). Path/query params from
  Markdown tables. Body + response examples from JSON code blocks. Auth
  detection from top-level Authentication / API Keys sections.
  `mapping.extensions["x-source-format"] = "markdown"` for drift detection.
- (Wave 2D) HTML doc-site parser — `cheerio` + 5 strategy modules covering:
  - OpenAPI-rendered SPA viewers (Swagger UI / Redoc / Scalar / Stoplight /
    RapiDoc) with same-origin `redirect_to_spec` auto-follow.
  - Stripe/Slate three-column layouts.
  - Docusaurus mdx-rendered.
  - GitBook conventions.
  - Generic last-resort heading heuristic.
  `mapping.extensions["x-html-archetype"]` records the detected strategy
  for drift detection on re-scrape.
  Commits: `ce563cb` (architect design), `439dfc1` (impl), `da7c66d` (nits).
- Real-world integration tests (`tests/integration/real-world-formats.test.js`)
  round-trip three hand-trimmed real-world fixtures (Petstore YAML, a
  Stripe-style HTML doc page, a GitHub repo Markdown API doc) through
  scrape → validate → ts-fetch codegen → python-requests codegen.
  Wave 2E commits: `dfda308` (impl), `090a01c` (nits).

### Security
- Same-origin guard for `redirect_to_spec` in HTML scrape handler. Cross-
  origin Swagger-UI/Redoc page pointing to an external spec URL now throws
  `HTMLParseError(-32008)` with an actionable hint, rather than crashing
  on null IR.
- New error codes: `HTMLParseError(-32008)`,
  `HTMLArchetypeUnsupportedError(-32009)`, `MarkdownParseError(-32010)` —
  dispatcher remaps all to `-32603` with `data.domain_code` per the Wave
  2A hardening contract.

### Changed
- `lib/handlers/scrape.js` `_sniffSourceType` now returns
  `html` | `markdown` | `openapi` (was `html` | `openapi`).
- Runtime dep added: `cheerio ^1.2.0` (MIT). Dep set is now
  `{zod, js-yaml, cheerio}`.

### Fixed
- Markdown multi-response attribution: endpoints with multiple response
  headings (e.g. `### Response` + `### Example response 404`) now produce
  distinct `responses['200']` and `responses['404']` entries with the
  correct bodies in `x-response-example-{status}`. Previously, all blocks
  collapsed to the last response heading seen in the section.

## [0.1.0] — 2026-05-19

### Added
- (Wave 4B) python-requests codegen target — emit a Python 3.8+ requests-based
  client from any apifier-mapping.json. Byte-deterministic; py_compile clean.
  Commits: `1f73f67` feat, `5197344` fix nits.
- (Wave 4A) ts-fetch codegen target — emit a byte-deterministic TypeScript
  fetch-based client. The `apifier-generate` MCP tool is no longer a stub.
  Commits: `5de226f` feat, `cd43194` fix nits.
- (Wave 2C) robots.txt enforcement (lib/http/robots.js) + sitemap.xml
  crawler (lib/http/sitemap.js) with sitemap-index expansion. Same-origin
  guard against SSRF; 5 MB body cap; in-memory origin cache.
  Commits: `462887c` feat, `616968f` fix nits.
- (Wave 2B) YAML support in `apifier-scrape` via js-yaml (safe-mode
  JSON_SCHEMA — rejects !!js/function and !!python/* tags).
- (Wave 2B) apifier-list + apifier-doctor MCP tools — no longer stubs.
  Commits: `3953cda` feat, `3c9b136` fix nits.
- (Wave 2A) End-to-end OpenAPI 3.0/3.1 ingest: `apifier-scrape` -> mapping
  on disk -> `apifier-validate`. Mapping schema v1 with provenance,
  canonical byte-stable writer, no-throw reader.
- (Wave 1) Plugin scaffold: orchestray-plugin.json manifest, NDJSON
  JSON-RPC dispatcher (server.js + lib/dispatcher.js), bin/apifier-doctor
  CLI health check. Commit: `f7f7916`.

### Security
- Shared `lib/path-guard.js` enforcing literal `..` + realpath allowed-roots
  on every file write (mapping persistence, generated clients).
- Output redaction in JSON-RPC error frames (control chars + credential
  patterns).
- Domain error codes remapped to JSON-RPC -32603 with data.domain_code
  for diagnostic traceability without leaking internals to callers.

### Codegen targets
- LIVE: ts-fetch, python-requests
- Planned: ts-axios, python-httpx, openapi-3.1 (Wave 4C), go-net-http,
  curl-shell (Wave 6+)

## [0.0.1] — pre-history
- Internal scaffold only; never published. Commit: `f7f7916`.

[0.2.0]: https://github.com/palginpav/apifier-orchestray-plugin/releases/tag/v0.2.0
[0.1.0]: https://github.com/palginpav/apifier-orchestray-plugin/releases/tag/v0.1.0
