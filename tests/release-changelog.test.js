/** Verifies the marker-based release changelog parser and post-success finalization module. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const modulePath = fileURLToPath(new URL("../tools/release-changelog.psm1", import.meta.url));


/** Quotes one local path for the PowerShell command line used by the real parser module. @param {string} value Local path. @returns {string} PowerShell single-quoted literal. */
function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}


/** Runs the actual PowerShell parser module and returns its standard output. @param {string} command Module invocation. @returns {Promise<string>} Captured output. */
async function runPowerShell(command) {
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `$ErrorActionPreference = 'Stop'; Import-Module ${psLiteral(modulePath)} -Force; ${command}`]);
  return result.stdout;
}


/** Creates an isolated temporary changelog fixture and removes it after its assertion. @param {string} content Fixture changelog content. @param {(path: string) => Promise<void>} assertion Test body. @returns {Promise<void>} Completion after cleanup. */
async function withChangelog(content, assertion) {
  const directory = await mkdtemp(join(tmpdir(), "smart-window-size-release-changelog-"));
  const path = join(directory, "CHANGELOG.md");
  try {
    await writeFile(path, content, "utf8");
    await assertion(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}


test("release script captures milestone sections before publication and moves only the marker after draft creation", async () => {
  const source = await readFile(new URL("../tools/release.ps1", import.meta.url), "utf8");
  const draftCreation = source.indexOf("Creating GitHub Draft Release");
  const finalization = source.indexOf("Move-ReleasedMarker");
  assert.ok(draftCreation >= 0 && finalization > draftCreation);
  assert.match(source, /UnreleasedMilestones\.UnreleasedText/);
  assert.match(source, /Get-UnreleasedMilestoneSections/);
  assert.doesNotMatch(source, /Arguments @\('commit'/);
});


test("commit milestone closes only the pending top block at the current version", async () => {
  const content = "# CHANGELOG\n\n- Added A.\n- Fixed B.\n\n## 1.0.23 - 2026-10-01\n- Earlier milestone.\n\n# Released\n\n## 1.0.0 - 2026-01-01\n- Old note.\n";
  await withChangelog(content, async (path) => {
    await runPowerShell(`$entries = Get-PendingChangelogEntries -ChangelogPath ${psLiteral(path)}; Write-CommitMilestoneChangelog -ChangelogPath ${psLiteral(path)} -PendingEntries $entries -Version '1.0.32' -CommitDate '2026-10-02'`);
    const updated = await readFile(path, "utf8");
    assert.match(updated, /^# CHANGELOG\r\n\r\n## 1\.0\.32 - 2026-10-02\r\n\r\n- Added A\.\r\n- Fixed B\./);
    assert.match(updated, /## 1\.0\.23 - 2026-10-01[\s\S]*# Released/);
    assert.doesNotMatch(updated, /## 1\.0\.24|## 1\.0\.31/);
  });
});


test("changelog parser requires one marker and forbids an Unreleased heading", async () => {
  const cases = [
    ["# CHANGELOG\n\n## 1.1.0 - 2026-10-02\n- Final.\n", /exactly one # Released marker/],
    ["# CHANGELOG\n\n## Unreleased\n\n# Released\n", /must not contain ## Unreleased/],
    ["# CHANGELOG\n\n# Released\n\n# Released\n", /exactly one # Released marker/]
  ];
  for (const [content, expected] of cases) {
    await withChangelog(content, async (path) => {
      await assert.rejects(runPowerShell(`Get-PendingChangelogEntries -ChangelogPath ${psLiteral(path)} | Out-Null`), expected);
    });
  }
});


test("official release captures all non-consecutive unreleased milestones and excludes history", async () => {
  const content = "# CHANGELOG\n\n## 1.1.0 - 2026-10-02\n- Final.\n\n## 1.0.69 - 2026-10-02\n- Centralized.\n\n## 1.0.68 - 2026-10-01\n- Fixed.\n\n# Released\n\n## 1.0.53 - 2026-10-01\n- Released.\n";
  await withChangelog(content, async (path) => {
    const output = await runPowerShell(`$state = Get-UnreleasedMilestoneSections -ChangelogPath ${psLiteral(path)} -Version '1.1.0'; [Console]::Write($state.UnreleasedText)`);
    assert.equal(output, "## 1.1.0 - 2026-10-02\r\n- Final.\r\n\r\n## 1.0.69 - 2026-10-02\r\n- Centralized.\r\n\r\n## 1.0.68 - 2026-10-01\r\n- Fixed.");
    assert.doesNotMatch(output, /1\.0\.53/);
  });
});


test("release rejects pending bullets and marker movement preserves milestone blocks", async () => {
  const pending = "# CHANGELOG\n\n- Not committed.\n\n## 1.1.0 - 2026-10-02\n- Final.\n\n# Released\n\n## 1.0.52 - 2026-10-01\n- Old.\n";
  await withChangelog(pending, async (path) => {
    await assert.rejects(runPowerShell(`Get-UnreleasedMilestoneSections -ChangelogPath ${psLiteral(path)} -Version '1.1.0' | Out-Null`), /pending changes that have not yet been assigned/);
  });
  const content = "# CHANGELOG\n\n## 1.1.0 - 2026-10-02\n- Final.\n\n## 1.0.32 - 2026-10-02\n- Prior.\n\n# Released\n\n## 1.0.23 - 2026-10-01\n- Old.\n";
  await withChangelog(content, async (path) => {
    await runPowerShell(`$state = Get-UnreleasedMilestoneSections -ChangelogPath ${psLiteral(path)} -Version '1.1.0'; Move-ReleasedMarker -ChangelogPath ${psLiteral(path)} -UnreleasedMilestones $state`);
    assert.equal(await readFile(path, "utf8"), "# CHANGELOG\r\n\r\n# Released\r\n\r\n## 1.1.0 - 2026-10-02\r\n- Final.\r\n\r\n## 1.0.32 - 2026-10-02\r\n- Prior.\r\n\r\n## 1.0.23 - 2026-10-01\r\n- Old.\r\n");
  });
});
