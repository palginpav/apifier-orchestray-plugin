# APIfier Roadmap

Each wave maps to one `/orchestray:run` invocation. Wave 1 is this orchestration.
Subsequent waves can be started once the open questions at the end of this file are
answered.

---

## Wave 1 — Foundation (DONE)

**Goal:** establish a working, installable plugin with a defined manifest, stub tool
handlers, and complete documentation.

**Agent mix:** architect (W2), coder (W3), documenter (W4), tester (W5).

**Decomposition:**
- Research viable libraries for every doc format (W1).
- Lock manifest, tool surface, module layout, mapping schema (W2).
- Scaffold `server.js`, stub all 5 tools, error taxonomy, path-traversal checks,
  output-redaction module (W3).
- Write README, ROADMAP, ARCHITECTURE docs (W4 — this wave).
- Write unit tests for stubs and a smoke-test harness (W5).

---

## Wave 2A — OpenAPI Vertical Slice (DONE)

**Commit:** `f7f7916` (bundled with Wave 1 scaffold) through `3953cda`

End-to-end OpenAPI 3.0/3.1 ingest: `apifier-scrape` → mapping on disk →
`apifier-validate`. Mapping schema v1 with provenance, canonical byte-stable
writer, no-throw reader.

---

## Wave 2B — YAML + list + doctor (DONE)

**Commits:** `3953cda` feat, `3c9b136` fix nits

YAML support in `apifier-scrape` via js-yaml (safe-mode JSON_SCHEMA).
`apifier-list` and `apifier-doctor` MCP tools — no longer stubs.

---

## Wave 2C — robots.txt + sitemap (DONE)

**Commits:** `462887c` feat, `616968f` fix nits

robots.txt enforcement (`lib/http/robots.js`) + sitemap.xml crawler
(`lib/http/sitemap.js`) with sitemap-index expansion. Same-origin guard;
5 MB body cap; in-memory origin cache.

---

## Wave 2D — HTML doc-site parser (DONE)

**Commits:** `ce563cb` (architect design), `439dfc1` (impl), `da7c66d` (nits)

`lib/parsers/html.js` with `cheerio` + 5 strategy modules covering OpenAPI-rendered
SPA viewers (Swagger UI / Redoc / Scalar / Stoplight / RapiDoc) with same-origin
`redirect_to_spec` auto-follow, Stripe/Slate three-column layouts, Docusaurus,
GitBook, and a generic last-resort heading heuristic.
`mapping.extensions["x-html-archetype"]` records the detected strategy.

## Wave 2E — Markdown doc parser (DONE)

**Commits:** `dfda308` (impl), `090a01c` (nits)

`lib/parsers/markdown.js` — pure-regex Markdown parser, no external deps. Three
endpoint-detection patterns (heading w/ METHOD path, backticked heading, bare line
in fenced block). Path/query params from Markdown tables. Body + response examples
from JSON code blocks. Auth detection from top-level Authentication / API Keys
sections. `mapping.extensions["x-source-format"] = "markdown"` for drift detection.

---

## Wave 4A — ts-fetch codegen (DONE)

**Commits:** `5de226f` feat, `cd43194` fix nits

`apifier-generate` with `target=ts-fetch` produces a byte-deterministic TypeScript
fetch-based client. Type aliases, `<ServiceName>Client` class, auth helpers.

---

## Wave 4B — python-requests codegen (DONE)

**Commits:** `1f73f67` feat, `5197344` fix nits, `65b6ad4` chore

`apifier-generate` with `target=python-requests` emits Python 3.8+ requests-based
client. Byte-deterministic; py_compile clean.

---

## Wave 4C — openapi-3.1 round-trip codegen (DONE)

**Commits:** `357bb8c` feat, `cfb8d59` fix nits, `1fe8331` chore (-275 LOC).

Hand-rolled byte-deterministic YAML emitter; round-trip property verified
(scrape → mapping → emit OAS 3.1 → re-parse via `parseOpenAPI` → identical
endpoint set, 0 warnings). Non-HTTP transport endpoints (graphql/grpc/ws/etc.)
surfaced in header warnings. Parameter defaults serialised in `_emitSchema`.

---

## Wave 4D — go-net-http codegen (DONE — 3rd language ecosystem)

**Commits:** `49d75b8` feat, `e31d6a8` fix nits.

Go stdlib `net/http` client generator. Validated by both `gofmt -e` AND
`go vet ./...` on every shipped output. Per-endpoint args struct (Go has no
kwargs); auth helpers (Set{Bearer,ApiKey,Basic}Auth); context-aware methods;
unused-import tracking; api-key with `in:'query'` correctly appends to URL.

---

## Wave 4E — Remaining codegen targets (OPEN)

Planned: `ts-axios` (axios variant of ts-fetch), `python-httpx` (httpx variant
of python-requests), `curl-shell` (shell scripts for ops use; Wave 4E moves
from 6+ to 4E per the v0.4.0 plan). Each implements
`lib/codegen/<target>.js` exporting `generate(mapping, opts) → { text, ext }`,
registered in `_registry.js`.

---

## Wave 5 — Packaging & Marketplace (DONE)

**Commits:** `79b496b` feat (publish prep + Petstore smoke), plus W19 follow-up nit fixes.

`package.json` v0.1.0 with full publish metadata, `CHANGELOG.md`, README + ROADMAP
refreshed, real-world Petstore integration smoke test. `npm publish` and
orchestray-marketplace submission remain manual steps for the maintainer.

## Wave 5.1 — v0.2.0 Consolidation + Real-world Fixture Tests (DONE)

v0.2.0 release: bumped `package.json` + `orchestray-plugin.json` to `0.2.0`.
CHANGELOG updated with Waves 2D + 2E delta. README + ROADMAP refreshed to reflect
HTML + Markdown support. Three real-world-style fixtures (Petstore YAML,
Stripe-style HTML, GitHub-style Markdown) and a new integration test
(`tests/integration/real-world-formats.test.js`) round-trip each through
scrape → validate → ts-fetch + python-requests codegen.

---

## Wave 5.3 — v0.4.0 Consolidation (DONE)

CHANGELOG entries for [0.3.0] (apifier-diff + openapi-3.1 + Postman) and
[0.4.0] (apifier-watch + GraphQL SDL + go-net-http) backfilled. ROADMAP
refreshed to mark Waves 4C / 4D / 6A / 6B / 7 / 8 DONE with commit refs.
Wave 4E (`ts-axios`, `python-httpx`, `curl-shell`) carried forward as the
remaining codegen work.

---

## Wave 6A — Postman v2.1 collection ingest (DONE — 5th source format)

**Commits:** `1733fd0` feat, `8890423` fix nits.

Pure-JSON walker; recursive `item[]`; folder hierarchy → `endpoint.tags[]`;
{{var}} substitution applies to both string-form `req.url` AND structured
URL objects (`raw`/`host[]`/`path[]`/`protocol`); per-mode body handling
(raw/JSON, urlencoded, formdata, file, none); auth translation. Recursion
guarded by `MAX_FOLDER_DEPTH = 100`. `mapping.extensions['x-source-format']
= 'postman'`, `x-postman-id` preserves the original collection id.

---

## Wave 6B — GraphQL SDL ingest (DONE — 6th source format)

**Commits:** `ab883ae` feat, `5f01ec3` fix nits.

Hand-rolled pure-JS SDL parser (no `graphql-js` dep). Each root field from
`type Query` / `Mutation` / `Subscription` (or the explicit `schema { ... }`
block rebound names) becomes an endpoint with `transport: "graphql"`.
`@deprecated(reason: "...")` directive flows to endpoint deprecation. Models
cover types / inputs / interfaces / unions / enums / scalars. Union
member-fields preserved (W36 regression-fixed). ReDoS-safe (64 KB body in
~2 ms).

---

## Wave 7 — apifier-diff MCP tool (DONE — 6th tool, v0.3.0)

**Commits:** `f63d50e` feat, `23d1df9` fix nits.

Pure-function `compareMapping(a, b) → ChangeReport` covering all 24 SemVer
change categories (endpoint / param / response / auth / model / enum /
description). Verdict cascade `breaking>0 → major; non_breaking>0 → minor;
patch>0 → patch; else compatible`. `format: "summary"` option for CI-sized
responses. Manifest version 0.2.0 → 0.3.0.

---

## Wave 8 — apifier-watch MCP tool (DONE — 7th tool, v0.4.0)

**Commits:** `29225fe` feat, `a3b853e` fix nits.

Composes apifier-scrape + apifier-diff into one atomic call returning
`should_block: boolean` for CI gates. Configurable `block_on` threshold
(`breaking` / `minor` / `patch` / `none`). Timing buckets: `scrape_ms`,
`baseline_load_ms`, `diff_ms`, `total_ms` (sum within ±1 ms rounding).
Manifest version 0.3.0 → 0.4.0. Path-guard on baseline_path; WatchError
(-32014) on phase-tagged failures.

---

## Wave 6+ — Advanced Capabilities

Ideas for future waves; none are committed:

- **Auth-flow walker** — detect login forms and token endpoints; guide the user through
  fetching a session token before scraping auth-gated docs.
- **OAuth helper** — integrate with orchestray's credential store to cache tokens across
  scrape sessions.
- **Change-detection diffing** — re-scrape a service, diff the new mapping against the
  committed one, and surface added/removed/changed endpoints in a human-readable report.
- **Go net/http codegen** — `lib/codegen/go-net-http.js`.
- **curl-shell codegen** — `lib/codegen/curl-shell.js`.
- **Postman collection export** — emit a Postman 2.1 collection from a mapping.

---

## Open Questions (answer before Wave 2)

The architect raised these in `.orchestray/kb/decisions/W2-architecture.md §5`. Each
Wave that depends on the answer is noted.

1. **Playwright as optional vs hard dependency.** Recommendation: declare as
   `optionalDependencies`; return a structured error with install instructions when
   `render_js=true` and the import fails. Needs user confirmation. _(affects Wave 2)_

2. **Codegen target priority.** Recommendation: implement `ts-fetch` first, then
   `openapi-3.1`, then `python-requests`. Needs product sign-off. _(affects Wave 4)_

3. **AsyncAPI and gRPC in the IR.** The schema models non-HTTP transports as endpoints
   with `transport ∈ {ws, kafka, mqtt, grpc}`. Alternative: mark v0.0.1 as HTTP-only and
   defer. Needs confirmation. _(affects Wave 2 + Wave 3)_

4. **GraphQL endpoint identity.** Each root field (query/mutation/subscription) is
   treated as an endpoint with `transport: "graphql"` and `path: "/<graphql-endpoint>"`.
   Needs confirmation. _(affects Wave 3)_

5. **Robots.txt and auth-gated docs.** Recommendation: return an explicit `not supported`
   error on 401/403 with a hint to download the spec locally. Needs user sign-off.
   _(affects Wave 2)_

6. **Inline mapping body in `apifier-scrape` response.** Currently returns `output_path`
   only (stdout cap). A short `head` sample (first 2 endpoints) could improve agent-loop
   UX. Open. _(affects Wave 2 UX)_
