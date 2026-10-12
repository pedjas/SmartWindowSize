import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

const source = new URL("../", import.meta.url);

test("the internal viewer loads the renamed bundled user manual", async () => {
  const viewer = await readFile(new URL("readme-viewer/readme.js", source), "utf8");

  assert.match(viewer, /chrome\.runtime\.getURL\("user-manual\.txt"\)/);
  assert.doesNotMatch(viewer, /getURL\("readme\.txt"\)/);
  await access(new URL("user-manual.txt", source), constants.R_OK);
  await assert.rejects(access(new URL("readme.txt", source), constants.F_OK));
});

test("packaging includes the renamed user manual and not the retired filename", async () => {
  const packaging = await readFile(new URL("tools/package-extension.ps1", source), "utf8");

  assert.match(packaging, /'user-manual\.txt'/);
  assert.doesNotMatch(packaging, /'readme\.txt'/);
});
