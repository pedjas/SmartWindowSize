/** Verifies the authoritative rule-type registry drives every shared membership and ordering view. */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeScopeType } from "../core/config.js";
import { SCOPE_PRIORITY, ruleMatchesUrl, scopeForUrl } from "../core/rule-matcher.js";
import { RULE_TYPE_DESCRIPTORS, RULE_TYPE_LABELS, RULE_TYPE_REGISTRY, RULE_TYPE_TYPES } from "../core/rule-types.js";


const EXPECTED_UI_TYPES = [
  "domain_tree",
  "domain_www_pair",
  "domain_exact",
  "url_subpaths",
  "url_any_parameters",
  "url_exact_parameters",
  "url_non_exact_parameters"
];

const EXPECTED_MATCH_PRIORITY = [
  "url_exact_parameters",
  "url_non_exact_parameters",
  "url_any_parameters",
  "url_subpaths",
  "domain_exact",
  "domain_www_pair",
  "domain_tree"
];


test("authoritative rule-type registry is unique and contains every supported type", () => {
  assert.deepEqual(RULE_TYPE_REGISTRY.map(({ type }) => type), EXPECTED_UI_TYPES);
  assert.equal(new Set(RULE_TYPE_REGISTRY.map(({ type }) => type)).size, RULE_TYPE_REGISTRY.length);
  assert.equal(new Set(RULE_TYPE_REGISTRY.map(({ uiOrder }) => uiOrder)).size, RULE_TYPE_REGISTRY.length);
  assert.equal(new Set(RULE_TYPE_REGISTRY.map(({ matchPriority }) => matchPriority)).size, RULE_TYPE_REGISTRY.length);
  for (const descriptor of RULE_TYPE_REGISTRY) {
    assert.equal(typeof descriptor.label, "string", descriptor.type);
    assert.ok(descriptor.label.length > 0, descriptor.type);
    assert.ok(Number.isInteger(descriptor.uiOrder) && descriptor.uiOrder > 0, descriptor.type);
    assert.ok(Number.isInteger(descriptor.matchPriority) && descriptor.matchPriority > 0, descriptor.type);
  }
});


test("UI descriptors and labels derive from the registry without changing UI order", () => {
  assert.deepEqual(RULE_TYPE_TYPES, EXPECTED_UI_TYPES);
  assert.deepEqual(RULE_TYPE_DESCRIPTORS.map(({ type }) => type), EXPECTED_UI_TYPES);
  assert.deepEqual(RULE_TYPE_DESCRIPTORS.map(({ label }) => label), EXPECTED_UI_TYPES.map((type) => RULE_TYPE_LABELS[type]));
  assert.equal(RULE_TYPE_LABELS.domain_www_pair, "Domain with and without www");
  assert.equal(RULE_TYPE_DESCRIPTORS.find(({ type }) => type === "domain_www_pair")?.type, "domain_www_pair");
});


test("matcher priority derives from the registry and preserves existing precedence", () => {
  assert.deepEqual(SCOPE_PRIORITY, EXPECTED_MATCH_PRIORITY);
  assert.deepEqual(SCOPE_PRIORITY, [...RULE_TYPE_REGISTRY]
    .sort((left, right) => left.matchPriority - right.matchPriority)
    .map(({ type }) => type));
  assert.deepEqual(new Set(SCOPE_PRIORITY), new Set(RULE_TYPE_TYPES));
});


test("unknown types remain unsupported across registry, validation, and matcher paths", () => {
  assert.equal(RULE_TYPE_LABELS.unknown_scope, undefined);
  assert.equal(normalizeScopeType("unknown_scope"), null);
  assert.equal(scopeForUrl("https://example.com/path", "unknown_scope"), null);
  assert.equal(ruleMatchesUrl({ scope: { type: "unknown_scope", value: "example.com" } }, "https://example.com/path"), false);
});


test("domain-www-pair remains registered, canonicalized, and matched with its existing semantics", () => {
  const descriptor = RULE_TYPE_REGISTRY.filter(({ type }) => type === "domain_www_pair");
  assert.equal(descriptor.length, 1);
  assert.equal(descriptor[0].uiOrder, 2);
  assert.equal(SCOPE_PRIORITY.indexOf("domain_www_pair"), 5);
  assert.equal(scopeForUrl("https://www.example.com/path", "domain_www_pair"), "example.com");
  const rule = { scope: { type: "domain_www_pair", value: "example.com" } };
  assert.equal(ruleMatchesUrl(rule, "https://example.com/path"), true);
  assert.equal(ruleMatchesUrl(rule, "https://www.example.com/path"), true);
  assert.equal(ruleMatchesUrl(rule, "https://shop.example.com/path"), false);
});
