/**
 * Defines SmartWindowSize defaults and validates persisted configuration data.
 * Storage helpers use this module to create and normalize the local schema.
 */
import { canonicalizeScopeValue } from "./rule-matcher.js";

/**
 * A canonical target matched against a tab URL.
 * @typedef {object} RuleScope
 * @property {"domain_tree"|"domain_www_pair"|"domain_exact"|"url_subpaths"|"url_any_parameters"|"url_exact_parameters"|"url_non_exact_parameters"} type URL coverage type.
 * @property {string} value Canonical URL-derived value stored for the scope.
 */


/**
 * Optional window coordinates in screen pixels.
 * @typedef {object} RulePosition
 * @property {boolean} enabled Whether stored coordinates should be restored.
 * @property {number|null} x Horizontal screen coordinate.
 * @property {number|null} y Vertical screen coordinate.
 */


/**
 * Optional saved browser display identifier.
 * @typedef {object} RuleDisplay
 * @property {boolean} enabled Whether the display preference should be restored.
 * @property {string|null} id Browser-provided display ID.
 */


/**
 * A persisted size rule for exactly one scope.
 * @typedef {object} WindowRule
 * @property {string} id Stable rule identifier.
 * @property {RuleScope} scope URL target to which the rule applies.
 * @property {boolean} enabled Whether this rule enables or explicitly disables its scope.
 * @property {number} width Saved window width in pixels.
 * @property {number} height Saved window height in pixels.
 * @property {RulePosition} position Optional saved window position.
 * @property {RuleDisplay} display Optional target display preference.
 * @property {string} lastUpdatedAt ISO timestamp of the last rule change.
 */


/**
 * Shared extension behavior and fallback window dimensions.
 * @typedef {object} GlobalSettings
 * @property {boolean} enabled Global extension switch.
 * @property {number} automaticWidth No-rule automatic window width in pixels.
 * @property {number} automaticHeight No-rule automatic window height in pixels.
 * @property {number} ruleRetentionDays Enabled-rule retention period in days.
 * @property {boolean} rememberMonitor Whether the browser display is saved.
 * @property {boolean} debug Whether local diagnostic output is enabled.
 */


/**
 * Complete persisted extension configuration.
 * @typedef {object} SmartWindowSizeConfig
 * @property {number} schemaVersion Persisted configuration shape version.
 * @property {GlobalSettings} global Shared behavior and defaults.
 * @property {WindowRule[]} rules All stored scope-specific rules.
 */

/** Schema version used to identify the normalized storage format. @type {number} */
export const CONFIG_SCHEMA_VERSION = 7;


/** Immutable default values copied into every new configuration. @type {Readonly<GlobalSettings>} */
export const DEFAULT_GLOBAL = Object.freeze({
  enabled: true,
  useDefaultSize: false,
  automaticWidth: 1200,
  automaticHeight: 960,
  ruleRetentionDays: 180,
  rememberMonitor: false,

  syncRules: false,

  diagnosticLevel: "warnings-errors",

  debug: false
});


/** Creates a new configuration using every current default value. @returns {object} Default configuration. */
export function createDefaultConfig() {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, global: { ...DEFAULT_GLOBAL }, sync: { clientId: null, tombstones: {} }, rules: [] };
}


/** Checks whether a value is a positive integer accepted for window dimensions. @param {unknown} value Candidate value. @returns {boolean} Whether the value is valid. */
export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}


/** Normalizes untrusted persisted or imported configuration data. @param {unknown} input Candidate configuration. @returns {object} Valid current-schema configuration. */
export function normalizeConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  const sourceGlobal = source.global && typeof source.global === "object" ? source.global : {};
  const global = { ...DEFAULT_GLOBAL, ...sourceGlobal };

  // Remove obsolete default-coverage preferences without discarding saved rules.
  delete global.defaultRememberType;
  delete global.defaultScope;
  delete global.autoRememberByDomainTree;
  // Migrate former ambiguous default-size keys without discarding a user's saved dimensions.
  global.automaticWidth = isPositiveInteger(sourceGlobal.automaticWidth) ? sourceGlobal.automaticWidth :
    (isPositiveInteger(sourceGlobal.defaultWidth) ? sourceGlobal.defaultWidth : DEFAULT_GLOBAL.automaticWidth);
  global.automaticHeight = isPositiveInteger(sourceGlobal.automaticHeight) ? sourceGlobal.automaticHeight :
    (isPositiveInteger(sourceGlobal.defaultHeight) ? sourceGlobal.defaultHeight : DEFAULT_GLOBAL.automaticHeight);
  delete global.defaultWidth;
  delete global.defaultHeight;
  global.enabled = Boolean(global.enabled);
  global.useDefaultSize = Boolean(global.useDefaultSize);
  global.ruleRetentionDays = [-1, 90, 180, 365, 730].includes(global.ruleRetentionDays) ? global.ruleRetentionDays : DEFAULT_GLOBAL.ruleRetentionDays;
  global.rememberMonitor = Boolean(global.rememberMonitor);
  global.syncRules = Boolean(global.syncRules);
  global.diagnosticLevel = ["errors", "warnings-errors", "verbose"].includes(global.diagnosticLevel) ? global.diagnosticLevel : DEFAULT_GLOBAL.diagnosticLevel;
  global.debug = Boolean(global.debug);

  const unique = new Map();
  for (const rule of Array.isArray(source.rules) ? source.rules : []) {
    if (!isValidRule(rule)) continue;
    const normalized = normalizeRule(rule);
    unique.set(`${normalized.scope.type}:${normalized.scope.value}`, normalized);
  }
  const sync = source.sync && typeof source.sync === "object" ? source.sync : {};
  const tombstones = Object.fromEntries(Object.entries(sync.tombstones && typeof sync.tombstones === "object" ? sync.tombstones : {}).filter(([, value]) =>
    value && typeof value === "object" && typeof value.id === "string" && Number.isInteger(value.revision) && value.revision > 0));
  return { schemaVersion: CONFIG_SCHEMA_VERSION, global, sync: { clientId: typeof sync.clientId === "string" && sync.clientId ? sync.clientId : null, tombstones }, rules: [...unique.values()] };
}


/** Checks whether a rule has the minimum fields required for persistence. @param {unknown} rule Candidate rule. @returns {boolean} Whether the rule is valid. */
export function isValidRule(rule) {
  return rule && typeof rule === "object" && rule.scope &&
    normalizeScopeType(rule.scope.type) !== null &&
    typeof rule.scope.value === "string" && rule.scope.value.length > 0 &&
    normalizedScopeValue(rule.scope) !== null &&
    isPositiveInteger(rule.width) && isPositiveInteger(rule.height);
}


/** Canonicalizes stored URL coverage without inferring a registrable domain. @param {object} scope Stored scope. @returns {string|null} Valid canonical coverage. */
export function normalizedScopeValue(scope) {
  const type = normalizeScopeType(scope.type);
  return type ? canonicalizeScopeValue(type, scope.value) : null;
}


/** Converts a valid rule into the complete current persistence shape. @param {object} rule Valid source rule. @returns {object} Normalized rule. */
export function normalizeRule(rule) {
  return {
    id: typeof rule.id === "string" && rule.id ? rule.id : createRuleId(),
    scope: { type: normalizeScopeType(rule.scope.type), value: normalizedScopeValue(rule.scope) },
    enabled: rule.enabled !== false,
    width: rule.width,
    height: rule.height,
    position: {
      enabled: Boolean(rule.position?.enabled) && Number.isInteger(rule.position?.x) && Number.isInteger(rule.position?.y),
      x: Number.isInteger(rule.position?.x) ? rule.position.x : null,
      y: Number.isInteger(rule.position?.y) ? rule.position.y : null
    },
    display: {
      enabled: Boolean(rule.display?.enabled) && typeof rule.display?.id === "string" && rule.display.id.length > 0,
      id: typeof rule.display?.id === "string" ? rule.display.id : null
    },
    ...(normalizeRuleSync(rule.sync) ? { sync: normalizeRuleSync(rule.sync) } : {}),
    lastUpdatedAt: typeof rule.lastUpdatedAt === "string" && !Number.isNaN(Date.parse(rule.lastUpdatedAt)) ? rule.lastUpdatedAt : new Date().toISOString()
  };
}


/** Normalizes local-only reconciliation metadata without trusting cloud data. @param {unknown} value Candidate metadata. @returns {object|null} Valid metadata or null for legacy migration. */
function normalizeRuleSync(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id) return null;
  return {
    id: value.id,
    revision: Number.isInteger(value.revision) && value.revision > 0 ? value.revision : 1,
    modifiedAt: typeof value.modifiedAt === "string" && !Number.isNaN(Date.parse(value.modifiedAt)) ? value.modifiedAt : null,
    modifiedByClientId: typeof value.modifiedByClientId === "string" && value.modifiedByClientId ? value.modifiedByClientId : null,
    origin: value.origin === "user" ? "user" : "legacy",
    conflict: value.conflict && typeof value.conflict === "object" ? structuredClone(value.conflict) : null
  };
}


/** Legacy coverage type names mapped to the current explicit URL coverage model. @type {Readonly<Record<string, string>>} */
const LEGACY_SCOPE_TYPES = Object.freeze({ domain: "domain_tree", subdomain: "domain_exact", path: "url_subpaths", page: "url_exact_parameters" });


/** Current coverage type names accepted by persisted configuration. @type {ReadonlySet<string>} */
const SCOPE_TYPES = new Set(["domain_tree", "domain_www_pair", "domain_exact", "url_subpaths", "url_any_parameters", "url_exact_parameters", "url_non_exact_parameters"]);


/** Converts a legacy or current coverage type into the current vocabulary. @param {unknown} type Candidate coverage type. @returns {string|null} Current type or null when unsupported. */
export function normalizeScopeType(type) {
  if (typeof type !== "string") return null;
  return LEGACY_SCOPE_TYPES[type] ?? (SCOPE_TYPES.has(type) ? type : null);
}


/** Creates a stable identifier for a newly persisted rule. @returns {string} Unique rule identifier. */
export function createRuleId() {
  return `rule_${crypto.randomUUID()}`;
}


/** Validates a complete backup before normalization can discard invalid fields. @param {unknown} input Parsed backup. @returns {object} Valid migrated configuration. @throws {Error} For an invalid or unsupported backup. */
export function validateConfigImport(input) {
  if (!input || typeof input !== "object" || !input.global || typeof input.global !== "object" || Array.isArray(input.global) || !Array.isArray(input.rules) ||
      !Number.isInteger(input.schemaVersion) || input.schemaVersion < 1 || input.schemaVersion > CONFIG_SCHEMA_VERSION) throw new Error("Invalid or unsupported configuration backup.");
  for (const key of ["enabled", "useDefaultSize", "rememberMonitor", "debug", "syncRules"]) {
    if (key in input.global && typeof input.global[key] !== "boolean") throw new Error(`Invalid setting: ${key}.`);
  }
  if ("diagnosticLevel" in input.global && !["errors", "warnings-errors", "verbose"].includes(input.global.diagnosticLevel)) throw new Error("Invalid diagnostic detail level.");
  for (const key of ["automaticWidth", "automaticHeight"]) {
    if (key in input.global && (!Number.isInteger(input.global[key]) || input.global[key] < (key === "automaticWidth" ? 320 : 240))) throw new Error(`Invalid setting: ${key}.`);
  }
  if ("ruleRetentionDays" in input.global && ![-1, 90, 180, 365, 730].includes(input.global.ruleRetentionDays)) throw new Error("Invalid rule retention period.");
  const ids = new Set();
  const scopes = new Set();
  for (const rule of input.rules) {
    if (!isValidRule(rule) || typeof rule.id !== "string" || !rule.id || ids.has(rule.id)) throw new Error("Invalid or duplicate rule identifier.");
    const type = normalizeScopeType(rule.scope.type);
    const value = rule.scope.value;
    const canonical = canonicalizeScopeValue(type, value);
    const key = `${type}:${value}`;
    if (canonical !== value || scopes.has(key)) throw new Error("Invalid or duplicate rule coverage.");
    if (typeof rule.enabled !== "boolean" || typeof rule.position?.enabled !== "boolean" || typeof rule.display?.enabled !== "boolean") throw new Error("Invalid rule switches.");
    if (rule.position.enabled && ![rule.position.x, rule.position.y].every(Number.isInteger)) throw new Error("Invalid rule position.");
    if (rule.display.enabled && (typeof rule.display.id !== "string" || !rule.display.id)) throw new Error("Invalid rule display.");
    if (rule.lastUpdatedAt !== undefined && (typeof rule.lastUpdatedAt !== "string" || Number.isNaN(Date.parse(rule.lastUpdatedAt)))) throw new Error("Invalid rule timestamp.");
    ids.add(rule.id);
    scopes.add(key);
  }
  return normalizeConfig(input);
}
