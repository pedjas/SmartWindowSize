/**
 * Authoritative registration for every supported persisted rule type.
 * UI order and matcher priority deliberately remain independent semantics.
 */
export const RULE_TYPE_REGISTRY = Object.freeze([
  Object.freeze({ type: "domain_tree", label: "This domain and its subdomains", uiOrder: 1, matchPriority: 7 }),
  Object.freeze({ type: "domain_www_pair", label: "Domain with and without www", uiOrder: 2, matchPriority: 6 }),
  Object.freeze({ type: "domain_exact", label: "Exact hostname", uiOrder: 3, matchPriority: 5 }),
  Object.freeze({ type: "url_subpaths", label: "This URL and its subpaths", uiOrder: 4, matchPriority: 4 }),
  Object.freeze({ type: "url_any_parameters", label: "This URL — any parameters", uiOrder: 5, matchPriority: 3 }),
  Object.freeze({ type: "url_exact_parameters", label: "This URL — exact query parameters", uiOrder: 6, matchPriority: 1 }),
  Object.freeze({ type: "url_non_exact_parameters", label: "This URL — non-exact query parameters", uiOrder: 7, matchPriority: 2 })
]);

/** User-facing descriptors derived from the authoritative registry in UI order. */
export const RULE_TYPE_DESCRIPTORS = Object.freeze([...RULE_TYPE_REGISTRY]
  .sort((left, right) => left.uiOrder - right.uiOrder)
  .map(({ type, label }) => Object.freeze({ type, label })));

/** Supported persisted rule types derived from the authoritative registry. */
export const RULE_TYPE_TYPES = Object.freeze(RULE_TYPE_DESCRIPTORS.map(({ type }) => type));

/** Single label source for popup, Configuration, and rule-editor surfaces. */
export const RULE_TYPE_LABELS = Object.freeze(Object.fromEntries(RULE_TYPE_DESCRIPTORS.map(({ type, label }) => [type, label])));
