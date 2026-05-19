'use strict';

// lib/http/sitemap.js — Sitemap fetcher with sitemap-index expansion and URL extraction.
// Pure-Node heuristic XML parser using regex; no external XML library.

const { SitemapNotFoundError, SitemapParseError } = require('../errors');

const DEFAULT_MAX_URLS  = 200;
const DEFAULT_TIMEOUT   = 10000;
const SITEMAP_INDEX_CHECK_BYTES = 4096;
// Resource-exhaustion guard: cap any single sitemap body. Real-world sitemaps
// are 1–4 MB; 5 MB is generous. Beyond this, throw SitemapParseError.
const MAX_BODY_BYTES   = 5 * 1024 * 1024;

/**
 * Decode 5 basic XML entities in a string.
 * @param {string} s
 * @returns {string}
 */
function _decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Strip <!-- ... --> XML comments so a comment containing the literal text
 * "<loc>" cannot poison the URL extractor below.
 * Non-greedy `[\s\S]*?` is bounded by the explicit `-->` terminator on each
 * comment, so this is ReDoS-safe.
 * @param {string} xml
 * @returns {string}
 */
function _stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Extract all <loc>...</loc> values from XML text.
 * Non-greedy regex; safe against large inputs. Comments are stripped first
 * so a comment containing the literal "<loc>" cannot be mis-extracted.
 * @param {string} xml
 * @returns {string[]}
 */
function _extractLocs(xml) {
  const stripped = _stripComments(xml);
  const results = [];
  // Non-greedy match; [\s\S]*? avoids catastrophic backtracking on large inputs.
  const re = /<loc>([\s\S]*?)<\/loc>/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const url = _decodeEntities(m[1].trim());
    if (url) results.push(url);
  }
  return results;
}

/**
 * Determine if XML text is a sitemap-index (heuristic: look in first 4 KB).
 * @param {string} xml
 * @returns {boolean}
 */
function _isSitemapIndex(xml) {
  const head = xml.slice(0, SITEMAP_INDEX_CHECK_BYTES);
  return head.includes('<sitemapindex');
}

/**
 * Fetch a single URL and return text body + status.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{text: string, status: number}>}
 */
async function _fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      signal:  controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'apifier/0.0.1' },
    });
  } catch (err) {
    throw new Error(`fetch failed for ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  // Resource-exhaustion guard. Honour Content-Length when present; otherwise
  // stream and abort if the running byte count exceeds MAX_BODY_BYTES.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new SitemapParseError(`sitemap body too large (${declared} bytes > ${MAX_BODY_BYTES}): ${url}`);
  }
  if (!response.body) {
    return { text: '', status: response.status };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      throw new SitemapParseError(`sitemap body exceeded ${MAX_BODY_BYTES} bytes (mid-stream): ${url}`);
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return { text: out, status: response.status };
}

/**
 * @typedef {{ urls: string[], origin: string, truncated: boolean }} SitemapResult
 */

/**
 * Fetch a sitemap.xml (or sitemap-index.xml) and return discovered <loc> URLs.
 * Recursively expands sitemap-index entries (depth cap: 2).
 *
 * @param {string} sitemapUrl
 * @param {object} [opts]
 * @param {number} [opts.maxUrls=200]
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<SitemapResult>}
 */
async function fetchSitemap(sitemapUrl, opts) {
  const maxUrls  = (opts && typeof opts.maxUrls === 'number')  ? opts.maxUrls  : DEFAULT_MAX_URLS;
  const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : DEFAULT_TIMEOUT;

  const origin = new URL(sitemapUrl).origin;
  const collectedUrls = [];
  let truncated = false;
  // SSRF / dedup guard. Sub-sitemap URLs are only fetched if they share the
  // root sitemap's origin AND have not already been visited.
  const visited = new Set([sitemapUrl]);

  /**
   * Recursively fetch and extract URLs.
   * @param {string} url
   * @param {number} depth - 0 = root, 1 = child sitemaps
   */
  async function _process(url, depth) {
    if (truncated) return;

    let text, status;
    try {
      ({ text, status } = await _fetchText(url, timeoutMs));
    } catch (err) {
      // Propagate already-typed errors (e.g. SitemapParseError from byte cap).
      if (err instanceof SitemapParseError || err instanceof SitemapNotFoundError) throw err;
      throw new Error(`sitemap fetch error: ${err.message}`);
    }

    if (status === 404 || status === 410) {
      throw new SitemapNotFoundError(`sitemap not found: ${url} (HTTP ${status})`);
    }

    if (!text.includes('<urlset') && !text.includes('<sitemapindex')) {
      throw new SitemapParseError(`not a valid sitemap (no <urlset> or <sitemapindex>): ${url}`);
    }

    if (_isSitemapIndex(text) && depth < 2) {
      // Expand sub-sitemaps one level. Same-origin only + dedup.
      const subUrls = _extractLocs(text);
      for (const subUrl of subUrls) {
        if (truncated) break;
        let subOrigin;
        try {
          subOrigin = new URL(subUrl).origin;
        } catch (_e) {
          // Malformed sub-sitemap URL — skip without aborting the whole crawl.
          continue;
        }
        if (subOrigin !== origin) continue;  // SSRF guard
        if (visited.has(subUrl)) continue;   // Dedup
        visited.add(subUrl);
        await _process(subUrl, depth + 1);
      }
    } else {
      // Flat sitemap: collect URLs (no origin filter here — these are content
      // URLs the caller will use, not URLs we will fetch ourselves).
      const locs = _extractLocs(text);
      for (const loc of locs) {
        if (collectedUrls.length >= maxUrls) {
          truncated = true;
          break;
        }
        collectedUrls.push(loc);
      }
    }
  }

  await _process(sitemapUrl, 0);

  return { urls: collectedUrls, origin, truncated };
}

module.exports = { fetchSitemap };
