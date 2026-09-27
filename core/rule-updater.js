/**
 * Updates the narrowest matching rule without changing its identity or coverage.
 * Resize handlers and toolbar actions share opt-in creation and retention logic.
 */
import { createRuleId } from "./config.js";
import { scopeForUrl } from "./rule-matcher.js";
import { resolveRule } from "./rule-resolver.js";


/** Updates the resolved rule with a user-observed window size. @param {object} config Normalized configuration. @param {object} context Source URL and optional position/display ID. @param {number} width Window width in pixels. @param {number} height Window height in pixels. @returns {{config: object, rule: object|null, changed: boolean}} Updated result. */
export function updateRuleForResize(config, context, width, height) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error("Invalid window size.");
  const resolved = resolveRule(context.url, config);
  if (resolved.status === "DISABLED") return { config, rule: null, changed: false };
  const type = resolved.rule?.scope.type ?? "domain_tree";
  const value = resolved.rule?.scope.value ?? scopeForUrl(context.url, type);
  if (!value) return { config, rule: null, changed: false };
  const index = resolved.rule ? config.rules.findIndex((rule) => rule.id === resolved.rule.id) : -1;
  const next = structuredClone(config);
  const patch = { width, height, lastUpdatedAt: new Date().toISOString() };
  const currentPositionEnabled = index >= 0 && next.rules[index].position.enabled;
  if (context.position && currentPositionEnabled) patch.position = { enabled: true, x: context.position.x, y: context.position.y };
  if (context.displayId && next.global.rememberMonitor) patch.display = { enabled: true, id: context.displayId };
  if (index >= 0) {
    const current = next.rules[index];
    const samePosition = !patch.position || current.position.enabled === patch.position.enabled && current.position.x === patch.position.x && current.position.y === patch.position.y;
    const sameDisplay = !patch.display || current.display.enabled === patch.display.enabled && current.display.id === patch.display.id;
    if (current.width === width && current.height === height && samePosition && sameDisplay) return { config, rule: current, changed: false };
    next.rules[index] = { ...next.rules[index], ...patch };
    return { config: next, rule: next.rules[index], changed: true };
  }
  if (!config.global.autoRememberByDomainTree) return { config, rule: null, changed: false };
  const rule = {
    id: createRuleId(), scope: { type, value }, enabled: true, width, height,
    position: patch.position ?? { enabled: false, x: null, y: null },
    display: patch.display ?? { enabled: false, id: null }, lastUpdatedAt: patch.lastUpdatedAt
  };
  next.rules.push(rule);
  return { config: next, rule, changed: true };
}

/** Deletes one persisted rule by its stable identifier. @param {object} config Normalized configuration. @param {string} ruleId Stable identifier to remove. @returns {{config: object, changed: boolean}} Updated configuration result. */
export function deleteRuleById(config, ruleId) {
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  if (index < 0) return { config, changed: false };
  const next = structuredClone(config);
  next.rules.splice(index, 1);
  return { config: next, changed: true };
}


/** Removes enabled rules that have not been updated within the configured retention period. @param {object} config Normalized configuration. @param {number} now Current timestamp in milliseconds. @returns {{config: object, changed: boolean}} Updated configuration result. */
export function pruneExpiredRules(config, now = Date.now()) {
  if (config.global.ruleRetentionDays === -1) return { config, changed: false };
  const cutoff = now - config.global.ruleRetentionDays * 24 * 60 * 60 * 1000;
  const rules = config.rules.filter((rule) => rule.enabled === false || Date.parse(rule.lastUpdatedAt) >= cutoff);
  if (rules.length === config.rules.length) return { config, changed: false };
  return { config: { ...structuredClone(config), rules }, changed: true };
}


/**
 * Updates dimensions of one existing rule after an automatic screen-bound adjustment.
 *
 * @param {object} config Normalized configuration.
 * @param {string} ruleId Stable identifier of the rule to update.
 * @param {number} width Applied outer-window width in pixels.
 * @param {number} height Applied outer-window height in pixels.
 * @returns {{config: object, changed: boolean}} Updated configuration result.
 */
export function updateRuleDimensions(config, ruleId, width, height) {
  const index = config.rules.findIndex((rule) => rule.id === ruleId);
  if (index < 0 || config.rules[index].width === width && config.rules[index].height === height) return { config, changed: false };
  const next = structuredClone(config);
  next.rules[index] = { ...next.rules[index], width, height, lastUpdatedAt: new Date().toISOString() };
  return { config: next, changed: true };
}
