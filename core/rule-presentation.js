/** Returns the available local monitor identifier without fabricating display metadata. @param {object} rule Saved rule. @returns {string|null} Stored display ID or null. */
export function rememberedMonitorLabel(rule) {
  return rule?.display?.enabled && typeof rule.display.id === "string" && rule.display.id ? rule.display.id : null;
}
