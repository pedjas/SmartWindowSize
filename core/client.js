/**
 * Shares request validation and visible error handling across extension pages.
 * Background-reported failures are not duplicated in session diagnostics.
 */

/** Current view's user-visible error element. @type {HTMLElement|null} */
let errorTarget = null;


/** Displays a failure and reports client-only errors to the background log. @param {string} operation Failed operation. @param {unknown} error Failure. @returns {Promise<void>} Best-effort completion. */
export async function showClientError(operation, error) {
  const message = error?.message ?? String(error);
  if (errorTarget) errorTarget.textContent = message;
  if (error?.reported) return;
  try {
    await chrome.runtime.sendMessage({ type: "report-client-error", operation, message });
  } catch {
    // Keep the visible error when the background itself is unavailable.
  }
}


/** Registers uncaught-error handlers before initializing a view. @param {HTMLElement|null} target Visible status element. @returns {void} */
export function installClientErrors(target) {
  errorTarget = target;
  window.addEventListener("error", (event) => { showClientError("Extension page", event.error ?? event.message); });
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    showClientError("Extension page", event.reason);
  });
}


/** Sends a request and rejects missing or unsuccessful background responses. @param {object} message Request envelope. @returns {Promise<object>} Successful response. */
export async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.error || response.ok === false) {
    const error = new Error(response?.error ?? "The background service did not respond.");
    error.reported = Boolean(response?.error);
    throw error;
  }
  return response;
}


/** Runs a UI action with visible errors instead of an unhandled rejection. @param {string} operation Action label. @param {Function} action Async action. @returns {Promise<void>} Completion. */
export async function runClientAction(operation, action) {
  if (errorTarget) errorTarget.textContent = "";
  try { await action(); } catch (error) { await showClientError(operation, error); }
}
