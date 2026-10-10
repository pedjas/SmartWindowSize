<# Coordinates a safe, already-committed push for the source and documentation repositories. #>
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'git-workflow.psm1') -Force

function Get-PushRepositoryState {
    param([Parameter(Mandatory)][string]$GitPath, [Parameter(Mandatory)][string]$RepositoryPath, [Parameter(Mandatory)][string]$Name)

    if (-not (Test-Path -LiteralPath $RepositoryPath -PathType Container)) { throw "$Name repository is missing: $RepositoryPath" }
    $root = Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('rev-parse', '--show-toplevel') -Description "Checking $Name Git repository"
    if ([System.IO.Path]::GetFullPath($root) -ne [System.IO.Path]::GetFullPath($RepositoryPath)) { throw "$Name path is not its Git repository root: $RepositoryPath" }
    $status = Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('status', '--porcelain=v1', '--untracked-files=all') -Description "Checking $Name working tree"
    $branch = Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('branch', '--show-current') -Description "Reading $Name branch"
    if ([string]::IsNullOrWhiteSpace($branch)) { throw "$Name is detached; check out a branch with a configured upstream before pushing." }
    try { $upstream = Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}') -Description "Reading $Name upstream" }
    catch { throw "$Name branch '$branch' has no usable configured upstream. Set one before pushing." }
    if ([string]::IsNullOrWhiteSpace($upstream) -or $upstream -notmatch '^(?<remote>[^/]+)/(?<branch>.+)$') { throw "$Name branch '$branch' has no usable configured upstream. Set one before pushing." }
    $remote = $Matches.remote
    $upstreamBranch = $Matches.branch
    $remoteUrl = Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('remote', 'get-url', $remote) -Description "Reading $Name remote URL"
    Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('fetch', '--prune', $remote) -Description "Fetching $Name remote state" | Out-Null
    $head = Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('rev-parse', 'HEAD') -Description "Reading $Name HEAD"
    $upstreamHead = Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('rev-parse', '@{upstream}') -Description "Reading $Name upstream HEAD"
    $counts = Invoke-SharedRepositoryGitCommand -GitPath $GitPath -RepositoryPath $RepositoryPath -Arguments @('rev-list', '--left-right', '--count', '@{upstream}...HEAD') -Description "Comparing $Name with its upstream"
    if ($counts -notmatch '^(?<behind>\d+)\s+(?<ahead>\d+)$') { throw "Cannot interpret $Name ahead/behind counts: $counts" }
    return [pscustomobject]@{ Name = $Name; Path = [System.IO.Path]::GetFullPath($RepositoryPath); Status = $status; Branch = $branch; Upstream = $upstream; UpstreamBranch = $upstreamBranch; Remote = $remote; RemoteUrl = $remoteUrl; Head = $head; UpstreamHead = $upstreamHead; Behind = [int]$Matches.behind; Ahead = [int]$Matches.ahead }
}

function Get-CoordinatedPushPlan {
    param([Parameter(Mandatory)][object[]]$Repository)

    $dirty = @($Repository | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Status) })
    if ($dirty.Count -gt 0) { throw "Refusing coordinated push because these working trees are dirty: $($dirty.Name -join ', '). Resolve them without stashing, resetting, or committing automatically, then retry." }
    $unsafe = @($Repository | Where-Object { $_.Behind -gt 0 })
    if ($unsafe.Count -gt 0) { throw "Refusing coordinated push because these repositories are behind or diverged: $($unsafe.Name -join ', '). Update them with the established Git workflow; this tool will not pull, merge, rebase, or force-push." }
    return @($Repository | ForEach-Object { [pscustomobject]@{ Repository = $_; Action = if ($_.Ahead -gt 0) { 'push' } else { 'skip' } } })
}

function Invoke-CoordinatedPushPlan {
    param([Parameter(Mandatory)][object[]]$Plan, [Parameter(Mandatory)][scriptblock]$PushAction)

    $completed = [System.Collections.Generic.List[string]]::new()
    foreach ($item in $Plan) {
        if ($item.Action -eq 'skip') { continue }
        try { & $PushAction $item.Repository; $completed.Add($item.Repository.Name) }
        catch { throw "Coordinated push stopped after successful push(es): $($completed -join ', '). $($item.Repository.Name) failed: $($_.Exception.Message)" }
    }
    return @($completed)
}

Export-ModuleMember -Function Get-PushRepositoryState, Get-CoordinatedPushPlan, Invoke-CoordinatedPushPlan
