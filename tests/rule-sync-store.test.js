/** Tests granular native-sync records without depending on a logged-in browser. */
import test from "node:test";
import assert from "node:assert/strict";

const cloud = {};
globalThis.chrome = { storage: { sync: {
  async get(key) { return { [key]: structuredClone(cloud[key]) }; },
  async set(values) { Object.assign(cloud, structuredClone(values)); }
} } };

const { activeCloudRecord, applyCloudDefinition, readCloudRule, writeCloudRule } = await import("../core/rule-sync-store.js");

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
