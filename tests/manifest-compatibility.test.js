/**
 * Verifies browser-specific manifest boundaries without requiring a running browser.
 * It protects the shared Options page and prevents Firefox fixes from widening
 * Chrome or Firefox page-access permissions.
 */
import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "115.0");
  assert.equal(chrome.host_permissions, undefined);
  assert.equal(firefox.host_permissions, undefined);
  assert.equal(chrome.permissions.includes("activeTab"), false);
  assert.equal(firefox.permissions.includes("activeTab"), false);
  assert.equal(firefox.permissions.includes("windows"), false);
  assert.equal(firefox.permissions.includes("system.display"), false);
  assert.deepEqual(chrome.permissions, ["storage", "tabs", "windows", "contextMenus", "system.display"]);
});
