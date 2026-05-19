'use strict';

// lib/diff/compare.js — Pure SemVer-classified comparison of two apifier-mapping objects.
// No I/O; no require('fs'). Inputs come entirely through function arguments.

/**
 * @typedef {Object} Change
 * @property {string}  kind   - Category from the SemVer classification table.
 * @property {string}  path   - Dotted path to the changed location.
 * @property {string}  impact - "breaking" | "non_breaking" | "patch"
 * @property {string}  detail - Human-readable description.
 * @property {*}       [before] - Value in mapping_a (optional).
 * @property {*}       [after]  - Value in mapping_b (optional).
 *
 * @typedef {Object} ChangeReport
 * @property {string}   verdict       - "compatible" | "patch" | "minor" | "major"
 * @property {Object}   counts        - { breaking, non_breaking, patch, total }
 * @property {Change[]} breaking      - Sorted by path.
 * @property {Change[]} non_breaking  - Sorted by path.
 * @property {Change[]} patch         - Sorted by path.
 * @property {Object}   summary       - { added_endpoints, removed_endpoints, modified_endpoints,
 *                                        added_models, removed_models, added_auth, removed_auth }
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable JSON stringify for type comparison.
 * @param {*} v
 * @returns {string}
 */
function _typeKey(v) {
  if (v === null || v === undefined) return String(v);
  return JSON.stringify(v);
}

/**
 * Build a lookup map from an array using a key function.
 * @template T
 * @param {T[]} arr
 * @param {function(T): string} keyFn
 * @returns {Map<string, T>}
 */
function _toMap(arr, keyFn) {
  const m = new Map();
  if (!Array.isArray(arr)) return m;
  for (const item of arr) {
    m.set(keyFn(item), item);
  }
  return m;
}

/**
 * Endpoint identity key: "<METHOD> <path>".
 * @param {object} ep
 * @returns {string}
 */
function _epKey(ep) {
  return `${ep.method} ${ep.path}`;
}

/**
 * Collect enum values as a sorted Set for comparison.
 * @param {*[]=} enumArr
 * @returns {Set<string>}
 */
function _enumSet(enumArr) {
  if (!Array.isArray(enumArr) || enumArr.length === 0) return new Set();
  return new Set(enumArr.map(v => JSON.stringify(v)));
}

// ---------------------------------------------------------------------------
// Param comparison
// ---------------------------------------------------------------------------

/**
 * Compare two param arrays (path_params, query_params, headers, cookies).
 * @param {object[]} aParams
 * @param {object[]} bParams
 * @param {string}   basePath - Dotted prefix for the Change.path field.
 * @param {Change[]} out      - Output array to push changes into.
 */
function _compareParams(aParams, bParams, basePath, out) {
  const aMap = _toMap(aParams || [], p => p.name);
  const bMap = _toMap(bParams || [], p => p.name);

  for (const [name, aParam] of aMap) {
    const paramPath = `${basePath}.${name}`;
    if (!bMap.has(name)) {
      // Param removed.
      if (aParam.required) {
        out.push({
          kind:   'param_removed',
          path:   paramPath,
          impact: 'breaking',
          detail: `Required param "${name}" removed from ${basePath}.`,
          before: aParam,
        });
      } else {
        out.push({
          kind:   'param_removed',
          path:   paramPath,
          impact: 'non_breaking',
          detail: `Optional param "${name}" removed from ${basePath}.`,
          before: aParam,
        });
      }
    } else {
      const bParam = bMap.get(name);
      // Check type change.
      if (_typeKey(aParam.type) !== _typeKey(bParam.type)) {
        out.push({
          kind:   'param_type_changed',
          path:   paramPath,
          impact: 'breaking',
          detail: `Param "${name}" type changed in ${basePath}.`,
          before: aParam.type,
          after:  bParam.type,
        });
      }
      // Check required → optional or optional → required.
      if (aParam.required === true && bParam.required !== true) {
        out.push({
          kind:   'param_made_optional',
          path:   paramPath,
          impact: 'non_breaking',
          detail: `Param "${name}" made optional in ${basePath}.`,
          before: true,
          after:  false,
        });
      } else if (aParam.required !== true && bParam.required === true) {
        out.push({
          kind:   'param_required_added',
          path:   paramPath,
          impact: 'breaking',
          detail: `Param "${name}" made required in ${basePath}.`,
          before: false,
          after:  true,
        });
      }
      // Enum value delta.
      const aEnum = _enumSet(aParam.enum);
      const bEnum = _enumSet(bParam.enum);
      if (aEnum.size > 0 || bEnum.size > 0) {
        for (const v of aEnum) {
          if (!bEnum.has(v)) {
            out.push({
              kind:   'enum_value_removed',
              path:   `${paramPath}.enum`,
              impact: 'breaking',
              detail: `Enum value ${v} removed from param "${name}" in ${basePath}.`,
              before: JSON.parse(v),
            });
          }
        }
        for (const v of bEnum) {
          if (!aEnum.has(v)) {
            out.push({
              kind:   'enum_value_added',
              path:   `${paramPath}.enum`,
              impact: 'non_breaking',
              detail: `Enum value ${v} added to param "${name}" in ${basePath}.`,
              after:  JSON.parse(v),
            });
          }
        }
      }
      // Description change.
      if ((aParam.description || null) !== (bParam.description || null)) {
        out.push({
          kind:   'description_changed',
          path:   `${paramPath}.description`,
          impact: 'patch',
          detail: `Description changed for param "${name}" in ${basePath}.`,
          before: aParam.description || null,
          after:  bParam.description || null,
        });
      }
    }
  }

  for (const [name, bParam] of bMap) {
    if (!aMap.has(name)) {
      const paramPath = `${basePath}.${name}`;
      if (bParam.required) {
        out.push({
          kind:   'param_added',
          path:   paramPath,
          impact: 'breaking',
          detail: `Required param "${name}" added to ${basePath}.`,
          after:  bParam,
        });
      } else {
        out.push({
          kind:   'param_optional_added',
          path:   paramPath,
          impact: 'non_breaking',
          detail: `Optional param "${name}" added to ${basePath}.`,
          after:  bParam,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Response comparison
// ---------------------------------------------------------------------------

/**
 * Compare two endpoint response maps.
 * @param {object} aResponses - { [statusCode]: ResponseObject }
 * @param {object} bResponses
 * @param {string} basePath
 * @param {Change[]} out
 */
function _compareResponses(aResponses, bResponses, basePath, out) {
  const aMap = aResponses || {};
  const bMap = bResponses || {};

  for (const status of Object.keys(aMap)) {
    const rPath = `${basePath}.responses[${status}]`;
    if (!(status in bMap)) {
      out.push({
        kind:   'response_removed',
        path:   rPath,
        impact: 'breaking',
        detail: `Response status ${status} removed from ${basePath}.`,
        before: aMap[status],
      });
    } else {
      const aResp = aMap[status];
      const bResp = bMap[status];
      // Schema change.
      if (_typeKey(aResp.schema) !== _typeKey(bResp.schema)) {
        // If only example changed (schema is same) this would not trigger.
        // We compare the schema field directly.
        out.push({
          kind:   'response_schema_changed',
          path:   `${rPath}.schema`,
          impact: 'breaking',
          detail: `Response schema for status ${status} changed in ${basePath}.`,
          before: aResp.schema,
          after:  bResp.schema,
        });
      }
      // Description change is patch.
      if ((aResp.description || null) !== (bResp.description || null)) {
        out.push({
          kind:   'description_changed',
          path:   `${rPath}.description`,
          impact: 'patch',
          detail: `Description changed for response ${status} in ${basePath}.`,
          before: aResp.description || null,
          after:  bResp.description || null,
        });
      }
    }
  }

  for (const status of Object.keys(bMap)) {
    if (!(status in aMap)) {
      const rPath = `${basePath}.responses[${status}]`;
      out.push({
        kind:   'response_added',
        path:   rPath,
        impact: 'non_breaking',
        detail: `Response status ${status} added to ${basePath}.`,
        after:  bMap[status],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Auth comparison
// ---------------------------------------------------------------------------

/**
 * Compare top-level auth arrays.
 * @param {object[]} aAuth
 * @param {object[]} bAuth
 * @param {Change[]} out
 */
function _compareAuth(aAuth, bAuth, out) {
  const aMap = _toMap(aAuth || [], s => s.id);
  const bMap = _toMap(bAuth || [], s => s.id);

  for (const [id, aScheme] of aMap) {
    if (!bMap.has(id)) {
      out.push({
        kind:   'auth_removed',
        path:   `auth[${id}]`,
        impact: 'breaking',
        detail: `Auth scheme "${id}" removed.`,
        before: aScheme,
      });
    } else {
      const bScheme = bMap.get(id);
      if (aScheme.type !== bScheme.type) {
        out.push({
          kind:   'auth_scheme_changed',
          path:   `auth[${id}].type`,
          impact: 'breaking',
          detail: `Auth scheme "${id}" type changed from "${aScheme.type}" to "${bScheme.type}".`,
          before: aScheme.type,
          after:  bScheme.type,
        });
      }
    }
  }

  for (const [id, bScheme] of bMap) {
    if (!aMap.has(id)) {
      out.push({
        kind:   'auth_added',
        path:   `auth[${id}]`,
        impact: 'non_breaking',
        detail: `Auth scheme "${id}" added.`,
        after:  bScheme,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Model comparison
// ---------------------------------------------------------------------------

/**
 * Compare two model arrays.
 * @param {object[]} aModels
 * @param {object[]} bModels
 * @param {Change[]} out
 */
function _compareModels(aModels, bModels, out) {
  const aMap = _toMap(aModels || [], m => m.name);
  const bMap = _toMap(bModels || [], m => m.name);

  for (const [name, aModel] of aMap) {
    const modelPath = `models[${name}]`;
    if (!bMap.has(name)) {
      out.push({
        kind:   'model_removed',
        path:   modelPath,
        impact: 'breaking',
        detail: `Model "${name}" removed.`,
        before: aModel,
      });
    } else {
      const bModel = bMap.get(name);
      _compareModelFields(aModel.fields || [], bModel.fields || [], name, out);
      // Description change.
      if ((aModel.description || null) !== (bModel.description || null)) {
        out.push({
          kind:   'description_changed',
          path:   `${modelPath}.description`,
          impact: 'patch',
          detail: `Description changed for model "${name}".`,
          before: aModel.description || null,
          after:  bModel.description || null,
        });
      }
    }
  }

  for (const [name] of bMap) {
    if (!aMap.has(name)) {
      out.push({
        kind:   'model_added',
        path:   `models[${name}]`,
        impact: 'non_breaking',
        detail: `Model "${name}" added.`,
        after:  bMap.get(name),
      });
    }
  }
}

/**
 * Compare fields of two model objects (both are arrays of field objects).
 * @param {object[]} aFields
 * @param {object[]} bFields
 * @param {string}   modelName
 * @param {Change[]} out
 */
function _compareModelFields(aFields, bFields, modelName, out) {
  const aMap = _toMap(aFields, f => f.name);
  const bMap = _toMap(bFields, f => f.name);
  const basePath = `models[${modelName}].fields`;

  for (const [name, aField] of aMap) {
    const fieldPath = `${basePath}.${name}`;
    if (!bMap.has(name)) {
      out.push({
        kind:   'model_field_removed',
        path:   fieldPath,
        impact: 'breaking',
        detail: `Field "${name}" removed from model "${modelName}".`,
        before: aField,
      });
    } else {
      const bField = bMap.get(name);
      // Type change.
      if (_typeKey(aField.type) !== _typeKey(bField.type)) {
        out.push({
          kind:   'model_field_type_changed',
          path:   `${fieldPath}.type`,
          impact: 'breaking',
          detail: `Field "${name}" type changed in model "${modelName}".`,
          before: aField.type,
          after:  bField.type,
        });
      }
      // Enum value delta.
      const aEnum = _enumSet(aField.enum);
      const bEnum = _enumSet(bField.enum);
      if (aEnum.size > 0 || bEnum.size > 0) {
        for (const v of aEnum) {
          if (!bEnum.has(v)) {
            out.push({
              kind:   'enum_value_removed',
              path:   `${fieldPath}.enum`,
              impact: 'breaking',
              detail: `Enum value ${v} removed from field "${name}" in model "${modelName}".`,
              before: JSON.parse(v),
            });
          }
        }
        for (const v of bEnum) {
          if (!aEnum.has(v)) {
            out.push({
              kind:   'enum_value_added',
              path:   `${fieldPath}.enum`,
              impact: 'non_breaking',
              detail: `Enum value ${v} added to field "${name}" in model "${modelName}".`,
              after:  JSON.parse(v),
            });
          }
        }
      }
      // Description change.
      if ((aField.description || null) !== (bField.description || null)) {
        out.push({
          kind:   'description_changed',
          path:   `${fieldPath}.description`,
          impact: 'patch',
          detail: `Description changed for field "${name}" in model "${modelName}".`,
          before: aField.description || null,
          after:  bField.description || null,
        });
      }
    }
  }

  for (const [name, bField] of bMap) {
    if (!aMap.has(name)) {
      const fieldPath = `${basePath}.${name}`;
      if (bField.required === true) {
        out.push({
          kind:   'model_field_added',
          path:   fieldPath,
          impact: 'breaking',
          detail: `Required field "${name}" added to model "${modelName}".`,
          after:  bField,
        });
      } else {
        out.push({
          kind:   'model_field_added',
          path:   fieldPath,
          impact: 'non_breaking',
          detail: `Optional field "${name}" added to model "${modelName}".`,
          after:  bField,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Endpoint-level comparison
// ---------------------------------------------------------------------------

/**
 * Compare two endpoint objects that have the same (method, path) identity key.
 * Walks params, responses, and description.
 * @param {object}   aEp
 * @param {object}   bEp
 * @param {Change[]} out
 */
function _compareEndpointDetail(aEp, bEp, out) {
  const epId = _epKey(aEp);
  const epBase = `endpoints[${epId}]`;

  // Description change.
  if ((aEp.description || null) !== (bEp.description || null)) {
    out.push({
      kind:   'description_changed',
      path:   `${epBase}.description`,
      impact: 'patch',
      detail: `Description changed for endpoint ${epId}.`,
      before: aEp.description || null,
      after:  bEp.description || null,
    });
  }

  // Summary change.
  if ((aEp.summary || null) !== (bEp.summary || null)) {
    out.push({
      kind:   'description_changed',
      path:   `${epBase}.summary`,
      impact: 'patch',
      detail: `Summary changed for endpoint ${epId}.`,
      before: aEp.summary || null,
      after:  bEp.summary || null,
    });
  }

  // Path params.
  _compareParams(aEp.path_params, bEp.path_params, `${epBase}.path_params`, out);
  // Query params.
  _compareParams(aEp.query_params, bEp.query_params, `${epBase}.query_params`, out);
  // Headers.
  _compareParams(aEp.headers, bEp.headers, `${epBase}.headers`, out);
  // Cookies.
  _compareParams(aEp.cookies, bEp.cookies, `${epBase}.cookies`, out);

  // Responses.
  _compareResponses(aEp.responses, bEp.responses, epBase, out);
}

// ---------------------------------------------------------------------------
// Top-level compareMapping
// ---------------------------------------------------------------------------

/**
 * Compare two apifier-mapping objects and return a SemVer-classified ChangeReport.
 *
 * @param {object} a - Baseline mapping (the "old" version).
 * @param {object} b - Candidate mapping (the "new" version).
 * @returns {ChangeReport}
 */
function compareMapping(a, b) {
  if (!a || typeof a !== 'object') throw new TypeError('compareMapping: a must be an object');
  if (!b || typeof b !== 'object') throw new TypeError('compareMapping: b must be an object');

  /** @type {Change[]} */
  const all = [];

  // ---- Endpoints ----
  const aEps = _toMap(a.endpoints || [], _epKey);
  const bEps = _toMap(b.endpoints || [], _epKey);
  let added_endpoints = 0;
  let removed_endpoints = 0;
  let modified_endpoints = 0;

  for (const [key, aEp] of aEps) {
    if (!bEps.has(key)) {
      // Endpoint removed.
      all.push({
        kind:   'endpoint_removed',
        path:   `endpoints[${key}]`,
        impact: 'breaking',
        detail: `Endpoint ${key} removed.`,
        before: aEp,
      });
      removed_endpoints++;
    } else {
      // Endpoint present in both — walk detail.
      const bEp = bEps.get(key);
      const before = all.length;
      _compareEndpointDetail(aEp, bEp, all);
      if (all.length > before) modified_endpoints++;
    }
  }

  for (const [key, bEp] of bEps) {
    if (!aEps.has(key)) {
      all.push({
        kind:   'endpoint_added',
        path:   `endpoints[${key}]`,
        impact: 'non_breaking',
        detail: `Endpoint ${key} added.`,
        after:  bEp,
      });
      added_endpoints++;
    }
  }

  // ---- Auth ----
  _compareAuth(a.auth, b.auth, all);
  const added_auth   = all.filter(c => c.kind === 'auth_added').length;
  const removed_auth = all.filter(c => c.kind === 'auth_removed').length;

  // ---- Models ----
  _compareModels(a.models, b.models, all);
  const added_models   = all.filter(c => c.kind === 'model_added').length;
  const removed_models = all.filter(c => c.kind === 'model_removed').length;

  // ---- Partition into buckets and sort by path ----
  const byImpact = { breaking: [], non_breaking: [], patch: [] };
  for (const c of all) {
    byImpact[c.impact].push(c);
  }

  const sortByPath = arr => arr.slice().sort((x, y) => x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

  const breaking     = sortByPath(byImpact.breaking);
  const non_breaking = sortByPath(byImpact.non_breaking);
  const patch        = sortByPath(byImpact.patch);

  const counts = {
    breaking:     breaking.length,
    non_breaking: non_breaking.length,
    patch:        patch.length,
    total:        all.length,
  };

  // ---- Verdict ----
  let verdict;
  if (counts.breaking > 0)     verdict = 'major';
  else if (counts.non_breaking > 0) verdict = 'minor';
  else if (counts.patch > 0)   verdict = 'patch';
  else                          verdict = 'compatible';

  return {
    verdict,
    counts,
    breaking,
    non_breaking,
    patch,
    summary: {
      added_endpoints,
      removed_endpoints,
      modified_endpoints,
      added_models,
      removed_models,
      added_auth,
      removed_auth,
    },
  };
}

module.exports = { compareMapping };
