# APIfier — API Doc Scraper & Client Generator for Orchestray

Scrape a service's API documentation into a reusable orchestray-compatible mapping
file, then generate ready-to-import API client modules in seven different targets.
Point APIfier at almost any common API-doc shape — an **OpenAPI 3.0/3.1 spec**
(JSON or YAML), a **Postman v2.1 collection**, a **GraphQL SDL** schema, a
**rendered HTML doc site** (Stripe/Slate three-column, Docusaurus, GitBook,
Swagger UI / Redoc / Scalar / Stoplight viewers, or generic heading-based
layouts), or a **Markdown API doc** (`docs/api.md`, README sections, wiki
exports) — and it normalises it into a single portable `<service>.apifier.json`
file. From that file you can emit a typed TypeScript client (`fetch` or
`axios`), a Python client (`requests` or `httpx`), a Go `net/http` client, a
Bash `curl` ops script, or a canonical OpenAPI 3.1 YAML round-trip.

Plus two CI-focused tools: `apifier-diff` classifies the SemVer impact of a
mapping delta across 24 change categories, and `apifier-watch` composes the
fresh scrape + diff + block-decision into a single atomic call that drives a
CI gate.

## Status

**v0.5.0 — 6 source formats × 7 codegen targets × 7 MCP tools.** The full
brief surface is delivered:

- **Scrape (6 input formats)**: OpenAPI 3.0/3.1 (JSON or YAML), HTML doc sites
  (5 archetypes: Stripe/Slate, Docusaurus, GitBook, OpenAPI-rendered viewers
  like Swagger UI / Redoc, Generic), Markdown API docs, Postman v2.1
  collections, GraphQL SDL.
- **Generate (ALL 7 codegen targets live)**:
  | Target | Language | Notes | Wave |
  |---|---|---|---|
  | `ts-fetch` | TypeScript | Native `fetch` | 4A |
  | `ts-axios` | TypeScript | `axios` client | 4F |
  | `python-requests` | Python 3.8+ | `requests` sync client | 4B |
  | `python-httpx` | Python 3.8+ | `httpx` sync client | 4F |
  | `go-net-http` | Go | Stdlib `net/http` | 4D |
  | `curl-shell` | Bash 4+ | Ops scripts (`set -euo pipefail`) | 4E |
  | `openapi-3.1` | YAML | Round-trip OpenAPI 3.1 spec | 4C |
- **CI workflow**: `apifier-diff` classifies mapping deltas across 24 SemVer
  change categories; `apifier-watch` composes scrape + diff into a single
  `should_block` decision for CI gates.
- **7 MCP tools** all live: `apifier-scrape`, `apifier-list`, `apifier-generate`,
  `apifier-validate`, `apifier-doctor`, `apifier-diff`, `apifier-watch`.

## How it works

1. **Scrape** — call `apifier-scrape` with a URL, local file path, or pasted spec
   text. APIfier auto-detects the source type (or you can force it via
   `source_type`).
2. **Map** — the matching parser normalises the input into an intermediate
   representation; `lib/mapping/build.js` writes a `<service>.apifier.json` file
   to `~/.orchestray/apifier/mappings/`.
3. **Generate** — call `apifier-generate` with the mapping path and a target.
   APIfier emits a deterministic client module to the path you specify.
4. **Use** — import the generated module into your project. Re-validate the
   mapping after upstream spec changes with `apifier-validate`; no re-scrape
   needed.
5. **Gate (CI)** — call `apifier-watch` with the live source and a committed
   baseline mapping; it returns `should_block: true` when the upstream change
   exceeds your `block_on` threshold (`breaking` / `minor` / `patch` / `none`).

## Install

APIfier is published to npm as
[`apifier-orchestray-plugin`](https://www.npmjs.com/package/apifier-orchestray-plugin).

**Via orchestray plugin manager (recommended):**

```sh
orchestray plugin add apifier-orchestray-plugin
# orchestray prompts to approve the plugin and reload the server
```

After approval, reload: `orchestray reload` (or restart Claude Code). APIfier's
7 MCP tools become available in the PM immediately.

**Local install for development:**

```sh
git clone https://github.com/palginpav/apifier-orchestray-plugin.git
cd apifier-orchestray-plugin
npm install
node bin/apifier-doctor.js     # verify 3 green checks
npm test                       # 404 tests; ~400 ms
```

Register the local clone with orchestray using
`orchestray plugin add --local <path>` per the plugin-authoring guide
(`docs/plugin-authoring-guide.md` in your orchestray install).

## Use

All tools share the `apifier-` prefix and communicate over the orchestray MCP
boundary. Invoke them via the PM or directly:

```
/orchestray:plugin invoke apifier <tool-name> '<json-args>'
```

### `apifier-scrape`

Ingest API docs from a URL, local file, or pasted spec text and write a mapping
file. Auto-detects the source type; `source_type: "auto"` is the default.

```json
{
  "source": "https://widget.example.com/openapi.json",
  "service_name": "widgets-api",
  "obey_robots_txt": true
}
```

Examples of accepted `source` values:

- `https://api.stripe.com/...` (live OpenAPI / HTML)
- `./schema.graphql` (GraphQL SDL)
- `./widgets.postman_collection.json` (Postman v2.1)
- `./docs/api.md` (Markdown)
- inline spec text (auto-sniffed against all six format heuristics)

Returns `{ output_path, endpoint_count, head_sample, warnings, source }` where
`head_sample` shows the first two endpoints for at-a-glance verification.

### `apifier-list`

List mapping files under the mappings directory. Returns metadata only — no
full mapping bodies.

```json
{ "filter": "widgets", "include_invalid": false }
```

Returns `{ mapping_count, mappings: [{ file, service_name, schema_version,
endpoint_count, source_url, fetched_at, validation_ok }], errors: [] }`.

### `apifier-generate`

Emit a language-specific client module from a mapping file.

```json
{
  "mapping_path": "~/.orchestray/apifier/mappings/widgets-api.apifier.json",
  "target": "ts-fetch",
  "out_path": "/your/project/src/widgets-client.ts"
}
```

Available targets (all LIVE as of v0.5.0):

| Target           | Status   | Wave | Output ext |
|------------------|----------|------|------------|
| `ts-fetch`       | **LIVE** | 4A   | `.ts`      |
| `ts-axios`       | **LIVE** | 4F   | `.ts`      |
| `python-requests`| **LIVE** | 4B   | `.py`      |
| `python-httpx`   | **LIVE** | 4F   | `.py`      |
| `go-net-http`    | **LIVE** | 4D   | `.go`      |
| `curl-shell`     | **LIVE** | 4E   | `.sh`      |
| `openapi-3.1`    | **LIVE** | 4C   | `.yaml`    |

All targets produce byte-deterministic output for the same input mapping
(generation timestamp comes from `source.fetched_at`, not wall-clock). Each
generated client passes its language's compile/syntax check (`node --check`,
`python3 -m py_compile`, `gofmt -e` + `go vet`, `bash -n` + `shellcheck`).

### `apifier-validate`

Re-validate a mapping file against the current schema. Useful after a
`schema_version` bump or to confirm a mapping is still well-formed.

```json
{
  "mapping_path": "~/.orchestray/apifier/mappings/widgets-api.apifier.json",
  "strict": false
}
```

Returns `{ ok, schema_version, endpoint_count, errors, warnings }`. In
`strict: true` mode, warnings are treated as errors.

### `apifier-doctor`

Health-check the plugin install. Runs 4 checks: node version, orchestray
install path, mappings directory writability, validity of every existing
mapping.

```json
{ "dir": "~/.orchestray/apifier/mappings/" }
```

Returns `{ ok, checks: [{ name, status, detail }], summary }` where each
check's `status` is `"pass" | "warn" | "fail"`. Overall `ok` is true iff no
check returned `"fail"` (warnings do not block).

### `apifier-diff`

Compare two mapping files and report the SemVer impact of the change.
Classifies every delta into one of 24 change categories (endpoint
add/remove/modify, param add/remove/type-change/required-toggle, response
add/remove/schema-change/example-change, auth add/remove/scheme-change,
model add/remove + field add/remove/type-change, enum value add/remove,
description-only).

```json
{
  "mapping_a": "/abs/path/to/baseline.apifier.json",
  "mapping_b": "/abs/path/to/candidate.apifier.json",
  "format": "structured"
}
```

Returns `{ verdict, counts, breaking, non_breaking, patch, summary }` where
`verdict` cascades: `breaking > 0 → "major"`; `non_breaking > 0 → "minor"`;
`patch > 0 → "patch"`; else `"compatible"`. Use `format: "summary"` for
CI-sized responses that omit the full change arrays.

### `apifier-watch`

Re-scrape an API doc source and diff the result against a committed baseline
mapping. Atomic operation — fresh scrape + diff + block decision in one call.
Designed for CI gates: *"block PR if upstream API changes break our pinned
baseline."*

```json
{
  "source": "https://upstream.example.com/openapi.yaml",
  "baseline_path": "/repo/api-baseline.apifier.json",
  "block_on": "breaking"
}
```

`block_on` accepts `"breaking"` (default — only major verdicts block),
`"minor"` (block on any non-`compatible` change above patch),
`"patch"` (block on any change), or `"none"` (report-only, never block).

Returns `{ verdict, counts, should_block, breaking_changes, summary,
fresh_mapping_path, baseline_summary, timing: { scrape_ms, baseline_load_ms,
diff_ms, total_ms } }`. CI exits non-zero on `should_block: true`.

## What gets produced

Mapping files are written to `~/.orchestray/apifier/mappings/` by default.
Each file follows the naming pattern `<service-name>.apifier.json` where
`service-name` is either the value you pass as `service_name` or a slug
derived from the spec's `info.title` or the source hostname.

Generated client modules default to `~/.orchestray/apifier/generated/` but you
should always pass an explicit `out_path` to place them inside your project.

The mapping file format is documented in full in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The mapping file carries
provenance fields (`source.url`, `source.sha256`, `source.fetched_at`,
`source.parser`) plus drift-detection extensions
(`mapping.extensions["x-source-format"]` — `openapi` / `html` / `markdown` /
`postman` / `graphql-sdl`; `mapping.extensions["x-html-archetype"]` when the
source was HTML).

## Architecture

APIfier is a Node.js orchestray plugin (CJS, Node ≥ 20) whose server process
speaks NDJSON JSON-RPC 2.0 over stdio. The core pipeline is: fetch via Node's
built-in `fetch` (5 MB body cap, 55 s timeout, SHA-256 + robots.txt-aware via
`lib/http/`), detect source type in `lib/handlers/scrape.js`, delegate to a
format-specific parser in `lib/parsers/`, normalise the result into a mapping
object, Zod-validate it via `lib/mapping/schema.js`, and write atomically. The
codegen path reads a mapping, dispatches to `lib/codegen/<target>.js`, and
writes the output file with the same path-guard stack used for mappings.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map and
data-flow diagram. See [ROADMAP.md](ROADMAP.md) for the wave-by-wave delivery
history.

## Prerequisites

- Orchestray ≥ 2.3.0 installed
- Node.js ≥ 20
- Claude Code with Orchestray installed

Runtime dependencies (3): `zod`, `js-yaml`, `cheerio`.

## Security

- **No sandbox.** Orchestray plugins run as unsandboxed child processes of
  Claude Code. APIfier compensates with the defences below.
- **Path-traversal defence.** All writes are validated against an allowed-roots
  list (`~/.orchestray/apifier/{mappings,generated}/`, `<cwd>/out/`,
  `<cwd>/apifier-out/`, `os.tmpdir()`). Literal `..` segments are rejected
  before any filesystem call. Symlinks are resolved via `realpath` and
  re-checked.
- **Scrape size cap.** Fetches are aborted at 5 MB; sitemap-driven crawls are
  capped at 200 pages (default 50). Per-call timeout is hard-capped at
  55 000 ms.
- **robots.txt opt-in.** `obey_robots_txt` defaults to `true`. The setting is
  recorded in `source.robots_respected` for downstream audit. 5xx robots
  responses block for politeness; 404/410 mean no robots → all-allowed.
- **Same-origin guard.** When an HTML scrape returns a `redirect_to_spec`
  signal (Swagger UI / Redoc / Scalar / etc. embedding a spec URL), APIfier
  auto-follows only same-origin URLs. Cross-origin redirects throw
  `HTMLParseError(-32008)` with an actionable hint to re-invoke with the spec
  URL directly.
- **Sitemap SSRF guard.** When expanding a `<sitemapindex>`, sub-sitemap URLs
  must share the root sitemap's origin or they are silently skipped.
- **YAML safety.** `js-yaml.load(body, { schema: jsYaml.JSON_SCHEMA })`
  forbids `!!js/function` / `!!python/*` exploit constructs that
  `DEFAULT_SCHEMA` would accept.
- **Output redaction.** Every value flowing into `error.message` or
  `summary.warnings[]` passes through `lib/output-redaction.js` which strips
  control characters, Bearer tokens, and API keys from query strings.
- **Domain error codes mapped to spec.** Internal error codes (`-32001`
  through `-32014`) are remapped to JSON-RPC `-32603` at the dispatcher with
  `data.domain_code` carrying the original — preventing domain-code leakage
  to MCP clients while preserving diagnostic traceability.

## License

MIT
