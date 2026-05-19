'use strict';

// lib/handlers/doctor.js — Shared health-check logic for apifier-doctor CLI and MCP tool.

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { getMappingDir } = require('../registry');
const { readMapping }   = require('../mapping/read');

const ORCHESTRAY_INSTALL_DIR = path.join(os.homedir(), '.claude', 'orchestray');

// ---------------------------------------------------------------------------
// Individual checks — each returns { name, status: "pass"|"warn"|"fail", detail }
// ---------------------------------------------------------------------------

/**
 * Check Node.js version >= 20.
 * @returns {{ name: string, status: string, detail: string }}
 */
function checkNodeVersion() {
  const match = process.version.match(/^v(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;
  const ok = major >= 20;
  return {
    name:   'node_version',
    status: ok ? 'pass' : 'fail',
    detail: `${process.version} (require >=20)`,
  };
}

/**
 * Check orchestray install present at ~/.claude/orchestray/.
 * @returns {{ name: string, status: string, detail: string }}
 */
function checkOrchestrayInstall() {
  const exists = fs.existsSync(ORCHESTRAY_INSTALL_DIR);
  return {
    name:   'orchestray_install',
    status: exists ? 'pass' : 'fail',
    detail: exists
      ? `found at ${ORCHESTRAY_INSTALL_DIR}`
      : `not found at ${ORCHESTRAY_INSTALL_DIR} — install orchestray first`,
  };
}

/**
 * Check mappings directory is creatable / writable.
 * @param {string} [dir] Override mappings dir (default: registry.getMappingDir()).
 * @returns {{ name: string, status: string, detail: string }}
 */
function checkMappingsDir(dir) {
  const mappingsDir = dir || getMappingDir();
  let ok = false;
  let detail = '';
  try {
    if (!fs.existsSync(mappingsDir)) {
      fs.mkdirSync(mappingsDir, { recursive: true });
      detail = `created ${mappingsDir}`;
    } else {
      const probe = path.join(mappingsDir, '.apifier-write-probe');
      fs.writeFileSync(probe, '', { mode: 0o600 });
      fs.unlinkSync(probe);
      detail = `writable at ${mappingsDir}`;
    }
    ok = true;
  } catch (e) {
    detail = `not writable: ${e.message}`;
  }
  return {
    name:   'mappings_dir',
    status: ok ? 'pass' : 'fail',
    detail,
  };
}

/**
 * Check mappings validity — counts invalid .apifier.json files. Status "warn" if any invalid.
 * Does NOT cause overall ok=false (informational).
 * @param {string} [dir] Override mappings dir.
 * @returns {{ name: string, status: string, detail: string }}
 */
function checkMappingsValidity(dir) {
  const mappingsDir = dir || getMappingDir();
  let invalid = 0;
  let total = 0;
  try {
    if (!fs.existsSync(mappingsDir)) {
      return { name: 'mappings_validity', status: 'pass', detail: 'mappings dir does not exist yet (0 files)' };
    }
    const files = fs.readdirSync(mappingsDir).filter(f => f.endsWith('.apifier.json'));
    total = files.length;
    for (const f of files) {
      try {
        const { validation } = readMapping({ mapping_path: path.join(mappingsDir, f) });
        if (!validation.ok) invalid++;
      } catch (_) {
        invalid++;
      }
    }
  } catch (e) {
    return { name: 'mappings_validity', status: 'warn', detail: `could not scan mappings dir: ${e.message}` };
  }
  if (invalid === 0) {
    return { name: 'mappings_validity', status: 'pass', detail: `${total} mapping(s), all valid` };
  }
  return { name: 'mappings_validity', status: 'warn', detail: `${invalid} of ${total} mapping(s) failed validation` };
}

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------

/**
 * Run all doctor checks and return structured result.
 * @param {object} [params]
 * @param {string} [params.dir] Override mappings dir (for testing).
 * @returns {{ ok: boolean, checks: object[], summary: string }}
 */
async function handleDoctor({ dir } = {}) {
  const checks = [
    checkNodeVersion(),
    checkOrchestrayInstall(),
    checkMappingsDir(dir),
    checkMappingsValidity(dir),
  ];

  const ok = checks.every(c => c.status !== 'fail');
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;

  let summary;
  if (ok && warnCount === 0) {
    summary = 'apifier-doctor: all checks passed.';
  } else if (ok) {
    summary = `apifier-doctor: all checks passed (${warnCount} warning(s)).`;
  } else {
    summary = `apifier-doctor: ${failCount} check(s) failed.`;
  }

  return { ok, checks, summary };
}

module.exports = {
  handleDoctor,
  checkNodeVersion,
  checkOrchestrayInstall,
  checkMappingsDir,
  checkMappingsValidity,
  ORCHESTRAY_INSTALL_DIR,
};
