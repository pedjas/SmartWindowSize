<#
.SYNOPSIS
Formats shared user-facing SmartWindowSize release preflight diagnostics.
#>

Set-StrictMode -Version Latest

function New-ReleaseDiagnostic {
    param([Parameter(Mandatory)][string]$Problem, [string]$Action, [string]$State)
    $parts = @('Problem:', $Problem)
    if ($Action) { $parts += @('', 'Required action:', $Action) }
    if ($State) { $parts += @('', 'Current state:', $State) }
    return $parts -join [Environment]::NewLine
}

function Get-WorkingTreeDiagnostic {
    param([Parameter(Mandatory)][string]$Status)
    return New-ReleaseDiagnostic -Problem 'Working tree contains uncommitted changes.' -Action 'Commit or otherwise resolve these changes before releasing.' -State $Status.Trim()
}

function Get-BranchSyncDiagnostic {
    param([Parameter(Mandatory)][string]$Branch, [Parameter(Mandatory)][int]$Ahead, [Parameter(Mandatory)][int]$Behind, [string]$Commits)
    if ($Ahead -gt 0 -and $Behind -eq 0) { return New-ReleaseDiagnostic -Problem "Local $Branch has $Ahead commit(s) that have not been pushed to origin/$Branch." -Action "git push origin $Branch`nThen verify: git rev-list --left-right --count origin/$Branch...$Branch`nExpected result: 0    0" -State $Commits }
    if ($Ahead -eq 0 -and $Behind -gt 0) { return New-ReleaseDiagnostic -Problem "Local $Branch is behind origin/$Branch by $Behind commit(s)." -Action "Update the local branch from origin/$Branch using the established Git workflow, then retry. Do not merge, rebase, or pull automatically during release." -State $Commits }
    if ($Ahead -gt 0 -and $Behind -gt 0) { return New-ReleaseDiagnostic -Problem "Local $Branch and origin/$Branch have diverged ($Ahead local-only, $Behind remote-only commit(s))." -Action 'Resolve the divergence using the established Git workflow, then retry. Do not force-push as the default release remedy.' -State $Commits }
    return $null
}

function Get-VersionMismatchDiagnostic {
    param([Parameter(Mandatory)][string]$RootVersion, [Parameter(Mandatory)][string]$FirefoxVersion)
    return New-ReleaseDiagnostic -Problem 'Browser manifest versions do not match.' -Action 'Align the versions before releasing.' -State "Root manifest:      $RootVersion`nFirefox manifest:   $FirefoxVersion"
}

function Get-TagConflictDiagnostic {
    param([Parameter(Mandatory)][string]$Tag, [Parameter(Mandatory)][bool]$Local, [Parameter(Mandatory)][bool]$Remote)
    $where = if ($Local -and $Remote) { 'Local and remote' } elseif ($Local) { 'Local' } else { 'Remote' }
    return New-ReleaseDiagnostic -Problem "$where tag $Tag already exists." -Action 'Verify the existing tag and release state; the script will not overwrite or resume it.'
}

function Get-GitHubCliDiagnostic {
    param([Parameter(Mandatory)][string]$Reason)
    return New-ReleaseDiagnostic -Problem $Reason -Action 'Run: gh auth status'
}

Export-ModuleMember -Function New-ReleaseDiagnostic, Get-WorkingTreeDiagnostic, Get-BranchSyncDiagnostic, Get-VersionMismatchDiagnostic, Get-TagConflictDiagnostic, Get-GitHubCliDiagnostic
