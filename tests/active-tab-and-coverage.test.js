/**
 * Tests active-tab ownership and explicit rule-coverage selection without a browser.
 * Runs the real background and rule-editor scripts with isolated API/DOM fixtures.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createDefaultConfig, normalizeConfig } from "../core/config.js";
import { matchingRulesForUrl, resolveRule } from "../core/rule-resolver.js";
import { SCOPE_PRIORITY, scopeForUrl } from "../core/rule-matcher.js";
import { canonicalMatchKey, canonicalMatchKeyForUrl } from "../core/rule-sync.js";
import { RULE_TYPE_LABELS, RULE_TYPE_DESCRIPTORS } from "../core/rule-types.js";
import { fingerprint } from "../core/configuration-actions.js";
import { windowBoundsChanged } from "../core/window-bounds.js";


/** Loads an ESM script without imports for dependency-injected VM execution. @param {string} path Project-relative script path. @returns {Promise<string>} Executable script body. */
async function scriptBody(path) {
  return (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/^import .*;\r?$/gm, "");
}


/** Creates a stable, valid matching-rule fixture. @param {string} type Coverage type. @param {string} value Coverage value. @returns {object} Rule with position disabled. */
function fixtureRule(type = "domain_exact", value = "first.example") {
  return { id: "saved-rule", scope: { type, value }, enabled: true, width: 800, height: 600,
    position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null }, lastUpdatedAt: "2026-09-26T10:00:00Z" };
}


/** Initializes real background handlers with independently controlled tab state. @returns {Promise<object>} Tab fixtures, applied rules, events and application entry point. */
async function backgroundFixture() {
  const tabs = new Map([
    [1, { id: 1, windowId: 7, active: true, url: "https://first.example/" }],
    [2, { id: 2, windowId: 7, active: false, url: "https://second.example/" }],
    [3, { id: 3, windowId: 8, active: true, url: "https://first.example/" }]
  ]);
  const config = createDefaultConfig();
  config.rules = [fixtureRule()];
  const applied = [];
  const listeners = {};
  const controls = { afterIcon: () => {} };
  const session = new Map();


  /** Captures one browser event listener without emitting startup events. @param {string} name Event name. @returns {object} Minimal event adapter. */
  function event(name) { return { addListener(callback) { listeners[name] = callback; } }; }

  const context = vm.createContext({
    APP_VERSION: "test", URL, setTimeout, clearTimeout, fingerprint, windowBoundsChanged,
    getTabIfExists: async (id) => tabs.has(id) ? { ...tabs.get(id) } : null,
    isMissingTabError: () => false,
    readSession: async (key) => structuredClone(session.get(key)),
    writeSession: async (key, value) => session.set(key, structuredClone(value)),
    removeSession: async (key) => session.delete(key),
    loadConfig: async () => config, resolveRule, matchingRulesForUrl,
    toUrl: (value) => { try { return new URL(value); } catch { return null; } },
    createContextMenus: async () => {}, registerContextMenuActions: () => {},
    loadDiagnostics: async () => [], recordDiagnostic: async () => {},
    updateActionIcon: async () => { controls.afterIcon(); return []; },
    updateDefaultActionIcon: async () => [],
    applyResolvedRule: async (windowId, resolved, _canApply, useSavedPosition) => {
      applied.push({ windowId, status: resolved.status, width: resolved.rule?.width, useSavedPosition });
      return { changed: true, sizeAdjusted: false };
    },
    chrome: {
      runtime: { sendMessage: async () => {}, onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
      action: { setBadgeText: async () => {} },
      storage: { onChanged: event("storage"), session: { set: async () => {} } },
      tabs: { query: async (query) => [...tabs.values()].filter((tab) => !query.active || tab.active), get: async (id) => ({ ...tabs.get(id) }), onActivated: event("activated"), onUpdated: event("updated"), onRemoved: event("tab-removed") },
      windows: { WINDOW_ID_NONE: -1, get: async (id) => ({ id, state: "normal", focused: false, width: 1200, height: 960, left: 0, top: 0 }),
        getAll: async () => [],
        onCreated: event("created"), onBoundsChanged: event("bounds"), onRemoved: event("removed") }
    }
  });
  vm.runInContext(await scriptBody("background/service-worker.js"), context);
  await new Promise((resolve) => setImmediate(resolve));
  return { tabs, config, applied, listeners, controls, apply: vm.runInContext("applyForTab", context) };
}


test("loading an inactive tab does not apply its rule to the shared window", async () => {
  const fixture = await backgroundFixture();
  fixture.listeners.updated(2, { status: "complete" }, fixture.tabs.get(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.applied.length, 0);
});


test("switching tabs applies the newly active tab and does not require window focus", async () => {
  const fixture = await backgroundFixture();
  await fixture.apply(fixture.tabs.get(1));
  assert.equal(fixture.applied[0].width, 800);
  fixture.tabs.get(1).active = false;
  fixture.tabs.get(2).active = true;
  fixture.listeners.activated({ tabId: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.applied[1].status, "NONE");
  await fixture.apply(fixture.tabs.get(3));
  assert.equal(fixture.applied[2].windowId, 8);
  assert.equal(fixture.applied[2].width, 800);
});


test("matching rules restore a remembered position for existing and new browser windows", async () => {
  const fixture = await backgroundFixture();
  fixture.config.rules[0].position = { enabled: true, x: 120, y: 80 };
  await fixture.apply(fixture.tabs.get(1));
  await fixture.apply(fixture.tabs.get(3), true);
  assert.equal(fixture.applied[0].useSavedPosition, true);
  assert.equal(fixture.applied[1].useSavedPosition, true);
});


test("a tab that becomes inactive during asynchronous processing cannot resize the window", async () => {
  const fixture = await backgroundFixture();
  fixture.controls.afterIcon = () => { fixture.tabs.get(1).active = false; };
  await fixture.apply(fixture.tabs.get(1));
  assert.equal(fixture.applied.length, 0);
});


/** Builds a small DOM element supporting rule-editor rendering and validation. @returns {object} Mutable element fixture. */
function element() {
  return { value: "", hidden: false, checked: false, disabled: false, listeners: {}, children: [],
    classList: { add() {} }, addEventListener(name, callback) { this.listeners[name] = callback; },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; }, setAttribute() {}, focus() {}, reportValidity() { return false; } };
}


/** Loads the real rule-editor script with a staged saved rule and no persistent writes. @param {object} access Mutable server state overrides. @returns {Promise<object>} Controls, requests and an edit entry point. */
async function ruleEditorFixture(access = {}) {
  const controls = new Map();
  for (const id of ["rules", "empty", "add", "editor", "selected-scope", "remember-position", "remember-monitor", "rule-enabled", "effective-scope", "editor-sync-status", "editor-title", "confirm-rule", "cancel-edit", "save", "cancel", "bring-to-front", "reload", "error", "source-url", "access-status", "focus-editor", "enable-editing"]) controls.set(id, element());
  controls.get("editor").hidden = true;
  const rule = access.rule ?? fixtureRule();
  const sourceUrl = access.url ?? "https://first.example/";
  const requests = [];
  let onMessage;
  let confirmations = 0;
  const context = vm.createContext({
    APP_VERSION: "test", SCOPE_PRIORITY, RULE_TYPE_LABELS, scopeForUrl, canonicalMatchKey, canonicalMatchKeyForUrl, matchingRulesForUrl, resolveRule, URL, structuredClone, crypto: { randomUUID: () => "test-id" },
    installClientErrors: () => {}, runClientAction: async (_operation, action) => action(),
    request: async (message) => {
      requests.push(message);
      if (message.type === "get-rule-editor-state") return { url: sourceUrl, rules: [structuredClone(rule)], ownsEditor: true, writable: true, hasOwner: true, sourceValid: true, enabled: true, ...access };
      if (message.type === "prepare-site-rule") return { rule: { ...rule, id: message.existing?.id ?? "new-rule", scope: { type: message.scope, value: scopeForUrl(message.url, message.scope) } } };
      return { ok: true };
    },
    location: { href: "https://extension.example/rules?tabId=1" }, window: { close() {} }, confirm: () => { confirmations += 1; return true; },
    document: { querySelector: (selector) => controls.get(selector.slice(1)), querySelectorAll: () => [], createElement: element },
    chrome: { runtime: { onMessage: { addListener(listener) { onMessage = listener; } }, sendMessage: async (message) => {
      requests.push(message);
      return message.type === "get-rule-editor-state"
        ? { url: sourceUrl, rules: [structuredClone(rule)], window: { width: 800, height: 600, left: 40, top: 80 } }
        : { ok: true };
    } } }
  });
  vm.runInContext(await scriptBody("rule-delete/rule-delete.js"), context);
  await new Promise((resolve) => setImmediate(resolve));
  return { controls, requests, rule, refresh: async () => { onMessage({ type: "rule-editors-changed" }); await new Promise((resolve) => setImmediate(resolve)); }, edit: vm.runInContext("openEditor", context), state: () => vm.runInContext("state", context), confirmations: () => confirmations };
}


test("Add rule starts with a usable domain-tree scope", async () => {
  const fixture = await ruleEditorFixture();
  const controls = fixture.controls;
  controls.get("add").listeners.click();
  assert.equal(controls.get("selected-scope").value, "domain_tree");
  assert.equal(controls.get("confirm-rule").disabled, false);
  assert.equal(controls.get("save").disabled, true);
  await controls.get("editor").listeners.submit({ preventDefault() {} });
  await controls.get("save").listeners.click();
  assert.equal(fixture.state().rules.length, 2);
  controls.get("selected-scope").value = "url_any_parameters";
  controls.get("selected-scope").listeners.change();
  assert.equal(controls.get("confirm-rule").disabled, false);
  await controls.get("editor").listeners.submit({ preventDefault() {} });
  assert.equal(fixture.state().rules.length, 2);
  await controls.get("save").listeners.click();
  assert.equal(fixture.requests.at(-1).type, "save-site-rules");
});

test("every supported rule type has one shared presentation label", () => {
  assert.equal(RULE_TYPE_DESCRIPTORS.length, SCOPE_PRIORITY.length);
  for (const type of SCOPE_PRIORITY) assert.equal(typeof RULE_TYPE_LABELS[type], "string", type);
});


test("rule editor previews shared effective scope live without persistence", async () => {
  const fixture = await ruleEditorFixture({ url: "https://first.example/docs/page?b=2&a=1#section" });
  const controls = fixture.controls;
  const beforeRequests = fixture.requests.length;
  controls.get("add").listeners.click();
  assert.equal(controls.get("effective-scope").textContent, "domain_tree|first.example");
  controls.get("selected-scope").value = "domain_tree";
  controls.get("selected-scope").listeners.change();
  assert.equal(controls.get("effective-scope").textContent, "domain_tree|first.example");
  controls.get("selected-scope").value = "url_subpaths";
  controls.get("selected-scope").listeners.input();
  assert.equal(controls.get("effective-scope").textContent, "url_subpaths|https://first.example/docs/page");
  controls.get("selected-scope").value = "url_exact_parameters";
  controls.get("selected-scope").listeners.change();
  assert.equal(controls.get("effective-scope").textContent, "url_exact_parameters|https://first.example/docs/page?a=1&b=2");
  assert.equal(fixture.requests.length, beforeRequests);
  assert.equal(fixture.state().rules.length, 1);
});


test("editing a synchronized rule shows only concise status and preserves its identity until Save", async () => {
  const synced = { ...fixtureRule(), sync: { id: "0123456789abcdef0123456789abcdef", revision: 3, modifiedAt: null, modifiedByClientId: null, origin: "legacy", conflict: null } };
  const fixture = await ruleEditorFixture({ rule: synced, syncEnabled: true });
  fixture.edit(synced);
  assert.equal(fixture.controls.get("editor-sync-status").textContent, "Sync: enabled · rev. 3");
  const id = fixture.state().rules[0].sync.id;
  fixture.controls.get("selected-scope").value = "domain_tree";
  fixture.controls.get("selected-scope").listeners.change();
  assert.equal(fixture.state().rules[0].sync.id, id);
  assert.equal(fixture.requests.filter((request) => request.type === "prepare-site-rule").length, 0);
});


test("Edit retains coverage and identity; cancelling an empty Add restores dialog save", async () => {
  const fixture = await ruleEditorFixture();
  fixture.edit(fixture.rule);
  assert.equal(fixture.controls.get("selected-scope").value, "domain_exact");
  await fixture.controls.get("editor").listeners.submit({ preventDefault() {} });
  assert.equal(fixture.state().rules.length, 1);
  assert.equal(fixture.state().rules[0].id, "saved-rule");
  fixture.controls.get("add").listeners.click();
  fixture.controls.get("cancel-edit").listeners.click();
  assert.equal(fixture.controls.get("save").disabled, false);
});


test("Reload confirms only when staged rules or editor fields have changed", async () => {
  const fixture = await ruleEditorFixture();
  fixture.controls.get("reload").listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.confirmations(), 0);
  fixture.edit(fixture.rule);
  fixture.controls.get("remember-position").checked = true;
  fixture.controls.get("reload").listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.confirmations(), 1);
});


test("schema migration renames automatic dimensions and removes legacy preferences without changing saved rules", () => {
  const rule = fixtureRule();
  const migrated = normalizeConfig({ schemaVersion: 4, global: { defaultRememberType: "page", defaultScope: "path", defaultWidth: 1400, defaultHeight: 900 }, rules: [rule] });
  assert.equal(migrated.schemaVersion, 7);
  assert.equal(Object.hasOwn(migrated.global, "defaultRememberType"), false);
  assert.equal(Object.hasOwn(migrated.global, "defaultScope"), false);
  assert.equal(Object.hasOwn(migrated.global, "defaultWidth"), false);
  assert.equal(Object.hasOwn(migrated.global, "defaultHeight"), false);
  assert.equal(migrated.global.automaticWidth, 1400);
  assert.equal(migrated.global.automaticHeight, 900);
  assert.deepEqual(migrated.rules, [rule]);
});


test("read-only editor forbids every local mutation and offers focus instead", async () => {
  const fixture = await ruleEditorFixture({ ownsEditor: false, writable: false });
  const controls = fixture.controls;
  for (const id of ["add", "save", "confirm-rule", "selected-scope", "remember-position", "cancel-edit"]) assert.equal(controls.get(id).disabled, true, id);
  const actions = controls.get("rules").children[0].children[1].children;
  for (const button of actions) {
    assert.equal(button.disabled, true);
    button.listeners.click();
  }
  controls.get("add").listeners.click();
  controls.get("selected-scope").value = "domain_tree";
  await controls.get("editor").listeners.submit({ preventDefault() {} });
  await controls.get("save").listeners.click();
  assert.equal(controls.get("editor").hidden, true);
  assert.equal(fixture.state().rules.length, 1);
  assert.equal(fixture.requests.some((request) => ["prepare-site-rule", "save-site-rules"].includes(request.type)), false);
  assert.equal(controls.get("focus-editor").hidden, false);
  await controls.get("focus-editor").listeners.click();
  assert.equal(fixture.requests.at(-1).type, "focus-rule-editor");
  assert.equal(controls.get("source-url").textContent, "https://first.example/");
});


test("live refresh updates read-only lists but preserves a writer's draft and inner form", async () => {
  const access = { ownsEditor: false, writable: false };
  const reader = await ruleEditorFixture(access);
  access.rules = [];
  access.hasOwner = false;
  await reader.refresh();
  assert.equal(reader.state().rules.length, 0);
  assert.equal(reader.controls.get("enable-editing").hidden, false);
  assert.equal(reader.controls.get("add").disabled, true);
  const writerAccess = {};
  const writer = await ruleEditorFixture(writerAccess);
  writer.edit(writer.rule);
  writer.controls.get("remember-position").checked = true;
  writerAccess.rules = [];
  await writer.refresh();
  assert.equal(writer.state().rules.length, 1);
  assert.equal(writer.controls.get("remember-position").checked, true);
  assert.equal(writer.controls.get("editor").hidden, false);
  writerAccess.sourceValid = false;
  writerAccess.writable = false;
  await writer.refresh();
  assert.equal(writer.controls.get("remember-position").disabled, true);
  assert.equal(writer.controls.get("save").disabled, true);
  assert.equal(writer.controls.get("source-url").textContent, "https://first.example/");
});
