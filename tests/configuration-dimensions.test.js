/** Exercises Configuration input events and saved fallback dimensions using the actual UI handlers. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createDefaultConfig } from "../core/config.js";
import { applyConfigurationAction } from "../core/configuration-actions.js";
import { resolveRule } from "../core/rule-resolver.js";
import { WINDOW_PRESETS, orientedPresetSize } from "../core/window-presets.js";


/** Creates a minimal input with callable browser-event listeners. @returns {object} Input fixture. */
function input(value = "") {
  return { value, checked: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } };
}


test("custom dimensions survive checkbox toggles, Save, and fallback resolution", async () => {
  const source = await readFile(new URL("../options/options.js", import.meta.url), "utf8");
  const config = createDefaultConfig();
  const form = input();
  form.elements = { Width: input("1200"), Height: input("960"), automaticWindowSize: input(), enabled: input() };
  form.elements.enabled.checked = true;
  const defaultPreset = input("preset:0");
  let saved;
  const context = vm.createContext({ form, defaultPreset, defaultVertical: input(), WINDOW_PRESETS, orientedPresetSize,
    globalBase: config.global, formDirty: false, FormData: class { *[Symbol.iterator]() {} },
    mutate(message) { saved = applyConfigurationAction(config, message); } });
  vm.runInContext(source.slice(source.indexOf("function selectedDefaultPreset()"), source.indexOf("/** Builds the shared preset")), context);
  vm.runInContext(source.slice(source.indexOf('defaultPreset.addEventListener("change"'), source.indexOf("/** Creates one labeled detail")), context);
  vm.runInContext(source.slice(source.indexOf('form.addEventListener("submit"'), source.indexOf('document.querySelector("#export")')), context);
  form.elements.automaticWindowSize.checked = true;
  form.elements.automaticWindowSize.listeners.change();
  form.elements.Width.value = "1377";
  form.elements.Width.listeners.input();
  form.elements.Height.value = "877";
  form.elements.Height.listeners.input();
  assert.equal(defaultPreset.value, "custom");
  for (const checked of [false, true]) {
    form.elements.automaticWindowSize.checked = checked;
    form.elements.automaticWindowSize.listeners.change();
    assert.equal(form.elements.Width.disabled, !checked);
    assert.equal(form.elements.Height.disabled, !checked);
    assert.equal(form.elements.Width.value, "1377");
    assert.equal(form.elements.Height.value, "877");
  }
  form.listeners.submit({ preventDefault() {} });
  const resolved = resolveRule("https://new.example/", saved);
  assert.equal(resolved.status, "DEFAULT");
  assert.deepEqual(resolved.size, { width: 1377, height: 877 });
  assert.equal(saved.rules.length, 0);
});
