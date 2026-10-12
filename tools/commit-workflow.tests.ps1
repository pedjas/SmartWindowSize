<# Focused non-mutating checks for the coordinated commit entry point. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Get-Content (Join-Path $PSScriptRoot 'commit.ps1') -Raw
foreach ($required in @('commit-milestone.ps1', 'Assert-VersionConsistency', 'Get-PendingChangelogEntries', '$WhatIfPreference', 'Nothing pushed', 'diff','--diff-filter=U')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "Missing coordinated commit safeguard: $required" }
}
if ($source -notmatch "Checking source staged files" -or $source -notmatch "Checking documentation staged files" -or $source -notmatch 'Get-CommitRepositoryPaths' -or $source -notmatch '\$docsPaths' -or $source -notmatch 'Get-CompletedCommitNames') { throw 'Dry-run and real commit planning must validate both indexes, use one parsed path collection for each repository, and report an empty completed list safely.' }
$milestone = Get-Content (Join-Path $PSScriptRoot 'commit-milestone.ps1') -Raw
if ($milestone -notmatch 'IsNullOrWhiteSpace\(\(\$stagedPaths -join') { throw 'Milestone helper must distinguish empty Git output from a staged path.' }
foreach ($forbidden in @("'push'", "'tag'", "'rebase'", "'merge'", "'reset'")) {
    if ($source -match [regex]::Escape($forbidden)) { throw "Commit workflow contains prohibited Git operation: $forbidden" }
}
$batch = Get-Content (Join-Path $PSScriptRoot 'commit.bat') -Raw
if ($batch -notmatch '%~dp0commit\.ps1') { throw 'Commit batch entry point must use its own directory.' }
foreach ($launcher in @('commit-dry-run.bat', 'push-dry-run.bat')) {
    $contents = Get-Content (Join-Path $PSScriptRoot $launcher) -Raw
    if ($contents -notmatch '-WhatIf' -or $contents -notmatch '%~dp0') { throw "$launcher must be an Explorer-safe WhatIf launcher." }
}
$WhatIfPreference = $true
Import-Module (Join-Path $PSScriptRoot 'git-workflow.psm1') -Force
$pathFixture = "MANUAL-TESTS.md`r`nSMOKE-TESTS.md`r`nSPECIFICATION.md`r`nSMART-WINDOW-SIZE-HANDOFF-2026-10-10.md"
$parsedPaths = @(ConvertFrom-SharedGitPathOutput $pathFixture)
$invalidPaths = @($parsedPaths | Where-Object { $_ -match "[\r\n]" -or [IO.Path]::IsPathRooted($_) })
if ($parsedPaths.Count -ne 4 -or $invalidPaths.Count -ne 0) { throw 'Shared Git path conversion must return one safe relative string per path.' }
$trackedDeletionRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SmartWindowSize-commit-tracked-path-$([guid]::NewGuid().ToString('N'))"
$previousWhatIfPreference = $WhatIfPreference
try {
    $WhatIfPreference = $false
    New-Item -ItemType Directory -Path $trackedDeletionRoot | Out-Null
    & git -C $trackedDeletionRoot init -q
    & git -C $trackedDeletionRoot config user.email commit-test@example.invalid
    & git -C $trackedDeletionRoot config user.name 'Commit Test'
    [IO.File]::WriteAllText((Join-Path $trackedDeletionRoot 'retired.txt'), 'retired')
    & git -C $trackedDeletionRoot add -- retired.txt
    & git -C $trackedDeletionRoot commit -qm base
    Remove-Item -LiteralPath (Join-Path $trackedDeletionRoot 'retired.txt')
    if (-not (Test-SharedRepositoryGitTrackedPath -GitPath (Get-Command git).Source -RepositoryPath $trackedDeletionRoot -RelativePath 'retired.txt')) { throw 'Shared Git workflow must recognize a tracked deletion.' }
}
finally {
    if (Test-Path -LiteralPath $trackedDeletionRoot) { Remove-Item -LiteralPath $trackedDeletionRoot -Recurse -Force }
    $WhatIfPreference = $previousWhatIfPreference
}
$root = Split-Path -Parent $PSScriptRoot
$gitRoot = Invoke-SharedRepositoryGitCommand -GitPath (Get-Command git).Source -RepositoryPath $root -Arguments @('rev-parse', '--show-toplevel') -Description 'Testing WhatIf-safe Git inspection'
if ([IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($root)) { throw 'WhatIf-safe Git inspection returned an invalid repository path.' }
Write-Host 'Coordinated commit workflow PowerShell tests passed.'
