/**
 * Defines SmartWindowSize defaults and validates persisted configuration data.
 * Storage helpers use this module to create and normalize the local schema.
 */
import { scopeForUrl } from "./rule-matcher.js";

/**
 * A canonical target matched against a tab URL.
 * @typedef {object} RuleScope
 * @property {"domain_tree"|"domain_exact"|"url_subpaths"|"url_any_parameters"|"url_exact_parameters"|"url_non_exact_parameters"} type URL coverage type.
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
 * @property {number} defaultWidth Fallback window width in pixels.
 * @property {number} defaultHeight Fallback window height in pixels.
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
export const CONFIG_SCHEMA_VERSION = 5;


/** Immutable default values copied into every new configuration. @type {Readonly<GlobalSettings>} */
export const DEFAULT_GLOBAL = Object.freeze({
  enabled: true,
  useDefaultSize: false,
  defaultWidth: 1200,
  defaultHeight: 960,
  ruleRetentionDays: 180,
  rememberMonitor: false,

  debug: false
});


/** Creates a new configuration using every current default value. @returns {object} Default configuration. */
export function createDefaultConfig() {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, global: { ...DEFAULT_GLOBAL }, rules: [] };
}


/** Checks whether a value is a positive integer accepted for window dimensions. @param {unknown} value Candidate value. @returns {boolean} Whether the value is valid. */
export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}


/** Normalizes untrusted persisted or imported configuration data. @param {unknown} input Candidate configuration. @returns {object} Valid current-schema configuration. */
export function normalizeConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  const global = { ...DEFAULT_GLOBAL, ...(source.global ?? {}) };

  // Remove obsolete default-coverage preferences without discarding saved rules.
  delete global.defaultRememberType;
  delete global.defaultScope;
  delete global.autoRememberByDomainTree;
  global.defaultWidth = isPositiveInteger(global.defaultWidth) ? global.defaultWidth : DEFAULT_GLOBAL.defaultWidth;
  global.defaultHeight = isPositiveInteger(global.defaultHeight) ? global.defaultHeight : DEFAULT_GLOBAL.defaultHeight;
  global.enabled = Boolean(global.enabled);
  global.useDefaultSize = Boolean(global.useDefaultSize);
  global.ruleRetentionDays = [-1, 90, 180, 365, 730].includes(global.ruleRetentionDays) ? global.ruleRetentionDays : DEFAULT_GLOBAL.ruleRetentionDays;
  global.rememberMonitor = Boolean(global.rememberMonitor);
  global.debug = Boolean(global.debug);

  const unique = new Map();
  for (const rule of Array.isArray(source.rules) ? source.rules : []) {
    if (!isValidRule(rule)) continue;
    const normalized = normalizeRule(rule);
    unique.set(`${normalized.scope.type}:${normalized.scope.value}`, normalized);
  }
  return { schemaVersion: CONFIG_SCHEMA_VERSION, global, rules: [...unique.values()] };
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
function normalizedScopeValue(scope) {
  const type = normalizeScopeType(scope.type);
  if (!type || typeof scope.value !== "string") return null;
  if (type.startsWith("domain_")) {
    const hostname = scopeForUrl(`https://${scope.value}/`, type);
    return hostname === scope.value.toLowerCase() ? hostname : null;
  }
  return scopeForUrl(scope.value, type);
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
    lastUpdatedAt: typeof rule.lastUpdatedAt === "string" && !Number.isNaN(Date.parse(rule.lastUpdatedAt)) ? rule.lastUpdatedAt : new Date().toISOString()
  };
}


/** Legacy coverage type names mapped to the current explicit URL coverage model. @type {Readonly<Record<string, string>>} */
const LEGACY_SCOPE_TYPES = Object.freeze({ domain: "domain_tree", subdomain: "domain_exact", path: "url_subpaths", page: "url_exact_parameters" });


/** Current coverage type names accepted by persisted configuration. @type {ReadonlySet<string>} */
const SCOPE_TYPES = new Set(["domain_tree", "domain_exact", "url_subpaths", "url_any_parameters", "url_exact_parameters", "url_non_exact_parameters"]);


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
  for (const key of ["enabled", "useDefaultSize", "rememberMonitor", "debug"]) {
    if (key in input.global && typeof input.global[key] !== "boolean") throw new Error(`Invalid setting: ${key}.`);
  }
  for (const key of ["defaultWidth", "defaultHeight"]) {
    if (key in input.global && (!Number.isInteger(input.global[key]) || input.global[key] < (key === "defaultWidth" ? 320 : 240))) throw new Error(`Invalid setting: ${key}.`);
  }
  if ("ruleRetentionDays" in input.global && ![-1, 90, 180, 365, 730].includes(input.global.ruleRetentionDays)) throw new Error("Invalid rule retention period.");
  const ids = new Set();
  const scopes = new Set();
  for (const rule of input.rules) {
    if (!isValidRule(rule) || typeof rule.id !== "string" || !rule.id || ids.has(rule.id)) throw new Error("Invalid or duplicate rule identifier.");
    const type = normalizeScopeType(rule.scope.type);
    const value = rule.scope.value;
    const canonical = scopeForUrl(type.startsWith("domain_") ? `https://${value}/` : value, type);
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
