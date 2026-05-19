'use strict';

// lib/http/robots.js — robots.txt fetcher and matcher with in-memory origin cache.
// Implements Google's interpretation: longest match wins; Allow beats Disallow on ties.

const DEFAULT_UA      = 'apifier';
const DEFAULT_TIMEOUT = 5000;

/** @type {Map<string, object>} origin -> parsed robots state */
const _cache = new Map();

/**
 * Convert a robots.txt rule path pattern to a RegExp.
 * Supports '*' wildcard and '$' end-anchor.
 * @param {string} pattern
 * @returns {RegExp}
 */
function _patternToRegex(pattern) {
  // Escape regex metacharacters except * and $
  let escaped = pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
  // Replace * with .* (non-greedy not needed here — leftmost match is fine)
  escaped = escaped.replace(/\*/g, '.*');
  // $ at end means end-of-string anchor; $ anywhere else is literal
  if (escaped.endsWith('$')) {
    escaped = escaped.slice(0, -1) + '$';
  } else {
    // No end-anchor: match from start but allow anything after
    escaped = escaped;
  }
  return new RegExp('^' + escaped);
}

/**
 * Parse robots.txt text into groups keyed by user-agent (lowercased).
 * Returns Map<string, { allows: string[], disallows: string[] }>
 * @param {string} text
 * @returns {Map<string, {allows: string[], disallows: string[]}>}
 */
function _parseRobots(text) {
  const groups = new Map();
  let currentAgents = [];

  for (let line of text.split(/\r?\n/)) {
    // Strip comments
    const commentIdx = line.indexOf('#');
    if (commentIdx !== -1) line = line.slice(0, commentIdx);
    line = line.trim();
    if (!line) {
      // Blank line ends current group
      currentAgents = [];
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      const ua = value.toLowerCase();
      if (!groups.has(ua)) groups.set(ua, { allows: [], disallows: [] });
      currentAgents.push(ua);
    } else if (field === 'allow') {
      for (const ua of currentAgents) {
        if (!groups.has(ua)) groups.set(ua, { allows: [], disallows: [] });
        if (value) groups.get(ua).allows.push(value);
      }
    } else if (field === 'disallow') {
      for (const ua of currentAgents) {
        if (!groups.has(ua)) groups.set(ua, { allows: [], disallows: [] });
        if (value) groups.get(ua).disallows.push(value);
      }
    }
  }

  return groups;
}

/**
 * Decide if urlPath is allowed by the given group rules.
 * Google interpretation: longest matching rule wins; Allow beats Disallow on ties.
 * @param {string} urlPath - The path+query portion of the target URL.
 * @param {{ allows: string[], disallows: string[] }} group
 * @returns {{ allowed: boolean, matched_rule: string|null }}
 */
function _applyGroup(urlPath, group) {
  let bestLength = -1;
  let bestAllowed = true;
  let bestRule = null;

  for (const pattern of group.allows) {
    const re = _patternToRegex(pattern);
    if (re.test(urlPath)) {
      const len = pattern.replace(/[*$]/g, '').length;
      if (len > bestLength || (len === bestLength && true /* allow wins ties */)) {
        // Only replace if strictly longer OR same length and we already have a disallow
        if (len > bestLength || !bestAllowed) {
          bestLength = len;
          bestAllowed = true;
          bestRule = `Allow: ${pattern}`;
        }
      }
    }
  }

  for (const pattern of group.disallows) {
    const re = _patternToRegex(pattern);
    if (re.test(urlPath)) {
      const len = pattern.replace(/[*$]/g, '').length;
      if (len > bestLength) {
        bestLength = len;
        bestAllowed = false;
        bestRule = `Disallow: ${pattern}`;
      }
      // On tie, Allow already wins — don't replace
    }
  }

  // Empty Disallow means allow all; empty Allow is a no-op
  // If no rule matched, default is allow
  return { allowed: bestAllowed, matched_rule: bestRule };
}

/**
 * Fetch robots.txt for origin and cache parsed result.
 * @param {string} origin
 * @param {string} userAgent
 * @param {number} timeoutMs
 * @returns {Promise<{ groups: Map, fetched_at: string, robots_url: string, status: number|null }>}
 */
async function _fetchAndParse(origin, userAgent, timeoutMs) {
  const robots_url = `${origin}/robots.txt`;
  const fetched_at = new Date().toISOString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let status = null;

  try {
    response = await fetch(robots_url, {
      signal:  controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': userAgent },
    });
    status = response.status;
  } catch (_err) {
    // Network error or timeout → block for politeness
    clearTimeout(timer);
    return { groups: null, fetched_at, robots_url, status: null, networkError: true };
  } finally {
    clearTimeout(timer);
  }

  // 404/410 → no robots → all allowed
  if (status === 404 || status === 410) {
    return { groups: new Map(), fetched_at, robots_url, status };
  }

  // 5xx → block for politeness
  if (status >= 500) {
    return { groups: null, fetched_at, robots_url, status, serverError: true };
  }

  // Non-2xx that isn't handled above → treat as no robots
  if (!response.ok) {
    return { groups: new Map(), fetched_at, robots_url, status };
  }

  let text;
  try {
    text = await response.text();
  } catch (_err) {
    return { groups: null, fetched_at, robots_url, status, networkError: true };
  }

  const groups = _parseRobots(text);
  return { groups, fetched_at, robots_url, status };
}

/**
 * @typedef {{ allowed: boolean, matched_rule: string|null, fetched_at: string, robots_url: string }} RobotsDecision
 */

/**
 * Fetch and parse robots.txt for origin, decide if targetUrl is allowed.
 * Cache per origin for process lifetime.
 * @param {string} targetUrl
 * @param {object} [opts]
 * @param {string} [opts.userAgent='apifier']
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<RobotsDecision>}
 */
async function checkRobots(targetUrl, opts) {
  const userAgent = (opts && opts.userAgent) ? opts.userAgent : DEFAULT_UA;
  const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : DEFAULT_TIMEOUT;

  const parsed = new URL(targetUrl);
  const origin = parsed.origin;
  const urlPath = parsed.pathname + (parsed.search || '');

  let cached = _cache.get(origin);
  if (!cached) {
    cached = await _fetchAndParse(origin, userAgent, timeoutMs);
    _cache.set(origin, cached);
  }

  const { groups, fetched_at, robots_url, networkError, serverError } = cached;

  // Network error or 5xx → block
  if (networkError || serverError || groups === null) {
    return {
      allowed:      false,
      matched_rule: serverError ? 'robots unavailable (5xx)' : 'robots unavailable (network error)',
      fetched_at,
      robots_url,
    };
  }

  // No rules (404/410 or empty file) → allow all
  if (groups.size === 0) {
    return { allowed: true, matched_rule: null, fetched_at, robots_url };
  }

  // Pick active group: UA-specific first, then '*'
  const uaLower = userAgent.toLowerCase();
  // Extract base UA without version
  const uaBase = uaLower.split('/')[0];
  const group = groups.get(uaBase) || groups.get(uaLower) || groups.get('*');

  if (!group) {
    // No matching group → allow
    return { allowed: true, matched_rule: null, fetched_at, robots_url };
  }

  const decision = _applyGroup(urlPath, group);
  return { ...decision, fetched_at, robots_url };
}

/** Clear in-memory cache (for tests). */
function _clearRobotsCache() {
  _cache.clear();
}

module.exports = { checkRobots, _clearRobotsCache };
