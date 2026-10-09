/**
 * Verifies browser-specific manifest boundaries without requiring a running browser.
 * It protects the shared Options page and prevents Firefox fixes from widening
 * Chrome or Firefox page-access permissions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";


/** Reads one JSON manifest fixture from the project root. @param {string} relativePath Project-relative manifest path. @returns {Promise<object>} Parsed manifest. */
async function readManifest(relativePath) {
  return JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}


test("Chrome and Firefox manifests expose the shared Options page without broad page access", async () => {
  const chrome = await readManifest("manifest.json");
  const firefox = await readManifest("manifests/firefox.manifest.json.template");
  assert.equal(chrome.options_page, "options/options.html");
  assert.deepEqual(firefox.options_ui, { page: "options/options.html", open_in_tab: true });
  assert.equal(firefox.options_page, undefined);
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.equal(chrome.host_permissions, undefined);
  assert.equal(firefox.host_permissions, undefined);
  assert.equal(chrome.permissions.includes("activeTab"), false);
  assert.equal(firefox.permissions.includes("activeTab"), false);
  assert.equal(firefox.permissions.includes("windows"), false);
  assert.equal(firefox.permissions.includes("system.display"), false);
  assert.deepEqual(chrome.permissions, ["storage", "tabs", "windows", "contextMenus", "system.display"]);
  assert.equal(chrome.key, "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvmEBnG7zxLUsM/Tt1WY3r34RZEc7rABRBwydWIGOXRO4cfP69wUmG1Ik11nging7qRHOLSXnt0RmA4HxjqwHdOM8sElYl6mXnvGr5LdH83/XD6/nzxui4CKJBTX6SsDZFn85fye0YTZ+h4NH6u0nQ1WUIrHvxFqtyS+/B4YTTV7/nD86KsWT0pcu+ESiJehTSIfF+GZJIzR0qnikAOb3oLdpm4jrJWMB8Xj/gEd0f03j6T70N2RuI5xchsQ0+VZhLwpeSlCG9w1prFoZoR48Nw8uGrpUePTdi+8olEQq1EsU6k0mNlLYk4GwQ6lnOxSFaqkHU+yQzhNkrSCSpV3vCQIDAQAB");
  const chromiumId = [...createHash("sha256").update(Buffer.from(chrome.key, "base64")).digest().subarray(0, 16)]
    .flatMap((byte) => [String.fromCharCode("a".charCodeAt(0) + (byte >> 4)), String.fromCharCode("a".charCodeAt(0) + (byte & 15))]).join("");
  assert.equal(chromiumId, "knonkimekepimholflhdgnogdbjndiaa");
  assert.equal(firefox.key, undefined);
});
