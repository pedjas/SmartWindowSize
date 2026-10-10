<#
.SYNOPSIS
Safely pushes already committed SmartWindowSize source and documentation work.

.DESCRIPTION
Fetches and verifies both repositories before pushing either. It never stages,
commits, tags, releases, packages, merges, rebases, or force-pushes.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DocumentationRoot = Join-Path $ProjectRoot 'project-docs'
Import-Module (Join-Path $PSScriptRoot 'git-workflow.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'push-workflow.psm1') -Force

$git = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $git) { throw 'Git was not found. Install Git and retry the coordinated push.' }

Write-Host 'SmartWindowSize coordinated push'
$repositories = @(
    Get-PushRepositoryState -GitPath $git.Source -RepositoryPath $ProjectRoot -Name 'Source'
    Get-PushRepositoryState -GitPath $git.Source -RepositoryPath $DocumentationRoot -Name 'Documentation'
)
foreach ($repository in $repositories) {
    Write-Host "$($repository.Name): branch $($repository.Branch); upstream $($repository.Upstream); ahead $($repository.Ahead); behind $($repository.Behind)"
    Write-Host "  remote: $($repository.RemoteUrl); HEAD: $($repository.Head); upstream HEAD: $($repository.UpstreamHead)"
}
$plan = Get-CoordinatedPushPlan -Repository $repositories

if ($WhatIfPreference) {
    foreach ($item in $plan) { Write-Host "$($item.Repository.Name): $(if ($item.Action -eq 'push') { 'would push' } else { 'already synchronized' })" }
    return
}

try {
    Invoke-CoordinatedPushPlan -Plan $plan -PushAction {
        param($repository)
        if ($PSCmdlet.ShouldProcess("$($repository.Name) $($repository.Branch) -> $($repository.Upstream)", 'Push already committed work')) {
            Invoke-SharedRepositoryGitCommand -GitPath $git.Source -RepositoryPath $repository.Path -Arguments @('push', $repository.Remote, "HEAD:refs/heads/$($repository.UpstreamBranch)") -Description "Pushing $($repository.Name)" | Out-Null
        }
    } | Out-Null
}
catch {
    Write-Host 'Partial push result:'
    foreach ($path in @(@{ Path = $ProjectRoot; Name = 'Source' }, @{ Path = $DocumentationRoot; Name = 'Documentation' })) {
        try { $state = Get-PushRepositoryState -GitPath $git.Source -RepositoryPath $path.Path -Name $path.Name; Write-Host "$($state.Name): ahead $($state.Ahead); behind $($state.Behind)" }
        catch { Write-Host "$($path.Name): state unavailable: $($_.Exception.Message)" }
    }
    throw
}

$verified = @(
    Get-PushRepositoryState -GitPath $git.Source -RepositoryPath $ProjectRoot -Name 'Source'
    Get-PushRepositoryState -GitPath $git.Source -RepositoryPath $DocumentationRoot -Name 'Documentation'
)
foreach ($repository in $verified) {
    if ($repository.Ahead -ne 0 -or $repository.Behind -ne 0 -or -not [string]::IsNullOrWhiteSpace($repository.Status)) { throw "$($repository.Name) did not finish synchronized and clean." }
    Write-Host "$($repository.Name): synchronized"
}
