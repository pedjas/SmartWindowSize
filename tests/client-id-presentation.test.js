/** Tests human-readable Rules Sync client attribution without touching stored IDs. */
import test from "node:test";
import assert from "node:assert/strict";
import { formatClientIdForDisplay } from "../core/client-id-presentation.js";

test("client attribution marks only this installation while preserving the selected ID presentation", () => {
  const localClientId = "a8f21493-1111-2222-3333-0000000093ac";
  const remoteClientId = "c71380b1-4444-5555-6666-00000000128e";
  assert.equal(formatClientIdForDisplay(localClientId, localClientId), `${localClientId} (local)`);
  assert.equal(formatClientIdForDisplay(remoteClientId, localClientId), remoteClientId);
  assert.equal(formatClientIdForDisplay(null, localClientId), "—");
  assert.equal(formatClientIdForDisplay("", localClientId), "—");
  assert.equal(formatClientIdForDisplay(localClientId, localClientId, (value) => `${value.slice(0, 8)}…${value.slice(-4)}`), "a8f21493…93ac (local)");
  assert.equal(formatClientIdForDisplay(remoteClientId, localClientId, (value) => `${value.slice(0, 8)}…${value.slice(-4)}`), "c71380b1…128e");
});
