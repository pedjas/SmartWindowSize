/**
 * Provides validated manual dimensions and shared standard presets for one browser window.
 * The service worker validates, applies, and persists the submitted size for the target window's active tab.
 */
import { APP_VERSION } from "../core/app-version.js";
import { WINDOW_PRESETS, findHorizontalPresetIndex, orientedPresetSize } from "../core/window-presets.js";
import { request, installClientErrors, runClientAction } from "../core/client.js";


/** Displays the central application version in the size-selector heading and document title. */
document.title = `SmartWindowSize ${APP_VERSION} — Set window dimensions`;


/** Browser window ID supplied by the popup that opened this selector. @type {number} */
const targetWindowId = Number(new URLSearchParams(location.search).get("windowId") ?? NaN);


/** Manual-size form containing the preset selection and dimensions. @type {HTMLFormElement} */
const form = document.querySelector("#size-form");


/** Dropdown offering shared standard sizes and a Custom input option. @type {HTMLSelectElement} */
const presetInput = document.querySelector("#preset");


/** Width input for a Custom outer window size. @type {HTMLInputElement} */
const widthInput = document.querySelector("#width");


/** Height input for a Custom outer window size. @type {HTMLInputElement} */
const heightInput = document.querySelector("#height");


/** Checkbox that rotates the selected standard preset into vertical orientation. @type {HTMLInputElement} */
const verticalInput = document.querySelector("#vertical");


/** Text element presenting validation failures to the user. @type {HTMLElement} */
const errorElement = document.querySelector("#error");
installClientErrors(errorElement);


/** Text element presenting current minimum and maximum dimensions. @type {HTMLElement} */
const limitsElement = document.querySelector("#limits");


/** Current display-dependent limits returned by the service worker. @type {{width: number, height: number}|null} */
let maximum = null;


/**
 * Checks a size against the current minimum and maximum UI limits.
 *
 * @param {number} width Requested width in pixels.
 * @param {number} height Requested height in pixels.
 * @returns {boolean} Whether the selector may submit the dimensions.
 */
function isAllowedSize(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 320 && height >= 240 &&
    maximum !== null && width <= maximum.width && height <= maximum.height;
}


/**
 * Returns the selected shared preset, if a standard option is selected.
 *
 * @returns {object|null} Selected preset or null for Custom.
 */
function selectedPreset() {
  const index = Number(presetInput.value.replace("preset:", ""));
  return presetInput.value.startsWith("preset:") && Number.isInteger(index) ? WINDOW_PRESETS[index] ?? null : null;
}


/** Synchronizes visible dimensions and input availability with the current preset selection. @returns {void} */
function synchronizePresetSelection() {
  const preset = selectedPreset();
  const isCustom = preset === null;
  widthInput.disabled = !isCustom;
  heightInput.disabled = !isCustom;
  if (!preset) return;

  const size = orientedPresetSize(preset, verticalInput.checked);
  widthInput.value = String(size.width);
  heightInput.value = String(size.height);
  errorElement.textContent = "";
}


/** Renders the preset dropdown. @param {string|Event} selectedValue Explicit initial selection or browser change event. @returns {void} */
function renderPresets(selectedValue = presetInput.value || "custom") {
  const previousValue = typeof selectedValue === "string" ? selectedValue : presetInput.value;
  presetInput.replaceChildren();
  WINDOW_PRESETS.forEach((preset, index) => {
    const size = orientedPresetSize(preset, verticalInput.checked);
    const option = new Option(`${preset.label} — ${size.width} × ${size.height}`, `preset:${index}`);
    option.disabled = !isAllowedSize(size.width, size.height);
    presetInput.add(option);
  });
  presetInput.add(new Option("Custom", "custom"));
  presetInput.value = Array.from(presetInput.options).some((option) => option.value === previousValue && !option.disabled) ? previousValue : Array.from(presetInput.options).find((option) => !option.disabled)?.value ?? "custom";
  synchronizePresetSelection();
  updateOrientationAvailability();
}


/** Enables an orientation change only if its resulting size fits the target display. @returns {void} */
function updateOrientationAvailability() {
  const preset = selectedPreset();
  const next = preset ? orientedPresetSize(preset, !verticalInput.checked) : { width: Number(heightInput.value), height: Number(widthInput.value) };
  verticalInput.disabled = !isAllowedSize(next.width, next.height);
}


/** Selects the matching preset or Custom from the current target-window dimensions. @param {{width: number, height: number}} current Current target-window outer dimensions. @returns {void} Updates controls before the first render. */
function selectCurrentSize(current) {
  const horizontalIndex = findHorizontalPresetIndex(current.width, current.height);
  const verticalIndex = findHorizontalPresetIndex(current.height, current.width);
  if (horizontalIndex >= 0) {
    presetInput.value = `preset:${horizontalIndex}`;
    verticalInput.checked = false;
  } else if (verticalIndex >= 0) {
    presetInput.value = `preset:${verticalIndex}`;
    verticalInput.checked = true;
  } else {
    presetInput.value = "custom";
    verticalInput.checked = false;
  }
  widthInput.value = String(current.width);
  heightInput.value = String(current.height);
  const index = horizontalIndex >= 0 ? horizontalIndex : verticalIndex;
  renderPresets(index >= 0 ? `preset:${index}` : "custom");
}


/** Loads display limits and selects the actual target-window size and orientation. @returns {Promise<void>} Completes after the selector is ready. */
async function initialize() {
  if (!Number.isInteger(targetWindowId) || targetWindowId < 0) throw new Error("Missing target window identifier.");
  const response = await request({ type: "get-window-size-limits", windowId: targetWindowId });
  if (response?.error || !response?.maximum) throw new Error(response?.error ?? "Unable to read window limits.");
  maximum = response.maximum;
  widthInput.min = "320";
  heightInput.min = "240";
  widthInput.max = String(maximum.width);
  heightInput.max = String(maximum.height);
  limitsElement.textContent = `Allowed: 320 × 240 to ${maximum.width} × ${maximum.height} px.`;
  selectCurrentSize(response.current);
}


/** Reorients the selected standard preset without exposing Custom inputs. */
verticalInput.addEventListener("change", () => {
  if (!selectedPreset()) {
    [widthInput.value, heightInput.value] = [heightInput.value, widthInput.value];
  }
  renderPresets();
});


/** Revalidates Custom orientation after either dimension is edited. */
for (const input of [widthInput, heightInput]) input.addEventListener("input", updateOrientationAvailability);


/** Applies the current dropdown selection to the visible dimensions. */
presetInput.addEventListener("change", renderPresets);


/** Focuses the browser window whose dimensions this dialog controls. */
document.querySelector("#bring-to-front").addEventListener("click", async () => {
  await runClientAction("Focus source window", () => request({ type: "focus-window", windowId: targetWindowId }));
});


/** Closes the manual-size dialog without changing the target browser window. */
document.querySelector("#cancel").addEventListener("click", () => window.close());


/** Adds explanatory tooltips to every static dialog action. */
for (const button of document.querySelectorAll("button")) button.title ||= button.textContent.trim();


/** Validates and applies explicitly submitted dimensions to the target browser window. */
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const width = Number(widthInput.value);
  const height = Number(heightInput.value);
  if (!isAllowedSize(width, height)) {
    errorElement.textContent = `Enter whole-pixel dimensions from 320 × 240 to ${maximum?.width ?? "?"} × ${maximum?.height ?? "?"}.`;
    return;
  }

  const apply = document.querySelector('button[form="size-form"][type="submit"]');
  if (apply.disabled) return;
  apply.disabled = true;
  await runClientAction("Set window dimensions", async () => {
    await request({ type: "resize-window", windowId: targetWindowId, width, height });
    window.close();
  });
  apply.disabled = false;
});


runClientAction("Load window dimensions", async () => {
  document.querySelector('button[form="size-form"][type="submit"]').disabled = true;
  await initialize();
  document.querySelector('button[form="size-form"][type="submit"]').disabled = false;
});
