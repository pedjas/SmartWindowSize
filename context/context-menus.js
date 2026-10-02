/**
 * Defines toolbar context-menu operations for the current browser window.
 * It is initialized by the Manifest V3 service worker and delegates work back to it.
 */
import { loadConfig } from "../core/storage.js";
import { resolveContextMenuTab } from "../core/context-menu-tab.js";
import { toUrl } from "../core/rule-matcher.js";
import { resolveRule } from "../core/rule-resolver.js";


/**
 * Registers one context-menu entry and exposes browser registration failures to the caller.
 *
 * @param {chrome.contextMenus.CreateProperties} properties Context-menu entry definition.
 * @returns {Promise<void>} Completes after the browser confirms registration.
 */
function createContextMenu(properties) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(properties, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

/**
 * Updates one context-menu entry and exposes browser update failures to the caller.
 *
 * @param {string} id Registered context-menu identifier.
 * @param {chrome.contextMenus.UpdateProperties} properties Replacement properties.
 * @returns {Promise<void>} Completes after the browser confirms the update.
 */
function updateContextMenu(id, properties) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.update(id, properties, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}


/**
 * Reads the active browser tab used to decide whether a site-rule action is applicable.
 *
 * @returns {Promise<boolean>} Whether the active tab has a supported HTTP(S) URL.
 */
async function activeTabSupportsRules() {
  const tab = await resolveContextMenuTab(undefined, (queryInfo) => chrome.tabs.query(queryInfo));
  return Boolean(toUrl(tab?.url));
}


/** Determines whether the active page has an enabled resolved rule eligible to update its cloud seed size. @param {object} config Current configuration. @param {object|undefined} tab Current tab. @returns {Promise<boolean>} Whether the seed action is applicable. */
async function activeTabSupportsSyncSeed(config, tab) {
  if (!config.global.enabled || !config.global.syncRules) return false;
  if (!tab) tab = await resolveContextMenuTab(undefined, (queryInfo) => chrome.tabs.query(queryInfo));
  return Boolean(toUrl(tab?.url) && resolveRule(tab.url, config).status === "RULE");
}


/**
 * Updates site-rule availability for the tab that is actually showing the toolbar menu.
 *
 * @param {chrome.tabs.Tab|undefined} tab Browser tab supplied by the context-menu event.
 * @returns {Promise<void>} Completes after the menu has been redrawn when supported.
 */
export async function refreshSiteRuleMenu(tab) {
  const config = await loadConfig();
  if (!tab) tab = await resolveContextMenuTab(undefined, (queryInfo) => chrome.tabs.query(queryInfo));
  await updateContextMenu("delete-matching-rules", { enabled: config.global.enabled && Boolean(toUrl(tab?.url)) });
  await updateContextMenu("set-sync-seed-size", { enabled: await activeTabSupportsSyncSeed(config, tab) });
  const refreshed = chrome.contextMenus.refresh?.();
  if (refreshed?.then) await refreshed;
}


/**
 * Recreates the toolbar context menu for current-window operations and application navigation.
 * @param {chrome.tabs.Tab|undefined} currentTab Known active tab used for immediate site-rule availability.
 * @returns {Promise<void>} Completes after every current menu entry is registered.
 */
export async function createContextMenus(currentTab = undefined) {
  const config = await loadConfig();
  const canSetRules = config.global.enabled && (currentTab ? Boolean(toUrl(currentTab.url)) : await activeTabSupportsRules().catch(() => false));
  const canSetSyncSeed = await activeTabSupportsSyncSeed(config, currentTab).catch(() => false);
  const usesFirefoxOptions = typeof chrome.runtime.getBrowserInfo === "function";
  await chrome.contextMenus.removeAll();
  const entries = [
    { id: "global-enabled", type: "checkbox", title: "Extension enabled", checked: config.global.enabled, contexts: ["action"] },
    ...(!usesFirefoxOptions ? [{ id: "global-separator", type: "separator", contexts: ["action"] }] : []),
    { id: "bring-window-on-screen", title: "Bring window on screen", enabled: config.global.enabled, contexts: ["action"] },
    { id: "delete-matching-rules", title: "Set rules for this site", enabled: canSetRules, contexts: ["action"] },
    { id: "set-sync-seed-size", title: "Set current size as synced default", enabled: canSetSyncSeed, contexts: ["action"] },
    ...(!usesFirefoxOptions ? [{ id: "window-separator", type: "separator", contexts: ["action"] }] : []),
    ...(usesFirefoxOptions ? [{ id: "open-options", title: "Options", contexts: ["action"] }] : []),
    { id: "about", title: "About SmartWindowSize", contexts: ["action"] }
  ];
  for (const entry of entries) await createContextMenu(entry);
}

/** Handles one context-menu action. @param {chrome.contextMenus.OnClickData} info Click details. @param {chrome.tabs.Tab|undefined} tab Clicked tab. @param {Function} dispatch Background-local request dispatcher. @returns {Promise<void>} Completes after the action. */
async function handleContextMenuClick(info, tab, dispatch) {

  /** Executes an action and rejects unsuccessful responses for local diagnostics. @param {object} message Action request. @returns {Promise<object>} Successful response. */
  const requestMenuAction = (message) => dispatch(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error ?? "The requested action did not complete.");
    return response;
  });
  if (info.menuItemId === "global-enabled") return requestMenuAction({ type: "set-global-enabled", enabled: info.checked });
  if (info.menuItemId === "about") return requestMenuAction({ type: "open-about", tabId: tab?.id });
  if (info.menuItemId === "open-options") return requestMenuAction({ type: "open-options" });
  const targetTab = await resolveContextMenuTab(tab, (queryInfo) => chrome.tabs.query(queryInfo));
  if (!Number.isInteger(targetTab?.id)) throw new Error("No active browser tab is available for this action.");
  if (info.menuItemId === "delete-matching-rules") {
    if (!toUrl(targetTab.url)) return;
    return requestMenuAction({ type: "open-rule-editor", tabId: targetTab.id, sourceWindowId: targetTab.windowId, sourceUrl: targetTab.url });
  }
  if (info.menuItemId === "set-sync-seed-size") return requestMenuAction({ type: "set-sync-seed-size", tabId: targetTab.id, windowId: targetTab.windowId });
  const actionType = info.menuItemId === "bring-window-on-screen" ? "bring-window-on-screen" : null;
  if (actionType) {
    await requestMenuAction({ type: actionType, tabId: targetTab.id, windowId: targetTab.windowId });
  }
}


/** Registers background-local menu actions without sending messages to the same background context. @param {Function} dispatch Shared request dispatcher. @param {Function} reportError Local diagnostic recorder. @returns {void} */
export function registerContextMenuActions(dispatch, reportError) {
  if (chrome.contextMenus.onShown?.addListener) {
    chrome.contextMenus.onShown.addListener((_info, tab) => {
      refreshSiteRuleMenu(tab).catch((error) => reportError("Refresh context menu availability", error));
    });
  }
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    return handleContextMenuClick(info, tab, dispatch).catch((error) => reportError("Context menu action", error));
  });
}
