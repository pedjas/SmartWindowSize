/**
 * SmartWindowSize | Version: 1.0.52 | Last updated: 2026-10-01 10:15:00 +02:00
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

/** Uses Firefox's native browser.windows event surface when available and Chromium's chrome.windows surface otherwise. @type {object} */
const browserWindowEvents = globalThis.browser?.windows ?? chrome.windows;

/** Whether this runtime exposes Firefox's browser namespace. @type {boolean} */
const isFirefoxWindowRuntime = Boolean(globalThis.browser?.windows);

/** Optional committed-bounds event provided by Chromium but not Firefox WebExtensions. @type {object|undefined} */
const boundsChangedEvent = browserWindowEvents?.onBoundsChanged;

/** Session key for normal site windows whose matching rules need geometry persistence. @type {string} */
const GEOMETRY_TRACKS_KEY = "geometryTracks";

/** Per-window timers that persist one stabilized user geometry. @type {Map<number, ReturnType<typeof setTimeout>>} */
const geometryDebounceTimers = new Map();

/** Per-window lightweight Firefox polling timers for tracked normal site windows. @type {Map<number, ReturnType<typeof setTimeout>>} */
const geometryPollTimers = new Map();

/** Delay after the final observed user geometry change before persistence. @type {number} */
const GEOMETRY_DEBOUNCE_MS = 150;

/** Firefox fallback interval for one tracked normal site window. @type {number} */
const GEOMETRY_POLL_MS = 750;

/** Serializes session-backed geometry tracking records. @type {Promise<unknown>} */
let geometryTrackQueue = Promise.resolve();

/** In-flight unique-dialog opens, keyed by the dialog identity. @type {Map<string, Promise<unknown>>} */
const dialogOpens = new Map();

/** Serializes session-backed ownership changes for auxiliary dialog windows. @type {Promise<unknown>} */
let dependentDialogQueue = Promise.resolve();

/** Serializes editor ownership and manual rule mutations across all dialogs. @type {Promise<unknown>} */
let editorQueue = Promise.resolve();

/** Monotonic fallback component for rule-editor tokens when crypto.randomUUID is unavailable. @type {number} */
let editorTokenSequence = 0;

/** Maximum age of an opening editor reservation before it can be treated as abandoned. @type {number} */
const EDITOR_OPENING_LEASE_MS = 30000;

/** Bounded handshake timers keyed by editor token; session storage remains the authoritative lifecycle record. @type {Map<string, ReturnType<typeof setTimeout>>} */
const editorOpeningTimers = new Map();


/** Announces access or saved-rule changes without exposing source URLs. @returns {void} */
function notifyRuleEditors() {
  chrome.runtime.sendMessage({ type: "rule-editors-changed" }).catch(() => undefined);
}


/** Cancels the local fallback timeout after an editor handshake, close, or explicit cleanup. @param {string} token Editor token. @returns {void} Clears the matching timer when present. */
function clearRuleEditorOpeningTimeout(token) {
  const timer = editorOpeningTimers.get(token);
  if (timer !== undefined) clearTimeout(timer);
  editorOpeningTimers.delete(token);
}


/** Removes a popup that never completed its token-bound page handshake and records an actionable local failure. @param {string} token Reserved editor token. @returns {Promise<void>} Completes after cleanup and best-effort diagnostics. */
async function expireRuleEditorOpening(token) {
  clearRuleEditorOpeningTimeout(token);
  const context = await withEditors((registry) => {
    const entry = registry.entries[token];
    if (!entry || entry.status !== "opening" || Date.now() - entry.openingAt < EDITOR_OPENING_LEASE_MS) return null;
    delete registry.entries[token];
    if (registry.owner === token) registry.owner = null;
    return {
      phase: "handshake-timeout",
      source: { tabId: entry.sourceId, windowId: entry.sourceWindowId, url: entry.url },
      editor: { token, windowId: entry.windowId, tabId: entry.dialogId },
      browserResult: { lifecycle: entry.lifecycle, reason: "Rules page did not complete its editor handshake before timeout." }
    };
  });
  if (context) await reportDiagnostic("open-rule-editor", new Error("The rule dialog did not finish loading before timeout."), context);
}


/** Schedules the non-blocking fallback for a popup that stays in opening state after browser navigation begins. @param {string} token Reserved editor token. @returns {void} Starts one bounded timeout for the token. */
function scheduleRuleEditorOpeningTimeout(token) {
  clearRuleEditorOpeningTimeout(token);
  editorOpeningTimers.set(token, setTimeout(() => {
    expireRuleEditorOpening(token).catch((error) => reportDiagnostic("Expire rule editor opening", error));
  }, EDITOR_OPENING_LEASE_MS));
}


/** Runs an editor operation with a reconciled, session-persisted registry. @param {Function} operation Receives live editor records and owner entry key. @returns {Promise<unknown>} Operation result. */
function withEditors(operation) {
  const work = editorQueue.catch(() => undefined).then(async () => {
    const registry = await readSession("ruleEditors") ?? { owner: null, entries: {} };
    const before = fingerprint(registry);
    for (const [key, entry] of Object.entries(registry.entries)) {
      entry.sourceKey ??= `${entry.sourceWindowId}:${entry.sourceId}`;
      const live = await locateRuleEditor(entry);
      if (live) Object.assign(entry, { windowId: live.window.id, dialogId: live.tab.id });
      else if (entry.status === "opening" && !Number.isInteger(entry.windowId) && !Number.isInteger(entry.dialogId) && Date.now() - entry.openingAt < EDITOR_OPENING_LEASE_MS) continue;
      else delete registry.entries[key];
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


/** Creates an opaque, per-dialog token that survives service-worker suspension through the dialog URL and session registry. @returns {string} Editor token. */
function createEditorToken() {
  const random = globalThis.crypto?.randomUUID?.();
  editorTokenSequence += 1;
  return random ?? `${Date.now()}-${editorTokenSequence}`;
}


/** Extracts the opaque editor token from an internal dialog URL. @param {string|undefined} url Browser-supplied dialog URL. @returns {string|undefined} Token when the URL is valid. */
function editorTokenFromUrl(url) {
  try { return new URL(url).searchParams.get("editorToken") ?? undefined; }
  catch { return undefined; }
}


/** Authenticates an editor handshake from its opaque token, immutable source binding, and known popup identity. @param {object} registry Live sessions. @param {object} message Request. @returns {object} Bound editor record with registry key. */
function editorRecord(registry, message) {
  const entryId = Object.keys(registry.entries).find((id) => registry.entries[id].token === message.editorToken);
  const entry = registry.entries[entryId];
  if (!entry || entry.sourceId !== message.tabId || entry.sourceWindowId !== message.sourceWindowId || entry.token !== message.editorToken) {
    throw new Error("Reopen this rule dialog from its source page.");
  }
  if (Number.isInteger(message.editorTabId) && Number.isInteger(entry.dialogId) && message.editorTabId !== entry.dialogId) {
    throw new Error("Reopen this rule dialog from its source page.");
  }
  if (Number.isInteger(message.editorWindowId) && Number.isInteger(entry.windowId) && message.editorWindowId !== entry.windowId) {
    throw new Error("Reopen this rule dialog from its source page.");
  }
  if (Number.isInteger(message.editorTabId)) entry.dialogId ??= message.editorTabId;
  if (Number.isInteger(message.editorWindowId)) entry.windowId ??= message.editorWindowId;
  return { entry, entryId };
}


/** Identifies an expected stale rule-editor request that must remain visible but not diagnostic. @param {object} message Request envelope. @param {unknown} error Rejected operation. @returns {boolean} Whether the condition is expected. */
function isExpectedStaleEditorRequest(message, error) {
  return message?.type === "get-rule-editor-state" && error?.message === "Reopen this rule dialog from its source page.";
}


/** Rejects every rule mutation from a read-only or rebound dialog. @param {object} registry Live sessions. @param {object} message Mutation. @returns {{entry: object, entryId: string}} Authenticated editor record. */
function requireEditorOwner(registry, message) {
  const { entry, entryId } = editorRecord(registry, message);
  if (registry.owner !== entryId) throw new Error("This dialog is read-only. Focus the editable dialog or enable editing.");
  if (entry.url !== message.url) throw new Error("The source URL does not match this dialog.");
  return { entry, entryId };
}


/** Builds the privacy-limited context retained when a token-authorized Rules save fails. @param {object} entry Bound editor session entry. @param {object|undefined} activeTab Active tab observed only for diagnostics. @param {string} condition Validation or save stage that failed. @returns {object} Copyable diagnostic context. */
function saveRuleEditorDiagnosticContext(entry, activeTab, condition) {
  return {
    phase: "save-site-rules",
    validation: condition,
    source: { tabId: entry.sourceId, windowId: entry.sourceWindowId, url: entry.url },
    editor: { token: entry.token, windowId: entry.windowId, tabId: entry.dialogId },
    activeTab: activeTab ? { tabId: activeTab.id ?? null, windowId: activeTab.windowId ?? null } : null
  };
}


/** Saves staged Rules changes through the immutable editor session instead of the browser's currently active tab. @param {object} registry Live editor registry. @param {object} message Token-bound save request. @returns {Promise<object>} Successful save response. */
async function saveSiteRulesForEditor(registry, message) {
  let bound;
  try {
    bound = requireEditorOwner(registry, message);
  } catch (error) {
    const activeTab = Number.isInteger(message.sourceWindowId)
      ? (await chrome.tabs.query({ active: true, windowId: message.sourceWindowId }).catch(() => []))[0] ?? null
      : null;
    throw attachRuleEditorDiagnosticContext(error, {
      phase: "save-site-rules",
      validation: "editor-session-token-or-ownership",
      source: { tabId: message.tabId ?? null, windowId: message.sourceWindowId ?? null, url: message.url ?? null },
      editor: { token: message.editorToken ?? null, windowId: message.editorWindowId ?? null, tabId: message.editorTabId ?? null },
      activeTab: activeTab ? { tabId: activeTab.id ?? null, windowId: activeTab.windowId ?? null } : null
    });
  }
  const { entry } = bound;
  let activeTab = (await chrome.tabs.query({ active: true, windowId: entry.sourceWindowId }))[0] ?? null;
  const diagnostic = saveRuleEditorDiagnosticContext(entry, activeTab, "source-tab-lookup");
  try {
    const source = await chrome.tabs.get(entry.sourceId).catch(() => null);
    if (!source) {
      diagnostic.validation = "source-tab-closed";
      throw new Error("The source tab was closed before saving its rules.");
    }
    if (source.windowId !== entry.sourceWindowId) {
      diagnostic.validation = "source-window-changed";
      throw new Error("The source tab moved to another window. Reload this dialog.");
    }
    if (source.url !== entry.url) {
      diagnostic.validation = "source-url-changed";
      throw new Error("The source page changed. Reload this dialog before saving.");
    }
    diagnostic.validation = "source-session-valid";
    await requireEditorSource(source, entry.url);
    await inWindow(entry.sourceWindowId, async () => {
      await flushPendingBounds(entry.sourceWindowId);
      const currentSource = await chrome.tabs.get(entry.sourceId).catch(() => null);
      if (!currentSource) {
        diagnostic.validation = "source-tab-closed-during-save";
        throw new Error("The source tab was closed before saving its rules.");
      }
      if (currentSource.windowId !== entry.sourceWindowId) {
        diagnostic.validation = "source-window-changed-during-save";
        throw new Error("The source tab moved to another window. Reload this dialog.");
      }
      if (currentSource.url !== entry.url) {
        diagnostic.validation = "source-url-changed-during-save";
        throw new Error("The source page changed. Reload this dialog before saving.");
      }
      const window = await chrome.windows.get(entry.sourceWindowId);
      if (window.state !== "normal") {
        diagnostic.validation = "source-window-not-normal";
        throw new Error("Restore the source window before saving its dimensions.");
      }
      const display = await displayForRule(null, window);
      await updateConfig((config) => {
        const candidate = applySiteRuleEdits(config, entry.url, message);
        const changedIds = new Set(message.rules.filter((rule) => fingerprint(rule) !== fingerprint(message.baseRules.find((base) => base.id === rule.id))).map((rule) => rule.id));
        candidate.rules = candidate.rules.map((rule) => changedIds.has(rule.id) ? {
          ...rule, width: window.width, height: window.height,
          position: rule.position.enabled ? { enabled: true, x: window.left, y: window.top } : rule.position,
          display: rule.display.enabled && display ? { enabled: true, id: display.id } : rule.display,
          lastUpdatedAt: new Date().toISOString()
        } : rule);
        return candidate;
      });
    });
    activeTab = (await chrome.tabs.query({ active: true, windowId: entry.sourceWindowId }))[0] ?? null;
    if (activeTab?.id === entry.sourceId) await applyForTab(source);
    return { ok: true };
  } catch (error) {
    diagnostic.activeTab = activeTab ? { tabId: activeTab.id ?? null, windowId: activeTab.windowId ?? null } : null;
    throw attachRuleEditorDiagnosticContext(error, diagnostic);
  }
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


/** Updates the session-backed map of auxiliary dialog window IDs to their source browser window IDs. @param {(registry: Record<string, number>) => unknown|Promise<unknown>} operation Serialized registry operation. @returns {Promise<unknown>} Operation result. */
function withDependentDialogs(operation) {
  const work = dependentDialogQueue.catch(() => undefined).then(async () => {
    const registry = await readSession("dependentDialogs") ?? {};
    const result = await operation(registry);
    await writeSession("dependentDialogs", registry);
    return result;
  });
  dependentDialogQueue = work;
  return work;
}


/** Records that an auxiliary dialog belongs to one browser window. @param {number|undefined} sourceWindowId Source browser window ID. @param {number} dialogWindowId Popup dialog window ID. @returns {Promise<void>} Completion. */
async function registerDependentDialog(sourceWindowId, dialogWindowId) {
  if (!Number.isInteger(sourceWindowId)) return;
  await withDependentDialogs((registry) => { registry[dialogWindowId] = sourceWindowId; });
}


/** Removes one closed dialog and returns every dialog whose source browser window has just closed. @param {number} windowId Closed browser or dialog window ID. @returns {Promise<number[]>} Dependent dialog IDs to close. */
async function takeDependentDialogsForClosedWindow(windowId) {
  return withDependentDialogs((registry) => {
    const dependent = Object.entries(registry).filter(([, sourceWindowId]) => sourceWindowId === windowId).map(([dialogWindowId]) => Number(dialogWindowId));
    delete registry[windowId];
    for (const dialogWindowId of dependent) delete registry[dialogWindowId];
    return dependent;
  });
}


/** Returns the ephemeral state key for one window. @param {number} id Window ID. @returns {string} Session key. */
function windowKey(id) { return `windowState:${id}`; }


/** Excludes extension dialogs and nonstandard browser windows from automatic site handling. @param {object} window Browser window. @returns {boolean} Whether this is a website window. */
function isSiteWindow(window) { return !window.type || window.type === "normal"; }


/** Browser and extension UI protocols that must never trigger website sizing. @type {ReadonlySet<string>} */
const INTERNAL_UI_PROTOCOLS = new Set(["about:", "brave:", "chrome:", "chrome-extension:", "devtools:", "edge:", "moz-extension:", "opera:", "vivaldi:"]);


/** Determines whether a browser URL represents content eligible for SmartWindowSize sizing. @param {string|undefined} urlText Browser-reported tab URL. @returns {boolean} Whether rule and default resolution may process the URL. */
function isSupportedSiteUrl(urlText) {
  try { return !INTERNAL_UI_PROTOCOLS.has(new URL(urlText).protocol); }
  catch { return false; }
}


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
  const hasErrors = (await loadDiagnostics()).some((entry) => entry.kind !== "trace");
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


/** Stores a local error and makes it immediately visible to the user. @param {string} operation Failed operation. @param {unknown} error Failure. @param {object|undefined} context Browser-operation context safe for Diagnostics. @returns {Promise<void>} Best-effort completion. */
async function reportDiagnostic(operation, error, context = undefined) {
  try {
    const config = await loadConfig();
    await recordDiagnostic(operation, error, config.global.debug, context ?? error?.diagnosticContext);
    notifyDiagnostics();
    await scheduleIconRefresh();
  } catch {
    // A diagnostic failure must not create an unhandled error loop.
  }
}


/** Attaches a non-user-facing, JSON-safe failure trace before the common message handler records the error. @param {unknown} error Failure from a rule-dialog browser API operation. @param {object} context Immutable source and dialog trace. @returns {unknown} Original failure for normal request handling. */
function attachRuleEditorDiagnosticContext(error, context) {
  if (error && typeof error === "object" && !error.diagnosticContext) error.diagnosticContext = context;
  return error;
}


/** Applies one tab icon without interrupting window recovery on icon failure. @param {number} tabId Tab ID. @param {object} resolved Resolution. @returns {Promise<void>} Completion. */
async function synchronizeActionIcon(tabId, resolved) {
  const failures = await updateActionIcon(tabId, resolved, (await loadDiagnostics()).some((entry) => entry.kind !== "trace"));
  for (const failure of failures) await reportDiagnostic(failure.operation, failure.error);
}


/** Converts browser outer-window geometry into a small copyable capture record. @param {object|undefined} window Browser window returned by the WebExtensions API. @returns {{width: number|null, height: number|null, left: number|null, top: number|null, state: string|null}|null} Geometry when a window is available. */
function capturedWindowGeometry(window) {
  if (!window) return null;
  return {
    width: Number.isInteger(window.width) ? window.width : null,
    height: Number.isInteger(window.height) ? window.height : null,
    left: Number.isInteger(window.left) ? window.left : null,
    top: Number.isInteger(window.top) ? window.top : null,
    state: typeof window.state === "string" ? window.state : null
  };
}


/** Serializes mutations to session-backed tracked normal-window geometry records. @param {Function} operation Receives mutable records keyed by browser window ID. @returns {Promise<unknown>} Operation result. */
function withGeometryTracks(operation) {
  const work = geometryTrackQueue.catch(() => undefined).then(async () => {
    const tracks = await readSession(GEOMETRY_TRACKS_KEY) ?? {};
    const result = await operation(tracks);
    await writeSession(GEOMETRY_TRACKS_KEY, tracks);
    return result;
  });
  geometryTrackQueue = work;
  return work;
}


/** Schedules one Firefox fallback observation for a tracked normal site window. @param {number} windowId Browser window identifier. @returns {void} Schedules at most one follow-up observation. */
function scheduleFirefoxGeometryPoll(windowId) {
  if (!isFirefoxWindowRuntime || geometryPollTimers.has(windowId)) return;
  geometryPollTimers.set(windowId, setTimeout(async () => {
    geometryPollTimers.delete(windowId);
    try {
      const tracks = await readSession(GEOMETRY_TRACKS_KEY) ?? {};
      if (!tracks[windowId]) return;
      await observeTrackedWindowGeometry(windowId);
      scheduleFirefoxGeometryPoll(windowId);
    } catch {
      // A closed tracked window ends its polling cycle without creating a diagnostic error.
    }
  }, GEOMETRY_POLL_MS));
}


/** Starts or refreshes tracking for a normal active site window with a resolved enabled rule. @param {object} tab Active site tab. @param {object} window Browser window. @param {string} ruleId Resolved rule identifier. @returns {Promise<void>} Completion after session tracking is stored. */
async function trackWindowGeometry(tab, window, ruleId) {
  if (!isFirefoxWindowRuntime || !isSiteWindow(window) || window.state !== "normal" || !tab?.url || !ruleId) return;
  const geometry = capturedWindowGeometry(window);
  await withGeometryTracks((tracks) => {
    const previous = tracks[window.id] ?? {};
    tracks[window.id] = {
      ...previous,
      windowId: window.id,
      tabId: tab.id,
      url: tab.url,
      ruleId,
      lastKnownGeometry: geometry,
      lastGeometryReadAt: new Date().toISOString()
    };
  });
  scheduleFirefoxGeometryPoll(window.id);
}


/** Checks whether an observed geometry is the expected result of a recent SmartWindowSize update. @param {number} windowId Browser window identifier. @param {object} geometry Current observed geometry. @returns {Promise<boolean>} Whether persistence must be suppressed. */
async function isExpectedProgrammaticGeometry(windowId, geometry) {
  const state = await readSession(windowKey(windowId));
  return Boolean(state?.until > Date.now() && geometryMatchesExpected(state.expected, geometry));
}


/** Persists one stabilized tracked window geometry and reports only failures through production Diagnostics. @param {object} track Tracked normal window state. @returns {Promise<void>} Completion after the configuration write and read-back validation. */
async function persistTrackedGeometry(track) {
  const geometry = track?.lastKnownGeometry;
  if (!track?.url || !geometry || geometry.state !== "normal" || !Number.isInteger(geometry.width) || !Number.isInteger(geometry.height)) return;
  try {
    let updatedRuleId = null;
    const saved = await updateConfig((config) => {
      const update = updateRuleForResize(config, { url: track.url, position: { x: geometry.left, y: geometry.top } }, geometry.width, geometry.height);
      updatedRuleId = update.rule?.id ?? null;
      return update.changed ? update.config : undefined;
    });
    const stored = updatedRuleId ? saved.rules.find((rule) => rule.id === updatedRuleId) ?? null : null;
    if (!stored) throw new Error("No matching enabled rule accepted the tracked window geometry.");
    if (stored.width !== geometry.width || stored.height !== geometry.height) throw new Error("Stored window geometry could not be verified.");
  } catch (error) {
    await reportDiagnostic("Persist window geometry", error);
  }
}


/** Persists a pending generation only when it remains the latest user geometry observation. @param {number} windowId Browser window identifier. @param {number} generation Latest geometry generation. @returns {Promise<void>} Completion after persistence and session cleanup. */
async function flushTrackedGeometry(windowId, generation) {
  const track = await withGeometryTracks((tracks) => tracks[windowId]?.pendingGeneration === generation ? structuredClone(tracks[windowId]) : null);
  if (!track) return;
  await persistTrackedGeometry(track);
  await withGeometryTracks((tracks) => {
    if (tracks[windowId]?.pendingGeneration === generation) delete tracks[windowId].pendingGeneration;
  });
}


/** Schedules persistence after a tracked user geometry remains stable briefly. @param {number} windowId Browser window identifier. @param {number} generation Latest user geometry generation. @returns {void} Replaces only this window's pending timer. */
function scheduleTrackedGeometryPersistence(windowId, generation) {
  clearTimeout(geometryDebounceTimers.get(windowId));
  geometryDebounceTimers.set(windowId, setTimeout(() => {
    geometryDebounceTimers.delete(windowId);
    flushTrackedGeometry(windowId, generation).catch((error) => reportDiagnostic("Persist window geometry", error));
  }, GEOMETRY_DEBOUNCE_MS));
}


/** Reads one tracked normal site window and schedules persistence only for a user-driven geometry change. @param {number} windowId Browser window identifier. @returns {Promise<object|null>} Current geometry when the tracked window remains available. */
async function observeTrackedWindowGeometry(windowId) {
  const tracks = await readSession(GEOMETRY_TRACKS_KEY) ?? {};
  if (!tracks[windowId]) return null;
  const window = await chrome.windows.get(windowId);
  if (!isSiteWindow(window) || window.state !== "normal") return null;
  const geometry = capturedWindowGeometry(window);
  const programmatic = await isExpectedProgrammaticGeometry(windowId, geometry);
  const result = await withGeometryTracks((mutable) => {
    const track = mutable[windowId];
    if (!track) return null;
    const changed = fingerprint(track.lastKnownGeometry) !== fingerprint(geometry);
    track.lastKnownGeometry = geometry;
    track.lastGeometryReadAt = new Date().toISOString();
    if (changed && !programmatic) track.pendingGeneration = (track.pendingGeneration ?? 0) + 1;
    return { changed, generation: track.pendingGeneration ?? null };
  });
  if (result?.changed && !programmatic && result.generation !== null) scheduleTrackedGeometryPersistence(windowId, result.generation);
  return geometry;
}


/** Flushes a pending final geometry before removing a closed window's tracking state. @param {number} windowId Closed browser window identifier. @returns {Promise<void>} Completion after best-effort persistence and cleanup. */
async function releaseTrackedWindowGeometry(windowId) {
  clearTimeout(geometryPollTimers.get(windowId));
  geometryPollTimers.delete(windowId);
  clearTimeout(geometryDebounceTimers.get(windowId));
  geometryDebounceTimers.delete(windowId);
  const track = await withGeometryTracks((tracks) => tracks[windowId] ? structuredClone(tracks[windowId]) : null);
  if (track?.pendingGeneration) await persistTrackedGeometry(track);
  await withGeometryTracks((tracks) => { delete tracks[windowId]; });
}


/** Restores Firefox-only tracked-window polling after an event-page restart. @returns {Promise<void>} Completion after live tracks are resumed or discarded. */
async function resumeFirefoxGeometryPolling() {
  if (!isFirefoxWindowRuntime) return;
  const tracks = await readSession(GEOMETRY_TRACKS_KEY) ?? {};
  for (const [id, track] of Object.entries(tracks)) {
    const windowId = Number(id);
    if (!Number.isInteger(windowId)) continue;
    try {
      const window = await chrome.windows.get(windowId);
      if (!isSiteWindow(window) || window.state !== "normal") {
        await withGeometryTracks((mutable) => { delete mutable[windowId]; });
        continue;
      }
      scheduleFirefoxGeometryPoll(windowId);
      if (Number.isInteger(track.pendingGeneration)) scheduleTrackedGeometryPersistence(windowId, track.pendingGeneration);
    } catch {
      await withGeometryTracks((mutable) => { delete mutable[windowId]; });
    }
  }
}


/** Checks whether two outer-window geometry snapshots match within browser rounding tolerance. @param {object|null|undefined} expected Extension-requested geometry. @param {object|null|undefined} actual Browser-observed geometry. @returns {boolean} Whether the snapshots represent the same bounds. */
function geometryMatchesExpected(expected, actual) {
  if (!expected || !actual) return false;
  return ["width", "height", "left", "top"].every((field) =>
    Number.isInteger(expected[field]) && Number.isInteger(actual[field]) && Math.abs(expected[field] - actual[field]) <= 1);
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


/** Applies the active tab's latest rule inside the owning window queue. @param {object} tab Candidate tab. @param {boolean} useSavedPosition Whether a newly created browser window may restore a saved position. @param {object} traceSource Browser event details that initiated this apply attempt. @returns {Promise<void>} Completion. */
async function applyForTab(tab, useSavedPosition = false, traceSource = { eventName: "other", changeInfo: {} }) {
  if (!Number.isInteger(tab?.id) || tab.windowId === chrome.windows.WINDOW_ID_NONE) return;
  return inWindow(tab.windowId, async () => {
    await flushPendingBounds(tab.windowId);
    tab = await chrome.tabs.get(tab.id);
    const window = await chrome.windows.get(tab.windowId);
    const finalUrl = tab.url ?? "";
    if (!tab.active) return;
    activeTabs.set(tab.windowId, tab);
    if (!isSiteWindow(window)) return;
    if (!isSupportedSiteUrl(finalUrl)) return { skipped: "unsupported-url-scheme" };
    if (window.state !== "normal") {
      await writeSession(windowKey(window.id), { bounds: window, state: window.state });
      return;
    }
    const config = await loadConfig();
    const resolved = resolveRule(finalUrl, config);
    if (resolved.status === "RULE") await trackWindowGeometry(tab, window, resolved.rule.id);
    await synchronizeActionIcon(tab.id, resolved);
    if (resolved.status === "DISABLED") {
      await writeSession(windowKey(window.id), { bounds: window, state: window.state });
      return { skipped: "disabled" };
    }
    const canApply = async () => {
      const currentTab = await chrome.tabs.get(tab.id);
      const currentConfig = await loadConfig();
      return currentTab.active && currentTab.windowId === tab.windowId && currentTab.url === tab.url && isSupportedSiteUrl(currentTab.url) &&
        fingerprint(resolveRule(tab.url ?? "", currentConfig)) === fingerprint(resolved);
    };
    if (!await canApply()) return;
    const rememberExpectedGeometry = async (updateInfo) => {
      if (resolved.status !== "RULE") return;
      const current = await readSession(windowKey(tab.windowId)) ?? {};
      await writeSession(windowKey(tab.windowId), {
        ...current,
        changing: true,
        expected: { ...updateInfo, state: "normal" },
        until: Date.now() + UPDATE_GRACE_MS,
        expectedRuleId: resolved.rule.id
      });
    };
    const application = await changeWindow(tab.windowId, () => applyResolvedRule(tab.windowId, resolved, canApply, useSavedPosition, undefined, rememberExpectedGeometry));
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


/** Applies automatic no-rule dimensions or visibility correction to a new window without saving a rule. @param {number} id New window ID. @returns {Promise<void>} Completion. */
async function recoverNewWindow(id) {
  await inWindow(id, async () => {
    const window = await chrome.windows.get(id);
    if (!isSiteWindow(window)) return;
    if (window.state !== "normal") {
      await writeSession(windowKey(id), { bounds: window, state: window.state });
      return;
    }
    const config = await loadConfig();
    if (!config.global.enabled) {
      await writeSession(windowKey(id), { bounds: window, state: window.state });
      return;
    }
    await changeWindow(id, async () => {
      const automatic = resolveRule("", config);
      const canApplyAutomaticSize = async () => {
        const current = await loadConfig();
        return current.global.enabled && fingerprint(resolveRule("", current)) === fingerprint(automatic);
      };
      const result = automatic.status === "DEFAULT"
        ? await applyResolvedRule(id, automatic, canApplyAutomaticSize)
        : await bringWindowOnScreen(id, async () => (await loadConfig()).global.enabled);
      const actual = await chrome.windows.get(id);
      const display = await displayForRule(null, actual);
      if (result.changed && display) {
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


/** Focuses an existing dialog or creates exactly one instance even for concurrent clicks. @param {string} key Dialog identity. @param {string} url Dialog URL. @param {number} width Outer width. @param {number} height Outer height. @param {number|undefined} sourceWindowId Browser window that owns this auxiliary dialog. @returns {Promise<object>} Created or focused browser window. */
async function openUniqueDialog(key, url, width, height, sourceWindowId = undefined) {
  if (dialogOpens.has(key)) return dialogOpens.get(key);
  const work = (async () => {
    const windows = await chrome.windows.getAll({ populate: true });
    const existing = windows.find((window) => window.tabs?.some((tab) => [tab.url, tab.pendingUrl].some((candidate) => key === "about" ? candidate?.split("?")[0] === url.split("?")[0] : candidate === url)));
    if (existing) return chrome.windows.update(existing.id, { focused: true });
    return chrome.windows.create({ url, type: "popup", width, height, focused: true });
  })();
  dialogOpens.set(key, work);
  try {
    const dialog = await work;
    await registerDependentDialog(sourceWindowId, dialog.id);
    return dialog;
  } finally { dialogOpens.delete(key); }
}


/** Finds a rule dialog by recorded popup IDs first, then by token after a background restart. @param {object} entry Session-backed editor entry. @returns {Promise<{window: object, tab: object}|null>} Matching live dialog or null. */
async function locateRuleEditor(entry) {
  if (Number.isInteger(entry.dialogId) && Number.isInteger(entry.windowId)) {
    const tab = await chrome.tabs.get(entry.dialogId).catch(() => null);
    if (tab?.windowId === entry.windowId) {
      const window = await chrome.windows.get(entry.windowId).catch(() => null);
      if (window) return { window, tab };
    }
  }
  const expectedPath = chrome.runtime.getURL("rule-delete/rule-delete.html").split("?")[0];
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((candidate) => [candidate.url, candidate.pendingUrl].some((url) =>
    url?.split("?")[0] === expectedPath && editorTokenFromUrl(url) === entry.token));
  if (!tab) return null;
  const window = await chrome.windows.get(tab.windowId).catch(() => null);
  return window ? { window, tab } : null;
}


/** Activates and focuses the editor popup while preserving its opening state until the page handshake succeeds. @param {object} entry Session-backed editor entry. @returns {Promise<boolean>} Whether a matching live dialog was focused. */
async function focusRecordedRuleEditor(entry) {
  const dialog = await locateRuleEditor(entry);
  if (!dialog) return false;
  await chrome.tabs.update(dialog.tab.id, { active: true });
  await chrome.windows.update(dialog.window.id, { focused: true });
  Object.assign(entry, { windowId: dialog.window.id, dialogId: dialog.tab.id });
  return true;
}


/** Chooses the unique tab created for a rules popup without requiring its URL to have finished navigation. @param {object} window Newly created or focused popup window. @param {string} token Reserved editor token. @returns {Promise<{tab: object|null, candidates: object[]}>} Candidate editor tab and observed popup tabs. */
async function discoverRuleEditorTab(window, token) {
  const returnedTabs = Array.isArray(window.tabs) ? window.tabs : [];
  const candidates = returnedTabs.length ? returnedTabs : await chrome.tabs.query({ windowId: window.id });
  const tokenTab = candidates.find((candidate) => editorTokenFromUrl(candidate.url) === token || editorTokenFromUrl(candidate.pendingUrl) === token);
  return { tab: tokenTab ?? (candidates.length === 1 ? candidates[0] : null), candidates };
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


/** Resolves a source tab and rejects an action whose captured URL or window changed before the background received it. @param {object} message Action request. @param {object} sender Browser sender. @returns {Promise<object|undefined>} Source tab. */
async function sourceTab(message, sender) {
  const tab = Number.isInteger(message.tabId) ? await chrome.tabs.get(message.tabId)
    : sender.tab ? await chrome.tabs.get(sender.tab.id)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (message.sourceUrl !== undefined && tab?.url !== message.sourceUrl) throw new Error("The source page changed before the action could start.");
  if (message.sourceWindowId !== undefined && tab?.windowId !== message.sourceWindowId) throw new Error("The source window changed before the action could start.");
  return tab;
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
  const coordinated = ["open-rule-editor", "get-rule-editor-state", "enable-rule-editing", "focus-rule-editor", "prepare-site-rule", "save-site-rules", "get-configuration", "delete-rule", "set-rule-enabled", "import-configuration", "reset-configuration"];
  if (coordinated.includes(message.type)) return withEditors((registry) => dispatchAction(message, sender, registry));
  return dispatchAction(message, sender);
}


/** Executes actions after obtaining the editor gate where required. @param {object} message Request. @param {object} sender Runtime sender. @param {object} registry Locked editor registry for coordinated actions. @returns {Promise<object>} Response. */
async function dispatchAction(message, sender, registry) {
  if (message.type === "get-app-version") return { version: APP_VERSION };
  if (message.type === "get-configuration") return { config: await loadConfig(), rulesLocked: registry.owner !== null };
  if (message.type === "focus-rule-editor") {
    editorRecord(registry, message);
    const owner = registry.entries[registry.owner];
    if (!owner) throw new Error("No editable dialog is open. You can enable editing here.");
    await chrome.windows.update(owner.windowId, { focused: true });
    return { ok: true };
  }
  if (["get-rule-editor-state", "enable-rule-editing"].includes(message.type)) {
    const { entry, entryId } = editorRecord(registry, message);
    if (message.type === "get-rule-editor-state" && entry.status === "opening" && Number.isInteger(message.editorTabId) && Number.isInteger(message.editorWindowId)) {
      entry.status = "open";
      entry.openedAt = Date.now();
      entry.lifecycle ??= {};
      entry.lifecycle.transition = "opening -> open";
      entry.lifecycle.handshakeAt = new Date().toISOString();
      clearRuleEditorOpeningTimeout(entry.token);
    }
    const source = await chrome.tabs.get(entry.sourceId).catch(() => null);
    const config = await loadConfig();
    const sourceValid = source?.windowId === entry.sourceWindowId && source?.url === entry.url;
    if (message.type === "enable-rule-editing") {
      if (!sourceValid || !config.global.enabled) throw new Error("The source page changed or the extension is disabled. Editing is unavailable.");
      if (registry.owner !== null && registry.owner !== entryId) throw new Error("Rules are being edited in another window.");
      registry.owner = entryId;
    }
    return { url: entry.url, rules: matchingRulesForUrl(entry.url, config), ownsEditor: registry.owner === entryId,
      writable: registry.owner === entryId && sourceValid && config.global.enabled,
      hasOwner: registry.owner !== null, sourceValid, enabled: config.global.enabled };
  }
  if (message.type === "prepare-site-rule") requireEditorOwner(registry, message);
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
  if (["save-global-settings", "delete-rule", "set-rule-enabled", "import-configuration", "reset-configuration"].includes(message.type)) {
    if (message.type !== "save-global-settings" && registry.owner !== null) throw new Error("Close the editable rule dialog before deleting, importing, or resetting rules.");
    const config = await updateConfig((current) => applyConfigurationAction(current, message));
    return { ok: true, config };
  }
  if (message.type === "open-about") {
    const owner = await sourceTab(message, sender).catch(() => null);
    await openUniqueDialog("about", `${chrome.runtime.getURL("about/about.html")}?tabId=${owner?.id ?? ""}`, 420, 340, owner?.windowId);
    return { ok: true };
  }
  if (message.type === "open-local-readme") {
    await openLocalReadme();
    return { ok: true };
  }
  if (message.type === "open-options") {
    if (typeof chrome.runtime.openOptionsPage !== "function") throw new Error("This browser does not provide an Options page action.");
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (message.type === "save-site-rules") return saveSiteRulesForEditor(registry, message);
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
    const sourceKey = `${tab.windowId}:${tab.id}`;
    const existing = Object.entries(registry.entries).find(([, entry]) => entry.sourceKey === sourceKey);
    if (existing) {
      if (existing[1].sourceClosed) {
        clearRuleEditorOpeningTimeout(existing[1].token);
        delete registry.entries[existing[0]];
        if (registry.owner === existing[0]) registry.owner = null;
      } else {
        if (await focusRecordedRuleEditor(existing[1])) return { ok: true };
        if (existing[1].status === "opening" && Date.now() - existing[1].openingAt < EDITOR_OPENING_LEASE_MS) return { ok: true, pending: true };
        delete registry.entries[existing[0]];
        if (registry.owner === existing[0]) registry.owner = null;
      }
    }
    const token = createEditorToken();
    const source = { sourceKey, sourceId: tab.id, sourceWindowId: tab.windowId, url: tab.url, status: "opening", openingAt: Date.now(), windowId: null, dialogId: null, token,
      lifecycle: { transition: "reserved", createdWindowId: null, discoveredTabId: null, initialTabUrl: null } };
    registry.entries[token] = source;
    if (registry.owner === null) registry.owner = token;

    /** Structured trace retained only when this dialog initialization fails. @type {object} */
    const diagnosticContext = {
      phase: "reserve-source-context",
      source: { tabId: tab.id, windowId: tab.windowId, url: tab.url },
      editor: { token, windowId: null, tabId: null },
      browserResult: { reservation: "saved" }
    };

    // Reserve and persist the immutable source before creating the window, preventing parallel dialogs and Firefox startup races.
    await writeSession("ruleEditors", registry);
    try {
      const dialogUrl = `${chrome.runtime.getURL("rule-delete/rule-delete.html")}?tabId=${tab.id}&sourceWindowId=${tab.windowId}&editorToken=${encodeURIComponent(token)}&sourceUrl=${encodeURIComponent(tab.url)}`;
      diagnosticContext.phase = "create-dialog-window";
      const window = await openUniqueDialog(`rules:${sourceKey}`, dialogUrl, 640, 620, tab.windowId);
      diagnosticContext.editor.windowId = window.id;
      diagnosticContext.browserResult.createDialogWindow = { windowId: window.id, type: window.type ?? null };
      diagnosticContext.phase = "find-dialog-tab";
      const discovery = await discoverRuleEditorTab(window, token);
      diagnosticContext.browserResult.queryDialogTabs = {
        windowId: window.id,
        tabs: discovery.candidates.map((candidate) => ({ id: candidate.id ?? null, windowId: candidate.windowId ?? null, url: candidate.url ?? null, pendingUrl: candidate.pendingUrl ?? null }))
      };
      const dialog = discovery.tab;
      if (!dialog) throw new Error("The rule dialog could not be initialized.");
      Object.assign(source, { windowId: window.id, dialogId: dialog.id,
        lifecycle: { transition: "opening", createdWindowId: window.id, discoveredTabId: dialog.id, initialTabUrl: dialog.url ?? dialog.pendingUrl ?? null } });
      Object.assign(diagnosticContext.editor, { tabId: dialog.id });
      diagnosticContext.browserResult.discoveredEditorTab = { id: dialog.id ?? null, windowId: dialog.windowId ?? null, initialUrl: dialog.url ?? null, pendingUrl: dialog.pendingUrl ?? null };
      await writeSession("ruleEditors", registry);
      scheduleRuleEditorOpeningTimeout(token);
    } catch (error) {
      clearRuleEditorOpeningTimeout(token);
      delete registry.entries[token];
      if (registry.owner === token) registry.owner = null;
      await writeSession("ruleEditors", registry);
      throw attachRuleEditorDiagnosticContext(error, diagnosticContext);
    }
    return { ok: true };
  }
  if (message.type === "open-size-picker") {
    if (!(await loadConfig()).global.enabled) throw new Error("SmartWindowSize is disabled.");
    if (!tab) throw new Error("The source window is no longer available.");
    await openUniqueDialog(`size:${tab.windowId}`, `${chrome.runtime.getURL("size-picker/size-picker.html")}?windowId=${tab.windowId}`, 440, 460, tab.windowId);
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
    const stagedRule = { id: existing?.id ?? createRuleId(), scope: { type, value }, enabled: existing?.enabled ?? true,
      width: current.width, height: current.height,
      position: message.rememberPosition ? { enabled: true, x: current.left, y: current.top } : { enabled: false, x: null, y: null },
      display: message.rememberMonitor && display ? { enabled: true, id: display.id } : { enabled: false, id: null },
      lastUpdatedAt: new Date().toISOString() };
    return { rule: stagedRule };
  }
  throw new Error("Unsupported extension request.");
}


/** Bridges runtime callbacks and the same local context-menu dispatcher. @param {object} message Request. @param {object} sender Source. @param {Function} sendResponse Browser response callback. @returns {boolean|undefined} Async-response marker. */
function handleExtensionRequest(message, sender, sendResponse) {
  if (["diagnostics-changed", "rule-editors-changed"].includes(message.type)) return;
  dispatchRequest(message, sender).then(sendResponse).catch(async (error) => {
    if (!isExpectedStaleEditorRequest(message, error)) await reportDiagnostic(message.type ?? "Handle extension request", error);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
}


/** Initializes missing baselines without treating browser startup as a user resize. @returns {Promise<void>} Completion. */
async function initialize() {
  await chrome.storage.local.remove(["debug.lastWindowRemoved", "debug.lastBoundsChanged"]);
  await removeSession("eliteDiagnosticWindows");
  await resumeFirefoxGeometryPolling();
  const activeTabsAtStartup = await chrome.tabs.query({ active: true });
  for (const tab of activeTabsAtStartup) {
    activeTabs.set(tab.windowId, tab);
  }
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
    return applyForTab(tab, false, { eventName: "tabs.onActivated", changeInfo: {} });
  }).catch((error) => reportDiagnostic("Activate tab rule", error));
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.url) withEditors(() => notifyRuleEditors()).catch((error) => reportDiagnostic("Refresh rule editors", error));
  if (tab.active) activeTabs.set(tab.windowId, tab);
  if (change.url && tab.active) refreshContextMenus(tab).catch((error) => reportDiagnostic("Refresh context menu", error));
  if (change.url || change.status === "complete") {
    applyForTab(tab, initializingWindows.has(tab.windowId), { eventName: "tabs.onUpdated", changeInfo: { status: change.status ?? null, url: change.url ?? null } })
      .catch((error) => reportDiagnostic("Load tab rule", error));
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  withEditors(() => notifyRuleEditors()).catch((error) => reportDiagnostic("Release rule editor", error));
  for (const [windowId, tab] of activeTabs) if (tab.id === id) activeTabs.delete(windowId);
});
browserWindowEvents.onCreated.addListener((window) => {
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
if (!isFirefoxWindowRuntime && typeof boundsChangedEvent?.addListener === "function") {
  boundsChangedEvent.addListener((window) => {
    const owner = activeTabs.get(window.id);
    handleBoundsChanged(window, owner ? { ...owner } : null, changingWindows.has(window.id) || initializingWindows.has(window.id)).catch((error) => reportDiagnostic("Process window bounds", error));
  });
}
browserWindowEvents.onRemoved.addListener(async (id) => {
  try {
    await releaseTrackedWindowGeometry(id);
  } catch (error) {
    await reportDiagnostic("Release tracked window geometry", error);
  }
  try {
    await inWindow(id, async () => {
      await flushPendingBounds(id);
      await removeSession(windowKey(id));
      await removeSession(`newWindow:${id}`);
    });
  } catch (error) {
    await reportDiagnostic("Remove window state", error);
  }
  try {
    const dialogWindowIds = await takeDependentDialogsForClosedWindow(id);
    await Promise.all(dialogWindowIds.map((dialogWindowId) => chrome.windows.remove(dialogWindowId).catch((error) => reportDiagnostic("Close dependent dialog", error))));
  } catch (error) {
    await reportDiagnostic("Release dependent dialogs", error);
  }
  await withEditors((registry) => {
    for (const [tabId, entry] of Object.entries(registry.entries)) {
      if (entry.windowId === id) {
        clearRuleEditorOpeningTimeout(entry.token);
        delete registry.entries[tabId];
      }
    }
    if (!registry.entries[registry.owner]) registry.owner = null;
    notifyRuleEditors();
  }).catch((error) => reportDiagnostic("Release rule editor window", error));
  activeTabs.delete(id);
  initializingWindows.delete(id);
  clearTimeout(creationTimers.get(id));
  creationTimers.delete(id);
});
chrome.tabs.onRemoved.addListener((id) => {
  withEditors((registry) => {
    for (const [entryId, entry] of Object.entries(registry.entries)) {
      if (entry.dialogId === id) {
        clearRuleEditorOpeningTimeout(entry.token);
        delete registry.entries[entryId];
      } else if (entry.sourceId === id) {
        entry.sourceClosed = true;
        entry.lifecycle ??= {};
        entry.lifecycle.transition = "source closed";
        entry.lifecycle.sourceClosedAt = new Date().toISOString();
      }
    }
    if (!registry.entries[registry.owner]) registry.owner = null;
  }).catch((error) => reportDiagnostic("Release rule editor tab", error));
});
initialize().catch((error) => reportDiagnostic("Initialize extension", error));
