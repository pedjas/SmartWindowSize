/**
 * Verifies serialized persistence of SmartWindowSize configuration updates.
 * This test supplies a minimal browser-storage mock for the shared storage module.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { updateRuleForResize } from "../core/rule-updater.js";


/** Latest configuration held by the deterministic chrome.storage.local mock. @type {object|undefined} */
let storedConfiguration;


/**
 * Creates an asynchronous browser-storage mock that exposes stale-read races without queueing.
 *
 * @returns {object} Chrome API subset used by core/storage.js.
 */
function createChromeStorageMock() {
  return {
    storage: {
      local: {
        async get(key) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { [key]: structuredClone(storedConfiguration) };
        },
        async set(value) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          storedConfiguration = structuredClone(value.smartWindowSizeConfig);
        }
      }
    }
  };
}


/** Supplies the mock before the storage module reads the browser API. */
globalThis.chrome = createChromeStorageMock();


/** Shared storage module loaded after its required browser API mock exists. */
const { updateConfig, loadConfig, replaceConfig } = await import("../core/storage.js");


/** Builds one persisted domain-tree rule for concurrent resize-update tests. @param {string} host Rule hostname. @returns {object} Rule fixture. */
function savedRule(host) {
  return { id: host, scope: { type: "domain_tree", value: host }, enabled: true, width: 800, height: 600,
    position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null }, lastUpdatedAt: new Date().toISOString() };
}


test("concurrent resize saves retain rules for both domains", async () => {
  storedConfiguration = undefined;
  await updateConfig((config) => ({ ...config, rules: [savedRule("first.example"), savedRule("second.example")] }));

  await Promise.all([
    updateConfig((config) => updateRuleForResize(config, { url: "https://first.example/", selectedScope: "domain_tree" }, 1100, 700).config),
    updateConfig((config) => updateRuleForResize(config, { url: "https://second.example/", selectedScope: "domain_tree" }, 1300, 800).config)
  ]);

  assert.equal(storedConfiguration.rules.length, 2);
  assert.equal(storedConfiguration.rules.find((rule) => rule.scope.value === "first.example").width, 1100);
  assert.equal(storedConfiguration.rules.find((rule) => rule.scope.value === "second.example").width, 1300);
});


test("a concurrent migration load cannot overwrite a later configuration write", async () => {
  storedConfiguration.schemaVersion = 4;
  await Promise.all([
    loadConfig(),
    updateConfig((config) => ({ ...config, global: { ...config.global, defaultWidth: 1450 } }))
  ]);
  assert.equal(storedConfiguration.global.defaultWidth, 1450);
  assert.equal(storedConfiguration.rules.length, 2);
});


test("invalid import leaves persistent configuration untouched", async () => {
  const before = structuredClone(storedConfiguration);
  await assert.rejects(replaceConfig({ rules: [] }), /Invalid/);
  assert.deepEqual(storedConfiguration, before);
});
