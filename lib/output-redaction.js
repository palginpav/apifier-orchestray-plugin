'use strict';

// lib/output-redaction.js — Credential and path redaction for all error messages and tool output.

const PATTERNS = [
  // Anthropic API key
  { re: /sk-ant-[A-Za-z0-9_-]+/g,                                                       replacement: '[REDACTED-API-KEY]' },
  // Authorization: Bearer <token>
  { re: /Authorization:\s*Bearer\s+\S+/gi,                                               replacement: 'Authorization: [REDACTED]' },
  // Bearer <token> standalone (W2-architecture §4.2)
  { re: /Bearer\s+[A-Za-z0-9._\-]+/g,                                                   replacement: 'Bearer <REDACTED>' },
  // x-api-key header
  { re: /x-api-key:\s*\S+/gi,                                                            replacement: 'x-api-key: [REDACTED]' },
  // PEM private key blocks
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,   replacement: '[REDACTED-PRIVATE-KEY-BLOCK]' },
  // JWT tokens: eyJ...eyJ...signature
  { re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,             replacement: '[REDACTED-JWT]' },
  // API key in URL query string (?api_key=... or &token=...)
  { re: /([?&])(api[_-]?key|token|secret|password)=[A-Za-z0-9_\-\.]{8,}/gi,             replacement: '$1$2=<REDACTED>' },
  // Generic key=value credentials
  { re: /(api[_-]?key|password|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{8,}['"]?/gi, replacement: '$1=[REDACTED]' },
];

/**
 * Replace credential patterns in a string with safe placeholders.
 * Also strips control characters (except \t, \n, \r) to prevent JSON-RPC
 * framing corruption and log-injection attacks.
 * @param {string} s - Input string (error message, log line, etc.)
 * @returns {string} - Redacted copy
 */
function redact(s) {
  if (typeof s !== 'string') return String(s);
  // Strip control chars first so credentials inside control-char sequences are still caught.
  // Preserve \t (0x09), \n (0x0a), \r (0x0d) — they are legitimate whitespace.
  let out = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

module.exports = { redact };
