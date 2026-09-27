/**
 * SmartWindowSize | Version: 1.0.3 | Last updated: 2026-09-27 20:25:00 +02:00
 *
 * Coordinates serialized window operations, validated configuration writes,
 * unique dialogs, and session diagnostics.
 */
import { loadConfig, updateConfig } from "../core/storage.js";
import { matchingRulesForUrl, resolveRule } from "../core/rule-resolver.js";
import { updateRuleDimensions, updateRuleForResize } from "../core/rule-updater.js";
import { applyResolvedRule, bringWindowOnScreen, displayForRule, maximumManualSizeForWindow, resizeWindowManually, safeCascadePosition } from "./window-manager.js";
import { updateActionIcon, updateDefaultActionIcon } from "./action-icon.js";
import { createContextMenus, registerContextMenuActions } from "../context/context-menus.js";
import { APP_VERSION } from "../core/app-version.js";
import { createRuleId, normalizeScopeType } from "../core/config.js";
import { applyConfigurationAction, applySiteRuleEdits, fingerprint } from "../core/configuration-actions.js";
import { windowBoundsChanged } from "../core/window-bounds.js";
import { scopeForUrl, toUrl } from "../core/rule-matcher.js";
import { clearDiagnostics, loadDiagnostics, recordDiagnostic } from "../core/diagnostics.js";
import { readSession, writeSession, removeSession } from "../core/runtime-session.js";

/** Per-window operation chains prevent rule application and persistence races. @type {Map<number, Promise<unknown>>} */
const windowQueues = new Map();

/** Short debounce timers; the corresponding pending bounds also live in session storage. @type {Map<number, ReturnType<typeof setTimeout>>} */
const resizeTimers = new Map();

/** Windows still receiving browser-created placement events. @type {Set<number>} */
const initializingWindows = new Set();

/** Final initial-placement timers, cancelled when their windows close. @type {Map<number, ReturnType<typeof setTimeout>>} */
const creationTimers = new Map();

/** Windows currently being changed by the extension, captured at event delivery time. @type {Set<number>} */
const changingWindows = new Set();

/** Last observed active tab in each browser window, including its URL at event time. @type {Map<number, object>} */
const activeTabs = new Map();

/** In-flight unique-dialog opens, keyed by the dialog identity. @type {Map<string, Promise<unknown>>} */
const dialogOpens = new Map();

/** Serializes editor ownership and manual rule mutations across all dialogs. @type {Promise<unknown>} */
let editorQueue = Promise.resolve();


/** Announces access or saved-rule changes without exposing source URLs. @returns {void} */
function notifyRuleEditors() {
  chrome.runtime.sendMessage({ type: "rule-editors-changed" }).catch(() => undefined);
}


/** Runs an editor operation with a reconciled, session-persisted registry. @param {Function} operation Receives live editor records and owner tab ID. @returns {Promise<unknown>} Operation result. */
function withEditors(operation) {
  const work = editorQueue.catch(() => undefined).then(async () => {
    const registry = await readSession("ruleEditors") ?? { owner: null, entries: {} };
    const before = fingerprint(registry);
    for (const [id, entry] of Object.entries(registry.entries)) {
      const live = await chrome.tabs.get(Number(id)).catch(() => null);
      if (!live || (live.url !== entry.dialogUrl && live.pendingUrl !== entry.dialogUrl)) delete registry.entries[id];
      else entry.windowId = live.windowId;
    }
    if (!registry.entries[registry.owner]) registry.owner = null;
    try { return await operation(registry); }
    finally {
      if (fingerprint(registry) !== before) {
        await writeSession("ruleEditors", registry);
        notifyRuleEditors();
      }
    }
  });
  editorQueue = work;
  return work;
}


/** Authenticates a dialog against its browser-supplied tab and bound source. @param {object} registry Live sessions. @param {object} sender Runtime sender. @param {object} message Request. @returns {object} Bound editor record. */
function editorRecord(registry, sender, message) {
  const entry = registry.entries[sender.tab?.id];
  if (!entry || entry.dialogUrl !== sender.tab.url || entry.sourceId !== message.tabId) throw new Error("Reopen this rule dialog from its source page.");
  return entry;
}


/** Rejects every rule mutation from a read-only or rebound dialog. @param {object} registry Live sessions. @param {object} sender Runtime sender. @param {object} message Mutation. @returns {void} Throws before any preparation or write. */
function requireEditorOwner(registry, sender, message) {
  const entry = editorRecord(registry, sender, message);
  if (registry.owner !== sender.tab.id) throw new Error("This dialog is read-only. Focus the editable dialog or enable editing.");
  if (entry.url !== message.url) throw new Error("The source URL does not match this dialog.");
}

/** Serialized context-menu replacement. @type {Promise<unknown>} */
let menuQueue = Promise.resolve();

/** Serialized icon refresh operations. @type {Promise<unknown>} */
let iconQueue = Promise.resolve();

/** Already reported icon failures avoid recursive diagnostic refresh loops. @type {Set<string>} */
const iconFailures = new Set();

/** Expected browser-event lifetime following a programmatic window update. @type {number} */
const UPDATE_GRACE_MS = 1200;


/** Serializes one operation for a window and releases unused queue entries. @param {number} id Window ID. @param {Function} operation Async operation. @returns {Promise<unknown>} Result. */
function inWindow(id, operation) {
  const work = (windowQueues.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
  windowQueues.set(id, work);
  work.finally(() => { if (windowQueues.get(id) === work) windowQueues.delete(id); }).catch(() => undefined);
  return work;
}


/** Returns the ephemeral state key for one window. @param {number} id Window ID. @returns {string} Session key. */
function windowKey(id) { return `windowState:${id}`; }


/** Excludes extension dialogs and nonstandard browser windows from automatic site handling. @param {object} window Browser window. @returns {boolean} Whether this is a website window. */
function isSiteWindow(window) { return !window.type || window.type === "normal"; }


/** Replaces the context menu after previous registrations finish. @param {object|undefined} tab Active tab used to set site-rule availability immediately. @returns {Promise<unknown>} Completion. */
function refreshContextMenus(tab = undefined) {
  menuQueue = menuQueue.catch(() => undefined).then(() => createContextMenus(tab));
  return menuQueue;
}


/** Notifies already open views; absent listeners are expected and harmless. @returns {void} */
function notifyDiagnostics() {
  chrome.runtime.sendMessage({ type: "diagnostics-changed" }).catch(() => undefined);
}


/** Refreshes every icon without recursively logging icon failures. @param {object} config Latest configuration. @returns {Promise<void>} Completion. */
async function refreshActionIcons(config) {
  const hasErrors = (await loadDiagnostics()).length > 0;
  const failures = await updateDefaultActionIcon(config.global.enabled, hasErrors);
  for (const tab of await chrome.tabs.query({})) {
    if (Number.isInteger(tab.id)) failures.push(...await updateActionIcon(tab.id, resolveRule(tab.url ?? "", config), hasErrors));
  }
  for (const failure of failures) {
    const key = `${failure.operation}:${failure.error?.message ?? failure.error}`;
    if (iconFailures.has(key)) continue;
    iconFailures.add(key);
    await recordDiagnostic(failure.operation, failure.error, config.global.debug);
  }
  if (failures.length) {
    notifyDiagnostics();
    if (!hasErrors) await refreshActionIcons(config);
  }
}


/** Schedules a refresh that reads configuration when it actually runs. @returns {Promise<unknown>} Completion. */
function scheduleIconRefresh() {
  iconQueue = iconQueue.catch(() => undefined).then(async () => refreshActionIcons(await loadConfig()));
  return iconQueue;
}


/** Stores a local error and makes it immediately visible to the user. @param {string} operation Failed operation. @param {unknown} error Failure. @returns {Promise<void>} Best-effort completion. */
async function reportDiagnostic(operation, error) {
  try {
    const config = await loadConfig();
    await recordDiagnostic(operation, error, config.global.debug);
    notifyDiagnostics();
    await scheduleIconRefresh();
  } catch {
    // A diagnostic failure must not create an unhandled error loop.
  }
}


/** Applies one tab icon without interrupting window recovery on icon failure. @param {number} tabId Tab ID. @param {object} resolved Resolution. @returns {Promise<void>} Completion. */
async function synchronizeActionIcon(tabId, resolved) {
  const failures = await updateActionIcon(tabId, resolved, (await loadDiagnostics()).length > 0);
  for (const failure of failures) await reportDiagnostic(failure.operation, failure.error);
}


/** Runs an extension-originated update and records its actual final bounds. @param {number} id Window ID. @param {Function} operation Window operation. @returns {Promise<unknown>} Operation result. */
async function changeWindow(id, operation) {
  changingWindows.add(id);
  try {
    const old = await readSession(windowKey(id)) ?? {};
    await writeSession(windowKey(id), { ...old, changing: true, until: Date.now() + UPDATE_GRACE_MS });
    return await operation();
  } finally {
    try {
      const actual = await chrome.windows.get(id);
      await writeSession(windowKey(id), { bounds: actual, state: actual.state, expected: actual, until: Date.now() + UPDATE_GRACE_MS, changing: false });
    } finally {
      changingWindows.delete(id);
    }
  }
}


/** Persists a user change against the narrowest rule without changing its coverage. @param {object} tab Source tab at event time. @param {object} window Actual changed bounds. @returns {Promise<void>} Completion. */
async function persistUserBounds(tab, window) {
  if (!tab?.url || window.state !== "normal") return;
  const display = await displayForRule(null, window);
  await updateConfig((config) => {
    const update = updateRuleForResize(config, { url: tab.url, position: { x: window.left, y: window.top }, displayId: display?.id }, window.width, window.height);
    return update.changed ? update.config : undefined;
  });
}


/** Saves a pending physical change before rule application can change tab ownership. Must run inside the window queue. @param {number} id Window ID. @returns {Promise<void>} Completion. */
async function flushPendingBounds(id) {
  clearTimeout(resizeTimers.get(id));
  resizeTimers.delete(id);
  const state = await readSession(windowKey(id));
  if (!state?.pending) return;
  await persistUserBounds(state.pending.tab, state.pending.window);
  delete state.pending;
  await writeSession(windowKey(id), state);
}


/** Applies the active tab's latest rule inside the owning window queue. @param {object} tab Candidate tab. @param {boolean} useSavedPosition Whether a newly created browser window may restore a saved position. @returns {Promise<void>} Completion. */
async function applyForTab(tab, useSavedPosition = false) {
  if (!Number.isInteger(tab?.id) || tab.windowId === chrome.windows.WINDOW_ID_NONE) return;
  return inWindow(tab.windowId, async () => {
    await flushPendingBounds(tab.windowId);
    tab = await chrome.tabs.get(tab.id);
    if (!tab.active) return;
    activeTabs.set(tab.windowId, tab);
    const window = await chrome.windows.get(tab.windowId);
    if (!isSiteWindow(window)) return;
    if (window.state !== "normal") {
      await writeSession(windowKey(window.id), { bounds: window, state: window.state });
      return;
    }
    const config = await loadConfig();
    const resolved = resolveRule(tab.url ?? "", config);
    await synchronizeActionIcon(tab.id, resolved);
    if (resolved.status === "DISABLED") {
      await writeSession(windowKey(window.id), { bounds: window, state: window.state });
      return { skipped: "disabled" };
    }
    const canApply = async () => {
      const currentTab = await chrome.tabs.get(tab.id);
      const currentConfig = await loadConfig();
      return currentTab.active && currentTab.windowId === tab.windowId && currentTab.url === tab.url &&
        fingerprint(resolveRule(tab.url ?? "", currentConfig)) === fingerprint(resolved);
    };
    if (!await canApply()) return;
    const appliedResolution = resolved.rule && !config.global.rememberMonitor
      ? { ...resolved, rule: { ...resolved.rule, display: { enabled: false, id: null } } } : resolved;
    const application = await changeWindow(tab.windowId, () => applyResolvedRule(tab.windowId, appliedResolution, canApply, useSavedPosition));
    if (resolved.status === "RULE" && application.sizeAdjusted) {
      await updateConfig((latest) => {
        const current = resolveRule(tab.url, latest);
        if (fingerprint(current) !== fingerprint(resolved)) return undefined;
        const update = updateRuleDimensions(latest, resolved.rule.id, application.size.width, application.size.height);
        return update.changed ? update.config : undefined;
      });
    }
    return application;
  });
}


/** Corrects initial placement without saving browser-created bounds as a site rule. @param {number} id New window ID. @returns {Promise<void>} Completion. */
async function recoverNewWindow(id) {
  await inWindow(id, async () => {
    const window = await chrome.windows.get(id);
    if (!isSiteWindow(window)) return;
    if (window.state !== "normal") {
      await writeSession(windowKey(id), { bounds: window, state: window.state });
      return;
    }
    if (!(await loadConfig()).global.enabled) {
      await writeSession(windowKey(id), { bounds: window, state: window.state });
      return;
    }
    await changeWindow(id, async () => {
      const display = await displayForRule(null, window);
      if (!display) return;
      const result = await bringWindowOnScreen(id, async () => (await loadConfig()).global.enabled);
      if (result.changed && result.verified) {
        const key = `cascade:${display.id}`;
        const slot = await readSession(key) ?? 0;
        if (slot > 0 && (await loadConfig()).global.enabled) await chrome.windows.update(id, safeCascadePosition(result.actual, display, slot));
        await writeSession(key, slot + 1);
      }
    });
  });
}


/** Handles an observed bounds event using its original tab ownership. @param {object} window Event bounds. @param {object|null} owner Tab captured when the event arrived. @param {boolean} ownChange Whether a programmatic operation was running. @returns {Promise<void>} Completion. */
async function handleBoundsChanged(window, owner, ownChange) {
  let restored = false;
  await inWindow(window.id, async () => {
    if (!isSiteWindow(window)) return;
    if (initializingWindows.has(window.id) || (await readSession(`newWindow:${window.id}`)) > Date.now()) return;
    const previous = await readSession(windowKey(window.id));
    const suppressed = window.state === "normal" && (ownChange || previous?.until > Date.now() &&
      (previous.changing || previous.expected?.state === window.state && !windowBoundsChanged(previous.expected, window)));
    if (suppressed) return;
    const next = { bounds: window, state: window.state, pending: previous?.pending };
    await writeSession(windowKey(window.id), next);
    if (window.state !== "normal") return;
    restored = ["maximized", "fullscreen"].includes(previous?.state);
    if (restored || !previous?.bounds || !windowBoundsChanged(previous.bounds, window)) return;
    const tab = owner ?? (await chrome.tabs.query({ active: true, windowId: window.id }))[0];
    if (previous?.pending && (previous.pending.tab?.id !== tab?.id || previous.pending.tab?.url !== tab?.url)) await flushPendingBounds(window.id);
    next.pending = { tab, window };
    await writeSession(windowKey(window.id), next);
    clearTimeout(resizeTimers.get(window.id));
    resizeTimers.set(window.id, setTimeout(() => {
      inWindow(window.id, () => flushPendingBounds(window.id)).catch((error) => reportDiagnostic("Save resized window", error));
    }, 120));
  });
  if (restored) await applyForTab((await chrome.tabs.query({ active: true, windowId: window.id }))[0]);
}


/** Focuses an existing dialog or creates exactly one instance even for concurrent clicks. @param {string} key Dialog identity. @param {string} url Dialog URL. @param {number} width Outer width. @param {number} height Outer height. @returns {Promise<object>} Created or focused browser window. */
async function openUniqueDialog(key, url, width, height) {
  if (dialogOpens.has(key)) return dialogOpens.get(key);
  const work = (async () => {
    const windows = await chrome.windows.getAll({ populate: true });
    const existing = windows.find((window) => window.tabs?.some((tab) => [tab.url, tab.pendingUrl].some((candidate) => key === "about" ? candidate?.split("?")[0] === url.split("?")[0] : candidate === url)));
    if (existing) return chrome.windows.update(existing.id, { focused: true });
    return chrome.windows.create({ url, type: "popup", width, height, focused: true });
  })();
  dialogOpens.set(key, work);
  try { return await work; } finally { dialogOpens.delete(key); }
}


/** Opens or focuses the single internal tab that displays the packaged local README. @returns {Promise<void>} Completes after the tab is created or focused. */
async function openLocalReadme() {
  const url = chrome.runtime.getURL("readme-viewer/readme.html");
  const existing = (await chrome.tabs.query({})).find((tab) => tab.url === url || tab.pendingUrl === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}


/** Resolves an explicit source tab, or the last focused browser tab for popup actions. @param {object} message Action request. @param {object} sender Browser sender. @returns {Promise<object|undefined>} Source tab. */
async function sourceTab(message, sender) {
  if (Number.isInteger(message.tabId)) return chrome.tabs.get(message.tabId);
  if (sender.tab) return chrome.tabs.get(sender.tab.id);
  return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
}


/** Requires a live, enabled website source for the rule editor. @param {object} tab Source tab. @param {string|undefined} url Expected unchanged URL. @returns {Promise<object>} Latest configuration. */
async function requireEditorSource(tab, url) {
  const config = await loadConfig();
  if (!config.global.enabled) throw new Error("SmartWindowSize is disabled.");
  if (!toUrl(tab?.url)) throw new Error("Rules can be set only for an HTTP or HTTPS website.");
  if (url !== undefined && tab.url !== url) throw new Error("The source page changed. Reload this dialog before saving.");
  return config;
}


/** Validates and executes one background action without requiring a tab for global actions. @param {object} message Request. @param {object} sender Browser sender. @returns {Promise<object>} Response. */
async function dispatchRequest(message, sender = {}) {
  const coordinated = ["open-rule-editor", "get-rule-editor-state", "enable-rule-editing", "focus-rule-editor", "prepare-site-rule", "save-site-rules", "get-configuration", "delete-rule", "import-configuration", "reset-configuration"];
  if (coordinated.includes(message.type)) return withEditors((registry) => dispatchAction(message, sender, registry));
  return dispatchAction(message, sender);
}


/** Executes actions after obtaining the editor gate where required. @param {object} message Request. @param {object} sender Runtime sender. @param {object} registry Locked editor registry for coordinated actions. @returns {Promise<object>} Response. */
async function dispatchAction(message, sender, registry) {
  if (message.type === "get-app-version") return { version: APP_VERSION };
  if (message.type === "get-configuration") return { config: await loadConfig(), rulesLocked: registry.owner !== null };
  if (message.type === "focus-rule-editor") {
    editorRecord(registry, sender, message);
    const owner = registry.entries[registry.owner];
    if (!owner) throw new Error("No editable dialog is open. You can enable editing here.");
    await chrome.windows.update(owner.windowId, { focused: true });
    return { ok: true };
  }
  if (["get-rule-editor-state", "enable-rule-editing"].includes(message.type)) {
    const entry = editorRecord(registry, sender, message);
    const source = await chrome.tabs.get(entry.sourceId).catch(() => null);
    const config = await loadConfig();
    const sourceValid = source?.url === entry.url;
    if (message.type === "enable-rule-editing") {
      if (!sourceValid || !config.global.enabled) throw new Error("The source page changed or the extension is disabled. Editing is unavailable.");
      if (registry.owner !== null && registry.owner !== sender.tab.id) throw new Error("Rules are being edited in another window.");
      registry.owner = sender.tab.id;
    }
    return { url: entry.url, rules: matchingRulesForUrl(entry.url, config), ownsEditor: registry.owner === sender.tab.id,
      writable: registry.owner === sender.tab.id && sourceValid && config.global.enabled,
      hasOwner: registry.owner !== null, sourceValid, enabled: config.global.enabled };
  }
  if (["prepare-site-rule", "save-site-rules"].includes(message.type)) requireEditorOwner(registry, sender, message);
  if (message.type === "get-diagnostics") return { entries: await loadDiagnostics((await loadConfig()).global.debug) };
  if (message.type === "report-client-error") {
    if (typeof message.operation !== "string" || typeof message.message !== "string") throw new Error("Invalid diagnostic entry.");
    await reportDiagnostic(message.operation, new Error(message.message));
    return { ok: true };
  }
  if (message.type === "clear-diagnostics") {
    await clearDiagnostics();
    iconFailures.clear();
    notifyDiagnostics();
    await scheduleIconRefresh();
    return { ok: true };
  }
  if (message.type === "set-global-enabled") {
    if (typeof message.enabled !== "boolean") throw new Error("Invalid extension state.");
    await updateConfig((config) => ({ ...config, global: { ...config.global, enabled: message.enabled } }));
    await refreshContextMenus();
    await scheduleIconRefresh();
    return { ok: true };
  }
  if (["save-global-settings", "delete-rule", "import-configuration", "reset-configuration"].includes(message.type)) {
    if (message.type !== "save-global-settings" && registry.owner !== null) throw new Error("Close the editable rule dialog before deleting, importing, or resetting rules.");
    const config = await updateConfig((current) => applyConfigurationAction(current, message));
    return { ok: true, config };
  }
  if (message.type === "open-about") {
    const owner = await sourceTab(message, sender).catch(() => null);
    await openUniqueDialog("about", `${chrome.runtime.getURL("about/about.html")}?tabId=${owner?.id ?? ""}`, 420, 340);
    return { ok: true };
  }
  if (message.type === "open-local-readme") {
    await openLocalReadme();
    return { ok: true };
  }
  const tab = await sourceTab(message, sender);
  if (message.type === "get-state") {
    const config = await loadConfig();
    const window = tab ? await chrome.windows.get(tab.windowId) : null;
    return { config, url: tab?.url, resolved: resolveRule(tab?.url ?? "", config), windowId: tab?.windowId, tabId: tab?.id,
      currentSize: window ? { width: window.width, height: window.height } : null };
  }
  if (message.type === "focus-window") {
    const id = message.windowId ?? tab?.windowId;
    if (!Number.isInteger(id)) throw new Error("The source window is no longer available.");
    await chrome.windows.update(id, { focused: true });
    return { ok: true };
  }
  if (message.type === "open-rule-editor") {
    await requireEditorSource(tab);
    const dialogUrl = `${chrome.runtime.getURL("rule-delete/rule-delete.html")}?tabId=${tab.id}`;
    const window = await openUniqueDialog(`rules:${tab.id}`, dialogUrl, 640, 620);
    const dialog = (await chrome.tabs.query({ windowId: window.id })).find((candidate) => candidate.url === dialogUrl || candidate.pendingUrl === dialogUrl);
    if (!dialog) throw new Error("The rule dialog could not be initialized.");
    if (!registry.entries[dialog.id]) {
      registry.entries[dialog.id] = { sourceId: tab.id, url: tab.url, windowId: window.id, dialogUrl };
      if (registry.owner === null) registry.owner = dialog.id;
    }
    return { ok: true };
  }
  if (message.type === "open-size-picker") {
    if (!(await loadConfig()).global.enabled) throw new Error("SmartWindowSize is disabled.");
    if (!tab) throw new Error("The source window is no longer available.");
    await openUniqueDialog(`size:${tab.windowId}`, `${chrome.runtime.getURL("size-picker/size-picker.html")}?windowId=${tab.windowId}`, 440, 460);
    return { ok: true };
  }
  if (message.type === "get-window-size-limits") {
    if (!Number.isInteger(message.windowId)) throw new Error("Invalid window identifier.");
    const current = await chrome.windows.get(message.windowId);
    return { current, maximum: await maximumManualSizeForWindow(current) };
  }
  if (message.type === "resize-window" || message.type === "bring-window-on-screen") {
    const id = message.windowId ?? tab?.windowId;
    if (!Number.isInteger(id)) throw new Error("Invalid window identifier.");
    return inWindow(id, async () => {
      await flushPendingBounds(id);
      if (!(await loadConfig()).global.enabled) throw new Error("SmartWindowSize is disabled.");
      const canApply = async () => (await loadConfig()).global.enabled;
      const result = await changeWindow(id, () => message.type === "resize-window"
        ? resizeWindowManually(id, message.width, message.height, canApply) : bringWindowOnScreen(id, canApply));
      const actual = await chrome.windows.get(id);
      const [owner] = await chrome.tabs.query({ active: true, windowId: id });
      if (result.changed) await persistUserBounds(owner, actual);
      if (message.type === "resize-window" && result.exact === false) throw new Error(`The browser applied ${actual.width} × ${actual.height}, not ${message.width} × ${message.height}.`);
      if (message.type === "bring-window-on-screen" && !result.verified) {
        throw new Error(result.display ? `The browser did not apply visible bounds. Before: ${JSON.stringify(result.before)}; requested: ${JSON.stringify(result.requested)}; actual: ${JSON.stringify(result.actual)}; display: ${JSON.stringify(result.display)}.`
          : "Display work-area data is unavailable. Approximate centering was attempted, but visibility cannot be verified.");
      }
      return { ok: true, ...result };
    });
  }
  if (message.type === "prepare-site-rule") {
    const config = await requireEditorSource(tab, message.url);
    const type = normalizeScopeType(message.scope);
    if (!type) throw new Error("Select a rule scope.");
    const current = await chrome.windows.get(tab.windowId);
    if (current.state !== "normal") throw new Error("Restore the source window before saving its dimensions.");
    const existing = message.existing;
    const value = existing?.scope.type === type ? existing.scope.value : scopeForUrl(tab.url, type);
    const display = await displayForRule(null, current);
    return { rule: { id: existing?.id ?? createRuleId(), scope: { type, value }, enabled: existing?.enabled ?? true,
      width: current.width, height: current.height,
      position: message.rememberPosition ? { enabled: true, x: current.left, y: current.top } : { enabled: false, x: null, y: null },
      display: config.global.rememberMonitor && display ? { enabled: true, id: display.id } : existing?.display ?? { enabled: false, id: null },
      lastUpdatedAt: new Date().toISOString() } };
  }
  if (message.type === "save-site-rules") {
    await requireEditorSource(tab, message.url);
    if (!tab.active) throw new Error("Activate the source tab before saving its rules.");
    await inWindow(tab.windowId, async () => {
      await flushPendingBounds(tab.windowId);
      const currentTab = await chrome.tabs.get(tab.id);
      if (!currentTab.active) throw new Error("Activate the source tab before saving its rules.");
      if (currentTab.windowId !== tab.windowId) throw new Error("The source tab moved to another window. Reload this dialog.");
      const window = await chrome.windows.get(currentTab.windowId);
      if (window.state !== "normal") throw new Error("Restore the source window before saving its rules.");
      const display = await displayForRule(null, window);
      await updateConfig((config) => {
        const candidate = applySiteRuleEdits(config, currentTab.url, message);
        const changedIds = new Set(message.rules.filter((rule) => fingerprint(rule) !== fingerprint(message.baseRules.find((base) => base.id === rule.id))).map((rule) => rule.id));
        candidate.rules = candidate.rules.map((rule) => changedIds.has(rule.id) ? {
          ...rule, width: window.width, height: window.height,
          position: rule.position.enabled ? { enabled: true, x: window.left, y: window.top } : rule.position,
          display: config.global.rememberMonitor && display ? { enabled: true, id: display.id } : rule.display,
          lastUpdatedAt: new Date().toISOString()
        } : rule);
        return candidate;
      });
    });
    const applied = await applyForTab(tab);
    if (!applied || applied.skipped === "source-changed") throw new Error("Rules were saved, but the source tab changed before they could be applied. Return to the source page and reload this dialog.");
    return { ok: true };
  }
  throw new Error("Unsupported extension request.");
}


/** Bridges runtime callbacks and the same local context-menu dispatcher. @param {object} message Request. @param {object} sender Source. @param {Function} sendResponse Browser response callback. @returns {boolean|undefined} Async-response marker. */
function handleExtensionRequest(message, sender, sendResponse) {
  if (["diagnostics-changed", "rule-editors-changed"].includes(message.type)) return;
  dispatchRequest(message, sender).then(sendResponse).catch(async (error) => {
    await reportDiagnostic(message.type ?? "Handle extension request", error);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
}


/** Initializes missing baselines without treating browser startup as a user resize. @returns {Promise<void>} Completion. */
async function initialize() {
  const activeTabsAtStartup = await chrome.tabs.query({ active: true });
  for (const tab of activeTabsAtStartup) activeTabs.set(tab.windowId, tab);
  for (const window of await chrome.windows.getAll({})) {
    await inWindow(window.id, async () => {
      if (!await readSession(windowKey(window.id))) await writeSession(windowKey(window.id), { bounds: window, state: window.state });
      else await flushPendingBounds(window.id);
    });
    const pendingCreation = await readSession(`newWindow:${window.id}`);
    if (pendingCreation) {
      if (pendingCreation > Date.now()) await recoverNewWindow(window.id);
      await removeSession(`newWindow:${window.id}`);
    }
  }
  await refreshContextMenus(activeTabsAtStartup[0]);
  await chrome.action.setBadgeText({ text: "" });
  await scheduleIconRefresh();
}


/** Registers browser events synchronously before asynchronous initialization begins. */
chrome.runtime.onMessage.addListener(handleExtensionRequest);
registerContextMenuActions((message) => dispatchRequest(message), reportDiagnostic);
chrome.runtime.onInstalled.addListener(() => refreshContextMenus().catch((error) => reportDiagnostic("Register context menu", error)));
chrome.runtime.onStartup.addListener(() => refreshContextMenus().catch((error) => reportDiagnostic("Register context menu", error)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.smartWindowSizeConfig) return;
  notifyRuleEditors();
  refreshContextMenus().then(scheduleIconRefresh).catch((error) => reportDiagnostic("Synchronize configuration", error));
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(async (tab) => {
    activeTabs.set(tab.windowId, tab);
    await refreshContextMenus(tab);
    return applyForTab(tab);
  }).catch((error) => reportDiagnostic("Activate tab rule", error));
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.url) withEditors(() => notifyRuleEditors()).catch((error) => reportDiagnostic("Refresh rule editors", error));
  if (tab.active) activeTabs.set(tab.windowId, tab);
  if (change.url && tab.active) refreshContextMenus(tab).catch((error) => reportDiagnostic("Refresh context menu", error));
  if (change.url || change.status === "complete") applyForTab(tab, initializingWindows.has(tab.windowId)).catch((error) => reportDiagnostic("Load tab rule", error));
});
chrome.tabs.onRemoved.addListener((id) => {
  withEditors(() => notifyRuleEditors()).catch((error) => reportDiagnostic("Release rule editor", error));
  for (const [windowId, tab] of activeTabs) if (tab.id === id) activeTabs.delete(windowId);
});
chrome.windows.onCreated.addListener((window) => {
  if (!isSiteWindow(window)) return;
  initializingWindows.add(window.id);
  writeSession(`newWindow:${window.id}`, Date.now() + UPDATE_GRACE_MS).then(() => recoverNewWindow(window.id)).catch((error) => reportDiagnostic("Create window visibility", error)).finally(() => {
    if (!initializingWindows.has(window.id)) return;
    creationTimers.set(window.id, setTimeout(() => {
      recoverNewWindow(window.id).catch((error) => reportDiagnostic("Finalize new window visibility", error)).finally(async () => {
        initializingWindows.delete(window.id);
        creationTimers.delete(window.id);
        await removeSession(`newWindow:${window.id}`);
      }).catch((error) => reportDiagnostic("Clear initial window state", error));
    }, 180));
  });
});
chrome.windows.onBoundsChanged.addListener((window) => {
  const owner = activeTabs.get(window.id);
  handleBoundsChanged(window, owner ? { ...owner } : null, changingWindows.has(window.id) || initializingWindows.has(window.id)).catch((error) => reportDiagnostic("Process window bounds", error));
});
chrome.windows.onRemoved.addListener((id) => {
  withEditors((registry) => {
    for (const [tabId, entry] of Object.entries(registry.entries)) if (entry.windowId === id) delete registry.entries[tabId];
    if (!registry.entries[registry.owner]) registry.owner = null;
    notifyRuleEditors();
  }).catch((error) => reportDiagnostic("Release rule editor window", error));
  activeTabs.delete(id);
  initializingWindows.delete(id);
  clearTimeout(creationTimers.get(id));
  creationTimers.delete(id);
  inWindow(id, async () => {
    await flushPendingBounds(id);
    await removeSession(windowKey(id));
    await removeSession(`newWindow:${id}`);
  }).catch((error) => reportDiagnostic("Remove window state", error));
});
initialize().catch((error) => reportDiagnostic("Initialize extension", error));
