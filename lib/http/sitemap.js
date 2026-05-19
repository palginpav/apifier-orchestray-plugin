'use strict';

// lib/http/sitemap.js — Sitemap fetcher with sitemap-index expansion and URL extraction.
// Pure-Node heuristic XML parser using regex; no external XML library.

const { SitemapNotFoundError, SitemapParseError } = require('../errors');

const DEFAULT_MAX_URLS  = 200;
const DEFAULT_TIMEOUT   = 10000;
const SITEMAP_INDEX_CHECK_BYTES = 4096;

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
 * Extract all <loc>...</loc> values from XML text.
 * Non-greedy regex; safe against large inputs.
 * @param {string} xml
 * @returns {string[]}
 */
function _extractLocs(xml) {
  const results = [];
  // Non-greedy match; [\s\S]*? avoids catastrophic backtracking on large inputs
  const re = /<loc>([\s\S]*?)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
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
    clearTimeout(timer);
    throw new Error(`fetch failed for ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  return { text, status: response.status };
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
      throw new Error(`sitemap fetch error: ${err.message}`);
    }

    if (status === 404 || status === 410) {
      throw new SitemapNotFoundError(`sitemap not found: ${url} (HTTP ${status})`);
    }

    if (!text.includes('<urlset') && !text.includes('<sitemapindex')) {
      throw new SitemapParseError(`not a valid sitemap (no <urlset> or <sitemapindex>): ${url}`);
    }

    if (_isSitemapIndex(text) && depth < 2) {
      // Expand sub-sitemaps one level
      const subUrls = _extractLocs(text);
      for (const subUrl of subUrls) {
        if (truncated) break;
        // Recurse into sub-sitemap (depth + 1)
        await _process(subUrl, depth + 1);
      }
    } else {
      // Flat sitemap: collect URLs
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
