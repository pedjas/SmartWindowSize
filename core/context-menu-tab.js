/**
 * Resolves the browser tab that toolbar context-menu actions must target.
 * This shared helper isolates browser callback differences from menu commands.
 */


/**
 * Uses the callback tab when available, otherwise finds the active tab in the last focused browser window.
 *
 * @param {chrome.tabs.Tab|undefined} clickedTab Tab supplied by the browser's context-menu callback.
 * @param {(queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>} queryTabs Browser tab-query adapter.
 * @returns {Promise<chrome.tabs.Tab|undefined>} Tab for the requested current-window action.
 */
export async function resolveContextMenuTab(clickedTab, queryTabs) {
  if (Number.isInteger(clickedTab?.id)) return clickedTab;
  const [activeTab] = await queryTabs({ active: true, lastFocusedWindow: true });
  return activeTab;
}
