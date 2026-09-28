import { SCOPE_PRIORITY, ruleMatchesUrl } from "./rule-matcher.js";


/**
 * Resolves the highest-priority rule for a URL according to the specification.
 * Popup and service-worker code use the same result to avoid priority drift.
 */

/** Resolves one URL against global settings and stored rules. @param {string} url Current tab URL. @param {object} config Normalized configuration. @returns {object} Resolution state, reason, rule, and default size when applicable. */
export function resolveRule(url, config) {
  if (!config.global.enabled) return { status: "DISABLED", reason: "global-disabled", rule: null };
  for (const type of SCOPE_PRIORITY) {
    const matches = config.rules.filter((rule) => rule.scope.type === type && ruleMatchesUrl(rule, url));
    if (!matches.length) continue;

    // A disabled matching rule is an explicit opt-out at its own scope.
    const rule = matches.sort((a, b) => b.scope.value.length - a.scope.value.length)[0];
    return rule.enabled
      ? { status: "RULE", reason: type, rule }
      : { status: "DISABLED", reason: `${type}-disabled`, rule };
  }
  if (!config.global.useDefaultSize) return { status: "NONE", reason: "no-matching-rule", rule: null };
  return {
    status: "DEFAULT",
    reason: "no-matching-rule",
    rule: null,
    size: { width: config.global.automaticWidth, height: config.global.automaticHeight }
  };
}


/** Lists every stored rule that covers a URL in application priority order. @param {string} url Current tab URL. @param {object} config Normalized configuration. @returns {object[]} Matching rules from narrowest to broadest coverage. */
export function matchingRulesForUrl(url, config) {
  return SCOPE_PRIORITY.flatMap((type) => config.rules
    .filter((rule) => rule.scope.type === type && ruleMatchesUrl(rule, url))
    .sort((left, right) => right.scope.value.length - left.scope.value.length));
}
