/**
 * Converts supported web URLs into comparable SmartWindowSize rule coverage values.
 * The resolver and rule updater share these functions to keep matching consistent.
 */


/** Rule coverage order from most specific to least specific. @type {readonly string[]} */
export const SCOPE_PRIORITY = Object.freeze(["url_exact_parameters", "url_non_exact_parameters", "url_any_parameters", "url_subpaths", "domain_exact", "domain_www_pair", "domain_tree"]);


/** Parses an HTTP(S) URL and rejects unsupported browser or malformed URLs. @param {string} urlText URL text from a browser API. @returns {URL|null} Parsed supported URL or null. */
export function toUrl(urlText) {
  try {
    const parsed = new URL(urlText);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}


/** Returns an order-independent canonical query string with duplicate entries preserved. @param {URLSearchParams} parameters URL parameters to canonicalize. @returns {string} Canonical query string without its leading question mark. */
export function canonicalQuery(parameters) {
  return [...parameters.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}


/** Builds the stable origin and pathname component shared by URL-based coverage types. @param {URL} url Parsed supported URL. @returns {string} Origin and pathname without query parameters. */
export function urlBase(url) {
  return `${url.origin}${url.pathname}`;
}


/** Builds the canonical value for a requested rule coverage type. @param {string} urlText Current tab URL. @param {string} type Requested coverage type. @returns {string|null} Canonical coverage value or null. */
export function scopeForUrl(urlText, type) {
  const url = toUrl(urlText);
  if (!url) return null;
  if (type === "domain_tree") return url.hostname.toLowerCase().replace(/^www\./, "");
  if (type === "domain_www_pair") return url.hostname.toLowerCase().replace(/^www\./, "");
  if (type === "domain_exact") return url.hostname.toLowerCase();
  if (type === "url_subpaths" || type === "url_any_parameters") return urlBase(url);
  if (type === "url_exact_parameters" || type === "url_non_exact_parameters") return `${urlBase(url)}?${canonicalQuery(url.searchParams)}`;
  return null;
}


/**
 * Converts a persisted scope value into the exact normalized value used by the
 * matcher. Configuration validation, duplicate detection, legacy migration,
 * and sync identity must all call this function rather than interpret raw
 * stored values independently.
 *
 * @param {string} type Normalized rule coverage type.
 * @param {string} value Candidate persisted scope value.
 * @returns {string|null} Canonical matching value, or null when invalid.
 */
export function canonicalizeScopeValue(type, value) {
  if (typeof value !== "string") return null;
  if (type === "domain_tree" || type === "domain_www_pair" || type === "domain_exact") {
    const hostname = scopeForUrl(`https://${value}/`, type);
    const raw = value.toLowerCase();
    return type === "domain_tree" || type === "domain_www_pair" ? (raw === hostname || raw === `www.${hostname}` ? hostname : null) : (hostname === raw ? hostname : null);
  }
  return scopeForUrl(value, type);
}


/** Checks whether a URL pathname equals a stored prefix or is a descendant at a path boundary. @param {string} storedBase Stored origin and pathname prefix. @param {URL} url Candidate URL. @returns {boolean} Whether the URL is covered by the stored prefix. */
function matchesPathAndSubpaths(storedBase, url) {
  const candidate = urlBase(url);
  if (candidate === storedBase) return true;
  return candidate.startsWith(storedBase.endsWith("/") ? storedBase : `${storedBase}/`);
}


/** Checks whether every stored query parameter and value exists in a candidate URL. @param {URLSearchParams} required Stored required parameters. @param {URLSearchParams} candidate Candidate URL parameters. @returns {boolean} Whether required entries are present with matching multiplicity. */
function containsQueryEntries(required, candidate) {
  const remaining = new Map();
  for (const [key, value] of candidate.entries()) {
    const entry = `${key}\u0000${value}`;
    remaining.set(entry, (remaining.get(entry) ?? 0) + 1);
  }
  for (const [key, value] of required.entries()) {
    const entry = `${key}\u0000${value}`;
    const count = remaining.get(entry) ?? 0;
    if (count === 0) return false;
    remaining.set(entry, count - 1);
  }
  return true;
}


/** Determines whether a rule applies to a URL according to its coverage type. @param {object} rule Stored rule. @param {string} urlText Current tab URL. @returns {boolean} Whether the rule applies. */
export function ruleMatchesUrl(rule, urlText) {
  const url = toUrl(urlText);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (rule.scope.type === "domain_tree") return host === rule.scope.value || host.endsWith(`.${rule.scope.value}`);
  if (rule.scope.type === "domain_exact") return host === rule.scope.value;
  if (rule.scope.type === "domain_www_pair") return host === rule.scope.value || host === `www.${rule.scope.value}`;
  if (rule.scope.type === "url_subpaths") return matchesPathAndSubpaths(rule.scope.value, url);
  if (rule.scope.type === "url_any_parameters") return rule.scope.value === urlBase(url);
  const separator = rule.scope.value.indexOf("?");
  if (separator < 0 || rule.scope.value.slice(0, separator) !== urlBase(url)) return false;
  const required = new URLSearchParams(rule.scope.value.slice(separator + 1));
  if (rule.scope.type === "url_exact_parameters") return canonicalQuery(required) === canonicalQuery(url.searchParams);
  if (rule.scope.type === "url_non_exact_parameters") return containsQueryEntries(required, url.searchParams);
  return false;
}
