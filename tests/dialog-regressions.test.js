/** Regression tests for background-local menu dispatch and manual-size dialog initialization. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { WINDOW_PRESETS, findHorizontalPresetIndex, orientedPresetSize } from "../core/window-presets.js";
import { createContextMenus, refreshSiteRuleMenu, registerContextMenuActions } from "../context/context-menus.js";
import { createDefaultConfig } from "../core/config.js";


/** Runs the real dialog script against minimal browser controls. @param {object} current Actual window size. @returns {Promise<Map>} Initialized controls. */
async function openSizeDialog(current) {
  const controls = new Map();
  for (const id of ["size-form", "preset", "width", "height", "vertical", "error", "limits", "bring-to-front", "cancel", "apply"]) {
    controls.set(id, { value: "", checked: false, disabled: false, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } });
  }
  const select = controls.get("preset");
  select.options = [];
  select.replaceChildren = () => { select.options = []; select.value = ""; };
  select.add = (option) => select.options.push(option);
  Object.defineProperty(select, "value", {
    get() { return this.selected ?? ""; },
    set(value) { this.selected = this.options.some((option) => option.value === value) ? value : ""; }
  });
  const source = (await readFile(new URL("../size-picker/size-picker.js", import.meta.url), "utf8")).replace(/^import .*;\r?$/gm, "");
  vm.runInNewContext(source, {
    APP_VERSION: "test", WINDOW_PRESETS, findHorizontalPresetIndex, orientedPresetSize,
    installClientErrors: () => {}, runClientAction: async (_operation, action) => action(),
    request: async () => ({ current, maximum: { width: 1920, height: 1080 } }),
    URLSearchParams, location: { search: "?windowId=7" }, window: { close() {} },
    Option: function(text, value) { this.text = text; this.value = value; },
    document: { querySelector: (selector) => controls.get(selector.startsWith("button") ? "apply" : selector.slice(1)), querySelectorAll: () => [] },
    chrome: { runtime: { sendMessage: async () => ({ current, maximum: { width: 1920, height: 1080 } }) } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  return controls;
}

test("reopening a 600 by 800 window retains SVGA Vertical and permits rotation", async () => {
  const controls = await openSizeDialog({ width: 600, height: 800 });
  assert.equal(controls.get("preset").value, "preset:1");
  assert.equal(controls.get("vertical").checked, true);
  assert.equal(controls.get("vertical").disabled, false);
  assert.equal(controls.get("width").value, "600");
  assert.equal(controls.get("height").value, "800");
});

test("Custom dimensions can rotate when the swapped size fits", async () => {
  const controls = await openSizeDialog({ width: 810, height: 610 });
  assert.equal(controls.get("preset").value, "custom");
  assert.equal(controls.get("vertical").disabled, false);
  controls.get("vertical").checked = true;
  controls.get("vertical").listeners.change();
  assert.equal(controls.get("width").value, "610");
  assert.equal(controls.get("height").value, "810");
});

test("menu clicks dispatch locally and report failed actions without runtime messaging", async () => {
  let listener;
  const requests = [];
  const failures = [];
  globalThis.chrome = { contextMenus: { onClicked: { addListener(callback) { listener = callback; } } } };
  try {
    registerContextMenuActions(async (message) => { requests.push(message); return { ok: message.type !== "set-global-enabled", error: "test failure" }; },
      async (operation, error) => failures.push(error.message));
    await listener({ menuItemId: "about" }, { id: 2, windowId: 7, url: "https://alpha.example/" });
    await listener({ menuItemId: "delete-matching-rules" }, { id: 2, windowId: 7, url: "https://alpha.example/" });
    await listener({ menuItemId: "set-sync-seed-size" }, { id: 2, windowId: 7, url: "https://alpha.example/" });
    await listener({ menuItemId: "global-enabled", checked: false });
    assert.deepEqual(requests.map((request) => request.type), ["open-about", "open-rule-editor", "set-sync-seed-size", "set-global-enabled"]);
    assert.deepEqual(requests[1], { type: "open-rule-editor", tabId: 2, sourceWindowId: 7, sourceUrl: "https://alpha.example/" });
    assert.deepEqual(requests[2], { type: "set-sync-seed-size", tabId: 2, windowId: 7 });
    assert.deepEqual(failures, ["test failure"]);
  } finally {
    delete globalThis.chrome;
  }
});


test("site-rule menu is disabled for an unsupported active URL and never dispatches it", async () => {
  const entries = [];
  let listener;
  const requests = [];
  const failures = [];
  const config = createDefaultConfig();
  globalThis.chrome = {
    storage: { local: { async get() { return { smartWindowSizeConfig: config }; } } },
    tabs: { async query() { return [{ id: 3, windowId: 9, url: "chrome-extension://test/options/options.html" }]; } },
    contextMenus: {
      async removeAll() {}, create(entry, callback) { entries.push(entry); callback(); },
      onClicked: { addListener(callback) { listener = callback; } }
    }, runtime: {}
  };
  try {
    await createContextMenus();
    assert.equal(entries.find((entry) => entry.id === "delete-matching-rules").enabled, false);
    assert.equal(entries.find((entry) => entry.id === "set-sync-seed-size").enabled, false);
    registerContextMenuActions(async (message) => { requests.push(message); return { ok: true }; }, async (_operation, error) => failures.push(error.message));
    await listener({ menuItemId: "delete-matching-rules" }, { id: 3, windowId: 9, url: "chrome-extension://test/options/options.html" });
    assert.deepEqual(requests, []);
    assert.deepEqual(failures, []);
  } finally {
    delete globalThis.chrome;
  }
});


test("Firefox keeps its five extension actions flat by omitting only visual separators", async () => {
  const entries = [];
  let listener;
  const requests = [];
  const config = createDefaultConfig();
  globalThis.chrome = {
    storage: { local: { async get() { return { smartWindowSizeConfig: config }; } } },
    tabs: { async query() { return [{ id: 3, windowId: 9, url: "https://alpha.example/" }]; } },
    runtime: { getBrowserInfo() {} },
    contextMenus: { async removeAll() {}, create(entry, callback) { entries.push(entry); callback(); }, onClicked: { addListener(callback) { listener = callback; } } }
  };
  try {
    await createContextMenus();
    assert.equal(entries.filter((entry) => entry.id === "open-options").length, 1);
    assert.equal(entries.filter((entry) => entry.type === "separator").length, 0);
    assert.deepEqual(entries.map((entry) => entry.id), ["global-enabled", "bring-window-on-screen", "delete-matching-rules", "set-sync-seed-size", "open-options", "about"]);
    registerContextMenuActions(async (message) => { requests.push(message); return { ok: true }; }, async () => {});
    await listener({ menuItemId: "open-options" });
    assert.deepEqual(requests, [{ type: "open-options" }]);
  } finally {
    delete globalThis.chrome;
  }
});


test("showing the toolbar menu uses its actual tab rather than a stale focused tab", async () => {
  const changes = [];
  const config = createDefaultConfig();
  config.global.syncRules = true;
  config.rules = [{ id: "alpha", scope: { type: "domain_tree", value: "alpha.example" }, enabled: true, width: 800, height: 600,
    position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null }, lastUpdatedAt: new Date().toISOString() }];
  globalThis.chrome = {
    storage: { local: { async get() { return { smartWindowSizeConfig: config }; } } },
    runtime: {},
    contextMenus: {
      update(id, properties, callback) { changes.push({ id, properties }); callback(); },
      refresh() {}
    }
  };
  try {
    await refreshSiteRuleMenu({ url: "https://alpha.example/" });
    await refreshSiteRuleMenu({ url: "chrome-extension://test/options/options.html" });
    assert.deepEqual(changes, [
      { id: "delete-matching-rules", properties: { enabled: true } },
      { id: "set-sync-seed-size", properties: { enabled: true } },
      { id: "delete-matching-rules", properties: { enabled: false } }
      , { id: "set-sync-seed-size", properties: { enabled: false } }
    ]);
  } finally {
    delete globalThis.chrome;
  }
});
