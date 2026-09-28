/**
 * Executes the real service worker and shared modules against a deterministic
 * browser API, including bounds events emitted by programmatic updates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as storage from "../core/storage.js";
import * as resolver from "../core/rule-resolver.js";
import * as updater from "../core/rule-updater.js";
import * as manager from "../background/window-manager.js";
import * as icons from "../background/action-icon.js";
import * as menus from "../context/context-menus.js";
import * as configModule from "../core/config.js";
import * as actions from "../core/configuration-actions.js";
import * as matcher from "../core/rule-matcher.js";
import * as diagnostics from "../core/diagnostics.js";
import * as session from "../core/runtime-session.js";
import { windowBoundsChanged } from "../core/window-bounds.js";


/** Builds a fully valid saved rule. @param {string} type Coverage. @param {string} value Canonical target. @param {number} width Width. @returns {object} Rule fixture. */
function rule(type = "domain_tree", value = "alpha.example", width = 800) {
  return { id: `${type}:${value}`, scope: { type, value }, enabled: true, width, height: 600,
    position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null }, lastUpdatedAt: new Date().toISOString() };
}


/** Creates an isolated browser fixture with real background business logic. @param {object[]} rules Initial rules. @returns {Promise<object>} Mutable browser controls and request API. */
async function browserFixture(rules = []) {
  const config = configModule.createDefaultConfig();
  config.rules = rules;
  config.global.ruleRetentionDays = -1;
  const local = { smartWindowSizeConfig: config };
  const ephemeral = {};
  const listeners = {};
  const updates = [];
  const iconUpdates = [];
  const messages = [];
  const timers = new Map();
  const tabs = new Map([
    [1, { id: 1, windowId: 7, active: true, url: "https://alpha.example/news/item" }],
    [2, { id: 2, windowId: 7, active: false, url: "https://beta.example/" }]
  ]);
  const windows = new Map([[7, { id: 7, type: "normal", state: "normal", left: 200, top: 100, width: 1200, height: 900 }]]);
  const displays = [
    { id: "left", isPrimary: true, workArea: { left: -1920, top: 0, width: 1920, height: 1080 } },
    { id: "right", workArea: { left: 0, top: 0, width: 1920, height: 1080 } }
  ];
  let created = 0;
  let createdTab = 200;
  let nextTimer = 0;


  /** Captures registered browser event callbacks. @param {string} name Event key. @returns {object} Event facade. */
  function event(name) { return { addListener(callback) { listeners[name] = callback; } }; }


  /** Creates one asynchronous browser storage area. @param {object} data Storage contents. @param {string} area Storage area name. @returns {object} API facade. */
  function area(data, area) {
    return {
      async get(key) { return { [key]: structuredClone(data[key]) }; },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        listeners.storage?.(changes, area);
      },
      async remove(key) { delete data[key]; }
    };
  }

  globalThis.chrome = {
    storage: { local: area(local, "local"), session: area(ephemeral, "session"), onChanged: event("storage") },
    runtime: { getURL: (path) => `chrome-extension://test/${path}`, sendMessage: async (message) => { messages.push(message); },
      onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup") },
    action: { setIcon: async (value) => { iconUpdates.push(value); }, setTitle: async () => {}, setBadgeText: async () => {} },
    contextMenus: { removeAll: async () => {}, create: (_entry, callback) => callback(), onClicked: event("menu") },
    system: { display: { getInfo: async () => structuredClone(displays) } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error("Tab closed."); return structuredClone(tabs.get(id)); },
      async query(query) { return [...tabs.values()].filter((tab) => (!query.active || tab.active) && (query.windowId === undefined || query.windowId === tab.windowId)).map((tab) => structuredClone(tab)); },
      async create(properties) {
        const windowId = 7;
        if (properties.active) for (const tab of tabs.values()) if (tab.windowId === windowId) tab.active = false;
        const tab = { id: ++createdTab, windowId, active: properties.active === true, url: properties.url };
        tabs.set(tab.id, tab);
        return structuredClone(tab);
      },
      async update(id, properties) {
        if (!tabs.has(id)) throw new Error("Tab closed.");
        const tab = tabs.get(id);
        if (properties.active) for (const candidate of tabs.values()) if (candidate.windowId === tab.windowId) candidate.active = false;
        Object.assign(tab, properties);
        return structuredClone(tab);
      },
      onActivated: event("activated"), onUpdated: event("updated"), onRemoved: event("tabRemoved")
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async get(id) { if (!windows.has(id)) throw new Error("Window closed."); return structuredClone(windows.get(id)); },
      async getAll() { return [...windows.values()].map((window) => ({ ...structuredClone(window), tabs: [...tabs.values()].filter((tab) => tab.windowId === window.id) })); },
      async update(id, patch) {
        assert.deepEqual(Object.keys(patch).filter((key) => !["width", "height", "left", "top", "focused"].includes(key)), []);
        const window = windows.get(id);
        Object.assign(window, patch);
        updates.push({ id, patch });
        if (Object.keys(patch).some((key) => key !== "focused")) listeners.bounds?.(structuredClone(window));
        return structuredClone(window);
      },
      async create(properties) {
        await new Promise((resolve) => setImmediate(resolve));
        created += 1;
        const id = 100 + created;
        const window = { id, type: "popup", state: "normal", width: properties.width, height: properties.height, left: 0, top: 0 };
        windows.set(id, window);
        tabs.set(id, { id, windowId: id, active: true, url: properties.url });
        listeners.created?.(structuredClone(window));
        return structuredClone(window);
      },
      onCreated: event("created"), onBoundsChanged: event("bounds"), onRemoved: event("removed")
    }
  };
  const source = (await readFile(new URL("../background/service-worker.js", import.meta.url), "utf8")).replace(/^import .*;\r?$/gm, "");
  const bindings = { ...storage, ...resolver, ...updater, ...manager, ...icons, ...menus, ...configModule, ...actions, ...matcher, ...diagnostics, ...session,
    windowBoundsChanged, APP_VERSION: "test", chrome: globalThis.chrome, Date, structuredClone,
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: (id) => timers.delete(id) };
  let context = vm.createContext(bindings);
  vm.runInContext(source, context);


  /** Drains Promise-based browser work without firing deferred browser timers. @returns {Promise<void>} Completion. */
  async function settle() {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  await settle();
  return { local, ephemeral, windows, tabs, updates, iconUpdates, messages, listeners, created: () => created,
    restart: async () => { context = vm.createContext({ ...bindings }); vm.runInContext(source, context); await settle(); },
    editor: async (tabId = 1) => {
      const dispatch = (...args) => vm.runInContext("dispatchRequest", context)(...args);
      await dispatch({ type: "open-rule-editor", tabId });
      const dialog = [...tabs.values()].find((tab) => tab.url === `chrome-extension://test/rule-delete/rule-delete.html?tabId=${tabId}`);
      return { dialog, dispatch: (message) => dispatch({ tabId, ...message }, { tab: structuredClone(dialog) }) };
    },
    apply: (...args) => vm.runInContext("applyForTab", context)(...args), dispatch: (...args) => vm.runInContext("dispatchRequest", context)(...args),
    flush: (id) => vm.runInContext("inWindow", context)(id, () => vm.runInContext("flushPendingBounds", context)(id)), settle,
    runTimers: async () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await settle(); },
    request: (message) => new Promise((resolve) => listeners.message(message, {}, resolve)) };
}


test("manual resize saves the resolved parent rule, actual size, position, and monitor", async () => {
  const saved = rule("url_subpaths", "https://alpha.example/news");
  saved.position = { enabled: true, x: 0, y: 0 };
  const browser = await browserFixture([rule(), saved]);
  browser.local.smartWindowSizeConfig.global.rememberMonitor = true;
  const result = await browser.request({ type: "resize-window", windowId: 7, width: 900, height: 700 });
  assert.equal(result.ok, true);
  await browser.settle();
  const rules = browser.local.smartWindowSizeConfig.rules;
  assert.equal(rules.length, 2);
  assert.equal(rules.find((item) => item.id === saved.id).width, 900);
  assert.equal(rules[0].width, 800);
  assert.deepEqual(rules[1].position, { enabled: true, x: 200, y: 100 });
  assert.equal(rules[1].display.id, "right");
});


test("manual resize without a rule never turns on remembering", async () => {
  const browser = await browserFixture();
  await browser.dispatch({ type: "resize-window", windowId: 7, width: 900, height: 700 });
  await browser.settle();
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 0);
});


test("Bring uses greatest display overlap and saves the corrected placement", async () => {
  const saved = rule();
  saved.position.enabled = true;
  saved.position.x = -300;
  saved.position.y = 900;
  const browser = await browserFixture([saved]);
  Object.assign(browser.windows.get(7), { left: -300, top: 900, width: 800, height: 600 });
  const result = await browser.dispatch({ type: "bring-window-on-screen", windowId: 7 });
  assert.equal(result.verified, true);
  assert.equal(browser.windows.get(7).left, 0);
  assert.equal(browser.windows.get(7).top, 480);
  assert.deepEqual(browser.local.smartWindowSizeConfig.rules[0].position, { enabled: true, x: 0, y: 480 });
});


test("disabled extension rejects manual actions and sets gray icons even with errors", async () => {
  const browser = await browserFixture([rule()]);
  await browser.request({ type: "report-client-error", operation: "test", message: "test failure" });
  await browser.dispatch({ type: "set-global-enabled", enabled: false });
  const before = browser.updates.length;
  assert.equal((await browser.request({ type: "resize-window", windowId: 7, width: 900, height: 700 })).ok, false);
  assert.equal((await browser.request({ type: "bring-window-on-screen", windowId: 7 })).ok, false);
  assert.equal((await browser.request({ type: "open-rule-editor", tabId: 1 })).ok, false);
  assert.equal(browser.updates.length, before);
  assert.match(browser.iconUpdates.at(-1).path[32], /inactive-32.png$/);
});


test("concurrent rule and About open requests create one instance of each dialog", async () => {
  const browser = await browserFixture();
  await Promise.all(Array.from({ length: 5 }, () => browser.dispatch({ type: "open-rule-editor", tabId: 1 })));
  assert.equal(browser.created(), 1);
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 1);
  await Promise.all([browser.dispatch({ type: "open-about", tabId: 1 }), browser.dispatch({ type: "open-about", tabId: 1 })]);
  assert.equal(browser.created(), 2);
  await browser.settle();
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 0);
});


test("About and Configuration can focus one packaged local README tab", async () => {
  const browser = await browserFixture();
  await browser.dispatch({ type: "open-local-readme" });
  await browser.dispatch({ type: "open-local-readme" });
  const tabs = [...browser.tabs.values()].filter((tab) => tab.url === "chrome-extension://test/readme-viewer/readme.html");
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].active, true);
});


test("editing a matching parent retains identity and samples fresh source bounds", async () => {
  const saved = rule("domain_tree", "example");
  const browser = await browserFixture([saved]);
  Object.assign(browser.windows.get(7), { width: 910, height: 710 });
  const editor = await browser.editor();
  const response = await editor.dispatch({ type: "prepare-site-rule", url: browser.tabs.get(1).url, scope: "domain_tree", existing: saved, rememberPosition: true });
  assert.equal(response.rule.id, saved.id);
  assert.equal(response.rule.scope.value, "example");
  assert.equal(response.rule.width, 910);
  assert.equal(response.rule.position.x, 200);
});


test("rule Save applies immediately; navigation, disabled state, and conflicts reject writes", async () => {
  const saved = rule();
  const browser = await browserFixture([saved]);
  const editor = await browser.editor();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  const edited = { ...saved, width: 1000 };
  browser.windows.get(7).width = 1000;
  await editor.dispatch({ type: "save-site-rules", url: state.url, baseRules: state.rules, rules: [edited] });
  assert.equal(browser.windows.get(7).width, 1000);
  await assert.rejects(editor.dispatch({ type: "save-site-rules", url: state.url, baseRules: state.rules, rules: [saved] }), /changed in another window/);
  browser.tabs.get(1).url = "https://elsewhere.example/";
  await assert.rejects(editor.dispatch({ type: "save-site-rules", url: state.url, baseRules: [edited], rules: [] }), /source page changed/);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].width, 1000);
});


test("a pending resize is saved to its original tab before applying another tab rule", async () => {
  const browser = await browserFixture([rule(), rule("domain_tree", "beta.example", 1100)]);
  Object.assign(browser.windows.get(7), { width: 950, height: 750 });
  browser.listeners.bounds(structuredClone(browser.windows.get(7)));
  await browser.settle();
  browser.tabs.get(1).active = false;
  browser.tabs.get(2).active = true;
  await browser.apply(browser.tabs.get(2));
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].width, 950);
  assert.equal(browser.local.smartWindowSizeConfig.rules[1].width, 1100);
  assert.equal(browser.windows.get(7).width, 1100);
});


test("session window state reapplies a rule after leaving maximized mode", async () => {
  const browser = await browserFixture([rule()]);
  browser.ephemeral["windowState:7"] = { state: "maximized", bounds: { ...browser.windows.get(7), state: "maximized", width: 1920 } };
  browser.listeners.bounds(structuredClone(browser.windows.get(7)));
  await browser.settle();
  assert.equal(browser.windows.get(7).width, 800);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].width, 800);
});


test("default sizing and extension-generated bounds cannot create or overwrite rules", async () => {
  const browser = await browserFixture();
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1600, automaticHeight: 1200, autoRememberByDomainTree: true });
  await browser.apply(browser.tabs.get(1));
  await browser.settle();
  assert.equal(browser.windows.get(7).height, 1080);
  assert.equal(browser.local.smartWindowSizeConfig.global.automaticHeight, 1200);
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 0);
});


test("automatic Configuration dimensions apply to a new window before it receives a URL", async () => {
  const browser = await browserFixture();
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1377, automaticHeight: 877 });
  const blank = { id: 8, type: "normal", state: "normal", left: 100, top: 100, width: 1200, height: 960 };
  browser.windows.set(blank.id, blank);
  browser.listeners.created(structuredClone(blank));
  await browser.settle();
  assert.equal(browser.windows.get(blank.id).width, 1377);
  assert.equal(browser.windows.get(blank.id).height, 877);
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 0);
});


test("Bring without display data reports unverified fallback instead of claiming success", async () => {
  const browser = await browserFixture();
  delete chrome.system;
  const response = await browser.request({ type: "bring-window-on-screen", windowId: 7 });
  assert.equal(response.ok, false);
  assert.match(response.error, /visibility cannot be verified/);
  assert.equal((await diagnostics.loadDiagnostics()).length, 1);
});


test("Save resamples new rules but deletion applies the unchanged broader rule immediately", async () => {
  const browser = await browserFixture([rule()]);
  const url = browser.tabs.get(1).url;
  const editor = await browser.editor();
  const base = (await editor.dispatch({ type: "get-rule-editor-state" })).rules;
  const narrow = rule("url_any_parameters", "https://alpha.example/news/item", 700);
  browser.windows.get(7).width = 940;
  await editor.dispatch({ type: "save-site-rules", url, baseRules: base, rules: [...base, narrow] });
  assert.equal(browser.local.smartWindowSizeConfig.rules.find((item) => item.id === narrow.id).width, 940);
  const next = (await editor.dispatch({ type: "get-rule-editor-state" })).rules;
  await editor.dispatch({ type: "save-site-rules", url, baseRules: next, rules: next.filter((item) => item.id !== narrow.id) });
  assert.equal(browser.windows.get(7).width, 800);
});


test("maximized state is recorded even when its bounds equal a recent automatic update", async () => {
  const browser = await browserFixture([rule()]);
  await browser.apply(browser.tabs.get(1));
  await browser.settle();
  browser.windows.get(7).state = "maximized";
  browser.listeners.bounds(structuredClone(browser.windows.get(7)));
  await browser.settle();
  assert.equal(browser.ephemeral["windowState:7"].state, "maximized");
  Object.assign(browser.windows.get(7), { state: "normal", width: 1250 });
  browser.listeners.bounds(structuredClone(browser.windows.get(7)));
  await browser.settle();
  assert.equal(browser.windows.get(7).width, 800);
});


test("late initial browser bounds cannot overwrite a site's saved size", async () => {
  const browser = await browserFixture([rule()]);
  const window = { id: 8, type: "normal", state: "normal", left: 1600, top: 800, width: 1200, height: 900 };
  const tab = { id: 3, windowId: 8, active: true, url: "https://alpha.example/" };
  browser.windows.set(8, structuredClone(window));
  browser.tabs.set(3, tab);
  browser.listeners.created(structuredClone(window));
  await browser.settle();
  await browser.apply(tab);
  browser.listeners.bounds(structuredClone(window));
  await browser.settle();
  await browser.runTimers();
  await browser.flush(8);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].width, 800);
  assert.equal(browser.windows.get(8).width, 800);
  assert.equal(manager.isWindowOnDisplay(browser.windows.get(8), { workArea: { left: 0, top: 0, width: 1920, height: 1080 } }), true);
});


test("only one editor can mutate; observers can focus it and Configuration cannot bypass the lock", async () => {
  const browser = await browserFixture([rule()]);
  const writer = await browser.editor(1);
  const reader = await browser.editor(2);
  assert.equal((await writer.dispatch({ type: "get-rule-editor-state" })).writable, true);
  const observed = await reader.dispatch({ type: "get-rule-editor-state" });
  assert.equal(observed.writable, false);
  assert.equal(observed.hasOwner, true);
  for (const type of ["prepare-site-rule", "save-site-rules"]) {
    await assert.rejects(reader.dispatch({ type, url: observed.url, scope: "domain_tree", rules: [], baseRules: [] }), /read-only/);
  }
  await assert.rejects(reader.dispatch({ type: "enable-rule-editing" }), /another window/);
  await assert.rejects(browser.dispatch({ type: "save-site-rules", tabId: 1 }), /Reopen/);
  for (const type of ["delete-rule", "import-configuration", "reset-configuration"]) {
    await assert.rejects(browser.dispatch({ type }), /Close the editable/);
  }
  assert.equal((await browser.dispatch({ type: "get-configuration" })).rulesLocked, true);
  await reader.dispatch({ type: "focus-rule-editor" });
  assert.equal(browser.updates.at(-1).id, writer.dialog.windowId);
  assert.equal(browser.updates.at(-1).patch.focused, true);
  await browser.dispatch({ type: "resize-window", windowId: 7, width: 920, height: 720 });
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].width, 920);
  assert.equal(browser.ephemeral.ruleEditors.owner, writer.dialog.id);
});


test("closing the writer releases the lock; competing readers cannot both acquire it", async () => {
  const browser = await browserFixture();
  browser.tabs.set(3, { id: 3, windowId: 7, active: false, url: "https://gamma.example/" });
  const writer = await browser.editor(1);
  const reader = await browser.editor(2);
  const other = await browser.editor(3);
  browser.tabs.delete(writer.dialog.id);
  browser.windows.delete(writer.dialog.windowId);
  browser.listeners.removed(writer.dialog.windowId);
  await browser.settle();
  const state = await reader.dispatch({ type: "get-rule-editor-state" });
  assert.equal(state.hasOwner, false);
  assert.equal(state.writable, false);
  assert.equal((await browser.dispatch({ type: "get-configuration" })).rulesLocked, false);
  const results = await Promise.allSettled([reader.dispatch({ type: "enable-rule-editing" }), other.dispatch({ type: "enable-rule-editing" })]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
});


test("source URL remains pinned after navigation or closure; no dialog can spoof another source", async () => {
  const browser = await browserFixture();
  browser.tabs.get(1).url += "?view=wide&order=asc";
  const writer = await browser.editor();
  const original = (await writer.dispatch({ type: "get-rule-editor-state" })).url;
  browser.tabs.get(1).url = "https://changed.example/";
  const state = await writer.dispatch({ type: "get-rule-editor-state" });
  assert.equal(state.url, original);
  assert.equal(state.sourceValid, false);
  assert.equal(state.writable, false);
  await assert.rejects(writer.dispatch({ type: "prepare-site-rule", url: original, scope: "domain_tree" }), /source page changed/);
  await assert.rejects(writer.dispatch({ type: "prepare-site-rule", url: browser.tabs.get(1).url, scope: "domain_tree" }), /does not match/);
  await assert.rejects(writer.dispatch({ type: "get-rule-editor-state", tabId: 2 }), /Reopen/);
  browser.tabs.delete(1);
  assert.equal((await writer.dispatch({ type: "get-rule-editor-state" })).sourceValid, false);
});


test("ownership is reconstructed from session state and stale dialog records are discarded", async () => {
  const browser = await browserFixture();
  const writer = await browser.editor();
  const reader = await browser.editor(2);
  const session = structuredClone(browser.ephemeral.ruleEditors);
  await browser.restart();
  browser.ephemeral.ruleEditors = session;
  assert.equal((await writer.dispatch({ type: "get-rule-editor-state" })).writable, true);
  writer.dialog.pendingUrl = writer.dialog.url;
  browser.tabs.get(writer.dialog.id).pendingUrl = writer.dialog.url;
  browser.tabs.get(writer.dialog.id).url = "";
  assert.equal((await browser.dispatch({ type: "get-configuration" })).rulesLocked, true);
  browser.tabs.get(writer.dialog.id).url = "chrome-extension://test/about/about.html";
  delete browser.tabs.get(writer.dialog.id).pendingUrl;
  assert.equal((await reader.dispatch({ type: "get-rule-editor-state" })).hasOwner, false);
  await assert.rejects(writer.dispatch({ type: "save-site-rules" }), /Reopen/);
});


test("saved rules notify observers; background persistence remains active and disable blocks the writer", async () => {
  const browser = await browserFixture([rule()]);
  browser.tabs.get(2).url = "https://alpha.example/news/other?view=wide";
  const writer = await browser.editor();
  const reader = await browser.editor(2);
  const initial = await writer.dispatch({ type: "get-rule-editor-state" });
  const edited = { ...initial.rules[0], position: { enabled: true, x: 200, y: 100 } };
  await writer.dispatch({ type: "save-site-rules", url: initial.url, rules: [edited], baseRules: initial.rules });
  const observer = await reader.dispatch({ type: "get-rule-editor-state" });
  assert.equal(observer.rules[0].position.enabled, true);
  assert.equal(observer.writable, false);
  assert.ok(browser.messages.some((message) => message.type === "rule-editors-changed"));
  await browser.dispatch({ type: "set-global-enabled", enabled: false });
  assert.equal((await writer.dispatch({ type: "get-rule-editor-state" })).writable, false);
  await assert.rejects(writer.dispatch({ type: "prepare-site-rule", url: initial.url, scope: "domain_tree" }), /disabled/);
  assert.equal((await browser.dispatch({ type: "get-configuration" })).rulesLocked, true);
});
