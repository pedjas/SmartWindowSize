/** Tests deterministic matcher identity and local-only cloud-definition boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeScopeValue } from "../core/rule-matcher.js";
import { abbreviateOpaqueId, canonicalMatchKey, cloudRuleDefinition, syncRuleIdForScope } from "../core/rule-sync.js";

test("canonical scope values reuse the matcher semantics for domains, paths, and queries", async () => {
  assert.equal(canonicalizeScopeValue("domain_tree", "EXAMPLE.com"), "example.com");
  assert.equal(canonicalizeScopeValue("url_any_parameters", "HTTPS://EXAMPLE.com:443/path?view=wide"), "https://example.com/path");
  assert.equal(canonicalizeScopeValue("url_exact_parameters", "https://example.com/search?b=2&a=1"), "https://example.com/search?a=1&b=2");
  assert.equal(await syncRuleIdForScope({ type: "url_exact_parameters", value: "https://example.com/search?b=2&a=1" }),
    await syncRuleIdForScope({ type: "url_exact_parameters", value: "https://example.com/search?a=1&b=2" }));
  assert.notEqual(canonicalMatchKey({ type: "domain_tree", value: "example.com" }), canonicalMatchKey({ type: "domain_exact", value: "example.com" }));
});


test("domain-tree removes only leading www while exact and URL scopes remain distinct", async () => {
  assert.equal(canonicalizeScopeValue("domain_tree", "www.example.com"), "example.com");
  assert.equal(canonicalizeScopeValue("domain_tree", "example.com"), "example.com");
  assert.equal(canonicalizeScopeValue("domain_exact", "www.example.com"), "www.example.com");
  assert.notEqual(canonicalMatchKey({ type: "domain_exact", value: "www.example.com" }), canonicalMatchKey({ type: "domain_exact", value: "example.com" }));
  assert.equal(canonicalizeScopeValue("url_subpaths", "https://www.example.com/docs"), "https://www.example.com/docs");
  assert.equal(await syncRuleIdForScope({ type: "domain_tree", value: "www.example.com" }), await syncRuleIdForScope({ type: "domain_tree", value: "example.com" }));
  assert.equal(canonicalizeScopeValue("domain_www_pair", "www.example.com"), "example.com");
  assert.equal(await syncRuleIdForScope({ type: "domain_www_pair", value: "www.example.com" }), await syncRuleIdForScope({ type: "domain_www_pair", value: "example.com" }));
  assert.notEqual(canonicalMatchKey({ type: "domain_www_pair", value: "example.com" }), canonicalMatchKey({ type: "domain_tree", value: "example.com" }));
});


test("sync IDs are the first 128 bits of SHA-256 and compact IDs retain both ends", async () => {
  const identity = "domain_tree|example.com";
  const full = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const expected = [...new Uint8Array(full).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const actual = await syncRuleIdForScope({ type: "domain_tree", value: "EXAMPLE.com" });
  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{32}$/);
  assert.equal(abbreviateOpaqueId(actual), `${actual.slice(0, 8)}…${actual.slice(-8)}`);
});

test("cloud definitions exclude enabled state and local geometry", () => {
  const definition = cloudRuleDefinition({ scope: { type: "domain_tree", value: "example.com" }, enabled: false, width: 900, height: 700,
    position: { enabled: true, x: 20, y: 30 }, display: { enabled: true, id: "monitor-1" } });
  assert.deepEqual(definition, { scope: { type: "domain_tree", value: "example.com" }, rememberPosition: true, rememberMonitor: true, seedWidth: 900, seedHeight: 700 });
});
