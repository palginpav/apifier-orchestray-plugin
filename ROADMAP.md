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

## Wave 2 — Doc Scraper

**Goal:** `apifier-scrape` produces real mapping files from live and local API docs.

**Agent mix:** coder (primary), tester.

**Decomposition:**
- Implement `lib/http/fetch.js` (undici wrapper: redirect cap, byte cap, timeout,
  User-Agent).
- Implement `lib/http/robots.js` (robots-parser integration).
- Implement `lib/detect.js` (signature heuristics for all source_type enum values).
- Implement each parser in `lib/parsers/`:
  - `openapi.js` — `@scalar/openapi-parser` dereference → IR.
  - `postman.js` — `postman-collection` SDK → IR.
  - `asyncapi.js` — `@asyncapi/parser` channels → IR.
  - `graphql.js` — SDL / introspection root fields → IR.
  - `grpc-proto.js` — `protobufjs` RPC methods → IR.
  - `html.js` — `cheerio` selector heuristics → IR.
  - `markdown.js` — `remark` + regex curl-example extraction → IR.
- Implement `lib/parsers/sitemap-crawler.js` for sitemap-guided HTML crawls.
- Wire parsers into the `apifier-scrape` tool handler (replace stub).
- Unit tests: one canonical fixture per parser, one path-traversal test per write path.

**Requires answers to open questions 1, 3, 5** (see below).

---

## Wave 3 — Mapping-File Producer

**Goal:** `lib/mapping/build.js`, `write.js`, and `read.js` produce schema-valid,
byte-stable mapping files from Wave 2's parsed IR.

**Agent mix:** coder (primary), tester.

**Decomposition:**
- Implement `lib/mapping/schema.js` — Zod schema compiled from the W2 mapping-schema
  decision; also exports a JSON Schema for external tools.
- Implement `lib/mapping/build.js` — IR → mapping JSON with provenance fields
  (`source.sha256`, `source.fetched_at`, `source.parser`).
- Implement `lib/mapping/write.js` — atomic `mkdtempSync` + Zod validate + `rename`;
  full path-traversal stack.
- Implement `lib/mapping/read.js` — read, JSON-parse, schema-validate.
- Implement `lib/mapping/migrate.js` stubs — one no-op entry for v1 → v1 (real
  migrations ship when schema_version bumps).
- Integration test: fixture HTTP server → `apifier-scrape` → mapping on disk →
  `apifier-validate` passes → `apifier-list` surfaces it → `apifier-doctor` ok.

**Requires answer to open question 4** (GraphQL endpoint identity model).

---

## Wave 4 — Language Code-Generators

**Goal:** `apifier-generate` with `target=ts-fetch` produces a usable, typed TypeScript
client; `target=openapi-3.1` round-trips a clean OAS 3.1 YAML from any mapping.

**Agent mix:** coder (primary), tester.

**Decomposition:**
- Implement `lib/codegen/ts-fetch.js` — emits a single `.ts` file:
  - Type aliases for every `models[]` entry.
  - `<ServiceName>Client` class with one async method per endpoint.
  - Auth-helper methods (`setBearerToken`, `setApiKey`, etc.) based on `auth[]`.
  - Error class hierarchy per `W2-mapping-schema.md` §5.4.
  - Init-guide header comment (§5.3).
  - Byte-deterministic output (endpoints sorted by canonical order).
- Implement `lib/codegen/openapi-3.1.js` — emit OAS 3.1 YAML from mapping.
- Update `lib/codegen/_registry.js` — register the two real targets; all others remain
  `not_supported`.
- Document how to add a new language target: implement `lib/codegen/<target>.js`
  exporting `async function generate(mapping, opts) → { text, ext }`, register it in
  `_registry.js`, add an enum value to `apifier-generate.target` inputSchema.
- Unit tests: ts-fetch round-trip of the widgets worked example from
  `W2-mapping-schema.md §7`.

**Requires answer to open question 2** (codegen target priority confirmation).

---

## Wave 5 — Packaging & Marketplace

**Goal:** the plugin is published to npm and listable in the orchestray marketplace.

**Agent mix:** coder, documenter.

**Decomposition:**
- Finalise `package.json` (name, description, keywords, files, bin, engines).
- Write `CHANGELOG.md` with v0.1.0 entry.
- `npm publish` to the public registry.
- Submit marketplace listing once the orchestray marketplace accepts community plugins.
- Plugin signing — when orchestray supports it, sign the package and record the
  signing key in the manifest's `capabilities` block.
- Manual smoke tests against real-world targets: Stripe OpenAPI export, GitHub REST
  OpenAPI, GitLab OpenAPI, Postman public workspaces.

---

## Wave 6+ — Advanced Capabilities

Ideas for future waves; none are committed:

- **Auth-flow walker** — detect login forms and token endpoints; guide the user through
  fetching a session token before scraping auth-gated docs.
- **OAuth helper** — integrate with orchestray's credential store to cache tokens across
  scrape sessions.
- **Change-detection diffing** — re-scrape a service, diff the new mapping against the
  committed one, and surface added/removed/changed endpoints in a human-readable report.
- **Python requests-client codegen** — `lib/codegen/python-requests.js`.
- **Go net/http codegen** — `lib/codegen/go-net-http.js`.
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
