/** Tests granular native-sync records without depending on a logged-in browser. */
import test from "node:test";
import assert from "node:assert/strict";

const cloud = {};
globalThis.chrome = { storage: { sync: {
  async get(key) { return { [key]: structuredClone(cloud[key]) }; },
  async set(values) { Object.assign(cloud, structuredClone(values)); }
} } };

const { activeCloudRecord, applyCloudDefinition, compareSyncStates, localRuleFromCloudRecord, localTombstoneFromCloudStatus, readCloudRule, SYNC_STATE_ORDER, writeCloudRule } = await import("../core/rule-sync-store.js");

/** Builds one minimal active or deleted state for comparator cases. @param {object} overrides State changes. @returns {object} Cloud-shaped state. */
function syncState(overrides = {}) {
  const status = { revision: 5, modifiedAt: "2026-10-09T10:00:00.000Z", modifiedByClientId: "client-a", deleted: false, ...(overrides.status ?? {}) };
  return { status, ...(status.deleted ? {} : { definition: { scope: { type: "domain_tree", value: "example.com" }, rememberPosition: false, rememberMonitor: false, seedWidth: 800, seedHeight: 600, ...(overrides.definition ?? {}) } }) };
}

test("central sync-state arbitration is revision-first and limits timestamps to different-client equal-revision collisions", () => {
  const local = syncState();
  const cases = [
    ["higher local revision", syncState({ status: { revision: 6 } }), syncState(), SYNC_STATE_ORDER.LOCAL_WINS],
    ["higher cloud revision", local, syncState({ status: { revision: 6 } }), SYNC_STATE_ORDER.CLOUD_WINS],
    ["equal active semantic state", local, syncState({ status: { modifiedAt: "2026-10-09T11:00:00.000Z", modifiedByClientId: "client-b" } }), SYNC_STATE_ORDER.EQUIVALENT],
    ["equal tombstones", syncState({ status: { deleted: true } }), syncState({ status: { deleted: true, modifiedByClientId: "client-b" } }), SYNC_STATE_ORDER.EQUIVALENT],
    ["different active definitions with newer cloud client", local, syncState({ status: { modifiedAt: "2026-10-09T11:00:00.000Z", modifiedByClientId: "client-b" }, definition: { rememberPosition: true } }), SYNC_STATE_ORDER.CLOUD_WINS],
    ["different active definitions with newer local client", syncState({ status: { modifiedAt: "2026-10-09T11:00:00.000Z" } }), syncState({ status: { modifiedByClientId: "client-b" }, definition: { rememberPosition: true } }), SYNC_STATE_ORDER.LOCAL_WINS],
    ["active versus tombstone with newer cloud client", local, syncState({ status: { deleted: true, modifiedAt: "2026-10-09T11:00:00.000Z", modifiedByClientId: "client-b" } }), SYNC_STATE_ORDER.CLOUD_WINS],
    ["tombstone versus active with newer local client", syncState({ status: { deleted: true, modifiedAt: "2026-10-09T11:00:00.000Z" } }), syncState({ status: { modifiedByClientId: "client-b" } }), SYNC_STATE_ORDER.LOCAL_WINS],
    ["same-client disagreement", local, syncState({ status: { deleted: true, modifiedAt: "2026-10-09T11:00:00.000Z" } }), SYNC_STATE_ORDER.CONFLICT],
    ["equal timestamps", local, syncState({ status: { deleted: true, modifiedByClientId: "client-b" } }), SYNC_STATE_ORDER.CONFLICT],
    ["missing timestamp", syncState({ status: { modifiedAt: null } }), syncState({ status: { deleted: true, modifiedByClientId: "client-b" } }), SYNC_STATE_ORDER.CONFLICT],
    ["invalid timestamp", syncState({ status: { modifiedAt: "not-a-date" } }), syncState({ status: { deleted: true, modifiedByClientId: "client-b" } }), SYNC_STATE_ORDER.CONFLICT]
  ];
  for (const [name, left, right, expected] of cases) assert.equal(compareSyncStates(left, right), expected, name);
});

test("cloud records retain semantic behavior and seed dimensions only", async () => {
  const local = { id: "local", scope: { type: "domain_tree", value: "example.com" }, enabled: false, width: 900, height: 700,
    position: { enabled: true, x: 10, y: 20 }, display: { enabled: true, id: "display-a" }, sync: { id: "abc", revision: 2, modifiedAt: "2026-10-01T10:00:00.000Z", modifiedByClientId: "client-a", origin: "user", conflict: null } };
  const record = activeCloudRecord(local);
  await writeCloudRule("abc", record);
  assert.deepEqual(await readCloudRule("abc"), record);
  const remote = { ...record, status: { ...record.status, revision: 3, modifiedByClientId: "client-b" }, definition: { ...record.definition, rememberPosition: false, seedWidth: 1200 } };
  const applied = applyCloudDefinition(local, remote);
  assert.equal(applied.enabled, false);
  assert.equal(applied.width, 900);
  assert.equal(applied.position.enabled, false);
  assert.equal(applied.display.id, "display-a");
});

test("received-from-sync lineage remains local while later cloud revisions preserve it", () => {
  const imported = { id: "local", scope: { type: "domain_tree", value: "example.com" }, enabled: false, width: 800, height: 600,
    position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null }, sync: { id: "abc", revision: 1, modifiedAt: "2026-10-01T10:00:00.000Z", modifiedByClientId: "client-a", origin: "sync", conflict: null } };
  const record = activeCloudRecord(imported);
  assert.equal(record.status.origin, "user");
  const applied = applyCloudDefinition(imported, { ...record, status: { ...record.status, revision: 2, modifiedByClientId: "client-b" } });
  assert.equal(applied.sync.origin, "sync");
  assert.equal(applied.sync.modifiedByClientId, "client-b");
  assert.equal(applied.width, 800);
});

test("cloud projections create only the intended local active rule and deletion index fields", () => {
  const cloud = syncState({ status: { revision: 7, modifiedAt: "2026-10-09T12:00:00.000Z", modifiedByClientId: "client-a" }, definition: { rememberPosition: true, rememberMonitor: true, seedWidth: 1234, seedHeight: 876 } });
  const local = localRuleFromCloudRecord("a".repeat(32), cloud, "local-rule", "2026-10-09T12:01:00.000Z");
  assert.deepEqual(local, {
    id: "local-rule", scope: { type: "domain_tree", value: "example.com" }, enabled: true, width: 1234, height: 876,
    position: { enabled: false, x: null, y: null }, display: { enabled: false, id: null }, lastUpdatedAt: "2026-10-09T12:01:00.000Z",
    sync: { id: "a".repeat(32), revision: 7, modifiedAt: "2026-10-09T12:00:00.000Z", modifiedByClientId: "client-a", origin: "sync", conflict: null }
  });
  const deleted = localTombstoneFromCloudStatus("a".repeat(32), { revision: 8, modifiedAt: "2026-10-09T12:02:00.000Z", modifiedByClientId: "client-b", deleted: true });
  assert.deepEqual(deleted, { id: "a".repeat(32), revision: 8, modifiedAt: "2026-10-09T12:02:00.000Z", modifiedByClientId: "client-b", deleted: true });
});
