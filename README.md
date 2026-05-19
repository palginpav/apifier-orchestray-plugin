# APIfier — API Doc Scraper & Client Generator for Orchestray

Scrape a service's API documentation into a reusable orchestray-compatible mapping
file, then generate ready-to-import API client modules in multiple languages. Point
APIfier at an **OpenAPI 3.0 or 3.1 spec** (JSON or YAML; URL, local file, or inline
text), an **HTML doc site** (Stripe/Slate three-column, Docusaurus, GitBook, or
generic heading-based layouts), or a **Markdown API doc** (`docs/api.md`, README
sections, wiki exports) and it normalises it into a single portable
`<service>.apifier.json` file. From that file you can emit a typed TypeScript `fetch`
client or a Python `requests` client without scraping the service again.

Additional source formats — Postman collections, AsyncAPI, GraphQL schemas, gRPC
`.proto` files — are planned for future waves. See
[ROADMAP.md](ROADMAP.md) for the full plan.

## Status

**v0.2.0 — adds HTML doc-site scraping (5 archetypes) and Markdown ingestion alongside
the existing OpenAPI JSON/YAML support. ts-fetch + python-requests codegen targets
remain live.**
All 5 MCP tools are real: `apifier-scrape` ingests OpenAPI 3.0/3.1 (JSON or YAML),
HTML doc sites (Stripe/Slate, Docusaurus, GitBook, generic), and Markdown API docs,
`apifier-generate` emits typed TypeScript fetch clients and Python requests clients,
`apifier-validate` / `apifier-list` / `apifier-doctor` are fully operational.
See [ROADMAP.md](ROADMAP.md) for planned targets (ts-axios, python-httpx, openapi-3.1).

## How it works

1. **Scrape** — call `apifier-scrape` with a URL, local file path, or pasted spec
   text. APIfier auto-detects the source type and fetches it.
2. **Map** — the matching parser normalises the input into an intermediate
   representation; `lib/mapping/build.js` writes a `<service>.apifier.json` file to
   `~/.orchestray/apifier/mappings/`.
3. **Generate** — call `apifier-generate` with the mapping path and a target language.
   APIfier emits a typed client module to the path you specify.
4. **Use** — import the generated module into your project. Re-validate the mapping
   after upstream spec changes with `apifier-validate`; no re-scrape needed.

## Install

APIfier is published to npm as `apifier-orchestray-plugin`.

**Via orchestray plugin manager (recommended):**

```sh
orchestray plugin add apifier-orchestray-plugin
# orchestray will prompt to approve the plugin and reload the server
```

After approval, reload: `orchestray reload` (or restart Claude Code). APIfier's 5 MCP
tools become available in the PM immediately.

**Local install for development:**

```sh
git clone https://github.com/palginpav/apifier-orchestray-plugin.git
npm install
node bin/apifier-doctor.js   # verify 3 green checks
```

Register the local clone with orchestray using `orchestray plugin add --local <path>`
per the plugin-authoring guide (`docs/plugin-authoring-guide.md` in your orchestray
install).

## Use

All tools share the `apifier-` prefix and communicate over the orchestray MCP boundary.
Invoke them via the PM or directly:

```
/orchestray:plugin invoke apifier <tool-name> '<json-args>'
```

### `apifier-scrape`

Ingest API docs from a URL, local file, or pasted spec text and write a mapping file.

```json
{
  "source": "https://widget.example.com/openapi.json",
  "service_name": "widgets-api",
  "obey_robots_txt": true
}
```

Returns `{ output_path, summary, warnings }`. The mapping is written to
`~/.orchestray/apifier/mappings/widgets-api.apifier.json`.

### `apifier-list`

List mapping files under the mappings directory. Returns metadata only — no full
mapping bodies.

```json
{ "filter": "widgets" }
```

Returns an array of `{ service_name, version, schema_version, endpoint_count, file_path }`.

### `apifier-generate`

Emit a language-specific client module from a mapping file.

```json
{
  "mapping_path": "~/.orchestray/apifier/mappings/widgets-api.apifier.json",
  "target": "ts-fetch",
  "out_path": "/your/project/src/widgets-client.ts"
}
```

Available targets:

| Target           | Status   | Wave |
|------------------|----------|------|
| `ts-fetch`       | **LIVE** | 4A   |
| `python-requests`| **LIVE** | 4B   |
| `ts-axios`       | planned  | 4C   |
| `python-httpx`   | planned  | 4C   |
| `openapi-3.1`    | planned  | 4C   |
| `go-net-http`    | planned  | 6+   |
| `curl-shell`     | planned  | 6+   |

### `apifier-validate`

Re-validate a mapping file against the current schema. Useful after a
`schema_version` bump without re-scraping.

```json
{
  "mapping_path": "~/.orchestray/apifier/mappings/widgets-api.apifier.json",
  "strict": false
}
```

Returns `{ status, errors[], warnings[] }`.

### `apifier-doctor`

Health-check the plugin install: node version, required modules, mappings directory
writability, and schema-validity of every existing mapping.

```json
{ "dir": "~/.orchestray/apifier/mappings/" }
```

Returns `{ ok: boolean, results: [{ check, ok, detail }] }`.

## What gets produced

Mapping files are written to `~/.orchestray/apifier/mappings/` by default. Each file
follows the naming pattern `<service-name>.apifier.json` where `service-name` is either
the value you pass as `service_name` or a slug derived from the spec's `info.title` or
the source hostname.

Generated client modules default to `~/.orchestray/apifier/generated/` but you should
always pass an explicit `out_path` to place them inside your project.

The mapping file format is documented in full in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the canonical schema decision at
`.orchestray/kb/decisions/W2-mapping-schema.md`.

## Architecture

APIfier is a Node.js orchestray plugin (CJS, Node >= 20) whose server process speaks
NDJSON JSON-RPC 2.0 over stdio. The core pipeline is: fetch via an `undici` wrapper,
detect source type, delegate to a format-specific parser in `lib/parsers/`, normalise
the result into a mapping object, Zod-validate it, and write atomically. The codegen
path reads a mapping, dispatches to `lib/codegen/<target>.js`, and writes the output
file. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map and
data-flow diagram.

## Prerequisites

- Orchestray >= 2.3.0 installed
- Node.js >= 20
- Claude Code with Orchestray installed

## Security

- **No sandbox.** Orchestray plugins run as unsandboxed child processes of Claude Code.
  APIfier compensates with the defences below.
- **Path-traversal defence.** All writes are validated against an allowed-roots list
  (`~/.orchestray/apifier/mappings/`, `~/.orchestray/apifier/generated/`,
  `<cwd>/out/`, `<cwd>/apifier-out/`). Literal `..` segments are rejected before any
  filesystem call. Symlinks are resolved and re-checked.
- **Scrape size cap.** Fetches are aborted at 5 MB; crawls are capped at 200 pages
  (default 50). Per-call timeout is hard-capped at 55 000 ms.
- **robots.txt opt-in.** `obey_robots_txt` defaults to `true`. The setting is recorded
  in `source.robots_respected` for downstream audit.
- **Output redaction.** Every value flowing into `error.message` or `summary.warnings[]`
  passes through `lib/output-redaction.js` which strips control characters, Bearer
  tokens, and API keys from query strings.

## License

MIT
