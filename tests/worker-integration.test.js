/**
 * Executes the real service worker and shared modules against a deterministic
 * browser API, including bounds events emitted by programmatic updates.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
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
import * as tabLifecycle from "../core/tab-lifecycle.js";
import * as ruleSync from "../core/rule-sync.js";
import * as ruleSyncStore from "../core/rule-sync-store.js";
import { windowBoundsChanged } from "../core/window-bounds.js";


/** Keeps imported production modules bound to the browser fixture that started their asynchronous work. */
const browserContexts = new AsyncLocalStorage();
const liveFixtures = new Set();
let fallbackChrome = null;

/** Resolves chrome for imported modules without depending on a mutable host-global fixture activation. */
const chromeContextProxy = new Proxy({}, {
  get(_target, property) {
    const chrome = browserContexts.getStore() ?? fallbackChrome;
    if (!chrome) throw new Error("No browser fixture context is active.");
    return chrome[property];
  },
  set(_target, property, value) {
    const chrome = browserContexts.getStore() ?? fallbackChrome;
    if (!chrome) throw new Error("No browser fixture context is active.");
    chrome[property] = value;
    return true;
  },
  deleteProperty(_target, property) {
    const chrome = browserContexts.getStore() ?? fallbackChrome;
    if (!chrome) throw new Error("No browser fixture context is active.");
    return delete chrome[property];
  }
});
globalThis.chrome = chromeContextProxy;


afterEach(async () => {
  await Promise.all([...liveFixtures].map((fixture) => fixture.dispose()));
});


/** Builds a fully valid saved rule. @param {string} type Coverage. @param {string} value Canonical target. @param {number} width Width. @returns {object} Rule fixture. */
function rule(type = "domain_tree", value = "alpha.example", width = 800) {
  return { id: `${type}:${value}`, scope: { type, value }, enabled: true, width, height: 600,
    position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null }, lastUpdatedAt: new Date().toISOString() };
}


/** Creates an isolated browser fixture with real background business logic. @param {object[]} rules Initial rules. @param {boolean} useFirefoxWindowEvents Whether to expose Firefox events. @param {boolean} firefoxHasBoundsChanged Whether Firefox has bounds events. @param {object|undefined} sharedCloud Optional cloud shared only by an explicit multi-client scenario. @param {string|undefined} clientId Persistent client identity for this fixture. @param {boolean} syncEnabled Whether sync is enabled before service-worker initialization. @returns {Promise<object>} Mutable browser controls and request API. */
async function browserFixture(rules = [], useFirefoxWindowEvents = false, firefoxHasBoundsChanged = true, sharedCloud = undefined, clientId = undefined, syncEnabled = false) {
  const config = configModule.createDefaultConfig();
  config.rules = rules;
  if (clientId) config.sync.clientId = clientId;
  config.global.syncRules = syncEnabled;
  config.global.ruleRetentionDays = -1;
  const local = { smartWindowSizeConfig: config };
  const ephemeral = {};
  const cloud = sharedCloud ?? {};
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
  let optionsOpened = 0;
  let omitCreatedRuleDialogFromQuery = false;
  let createdPopupStartsBlank = false;
  let tabGetFailure = null;
  let syncReadFailure = null;
  let disposed = false;
  let localReadGate = null;
  const pendingTasks = new Set();


  /** Runs and tracks fixture work in this fixture's permanent browser context. @template T @param {() => T|Promise<T>} operation Fixture operation. @returns {Promise<T>} Completion. */
  function runInFixture(operation) {
    if (disposed) return Promise.reject(new Error("Browser fixture has been disposed."));
    return trackFixturePromise(browserContexts.run(chrome, operation));
  }


  /** Tracks an asynchronous browser API result even when production code intentionally starts it without awaiting the outer callback. @template T @param {T|Promise<T>} result Browser API result. @returns {Promise<T>} Completion. */
  function trackFixturePromise(result) {
    const task = Promise.resolve(result);
    pendingTasks.add(task);
    task.then(() => pendingTasks.delete(task), () => pendingTasks.delete(task));
    return task;
  }


  /** Captures registered browser event callbacks. @param {string} name Event key. @returns {object} Event facade. */
  function event(name) { return { addListener(callback) { listeners[name] = (...args) => runInFixture(() => callback(...args)); } }; }


  /** Creates one asynchronous browser storage area. @param {object} data Storage contents. @param {string} area Storage area name. @returns {object} API facade. */
  function area(data, area) {
    return {
      get(key) { return trackFixturePromise((async () => {
        if (area === "sync" && syncReadFailure && key !== null) throw syncReadFailure;
        const gate = area === "local" ? localReadGate : null;
        if (gate) { gate.markReached(); await gate.promise; }
        return key === null ? structuredClone(data) : { [key]: structuredClone(data[key]) };
      })()); },
      set(values) { return trackFixturePromise((async () => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        listeners.storage?.(changes, area);
      })()); },
      remove(key) { return trackFixturePromise((async () => { for (const item of Array.isArray(key) ? key : [key]) delete data[item]; })()); }
    };
  }

  const chrome = {
    storage: { local: area(local, "local"), session: area(ephemeral, "session"), sync: area(cloud, "sync"), onChanged: event("storage") },
    runtime: { getURL: (path) => `chrome-extension://test/${path}`, sendMessage: async (message) => { messages.push(message); }, openOptionsPage: async () => { optionsOpened += 1; },
      onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup") },
    action: { setIcon: async (value) => { iconUpdates.push(value); }, setTitle: async () => {}, setBadgeText: async () => {} },
    contextMenus: { removeAll: async () => {}, create: (_entry, callback) => callback(), onClicked: event("menu") },
    system: { display: { getInfo: async () => structuredClone(displays) } },
    tabs: {
      async get(id) {
        if (tabGetFailure) throw tabGetFailure;
        if (!tabs.has(id)) throw new Error("Tab closed.");
        return structuredClone(tabs.get(id));
      },
      async query(query) {
        const matched = [...tabs.values()].filter((tab) => (!query.active || tab.active) && (query.windowId === undefined || query.windowId === tab.windowId));
        if (omitCreatedRuleDialogFromQuery && query.windowId >= 100) return [];
        return matched.map((tab) => structuredClone(tab));
      },
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
      async remove(id) {
        if (!windows.has(id)) throw new Error("Window closed.");
        windows.delete(id);
        for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId);
        listeners.removed?.(id);
      },
      async create(properties) {
        await new Promise((resolve) => setImmediate(resolve));
        created += 1;
        const id = 100 + created;
        const window = { id, type: "popup", state: "normal", width: properties.width, height: properties.height, left: 0, top: 0 };
        windows.set(id, window);
        tabs.set(id, { id, windowId: id, active: true, url: createdPopupStartsBlank ? "about:blank" : properties.url });
        listeners.created?.(structuredClone(window));
        return structuredClone(window);
      },
      onCreated: event("created"), onBoundsChanged: event("bounds"), onFocusChanged: event("focus"), onRemoved: event("removed")
    }
  };
  const source = (await readFile(new URL("../background/service-worker.js", import.meta.url), "utf8")).replace(/^import .*;\r?$/gm, "");
  const firefoxWindowEvents = useFirefoxWindowEvents ? {
    onCreated: chrome.windows.onCreated,
    onFocusChanged: chrome.windows.onFocusChanged,
    onRemoved: chrome.windows.onRemoved,
    ...(firefoxHasBoundsChanged ? { onBoundsChanged: chrome.windows.onBoundsChanged } : {})
  } : undefined;
  const bindings = { ...storage, ...resolver, ...updater, ...manager, ...icons, ...menus, ...configModule, ...actions, ...matcher, ...diagnostics, ...session, ...tabLifecycle, ...ruleSync, ...ruleSyncStore,
    windowBoundsChanged, APP_VERSION: "test", chrome, Date, URL, structuredClone,
    browser: firefoxWindowEvents ? { windows: firefoxWindowEvents } : undefined,
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, () => runInFixture(callback)); return id; }, clearTimeout: (id) => timers.delete(id) };
  let context = vm.createContext(bindings);
  await runInFixture(() => vm.runInContext(source, context));


  /** Waits for every actual service-worker queue to become stable without advancing fixture timers. @returns {Promise<boolean>} Whether no queue changed while it drained. */
  async function drainWorkerQueues() {
    return browserContexts.run(chrome, () => vm.runInContext(`(async () => {
      const before = [geometryTrackQueue, dependentDialogQueue, editorQueue, ruleSyncQueue, menuQueue, iconQueue, ...windowQueues.values()];
      await Promise.allSettled(before);
      const after = [geometryTrackQueue, dependentDialogQueue, editorQueue, ruleSyncQueue, menuQueue, iconQueue, ...windowQueues.values()];
      return windowQueues.size === 0 && before.length === after.length && before.every((queue, index) => queue === after[index]);
    })()`, context));
  }


  /** Drains tracked fixture work without relying on arbitrary host event-loop delays. @returns {Promise<void>} Completion. */
  async function settle() {
    while (true) {
      await Promise.resolve();
      if (pendingTasks.size) await Promise.all([...pendingTasks]);
      const workerIdle = await drainWorkerQueues();
      if (!workerIdle || pendingTasks.size !== 0) continue;
      await new Promise((resolve) => setImmediate(resolve));
      if (pendingTasks.size === 0 && await drainWorkerQueues()) return;
    }
  }

  const fixture = { local, ephemeral, cloud, windows, tabs, updates, iconUpdates, messages, listeners, created: () => created, optionsOpened: () => optionsOpened,
    omitCreatedRuleDialogFromQuery: (value) => { omitCreatedRuleDialogFromQuery = value; },
    createdPopupStartsBlank: (value) => { createdPopupStartsBlank = value; },
    tabGetFailure: (error) => { tabGetFailure = error; },
    syncReadFailure: (error) => { syncReadFailure = error; },
    storageSyncAvailable: (available) => { if (available) chrome.storage.sync = area(cloud, "sync"); else delete chrome.storage.sync; },
    holdLocalReads: () => {
      let release; let markReached;
      const promise = new Promise((resolve) => { release = resolve; });
      const reached = new Promise((resolve) => { markReached = resolve; });
      localReadGate = { promise, release, markReached };
      return { reached, release: () => { if (localReadGate?.promise === promise) localReadGate = null; release(); } };
    },
    closeWindow: async (id) => { await runInFixture(() => { windows.delete(id); for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId); return listeners.removed?.(id); }); await settle(); },
    activate: () => { fallbackChrome = chrome; },
    restart: async () => { await runInFixture(() => { context = vm.createContext({ ...bindings }); return vm.runInContext(source, context); }); await settle(); },
    editor: async (tabId = 1) => {
      const dispatch = (...args) => runInFixture(() => vm.runInContext("dispatchRequest", context)(...args));
      await dispatch({ type: "open-rule-editor", tabId });
      const dialog = [...tabs.values()].find((tab) => tab.url?.startsWith(`chrome-extension://test/rule-delete/rule-delete.html?tabId=${tabId}&sourceWindowId=7&editorToken=`));
      const editorToken = new URL(dialog.url).searchParams.get("editorToken");
      return { dialog, editorToken, dispatch: (message) => dispatch({ tabId, sourceWindowId: 7, editorToken, editorTabId: dialog.id, editorWindowId: dialog.windowId, ...message }, { tab: structuredClone(dialog) }) };
    },
    apply: (...args) => runInFixture(() => vm.runInContext("applyForTab", context)(...args)), dispatch: (...args) => runInFixture(() => vm.runInContext("dispatchRequest", context)(...args)),
    flush: (id) => runInFixture(() => vm.runInContext("inWindow", context)(id, () => vm.runInContext("flushPendingBounds", context)(id))), settle,
    runTimers: async () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await settle(); },
    runTimersUntil: async (predicate) => {
      while (!predicate()) {
        const callbacks = [...timers.values()];
        if (callbacks.length === 0) throw new Error("No fixture timer remains to satisfy the requested completion condition.");
        timers.clear();
        for (const callback of callbacks) callback();
        await settle();
      }
    },
    request: (message) => runInFixture(() => new Promise((resolve) => listeners.message(message, {}, resolve))),
    dispose: async () => {
      disposed = true;
      timers.clear();
      localReadGate?.release(); localReadGate = null;
      for (const name of Object.keys(listeners)) delete listeners[name];
      await Promise.allSettled([...pendingTasks]);
      liveFixtures.delete(fixture);
    }
  };
  liveFixtures.add(fixture);
  fixture.activate();
  await settle();
  return fixture;
}


/** Creates two isolated service-worker clients that intentionally share only the simulated storage.sync cloud. @returns {Promise<{a: object, b: object, cloud: object, deliver: (target: object) => Promise<void>, settleAll: () => Promise<void>}>} Two clients and controlled cloud delivery. */
async function twoClientFixture() {
  const cloud = {};
  const a = await browserFixture([], false, true, cloud, "client-a", true);
  const b = await browserFixture([], false, true, cloud, "client-b", true);
  /** Delivers the cloud snapshot to one client as a browser sync-area change. @param {object} target Receiving client. @returns {Promise<void>} Completion after its worker settles. */
  async function deliver(target) {
    const changes = Object.fromEntries(Object.entries(cloud).map(([key, value]) => [key, { oldValue: undefined, newValue: structuredClone(value) }]));
    await target.listeners.storage(changes, "sync");
    await target.settle();
  }
  /** Fully drains each independently activated client before a later fixture can replace host-level module bindings. @returns {Promise<void>} Completion after both queues settle. */
  async function settleAll() { await a.settle(); await b.settle(); }
  return { a, b, cloud, deliver, settleAll };
}


/** Adds one domain rule through the real editor prepare/save production path. @param {object} client Worker fixture. @returns {Promise<object>} Newly persisted rule. */
async function addDomainRule(client) {
  const editor = await client.editor();
  const initial = await editor.dispatch({ type: "get-rule-editor-state" });
  const prepared = await editor.dispatch({ type: "prepare-site-rule", url: initial.url, scope: "domain_tree", rememberPosition: false, rememberMonitor: false });
  await editor.dispatch({ type: "save-site-rules", url: initial.url, baseRules: initial.rules, rules: [...initial.rules, prepared.rule] });
  await client.settle();
  return client.local.smartWindowSizeConfig.rules[0];
}


test("a tab closed before rule application quietly stops the stale lifecycle operation", async () => {
  const browser = await browserFixture([rule()]);
  browser.tabs.delete(1);
  const result = await browser.apply({ id: 1, windowId: 7, active: true, url: "https://alpha.example/news/item" });
  assert.equal(result.skipped, "tab-closed");
  assert.deepEqual((await browser.request({ type: "get-diagnostics" })).entries, []);
});


test("a closed Rules source tab releases editor ownership without diagnostic spam", async () => {
  const browser = await browserFixture([rule()]);
  const editor = await browser.editor();
  browser.tabs.delete(1);
  browser.listeners.tabRemoved(1);
  await browser.settle();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  assert.equal(state.sourceValid, false);
  assert.equal(state.writable, false);
  assert.equal(browser.ephemeral.ruleEditors.owner, null);
  assert.equal(browser.ephemeral.ruleEditors.entries[editor.editorToken].sourceClosed, true);
  assert.deepEqual((await browser.request({ type: "get-diagnostics" })).entries, []);
});


test("an unknown tab API failure propagates to the established diagnostic handler", async () => {
  const browser = await browserFixture();
  browser.tabGetFailure(new Error("Tab API permission denied."));
  const result = await browser.request({ type: "get-state", tabId: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /permission denied/i);
  const entries = (await browser.request({ type: "get-diagnostics" })).entries;
  assert.equal(entries.length, 1);
  assert.match(entries[0].message, /permission denied/i);
});


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


test("enabling Rules Sync publishes one compact record without local geometry", async () => {
  const saved = rule();
  saved.position = { enabled: true, x: 250, y: 120 };
  saved.display = { enabled: true, id: "right" };
  const browser = await browserFixture([saved]);
  const base = structuredClone(browser.local.smartWindowSizeConfig.global);
  await browser.request({ type: "save-global-settings", base, global: { ...base, syncRules: true } });
  await browser.settle();
  const synced = Object.values(browser.cloud);
  assert.equal(synced.length, 1);
  assert.equal(synced[0].definition.scope.value, "alpha.example");
  assert.equal(synced[0].definition.rememberPosition, true);
  assert.equal(synced[0].definition.rememberMonitor, true);
  assert.equal("enabled" in synced[0].definition, false);
  assert.equal("x" in synced[0].definition, false);
  assert.equal("display" in synced[0].definition, false);
  const before = structuredClone(browser.local.smartWindowSizeConfig.rules[0]);
  Object.assign(browser.windows.get(7), { width: 1111, height: 777 });
  await browser.dispatch({ type: "set-sync-seed-size", tabId: 1, windowId: 7 });
  await browser.settle();
  const updated = Object.values(browser.cloud)[0];
  assert.equal(updated.definition.seedWidth, 1111);
  assert.equal(updated.definition.seedHeight, 777);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].width, before.width);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].sync.id, before.sync.id);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].sync.revision, before.sync.revision);
});


test("fixture-bound async work cannot switch local storage when another client starts work", async () => {
  const a = await browserFixture([], false, true, undefined, "client-a");
  const b = await browserFixture([], false, true, undefined, "client-b");
  const gate = a.holdLocalReads();
  const base = structuredClone(a.local.smartWindowSizeConfig.global);
  const aSave = a.request({ type: "save-global-settings", base, global: { ...base, enabled: false } });
  await gate.reached;
  const bRead = b.request({ type: "get-state", tabId: 1 });
  gate.release();
  await Promise.all([aSave, bRead]);
  await Promise.all([a.settle(), b.settle()]);
  assert.equal(a.local.smartWindowSizeConfig.global.enabled, false);
  assert.equal(b.local.smartWindowSizeConfig.global.enabled, true);
  await a.dispose();
  assert.equal(b.local.smartWindowSizeConfig.global.enabled, true);
});


test("two independent clients create, import, and semantically edit one shared rule without replacing local lineage or geometry", async () => {
  const { a, b, cloud, deliver, settleAll } = await twoClientFixture();
  const created = await addDomainRule(a);
  const key = ruleSyncStore.cloudRuleKey(created.sync.id);
  assert.equal(cloud[key].status.revision, 1);
  assert.equal(created.sync.origin, "user");
  assert.equal(cloud[key].status.modifiedByClientId, "client-a");
  const syncNow = await b.request({ type: "sync-rules-now" });
  assert.equal(syncNow.result.received, 1);
  const imported = b.local.smartWindowSizeConfig.rules[0];
  assert.equal(imported.sync.id, created.sync.id);
  assert.equal(imported.sync.origin, "sync");
  assert.equal(imported.sync.modifiedByClientId, "client-a");
  assert.equal(b.local.smartWindowSizeConfig.rules.length, 1);
  Object.assign(a.local.smartWindowSizeConfig.rules[0], { enabled: false, width: 901, height: 701, position: { enabled: true, x: 10, y: 20 }, display: { enabled: true, id: "left" } });
  Object.assign(b.local.smartWindowSizeConfig.rules[0], { enabled: true, width: 811, height: 611, position: { enabled: false, x: 30, y: 40 }, display: { enabled: true, id: "right" } });
  const editor = await b.editor();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  const edited = { ...state.rules[0], position: { ...state.rules[0].position, enabled: true } };
  await editor.dispatch({ type: "save-site-rules", url: state.url, baseRules: state.rules, rules: [edited] });
  await b.settle();
  assert.equal(cloud[key].status.revision, 2);
  assert.equal(cloud[key].status.modifiedByClientId, "client-b");
  assert.equal(b.local.smartWindowSizeConfig.rules[0].sync.origin, "sync");
  await deliver(a);
  const updatedA = a.local.smartWindowSizeConfig.rules[0];
  assert.equal(updatedA.sync.revision, 2);
  assert.equal(updatedA.sync.modifiedByClientId, "client-b");
  assert.equal(updatedA.sync.origin, "user");
  assert.deepEqual({ enabled: updatedA.enabled, width: updatedA.width, height: updatedA.height, position: updatedA.position, display: updatedA.display }, { enabled: false, width: 901, height: 701, position: { enabled: true, x: 10, y: 20 }, display: { enabled: true, id: "left" } });
  assert.deepEqual({ enabled: cloud[key].definition.enabled, width: cloud[key].definition.width, position: cloud[key].definition.position, display: cloud[key].definition.display }, { enabled: undefined, width: undefined, position: undefined, display: undefined });
  await settleAll();
});


test("two-client delete and explicit same-scope recreation keep one deterministic identity and clear both deletion indexes", async () => {
  const { a, b, cloud, deliver, settleAll } = await twoClientFixture();
  const created = await addDomainRule(a);
  const id = created.sync.id;
  const key = ruleSyncStore.cloudRuleKey(id);
  await deliver(b);
  const editor = await a.editor();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  await editor.dispatch({ type: "save-site-rules", url: state.url, baseRules: state.rules, rules: [] });
  await a.settle();
  assert.equal(a.local.smartWindowSizeConfig.rules.length, 0);
  assert.equal(a.local.smartWindowSizeConfig.sync.tombstones[id].deleted, true);
  assert.equal(cloud[key].status.deleted, true);
  await deliver(b);
  assert.equal(b.local.smartWindowSizeConfig.rules.length, 0);
  assert.equal(b.local.smartWindowSizeConfig.sync.tombstones[id].deleted, true);
  await a.closeWindow(editor.dialog.windowId);
  const recreated = await addDomainRule(a);
  assert.equal(recreated.sync.id, id);
  assert.equal(a.local.smartWindowSizeConfig.sync.tombstones[id], undefined);
  assert.equal(cloud[key].status.deleted, false);
  await deliver(b);
  assert.equal(b.local.smartWindowSizeConfig.rules.length, 1);
  assert.equal(b.local.smartWindowSizeConfig.rules[0].sync.id, id);
  assert.equal(b.local.smartWindowSizeConfig.rules[0].sync.origin, "sync");
  assert.equal(b.local.smartWindowSizeConfig.sync.tombstones[id], undefined);
  assert.equal(cloud[key].status.deleted, false);
  const repeatEditor = await a.editor();
  const repeatState = await repeatEditor.dispatch({ type: "get-rule-editor-state" });
  await repeatEditor.dispatch({ type: "save-site-rules", url: repeatState.url, baseRules: repeatState.rules, rules: [] });
  await a.settle();
  assert.equal(cloud[key].status.revision, 4);
  assert.equal(cloud[key].status.deleted, true);
  await deliver(b);
  assert.equal(b.local.smartWindowSizeConfig.rules.length, 0);
  await a.closeWindow(repeatEditor.dialog.windowId);
  const finalRule = await addDomainRule(a);
  assert.equal(finalRule.sync.id, id);
  assert.equal(finalRule.sync.revision, 5);
  await deliver(b);
  assert.equal(b.local.smartWindowSizeConfig.rules.length, 1);
  assert.equal(b.local.smartWindowSizeConfig.rules[0].sync.revision, 5);
  assert.equal(b.local.smartWindowSizeConfig.rules.filter((rule) => rule.sync.id === id).length, 1);
  await settleAll();
});


test("the real editor Add route still rejects a currently active canonical duplicate", async () => {
  const browser = await browserFixture();
  const created = await addDomainRule(browser);
  const first = await browser.editor();
  await browser.closeWindow(first.dialog.windowId);
  const editor = await browser.editor();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  await assert.rejects(editor.dispatch({ type: "prepare-site-rule", url: state.url, scope: "domain_tree", rememberPosition: false, rememberMonitor: false }), /active rule.*effective scope/i);
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 1);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].sync.id, created.sync.id);
  await browser.closeWindow(editor.dialog.windowId);
});


test("startup reconciliation imports a missed cloud change into a newly initialized independent client", async () => {
  const cloud = {};
  const a = await browserFixture([], false, true, cloud, "client-a", true);
  const created = await addDomainRule(a);
  const b = await browserFixture([], false, true, cloud, "client-b", true);
  assert.equal(b.local.smartWindowSizeConfig.rules.length, 1);
  assert.equal(b.local.smartWindowSizeConfig.rules[0].sync.id, created.sync.id);
  assert.equal(b.local.smartWindowSizeConfig.rules[0].sync.origin, "sync");
  a.activate(); await a.settle(); b.activate(); await b.settle();
});


test("automatic Rules Sync reconciliation publishes fresh Diagnostics visibility and result state", async () => {
  const browser = await browserFixture([], false, true, undefined, "client-b", true);
  const scope = { type: "domain_tree", value: "fresh.example" };
  const id = await ruleSync.syncRuleIdForScope(scope);
  const key = ruleSyncStore.cloudRuleKey(id);
  const initial = await browser.request({ type: "get-diagnostics" });
  assert.deepEqual(initial.rulesSync.visibility, { active: 0, status: 0, tombstones: 0, malformed: 0 });
  browser.messages.length = 0;
  browser.cloud[key] = {
    status: { revision: 1, modifiedAt: "2026-10-10T05:12:05.000Z", modifiedByClientId: "client-a", origin: "user", deleted: false },
    definition: { scope, rememberPosition: false, rememberMonitor: false, seedWidth: 1200, seedHeight: 960 }
  };
  await browser.listeners.storage({ [key]: { oldValue: undefined, newValue: structuredClone(browser.cloud[key]) } }, "sync");
  await browser.settle();
  assert.ok(browser.messages.some((message) => message.type === "diagnostics-changed"));
  const refreshed = await browser.request({ type: "get-diagnostics" });
  assert.deepEqual(refreshed.rulesSync.visibility, { active: 1, status: 1, tombstones: 0, malformed: 0 });
  assert.equal(refreshed.rulesSync.lastResult.received, 1);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].sync.id, id);
});

test("an authoritative remote tombstone removes the active rule and persists its local deletion index", async () => {
  const browser = await browserFixture([rule()]);
  const base = structuredClone(browser.local.smartWindowSizeConfig.global);
  await browser.request({ type: "save-global-settings", base, global: { ...base, syncRules: true } });
  await browser.settle();
  const local = browser.local.smartWindowSizeConfig.rules[0];
  const status = { revision: local.sync.revision + 1, modifiedAt: "2026-10-09T10:00:00.000Z", modifiedByClientId: "client-a", deleted: true };
  const key = ruleSyncStore.cloudRuleKey(local.sync.id);
  browser.cloud[key] = { status };
  browser.listeners.storage({ [key]: { oldValue: null, newValue: structuredClone(browser.cloud[key]) } }, "sync");
  await browser.settle();
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 0);
  assert.deepEqual(browser.local.smartWindowSizeConfig.sync.tombstones[local.sync.id], { id: local.sync.id, ...status });
  assert.deepEqual(browser.cloud[key].status, status);
});


test("equal-revision active and tombstone states use the shared different-client timestamp fallback", async () => {
  const browser = await browserFixture([rule()]);
  const base = structuredClone(browser.local.smartWindowSizeConfig.global);
  await browser.request({ type: "save-global-settings", base, global: { ...base, syncRules: true } });
  await browser.settle();
  const local = browser.local.smartWindowSizeConfig.rules[0];
  const key = ruleSyncStore.cloudRuleKey(local.sync.id);
  const newerCloudTime = new Date(Date.parse(local.sync.modifiedAt) + 60000).toISOString();
  browser.cloud[key] = { status: { revision: local.sync.revision, modifiedAt: newerCloudTime, modifiedByClientId: "client-b", deleted: true } };
  browser.listeners.storage({ [key]: { oldValue: null, newValue: structuredClone(browser.cloud[key]) } }, "sync");
  await browser.settle();
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 0);
  assert.equal(browser.local.smartWindowSizeConfig.sync.tombstones[local.sync.id].modifiedByClientId, "client-b");
});


test("unresolved equal-revision active and tombstone states remain local conflicts", async () => {
  const browser = await browserFixture([rule()]);
  const base = structuredClone(browser.local.smartWindowSizeConfig.global);
  await browser.request({ type: "save-global-settings", base, global: { ...base, syncRules: true } });
  await browser.settle();
  const local = browser.local.smartWindowSizeConfig.rules[0];
  const key = ruleSyncStore.cloudRuleKey(local.sync.id);
  browser.cloud[key] = { status: { revision: local.sync.revision, modifiedAt: "2026-10-09T10:05:00.000Z", modifiedByClientId: local.sync.modifiedByClientId, deleted: true } };
  browser.listeners.storage({ [key]: { oldValue: null, newValue: structuredClone(browser.cloud[key]) } }, "sync");
  await browser.settle();
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 1);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].sync.conflict.kind, "equal-revision-state-conflict");
  assert.equal((await browser.request({ type: "get-diagnostics" })).entries.filter((entry) => entry.kind === "warning" && entry.operation === "Rules Sync conflict").length, 1);
  await browser.request({ type: "sync-rules-now" });
  assert.equal((await browser.request({ type: "get-diagnostics" })).entries.filter((entry) => entry.kind === "warning" && entry.operation === "Rules Sync conflict").length, 1);
});


test("unresolved equal-revision active conflicts use one default-visible warning and changed state gets a new warning", async () => {
  const browser = await browserFixture([rule()]);
  const base = structuredClone(browser.local.smartWindowSizeConfig.global);
  await browser.request({ type: "save-global-settings", base, global: { ...base, syncRules: true } });
  await browser.settle();
  const local = browser.local.smartWindowSizeConfig.rules[0];
  const key = ruleSyncStore.cloudRuleKey(local.sync.id);
  browser.cloud[key].definition.rememberMonitor = true;
  await browser.request({ type: "sync-rules-now" });
  let response = await browser.request({ type: "get-diagnostics" });
  assert.equal(response.entries.filter((entry) => entry.kind === "warning" && entry.operation === "Rules Sync conflict").length, 1);
  await browser.request({ type: "sync-rules-now" });
  response = await browser.request({ type: "get-diagnostics" });
  assert.equal(response.entries.filter((entry) => entry.kind === "warning" && entry.operation === "Rules Sync conflict").length, 1);
  browser.cloud[key].definition.rememberPosition = true;
  await browser.request({ type: "sync-rules-now" });
  response = await browser.request({ type: "get-diagnostics" });
  assert.equal(response.entries.filter((entry) => entry.kind === "warning" && entry.operation === "Rules Sync conflict").length, 2);
});


test("manual Rules Sync distinguishes disabled and unavailable browser sync storage", async () => {
  const browser = await browserFixture([]);
  let result = await browser.request({ type: "sync-rules-now" });
  assert.equal(result.result.skippedReason, "sync-disabled");
  const base = structuredClone(browser.local.smartWindowSizeConfig.global);
  await browser.request({ type: "save-global-settings", base, global: { ...base, syncRules: true } });
  await browser.settle();
  browser.storageSyncAvailable(false);
  result = await browser.request({ type: "sync-rules-now" });
  assert.equal(result.result.skippedReason, "storage-sync-unavailable");
});


test("Rules Save continues locally and warns when its non-fatal cloud read fails", async () => {
  const saved = rule();
  const browser = await browserFixture([saved]);
  const base = structuredClone(browser.local.smartWindowSizeConfig.global);
  await browser.request({ type: "save-global-settings", base, global: { ...base, syncRules: true } });
  await browser.settle();
  const editor = await browser.editor();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  browser.syncReadFailure(new Error("sync read unavailable"));
  browser.windows.get(7).width = 990;
  await editor.dispatch({ type: "save-site-rules", url: state.url, baseRules: state.rules, rules: [{ ...state.rules[0], width: 990 }] });
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].width, 990);
  const response = await browser.request({ type: "get-diagnostics" });
  assert.equal(response.entries.filter((entry) => entry.kind === "warning" && entry.operation === "Prepare Rules Sync update").length, 1);
});


test("a newer cloud active state recreates a locally tombstoned rule without republishing it", async () => {
  const browser = await browserFixture([rule()]);
  const base = structuredClone(browser.local.smartWindowSizeConfig.global);
  await browser.request({ type: "save-global-settings", base, global: { ...base, syncRules: true } });
  await browser.settle();
  const local = browser.local.smartWindowSizeConfig.rules[0];
  const key = ruleSyncStore.cloudRuleKey(local.sync.id);
  browser.cloud[key] = { status: { revision: local.sync.revision + 1, modifiedAt: "2026-10-09T10:05:00.000Z", modifiedByClientId: "client-a", deleted: true } };
  browser.listeners.storage({ [key]: { oldValue: null, newValue: structuredClone(browser.cloud[key]) } }, "sync");
  await browser.settle();
  browser.cloud[key] = { status: { revision: local.sync.revision + 2, modifiedAt: "2026-10-09T10:10:00.000Z", modifiedByClientId: "client-b", origin: "user", deleted: false }, definition: { scope: structuredClone(local.scope), rememberPosition: false, rememberMonitor: false, seedWidth: 999, seedHeight: 777 } };
  browser.listeners.storage({ [key]: { oldValue: null, newValue: structuredClone(browser.cloud[key]) } }, "sync");
  await browser.settle();
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 1);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].sync.origin, "sync");
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].width, 999);
  assert.deepEqual(browser.cloud[key].definition.seedWidth, 999);
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


test("a failed rule-dialog initialization records its browser phase and captured source context", async () => {
  const browser = await browserFixture();
  browser.omitCreatedRuleDialogFromQuery(true);
  const response = await browser.request({ type: "open-rule-editor", tabId: 1 });
  assert.equal(response.ok, false);
  assert.equal(response.error, "The rule dialog could not be initialized.");
  const entry = (await diagnostics.loadDiagnostics()).find((item) => item.operation === "open-rule-editor");
  assert.equal(entry.operation, "open-rule-editor");
  assert.equal(entry.technical.context.phase, "find-dialog-tab");
  assert.deepEqual(entry.technical.context.source, { tabId: 1, windowId: 7, url: "https://alpha.example/news/item" });
  assert.equal(entry.technical.context.editor.windowId, 101);
  assert.deepEqual(entry.technical.context.browserResult.queryDialogTabs.tabs, []);
});


test("a Firefox about:blank popup remains the reserved editor until its token handshake completes", async () => {
  const browser = await browserFixture();
  browser.createdPopupStartsBlank(true);
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 1);
  const [opening] = Object.values(browser.ephemeral.ruleEditors.entries);
  assert.equal(opening.status, "opening");
  assert.equal(opening.windowId, 101);
  assert.equal(opening.dialogId, 101);
  assert.equal(opening.lifecycle.initialTabUrl, "about:blank");
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 1);
  assert.equal(browser.updates.at(-1).id, 101);
  browser.tabs.get(opening.dialogId).url = `chrome-extension://test/rule-delete/rule-delete.html?tabId=1&sourceWindowId=7&editorToken=${opening.token}`;
  const state = await browser.dispatch({ type: "get-rule-editor-state", tabId: 1, sourceWindowId: 7, editorToken: opening.token,
    editorTabId: opening.dialogId, editorWindowId: opening.windowId });
  assert.equal(state.sourceValid, true);
  assert.equal(state.writable, true);
  const [opened] = Object.values(browser.ephemeral.ruleEditors.entries);
  assert.equal(opened.status, "open");
  assert.equal(opened.lifecycle.transition, "opening -> open");
});


test("closing a Firefox about:blank popup releases its opening editor reservation", async () => {
  const browser = await browserFixture();
  browser.createdPopupStartsBlank(true);
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  const [opening] = Object.values(browser.ephemeral.ruleEditors.entries);
  browser.tabs.delete(opening.dialogId);
  browser.windows.delete(opening.windowId);
  browser.listeners.removed(opening.windowId);
  await browser.settle();
  assert.deepEqual(browser.ephemeral.ruleEditors.entries, {});
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 2);
});


test("a rule dialog preserves its captured HTTP source context after the active tab changes", async () => {
  const browser = await browserFixture();
  const source = structuredClone(browser.tabs.get(1));
  await browser.dispatch({ type: "open-rule-editor", tabId: source.id, sourceWindowId: source.windowId, sourceUrl: source.url });
  const dialog = [...browser.tabs.values()].find((tab) => tab.url?.startsWith("chrome-extension://test/rule-delete/rule-delete.html?tabId=1&sourceWindowId=7&editorToken="));
  const editorToken = new URL(dialog.url).searchParams.get("editorToken");
  assert.equal(new URL(dialog.url).searchParams.get("sourceUrl"), source.url);
  const entry = Object.values(browser.ephemeral.ruleEditors.entries).find((candidate) => candidate.token === editorToken);
  assert.deepEqual({ sourceId: entry.sourceId, sourceWindowId: entry.sourceWindowId, url: entry.url }, { sourceId: 1, sourceWindowId: 7, url: source.url });
  assert.equal(entry.token, editorToken);
  browser.tabs.get(1).active = false;
  browser.tabs.get(2).active = true;
  const state = await browser.dispatch({ type: "get-rule-editor-state", tabId: 1, sourceWindowId: 7, editorToken }, { tab: structuredClone(dialog) });
  assert.equal(state.url, source.url);
  assert.equal(state.sourceValid, true);
  const prepared = await browser.dispatch({ type: "prepare-site-rule", tabId: 1, sourceWindowId: 7, editorToken, url: source.url, scope: "domain_tree", rememberPosition: false, rememberMonitor: false }, { tab: structuredClone(dialog) });
  assert.equal(prepared.rule.scope.type, "domain_tree");
});


test("a direct rule-dialog request without a captured source context remains blocked", async () => {
  const browser = await browserFixture();
  const sender = { tab: { id: 901, windowId: 902, url: "chrome-extension://test/rule-delete/rule-delete.html?tabId=1" } };
  await assert.rejects(browser.dispatch({ type: "get-rule-editor-state", tabId: 1 }, sender), /Reopen this rule dialog/);
});


test("closing a source tab retains its editor only long enough to report the specific Save error", async () => {
  const browser = await browserFixture();
  const writer = await browser.editor(1);
  browser.tabs.delete(1);
  browser.listeners.tabRemoved(1);
  await browser.settle();
  const closed = await writer.dispatch({ type: "get-rule-editor-state" });
  assert.equal(closed.sourceValid, false);
  assert.equal(closed.writable, false);
  browser.tabs.set(1, { id: 1, windowId: 7, active: true, url: "https://alpha.example/new" });
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 2);
});


test("the Options action uses the browser-neutral runtime options API", async () => {
  const browser = await browserFixture();
  assert.equal((await browser.dispatch({ type: "open-options" })).ok, true);
  assert.equal(browser.optionsOpened(), 1);
});


test("a Firefox-style internal dialog sender without sender.tab uses its saved token context", async () => {
  const browser = await browserFixture();
  const writer = await browser.editor();
  const state = await browser.dispatch({ type: "get-rule-editor-state", tabId: 1, sourceWindowId: 7, editorToken: writer.editorToken }, {});
  assert.equal(state.url, "https://alpha.example/news/item");
  assert.equal(state.writable, true);
  const prepared = await browser.dispatch({ type: "prepare-site-rule", tabId: 1, sourceWindowId: 7, editorToken: writer.editorToken, url: state.url, scope: "domain_tree", rememberPosition: false, rememberMonitor: false }, {});
  assert.equal(prepared.rule.scope.value, "alpha.example");
});


test("a Firefox sender tab cannot invalidate a legitimate token-bound rule dialog", async () => {
  const browser = await browserFixture();
  const writer = await browser.editor();
  const state = await browser.dispatch({ type: "get-rule-editor-state", tabId: 1, sourceWindowId: 7, editorToken: writer.editorToken },
    { tab: { id: 1, windowId: 7, url: "https://alpha.example/news/item" } });
  assert.equal(state.url, "https://alpha.example/news/item");
  assert.equal(state.writable, true);
});


test("Firefox background restart recovers an opening registry record from the dialog token", async () => {
  const browser = await browserFixture();
  const writer = await browser.editor();
  const entry = Object.values(browser.ephemeral.ruleEditors.entries).find((candidate) => candidate.token === writer.editorToken);
  entry.status = "opening";
  entry.windowId = null;
  entry.dialogId = null;
  await browser.restart();
  const state = await writer.dispatch({ type: "get-rule-editor-state" });
  assert.equal(state.url, "https://alpha.example/news/item");
  assert.equal(state.sourceValid, true);
  assert.equal(state.writable, true);
  const recovered = Object.values(browser.ephemeral.ruleEditors.entries).find((candidate) => candidate.token === writer.editorToken);
  assert.equal(recovered.status, "open");
  assert.equal(recovered.windowId, writer.dialog.windowId);
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 1);
  assert.equal(browser.updates.at(-1).id, writer.dialog.windowId);
  assert.equal(browser.updates.at(-1).patch.focused, true);
});


test("a recent pending reservation blocks another create until it expires", async () => {
  const browser = await browserFixture();
  const writer = await browser.editor();
  browser.tabs.delete(writer.dialog.id);
  browser.windows.delete(writer.dialog.windowId);
  const entry = Object.values(browser.ephemeral.ruleEditors.entries).find((candidate) => candidate.token === writer.editorToken);
  entry.status = "opening";
  entry.openingAt = Date.now();
  entry.windowId = null;
  entry.dialogId = null;
  const pending = await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(pending.pending, true);
  assert.equal(browser.created(), 1);
  const stored = Object.values(browser.ephemeral.ruleEditors.entries).find((candidate) => candidate.token === writer.editorToken);
  assert.ok(stored);
  stored.openingAt = Date.now() - 31000;
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 2);
});


test("a stale closed editor mapping is removed before a replacement is created", async () => {
  const browser = await browserFixture();
  const writer = await browser.editor();
  browser.tabs.delete(writer.dialog.id);
  browser.windows.delete(writer.dialog.windowId);
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 2);
  const entries = Object.values(browser.ephemeral.ruleEditors.entries);
  assert.equal(entries.length, 1);
  assert.notEqual(entries[0].token, writer.editorToken);
});


test("closing one editor removes only its source mapping and leaves the other live", async () => {
  const browser = await browserFixture();
  browser.tabs.set(3, { id: 3, windowId: 7, active: false, url: "https://gamma.example/" });
  const first = await browser.editor(1);
  const second = await browser.editor(3);
  browser.tabs.delete(first.dialog.id);
  browser.windows.delete(first.dialog.windowId);
  browser.listeners.removed(first.dialog.windowId);
  await browser.settle();
  const entries = Object.values(browser.ephemeral.ruleEditors.entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].token, second.editorToken);
  assert.equal((await second.dispatch({ type: "get-rule-editor-state" })).sourceValid, true);
});


test("Set and Edit requests share one reserved editor key for the same source tab", async () => {
  const browser = await browserFixture();
  await Promise.all([
    browser.dispatch({ type: "open-rule-editor", tabId: 1 }),
    browser.dispatch({ type: "open-rule-editor", tabId: 1, sourceWindowId: 7, sourceUrl: "https://alpha.example/news/item" })
  ]);
  assert.equal(browser.created(), 1);
  const [entry] = Object.values(browser.ephemeral.ruleEditors.entries);
  assert.equal(entry.sourceKey, "7:1");
  assert.equal(entry.status, "opening");
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  assert.equal(browser.created(), 1);
  assert.equal(browser.updates.at(-1).id, entry.windowId);
  assert.equal(browser.updates.at(-1).patch.focused, true);
});


test("About and Configuration can focus one packaged local README tab", async () => {
  const browser = await browserFixture();
  await browser.dispatch({ type: "open-local-readme" });
  await browser.dispatch({ type: "open-local-readme" });
  const tabs = [...browser.tabs.values()].filter((tab) => tab.url === "chrome-extension://test/readme-viewer/readme.html");
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].active, true);
});


test("closing a source browser window closes its dependent dialogs but not Configuration", async () => {
  const browser = await browserFixture();
  await browser.dispatch({ type: "open-rule-editor", tabId: 1 });
  await browser.dispatch({ type: "open-size-picker", tabId: 1 });
  await browser.dispatch({ type: "open-about", tabId: 1 });
  const dialogWindowIds = [...browser.windows.values()].filter((window) => window.id !== 7).map((window) => window.id);
  assert.equal(dialogWindowIds.length, 3);
  await chrome.windows.remove(7);
  await browser.settle();
  for (const dialogWindowId of dialogWindowIds) assert.equal(browser.windows.has(dialogWindowId), false);
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


for (const [width, height] of [[1508, 543], [1200, 700], [1000, 500], [1600, 900]]) {
  test(`captured ${width} by ${height} outer geometry persists and reapplies without transformation`, async () => {
    const browser = await browserFixture();
    await diagnostics.clearDiagnostics();
    Object.assign(browser.windows.get(7), { width, height });
    const editor = await browser.editor();
    const state = await editor.dispatch({ type: "get-rule-editor-state" });
    const prepared = await editor.dispatch({ type: "prepare-site-rule", url: state.url, scope: "domain_tree", rememberPosition: false, rememberMonitor: false });
    assert.deepEqual({ width: prepared.rule.width, height: prepared.rule.height }, { width, height });
    await editor.dispatch({ type: "save-site-rules", url: state.url, baseRules: state.rules, rules: [prepared.rule] });
    const stored = browser.local.smartWindowSizeConfig.rules.find((item) => item.id === prepared.rule.id);
    assert.deepEqual({ width: stored.width, height: stored.height }, { width, height });
    Object.assign(browser.windows.get(7), { width: 900, height: 600 });
    await browser.apply(browser.tabs.get(1));
    assert.deepEqual({ width: browser.windows.get(7).width, height: browser.windows.get(7).height }, { width, height });
  });
}


test.skip("retired lifecycle trace instrumentation", async () => {
  const saved = rule("domain_tree", "tracked.example", 1508);
  saved.height = 543;
  const browser = await browserFixture([saved]);
  await diagnostics.clearDiagnostics();
  const window = { id: 8, type: "normal", state: "normal", left: 48, top: 72, width: 900, height: 700, focused: true };
  const tab = { id: 3, windowId: 8, active: true, url: "about:blank", status: "loading" };
  browser.windows.set(window.id, window);
  browser.tabs.set(tab.id, tab);
  browser.listeners.created(structuredClone(window));
  await browser.settle();
  tab.url = "https://tracked.example/";
  tab.status = "complete";
  browser.listeners.updated(tab.id, { url: tab.url, status: "complete" }, structuredClone(tab));
  await browser.settle();
  Object.assign(window, { left: 64, top: 80, width: 1450, height: 520 });
  browser.listeners.bounds(structuredClone(window));
  await browser.settle();
  await chrome.windows.remove(8);
  await browser.settle();
  const traces = (await diagnostics.loadDiagnostics()).filter((entry) => entry.kind === "trace");
  const operations = traces.map((entry) => entry.operation);
  for (const operation of ["RETIRED_TRACE"]) {
    assert.ok(operations.includes(operation), `Expected ${operation} trace.`);
  }
  const created = traces.find((entry) => entry.operation === "RETIRED_TRACE");
  assert.equal(created.technical.context.currentTabUrl, "about:blank");
  const matched = traces.find((entry) => entry.operation === "RETIRED_TRACE");
  assert.deepEqual(matched.technical.context.savedTarget, { width: 1508, height: 543 });
  const removed = traces.find((entry) => entry.operation === "RETIRED_TRACE");
  assert.deepEqual(removed.technical.context.lastKnownGeometry, { width: 1450, height: 520, left: 64, top: 80, state: "normal" });
  const rawRemoved = traces.find((entry) => entry.operation === "RETIRED_TRACE");
  assert.equal(rawRemoved.technical.context.windowId, 8);
  assert.equal(typeof rawRemoved.technical.context.timestamp, "string");
  const trackedLookup = traces.find((entry) => entry.operation === "RETIRED_TRACE");
  assert.equal(trackedLookup.technical.context.trackedFound, true);
  assert.deepEqual(trackedLookup.technical.context.lastKnownGeometry, { width: 1450, height: 520, left: 64, top: 80, state: "normal" });
  const persisted = traces.find((entry) => entry.operation === "RETIRED_TRACE");
  assert.deepEqual({ width: persisted.technical.context.width, height: persisted.technical.context.height }, { width: 1450, height: 520 });
  const ordering = ["RETIRED_TRACE"]
    .map((operation) => operations.indexOf(operation));
  assert.deepEqual(ordering, [...ordering].sort((left, right) => left - right));
  assert.deepEqual({ width: browser.local.smartWindowSizeConfig.rules[0].width, height: browser.local.smartWindowSizeConfig.rules[0].height }, { width: 1450, height: 520 });
  const reopenedWindow = { id: 9, type: "normal", state: "normal", left: 100, top: 100, width: 900, height: 700, focused: true };
  const reopenedTab = { id: 4, windowId: 9, active: true, url: "https://tracked.example/", status: "complete" };
  browser.windows.set(reopenedWindow.id, reopenedWindow);
  browser.tabs.set(reopenedTab.id, reopenedTab);
  browser.listeners.created(structuredClone(reopenedWindow));
  browser.listeners.updated(reopenedTab.id, { url: reopenedTab.url, status: "complete" }, structuredClone(reopenedTab));
  await browser.settle();
  assert.deepEqual({ width: reopenedWindow.width, height: reopenedWindow.height }, { width: 1450, height: 520 });
  assert.equal(browser.ephemeral.retiredDiagnosticWindows?.[8], undefined);
});


test.skip("retired close trace instrumentation", async () => {
  const saved = rule("domain_tree", "tracked.example", 900);
  saved.height = 600;
  const browser = await browserFixture([saved], true);
  await diagnostics.clearDiagnostics();
  await browser.restart();
  await browser.settle();
  const window = { id: 8, type: "normal", state: "normal", left: 20, top: 30, width: 900, height: 600, focused: true };
  const tab = { id: 3, windowId: 8, active: true, url: "https://tracked.example/", status: "complete" };
  browser.windows.set(8, window);
  browser.tabs.set(3, tab);
  browser.listeners.created(structuredClone(window));
  browser.listeners.updated(3, { url: tab.url, status: "complete" }, structuredClone(tab));
  await browser.settle();
  Object.assign(window, { width: 1182, height: 712 });
  await browser.runTimers();
  await browser.runTimers();
  await browser.restart();
  await browser.settle();
  await chrome.windows.remove(8);
  await browser.settle();
  assert.deepEqual({ width: browser.local.smartWindowSizeConfig.rules[0].width, height: browser.local.smartWindowSizeConfig.rules[0].height }, { width: 1182, height: 712 });
  assert.deepEqual(browser.local["retired.lastWindowRemoved"], { windowId: 8, timestamp: browser.local["retired.lastWindowRemoved"].timestamp });
  assert.ok((await diagnostics.loadDiagnostics()).some((entry) => entry.operation === "RETIRED_TRACE"));
  await diagnostics.clearDiagnostics();
  await browser.restart();
  await browser.settle();
  const operations = (await diagnostics.loadDiagnostics()).map((entry) => entry.operation);
  assert.ok(operations.includes("RETIRED_TRACE"));
  assert.equal(browser.local["retired.lastWindowRemoved"], undefined);
});


/** Attaches one normal tracked test window to the real background event flow. @param {object} browser Browser fixture. @param {number} windowId Browser window identifier. @param {number} tabId Browser tab identifier. @returns {Promise<object>} Mutable window fixture. */
async function attachTrackedWindow(browser, windowId, tabId) {
  const window = { id: windowId, type: "normal", state: "normal", left: 20, top: 30, width: 900, height: 600, focused: true };
  const tab = { id: tabId, windowId, active: true, url: "https://tracked.example/", status: "complete" };
  browser.windows.set(windowId, window);
  browser.tabs.set(tabId, tab);
  browser.listeners.created(structuredClone(window));
  browser.listeners.updated(tabId, { url: tab.url, status: "complete" }, structuredClone(tab));
  await browser.settle();
  return window;
}


test("Firefox polling persists the final manual geometry without recording a programmatic apply", async () => {
  const saved = rule("domain_tree", "tracked.example", 800);
  saved.height = 600;
  const browser = await browserFixture([saved], true);
  const window = await attachTrackedWindow(browser, 8, 3);
  await browser.runTimers();
  assert.deepEqual({ width: browser.local.smartWindowSizeConfig.rules[0].width, height: browser.local.smartWindowSizeConfig.rules[0].height }, { width: 800, height: 600 });
  Object.assign(window, { width: 1182, height: 712 });
  await browser.runTimersUntil(() => browser.local.smartWindowSizeConfig.rules[0].width === 1182 && browser.local.smartWindowSizeConfig.rules[0].height === 712);
  assert.deepEqual({ width: browser.local.smartWindowSizeConfig.rules[0].width, height: browser.local.smartWindowSizeConfig.rules[0].height }, { width: 1182, height: 712 });
  assert.equal((await diagnostics.loadDiagnostics()).length, 0);
});


test.skip("retired Firefox trace instrumentation", async () => {
  const saved = rule("domain_tree", "tracked.example", 800);
  saved.height = 600;
  const browser = await browserFixture([saved], true, false);
  await browser.request({ type: "clear-diagnostics" });
  const window = await attachTrackedWindow(browser, 8, 3);
  await browser.settle();
  await browser.runTimers();
  assert.deepEqual({ width: browser.local.smartWindowSizeConfig.rules[0].width, height: browser.local.smartWindowSizeConfig.rules[0].height }, { width: 800, height: 600 });
  Object.assign(window, { width: 1182, height: 712 });
  await browser.runTimers();
  await browser.runTimers();
  assert.deepEqual({ width: browser.local.smartWindowSizeConfig.rules[0].width, height: browser.local.smartWindowSizeConfig.rules[0].height }, { width: 1182, height: 712 });
  const operations = (await diagnostics.loadDiagnostics()).map((entry) => entry.operation);
  const listenerStatus = (await diagnostics.loadDiagnostics()).find((entry) => entry.operation === "RETIRED_TRACE");
  assert.equal(listenerStatus.technical.context.listenerRegistered, false);
  assert.ok(!operations.includes("RETIRED_TRACE"));
});


test.skip("retired polling trace instrumentation", async () => {
  const saved = rule("domain_tree", "tracked.example", 800);
  saved.height = 600;
  const browser = await browserFixture([saved], true);
  await diagnostics.clearDiagnostics();
  const first = await attachTrackedWindow(browser, 8, 3);
  Object.assign(first, { width: 901, height: 601 });
  Object.assign(first, { width: 902, height: 602 });
  Object.assign(first, { width: 903, height: 603 });
  await browser.runTimers();
  await browser.runTimers();
  assert.deepEqual({ width: browser.local.smartWindowSizeConfig.rules[0].width, height: browser.local.smartWindowSizeConfig.rules[0].height }, { width: 903, height: 603 });
  const second = await attachTrackedWindow(browser, 9, 4);
  Object.assign(second, { width: 1104, height: 704 });
  await browser.runTimers();
  await browser.runTimers();
  assert.deepEqual({ width: browser.local.smartWindowSizeConfig.rules[0].width, height: browser.local.smartWindowSizeConfig.rules[0].height }, { width: 1104, height: 704 });
});


test.skip("retired Chromium trace instrumentation", async () => {
  const saved = rule("domain_tree", "tracked.example", 800);
  saved.height = 600;
  saved.position = { enabled: true, x: 20, y: 30 };
  const browser = await browserFixture([saved]);
  await diagnostics.clearDiagnostics();
  const window = await attachTrackedWindow(browser, 8, 3);
  Object.assign(window, { left: 145, top: 155, width: 1060, height: 710 });
  browser.listeners.bounds(structuredClone(window));
  await browser.settle();
  await browser.runTimers();
  const stored = browser.local.smartWindowSizeConfig.rules[0];
  assert.deepEqual({ width: stored.width, height: stored.height }, { width: 1060, height: 710 });
  assert.deepEqual(stored.position, { enabled: true, x: 145, y: 155 });
  const operations = (await diagnostics.loadDiagnostics()).map((entry) => entry.operation);
  assert.ok(operations.includes("RETIRED_TRACE"));
  assert.deepEqual(browser.local["retired.lastBoundsChanged"], {
    windowId: 8, width: 1060, height: 710, left: 145, top: 155,
    timestamp: browser.local["retired.lastBoundsChanged"].timestamp
  });
  const response = await browser.request({ type: "get-diagnostics" });
  assert.ok(response.entries.some((entry) => entry.operation === "RETIRED_TRACE"));
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


test("Rules Save uses its bound source session while the editor or another source-window tab has focus", async () => {
  const saved = rule();
  const browser = await browserFixture([saved]);
  const editor = await browser.editor();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  browser.tabs.get(1).active = false;
  browser.tabs.get(2).active = true;
  browser.windows.get(7).width = 975;
  const edited = { ...saved, width: 975 };
  await editor.dispatch({ type: "save-site-rules", url: state.url, baseRules: state.rules, rules: [edited] });
  assert.equal(browser.local.smartWindowSizeConfig.rules.find((item) => item.id === saved.id).width, 975);
  assert.equal(browser.tabs.get(1).active, false);
  assert.equal(browser.tabs.get(2).active, true);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].scope.value, "alpha.example");
});


test("Rules Save reports a closed bound source tab without substituting another active tab", async () => {
  const browser = await browserFixture([rule()]);
  const editor = await browser.editor();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  browser.tabs.delete(1);
  browser.listeners.tabRemoved(1);
  browser.tabs.get(2).active = true;
  const response = await browser.request({ type: "save-site-rules", tabId: 1, sourceWindowId: 7, editorToken: editor.editorToken,
    editorTabId: editor.dialog.id, editorWindowId: editor.dialog.windowId, url: state.url, baseRules: state.rules, rules: state.rules });
  assert.equal(response.ok, false);
  assert.match(response.error, /source tab was closed/);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].scope.value, "alpha.example");
  const entry = (await diagnostics.loadDiagnostics()).find((item) => item.operation === "save-site-rules");
  assert.equal(entry.technical.context.validation, "source-tab-closed");
  assert.equal(entry.technical.context.activeTab.tabId, 2);
});


test("Rules Save rejects an invalid editor token without accepting the active tab as a replacement", async () => {
  const browser = await browserFixture([rule()]);
  const editor = await browser.editor();
  const state = await editor.dispatch({ type: "get-rule-editor-state" });
  browser.tabs.get(1).active = false;
  browser.tabs.get(2).active = true;
  const response = await browser.request({ type: "save-site-rules", tabId: 1, sourceWindowId: 7, editorToken: "invalid-token",
    editorTabId: editor.dialog.id, editorWindowId: editor.dialog.windowId, url: state.url, baseRules: state.rules, rules: state.rules });
  assert.equal(response.ok, false);
  assert.match(response.error, /Reopen this rule dialog/);
  const entry = (await diagnostics.loadDiagnostics()).find((item) => item.operation === "save-site-rules");
  assert.equal(entry.technical.context.validation, "editor-session-token-or-ownership");
  assert.equal(entry.technical.context.activeTab.tabId, 2);
  assert.equal(browser.local.smartWindowSizeConfig.rules[0].scope.value, "alpha.example");
});


test("browser-neutral navigation applies a matching rule to its source window without editor-session dependency", async () => {
  const browser = await browserFixture([rule()]);
  await diagnostics.clearDiagnostics();
  const source = browser.tabs.get(1);
  browser.listeners.updated(source.id, { status: "complete" }, structuredClone(source));
  await browser.settle();
  assert.equal(browser.windows.get(7).width, 800);
  assert.equal(browser.windows.get(7).height, 600);
  assert.equal(browser.updates.at(-1).id, 7);
  assert.deepEqual(browser.updates.at(-1).patch, { width: 800, height: 600, left: 200, top: 100 });
  const editor = await browser.editor();
  browser.windows.get(7).width = 1100;
  browser.listeners.updated(source.id, { status: "complete" }, structuredClone(source));
  await browser.settle();
  assert.equal(editor.dialog.windowId > 7, true);
  assert.equal(browser.windows.get(7).width, 800);

  const before = browser.updates.length;
  browser.tabs.get(1).url = "https://unmatched.example/";
  browser.listeners.updated(source.id, { status: "complete" }, structuredClone(browser.tabs.get(1)));
  await browser.settle();
  assert.equal(browser.updates.length, before);
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


test("session virtual domain rules retain manual no-rule dimensions through reloads, paths, and worker restart", async () => {
  const browser = await browserFixture();
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1400, automaticHeight: 800 });
  const tab = browser.tabs.get(1);
  tab.url = "https://unmatched.example/";
  await browser.apply(tab);
  assert.deepEqual({ width: browser.windows.get(7).width, height: browser.windows.get(7).height }, { width: 1400, height: 800 });
  const afterInitialDefault = browser.updates.length;

  Object.assign(browser.windows.get(7), { width: 975, height: 725 });
  browser.listeners.bounds(structuredClone(browser.windows.get(7)));
  await browser.settle();
  await browser.runTimers();
  assert.equal(browser.local.smartWindowSizeConfig.rules.length, 0);

  browser.listeners.updated(tab.id, { status: "complete" }, structuredClone(tab));
  await browser.settle();
  tab.url = "https://unmatched.example/another/path?route=spa";
  browser.listeners.updated(tab.id, { url: tab.url, status: "complete" }, structuredClone(tab));
  await browser.settle();
  browser.listeners.updated(tab.id, { status: "complete" }, structuredClone(tab));
  await browser.settle();
  assert.equal(browser.updates.length, afterInitialDefault);
  assert.deepEqual({ width: browser.windows.get(7).width, height: browser.windows.get(7).height }, { width: 975, height: 725 });
  assert.deepEqual(browser.ephemeral.virtualDefaultRules["unmatched.example"], { width: 975, height: 725 });
  await browser.restart();
  await browser.apply(tab);
  assert.equal(browser.windows.get(7).width, 975);

  await browser.closeWindow(7);
  assert.equal(browser.ephemeral["windowState:7"], undefined);
  assert.deepEqual(browser.ephemeral.virtualDefaultRules["unmatched.example"], { width: 975, height: 725 });
});


test("virtual domains seed independently, retain existing sizes across default changes, and yield to real rules", async () => {
  const browser = await browserFixture([rule("url_subpaths", "https://matched.example/special", 800)]);
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1200, automaticHeight: 960 });
  const tab = browser.tabs.get(1);
  tab.url = "https://example.com/first";
  await browser.apply(tab);
  Object.assign(browser.windows.get(7), { width: 1450, height: 1000 });
  browser.listeners.bounds(structuredClone(browser.windows.get(7))); await browser.settle(); await browser.runTimers();
  Object.assign(browser.local.smartWindowSizeConfig.global, { automaticWidth: 1300, automaticHeight: 900 });
  tab.url = "https://another.example/first";
  await browser.apply(tab);
  assert.deepEqual(browser.ephemeral.virtualDefaultRules, { "example.com": { width: 1450, height: 1000 }, "another.example": { width: 1300, height: 900 } });
  tab.url = "https://example.com/special";
  await browser.apply(tab);
  assert.equal(browser.windows.get(7).width, 1450);
  tab.url = "https://matched.example/special/page";
  await browser.apply(tab);
  assert.equal(browser.windows.get(7).width, 800);
});


test("disabled real rules fall through to one session-global virtual domain rule across windows and reseed after browser-session reset", async () => {
  const disabled = rule("domain_tree", "disabled.example", 800);
  disabled.enabled = false;
  const browser = await browserFixture([disabled], false, true, undefined, undefined, true);
  const cloudBeforeVirtualSizing = structuredClone(browser.cloud);
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1200, automaticHeight: 900 });
  const firstTab = browser.tabs.get(1);
  firstTab.url = "https://disabled.example/first";
  await browser.apply(firstTab);
  assert.equal(browser.windows.get(7).width, 1200);
  assert.deepEqual(browser.ephemeral.virtualDefaultRules["disabled.example"], { width: 1200, height: 900 });
  assert.deepEqual(browser.cloud, cloudBeforeVirtualSizing);

  browser.windows.set(8, { id: 8, type: "normal", state: "normal", left: 20, top: 20, width: 700, height: 500 });
  browser.tabs.set(3, { id: 3, windowId: 8, active: true, url: "https://disabled.example/other" });
  await browser.apply(browser.tabs.get(3));
  assert.deepEqual({ width: browser.windows.get(8).width, height: browser.windows.get(8).height }, { width: 1200, height: 900 });

  Object.assign(browser.windows.get(8), { width: 1111, height: 777 });
  browser.listeners.bounds(structuredClone(browser.windows.get(8))); await browser.settle(); await browser.runTimers();
  assert.deepEqual(browser.ephemeral.virtualDefaultRules["disabled.example"], { width: 1111, height: 777 });
  await browser.apply(firstTab);
  assert.deepEqual({ width: browser.windows.get(7).width, height: browser.windows.get(7).height }, { width: 1111, height: 777 });

  delete browser.ephemeral.virtualDefaultRules;
  Object.assign(browser.local.smartWindowSizeConfig.global, { automaticWidth: 1300, automaticHeight: 850 });
  firstTab.url = "https://fresh.example/";
  await browser.apply(firstTab);
  assert.deepEqual(browser.ephemeral.virtualDefaultRules, { "fresh.example": { width: 1300, height: 850 } });
  assert.deepEqual(browser.cloud, cloudBeforeVirtualSizing);

  await browser.closeWindow(7);
  await browser.closeWindow(8);
  assert.deepEqual(browser.ephemeral.virtualDefaultRules, { "fresh.example": { width: 1300, height: 850 } });
});

test("clearing virtual rules leaves saved configuration and sync untouched until a later no-rule resolution reseeds", async () => {
  const browser = await browserFixture([], false, true, undefined, undefined, true);
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1200, automaticHeight: 900 });
  const tab = browser.tabs.get(1); tab.url = "https://clear.example/";
  await browser.apply(tab);
  const beforeConfig = structuredClone(browser.local.smartWindowSizeConfig);
  const beforeCloud = structuredClone(browser.cloud);
  await browser.dispatch({ type: "clear-virtual-rules" });
  assert.equal(browser.ephemeral.virtualDefaultRules, undefined);
  assert.deepEqual(browser.local.smartWindowSizeConfig, beforeConfig);
  assert.deepEqual(browser.cloud, beforeCloud);
  assert.equal(browser.updates.length, 0);
  Object.assign(browser.local.smartWindowSizeConfig.global, { automaticWidth: 1300, automaticHeight: 850 });
  await browser.apply(tab);
  assert.deepEqual(browser.ephemeral.virtualDefaultRules, { "clear.example": { width: 1300, height: 850 } });
});


test("default sizing gates only virtual-rule creation, not existing virtual-rule use", async () => {
  const browser = await browserFixture();
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1200, automaticHeight: 900 });
  const firstTab = browser.tabs.get(1); firstTab.url = "https://example.com/first";
  await browser.apply(firstTab);
  Object.assign(browser.windows.get(7), { width: 1450, height: 1000 });
  browser.listeners.bounds(structuredClone(browser.windows.get(7))); await browser.settle(); await browser.runTimers();
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: false });

  firstTab.url = "https://example.com/next";
  await browser.apply(firstTab);
  assert.deepEqual({ width: browser.windows.get(7).width, height: browser.windows.get(7).height }, { width: 1450, height: 1000 });
  browser.windows.set(8, { id: 8, type: "normal", state: "normal", left: 20, top: 20, width: 700, height: 500 });
  browser.tabs.set(3, { id: 3, windowId: 8, active: true, url: "https://example.com/other" });
  await browser.apply(browser.tabs.get(3));
  assert.deepEqual({ width: browser.windows.get(8).width, height: browser.windows.get(8).height }, { width: 1450, height: 1000 });

  await browser.dispatch({ type: "clear-virtual-rules" });
  await browser.apply(firstTab);
  assert.equal(browser.ephemeral.virtualDefaultRules, undefined);
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1300, automaticHeight: 850 });
  await browser.apply(firstTab);
  assert.deepEqual(browser.ephemeral.virtualDefaultRules, { "example.com": { width: 1300, height: 850 } });
});


test("enabled real rules beat existing virtual rules while disabled real rules remain non-exclusions", async () => {
  const broader = rule("domain_tree", "example.com", 900);
  const disabledSpecific = rule("exact_hostname", "app.example.com", 800); disabledSpecific.enabled = false;
  const browser = await browserFixture([broader, disabledSpecific]);
  browser.ephemeral.virtualDefaultRules = { "app.example.com": { width: 1450, height: 1000 } };
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: false });
  const tab = browser.tabs.get(1); tab.url = "https://app.example.com/path";
  await browser.apply(tab);
  assert.equal(browser.windows.get(7).width, 900);

  browser.local.smartWindowSizeConfig.rules.find((candidate) => candidate.id === broader.id).enabled = false;
  await browser.apply(tab);
  assert.deepEqual({ width: browser.windows.get(7).width, height: browser.windows.get(7).height }, { width: 1450, height: 1000 });
  delete browser.ephemeral.virtualDefaultRules;
  const updatesBefore = browser.updates.length;
  await browser.apply(tab);
  assert.equal(browser.updates.length, updatesBefore);
  assert.equal(browser.ephemeral.virtualDefaultRules, undefined);
});


test("default-disabled no-rule tabs remain unchanged and explicit rules still reapply on completion", async () => {
  const noRule = await browserFixture();
  const noRuleTab = noRule.tabs.get(1);
  noRuleTab.url = "https://unmatched.example/";
  noRule.listeners.updated(noRuleTab.id, { status: "complete" }, structuredClone(noRuleTab));
  await noRule.settle();
  assert.equal(noRule.updates.length, 0);

  const explicit = await browserFixture([rule()]);
  const explicitTab = explicit.tabs.get(1);
  await explicit.apply(explicitTab);
  Object.assign(explicit.windows.get(7), { width: 975, height: 725 });
  const beforeReload = explicit.updates.length;
  explicit.listeners.updated(explicitTab.id, { status: "complete" }, structuredClone(explicitTab));
  await explicit.settle();
  assert.equal(explicit.updates.length, beforeReload + 1);
  assert.equal(explicit.windows.get(7).width, 800);
});


test("browser and extension UI URLs never trigger website or automatic window sizing", async () => {
  const browser = await browserFixture();
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1400, automaticHeight: 800 });
  const tab = browser.tabs.get(1);
  const window = browser.windows.get(7);
  const internalUrls = [
    "moz-extension://test/options/options.html",
    "moz-extension://test/options/options.html#configuration",
    "moz-extension://test/options/options.html#rules",
    "moz-extension://test/options/options.html#diagnostics",
    "about:addons",
    "about:debugging",
    "chrome-extension://test/options/options.html",
    "chrome://extensions",
    "chrome://settings"
  ];
  for (const url of internalUrls) {
    Object.assign(window, { width: 910, height: 710 });
    tab.url = url;
    const updateCount = browser.updates.length;
    await browser.apply(tab);
    assert.deepEqual({ width: window.width, height: window.height }, { width: 910, height: 710 }, url);
    assert.equal(browser.updates.length, updateCount, url);
  }
});


test("content URLs retain default and matching-rule sizing", async () => {
  const browser = await browserFixture([rule("domain_tree", "matched.example", 1010)]);
  Object.assign(browser.local.smartWindowSizeConfig.global, { useDefaultSize: true, automaticWidth: 1400, automaticHeight: 800 });
  const tab = browser.tabs.get(1);
  const window = browser.windows.get(7);
  tab.url = "http://unmatched.example/document.json";
  await browser.apply(tab);
  assert.deepEqual({ width: window.width, height: window.height }, { width: 1400, height: 800 });
  Object.assign(window, { width: 900, height: 600 });
  tab.url = "https://matched.example/document.xml";
  await browser.apply(tab);
  assert.deepEqual({ width: window.width, height: window.height }, { width: 1010, height: 600 });
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
  assert.equal((await diagnostics.loadDiagnostics()).filter((entry) => entry.kind === "error").length, 1);
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
  assert.equal(browser.ephemeral.ruleEditors.owner, writer.editorToken);
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


test("ownership is reconstructed from session state and closed dialog windows release their records", async () => {
  const browser = await browserFixture();
  const writer = await browser.editor();
  const reader = await browser.editor(2);
  const session = structuredClone(browser.ephemeral.ruleEditors);
  await browser.restart();
  browser.ephemeral.ruleEditors = session;
  assert.equal((await writer.dispatch({ type: "get-rule-editor-state" })).writable, true);
  assert.equal((await browser.dispatch({ type: "get-configuration" })).rulesLocked, true);
  browser.tabs.delete(writer.dialog.id);
  browser.windows.delete(writer.dialog.windowId);
  browser.listeners.removed(writer.dialog.windowId);
  await browser.settle();
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
