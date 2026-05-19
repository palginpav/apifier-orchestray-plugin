#!/usr/bin/env node
'use strict';

// bin/apifier-doctor.js — CLI health-check for the APIfier plugin install.
// Checks node version, orchestray install, and mappings directory.
// Exit 0 on all-green; exit 1 if any check fails or warns.

const os = require('os');
const fs = require('fs');
const path = require('path');

const ORCHESTRAY_INSTALL_DIR = path.join(os.homedir(), '.claude', 'orchestray');
const MAPPINGS_DIR = path.join(os.homedir(), '.orchestray', 'apifier', 'mappings');

const results = [];
let overallOk = true;

/**
 * Record a check result and print it.
 * @param {string} check - Check name
 * @param {boolean} ok - Whether the check passed
 * @param {string} detail - Human-readable detail
 */
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  const icon = ok ? '[OK]' : '[FAIL]';
  process.stdout.write(`${icon}  ${check}: ${detail}\n`);
  if (!ok) overallOk = false;
}

// ---------------------------------------------------------------------------
// Check 1: Node version >= 20
// ---------------------------------------------------------------------------

const nodeVerMatch = process.version.match(/^v(\d+)/);
const nodeMajor = nodeVerMatch ? parseInt(nodeVerMatch[1], 10) : 0;
record(
  'node_version',
  nodeMajor >= 20,
  `${process.version} (require >=20)`
);

// ---------------------------------------------------------------------------
// Check 2: orchestray install present at ~/.claude/orchestray/
// ---------------------------------------------------------------------------

const orchestrayExists = fs.existsSync(ORCHESTRAY_INSTALL_DIR);
record(
  'orchestray_install',
  orchestrayExists,
  orchestrayExists
    ? `found at ${ORCHESTRAY_INSTALL_DIR}`
    : `not found at ${ORCHESTRAY_INSTALL_DIR} — install orchestray first`
);

// ---------------------------------------------------------------------------
// Check 3: mappings directory is creatable / writable
// ---------------------------------------------------------------------------

let mappingsDirOk = false;
let mappingsDirDetail = '';
try {
  if (!fs.existsSync(MAPPINGS_DIR)) {
    fs.mkdirSync(MAPPINGS_DIR, { recursive: true });
    mappingsDirDetail = `created ${MAPPINGS_DIR}`;
  } else {
    // Probe writeability with a temp file.
    const probe = path.join(MAPPINGS_DIR, '.apifier-write-probe');
    fs.writeFileSync(probe, '', { mode: 0o600 });
    fs.unlinkSync(probe);
    mappingsDirDetail = `writable at ${MAPPINGS_DIR}`;
  }
  mappingsDirOk = true;
} catch (e) {
  mappingsDirDetail = `not writable: ${e.message}`;
}
record('mappings_dir', mappingsDirOk, mappingsDirDetail);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write('\n');
if (overallOk) {
  process.stdout.write('apifier-doctor: all checks passed.\n');
  process.exit(0);
} else {
  process.stdout.write('apifier-doctor: one or more checks failed.\n');
  process.exit(1);
}
