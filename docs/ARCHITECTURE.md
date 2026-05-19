# APIfier Architecture

This document is the entry point for contributors. It covers the module layout, data
flow, mapping-file schema, plugin lifecycle, extension points, and security posture.
Read it alongside the two canonical decision records:

- `.orchestray/kb/decisions/W2-architecture.md` — manifest, tool surface, module
  details, security posture.
- `.orchestray/kb/decisions/W2-mapping-schema.md` — mapping-file format, codegen
  contract, versioning rules.

---

## 1. Module map

```
apifier/
  orchestray-plugin.json     Manifest: name="apifier", 5 tools, transport=stdio
  package.json               CJS, engines.node >=20
  server.js                  NDJSON JSON-RPC 2.0 dispatcher
  lib/
    http/
      fetch.js               undici wrapper — redirect cap, byte cap, timeout, User-Agent
      robots.js              robots.txt fetch + parse (robots-parser)
    detect.js                Source-type heuristics (auto-detects from first bytes)
    parsers/
      openapi.js             @scalar/openapi-parser → IR
      postman.js             postman-collection SDK → IR
      asyncapi.js            @asyncapi/parser channels → IR
      graphql.js             SDL / introspection root fields → IR
      grpc-proto.js          protobufjs RPC methods → IR
      html.js                cheerio selector heuristics → IR
      markdown.js            remark + regex curl-example extraction → IR
    mapping/
      schema.js              Zod schema + JSON Schema export
      build.js               IR → mapping JSON with provenance
      write.js               Atomic mkdtempSync + validate + rename
      read.js                Read + parse + schema-validate
      migrate.js             schema_version N → N+1 migrations (stubs in v0.0.1)
    codegen/
      ts-fetch.js            TypeScript fetch client (stub in v0.0.1)
      openapi-3.1.js         OAS 3.1 round-trip (stub in v0.0.1)
      _registry.js           target → impl lookup; unknown targets → not_supported
    list-doctor.js           Shared scanning for apifier-list + apifier-doctor
    output-redaction.js      Strips control chars, Bearer tokens, API keys from output
    errors.js                ApifierError hierarchy (BadParamsError, FetcherError, …)
  bin/
    apifier-doctor.js        CLI health check (real in v0.0.1)
    apifier-smoke.js         Synthetic NDJSON harness for CI (planned, Wave 2)
  docs/
    ARCHITECTURE.md          This file
```

All five tools are declared in `orchestray-plugin.json` and have matching entries in
`lib/dispatcher.js`'s `TOOL_DECLS` constant (loaded from the manifest at module-init
time, so the two cannot drift). Divergence between manifest and `tools/list` response
transitions the plugin to `dead` state (plugin-authoring-guide §Lifecycle).

---

## 2. Data flow

```
URL / file / inline text
        │
        ▼
server.js — Zod-validate inputSchema
        │
        ▼
lib/http/fetch.js — robots.txt check → fetch (undici, ≤55 s, ≤5 MB)
        │
        ▼
lib/detect.js — signature heuristics → source_type
        │
        ▼
lib/parsers/<type>.js — parse(input, ctx) → IRSpec
        │
        ▼
lib/mapping/build.js — IRSpec + provenance → mapping object
        │
        ▼
lib/mapping/write.js — Zod validate → mkdtempSync → chmodSync → rename
        │
        ▼
<service>.apifier.json  (default: ~/.orchestray/apifier/mappings/)
        │
        ▼ (apifier-generate)
lib/codegen/<target>.js — mapping → client module text
        │
        ▼
out_path (explicit path inside user's project)
```

For `apifier-generate` the flow starts from the mapping file: read → validate →
dispatch to `lib/codegen/<target>.js` → write.

Large mapping bodies are never returned inline. `apifier-scrape` returns
`{ output_path, summary, warnings }` only, keeping MCP stdout well under the 1 MB
per-line cap (plugin-authoring-guide line 73).

---

## 3. Mapping-file schema

The mapping file is JSON with the `.apifier.json` extension. The full schema is
specified in `.orchestray/kb/decisions/W2-mapping-schema.md`. Key points:

**Top-level shape:**
```json
{
  "schema_version": 1,
  "apifier_version": "0.0.1",
  "kind": "apifier-mapping",
  "service":   { "name": "...", "version": "..." },
  "source":    { "type": "openapi", "url": "...", "sha256": "...", ... },
  "auth":      [ { "id": "bearer-jwt", "type": "http-bearer", ... } ],
  "servers":   [ { "url": "https://...", "description": "production" } ],
  "endpoints": [ { "id": "createWidget", "transport": "http", "method": "POST", ... } ],
  "models":    [ { "name": "Widget", "kind": "object", "fields": [...] } ],
  "errors":    [ { "code": "WIDGET_NOT_FOUND", "status": 404, ... } ],
  "examples":  [ { "name": "...", "endpoint": "...", "language": "curl", ... } ],
  "extensions": {}
}
```

**Canonicalisation:** endpoints sorted by `(transport, method, path)`, models by
`name`, errors by `(scope, status, code)`. 2-space JSON, UTF-8, trailing newline.
Same upstream spec + same plugin version always produces byte-identical output.

**Worked example** (two endpoints, JWT auth, one model, one error): see
`.orchestray/kb/decisions/W2-mapping-schema.md §7`.

**Versioning:** `schema_version: 1` is locked. Additive changes (new optional fields)
are allowed within v1. Breaking changes require `schema_version: 2` and a
`lib/mapping/migrate.js` entry.

---

## 4. Plugin lifecycle states

Orchestray tracks each plugin through states defined in the plugin-authoring guide.
APIfier's behaviour in each:

| State | Trigger | APIfier behaviour |
|-------|---------|-------------------|
| `loading` | Orchestray spawns `server.js`, sends `initialize` | Returns `serverInfo.name="apifier"`, protocol `2025-03-26` |
| `ready` | `tools/list` response matches manifest | Normal tool dispatch |
| `dead` | `tools/list` diverges from manifest, or init fails | Orchestray stops routing calls; server exits |
| `error` | Tool handler throws unhandled exception | `ApifierError` (-32603) returned; plugin stays running |

The `TOOL_DECLS` constant in `lib/dispatcher.js` is loaded from
`orchestray-plugin.json` at module-init time, so the manifest is the single source of
truth and `tools/list` cannot drift from it.

Unknown methods return `{"error":{"code":-32601,...}}` per the MCP spec (plugin-
authoring-guide line 195).

---

## 5. Extension points

### Adding a new parser

1. Create `lib/parsers/<format>.js` exporting:
   ```js
   async function parse(input, ctx) { /* returns IRSpec */ }
   module.exports = { parse };
   ```
2. Add the format as an enum value in the `source_type` field of `apifier-scrape`'s
   inputSchema (in `orchestray-plugin.json` — `lib/dispatcher.js` re-reads the manifest).
3. Add a detection branch in `lib/detect.js`.
4. Add a fixture test in `tests/parsers/<format>.test.js`.

The `IRSpec` shape is the mapping object minus the `source` provenance fields — parsers
return the semantic content; `lib/mapping/build.js` adds provenance.

### Adding a new codegen target

1. Create `lib/codegen/<target>.js` exporting:
   ```js
   async function generate(mapping, opts) { return { text, ext }; }
   module.exports = { generate };
   ```
   The module MUST be byte-deterministic — no `Date.now()` or random values in output
   (except the generated-on timestamp via an injectable `now` parameter for tests).
2. Register the target in `lib/codegen/_registry.js`.
3. Add the target enum value to `apifier-generate.target` inputSchema.
4. Add a round-trip test using the widgets worked example.

The cross-language contract (module shape, auth helpers, error hierarchy, init comment)
is specified in `.orchestray/kb/decisions/W2-mapping-schema.md §5`.

### Adding a new auth scheme

1. Add a new `type` value to the auth scheme's `type` enum in `lib/mapping/schema.js`.
2. Update any parser that can emit that scheme type.
3. Update codegen targets to emit the corresponding auth-helper method.
4. Because `schema_version: 1` is additive-compatible, a new optional `type` value
   does not require a schema_version bump — existing consumers must ignore unknown
   `type` values and emit a warning rather than fail.

---

## 6. Security posture

APIfier runs as an unsandboxed child process (no OS sandbox from orchestray). Its
defences are internal:

**Path traversal (`lib/mapping/write.js`):**
- Reject literal `..` segments before any FS call.
- `path.resolve()` to absolute form; compare against allowed-roots list:
  `~/.orchestray/apifier/mappings/`, `~/.orchestray/apifier/generated/`,
  `<cwd>/out/`, `<cwd>/apifier-out/`, `os.tmpdir()`.
- `fs.realpathSync()` to resolve symlinks; re-check against roots.
- Atomic write: `mkdtempSync(...'.apifier-tmp-')` + `chmodSync(0o700)` + file mode
  `0o600` + `rename` into place. Temp dir is unlinked on any failure path.

**Output redaction (`lib/output-redaction.js`):**
Applied to every `error.message` and `summary.warnings[]` value:
- ASCII control chars (< 0x20, except tab/LF/CR) → `?`.
- `Bearer <token>` patterns → `Bearer <REDACTED>`.
- Query-string API keys (32+ char alphanum before `=` after `?`/`&`) → `<REDACTED>`.

**Scrape caps:**
- Fetch byte cap: 5 MB.
- Per-call timeout: 55 000 ms max (5 s under the orchestray 60 s hard limit).
- Crawl page cap: 200 max (default 50).
- Concurrency: max 4 parallel page fetches.

**robots.txt:** `obey_robots_txt` defaults to `true`. Recorded in
`source.robots_respected` for audit. If `robots.txt` is unreachable, treat as
fully-allowed (de-facto web standard).

**Env-strip:** APIfier does not read `process.env` directly. `os.homedir()` is used
instead of `process.env.HOME`. Any future env-var dependency must be declared in the
manifest's `capabilities` block.

**No eval:** Playwright is supported for `render_js=true` but the plugin code never
`eval`s content from the scraped page.

---

## 7. v0.0.1 status — what is real vs stub

| Module | Status | Arrives in |
|--------|--------|------------|
| `server.js` dispatcher | Real (skeleton — `initialize` / `tools/list` / `tools/call` only) | Wave 1 |
| `lib/dispatcher.js` | Real (pure dispatch function with stub tool handlers) | Wave 1 |
| `lib/errors.js` | Real (JSON-RPC error helpers) | Wave 1 |
| `lib/registry.js` | Real (`getMappingDir()` only — full CRUD in Wave 3) | Wave 1 |
| `bin/apifier-doctor.js` | Real (CLI health check) | Wave 1 |
| `lib/output-redaction.js` | Not created yet | Wave 2 |
| `lib/mapping/write.js` (path-traversal stack) | Not created yet | Wave 3 |
| `lib/mapping/schema.js` (Zod schema) | Not created yet | Wave 3 |
| `lib/http/fetch.js` | Not created yet | Wave 2 |
| `lib/http/robots.js` | Not created yet | Wave 2 |
| `lib/detect.js` | Not created yet | Wave 2 |
| `lib/parsers/*.js` | Not created yet | Wave 2 |
| `lib/mapping/build.js` | Not created yet | Wave 3 |
| `lib/mapping/read.js` + `migrate.js` | Not created yet | Wave 3 |
| `lib/codegen/ts-fetch.js` | Not created yet | Wave 4 |
| `lib/codegen/openapi-3.1.js` | Not created yet | Wave 4 |

See [ROADMAP.md](../ROADMAP.md) for the full wave-by-wave plan and the open questions
that must be answered before Wave 2 starts.
