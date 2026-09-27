/**
 * Defines the shared SmartWindowSize window-dimension presets.
 * The Options page and manual size selector import this module so both interfaces offer identical choices.
 */


/**
 * A named horizontal window-size preset.
 *
 * @typedef {object} WindowPreset
 * @property {string} label User-facing display name and aspect ratio.
 * @property {number} width Horizontal outer-window width in pixels.
 * @property {number} height Horizontal outer-window height in pixels.
 */


/** Ordered standard horizontal window-size presets. @type {ReadonlyArray<WindowPreset>} */
export const WINDOW_PRESETS = Object.freeze([
  { label: "Default · 5:4", width: 1200, height: 960 },
  { label: "SVGA · 4:3", width: 800, height: 600 },
  { label: "XGA · 4:3", width: 1024, height: 768 },
  { label: "HD · 16:9", width: 1280, height: 720 },
  { label: "WXGA · 16:10", width: 1280, height: 800 },
  { label: "WXGA · 16:9", width: 1366, height: 768 },
  { label: "WXGA+ · 16:10", width: 1440, height: 900 },
  { label: "16:9", width: 1536, height: 864 },
  { label: "HD+ · 16:9", width: 1600, height: 900 },
  { label: "Full HD · 16:9", width: 1920, height: 1080 },
  { label: "QHD · 16:9", width: 2560, height: 1440 },
  { label: "4K UHD · 16:9", width: 3840, height: 2160 }
]);


/**
 * Returns a preset in the requested display orientation.
 *
 * @param {WindowPreset} preset Canonical horizontal preset.
 * @param {boolean} vertical Whether to rotate the preset.
 * @returns {{width: number, height: number}} Dimensions in pixels.
 */
export function orientedPresetSize(preset, vertical) {
  return vertical ? { width: preset.height, height: preset.width } : { width: preset.width, height: preset.height };
}


/**
 * Finds the matching horizontal preset index for saved global dimensions.
 *
 * @param {number} width Candidate outer-window width in pixels.
 * @param {number} height Candidate outer-window height in pixels.
 * @returns {number} Preset index, or -1 when custom dimensions are required.
 */
export function findHorizontalPresetIndex(width, height) {
  return WINDOW_PRESETS.findIndex((preset) => preset.width === width && preset.height === height);
}
