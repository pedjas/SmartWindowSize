/**
 * Verifies bounded session-only diagnostic storage without a live browser.
 * The test supplies the chrome.storage.session subset consumed by core/diagnostics.js.
 */
import test from "node:test";
import assert from "node:assert/strict";


/** Mutable session data used by the deterministic diagnostics storage mock. @type {object} */
let sessionData = {};


/** Creates the browser session-storage mock used by diagnostic unit tests. @returns {object} Required Chrome API subset. */
function createDiagnosticsChromeMock() {
  return {
    storage: {
      session: {
        async get(key) { return { [key]: structuredClone(sessionData[key]) }; },
        async set(values) { sessionData = { ...sessionData, ...structuredClone(values) }; },
        async remove(key) { delete sessionData[key]; }
      }
    }
  };
}


/** Provides the mock before importing the diagnostic storage module. */
globalThis.chrome = createDiagnosticsChromeMock();


/** Diagnostic storage operations loaded against the browser mock. */
const { MAXIMUM_DIAGNOSTIC_ENTRIES, clearDiagnostics, loadDiagnostics, recordDiagnostic } = await import("../core/diagnostics.js");


test("diagnostics retain the newest bounded session entries and clear on request", async () => {
  sessionData = {};
  for (let index = 0; index < MAXIMUM_DIAGNOSTIC_ENTRIES + 2; index += 1) {
    await recordDiagnostic("Test operation", new Error(`failure-${index}`));
  }
  const retained = await loadDiagnostics();
  assert.equal(retained.length, MAXIMUM_DIAGNOSTIC_ENTRIES);
  assert.equal(retained[0].message, "failure-2");
  assert.equal(retained.at(-1).message, `failure-${MAXIMUM_DIAGNOSTIC_ENTRIES + 1}`);
  await clearDiagnostics();
  assert.deepEqual(await loadDiagnostics(), []);
});


test("concurrent diagnostic writes retain every entry and redact URLs by default", async () => {
  await clearDiagnostics();
  await Promise.all(Array.from({ length: 20 }, (_, index) => recordDiagnostic("Concurrent", new Error(`${index}: https://private.example/page?token=hidden`))));
  const entries = await loadDiagnostics();
  assert.equal(entries.length, 20);
  assert.ok(entries.every((entry) => !entry.message.includes("private.example")));
});


test("rule-editor diagnostics preserve a copyable technical cause chain and source context", async () => {
  await clearDiagnostics();
  const cause = new TypeError("Firefox tabs query rejected");
  const error = new Error("The rule dialog could not be initialized.", { cause });
  error.stack = "Error: The rule dialog could not be initialized.\n    at test";
  await recordDiagnostic("open-rule-editor", error, false, {
    phase: "find-dialog-tab",
    source: { tabId: 17, windowId: 8, url: "https://private.example/path?mode=test" },
    editor: { token: "editor-token", windowId: 22, tabId: null },
    browserResult: { queryDialogTabs: { windowId: 22, tabs: [] } }
  });
  const [entry] = await loadDiagnostics();
  assert.equal(entry.operation, "open-rule-editor");
  assert.equal(entry.message, "The rule dialog could not be initialized.");
  assert.equal(entry.technical.error.name, "Error");
  assert.equal(entry.technical.error.cause.name, "TypeError");
  assert.equal(entry.technical.context.phase, "find-dialog-tab");
  assert.equal(entry.technical.context.source.tabId, 17);
  assert.equal(entry.technical.context.source.url, "https://private.example/path?mode=test");
  assert.deepEqual(entry.technical.context.browserResult.queryDialogTabs.tabs, []);
});


test("a browser without session storage uses a volatile diagnostic fallback", async () => {
  const saved = chrome.storage.session;
  delete chrome.storage.session;
  try {
    await clearDiagnostics();
    await recordDiagnostic("Fallback", new Error("test"));
    assert.equal((await loadDiagnostics()).length, 1);
    await clearDiagnostics();
  } finally {
    chrome.storage.session = saved;
  }
});
