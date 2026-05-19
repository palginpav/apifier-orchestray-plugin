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

## Wave 2D — HTML + Markdown parsers (OPEN)

`lib/parsers/html.js` (cheerio selector heuristics) and `lib/parsers/markdown.js`
(remark + regex curl-example extraction). Blocked on confirming Playwright as
optional dependency (open question 1).

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

## Wave 4C — Additional codegen targets (OPEN)

Planned targets: `ts-axios`, `python-httpx`, `openapi-3.1`. Implement
`lib/codegen/<target>.js` exporting `generate(mapping, opts) → { text, ext }`,
register in `_registry.js`.

---

## Wave 5 — Packaging & Marketplace (DONE)

**Commits:** `79b496b` feat (publish prep + Petstore smoke), plus W19 follow-up nit fixes.

`package.json` v0.1.0 with full publish metadata, `CHANGELOG.md`, README + ROADMAP
refreshed, real-world Petstore integration smoke test. `npm publish` and
orchestray-marketplace submission remain manual steps for the maintainer.

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
