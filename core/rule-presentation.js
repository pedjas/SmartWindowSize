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
