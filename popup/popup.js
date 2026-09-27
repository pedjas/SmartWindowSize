/**
 * Displays the current resolved rule and sends popup actions to the service worker.
 * It intentionally delegates rule resolution and persistence to shared background logic.
 */

import { APP_VERSION } from "../core/app-version.js";
import { toUrl } from "../core/rule-matcher.js";
import { request, installClientErrors, runClientAction } from "../core/client.js";


/** Installs visible client error reporting before requesting background state. */
installClientErrors(document.querySelector("#active-rule"));

/** Current popup state loaded through the checked background protocol. @type {object} */
const state = await request({ type: "get-state" }).catch(async (error) => {
  await runClientAction("Load popup", async () => { throw error; });
  return { config: { global: { enabled: false } }, error: error.message };
});
document.title = `SmartWindowSize ${APP_VERSION}`;
document.querySelector("#application-title").textContent = `SmartWindowSize ${APP_VERSION}`;


/** Element that reports the active resolved rule or absence of a saved rule. @type {HTMLElement} */
const label = document.querySelector("#active-rule");

/** Current outer-window dimension label. @type {HTMLElement} */
const currentSize = document.querySelector("#current-size");


/** User-facing coverage labels keyed by persisted rule scope type. @type {Readonly<Record<string, string>>} */
const ruleLabels = Object.freeze({
  domain_tree: "This domain and its subdomains",
  domain_exact: "This domain only",
  url_subpaths: "This URL and its subpaths",
  url_any_parameters: "This URL — any parameters",
  url_exact_parameters: "This URL — exact query parameters",
  url_non_exact_parameters: "This URL — non-exact query parameters"
});
currentSize.textContent = state.currentSize ? `Current size: ${state.currentSize.width} × ${state.currentSize.height} px` : "Current size: unavailable";
if (state.resolved?.status === "RULE") label.textContent = `Active rule: ${ruleLabels[state.resolved.rule.scope.type] ?? "Unknown rule"}`;
else if (state.resolved?.status === "DISABLED") label.textContent = state.config?.global?.enabled === false ? "SmartWindowSize is disabled." : "The matching saved rule is disabled.";
else label.textContent = state.error ?? "No saved rule for this site.";


/** Disables window-affecting actions when the global extension switch is off. */
for (const id of ["set-rule", "manual-size"]) document.querySelector(`#${id}`).disabled = state.config?.global?.enabled !== true;
if (!toUrl(state.url)) document.querySelector("#set-rule").disabled = true;

document.querySelector("#set-rule").addEventListener("click", async () => {
  await runClientAction("Open rule editor", async () => {
    await request({ type: "open-rule-editor", tabId: state.tabId });
    window.close();
  });
});


/** Opens a separate size selector for the browser window that owns this popup. */
document.querySelector("#manual-size").addEventListener("click", async () => {
  await runClientAction("Open window size settings", async () => {
    await request({ type: "open-size-picker", tabId: state.tabId });
    window.close();
  });
});

/** Adds mouse-over descriptions to popup actions. */
for (const button of document.querySelectorAll("button")) button.title ||= button.textContent.trim();
