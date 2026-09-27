/**
 * Compares browser-window bounds used to distinguish initialization from later user changes.
 * The service worker uses this pure helper before persisting a resize-derived rule.
 */


/** Checks whether any tracked outer-window bound differs between two snapshots. @param {{width?: number, height?: number, left?: number, top?: number}|undefined} previous Earlier observed bounds. @param {{width?: number, height?: number, left?: number, top?: number}} current New browser-reported bounds. @returns {boolean} Whether the browser window changed after its baseline was established. */
export function windowBoundsChanged(previous, current) {
  return previous !== undefined && (previous.width !== current.width || previous.height !== current.height || previous.left !== current.left || previous.top !== current.top);
}
