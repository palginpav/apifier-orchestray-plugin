# Changelog
All notable changes to this project will be documented in this file.
The format is based on Keep a Changelog (https://keepachangelog.com/en/1.1.0/).

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

[0.1.0]: https://github.com/palginpav/apifier-orchestray-plugin/releases/tag/v0.1.0
