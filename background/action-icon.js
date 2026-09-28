/**
 * Provides toolbar icon paths for the current SmartWindowSize state.
 * This module is used by the service worker after resolving a rule for a tab.
 */
import { APP_VERSION } from "../core/app-version.js";

/**
 * Maps an active-state flag to every icon size declared by the manifest.
 * @param {boolean} state Whether SmartWindowSize is active for the tab.
 * @returns {Record<number, string>} Icon paths keyed by pixel size.
 */
export function iconPaths(state, hasDiagnostics = false) {


  /** Base filename for the active or disabled icon family. @type {string} */
  const name = !state ? "inactive" : hasDiagnostics ? "error" : "active";
  return {
    16: `icons/${name}-16.png`,
    32: `icons/${name}-32.png`,
    48: `icons/${name}-48.png`,
    128: `icons/${name}-128.png`
  };
}


/**
 * Determines whether the colored toolbar icon is allowed for a resolved browser context.
 *
 * @param {{status?: string}|null} resolved Resolved global and scope state.
 * @returns {boolean} Whether SmartWindowSize is enabled in this context.
 */
export function isActionActive(resolved) {
  return resolved?.status !== "DISABLED";
}


/** Decoded toolbar icon data cached for the lifetime of the background environment. @type {Map<string, ImageData>} */
const iconImageDataCache = new Map();


/**
 * Decodes one packaged PNG through the extension runtime URL into action-compatible image data.
 *
 * @param {string} path Relative packaged PNG path.
 * @returns {Promise<ImageData>} Pixel data accepted by chrome.action.setIcon.
 * @throws {Error} When the packaged asset cannot be fetched or decoded.
 */
async function imageDataForPath(path) {
  if (iconImageDataCache.has(path)) return iconImageDataCache.get(path);
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`Unable to fetch ${path}: HTTP ${response.status}.`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(bitmap.width, bitmap.height) : globalThis.document?.createElement("canvas");
  if (!canvas) throw new Error("This browser cannot decode a toolbar icon.");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(`Unable to create a drawing context for ${path}.`);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  iconImageDataCache.set(path, imageData);
  return imageData;
}


/** Builds the device-density icon dictionary from locally decoded PNG image data. @param {boolean} state Whether the active icon family is needed. @returns {Promise<Record<number, ImageData>>} Image data keyed by pixel size. */
async function iconImageData(state, hasDiagnostics = false) {
  const paths = iconPaths(state, hasDiagnostics);
  const entries = await Promise.all(Object.entries(paths).map(async ([size, path]) => [size, await imageDataForPath(path)]));
  return Object.fromEntries(entries);
}


/** Resolves packaged paths independently of the background script directory. @param {boolean} active Enabled state. @param {boolean} warning Diagnostic state. @returns {object} Absolute extension icon URLs. */
function absoluteIconPaths(active, warning) {
  return Object.fromEntries(Object.entries(iconPaths(active, warning)).map(([size, path]) => [size, chrome.runtime.getURL(path)]));
}


/**
 * Updates the toolbar icon and accessible title for a tab's resolved state.
 * @param {number} tabId Browser tab identifier.
 * @param {{status?: string}|null} resolved Resolved rule result for the tab.
 * @returns {Promise<Array<{operation: string, error: unknown}>>} Non-fatal browser API failures that the caller must record.
 */
export async function updateActionIcon(tabId, resolved, hasDiagnostics = false) {
  /** Whether the resolved state permits SmartWindowSize actions in this tab. @type {boolean} */
  const active = isActionActive(resolved);
  const warning = active && hasDiagnostics;
  const failures = [];
  try {
    try {
      const imageData = await iconImageData(active, warning);
      await chrome.action.setIcon({ tabId, imageData });
    } catch {
      await chrome.action.setIcon({ tabId, path: absoluteIconPaths(active, warning) });
    }
  } catch (error) {
    failures.push({ operation: "Apply toolbar icon", error });
  }
  try {
    await chrome.action.setTitle({ tabId, title: active ? `SmartWindowSize ${APP_VERSION}: enabled` : `SmartWindowSize ${APP_VERSION}: disabled` });
  } catch (error) {
    if (!/No tab with id/i.test(error.message)) failures.push({ operation: "Set toolbar title", error });
  }
  return failures;
}


/**
 * Updates the default toolbar icon used before a tab-specific icon is available.
 * @param {boolean} enabled Whether the extension is globally enabled.
 * @param {boolean} hasDiagnostics Whether the warning icon takes precedence.
 * @returns {Promise<Array<{operation: string, error: unknown}>>} Non-fatal browser API failures.
 */
export async function updateDefaultActionIcon(enabled, hasDiagnostics = false) {
  const failures = [];
  try {
    try {
      await chrome.action.setIcon({ imageData: await iconImageData(enabled, false) });
    } catch {
      await chrome.action.setIcon({ path: absoluteIconPaths(enabled, false) });
    }
  } catch (error) {
    failures.push({ operation: "Apply default toolbar icon", error });
  }
  return failures;
}
