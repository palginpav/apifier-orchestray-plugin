'use strict';

// lib/registry.js — Mapping directory stub for v0.0.1.
// getMappingDir() returns the default mappings path and creates it on first call.
// Real CRUD (list, read, write, delete) lands in Wave 3.

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Return the default mappings directory path, creating it if it does not exist.
 * Uses os.homedir() per W2 §4.3 (no direct process.env.HOME reads).
 * @returns {string} Absolute path to the mappings directory.
 */
function getMappingDir() {
  const dir = path.join(os.homedir(), '.orchestray', 'apifier', 'mappings');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

module.exports = { getMappingDir };
