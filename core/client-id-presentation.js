/**
 * Formats client attribution for human-readable surfaces without changing any
 * persisted client identifier or synchronized metadata.
 */

/**
 * Formats one modifying client identifier using the caller's chosen full or
 * compact representation, and marks it only when it identifies this install.
 *
 * @param {string|null|undefined} modifiedByClientId Stored modifying client ID.
 * @param {string|null|undefined} localClientId This installation's client ID.
 * @param {(clientId: string) => string} [format] Caller-selected ID formatter.
 * @returns {string} Readable modifier attribution with an optional local marker.
 */
export function formatClientIdForDisplay(modifiedByClientId, localClientId, format = (clientId) => clientId) {
  if (typeof modifiedByClientId !== "string" || !modifiedByClientId) return "—";
  const displayed = format(modifiedByClientId);
  return modifiedByClientId === localClientId ? `${displayed} (local)` : displayed;
}
