/** Returns the available local monitor identifier without fabricating display metadata. @param {object} rule Saved rule. @returns {string|null} Stored display ID or null. */
export function rememberedMonitorLabel(rule) {
  return rule?.display?.enabled && typeof rule.display.id === "string" && rule.display.id ? rule.display.id : null;
}


/** Returns the stable user-facing label for this installation's rule lineage. @param {string|undefined} origin Stored local lineage marker. @returns {string} Readable lineage label. */
export function originLabel(origin) {
  if (origin === "legacy") return "Migrated from previous version";
  if (origin === "sync") return "Received from sync";
  return "Created locally";
}


/** Stable user-facing Rules Sync states derived from existing local sync metadata. */
export const RULE_SYNC_STATUS = Object.freeze({ DISABLED: "disabled", NOT_SYNCED: "not-synced", SYNCED: "synced", CONFLICT: "conflict" });


/**
 * Classifies a rule's user-facing Rules Sync status without interpreting
 * lineage, modifier attribution, cloud state, or reconciliation behavior.
 * @param {object|null|undefined} rule Local rule whose sync metadata is displayed.
 * @param {boolean} syncEnabled Whether Rules Sync is enabled globally.
 * @returns {{state: string, revision: number|null, label: string}} Shared presentation model.
 */
export function ruleSyncStatus(rule, syncEnabled) {
  const sync = rule?.sync;
  const revision = Number.isInteger(sync?.revision) && sync.revision > 0 ? sync.revision : null;
  if (sync?.conflict) return { state: RULE_SYNC_STATUS.CONFLICT, revision, label: "Conflict" };
  if (!syncEnabled) return { state: RULE_SYNC_STATUS.DISABLED, revision, label: "Sync disabled" };
  if (typeof sync?.id !== "string" || !sync.id || revision === null) return { state: RULE_SYNC_STATUS.NOT_SYNCED, revision: null, label: "Not synced yet" };
  return { state: RULE_SYNC_STATUS.SYNCED, revision, label: "Synced" };
}


/** Formats a shared Rules Sync status while keeping screen layout independent. @param {{state: string, revision: number|null, label: string}} status Shared status model. @returns {string} Concise user-facing status. */
export function formatRuleSyncStatus(status) {
  return status.state === RULE_SYNC_STATUS.SYNCED ? `${status.label} · rev. ${status.revision}` : status.label;
}
