/**
 * Adapts ephemeral background state to browser session storage.
 * Older browsers use memory without leaking session data into persistent storage.
 */

/** Volatile fallback used only when the browser lacks session storage. @type {Map<string, unknown>} */
const fallback = new Map();


/** Reads ephemeral state without persisting it across browser sessions. @param {string} key Session key. @returns {Promise<unknown>} Stored value. */
export async function readSession(key) {
  if (chrome.storage.session) return (await chrome.storage.session.get(key))[key];
  return structuredClone(fallback.get(key));
}


/** Writes ephemeral state using the best available session facility. @param {string} key Session key. @param {unknown} value Session value. @returns {Promise<void>} Completion. */
export async function writeSession(key, value) {
  if (chrome.storage.session) await chrome.storage.session.set({ [key]: value });
  else fallback.set(key, structuredClone(value));
}


/** Removes ephemeral state after its owner closes or clears it. @param {string} key Session key. @returns {Promise<void>} Completion. */
export async function removeSession(key) {
  if (chrome.storage.session) await chrome.storage.session.remove(key);
  else fallback.delete(key);
}
