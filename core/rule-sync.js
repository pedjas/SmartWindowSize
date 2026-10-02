/**
 * Defines deterministic SmartWindowSize rule identity and compact cloud rule
 * records. It deliberately shares matcher canonicalization with local rule
 * validation so independently migrated installations identify equal scopes.
 */
import { canonicalizeScopeValue, scopeForUrl } from "./rule-matcher.js";

/** Creates the readable matching key used as the sole input to a sync hash. @param {object} scope Rule scope. @returns {string|null} Canonical key or null for invalid input. */
export function canonicalMatchKey(scope) {
  const value = canonicalizeScopeValue(scope?.type, scope?.value);
  return value === null ? null : `${scope.type}|${value}`;
}


/** Derives the exact canonical identity that a prospective rule for a URL would use. @param {string} url Source URL. @param {string} type Selected scope type. @returns {string|null} Canonical identity or null while the form is incomplete. */
export function canonicalMatchKeyForUrl(url, type) {
  const value = scopeForUrl(url, type);
  return value === null ? null : canonicalMatchKey({ type, value });
}


/** Computes a portable SHA-256 identifier for one canonical matching scope. @param {object} scope Rule scope. @returns {Promise<string>} Hex sync identifier. */
export async function syncRuleIdForScope(scope) {
  const key = canonicalMatchKey(scope);
  if (key === null) throw new Error("Cannot create a sync identity for an invalid rule scope.");
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}


/** Shortens an opaque technical ID for compact views without hiding either comparison end. @param {string|null|undefined} value Opaque ID. @returns {string} Full short value or prefix-ellipsis-suffix presentation. */
export function abbreviateOpaqueId(value) {
  if (typeof value !== "string" || !value) return "—";
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}


/** Generates one random local installation identifier without machine data. @returns {string} New client identifier. */
export function createClientId() {
  return crypto.randomUUID();
}


/** Returns only the rule behavior shared through browser-native sync. @param {object} rule Local rule. @returns {object} Cloud semantic definition and first-client seed dimensions. */
export function cloudRuleDefinition(rule) {
  return {
    scope: structuredClone(rule.scope),
    rememberPosition: Boolean(rule.position?.enabled),
    rememberMonitor: Boolean(rule.display?.enabled),
    seedWidth: rule.width,
    seedHeight: rule.height
  };
}
