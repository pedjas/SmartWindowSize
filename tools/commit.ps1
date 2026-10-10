<# Creates coordinated local commits only; push and release remain separate. #>
[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$SourceMessage, [string]$DocsMessage)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DocumentationRoot = Join-Path $ProjectRoot 'project-docs'
Import-Module (Join-Path $PSScriptRoot 'git-workflow.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'release-changelog.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'version-consistency.psm1') -Force
$git = (Get-Command git -ErrorAction Stop).Source

function Get-CommitRepositoryState {
    param([string]$Path, [string]$Name)
    $root = Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $Path -Arguments @('rev-parse','--show-toplevel') -Description "Checking $Name repository"
    if ([IO.Path]::GetFullPath($root) -ne [IO.Path]::GetFullPath($Path)) { throw "$Name is not a Git repository root." }
    $branch = Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $Path -Arguments @('branch','--show-current') -Description "Reading $Name branch"
    if ([string]::IsNullOrWhiteSpace($branch)) { throw "$Name is detached; check out a branch before committing." }
    $conflicts = Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $Path -Arguments @('diff','--name-only','--diff-filter=U') -Description "Checking $Name merge conflicts"
    if ($conflicts) { throw "$Name has unresolved merge conflicts: $conflicts" }
    $status = Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $Path -Arguments @('status','--porcelain=v1','--untracked-files=all') -Description "Checking $Name changes"
    return [pscustomobject]@{ Name=$Name; Path=$Path; Branch=$branch; Status=$status; Changed=(-not [string]::IsNullOrWhiteSpace($status)) }
}

Write-Host 'SmartWindowSize coordinated commit'
$source = Get-CommitRepositoryState -Path $ProjectRoot -Name Source
$docs = Get-CommitRepositoryState -Path $DocumentationRoot -Name Documentation
$sourceIndex = Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $ProjectRoot -Arguments @('diff','--cached','--name-only') -Description 'Checking source staged files'
if (-not [string]::IsNullOrWhiteSpace($sourceIndex)) { throw "Source index is not empty; coordinated commit will not risk staged content. Unstage or commit it separately before retrying.`n$sourceIndex" }
Assert-VersionConsistency -ProjectRoot $ProjectRoot | Out-Null
$changelog = Get-PendingChangelogEntries -ChangelogPath (Join-Path $ProjectRoot 'CHANGELOG.md')
if ($source.Changed -and [string]::IsNullOrWhiteSpace($changelog.PendingNotes)) { throw 'Source changes require pending CHANGELOG entries before a milestone commit.' }
$manifest = Get-Content (Join-Path $ProjectRoot 'manifest.json') -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($SourceMessage)) { $SourceMessage = "Commit SmartWindowSize milestone ($($manifest.version))" }
if ($SourceMessage -notmatch "\($([regex]::Escape($manifest.version))\)$") { throw "SourceMessage must end with ($($manifest.version))." }
if ([string]::IsNullOrWhiteSpace($DocsMessage)) { $DocsMessage = 'Update SmartWindowSize documentation' }
$sourcePaths = @(ConvertFrom-SharedGitPathOutput (Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $ProjectRoot -Arguments @('diff','--name-only') -Description 'Listing source modified files'))
$sourcePaths += @(ConvertFrom-SharedGitPathOutput (Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $ProjectRoot -Arguments @('ls-files','--others','--exclude-standard') -Description 'Listing source untracked files'))
foreach ($path in $sourcePaths) { if ([IO.Path]::IsPathRooted($path) -or $path -match "[\r\n]") { throw "Invalid source path planned for milestone commit: '$path'" } }
Write-Host "Source: $(if($source.Changed){'would commit'}else{'clean; skipped'})"
Write-Host "Documentation: $(if($docs.Changed){'would commit'}else{'clean; skipped'})"
if ($WhatIfPreference) { Write-Host "Source message: $SourceMessage"; Write-Host "Documentation message: $DocsMessage"; return }

$completed = [Collections.Generic.List[string]]::new()
try {
    if ($source.Changed -and $PSCmdlet.ShouldProcess('Source milestone','Create local commit')) {
        & (Join-Path $PSScriptRoot 'commit-milestone.ps1') -Message $SourceMessage -Path @($sourcePaths | Where-Object { $_ -ne 'CHANGELOG.md' })
        if ($LASTEXITCODE -ne 0) { throw 'Source milestone commit failed.' }; $completed.Add('Source')
    }
    if ($docs.Changed -and $PSCmdlet.ShouldProcess('Documentation','Create local commit')) {
        $paths = @((Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $DocumentationRoot -Arguments @('diff','--name-only') -Description 'Listing documentation modified files') + (Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $DocumentationRoot -Arguments @('ls-files','--others','--exclude-standard') -Description 'Listing documentation untracked files'))
        Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $DocumentationRoot -Arguments (@('add','--') + $paths) -Description 'Staging documentation changes' | Out-Null
        Invoke-SharedRepositoryGitCommand -GitPath $git -RepositoryPath $DocumentationRoot -Arguments @('commit','-m',$DocsMessage) -Description 'Creating documentation commit' | Out-Null
        $completed.Add('Documentation')
    }
}
catch { throw "Coordinated commit stopped after: $($completed -join ', '). $($_.Exception.Message)" }
Write-Host "Committed: $($completed -join ', '). Nothing pushed."
