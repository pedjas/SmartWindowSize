/**
 * Stores and reconciles compact per-rule records in browser-native storage.sync.
 * Cloud records contain semantic behavior and seed dimensions only; callers
 * preserve every local geometry and enabled field when applying a definition.
 */
import { canonicalMatchKey, cloudRuleDefinition } from "./rule-sync.js";

/** Prefix for one independent cloud record per deterministic sync identity. @type {string} */
const SYNC_KEY_PREFIX = "smartWindowSize.sync.rule.";

/** Returns the storage.sync key for a deterministic sync rule ID. @param {string} syncRuleId Rule identity. @returns {string} Cloud storage key. */
export function cloudRuleKey(syncRuleId) { return `${SYNC_KEY_PREFIX}${syncRuleId}`; }


/** Reads and validates the compact cloud record for one rule. @param {string} syncRuleId Rule identity. @returns {Promise<object|null>} Valid cloud record or null when absent/malformed. */
export async function readCloudRule(syncRuleId) {
  const key = cloudRuleKey(syncRuleId);
  const value = (await chrome.storage.sync.get(key))[key];
  if (!value || typeof value !== "object" || !validStatus(value.status)) return null;
  if (value.status.deleted) return value;
  return validDefinition(value.definition) ? value : null;
}

/** Reads valid SmartWindowSize records currently visible in storage.sync. @returns {Promise<{records: Map<string, object>, counts: object}>} Records and visibility counts. */
export async function readVisibleCloudRules() {
  const values = await chrome.storage.sync.get(null);
  const records = new Map();
  const counts = { active: 0, status: 0, tombstones: 0, malformed: 0 };
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(SYNC_KEY_PREFIX)) continue;
    const id = key.slice(SYNC_KEY_PREFIX.length);
    if (!/^[0-9a-f]{32}$/.test(id) || !value || typeof value !== "object" || !validStatus(value.status) || (!value.status.deleted && !validDefinition(value.definition))) { counts.malformed++; continue; }
    records.set(id, value); counts.status++;
    if (value.status.deleted) counts.tombstones++; else counts.active++;
  }
  return { records, counts };
}


/** Checks revision metadata shared by active records and tombstones. @param {unknown} status Candidate record status. @returns {boolean} Whether the status is safe to reconcile. */
function validStatus(status) {
  return status && typeof status === "object" && Number.isInteger(status.revision) && status.revision > 0 && typeof status.deleted === "boolean" &&
    (status.modifiedAt === null || (typeof status.modifiedAt === "string" && !Number.isNaN(Date.parse(status.modifiedAt)))) &&
    (status.modifiedByClientId === null || typeof status.modifiedByClientId === "string") &&
    (status.origin === undefined || status.origin === "legacy" || status.origin === "user");
}


/** Checks the compact active definition without accepting a sync-only URL interpretation. @param {unknown} definition Candidate cloud definition. @returns {boolean} Whether it uses matcher-canonical scope data. */
function validDefinition(definition) {
  return definition && typeof definition === "object" && canonicalMatchKey(definition.scope) !== null &&
    typeof definition.rememberPosition === "boolean" && typeof definition.rememberMonitor === "boolean" &&
    Number.isInteger(definition.seedWidth) && definition.seedWidth > 0 && Number.isInteger(definition.seedHeight) && definition.seedHeight > 0;
}


/** Writes one cloud record without rewriting unrelated synchronized rules. @param {string} syncRuleId Rule identity. @param {object} record Valid cloud record. @returns {Promise<void>} Completion. */
export async function writeCloudRule(syncRuleId, record) {
  await chrome.storage.sync.set({ [cloudRuleKey(syncRuleId)]: record });
}


/** Builds the active cloud representation of a local sync-aware rule. @param {object} rule Local rule. @returns {object} Cloud record. */
export function activeCloudRecord(rule) {
  return { status: { revision: rule.sync.revision, modifiedAt: rule.sync.modifiedAt, modifiedByClientId: rule.sync.modifiedByClientId, origin: rule.sync.origin === "legacy" ? "legacy" : "user", deleted: false }, definition: cloudRuleDefinition(rule) };
}


/** Builds a tombstone record whose active semantic definition is deliberately absent. @param {object} tombstone Local delete metadata. @returns {object} Compact cloud tombstone. */
export function deletedCloudRecord(tombstone) {
  return { status: { revision: tombstone.revision, modifiedAt: tombstone.modifiedAt, modifiedByClientId: tombstone.modifiedByClientId, deleted: true } };
}


/** Compares semantic cloud definitions without considering seed dimensions. @param {object} left Cloud definition. @param {object} right Cloud definition. @returns {boolean} Whether the semantic behavior is equivalent. */
export function sameSemanticDefinition(left, right) {
  return left?.scope?.type === right?.scope?.type && left?.scope?.value === right?.scope?.value &&
    Boolean(left?.rememberPosition) === Boolean(right?.rememberPosition) && Boolean(left?.rememberMonitor) === Boolean(right?.rememberMonitor);
}


/** Explicit outcomes for arbitration of two states with the same deterministic sync identity. @readonly @enum {string} */
export const SYNC_STATE_ORDER = Object.freeze({ LOCAL_WINS: "local-wins", CLOUD_WINS: "cloud-wins", EQUIVALENT: "equivalent", CONFLICT: "conflict" });


/**
 * Compares the semantic status of two records for one deterministic sync identity.
 * Revision is always the primary order. A timestamp is considered only for an
 * equal-revision disagreement made by two identified, different clients.
 *
 * @param {object} local Local active or tombstone cloud-shaped record.
 * @param {object} cloud Cloud active or tombstone record.
 * @returns {string} One SYNC_STATE_ORDER value.
 */
export function compareSyncStates(local, cloud) {
  const localStatus = local.status;
  const cloudStatus = cloud.status;
  if (localStatus.revision > cloudStatus.revision) return SYNC_STATE_ORDER.LOCAL_WINS;
  if (cloudStatus.revision > localStatus.revision) return SYNC_STATE_ORDER.CLOUD_WINS;
  const bothDeleted = localStatus.deleted && cloudStatus.deleted;
  const bothEquivalentActive = !localStatus.deleted && !cloudStatus.deleted && sameSemanticDefinition(local.definition, cloud.definition);
  if (bothDeleted || bothEquivalentActive) return SYNC_STATE_ORDER.EQUIVALENT;
  if (typeof localStatus.modifiedByClientId !== "string" || typeof cloudStatus.modifiedByClientId !== "string" || localStatus.modifiedByClientId === cloudStatus.modifiedByClientId) return SYNC_STATE_ORDER.CONFLICT;
  const localTimestamp = Date.parse(localStatus.modifiedAt ?? "");
  const cloudTimestamp = Date.parse(cloudStatus.modifiedAt ?? "");
  if (Number.isNaN(localTimestamp) || Number.isNaN(cloudTimestamp) || localTimestamp === cloudTimestamp) return SYNC_STATE_ORDER.CONFLICT;
  return localTimestamp > cloudTimestamp ? SYNC_STATE_ORDER.LOCAL_WINS : SYNC_STATE_ORDER.CLOUD_WINS;
}


/** Applies a cloud definition while retaining all machine-local behavior. @param {object} local Existing local rule. @param {object} cloud Cloud record. @returns {object} Updated local rule. */
export function applyCloudDefinition(local, cloud) {
  const definition = cloud.definition;
  return {
    ...local,
    scope: structuredClone(definition.scope),
    position: definition.rememberPosition ? local.position : { enabled: false, x: null, y: null },
    display: definition.rememberMonitor ? local.display : { enabled: false, id: null },
    sync: { ...local.sync, revision: cloud.status.revision, modifiedAt: cloud.status.modifiedAt, modifiedByClientId: cloud.status.modifiedByClientId, conflict: null }
  };
}
