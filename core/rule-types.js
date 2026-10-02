/** User-facing descriptor for every supported persisted rule type. */
export const RULE_TYPE_DESCRIPTORS = Object.freeze([
  Object.freeze({ type: "domain_tree", label: "This domain and its subdomains" }),
  Object.freeze({ type: "domain_www_pair", label: "Domain with and without www" }),
  Object.freeze({ type: "domain_exact", label: "Exact hostname" }),
  Object.freeze({ type: "url_subpaths", label: "This URL and its subpaths" }),
  Object.freeze({ type: "url_any_parameters", label: "This URL — any parameters" }),
  Object.freeze({ type: "url_exact_parameters", label: "This URL — exact query parameters" }),
  Object.freeze({ type: "url_non_exact_parameters", label: "This URL — non-exact query parameters" })
]);

/** Single label source for popup, Configuration, and rule-editor surfaces. */
export const RULE_TYPE_LABELS = Object.freeze(Object.fromEntries(RULE_TYPE_DESCRIPTORS.map(({ type, label }) => [type, label])));
