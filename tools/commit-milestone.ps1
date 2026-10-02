<#
.SYNOPSIS
Creates one explicitly scoped SmartWindowSize development commit milestone.

.DESCRIPTION
Closes the pending top-level CHANGELOG.md bullets into the current manifest
version, stages only CHANGELOG.md plus explicitly named project paths, and
creates the requested normal commit. It never pushes, tags, or releases.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Message,

    [Parameter(Mandatory)]
    [string[]]$Path,

    [switch]$DocumentationOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<# The repository root is fixed by this script's tools/ location. #>
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Import-Module (Join-Path $PSScriptRoot 'release-changelog.psm1') -Force


<#
.SYNOPSIS
Runs Git only inside this project with the project's explicit safe-directory setting.

.PARAMETER Arguments
Arguments passed to Git after the repository selection arguments.

.PARAMETER Description
Human-readable operation description used in failures.
#>
function Invoke-ProjectGit {
    param([Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][string]$Description)

    $safeDirectory = $ProjectRoot -replace '\\', '/'
    & git -c "safe.directory=$safeDirectory" -C $ProjectRoot @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}


<#
.SYNOPSIS
Validates that a requested path stays inside the project and can be passed to Git.

.PARAMETER Candidate
Relative project path supplied by the caller.
#>
function Get-RelativeProjectPath {
    param([Parameter(Mandatory)][string]$Candidate)

    if ([System.IO.Path]::IsPathRooted($Candidate) -or $Candidate -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "Commit path must be a relative path inside the project: $Candidate"
    }
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Candidate))
    $rootPrefix = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Commit path resolves outside the project: $Candidate"
    }
    if (-not (Test-Path -LiteralPath $fullPath)) { throw "Commit path does not exist: $Candidate" }
    return $Candidate
}


<# Require an explicit commit message matching the documented current-version suffix. #>
$manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'manifest.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Root manifest version '$version' must use X.Y.Z." }
if ($Message -notmatch "\($([regex]::Escape($version))\)$") { throw "Commit message must end with the current version ($version)." }

<# Do not mix this helper's explicit staging operation with an existing index. #>
$stagedPaths = @(Invoke-ProjectGit -Arguments @('diff', '--cached', '--name-only') -Description 'Checking staged files')
if ($stagedPaths.Count -gt 0) { throw 'Commit milestone helper requires an empty Git index. Unstage existing files or commit them separately.' }

$paths = @($Path | ForEach-Object { Get-RelativeProjectPath -Candidate $_ } | Select-Object -Unique)
$changelogPath = Join-Path $ProjectRoot 'CHANGELOG.md'
$entries = Get-PendingChangelogEntries -ChangelogPath $changelogPath
if ([string]::IsNullOrWhiteSpace($entries.PendingNotes)) {
    if (-not $DocumentationOnly) { throw 'Normal feature or fix commits require meaningful pending CHANGELOG.md entries.' }
}
else {
    Write-CommitMilestoneChangelog -ChangelogPath $changelogPath -PendingEntries $entries -Version $version -CommitDate (Get-Date -Format 'yyyy-MM-dd')
}

<# Stage only the requested project changes and the changelog when it was updated. #>
$stagePaths = @($paths)
if (-not [string]::IsNullOrWhiteSpace($entries.PendingNotes)) { $stagePaths += 'CHANGELOG.md' }
Invoke-ProjectGit -Arguments (@('add', '--') + $stagePaths) -Description 'Staging explicit commit paths'
Invoke-ProjectGit -Arguments @('commit', '-m', $Message) -Description 'Creating development commit'

Write-Host "Created commit milestone $version. No push, tag, or release was performed."
