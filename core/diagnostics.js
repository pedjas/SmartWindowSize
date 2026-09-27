/**
 * Stores bounded, local SmartWindowSize diagnostic entries for user-visible troubleshooting.
 * The service worker, toolbar actions, and Configuration page share this session-only log.
 */
import { readSession, writeSession, removeSession } from "./runtime-session.js";


/** chrome.storage.session key containing the ordered diagnostic entries. @type {string} */
const DIAGNOSTICS_KEY = "smartWindowSizeDiagnostics";

/** Serialized diagnostic writes, including clear operations. @type {Promise<unknown>} */
let diagnosticQueue = Promise.resolve();


/** Maximum number of recent diagnostic entries retained in the browser session. @type {number} */
export const MAXIMUM_DIAGNOSTIC_ENTRIES = 50;


/**
 * Reads the current diagnostic log and discards malformed entries.
 *
 * @param {boolean} includeUrls Whether the caller has explicitly enabled debug details.
 * @returns {Promise<Array<{occurredAt: string, operation: string, message: string}>>} Valid entries in chronological order.
 */
export async function loadDiagnostics(includeUrls = false) {
  await diagnosticQueue;
  const entries = await readEntries();
  return includeUrls ? entries : entries.map((entry) => ({ ...entry, operation: hideUrls(entry.operation), message: hideUrls(entry.message) }));
}


/** Masks URL text before displaying or recording a non-debug diagnostic. @param {string} message Diagnostic text. @returns {string} Privacy-safe text. */
function hideUrls(message) {
  return message.replace(/(?:https?|file|chrome|brave|moz-extension|chrome-extension):\/\/[^\s"'<>]+/gi, "[URL hidden]");
}


/** Reads the log inside a serialized operation without reentering the queue. @returns {Promise<object[]>} Valid entries. */
async function readEntries() {
  const entries = await readSession(DIAGNOSTICS_KEY);
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry && typeof entry.occurredAt === "string" && typeof entry.operation === "string" && typeof entry.message === "string");
}


/**
 * Adds a local error entry while retaining only the most recent bounded history.
 *
 * @param {string} operation User-meaningful operation that failed.
 * @param {unknown} error Error or rejection supplied by the browser API.
 * @param {boolean} debug Whether URL details are allowed in this session entry.
 * @returns {Promise<number>} Number of retained diagnostic entries after the save.
 */
export async function recordDiagnostic(operation, error, debug = false) {
  const work = diagnosticQueue.catch(() => undefined).then(async () => {
    const entries = await readEntries();
    const raw = String(error?.message ?? error);
    const message = debug ? raw : hideUrls(raw);
    entries.push({ occurredAt: new Date().toISOString(), operation: (debug ? operation : hideUrls(operation)).slice(0, 200), message: message.slice(0, 4000) });
    const retained = entries.slice(-MAXIMUM_DIAGNOSTIC_ENTRIES);
    await writeSession(DIAGNOSTICS_KEY, retained);
    return retained.length;
  });
  diagnosticQueue = work.catch(() => undefined);
  return work;
}


/** Clears every diagnostic entry after the user has reviewed or copied it. @returns {Promise<void>} Completes after session storage is cleared. */
export async function clearDiagnostics() {
  const work = diagnosticQueue.catch(() => undefined).then(() => removeSession(DIAGNOSTICS_KEY));
  diagnosticQueue = work.catch(() => undefined);
  await work;
}
