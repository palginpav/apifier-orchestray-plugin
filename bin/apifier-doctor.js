#!/usr/bin/env node
'use strict';

// bin/apifier-doctor.js — CLI health-check for the APIfier plugin install.
// Runs 3 checks: node version, orchestray install, and mappings directory.
// (The MCP apifier-doctor tool runs a 4th check, mappings_validity, which
//  reads every mapping file — kept MCP-only to avoid slow CLI startups when
//  mapping dirs grow. See lib/handlers/doctor.js for the shared check fns.)
// Exit 0 on all-green; exit 1 if any check fails or warns.

const {
  checkNodeVersion,
  checkOrchestrayInstall,
  checkMappingsDir,
} = require('../lib/handlers/doctor');

const results = [];
let overallOk = true;

/**
 * Record a check result and print it (CLI format).
 * @param {{ name: string, status: string, detail: string }} check
 */
function record(check) {
  const ok = check.status !== 'fail';
  results.push({ check: check.name, ok, detail: check.detail });
  const icon = ok ? '[OK]' : '[FAIL]';
  process.stdout.write(`${icon}  ${check.name}: ${check.detail}\n`);
  if (!ok) overallOk = false;
}

// ---------------------------------------------------------------------------
// Run the 3 CLI checks (mappings_validity is MCP-only in v0.0.1)
// ---------------------------------------------------------------------------

record(checkNodeVersion());
record(checkOrchestrayInstall());
record(checkMappingsDir());

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
