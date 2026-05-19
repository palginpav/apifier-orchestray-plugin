---
id: W20-html-parser-strategy
bucket: decisions
path: decisions/W20-html-parser-strategy.md
topic: html-doc-site-parser-strategy
author: architect
task: W20
orchestration_id: orch-2026-05-19T10-44-00Z
---

# Decision: HTML Doc-Site Parser Strategy (Wave 2D-1)

**Status:** Accepted (W20). Locks v0.x HTML parser design; implementation deliverable
for Wave 2D-2. Ships as `lib/parsers/html.js` plus `lib/parsers/html-strategies/`. No
code in this document.

**Companion to:** `.orchestray/kb/decisions/W2-architecture.md`,
`.orchestray/kb/decisions/W2-mapping-schema.md`.

**Pattern check:** `mcp__orchestray__pattern_find` not invoked — worktree has no pattern
registry yet (see `.orchestray/state/context-telemetry.json`). Design mirrors the
in-repo precedent `lib/parsers/openapi.js`.

---

## 1. Problem statement

**Today.** `lib/handlers/scrape.js` line 77 unconditionally calls `parseOpenAPI` on
every fetched body. That parser (`lib/parsers/openapi.js` lines 403-505) handles
OpenAPI 3.x JSON/YAML and Swagger 2.0 best-effort. Everything else — Stripe, GitBook,
Docusaurus, Swagger-UI shells, Redoc/Scalar/Stoplight viewers — fails at
`_parseDocBody` (lines 376-392) with `OpenAPIParseError`. The manifest at
`orchestray-plugin.json` line 25 already declares `source_type: "html"`, but no parser
exists. W20 closes that gap.

**Why heuristic cheerio, not Playwright.** Locked Q1 in `W2-architecture.md` §5 item 1
defers Playwright for v0.x. Most target shapes render endpoint info into static HTML
(Stripe anchors, Slate three-column, GitBook prose, pre-rendered Docusaurus). For pure
SPA viewers (Swagger UI, Redoc, Scalar) the spec URL is embedded in static markup and
discovered with a selector — we recurse into the OpenAPI parser without a browser.
Heuristic extraction keeps install size small (cheerio ~3 MB vs Playwright + Chromium
~300 MB), latency well under the 60 s MCP cap
(`/home/palgin/orchestray/docs/plugin-authoring-guide.md` line 75; cheerio parses 1 MB
in <100 ms), and dependencies pure-JS — matching `W2-architecture.md` §1.2. Confidence
emitted per extraction (§7) makes the heuristic nature explicit.

---

## 2. Doc-site archetypes

For each: markup cues, owning strategy module (§5), confidence, expected endpoint
hit-rate.

| # | Archetype | Cues | Strategy | Confidence | Hit-rate |
|---|---|---|---|---|---|
| 2.1 | **OpenAPI-rendered SPA** (Swagger UI, Redoc, Scalar, Stoplight, RapiDoc) | `SwaggerUIBundle({url:...})`, `<redoc spec-url>`, `<elements-api apiDescriptionUrl>`, `<rapi-doc spec-url>`, `data-configuration='{"spec":{"url":...}}'` | `openapi-rendered.js` | high | ~95% (redirects to spec) |
| 2.2 | **Stripe / Slate three-column** | `<h2>POST /path</h2>` or `<span class="http-method">POST</span><code class="path">/v1/charges</code>`; `<table>` with header `/parameter\|name\|type/i`; `<pre><code class="language-shell\|json">` | `stripe-slate.js` | high → medium | ~80% endpoints, ~70% params |
| 2.3 | **GitBook** | `<div data-gitbook-component>` with hashed classnames; semantic `<h2>POST /...`; `<pre><code class="lang-bash">` | `gitbook.js` | medium | ~60% |
| 2.4 | **Docusaurus** (esp. `docusaurus-plugin-openapi-docs`) | body class `theme-doc-*`; `<div class="openapi__method-endpoint"><span class="openapi__method-badge">POST</span><code>/widgets</code></div>`; `<table class="openapi-tabs__schema-table">` | `docusaurus.js` | medium-high (w/ plugin) | ~80% |
| 2.5 | **GitHub Pages / Jekyll / Hugo / MkDocs** | generic `<h2>POST /...` regex; fenced code blocks; no distinct generator signal | `generic.js` | low | ~50% |
| 2.6 | **README single page** | rendered Markdown; same as §2.5 | `generic.js` | low | ~40% |

**§2.1 expanded selectors** (load-bearing for redirect signal):
- Swagger UI: `<script>` text matching `SwaggerUIBundle\s*\(\s*\{[^}]*url\s*:\s*['"]([^'"]+)`.
- Redoc: `<redoc spec-url="X">` attribute OR `<script>Redoc\.init\s*\(\s*['"]([^'"]+)`.
- Scalar: `<script id="api-reference" data-url="X">` OR
  `data-configuration` JSON with `spec.url`.
- Stoplight Elements: `<elements-api apiDescriptionUrl="X">`.
- RapiDoc: `<rapi-doc spec-url="X">`.

---

## 3. Library + dependency choice

### 3.1 Locked: `cheerio` v1 (MIT)

W1's top pick (`W1-research-summary.md` §2.2 line 146). MIT, ~3 MB, no native deps,
jQuery API over parse5. Add to `package.json` `dependencies`.

**Import discipline.** `require('cheerio')` permitted ONLY inside `lib/parsers/html.js`
and `lib/parsers/html-strategies/`. Other modules MUST NOT import cheerio — the
dispatcher (`lib/dispatcher.js` line 32) lazy-loads handlers so the mapping codepath
(validate/list/generate/doctor) pays no cheerio startup cost. Enforce with:
- `.eslintrc` `no-restricted-modules` rule on `lib/` excluding `lib/parsers/html*`.
- `tests/no-cheerio-leak.test.js` greps every non-html-parser `lib/**/*.js` for a
  literal `cheerio` token and fails on any match.

### 3.2 Rejected: `playwright` (Apache-2.0) for v0.x

Deferred per `W2-architecture.md` §5 item 1. Unlock criteria:
1. A required archetype has empty static HTML AND no spec-URL hint (none today —
   §4.4 redirect handles SPA viewers).
2. Stakeholder requests a named site whose static payload is provably empty.
3. ~300 MB install-size budget is relaxed.

When unlocked, land as `optionalDependencies`; `apifier-scrape` with `render_js=true`
lazy-imports and falls back to structured `FetcherError` if absent. Manifest at
`orchestray-plugin.json` lines 37-41 already declares the `render_js` flag.

### 3.3 Rejected: `jsdom`

~15 MB deps, full DOM+JS, provides no static-extraction capability cheerio lacks. W1
§2.2 line 148 ranks it 3/5 behind cheerio.

### 3.4 Transitive footprint

cheerio brings ~5 packages, all MIT: parse5, parse5-htmlparser2-tree-adapter,
htmlparser2, domhandler/domelementtype/domutils, boolbase/css-select/css-what/nth-check.
None GPL or restricted. Dev confirms actual `npm install` delta during W2D-2.

---

## 4. Detection + dispatch

### 4.1 Current state

`lib/handlers/scrape.js` line 77 unconditionally calls `parseOpenAPI`. OpenAPI parser
detects YAML vs JSON internally (`lib/parsers/openapi.js` lines 358-392). No
source-type router yet.

### 4.2 New dispatch rule (Wave 2D-2 edit to `scrape.js`)

Insert between line 74 (fetch result) and line 77 (parse call):

1. If `params.source_type === "openapi" | "swagger"` → call `parseOpenAPI`.
2. If `params.source_type === "html"` → call `parseHTML`.
3. If `params.source_type === "auto"` (manifest default at
   `orchestray-plugin.json` line 26) → sniff first 256 bytes of `fetchResult.body`:
   - Leading `{`, `openapi:`, `swagger:`, `---` → `parseOpenAPI`.
   - Leading `<!DOCTYPE html`, `<html`, `<!doctype html` (case-insensitive) →
     `parseHTML`.
   - Otherwise → `parseOpenAPI` (current default; emits warning).

Sniff function lives inline near the existing service-name resolver (lines 16-44). No
new util module.

### 4.3 `parseHTML` export contract

Mirrors `parseOpenAPI` (`lib/parsers/openapi.js` lines 403-507):

```text
async function parseHTML({ body, content_type, source_url }) → {
  ir,                  // populated IR (§6) OR null when redirect_to_spec is set
  warnings,            // string[]
  parser,              // { name: 'apifier-html-parser', version: '0.0.1' }
  redirect_to_spec?    // optional absolute URL — see §4.4
}
```

Required exports: `parseHTML`, `PARSER_NAME`, `PARSER_VERSION` (mirrors `openapi.js`
line 507).

### 4.4 SPA viewer → redirect signal

`openapi-rendered.js` runs first inside `parseHTML`. On match, it returns
`{ ir: null, warnings: [], parser: PARSER_META, redirect_to_spec: <url> }`. The handler
checks for `redirect_to_spec` after the parser call. If present AND the URL passes the
same-origin / relative-path safety check (§9.3), the handler:

1. Pushes a warning `{ code: "spec_redirect_followed", detail: "discovered OpenAPI spec at <url>" }`.
2. Re-fetches via `fetchSource` (reuses `timeout_ms`, `obey_robots_txt`, 5 MB cap).
3. Routes through `parseOpenAPI`.
4. Sets `mapping.source.type = "openapi"`; records original HTML URL in
   `parser_warnings` for provenance.

Auto-follow vs user opt-in: open question §12.1 (design default: auto-follow
same-origin).

### 4.5 Archetype dispatch order in `parseHTML`

After `openapi-rendered.js` rejects, first-match-wins in order:
1. `stripe-slate.js`
2. `docusaurus.js`
3. `gitbook.js`
4. `generic.js` (always matches unless §12.3 Option B is chosen)

If none match → `HTMLParseError` (§8).

---

## 5. Strategy module breakdown

### 5.1 Directory layout (locked)

```
lib/parsers/html.js
lib/parsers/html-strategies/
  _common.js              # shared cheerio helpers
  openapi-rendered.js     # SPA viewer detection + redirect
  stripe-slate.js         # three-column layout
  gitbook.js              # GitBook rendered
  docusaurus.js           # Docusaurus (with/without openapi-docs plugin)
  generic.js              # heading-based fallback
```

### 5.2 Module contract

Each strategy exports:

```text
matches(doc: CheerioAPI): boolean
extract(doc: CheerioAPI, ctx: { source_url: string|null }): { ir: object, warnings: string[] }
```

`openapi-rendered.js` additionally exports:

```text
extractRedirect(doc, ctx): { redirect_to_spec: string, warnings: string[] } | null
```

`parseHTML` calls `extractRedirect` first; on non-null result, short-circuits with
the redirect signal without invoking other strategies.

### 5.3 `_common.js` shared helpers

Pure utility functions, no mutable state:
- `findCodeBlocks(doc, parent)` → `{ language, text }[]` (classifies from
  `class="language-X"`, `class="lang-X"`, `data-lang="X"`).
- `extractAnchorText(doc, el)` → prose text under `el` until next sibling heading of
  equal-or-higher rank.
- `normaliseMethodPath(raw)` → `{ method, path }` or `null` for strings like
  `"POST /v1/charges"`.
- `parseParameterTable(doc, table)` → `Param[]` from `<table>` with headers matching
  `/name\|parameter\|type\|description\|required/i`.
- `slugifyId(method, path)` → matches `lib/parsers/openapi.js` `_deriveId` (lines
  21-42) for cross-parser uniformity.

`parseHTML` constructs `cheerio.load(body, { decodeEntities: true })` once and passes
to every strategy.

### 5.4 LOC budget (rough; ±5× per architect-prompt calibration caveat)

- `html.js`: ~150
- `_common.js`: ~150
- `openapi-rendered.js`: ~80
- `stripe-slate.js`: ~200
- `gitbook.js`: ~120
- `docusaurus.js`: ~150
- `generic.js`: ~120

Total ~900-1100 LOC. Actual will skew higher when TDD adds test LOC.

---

## 6. IR mapping from HTML

Target IR shape: `W2-mapping-schema.md` §3 (endpoints) + §2 (top-level). Binding
contract: `lib/mapping/schema.js` `EndpointSchema` lines 124-168.

### 6.1 Endpoint method + path

- **Primary (high confidence):** iterate `<h1>`-`<h4>`, regex
  `^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/\S*)` on plain text.
- **Secondary (high):** sibling `<span class="http-method">POST</span>` +
  `<code class="path">/v1/charges</code>` (Stripe pattern). Classnames matched by
  `/method|http-method|verb/i` and `/path|endpoint|route|url/i`.
- **Tertiary (medium):** adjacent `<code>POST</code><code>/v1/charges</code>` in same
  parent.

Strategy modules choose: `stripe-slate.js` favours secondary; `generic.js` uses only
primary.

### 6.2 Path parameters

Regex `\{([A-Za-z_][A-Za-z0-9_]*)\}` on the path → emit `path_params[]` entry per
match. Defaults: `type={primitive:"string"}`, `required=true`. If an adjacent parameter
table contains a row whose Name equals the variable, merge `Type`/`Description`/
`Required`/`Example`. Confidence: **high** when merged; **medium** otherwise.

### 6.3 Query parameters

Find `<table>` between endpoint heading and next endpoint heading whose header row
contains `/query|parameter/i`. Parse via `parseParameterTable`. Emit per-row matching
the `ParamSchema` (`lib/mapping/schema.js` lines 22-34). Disambiguator vs body-schema
table: header has "Query" OR all rows have primitive type values. Confidence:
**medium**.

### 6.4 Headers / cookies

Same as §6.3 gated on header text `/header/i` or `/cookie/i`. Confidence: **low**
(most sites don't tabulate these per-endpoint).

### 6.5 Body schema

Scan `<pre><code class="language-json">` blocks between the endpoint heading and the
next endpoint heading, preferring blocks under a sub-heading matching
`/request|body|payload/i`. v0.x stores the raw JSON snippet as opaque text — emit an
inline model:

```text
{ name: "<endpointId>Body", kind: "object", description: <JSON text truncated to 500 chars> }
```

and reference it as `endpoint.body.schema = { "$ref": "<endpointId>Body" }`.
Confidence: **low**. Typed schema inference deferred (open question §12.4).

### 6.6 Response examples + responses record

For each `language-json` block under a sub-heading matching
`/response|returns|example response/i`, treat first as `200`:
`responses["200"] = { description, content_type: "application/json" }` (no schema).

Top-level `examples[]`: for each `language-shell|language-bash` block under
`/example|usage|curl/i`, emit
`{ name: "<endpointId>Example", endpoint: "<METHOD> <path>", language: "curl", code, source_origin: "scraped" }`.

### 6.7 Auth

Scan body once for headings/callouts matching `/authentication|authorization|auth/i`.
Within 500 chars of such a heading:
- `/Bearer/i` + `/token/i` → `{ id: "bearer-auth", type: "http-bearer", description }`.
- `/api[\s-]?key/i` → `{ id: "api-key", type: "api-key", in: "header", name: <best guess from prose> }`.
- `/oauth/i` → `{ id: "oauth2-cc", type: "oauth2", flow: "client_credentials" }`.
- `/basic/i` + `/auth/i` → `{ id: "basic-auth", type: "http-basic" }`.

No detection → zero auth entries. Each endpoint's `auth[]` = union of detected ids
(OR composition per `W2-mapping-schema.md` §4.2). Confidence: **low to medium**.

### 6.8 Description

Prose text within endpoint section (heading → next equal-or-higher heading) via
`extractAnchorText`. Truncate to 5000 chars. Confidence: **medium**.

### 6.9 `service.name` / `service.version`

- `name`: `<title>` → slug per `^[a-z0-9][a-z0-9-]{0,63}$` (`lib/mapping/schema.js`
  line 257); fallback URL hostname, mirror `lib/parsers/openapi.js` lines 475-478.
- `version`: today's `YYYY-MM-DD` if undetected (the Zod schema accepts any non-empty
  string, line 262). Emit warning.

### 6.10 `servers[]`

Scan body for absolute URLs in `<code>` near phrases `base URL|production|endpoint|api`.
Dedupe. Emit `{ url, description: "scraped" }`. Confidence: **low**.

### 6.11 Fields explicitly NOT populated by `parseHTML` in v0.x

- `pagination`, `rate_limit`: `null`.
- `deprecated`: `{ is_deprecated: false, since: null, replacement_endpoint_id: null, sunset_at: null }`.
- `idempotency`: `method_intrinsic` from HTTP method (mirrors openapi.js lines
  142-145); other fields null.
- `error_codes`: `[]`.
- `models[]`: only the §6.5 inline body models.
- `errors[]`: `[]`.

### 6.12 Per-endpoint `x-origin` provenance

Every endpoint MUST include
`'x-origin': { html_selector: '<CSS selector>', source_url: '<page URL>' }` —
mirrors `lib/parsers/openapi.js` line 203 spec-pointer provenance.

---

## 7. Confidence + warnings policy

### 7.1 Per-extraction confidence tiers

Each field tagged internally `high | medium | low`. IR does not carry the tag (additive
schema compat — no new required fields). Instead `parseHTML` emits a `warnings[]`
entry for any field below `high`:

```text
"low_confidence: endpoints[2].query_params — heading-only fallback; no parameter table found"
```

Handler at `lib/handlers/scrape.js` line 95 already maps `warnings` into
`parser_warnings`; flow preserved.

### 7.2 Refusal policy

`parseHTML` MUST throw `HTMLParseError` (§8.1) when:
1. After all strategies, zero endpoints with both `method` AND `path` extracted AND
   no `redirect_to_spec` discovered.
2. Body empty or under 200 bytes.
3. `cheerio.load()` throws.

`parseHTML` MUST NOT throw when ≥1 endpoint extracted, even if every other field is
low-confidence. The mapping ships; warnings communicate quality.

### 7.3 Redirect short-circuit

When `openapi-rendered.js` returns a `redirect_to_spec`, `parseHTML` exits early
without invoking other strategies. Extraction quality irrelevant — we hand off to
the OpenAPI parser.

---

## 8. Error taxonomy additions

Two new classes in `lib/errors.js` (mirrors `OpenAPIParseError` at lines 86-91 and
`SitemapParseError` at lines 113-119):

### 8.1 `HTMLParseError` — code `-32008`

Subclass of `ParserError`. Thrown per §7.2. Message includes which strategies were
tried.

### 8.2 `HTMLArchetypeUnsupportedError` — code `-32009`

Subclass of `ParserError`. Reserved for the post-Playwright unlock; in v0.x no
archetype emits this. Declared now to reserve the code.

Both classes appended to `module.exports` block at `lib/errors.js` lines 162-181.

### 8.3 Dispatcher behaviour (no change)

`lib/dispatcher.js` lines 79-89 already remap non-spec codes to JSON-RPC `-32603` with
`data.domain_code` carrying the original. Codes `-32008` and `-32009` flow through
unchanged.

---

## 9. Security considerations

### 9.1 Script content as text (no JS execution)

cheerio does not execute JavaScript; `<script>` content is text. The parser MAY read
script text (openapi-rendered extracts spec URL from `SwaggerUIBundle({url:...})`
literal via regex) but MUST NOT `eval`. Confirmed: cheerio's parse5 backend ignores
DTDs — not vulnerable to billion-laughs / xml-entity-expansion.

### 9.2 Body cap reuse

`lib/http/fetch.js` line 13 caps every fetched body at 5 MB (`MAX_BODY_BYTES`). That
cap protects against multi-MB HTML. Cheerio (parse5) is O(n) in input size — 5 MB
parses in <500 ms. No additional in-parser document-size cap required.

### 9.3 Same-origin restriction on `redirect_to_spec`

When `openapi-rendered.js` discovers a spec URL, the handler MUST validate the target
before re-fetching:
- Relative path (no scheme) → resolve against original `source_url`. Allowed.
- Absolute URL → parse via `new URL(...)`; compare `.origin` to original
  `source_url.origin`. Allowed if equal; otherwise emit warning and skip auto-follow.
  User can re-invoke with the cross-origin URL explicitly.

Cross-origin auto-follow would expand attack surface (malicious page redirects to
internal-network URL or credential-stealing endpoint). Same-origin is the safe
default.

### 9.4 Output redaction reuse

All `parser_warnings[]` pass through `lib/output-redaction.js` via existing handler
flow. Existing rules (Bearer pattern, API-key URL pattern — `W2-architecture.md` §4.2)
cover HTML doc leak patterns. No new redaction rules needed.

### 9.5 No new env-var reads

Per `W2-architecture.md` §4.3 the plugin reads no env vars outside `os.homedir()`.
`parseHTML` honours this — no `process.env.*` in strategy modules.

---

## 10. Test fixture strategy

Fixtures under `tests/fixtures/html/`. Hand-authored, each <100 lines, top comment
naming the archetype.

| File | Lines | Purpose | Expected |
|---|---|---|---|
| `stripe-slate-widgets.html` | ~100 | three-column, 2-3 endpoints, parameter tables, curl + JSON examples, Bearer auth callout | 2-3 endpoints high-confidence, 1 auth scheme, 1 inline model per endpoint, 2-3 examples |
| `swagger-ui-shell.html` | ~30 | `<div id="swagger-ui">` + `SwaggerUIBundle({url:"/openapi.json"})` | `{ ir: null, redirect_to_spec: "<origin>/openapi.json" }` |
| `redoc-shell.html` | ~25 | `<redoc spec-url="https://example.test/api/openapi.yaml">` | same shape as Swagger UI; cross-origin warning if origin differs |
| `docusaurus-openapi-page.html` | ~80 | body class `theme-doc-*`, single endpoint with `openapi__method-endpoint` signature + schema table | 1 endpoint, query_params from table, medium-high confidence |
| `generic-readme.html` | ~50 | `<h2>POST /widgets</h2>` + prose + curl block, no table | 1 endpoint method+path only, body opaque, low-confidence warning |
| `no-endpoints.html` | ~20 | blog-style page, no method+path patterns | throws `HTMLParseError` |

GitBook fixture is **lower priority** — Wave 2D-2 may defer to a follow-up wave. The
`gitbook.js` strategy module still ships; only the fixture is deferred.

---

## 11. Wave 2D-2 implementation handoff

### 11.1 New files

1. `lib/parsers/html.js` — entry; exports `parseHTML`, `PARSER_NAME`, `PARSER_VERSION`. Mirrors `lib/parsers/openapi.js` lines 403-507.
2. `lib/parsers/html-strategies/_common.js` — §5.3 helpers.
3. `lib/parsers/html-strategies/openapi-rendered.js` — `matches` + `extractRedirect`.
4. `lib/parsers/html-strategies/stripe-slate.js` — `matches` + `extract`.
5. `lib/parsers/html-strategies/gitbook.js` — `matches` + `extract`.
6. `lib/parsers/html-strategies/docusaurus.js` — `matches` + `extract`.
7. `lib/parsers/html-strategies/generic.js` — `matches` + `extract` (fallback; `matches` always `true` unless §12.3 Option B chosen).
8. `tests/fixtures/html/*.html` — per §10.
9. `tests/parsers/html.test.js` — one test per strategy + failure case. Asserts `endpoints.length`, one representative `method`+`path`, and that IR validates clean against `MappingSchemaV1` after `buildMapping` wraps it.
10. `tests/no-cheerio-leak.test.js` — grep test per §3.1.

### 11.2 Files to modify

1. `lib/handlers/scrape.js` — auto-sniff branch (§4.2) + `redirect_to_spec` follow-up (§4.4). ~30 LOC around lines 67-96.
2. `lib/errors.js` — append `HTMLParseError`, `HTMLArchetypeUnsupportedError` classes; add to `module.exports`. ~20 LOC added.
3. `package.json` — add `"cheerio": "^1.0.0"` to `dependencies`.

### 11.3 Files to read for context (no modification)

- `lib/parsers/openapi.js` — pattern to mirror.
- `lib/http/fetch.js` — 5 MB cap + same-origin context.
- `lib/mapping/schema.js` — `EndpointSchema`, `ParamSchema` are binding shapes.
- `lib/mapping/build.js` — canonical sort + provenance wrapping.

### 11.4 Out of scope for Wave 2D-2

- Playwright integration (deferred per §3.2).
- Typed schema inference from JSON body samples (§12.4).
- Multi-page crawling within one doc site (§12.6).
- Markdown parser `lib/parsers/markdown.js` — separate W-item.

### 11.5 Acceptance criteria for Wave 2D-2

- All 10 files in §11.1 exist and pass `npm test`.
- `lib/handlers/scrape.js` correctly dispatches HTML and follows same-origin
  redirects.
- A scrape against `tests/fixtures/html/stripe-slate-widgets.html` (file: URL) yields
  ≥2 endpoints, validates clean against `MappingSchemaV1`, writes successfully.
- A scrape against the Swagger-UI fixture follows the redirect and produces an
  openapi-derived mapping.
- A scrape against `no-endpoints.html` throws `HTMLParseError`; dispatcher remaps to
  `-32603` + `data.domain_code: -32008`.

---

## 12. Open questions (for the user)

### 12.1 Auto-follow `redirect_to_spec`?

- **A (design default):** auto-follow same-origin URLs. Same-origin restriction (§9.3) bounds risk; one extra HTTP fetch transparent to caller.
- **B:** never auto-follow; return `redirect_to_spec` and require user re-invoke.

**Recommendation: A.**

### 12.2 Extract-with-warning vs refuse-with-error on ambiguous markup?

- **A (current design):** extract anything; emit `low_confidence` warnings; refuse only on zero endpoints.
- **B:** refuse anything below medium confidence per endpoint.

**Recommendation: A.** User can opt into stricter behaviour via `apifier-validate --strict` (flag already exists, `orchestray-plugin.json` line 86).

### 12.3 Should `generic.js` ever run?

- **A (current design):** `generic.js` always tried last, low confidence; refuse only when even generic finds nothing.
- **B:** require a named archetype match; `HTMLParseError("no recognised archetype")` if only `generic.js` would match.

**Recommendation: A.** Plugin's value is "scrape anything"; low-confidence warnings communicate the limitation.

### 12.4 Typed schema inference from JSON samples?

§6.5 currently stores raw JSON as opaque text. Should W2D-2 walk samples to emit typed `{name, fields}` models?

**Recommendation: defer to a future wave.**

### 12.5 Record archetype in mapping for drift detection?

Add `mapping.extensions["x-html-archetype"] = "stripe-slate"` so `apifier-validate` can warn on re-scrape archetype switches?

**Recommendation: yes, low-cost. Add to W2D-2 scope.**

### 12.6 Single-page vs multi-page scrape?

`fetchSource` reads one URL today. Many doc sites span dozens of pages linked from a left nav. Follow same-origin links within `max_pages` budget (already declared at `orchestray-plugin.json` line 43)?

**Recommendation: defer to a future wave.** W2D-2 ships single-page; multi-page is its own design with politeness/budget concerns.

---

## 13. Acceptance Rubric

```yaml
correctness:
  - C1 (binary): §2 enumerates all six archetypes with markup cues, strategy module, confidence tier, and hit-rate estimate in the summary table.
  - C2 (binary): §3 locks cheerio v1 MIT, rejects playwright + jsdom with rationale, documents the import-discipline rule with enforcement (eslint + grep test).
  - C3 (binary): §4 specifies the auto-sniff dispatch citing exact file paths and line numbers (lib/handlers/scrape.js line 77, lib/parsers/openapi.js lines 358-392).
  - C4 (binary): §5 defines the strategy directory layout and the matches/extract/extractRedirect contract.
  - C5 (binary): §6 maps every load-bearing IR field (method, path, params, body, responses, auth, description, service) to a named heuristic with a confidence tier.
  - C6 (binary): §7 defines refusal threshold (zero endpoints → HTMLParseError) and the low_confidence warning flow.
  - C7 (binary): §8 defines HTMLParseError (-32008) and HTMLArchetypeUnsupportedError (-32009) as ParserError subclasses, citing dispatcher remap at lib/dispatcher.js lines 79-89.
  - C8 (binary): §9 confirms script-as-text behaviour, reuses the 5 MB body cap (lib/http/fetch.js line 13), and locks same-origin restriction on redirect_to_spec.
  - C9 (binary): §10 enumerates six hand-authored test fixtures with expected behaviour.
  - C10 (binary): §11 lists every Wave 2D-2 deliverable file (new and modified) with a LOC budget; developer can implement without re-asking architect.
api-compat:
  - C11 (binary): IR fields in §6 are a subset of EndpointSchema (lib/mapping/schema.js lines 124-168); no invented fields.
  - C12 (binary): Parser export shape in §4.3 matches lib/parsers/openapi.js line 507 exactly.
docs:
  - C13 (binary): All file-path citations resolve in the worktree; spot-check at least 8 line citations.
operability:
  - C14 (binary): File exists at .orchestray/kb/decisions/W20-html-parser-strategy.md with the frontmatter at the top.
  - C15 (binary): §12 lists at least 4 open questions, each with options and a recommendation (this design lists 6).
```
