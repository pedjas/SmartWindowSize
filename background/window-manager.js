/**
 * Applies resolved SmartWindowSize rules to browser windows.
 * It cooperates with the service worker and optional display API data.
 */

/** Smallest user-selectable browser window width in pixels. @type {number} */
export const MINIMUM_WINDOW_WIDTH = 320;

/** Smallest user-selectable browser window height in pixels. @type {number} */
export const MINIMUM_WINDOW_HEIGHT = 240;

/** Maximum manual size used when display work-area data is unavailable. @type {{width: number, height: number}} */
export const FALLBACK_MAXIMUM_WINDOW_SIZE = Object.freeze({ width: 7680, height: 4320 });

/**
 * Limits a requested size to the usable bounds of a display when available.
 * @param {{width: number, height: number}} size Requested window dimensions.
 * @param {chrome.system.display.DisplayUnitInfo|undefined} display Target display.
 * @returns {{width: number, height: number}} Safe window dimensions.
 */
export function clampSize(size, display) {
  const area = display?.workArea ?? display?.bounds;
  if (!area) return size;
  return { width: Math.min(size.width, area.width), height: Math.min(size.height, area.height) };
}


/**
 * Constrains a window's size and position to a display work area.
 *
 * Position is adjusted before size whenever the requested size already fits.
 *
 * @param {chrome.windows.Window} windowInfo Current browser window bounds.
 * @param {{width: number, height: number}} desired Requested outer-window dimensions.
 * @param {object|null} rule Resolved rule with an optional saved position.
 * @param {chrome.system.display.DisplayUnitInfo|undefined} display Target display.
 * @returns {{width: number, height: number, left: number, top: number, sizeAdjusted: boolean}} Bounds safe for windows.update.
 */
export function constrainWindowBounds(windowInfo, desired, rule, display) {
  const size = clampSize(desired, display);
  const area = display?.workArea ?? display?.bounds;
  const preferredLeft = rule?.position?.enabled ? rule.position.x : windowInfo.left;
  const preferredTop = rule?.position?.enabled ? rule.position.y : windowInfo.top;
  if (!area) {
    return {
      ...size,
      left: Number.isInteger(preferredLeft) ? preferredLeft : 0,
      top: Number.isInteger(preferredTop) ? preferredTop : 0,
      sizeAdjusted: size.width !== desired.width || size.height !== desired.height
    };
  }
  return {
    ...size,
    left: Math.max(area.left, Math.min(preferredLeft ?? area.left, area.left + area.width - size.width)),
    top: Math.max(area.top, Math.min(preferredTop ?? area.top, area.top + area.height - size.height)),
    sizeAdjusted: size.width !== desired.width || size.height !== desired.height
  };
}


/**
 * Selects only browser-supported window-bound fields from an internal bounds calculation.
 *
 * @param {{width: number, height: number, left: number, top: number}} bounds Internal calculated bounds.
 * @returns {{width: number, height: number, left: number, top: number}} Object accepted by chrome.windows.update.
 */
export function windowUpdateInfo(bounds) {
  return { width: bounds.width, height: bounds.height, left: bounds.left, top: bounds.top };
}


/**
 * Returns a stored position constrained to the target display's work area.
 * @param {object|null} rule Resolved rule with optional position data.
 * @param {chrome.system.display.DisplayUnitInfo|undefined} display Target display.
 * @returns {{left?: number, top?: number}} Position accepted by windows.update.
 */
export function positionForRule(rule, display) {
  if (!rule?.position?.enabled) return {};
  const area = display?.workArea ?? display?.bounds;
  if (!area) return { left: rule.position.x, top: rule.position.y };
  return {
    left: Math.max(area.left, Math.min(rule.position.x, area.left + area.width - rule.width)),
    top: Math.max(area.top, Math.min(rule.position.y, area.top + area.height - rule.height))
  };
}


/**
 * Selects a rule's saved display or the display that currently contains the window.
 * @param {object|null} rule Resolved rule with optional display data.
 * @param {chrome.windows.Window} windowInfo Current browser window used when no display is saved.
 * @returns {Promise<chrome.system.display.DisplayUnitInfo|undefined>} Selected display.
 */
export async function displayForRule(rule, windowInfo) {
  if (!chrome.system?.display?.getInfo) return undefined;

  let displays;
  try {
    displays = await chrome.system.display.getInfo();
  } catch {
    return undefined;
  }

  if (!rule?.display?.enabled) return displayForWindow(windowInfo, displays);
  return displays.find((display) => display.id === rule.display.id) ?? displays.find((display) => display.isPrimary) ?? displays[0];
}


/**
 * Finds the display with the greatest overlap with a window, with the primary display as fallback.
 * @param {chrome.windows.Window} windowInfo Browser window being resized.
 * @param {chrome.system.display.DisplayUnitInfo[]} displays Available displays.
 * @returns {chrome.system.display.DisplayUnitInfo|undefined} Display used for manual-size limits.
 */
export function displayForWindow(windowInfo, displays) {
  const windowBounds = {
    left: windowInfo.left ?? 0,
    top: windowInfo.top ?? 0,
    width: windowInfo.width ?? 0,
    height: windowInfo.height ?? 0
  };
  let selected;
  let greatestOverlap = 0;
  for (const display of displays) {
    const overlap = overlapArea(windowBounds, display.workArea ?? display.bounds);
    if (overlap > greatestOverlap) {
      selected = display;
      greatestOverlap = overlap;
    }
  }
  return selected ?? displays.find((display) => display.isPrimary) ?? displays[0];
}


/**
 * Calculates the shared area of two rectangular browser/display bounds.
 * @param {{left: number, top: number, width: number, height: number}} first First rectangle.
 * @param {{left: number, top: number, width: number, height: number}} second Second rectangle.
 * @returns {number} Shared area in square pixels, or zero when the rectangles do not overlap.
 */
export function overlapArea(first, second) {
  const width = Math.max(0, Math.min(first.left + first.width, second.left + second.width) - Math.max(first.left, second.left));
  const height = Math.max(0, Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top));
  return width * height;
}


/**
 * Verifies that complete browser window bounds lie within a selected display work area.
 * @param {chrome.windows.Window} windowInfo Browser window whose bounds are checked.
 * @param {chrome.system.display.DisplayUnitInfo|undefined} display Selected display.
 * @returns {boolean} Whether all bounds are verified against a known display.
 */
export function isWindowOnDisplay(windowInfo, display) {
  const area = display?.workArea ?? display?.bounds;
  if (!area) return false;
  return windowInfo.left >= area.left && windowInfo.top >= area.top &&
    windowInfo.left + windowInfo.width <= area.left + area.width &&
    windowInfo.top + windowInfo.height <= area.top + area.height;
}


/**
 * Returns the maximum dimensions permitted for manual input on a window's display.
 * @param {chrome.windows.Window} windowInfo Browser window being resized.
 * @returns {Promise<{width: number, height: number}>} Available work-area size or the safe fallback.
 */
export async function maximumManualSizeForWindow(windowInfo) {
  if (!chrome.system?.display?.getInfo) return FALLBACK_MAXIMUM_WINDOW_SIZE;

  try {
    const displays = await chrome.system.display.getInfo();
    const display = displayForWindow(windowInfo, displays);
    const area = display?.workArea ?? display?.bounds;
    return area ? { width: area.width, height: area.height } : FALLBACK_MAXIMUM_WINDOW_SIZE;
  } catch {
    return FALLBACK_MAXIMUM_WINDOW_SIZE;
  }
}


/**
 * Checks user-entered dimensions against the global minimum and display maximum.
 * @param {number} width Requested outer window width in pixels.
 * @param {number} height Requested outer window height in pixels.
 * @param {{width: number, height: number}} maximum Current display or fallback maximum.
 * @returns {boolean} Whether both dimensions are allowed.
 */
export function isAllowedManualSize(width, height, maximum) {
  return Number.isInteger(width) && Number.isInteger(height) &&
    width >= MINIMUM_WINDOW_WIDTH && height >= MINIMUM_WINDOW_HEIGHT &&
    width <= maximum.width && height <= maximum.height;
}


/**
 * Applies validated manual dimensions to one browser window without saving a rule.
 * @param {number} windowId Browser window identifier selected by the user.
 * @param {number} width Requested outer window width in pixels.
 * @param {number} height Requested outer window height in pixels.
 * @param {Function} canApply Last-moment global-enabled check.
 * @returns {Promise<object>} Actual browser bounds, applied limits, and exact-size verification.
 * @throws {RangeError} When dimensions are outside the permitted range.
 */
export async function resizeWindowManually(windowId, width, height, canApply = async () => true) {
  const windowInfo = await chrome.windows.get(windowId);
  if (windowInfo.state !== "normal") throw new Error("Restore the window before changing its dimensions.");
  const maximum = await maximumManualSizeForWindow(windowInfo);
  if (!isAllowedManualSize(width, height, maximum)) {
    throw new RangeError(`Dimensions must be whole pixels from ${MINIMUM_WINDOW_WIDTH} × ${MINIMUM_WINDOW_HEIGHT} to ${maximum.width} × ${maximum.height}.`);
  }

  if (windowInfo.width === width && windowInfo.height === height) return { changed: false, maximum, actual: windowInfo };
  if (!await canApply()) throw new Error("SmartWindowSize is disabled.");
  await chrome.windows.update(windowId, { width, height });
  const actual = await chrome.windows.get(windowId);
  return { changed: true, maximum, actual, exact: actual.width === width && actual.height === height };
}


/**
 * Returns the current window to the visible work area with the smallest necessary correction.
 *
 * @param {number} windowId Browser window identifier selected by the user.
 * @param {Function} canApply Last-moment global-enabled check.
 * @returns {Promise<{changed: boolean, verified: boolean, size: {width: number, height: number}, position: {x: number, y: number}, before: object, requested: object, actual: object, display: object|null}>} Applied and verified result.
 */
export async function bringWindowOnScreen(windowId, canApply = async () => true) {
  const current = await chrome.windows.get(windowId);
  if (current.state !== "normal") throw new Error("Restore the window before bringing it on screen.");
  const display = await displayForRule(null, current);
  const bounds = display ? constrainWindowBounds(current, { width: current.width, height: current.height }, null, display) : {
    width: current.width, height: current.height,
    left: Math.max(0, Math.round((1920 - current.width) / 2)),
    top: Math.max(0, Math.round((1080 - current.height) / 2))
  };
  const changed = current.width !== bounds.width || current.height !== bounds.height || current.left !== bounds.left || current.top !== bounds.top;
  if (changed) {
    if (!await canApply()) throw new Error("SmartWindowSize is disabled.");
    await chrome.windows.update(windowId, windowUpdateInfo(bounds));
  }
  const actual = changed ? await chrome.windows.get(windowId) : current;
  return {
    changed,
    verified: isWindowOnDisplay(actual, display),
    size: { width: actual.width, height: actual.height },
    position: { x: actual.left, y: actual.top },
    before: { width: current.width, height: current.height, left: current.left, top: current.top },
    requested: windowUpdateInfo(bounds),
    actual: { width: actual.width, height: actual.height, left: actual.left, top: actual.top },
    display: display ? { id: display.id, workArea: display.workArea ?? display.bounds } : null
  };
}


/**
 * Resizes a window only when its current bounds differ from the resolved rule.
 * @param {number} windowId Browser window identifier.
 * @param {{status: string, rule?: object, size?: {width: number, height: number}}} resolved Rule resolution result.
 * @param {Function} canApply Last-moment source-tab and configuration check.
 * @returns {Promise<{changed: boolean, sizeAdjusted: boolean, size: {width: number, height: number}}>} Applied result.
 */
export async function applyResolvedRule(windowId, resolved, canApply = async () => true) {
  if (resolved.status === "DISABLED") return { changed: false };
  const rule = resolved.rule;
  const current = await chrome.windows.get(windowId);
  if (current.state !== "normal") return { changed: false };
  const desired = rule ? { width: rule.width, height: rule.height } : resolved.size ?? { width: current.width, height: current.height };
  const display = await displayForRule(rule, current);
  const bounds = constrainWindowBounds(current, desired, rule, display);
  if (!await canApply()) return { changed: false, skipped: "source-changed" };
  if (current.width === bounds.width && current.height === bounds.height && current.left === bounds.left && current.top === bounds.top) {
    return { changed: false, sizeAdjusted: bounds.sizeAdjusted, size: { width: bounds.width, height: bounds.height } };
  }
  await chrome.windows.update(windowId, windowUpdateInfo(bounds));
  const actual = await chrome.windows.get(windowId);
  if (display && !isWindowOnDisplay(actual, display)) throw new Error("The browser did not apply bounds inside the selected display.");
  if (actual.width !== bounds.width || actual.height !== bounds.height) throw new Error("The browser did not apply the requested rule dimensions.");
  return { changed: true, sizeAdjusted: bounds.sizeAdjusted, size: { width: actual.width, height: actual.height }, actual };
}


/** Computes a finite, wrapping cascade inside one work area. @param {object} bounds Corrected window bounds. @param {object} display Target display. @param {number} index Cascade slot. @returns {{left: number, top: number}} Safe position. */
export function safeCascadePosition(bounds, display, index) {
  const area = display?.workArea ?? display?.bounds;
  if (!area) return { left: bounds.left, top: bounds.top };
  const horizontalRoom = Math.max(0, area.width - bounds.width);
  const verticalRoom = Math.max(0, area.height - bounds.height);
  const slots = Math.max(1, Math.floor(Math.max(horizontalRoom, verticalRoom) / 32) + 1);
  const offset = (index % slots) * 32;
  return { left: area.left + Math.min(offset, horizontalRoom), top: area.top + Math.min(offset, verticalRoom) };
}
