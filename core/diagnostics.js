/**
 * Stores bounded, local SmartWindowSize diagnostic entries for user-visible troubleshooting.
 * The service worker, toolbar actions, and Configuration page share this session-only log,
 * including structured technical context for failures that need browser-specific analysis.
 */
import { readSession, writeSession, removeSession } from "./runtime-session.js";


/** chrome.storage.session key containing the ordered diagnostic entries. @type {string} */
const DIAGNOSTICS_KEY = "smartWindowSizeDiagnostics";

/** Serialized diagnostic writes, including clear operations. @type {Promise<unknown>} */
let diagnosticQueue = Promise.resolve();


/** Maximum number of recent diagnostic entries retained in the browser session. @type {number} */
export const MAXIMUM_DIAGNOSTIC_ENTRIES = 50;


/** Maximum number of characters retained for one technical diagnostic string. @type {number} */
const MAXIMUM_DETAIL_LENGTH = 12000;


/**
 * Reads the current diagnostic log and discards malformed entries.
 *
 * @param {boolean} includeUrls Whether the caller has explicitly enabled debug details.
 * @returns {Promise<Array<object>>} Valid entries in chronological order.
 */
export async function loadDiagnostics(includeUrls = false) {
  await diagnosticQueue;
  const entries = await readEntries();
  return includeUrls ? entries : entries.map((entry) => {
    const redacted = redactDiagnosticValue(entry);
    if (typeof entry?.technical?.context?.source?.url === "string") redacted.technical.context.source.url = entry.technical.context.source.url;
    return redacted;
  });
}


/** Masks URL text before displaying or recording a non-debug diagnostic. @param {string} message Diagnostic text. @returns {string} Privacy-safe text. */
function hideUrls(message) {
  return message.replace(/(?:https?|file|chrome|brave|moz-extension|chrome-extension):\/\/[^\s"'<>]+/gi, "[URL hidden]");
}


/** Recursively removes URL text from a JSON-like diagnostic value before display. @param {unknown} value Stored diagnostic value. @returns {unknown} Privacy-safe clone. */
function redactDiagnosticValue(value) {
  if (typeof value === "string") return hideUrls(value);
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDiagnosticValue(item)]));
}


/** Converts an error and its optional cause chain into copyable JSON-safe technical details. @param {unknown} error Original rejection. @param {number} depth Current nested-cause depth. @returns {object} Sanitized error details. */
function describeError(error, depth = 0) {
  const object = error && typeof error === "object" ? error : null;
  const detail = {
    name: String(object?.name ?? "Error").slice(0, 200),
    message: String(object?.message ?? error ?? "Unknown error").slice(0, MAXIMUM_DETAIL_LENGTH)
  };
  if (typeof object?.stack === "string") detail.stack = object.stack.slice(0, MAXIMUM_DETAIL_LENGTH);
  if (depth < 4 && object?.cause !== undefined) detail.cause = describeError(object.cause, depth + 1);
  return detail;
}


/** Retains only primitive, array, and plain-object values suitable for a local diagnostic record. @param {unknown} value Context supplied by the failed operation. @param {number} depth Current recursion depth. @returns {unknown} JSON-safe context value. */
function copyDiagnosticContext(value, depth = 0) {
  if (typeof value === "string") return value.slice(0, MAXIMUM_DETAIL_LENGTH);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value) && depth < 5) return value.slice(0, 50).map((item) => copyDiagnosticContext(item, depth + 1));
  if (!value || typeof value !== "object" || depth >= 5) return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 50).flatMap(([key, item]) => {
    const copied = copyDiagnosticContext(item, depth + 1);
    return copied === undefined ? [] : [[key, copied]];
  }));
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
 * @param {object|undefined} context Structured operation context without page content or credentials.
 * @returns {Promise<number>} Number of retained diagnostic entries after the save.
 */
export async function recordDiagnostic(operation, error, debug = false, context = undefined) {
  const work = diagnosticQueue.catch(() => undefined).then(async () => {
    const entries = await readEntries();
    const raw = String(error?.message ?? error);
    const message = debug ? raw : hideUrls(raw);
    const entry = {
      occurredAt: new Date().toISOString(),
      operation: (debug ? operation : hideUrls(operation)).slice(0, 200),
      message: message.slice(0, 4000),
      technical: {
        error: describeError(error),
        context: copyDiagnosticContext(context)
      }
    };
    // Keep the original local session record so a later copy can preserve the rule-editor source trace.
    entries.push(entry);
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
