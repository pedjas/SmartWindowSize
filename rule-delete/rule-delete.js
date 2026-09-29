/**
 * Stages complete matching-rule edits for one browser tab until the user saves.
 * It cooperates with the service worker, which validates and applies the staged result.
 */
import { APP_VERSION } from "../core/app-version.js";
import { SCOPE_PRIORITY } from "../core/rule-matcher.js";
import { matchingRulesForUrl, resolveRule } from "../core/rule-resolver.js";
import { request, installClientErrors, runClientAction, showClientError } from "../core/client.js";


/** Browser tab identifier whose matching rules are being edited. @type {number} */
const tabId = Number(new URL(location.href).searchParams.get("tabId") ?? NaN);

/** Browser window identifier captured with the source tab at the user action. @type {number} */
const sourceWindowId = Number(new URL(location.href).searchParams.get("sourceWindowId") ?? NaN);

/** Opaque token that binds this internal page to the source context captured when the dialog opened. @type {string|undefined} */
const editorToken = new URL(location.href).searchParams.get("editorToken") ?? undefined;

/** Immutable source URL copied into the dialog URL when the user opens Set rules. @type {string} */
const capturedSourceUrl = new URL(location.href).searchParams.get("sourceUrl") ?? "";


/** Resolves the internal extension tab identity used to complete the background editor handshake. @type {Promise<{editorTabId?: number, editorWindowId?: number}>} */
const editorIdentity = typeof chrome.tabs?.getCurrent === "function"
  ? chrome.tabs.getCurrent().then((tab) => Number.isInteger(tab?.id) && Number.isInteger(tab?.windowId) ? { editorTabId: tab.id, editorWindowId: tab.windowId } : {}).catch(() => ({}))
  : Promise.resolve({});


/** Sends a rule-editor request with immutable source binding and the internal tab handshake identity. @param {object} message Rule-editor request fields. @returns {Promise<object>} Background response. */
async function requestEditor(message) {
  return request({ ...message, tabId, sourceWindowId, editorToken, ...await editorIdentity });
}


/** Human-readable labels keyed by persisted coverage type. @type {Record<string, string>} */
const labels = Object.freeze({
  domain_tree: "This domain and its subdomains",
  domain_exact: "This domain only",
  url_subpaths: "This URL and its subpaths",
  url_any_parameters: "This URL — any parameters",
  url_exact_parameters: "This URL — exact query parameters",
  url_non_exact_parameters: "This URL — non-exact query parameters"
});


/** Rule list staged locally until Save changes is clicked. @type {{url: string, rules: object[], resolvedRuleId?: string|null}|null} */
let state = null;


/** Identifier of the staged rule displayed in the editor, or null when adding. @type {string|null} */
let editingRuleId = null;

/** Initial local values of the currently open editor, used to detect an unsaved field change. @type {{scope: string, rememberPosition: boolean}|null} */
let editorBaseline = null;

/** Immutable initial matching-rule snapshot used to detect conflicting saves. @type {object[]} */
let baseRules = [];

/** Prevents overlapping edit and save operations in this view. @type {boolean} */
let busy = false;

/** Orders live refreshes so an older response cannot replace newly acquired access. @type {Promise<unknown>} */
let refreshQueue = Promise.resolve();


/** List element that displays staged matching rules. @type {HTMLUListElement} */
const list = document.querySelector("#rules");


/** Empty-state message displayed when there are no staged matching rules. @type {HTMLParagraphElement} */
const empty = document.querySelector("#empty");


/** Button that opens the add-rule editor. @type {HTMLButtonElement} */
const addButton = document.querySelector("#add");


/** Framed form used for both adding and editing one rule. @type {HTMLFormElement} */
const editor = document.querySelector("#editor");


/** Coverage selector inside the rule editor. @type {HTMLSelectElement} */
const scopeInput = document.querySelector("#selected-scope");


/** Position-persistence checkbox inside the rule editor. @type {HTMLInputElement} */
const positionInput = document.querySelector("#remember-position");
const monitorInput = document.querySelector("#remember-monitor");


/** Recalculates the active staged rule from the shared coverage priority. @returns {void} Updates the bold row state. */
function resolveStagedRule() {
  state.resolvedRuleId = resolveRule(state.url, { global: { enabled: true, useDefaultSize: false }, rules: state.rules }).rule?.id ?? null;
}


/** Sorts staged rules from narrowest to broadest coverage. @returns {object[]} Sorted staged rules. */
function sortedRules() {
  return matchingRulesForUrl(state.url, { rules: state.rules });
}


/** Renders every staged matching rule and its edit/delete controls. @returns {void} */
function render() {
  resolveStagedRule();
  list.replaceChildren(...sortedRules().map((rule) => {
    const row = document.createElement("li");
    if (rule.id === state.resolvedRuleId) row.classList.add("active");
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${labels[rule.scope.type]} — ${rule.width} × ${rule.height}`;
    const position = document.createElement("span");
    position.className = "details";
    position.textContent = `${rule.position?.enabled ? `Remember position: Yes (${rule.position.x},${rule.position.y})` : "Remember position: No"} · Remember monitor: ${rule.display?.enabled ? "Yes" : "No"}`;
    details.append(title, position);
    const coverage = document.createElement("span");
    coverage.className = "details";
    coverage.textContent = rule.scope.value;
    details.append(coverage);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.title = "Edit this rule";
    edit.disabled = busy || !state.writable;
    edit.addEventListener("click", () => openEditor(rule));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.setAttribute("aria-label", `Delete ${labels[rule.scope.type]} rule`);
    remove.title = `Delete ${labels[rule.scope.type]} rule`;
    remove.textContent = "×";
    remove.disabled = busy || !state.writable;
    remove.addEventListener("click", () => {
      if (busy || !state.writable) return;
      state.rules = state.rules.filter((item) => item.id !== rule.id);
      if (editingRuleId === rule.id) closeEditor();
      render();
    });
    actions.append(edit, remove);
    row.append(details, actions);
    return row;
  }));
  empty.hidden = state.rules.length !== 0;
}


/** Opens the framed editor in add mode or for one existing staged rule. @param {object|null} rule Existing staged rule, or null to add. @returns {void} */
function openEditor(rule = null) {
  if (busy || !state?.writable) return;
  editingRuleId = rule?.id ?? null;
  scopeInput.value = rule?.scope.type ?? "";
  positionInput.checked = rule?.position?.enabled === true;
  monitorInput.checked = rule?.display?.enabled === true;
  editorBaseline = { scope: scopeInput.value, rememberPosition: positionInput.checked, rememberMonitor: monitorInput.checked };
  document.querySelector("#editor-title").textContent = rule ? "Edit rule" : "Add rule";
  document.querySelector("#confirm-rule").textContent = rule ? "Update rule" : "Add rule";
  document.querySelector("#confirm-rule").title = rule ? "Update this staged rule using the current window size" : "Add a staged rule using the current window size";
  editor.hidden = false;
  addButton.hidden = true;
  synchronizeScopeSelection();
  editor.scrollIntoView?.({ block: "center", inline: "nearest" });
  scopeInput.focus();
}


/** Closes the framed editor without changing staged rules. @returns {void} */
function closeEditor() {
  editingRuleId = null;
  editorBaseline = null;
  editor.hidden = true;
  addButton.hidden = false;
  synchronizeScopeSelection();
}


/** Determines whether staged rules or the visible editor differ from the loaded state. @returns {boolean} Whether Reload must confirm discarding local edits. */
function hasUnsavedChanges() {
  const normalized = (rules) => [...rules].sort((left, right) => left.id.localeCompare(right.id));
  const rulesChanged = JSON.stringify(normalized(state?.rules ?? [])) !== JSON.stringify(normalized(baseRules));
  const editorChanged = !editor.hidden && editorBaseline !== null && (scopeInput.value !== editorBaseline.scope || positionInput.checked !== editorBaseline.rememberPosition || monitorInput.checked !== editorBaseline.rememberMonitor);
  return rulesChanged || editorChanged;
}


/** Updates confirmation availability while an explicit scope choice is missing. @returns {void} Updates form and dialog buttons without persisting edits. */
function synchronizeScopeSelection() {
  const blocked = busy || !state?.writable;
  const incomplete = !editor.hidden && !SCOPE_PRIORITY.includes(scopeInput.value);
  document.querySelector("#confirm-rule").disabled = blocked || incomplete;
  document.querySelector("#save").disabled = blocked || !editor.hidden;
  document.querySelector("#cancel").disabled = busy;
  document.querySelector("#cancel-edit").disabled = blocked;
  addButton.disabled = blocked;
  scopeInput.disabled = blocked;
  positionInput.disabled = blocked;
  for (const button of list.querySelectorAll("button")) button.disabled = blocked;
  document.querySelector("#reload").disabled = busy;
  document.querySelector("#enable-editing").disabled = busy || !state?.sourceValid || !state?.enabled;
}


/** Samples current source-window bounds and creates a staged rule. @param {object|null} existing Existing staged rule, if any. @returns {Promise<object>} Rule ready for staging, not yet persisted. */
async function ruleFromEditor(existing) {
  const response = await requestEditor({ type: "prepare-site-rule", url: state.url, scope: scopeInput.value, rememberPosition: positionInput.checked, rememberMonitor: monitorInput.checked, existing });
  return response.rule;
}


/** Loads the initial staged state from the service worker. @returns {Promise<void>} Completes after the list is drawn. */
async function load() {
  await refresh(true);
}


/** Refreshes access and observers without overwriting the writable draft. @param {boolean} replaceDraft Explicit reload or initial load. @param {string} type State or acquisition request. @returns {Promise<void>} Render completion. */
function refresh(replaceDraft = false, type = "get-rule-editor-state") {
  const work = refreshQueue.catch(() => undefined).then(async () => {
    const next = await requestEditor({ type });
    const preserve = state?.ownsEditor && next.ownsEditor && !replaceDraft;
    state = preserve ? { ...next, rules: state.rules } : next;
    if (!preserve) {
      baseRules = structuredClone(state.rules);
      closeEditor();
    }
    document.querySelector("#source-url").textContent = state.url;
    document.title = `SmartWindowSize ${APP_VERSION} — Set rules for this site — ${new URL(state.url).hostname}`;
    document.querySelector("#access-status").textContent = !state.sourceValid
      ? "The source page changed or closed. Close this dialog and reopen it from the page you want to edit."
      : !state.enabled ? "SmartWindowSize is disabled. Editing is unavailable."
        : state.writable ? "Editing rules for this source URL."
          : state.hasOwner ? "Rules are being edited in another window. This dialog is read-only."
            : "This dialog is read-only. Choose Enable editing to make changes.";
    document.querySelector("#focus-editor").hidden = !state.hasOwner || state.ownsEditor;
    document.querySelector("#enable-editing").hidden = state.hasOwner;
    render();
    synchronizeScopeSelection();
  });
  refreshQueue = work;
  return work;
}


/** Initializes the dialog caption without repeating the application name in its body. */
document.title = `SmartWindowSize ${APP_VERSION} — Set rules for this site`;
document.querySelector("#source-url").textContent = capturedSourceUrl;
installClientErrors(document.querySelector("#error"));
for (const button of document.querySelectorAll("button")) button.title ||= button.textContent.trim();

addButton.addEventListener("click", () => openEditor());
scopeInput.addEventListener("change", synchronizeScopeSelection);
document.querySelector("#cancel-edit").addEventListener("click", () => { if (!busy && state?.writable) closeEditor(); });
editor.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !state?.writable) return;
  if (!SCOPE_PRIORITY.includes(scopeInput.value)) {
    scopeInput.reportValidity();
    return;
  }
  busy = true;
  synchronizeScopeSelection();
  await runClientAction("Prepare site rule", async () => {
    const existing = editingRuleId ? state.rules.find((rule) => rule.id === editingRuleId) ?? null : null;
    const next = await ruleFromEditor(existing);
    if (!state.writable) return;
    state.rules = state.rules.filter((rule) => rule.id !== next.id && (rule.scope.type !== next.scope.type || rule.scope.value !== next.scope.value));
    state.rules.push(next);
    closeEditor();
    render();
  });
  busy = false;
  synchronizeScopeSelection();
});
document.querySelector("#save").addEventListener("click", async () => {
  if (!state?.writable) return;
  if (busy || !editor.hidden) {
    scopeInput.reportValidity();
    return;
  }
  busy = true;
  synchronizeScopeSelection();
  await runClientAction("Save site rules", async () => {
    await requestEditor({ type: "save-site-rules", url: state.url, rules: state.rules, baseRules });
    window.close();
  });
  busy = false;
  synchronizeScopeSelection();
});
document.querySelector("#cancel").addEventListener("click", () => window.close());
document.querySelector("#bring-to-front").addEventListener("click", async () => {
  await runClientAction("Focus source window", () => request({ type: "focus-window", tabId }));
});
document.querySelector("#reload").addEventListener("click", () => {
  if (!busy && (!state?.ownsEditor || !hasUnsavedChanges() || confirm("Discard staged changes and reload the current rules?"))) runClientAction("Reload rules", load);
});
document.querySelector("#focus-editor").addEventListener("click", () => runClientAction("Focus editable dialog", () => requestEditor({ type: "focus-rule-editor" })));
document.querySelector("#enable-editing").addEventListener("click", async () => {
  if (busy || state?.hasOwner || !state?.sourceValid || !state?.enabled) return;
  busy = true;
  synchronizeScopeSelection();
  await runClientAction("Enable rule editing", () => refresh(true, "enable-rule-editing"));
  busy = false;
  synchronizeScopeSelection();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "rule-editors-changed") refresh().catch((error) => showClientError("Refresh rule editor", error));
});
synchronizeScopeSelection();
runClientAction("Load rule editor", load);
