/** Tests conflict-safe UI writes, strict backup validation, and screen-bound cascade geometry. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, validateConfigImport } from "../core/config.js";
import { applyConfigurationAction, applySiteRuleEdits } from "../core/configuration-actions.js";
import { updateRuleForResize } from "../core/rule-updater.js";
import { safeCascadePosition, isWindowOnDisplay } from "../background/window-manager.js";


/** Builds one normalized rule with complete backup fields. @param {string} host Hostname. @returns {object} Rule fixture. */
function rule(host = "alpha.example") {
  return { id: host, scope: { type: "domain_tree", value: host }, enabled: true, width: 800, height: 600,
    position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null }, lastUpdatedAt: new Date().toISOString() };
}


test("global settings preserve rules created after Configuration was opened", () => {
  const original = createDefaultConfig();
  const latest = { ...original, rules: [rule()] };
  const changed = applyConfigurationAction(latest, { type: "save-global-settings", base: original.global, global: { ...original.global, enabled: false } });
  assert.equal(changed.global.enabled, false);
  assert.deepEqual(changed.rules, latest.rules);
});


test("global and rule-delete conflicts preserve newer settings", () => {
  const config = createDefaultConfig();
  config.rules = [rule()];
  assert.throws(() => applyConfigurationAction(config, { type: "save-global-settings", base: { ...config.global, enabled: false }, global: config.global }), /Reload/);
  assert.throws(() => applyConfigurationAction(config, { type: "delete-rule", ruleId: config.rules[0].id, base: { ...config.rules[0], width: 700 } }), /Reload/);
  assert.equal(config.rules.length, 1);
});


test("site Save preserves unrelated rules and rejects new overlapping rules added concurrently", () => {
  const config = createDefaultConfig();
  const original = rule();
  config.rules = [original, rule("beta.example")];
  const changed = applySiteRuleEdits(config, "https://alpha.example/", { url: "https://alpha.example/", baseRules: [original], rules: [] });
  assert.deepEqual(changed.rules.map((item) => item.id), ["beta.example"]);
  config.rules.push({ ...rule(), id: "exact", scope: { type: "domain_exact", value: "alpha.example" } });
  assert.throws(() => applySiteRuleEdits(config, "https://alpha.example/", { url: "https://alpha.example/", baseRules: [original], rules: [] }), /Reload/);
});


test("invalid backups reject before normalization can silently discard data", () => {
  const valid = createDefaultConfig();
  valid.rules = [rule()];
  assert.deepEqual(validateConfigImport(valid), valid);
  for (const invalid of [
    {},
    { ...valid, schemaVersion: 900 },
    { ...valid, global: { ...valid.global, enabled: "false" } },
    { ...valid, global: { ...valid.global, defaultWidth: 0 } },
    { ...valid, rules: [...valid.rules, valid.rules[0]] },
    { ...valid, rules: [{ ...valid.rules[0], position: { enabled: true, x: null, y: 20 } }] },
    { ...valid, rules: [{ ...valid.rules[0], scope: { type: "domain_tree", value: "https://wrong.example" } }] },
    { ...valid, rules: [{ ...valid.rules[0], lastUpdatedAt: "invalid" }] }
  ]) assert.throws(() => validateConfigImport(invalid));
});


test("legacy backup migrates without retaining the obsolete default coverage", () => {
  const config = createDefaultConfig();
  config.schemaVersion = 4;
  config.global.defaultRememberType = "domain";
  config.rules = [{ ...rule(), scope: { type: "domain", value: "alpha.example" } }];
  const imported = validateConfigImport(config);
  assert.equal(imported.rules[0].scope.type, "domain_tree");
  assert.equal(Object.hasOwn(imported.global, "defaultRememberType"), false);
});


test("resizing without a matching rule never creates a rule", () => {
  const config = createDefaultConfig();
  assert.equal(updateRuleForResize(config, { url: "https://alpha.example/" }, 900, 700).changed, false);
  config.global.autoRememberByDomainTree = true;
  assert.equal(updateRuleForResize(config, { url: "brave://extensions/" }, 900, 700).changed, false);
  assert.equal(updateRuleForResize(config, { url: "https://alpha.example/" }, 900, 700).changed, false);
});


test("safe cascade wraps and stays inside offset and negative monitor coordinates", () => {
  const display = { workArea: { left: -1920, top: -100, width: 1920, height: 1080 } };
  const bounds = { width: 1800, height: 1000, left: -1920, top: -100 };
  const first = safeCascadePosition(bounds, display, 0);
  assert.deepEqual(safeCascadePosition(bounds, display, 4), first);
  for (let index = 0; index < 100; index += 1) assert.equal(isWindowOnDisplay({ ...bounds, ...safeCascadePosition(bounds, display, index) }, display), true);
  assert.equal(isWindowOnDisplay(bounds, undefined), false);
});


test("moving a window without position remembering does not renew an unchanged rule", () => {
  const config = createDefaultConfig();
  config.rules = [rule()];
  const update = updateRuleForResize(config, { url: "https://alpha.example/", position: { x: 300, y: 400 } }, 800, 600);
  assert.equal(update.changed, false);
  assert.equal(update.config.rules[0].lastUpdatedAt, config.rules[0].lastUpdatedAt);
});
