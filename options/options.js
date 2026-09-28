import { normalizeConfig } from "../core/config.js";
import { APP_VERSION } from "../core/app-version.js";
import { WINDOW_PRESETS, findHorizontalPresetIndex, orientedPresetSize } from "../core/window-presets.js";
import { request, installClientErrors, runClientAction, showClientError } from "../core/client.js";


/**
 * Renders SmartWindowSize settings, rules, and live session diagnostics.
 * Mutations go through validated background transactions rather than direct storage writes.
 */

/** chrome.storage.local key shared with the background configuration store. @type {string} */
const KEY = "smartWindowSizeConfig";


/** User-facing rule-scope labels keyed by their stored internal type. @type {Readonly<Record<string, string>>} */
const RULE_SCOPE_LABELS = Object.freeze({
  domain_tree: "This domain and its subdomains",
  domain_exact: "This domain only",
  url_subpaths: "This URL and its subpaths",
  url_any_parameters: "This URL — any parameters",
  url_exact_parameters: "This URL — exact query parameters",
  url_non_exact_parameters: "This URL — non-exact query parameters"
});


/** Mutable normalized configuration represented by the options form. @type {object} */
let config = normalizeConfig(null);

/** Snapshot of global settings represented by the editable form. @type {object} */
let globalBase = structuredClone(config.global);

/** Whether the global form has unsaved input that must survive external rule updates. @type {boolean} */
let formDirty = false;

/** Prevents concurrent writes initiated by this options view. @type {boolean} */
let saving = false;

/** Whether an open rule editor owns exclusive manual rule-editing access. @type {boolean} */
let rulesLocked = true;

installClientErrors(document.querySelector("#error"));
document.title = `SmartWindowSize ${APP_VERSION} — Configuration`;
document.querySelector("#application-title").textContent = `SmartWindowSize ${APP_VERSION}`;


/** Switches between Configuration and Diagnostics without leaving the options page. @param {string} tab Requested tab name. @returns {void} Updates visible panel and URL fragment. */
function selectOptionsTab(tab) {
  const panels = { configuration: "configuration-panel", rules: "rules-panel", diagnostics: "diagnostics" };
  for (const [name, panel] of Object.entries(panels)) {
    document.querySelector(`#${panel}`).hidden = name !== tab;
    document.querySelector(`#${name}-tab`).setAttribute("aria-selected", String(name === tab));
  }
  history.replaceState(null, "", `#${tab}`);
}


document.querySelector("#configuration-tab").addEventListener("click", () => selectOptionsTab("configuration"));
document.querySelector("#rules-tab").addEventListener("click", () => selectOptionsTab("rules"));
document.querySelector("#diagnostics-tab").addEventListener("click", () => selectOptionsTab("diagnostics"));
selectOptionsTab(["#rules", "#diagnostics"].includes(location.hash) ? location.hash.slice(1) : "configuration");


/** Human-readable diagnostic entries currently returned by the service worker. @type {Array<{occurredAt: string, operation: string, message: string}>} */
let diagnostics = [];


/** Renders the current session-only diagnostic log in Configuration. @returns {Promise<void>} Completes after the DOM reflects the latest entries. */
async function renderDiagnostics() {
  const response = await request({ type: "get-diagnostics" });
  diagnostics = response?.entries ?? [];
  document.querySelector("#diagnostic-status").textContent = diagnostics.length ? `${diagnostics.length} error${diagnostics.length === 1 ? "" : "s"} recorded in this browser session.` : "No errors recorded in this browser session.";
  document.querySelector("#diagnostic-log").textContent = diagnostics.length ? diagnostics.map((entry) => `${entry.occurredAt} | ${entry.operation}\n${entry.message}`).join("\n\n") : "No diagnostics available.";
  document.querySelector("#diagnostics-tab").classList.toggle("has-errors", diagnostics.length > 0);
}


/** Adds a concise native mouse-over explanation to every visible button. */
for (const button of document.querySelectorAll("button")) button.title ||= button.textContent.trim();


/** Copies the displayed diagnostic log for sharing without requiring Extension Manager access. @returns {Promise<void>} Completes after clipboard writing is requested. */
async function copyDiagnostics() {
  const text = diagnostics.length ? diagnostics.map((entry) => `${entry.occurredAt} | ${entry.operation}\n${entry.message}`).join("\n\n") : "No diagnostics available.";
  await navigator.clipboard.writeText(text);
}


/** Form element that edits global SmartWindowSize settings. @type {HTMLFormElement} */
const form = document.querySelector("#global");

/** Shared default-size preset selector. @type {HTMLSelectElement} */
const defaultPreset = document.querySelector("#default-preset");

/** Orientation of the selected default-size preset. @type {HTMLInputElement} */
const defaultVertical = document.querySelector("#default-vertical");


/** Replaces all form controls after loading, importing, or resetting settings. @returns {void} */
function renderGlobal() {
  globalBase = structuredClone(config.global);
  for (const [key, value] of Object.entries(config.global)) {
    const control = form.elements.namedItem(key);
    if (!control) continue;
    if (control.type === "checkbox") control.checked = value;
    else control.value = value;
  }
  form.elements.Width.value = config.global.automaticWidth;
  form.elements.Height.value = config.global.automaticHeight;
  form.elements.automaticWindowSize.checked = config.global.useDefaultSize;
  renderDefaultPresets(true);
  formDirty = false;
}


/** Returns the standard preset currently selected in the Options dropdown. @returns {object|null} Preset or null for Custom. */
function selectedDefaultPreset() {
  const index = Number(defaultPreset.value.replace("preset:", ""));
  return defaultPreset.value.startsWith("preset:") && Number.isInteger(index) ? WINDOW_PRESETS[index] ?? null : null;
}


/** Updates field availability without replacing unsaved dimensions. @returns {void} */
function synchronizeDimensionAvailability() {
  const dimensionsEnabled = form.elements.automaticWindowSize.checked;
  defaultPreset.disabled = !dimensionsEnabled;
  defaultVertical.disabled = !dimensionsEnabled;
  form.elements.Width.disabled = !dimensionsEnabled;
  form.elements.Height.disabled = !dimensionsEnabled;
}


/** Applies an explicitly selected preset and updates field availability. @returns {void} */
function synchronizeDefaultPreset() {
  const preset = selectedDefaultPreset();
  synchronizeDimensionAvailability();
  if (!preset) return;
  const size = orientedPresetSize(preset, defaultVertical.checked);
  form.elements.Width.value = size.width;
  form.elements.Height.value = size.height;
}


/** Builds the shared preset dropdown, optionally initializing it from the saved default. @param {boolean} fromSavedDefault Whether to select the persisted dimensions. @returns {void} */
function renderDefaultPresets(fromSavedDefault = false) {
  const horizontalIndex = findHorizontalPresetIndex(config.global.automaticWidth, config.global.automaticHeight);
  const verticalIndex = findHorizontalPresetIndex(config.global.automaticHeight, config.global.automaticWidth);
  const previousValue = defaultPreset.value;
  if (fromSavedDefault) defaultVertical.checked = verticalIndex >= 0 && horizontalIndex < 0;
  defaultPreset.replaceChildren();
  WINDOW_PRESETS.forEach((preset, index) => {
    const size = orientedPresetSize(preset, defaultVertical.checked);
    defaultPreset.add(new Option(`${preset.label} — ${size.width} × ${size.height}`, `preset:${index}`));
  });
  defaultPreset.add(new Option("Custom", "custom"));
  const presetIndex = horizontalIndex >= 0 ? horizontalIndex : verticalIndex;
  defaultPreset.value = fromSavedDefault ? (presetIndex >= 0 ? `preset:${presetIndex}` : "custom") : previousValue;
  synchronizeDefaultPreset();
}


/** Reorients the selected global default preset. */
defaultVertical.addEventListener("change", () => {
  renderDefaultPresets();
});


/** Applies the selected default preset without persisting until the form is saved. */
defaultPreset.addEventListener("change", synchronizeDefaultPreset);
form.addEventListener("input", () => { formDirty = true; });
for (const control of [form.elements.Width, form.elements.Height]) {
  control.addEventListener("input", () => { defaultPreset.value = "custom"; });
}
form.addEventListener("change", () => { formDirty = true; });


/** Creates one labeled detail for a readable multi-row rule card. @param {string} label Field caption. @param {string} value Field value. @returns {HTMLDivElement} Detail element. */
function createRuleDetail(label, value) {
  const detail = document.createElement("div");
  const caption = document.createElement("span");
  const content = document.createElement("strong");
  caption.textContent = label;
  content.textContent = value;
  detail.append(caption, content);
  return detail;
}


/** Renders all saved rules as readable cards and binds their deletion controls. @returns {void} */
function renderRules() {
  document.querySelector("#rules-empty").hidden = config.rules.length !== 0;
  document.querySelector("#rules").replaceChildren(...config.rules.map((rule) => {
    const card = document.createElement("article");
    card.className = "rule-card";
    const header = document.createElement("div");
    header.className = "rule-card-header";
    const scope = document.createElement("h3");
    scope.textContent = RULE_SCOPE_LABELS[rule.scope.type] ?? "Unknown scope";
    const status = document.createElement("strong");
    status.textContent = rule.enabled ? "Enabled" : "Disabled";
    header.append(scope, status);
    const value = document.createElement("p");
    value.className = "rule-card-value";
    value.textContent = rule.scope.value;
    const details = document.createElement("div");
    details.className = "rule-card-details";
    details.append(
      createRuleDetail("Size", `${rule.width} × ${rule.height}`),
      createRuleDetail("Remember position", rule.position.enabled ? "Yes" : "No"),
      createRuleDetail("Remember monitor", rule.display.enabled ? "Yes" : "No"),
      createRuleDetail("Position", rule.position.enabled ? `${rule.position.x},${rule.position.y}` : ""),
      createRuleDetail("Last updated", new Date(rule.lastUpdatedAt).toLocaleDateString())
    );
    const actions = document.createElement("div");
    actions.className = "rule-card-actions";
    const toggle = document.createElement("button");
    toggle.textContent = rule.enabled ? "Disable" : "Enable";
    toggle.title = `${toggle.textContent} this saved rule`;
    toggle.disabled = rulesLocked;
    toggle.addEventListener("click", () => mutate({ type: "set-rule-enabled", ruleId: rule.id, enabled: !rule.enabled, base: rule }));
    const remove = document.createElement("button");
    remove.textContent = "Delete";
    remove.title = "Delete this saved rule";
    remove.disabled = rulesLocked;
    remove.addEventListener("click", () => mutate({ type: "delete-rule", ruleId: rule.id, base: rule }));
    actions.append(toggle, remove);
    card.append(header, value, details, actions);
    return card;
  }));
}


/** Sends a granular write through the background's serialized configuration queue. @param {object} message Mutation. @param {boolean} refreshForm Whether to replace the global form. @returns {Promise<void>} Completion. */
async function mutate(message, refreshForm = false) {
  if (saving || (rulesLocked && message.type !== "save-global-settings")) return;
  saving = true;
  await runClientAction("Save configuration", async () => {
    config = (await request(message)).config;
    renderRules();
    if (refreshForm) renderGlobal();
  });
  saving = false;
}


/** Saves only global settings, never a stale copy of the rule list. */
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const global = { ...globalBase };
  for (const [key, value] of new FormData(form)) if (key !== "automaticWindowSize") global[key] = ["ruleRetentionDays"].includes(key) ? Number(value) : value;
  global.automaticWidth = Number(form.elements.Width.value);
  global.automaticHeight = Number(form.elements.Height.value);
  global.useDefaultSize = form.elements.automaticWindowSize.checked;
  for (const name of ["enabled", "rememberMonitor"]) {
    if (form.elements[name]) global[name] = form.elements[name].checked;
  }
  mutate({ type: "save-global-settings", global, base: globalBase }, true);
});
form.elements.automaticWindowSize.addEventListener("change", synchronizeDimensionAvailability);
document.querySelector("#export").addEventListener("click", () => runClientAction("Export configuration", async () => {
  const latest = (await request({ type: "get-configuration" })).config;
  const url = URL.createObjectURL(new Blob([JSON.stringify(latest, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "smart-window-size.json" }); a.click(); URL.revokeObjectURL(url);
}));
document.querySelector("#import").addEventListener("change", (event) => runClientAction("Import configuration", async () => {
  if (rulesLocked) return;
  const file = event.target.files[0];
  if (!file) return;
  const candidate = JSON.parse(await file.text());
  await mutate({ type: "import-configuration", config: candidate, base: config }, true);
  event.target.value = "";
}));
document.querySelector("#reset").addEventListener("click", () => {
  if (rulesLocked) return;
  if (confirm("Reset all configuration?")) mutate({ type: "reset-configuration", base: config }, true);
});
document.querySelector("#open-readme").addEventListener("click", () => runClientAction("Open local README", () => request({ type: "open-local-readme" })));
document.querySelector("#copy-diagnostics").addEventListener("click", () => runClientAction("Copy diagnostics", copyDiagnostics));
document.querySelector("#clear-diagnostics").addEventListener("click", () => runClientAction("Clear diagnostics", async () => {
  await request({ type: "clear-diagnostics" });
  await renderDiagnostics();
}));
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "diagnostics-changed") renderDiagnostics().catch((error) => { document.querySelector("#diagnostic-status").textContent = error.message; });
  if (message.type === "rule-editors-changed") refreshRuleAccess().catch((error) => showClientError("Refresh rule access", error));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[KEY]) {
    config = normalizeConfig(changes[KEY].newValue);
    renderRules();
    if (!formDirty && !saving) renderGlobal();
  }
});


/** Reads current locking and rules while preserving unsaved global settings. @returns {Promise<void>} Updated rule table and mutation availability. */
async function refreshRuleAccess() {
  const response = await request({ type: "get-configuration" });
  config = response.config;
  rulesLocked = response.rulesLocked;
  document.querySelector("#import").disabled = rulesLocked;
  document.querySelector("#reset").disabled = rulesLocked;
  document.querySelector("#rule-lock-status").hidden = !rulesLocked;
  renderRules();
}


runClientAction("Load configuration", async () => {
  await refreshRuleAccess();
  renderGlobal();
  renderRules();
  await renderDiagnostics();
});
