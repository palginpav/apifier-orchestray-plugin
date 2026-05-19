# Changelog
All notable changes to this project will be documented in this file.
The format is based on Keep a Changelog (https://keepachangelog.com/en/1.1.0/).

## [0.5.0] — 2026-05-19

**Codegen complete: ALL 7 declared targets are now LIVE.**

### Added
- (Wave 4F) **`ts-axios` codegen** — TypeScript axios client. Mirrors the
  `ts-fetch` shape but uses `axios.create({baseURL}).request(...)`. Error
  mapping via `AxiosError.response?.status` → ApifierXxxError. Per-request
  header injection (no shared `defaults` mutation) for safer concurrent
  use. `node --check` validated.
- (Wave 4F) **`python-httpx` codegen** — Python 3.8+ httpx sync client.
  Mirrors `python-requests` shape but uses `httpx.Client`. Cleaner
  basic-auth (httpx accepts `auth=(user, password)` tuples — no manual
  base64). `python3 -m py_compile` validated.
- `tests/integration/openapi-3.1-roundtrip.test.js` gains a completeness
  test asserting **every** registry target is supported — catches a
  future regression where a new target is declared without a wired
  handler.

### Changed
- `apifier-generate` manifest description rewritten: now enumerates all
  7 live targets (`ts-fetch`, `ts-axios`, `python-requests`,
  `python-httpx`, `openapi-3.1`, `go-net-http`, `curl-shell`). No more
  "Planned" section in the description.
- Plugin version 0.4.0 → 0.5.0 (third feature-add minor since 0.2.0).
  Manifest + `package.json` in lock-step.

### Fixed (W42 follow-up, before publish)
- (CRITICAL) `python-httpx`: `self._base_url` was referenced in per-method
  URL f-strings but never assigned in `__init__` — every generated client
  method would raise `AttributeError` at runtime. `py_compile` is
  syntax-only, so it didn't catch this; the golden-file test passed
  because the golden was bug-compatible. Fix: assign `self._base_url`
  alongside `self._client` in the constructor.
- (CRITICAL) `python-httpx` + `python-requests`: alphabetically-sorted
  models caused forward-reference NameErrors (e.g. `Pet` references
  `Tag` but `Tag` is defined later in the file; dataclass evaluates
  annotations at class-definition time). Fix: emit `from __future__
  import annotations` (PEP 563, Python 3.7+; we target 3.8+).
  All dataclass annotations are now lazy strings.
- `ts-axios` JSDoc comment for `_buildHeaderLines` rewritten to describe
  the actual per-request injection strategy (the prior comment claimed
  `defaults.headers` mutation, which the implementation didn't do).

### Codegen targets at v0.5.0
| Target | Wave | Status |
|---|---|---|
| `ts-fetch` | 4A | LIVE |
| `python-requests` | 4B | LIVE |
| `openapi-3.1` | 4C | LIVE |
| `go-net-http` | 4D | LIVE |
| `curl-shell` | 4E | LIVE |
| `ts-axios` | 4F | LIVE |
| `python-httpx` | 4F | LIVE |

## [0.4.0] — 2026-05-19

### Added
- (Wave 8) **`apifier-watch` MCP tool** (7th tool). Composes
  `apifier-scrape` + `apifier-diff` into a single atomic call that
  returns `should_block: boolean` for CI gates. Configurable severity
  threshold via `block_on` (`breaking` / `minor` / `patch` / `none`).
  Pairs with `apifier-diff` to form the complete API drift-detection
  loop. Timing buckets — `scrape_ms`, `baseline_load_ms`, `diff_ms`,
  `total_ms` — let CI measure where the per-tick budget is spent.
- (Wave 6B) **GraphQL SDL ingest** (6th source format). Hand-rolled
  pure-JS SDL parser (no `graphql-js` dep). Each `type Query` /
  `Mutation` / `Subscription` root field becomes an endpoint with
  `transport: "graphql"`. Explicit `schema { query: X, mutation: Y }`
  blocks correctly rebind non-conventional root names. `@deprecated`
  directive flows to endpoint deprecation. Custom scalars / enums /
  unions / inputs all map cleanly into the IR models.
  `mapping.extensions["x-source-format"] = "graphql-sdl"` +
  `mapping.extensions["x-graphql-root-types"]`.
- (Wave 4D) **`go-net-http` codegen** (3rd language ecosystem — Go
  stdlib net/http). Validated by both `gofmt -e` and `go vet ./...`
  on every shipped output. Auth helpers (`SetBearerToken`,
  `SetApiKey` w/ header AND query positions, `SetBasicAuth`), error
  class hierarchy via composition, context-aware methods, per-endpoint
  args struct. Byte-deterministic; unused-imports tracking prevents
  `go vet` failures on endpoint-less mappings.

### Changed
- Codegen registry now lists 4 LIVE targets (was 3 after Wave 4C):
  `ts-fetch` (4A), `python-requests` (4B), `openapi-3.1` (4C),
  `go-net-http` (4D). Planned: `ts-axios`, `python-httpx` (4E);
  `curl-shell` (6+).
- Tool surface: 5 → 6 → 7 (apifier-diff in Wave 7; apifier-watch
  in Wave 8). All tools auto-discover via `TOOL_DECLS.length` in
  the dispatcher; manifest is the single source of truth.
- Plugin manifest description updated to advertise all four live
  codegen targets and to enumerate the 4E-planned variants.
- `apifier-scrape` + `apifier-watch` `source_type` enums now in
  parity (graphql-introspection is in both).

### Security
- `lib/diff/compare.js` is a pure function (no I/O); the diff
  surface is exhaustively unit-testable.
- `apifier-watch` baseline_path routed through `lib/path-guard.js`;
  cross-allowed-root inputs are rejected.
- Domain error codes added: `MappingDiffError(-32012)`,
  `GraphQLParseError(-32013)`, `WatchError(-32014)`. All remap to
  JSON-RPC `-32603` with `data.domain_code` for diagnostic
  traceability without leaking internals to callers.

### Fixed
- (W36) GraphQL SDL union member fields previously always empty
  (`fields: []`) due to a tokenizer skip-loop that consumed the
  `= A | B | C` body before the union-specific parser ran. One-
  character fix: the implements-skip loop now also stops at `=`.
  Regression test pins this down.
- (W30) Go codegen for zero-endpoint mappings now passes `go vet`
  (unused-imports bug fixed; `context`/`io`/`net/url` only added
  when `endpoints.length > 0`).
- (W30) `lib/handlers/scrape.js` cross-origin redirect_to_spec
  path now throws `HTMLParseError` with an actionable message
  instead of crashing on null IR.
- (W34) `lib/diff/compare.js` adds the missing
  `response_example_only_changed` change category (patch-impact)
  with subsumption when schema also changed.
- (W32) Postman `_walkItems` recursion guarded by
  `MAX_FOLDER_DEPTH = 100`; variable substitution now also applies
  to `req.url.raw` / `host[]` in structured URL objects (the
  common `{{baseUrl}}` pattern).

### Codegen targets
- LIVE: ts-fetch (4A), python-requests (4B), openapi-3.1 (4C),
  go-net-http (4D).
- Planned: ts-axios (4E), python-httpx (4E); curl-shell (6+).

## [0.3.0] — 2026-05-19

### Added
- (Wave 7) **`apifier-diff` MCP tool** (6th tool). Pure-function
  comparator (`lib/diff/compare.js`) classifies the delta between
  two `apifier-mapping.json` files across 24 SemVer categories
  (endpoint add/remove/modify, param add/remove/required-toggle/
  type-change, response add/remove/schema-change/example-change,
  auth add/remove/scheme-change, model add/remove + field add/
  remove/type-change, enum value add/remove, description-only).
  Verdict cascade: `breaking>0 → major; non_breaking>0 → minor;
  patch>0 → patch; else compatible`. Endpoint identity is
  `<method> <path>`. Optional `format: "summary"` for CI-sized
  responses.
- (Wave 4C) **`openapi-3.1` codegen** (round-trip OpenAPI 3.1 YAML
  emitter). Pure-string hand-rolled YAML emitter — no `js-yaml.dump`
  call — for byte-deterministic output. Canonical key order across
  root / operation / parameter / response / schema / securityScheme.
  Round-trip property verified: scrape → mapping → emit YAML →
  re-parse via `parseOpenAPI` → identical endpoint set + 0 warnings.
- (Wave 6A) **Postman v2.1 collection ingest** (5th source format).
  Pure-JSON walker; recursive `item[]` traversal; folder hierarchy
  → `endpoint.tags[]`; `{{var}}` placeholder substitution; per-mode
  body handling (raw/JSON, urlencoded, formdata, file, none); auth
  translation (bearer/basic/apikey/oauth2). `mapping.extensions
  ["x-source-format"] = "postman"`, `x-postman-id` preserves
  original collection id.

### Codegen targets at v0.3.0
- LIVE: ts-fetch (4A), python-requests (4B), openapi-3.1 (4C).
- Planned: go-net-http (4D), ts-axios, python-httpx (4E);
  curl-shell (6+).

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

[0.5.0]: https://github.com/palginpav/apifier-orchestray-plugin/releases/tag/v0.5.0
[0.4.0]: https://github.com/palginpav/apifier-orchestray-plugin/releases/tag/v0.4.0
[0.3.0]: https://github.com/palginpav/apifier-orchestray-plugin/releases/tag/v0.3.0
[0.2.0]: https://github.com/palginpav/apifier-orchestray-plugin/releases/tag/v0.2.0
[0.1.0]: https://github.com/palginpav/apifier-orchestray-plugin/releases/tag/v0.1.0
