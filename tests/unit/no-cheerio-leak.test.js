'use strict';

// tests/unit/no-cheerio-leak.test.js — Enforce cheerio import discipline.
// cheerio must ONLY appear in lib/parsers/html.js and lib/parsers/html-strategies/*.js.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '../../');
const LIB_DIR      = path.join(PROJECT_ROOT, 'lib');

// Allowed files that may import cheerio.
const ALLOWED_PATTERNS = [
  /lib[/\\]parsers[/\\]html\.js$/,
  /lib[/\\]parsers[/\\]html-strategies[/\\]/,
];

/**
 * Recursively collect all .js files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function walkJs(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJs(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

test('no-cheerio-leak: cheerio imported only in html parser files', () => {
  const allLibFiles = walkJs(LIB_DIR);
  const violations = [];

  for (const filePath of allLibFiles) {
    const isAllowed = ALLOWED_PATTERNS.some(re => re.test(filePath));
    if (isAllowed) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    // Check for any require('cheerio') or require("cheerio") — including with whitespace.
    if (/require\s*\(\s*['"]cheerio['"]\s*\)/.test(content)) {
      violations.push(filePath.replace(PROJECT_ROOT, ''));
    }
  }

  assert.deepEqual(
    violations,
    [],
    `cheerio imported in non-html-parser files: ${violations.join(', ')}`
  );
});
