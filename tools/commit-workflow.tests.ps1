<# Focused non-mutating checks for the coordinated commit entry point. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Get-Content (Join-Path $PSScriptRoot 'commit.ps1') -Raw
foreach ($required in @('commit-milestone.ps1', 'Assert-VersionConsistency', 'Get-PendingChangelogEntries', '$WhatIfPreference', 'Nothing pushed', 'diff','--diff-filter=U')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "Missing coordinated commit safeguard: $required" }
}
if ($source -notmatch "Checking source staged files" -or $source -notmatch "Listing source modified files") { throw 'Dry-run and real commit planning must validate the source index and supply shared-helper descriptions.' }
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
$root = Split-Path -Parent $PSScriptRoot
$gitRoot = Invoke-SharedRepositoryGitCommand -GitPath (Get-Command git).Source -RepositoryPath $root -Arguments @('rev-parse', '--show-toplevel') -Description 'Testing WhatIf-safe Git inspection'
if ([IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($root)) { throw 'WhatIf-safe Git inspection returned an invalid repository path.' }
Write-Host 'Coordinated commit workflow PowerShell tests passed.'
