/**
 * Classifies tab lifecycle failures shared by background and toolbar code.
 * It consumes only known close-race errors, allowing all other browser API
 * failures to reach their established error handling and Diagnostics paths.
 */

/**
 * Returns whether a browser API rejection means that a tab vanished between
 * scheduling an operation and its execution.
 *
 * @param {unknown} error Browser API rejection.
 * @returns {boolean} Whether the error represents a known missing-tab race.
 */
export function isMissingTabError(error) {
  const message = String(error?.message ?? error ?? "");
  return /(?:no tab with id|invalid tab id|tab (?:closed|not found|no longer exists))/i.test(message);
}


/**
 * Reads a tab while treating only an already-closed tab as an expected race.
 *
 * @param {number} tabId Browser tab identifier.
 * @returns {Promise<object|null>} Current tab, or null when it disappeared.
 * @throws {unknown} For any browser failure that is not a missing-tab race.
 */
export async function getTabIfExists(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    if (isMissingTabError(error)) return null;
    throw error;
  }
}
