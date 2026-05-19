'use strict';

// lib/mapping/migrate.js — Forward-compat migration stub; v1→v1 is a no-op seam.

/**
 * Migrate a mapping from its current schema_version toward the latest.
 * Real migrations land here when schema_version bumps (see W2-mapping-schema §6.2).
 * For v1→v1 this is an identity transform.
 *
 * @param {object} mapping - Mapping object as read from disk.
 * @returns {{ mapping: object, applied: string[] }}
 */
function migrate(mapping) {
  // No migrations defined for schema_version 1.
  return { mapping, applied: [] };
}

module.exports = { migrate };
