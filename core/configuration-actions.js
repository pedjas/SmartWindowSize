/**
 * Validates granular Configuration and site-dialog transactions.
 * The background storage queue calls these pure operations against fresh data.
 */
import { createDefaultConfig, validateConfigImport } from "./config.js";
import { matchingRulesForUrl } from "./rule-resolver.js";
import { ruleMatchesUrl, toUrl } from "./rule-matcher.js";


/** Compares JSON data while ignoring object-key and rule-list order. @param {unknown} value JSON value. @returns {string} Stable comparison string. */
export function fingerprint(value) {
  if (Array.isArray(value)) return `[${value.map(fingerprint).sort().join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${fingerprint(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}


/** Prevents a stale UI snapshot from overwriting more recent data. @param {unknown} current Latest target. @param {unknown} base UI snapshot. @returns {void} Throws on conflict. */
function requireUnchanged(current, base) {
  if (fingerprint(current) !== fingerprint(base)) throw new Error("These settings changed in another window. Reload before saving; your changes have not been written.");
}


/** Applies a narrow Configuration-page operation to the latest state. @param {object} config Latest configuration. @param {object} message Validated action envelope. @returns {object} Candidate configuration. */
export function applyConfigurationAction(config, message) {
  if (message.type === "save-global-settings") {
    requireUnchanged(config.global, message.base);
    const candidate = validateConfigImport({ ...config, global: message.global });
    return { ...config, global: candidate.global };
  }
  if (message.type === "delete-rule") {
    const current = config.rules.find((rule) => rule.id === message.ruleId);
    if (!current) return config;
    requireUnchanged(current, message.base);
    const syncId = current.sync?.id;
    const tombstones = { ...(config.sync?.tombstones ?? {}) };
    if (syncId) tombstones[syncId] = { id: syncId, revision: current.sync.revision + 1, modifiedAt: new Date().toISOString(), modifiedByClientId: config.sync.clientId, deleted: true };
    return { ...config, sync: { ...config.sync, tombstones }, rules: config.rules.filter((rule) => rule.id !== message.ruleId) };
  }
  if (message.type === "set-rule-enabled") {
    const current = config.rules.find((rule) => rule.id === message.ruleId);
    if (!current) return config;
    requireUnchanged(current, message.base);
    if (typeof message.enabled !== "boolean") throw new Error("Invalid rule enabled state.");
    return { ...config, rules: config.rules.map((rule) => rule.id === current.id ? { ...rule, enabled: message.enabled } : rule) };
  }
  if (message.type === "import-configuration" || message.type === "reset-configuration") {
    requireUnchanged(config, message.base);
    if (message.type === "reset-configuration") {
      const reset = createDefaultConfig();
      return { ...reset, sync: { clientId: config.sync.clientId, tombstones: {} } };
    }
    const imported = validateConfigImport(message.config);
    // Backup sync history is local bookkeeping, not portable cloud authority.
    // Retaining its original schema marker lets storage assign legacy metadata.
    return {
      ...imported,
      schemaVersion: message.config.schemaVersion,
      sync: { clientId: config.sync.clientId, tombstones: {} }
    };
  }
  throw new Error("Unsupported configuration action.");
}


/** Replaces only the matching rules after checking the dialog snapshot and URL. @param {object} config Latest configuration. @param {string} url Current source URL. @param {object} message Dialog transaction. @returns {object} Atomically staged configuration. */
export function applySiteRuleEdits(config, url, message) {
  if (!config.global.enabled) throw new Error("SmartWindowSize is disabled.");
  if (!toUrl(url) || url !== message.url) throw new Error("The source page changed. Reload this dialog before saving.");
  const current = matchingRulesForUrl(url, config);
  requireUnchanged(current, message.baseRules);
  if (!Array.isArray(message.rules) || message.rules.some((rule) => !ruleMatchesUrl(rule, url))) throw new Error("Every edited rule must cover the source page.");
  const currentIds = new Set(current.map((rule) => rule.id));
  const candidate = validateConfigImport({ ...config, rules: [...config.rules.filter((rule) => !currentIds.has(rule.id)), ...message.rules] });
  const beforeById = new Map(current.map((rule) => [rule.id, rule]));
  const afterById = new Map(candidate.rules.map((rule) => [rule.id, rule]));
  const tombstones = { ...(candidate.sync?.tombstones ?? {}) };
  for (const [id, before] of beforeById) {
    const after = afterById.get(id);
    if (!after || before.scope.type !== after.scope.type || before.scope.value !== after.scope.value) {
      if (before.sync?.id) tombstones[before.sync.id] = { id: before.sync.id, revision: before.sync.revision + 1, modifiedAt: new Date().toISOString(), modifiedByClientId: candidate.sync.clientId, deleted: true };
      if (after) delete after.sync;
      continue;
    }
    if (before.sync && (before.position.enabled !== after.position.enabled || before.display.enabled !== after.display.enabled)) {
      after.sync = { ...before.sync, revision: before.sync.revision + 1, modifiedAt: new Date().toISOString(), modifiedByClientId: candidate.sync.clientId, origin: "user", conflict: null };
    }
  }
  return { ...candidate, sync: { ...candidate.sync, tombstones } };
}
