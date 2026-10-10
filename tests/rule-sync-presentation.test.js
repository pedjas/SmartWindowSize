/** Verifies shared user-facing Rules Sync status interpretation without changing sync behavior. */
import test from "node:test";
import assert from "node:assert/strict";
import { formatRuleSyncStatus, RULE_SYNC_STATUS, ruleSyncStatus } from "../core/rule-presentation.js";


function rule(sync) {
  return { id: "rule", sync };
}


const synchronized = { id: "a".repeat(32), revision: 4, modifiedAt: "2026-10-09T12:00:00.000Z", modifiedByClientId: "client-a", origin: "user", conflict: null };


test("Rules Sync disabled is distinct from synchronized local metadata", () => {
  const status = ruleSyncStatus(rule(synchronized), false);
  assert.deepEqual(status, { state: RULE_SYNC_STATUS.DISABLED, revision: 4, label: "Sync disabled" });
  assert.equal(formatRuleSyncStatus(status), "Sync disabled");
});


test("a synchronized rule retains its revision regardless of local lineage", () => {
  for (const origin of ["user", "sync", "legacy"]) {
    const status = ruleSyncStatus(rule({ ...synchronized, origin }), true);
    assert.equal(status.state, RULE_SYNC_STATUS.SYNCED);
    assert.equal(status.revision, 4);
    assert.equal(formatRuleSyncStatus(status), "Synced · rev. 4");
  }
});


test("missing or partial local metadata is presented as not synced yet", () => {
  for (const sync of [undefined, {}, { id: "a".repeat(32) }, { revision: 2 }]) {
    const status = ruleSyncStatus(rule(sync), true);
    assert.deepEqual(status, { state: RULE_SYNC_STATUS.NOT_SYNCED, revision: null, label: "Not synced yet" });
    assert.equal(formatRuleSyncStatus(status), "Not synced yet");
  }
});


test("an existing conflict remains a conflict without recreating conflict semantics", () => {
  const status = ruleSyncStatus(rule({ ...synchronized, conflict: { kind: "equal-revision-definition-conflict" } }), true);
  assert.deepEqual(status, { state: RULE_SYNC_STATUS.CONFLICT, revision: 4, label: "Conflict" });
  assert.equal(formatRuleSyncStatus(status), "Conflict");
});
