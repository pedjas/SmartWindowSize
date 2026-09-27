<#
.SYNOPSIS
Creates a guarded SmartWindowSize GitHub Draft Release from the current manifest version.

.DESCRIPTION
Validates the repository before changing CHANGELOG.md, uses the established
package-extension.ps1 build, creates one release commit and tag, pushes them,
then uploads the two ZIP packages to a GitHub Draft Release.

.PARAMETER ReleaseBranch
The only local branch permitted to create a release. It must be synchronized
with its matching origin branch before this script changes any local file.

.PARAMETER DryRun
Builds and validates temporary browser packages without modifying CHANGELOG.md,
Git history, the project install/ directory, a remote, or GitHub.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ReleaseBranch = 'master',

    [switch]$DryRun
)

<# Strict mode prevents incomplete preflight results from being treated as valid release state. #>
Set-StrictMode -Version Latest

<# Native-command failures must stop the release before later external steps can run. #>
$ErrorActionPreference = 'Stop'


<# The GitHub repository that receives every SmartWindowSize Draft Release. #>
$ExpectedRepository = 'pedjas/SmartWindowSize'

<# The repository root derived from this script's known tools/ location. #>
$ProjectRoot = Split-Path -Parent $PSScriptRoot

<# The cumulative record of externally visible steps completed by this invocation. #>
$CompletedSteps = [System.Collections.Generic.List[string]]::new()

<# The temporary release-notes file created only for the GitHub CLI upload. #>
$ReleaseNotesPath = $null

<# The temporary package root used only by a dry run and removed when it completes. #>
$DryRunInstallRoot = $null


<#
.SYNOPSIS
Runs a native command and returns its trimmed standard output.

.PARAMETER Executable
The executable path or command name.

.PARAMETER Arguments
Arguments passed without shell interpolation.

.PARAMETER Description
Human-readable operation description used in failures.

.OUTPUTS
System.String. Trimmed standard output from the successful native command.
#>
function Get-NativeCommandResult {
    param(
        [Parameter(Mandatory)]
        [string]$Executable,

        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [Parameter(Mandatory)]
        [string]$Description
    )

    # Redirect stderr so expected Git status output cannot become a PowerShell terminating error.
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "SmartWindowSize-native-$([guid]::NewGuid().ToString('N')).stderr"
    $previousErrorActionPreference = $ErrorActionPreference
    $stdout = @()
    $stderr = ''
    $exitCode = $null
    try {
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $stdout = @(& $Executable @Arguments 2> $stderrPath)
        $exitCode = $LASTEXITCODE
        $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if (Test-Path -LiteralPath $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }
    }
    $standardOutput = [string]::Empty + (($stdout | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
    $standardError = [string]::Empty + $stderr
    return [pscustomobject]@{ ExitCode = $exitCode; StandardOutput = $standardOutput.Trim(); StandardError = $standardError.Trim() }
}


function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Description
    )
    $result = Get-NativeCommandResult -Executable $Executable -Arguments $Arguments -Description $Description
    if ($result.ExitCode -ne 0) {
        $details = @($result.StandardOutput, $result.StandardError) -join [Environment]::NewLine
        throw "$Description failed with exit code $($result.ExitCode).`n$details"
    }
    return $result.StandardOutput
}


<#
.SYNOPSIS
Runs Git against this exact repository with an explicit safe-directory override.

.PARAMETER GitPath
The resolved Git executable path.

.PARAMETER Arguments
Git arguments after the repository selection arguments.

.PARAMETER Description
Human-readable operation description used in failures.

.OUTPUTS
System.String. Trimmed standard output from the successful Git command.
#>
function Invoke-RepositoryGitCommand {
    param(
        [Parameter(Mandatory)]
        [string]$GitPath,

        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [Parameter(Mandatory)]
        [string]$Description
    )

    # Git safe.directory is scoped to this invocation and normalized for Git's cross-platform path matching.
    $safeDirectory = $ProjectRoot -replace '\\', '/'
    $repositoryArguments = @('-c', "safe.directory=$safeDirectory", '-C', $ProjectRoot) + $Arguments
    return Invoke-NativeCommand -Executable $GitPath -Arguments $repositoryArguments -Description $Description
}


<#
.SYNOPSIS
Requires an executable used by the release procedure.

.PARAMETER Name
The command name that must resolve through the current PATH.

.OUTPUTS
System.String. The resolved executable path.
#>
function Require-Command {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "Required tool '$Name' is not available on PATH. Install it before creating a release."
    }

    return $command.Source
}


<#
.SYNOPSIS
Reads a GitHub Release while preserving the native exit code and both output streams.

.PARAMETER GhPath
The resolved GitHub CLI executable path.

.PARAMETER Tag
The vX.Y.Z tag whose GitHub Release state is being queried.

.OUTPUTS
PSCustomObject. The native exit code, standard output, standard error, and combined details.
#>
function Get-GitHubReleaseViewResult {
    param(
        [Parameter(Mandatory)]
        [string]$GhPath,

        [Parameter(Mandatory)]
        [string]$Tag
    )

    # A redirected stderr file prevents expected CLI failures from becoming terminating PowerShell errors.
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "SmartWindowSize-gh-release-view-$([guid]::NewGuid().ToString('N')).stderr"
    $stdout = @()
    $stderr = ''
    $exitCode = $null
    $previousErrorActionPreference = $ErrorActionPreference

    try {
        # Keep native non-zero exit codes observable so only known "not found" output is accepted.
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $stdout = @(& $GhPath release view $Tag --repo $ExpectedRepository --json url --jq '.url' 2> $stderrPath)
        $exitCode = $LASTEXITCODE
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
            $stderr = Get-Content -LiteralPath $stderrPath -Raw
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
            Remove-Item -LiteralPath $stderrPath -Force
        }
    }

    $standardOutput = ($stdout | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    $details = (@($standardOutput.Trim(), $stderr.Trim()) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
    return [pscustomobject]@{
        ExitCode = $exitCode
        StandardOutput = $standardOutput.Trim()
        StandardError = $stderr.Trim()
        Details = $details
    }
}


<#
.SYNOPSIS
Reads and validates the release version from the root extension manifest.

.PARAMETER ManifestPath
The root manifest.json file that is the only release-version authority.

.OUTPUTS
System.String. A validated X.Y.Z version.
#>
function Get-ManifestVersion {
    param(
        [Parameter(Mandatory)]
        [string]$ManifestPath
    )

    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "Required root manifest is missing: $ManifestPath"
    }

    try {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Root manifest.json is not valid JSON: $($_.Exception.Message)"
    }

    $version = [string]$manifest.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
        throw "Root manifest.json version '$version' must use the X.Y.Z format."
    }

    return $version
}


<#
.SYNOPSIS
Returns the non-empty Unreleased release notes from the cumulative changelog.

.PARAMETER ChangelogPath
The cumulative root CHANGELOG.md to validate and later finalize.

.OUTPUTS
PSCustomObject. Original content, the Unreleased match, and its release notes.
#>
function Get-UnreleasedChangelog {
    param(
        [Parameter(Mandatory)]
        [string]$ChangelogPath
    )

    if (-not (Test-Path -LiteralPath $ChangelogPath -PathType Leaf)) {
        throw "Required changelog is missing: $ChangelogPath"
    }

    # Preserve the current text so finalization can leave prior release sections untouched.
    $content = Get-Content -LiteralPath $ChangelogPath -Raw
    $options = [System.Text.RegularExpressions.RegexOptions]::Multiline -bor [System.Text.RegularExpressions.RegexOptions]::Singleline
    $match = [regex]::Match($content, '\A# Changelog\r?\n\r?\n## Unreleased\r?\n(?<notes>.*?)(?=^##\s|\z)', $options)
    if (-not $match.Success) {
        throw 'CHANGELOG.md must begin with # Changelog followed immediately by ## Unreleased.'
    }

    # A heading alone is not releasable; at least one user-visible change must be recorded.
    $notes = $match.Groups['notes'].Value.Trim()
    if ([string]::IsNullOrWhiteSpace($notes) -or $notes -notmatch '(?m)^\s*-\s+\S') {
        throw 'CHANGELOG.md ## Unreleased must contain at least one release-note bullet before releasing.'
    }

    return [pscustomobject]@{
        Content = $content
        Match = $match
        Notes = $notes
    }
}


<#
.SYNOPSIS
Moves the current Unreleased notes into a dated, immutable release section.

.PARAMETER ChangelogPath
The root CHANGELOG.md whose Unreleased section will be finalized.

.PARAMETER Unreleased
The validated Unreleased content returned by Get-UnreleasedChangelog.

.PARAMETER Version
The already-established manifest version for the new history heading.

.PARAMETER ReleaseDate
The local release date formatted as YYYY-MM-DD.

.OUTPUTS
None. Rewrites only CHANGELOG.md with a new empty Unreleased section.
#>
function Write-FinalizedChangelog {
    param(
        [Parameter(Mandatory)]
        [string]$ChangelogPath,

        [Parameter(Mandatory)]
        [pscustomobject]$Unreleased,

        [Parameter(Mandatory)]
        [string]$Version,

        [Parameter(Mandatory)]
        [string]$ReleaseDate
    )

    # Copy the historical portion verbatim after inserting the new immutable release section.
    $notesEnd = $Unreleased.Match.Groups['notes'].Index + $Unreleased.Match.Groups['notes'].Length
    $history = $Unreleased.Content.Substring($notesEnd).TrimStart([char[]]"`r`n")
    $normalizedNotes = ($Unreleased.Notes -replace "`r?`n", "`r`n").Trim()
    $updated = "# Changelog`r`n`r`n## Unreleased`r`n`r`n## $Version - $ReleaseDate`r`n`r`n$normalizedNotes"

    if (-not [string]::IsNullOrWhiteSpace($history)) {
        $updated += "`r`n`r`n$history"
    }

    $updated += "`r`n"
    [System.IO.File]::WriteAllText($ChangelogPath, $updated, [System.Text.UTF8Encoding]::new($false))
}


<#
.SYNOPSIS
Checks whether a local or remote tag already exists without changing Git history.

.PARAMETER GitPath
The resolved Git executable path.

.PARAMETER Tag
The vX.Y.Z tag that must be absent both locally and on origin.

.OUTPUTS
None. Throws when either tag already exists or cannot be verified.
#>
function Test-TagAvailable {
    param(
        [Parameter(Mandatory)]
        [string]$GitPath,

        [Parameter(Mandatory)]
        [string]$Tag
    )

    $safeDirectory = $ProjectRoot -replace '\\', '/'
    $localTag = Get-NativeCommandResult -Executable $GitPath -Arguments @('-c', "safe.directory=$safeDirectory", '-C', $ProjectRoot, 'show-ref', '--tags', '--verify', '--quiet', "refs/tags/$Tag") -Description "Checking local Git tag '$Tag'"
    if ($localTag.ExitCode -ne 0 -and $localTag.ExitCode -ne 1) { throw "Unable to check local Git tag '$Tag'.`n$($localTag.StandardError)" }
    $remoteTag = Invoke-RepositoryGitCommand -GitPath $GitPath -Arguments @('ls-remote', '--tags', 'origin', "refs/tags/$Tag") -Description "Checking remote Git tag '$Tag'"
    if ($localTag.ExitCode -eq 0 -or -not [string]::IsNullOrWhiteSpace($remoteTag)) {
        $tagCommit = if ($localTag.ExitCode -eq 0) { Invoke-RepositoryGitCommand -GitPath $GitPath -Arguments @('rev-parse', "$Tag^{commit}") -Description "Reading existing release tag '$Tag'" } else { 'unavailable locally' }
        $branchState = if ($localTag.ExitCode -eq 0) { (Get-NativeCommandResult -Executable $GitPath -Arguments @('-c', "safe.directory=$safeDirectory", '-C', $ProjectRoot, 'merge-base', '--is-ancestor', "$Tag^{commit}", "origin/$ReleaseBranch") -Description 'Checking existing release commit').ExitCode } else { -1 }
        $onOrigin = if ($branchState -eq 0) { 'yes' } elseif ($branchState -eq 1) { 'no' } else { 'unknown' }
        throw "Release '$Tag' is already partially or fully created. Local tag: $($localTag.ExitCode -eq 0); remote tag: $(-not [string]::IsNullOrWhiteSpace($remoteTag)); tag commit: $tagCommit; commit on origin/${ReleaseBranch}: $onOrigin. The script will not overwrite, rollback, force-push, or resume this state. Verify or create any pending Draft Release manually."
    }
}


<#
.SYNOPSIS
Checks that GitHub has no existing release for the requested tag.

.PARAMETER GhPath
The resolved GitHub CLI executable path.

.PARAMETER Tag
The vX.Y.Z tag that must not already have a GitHub Release.

.OUTPUTS
None. Throws when the release exists or its absence cannot be verified.
#>
function Test-GitHubReleaseAvailable {
    param(
        [Parameter(Mandatory)]
        [string]$GhPath,

        [Parameter(Mandatory)]
        [string]$Tag
    )

    $result = Get-GitHubReleaseViewResult -GhPath $GhPath -Tag $Tag
    if ($result.ExitCode -eq 0) {
        throw "GitHub Release for '$Tag' already exists: $($result.StandardOutput)"
    }

    # Only the CLI's explicit missing-release result is normal for a first or new release.
    if ($result.ExitCode -eq 1 -and $result.Details -match '(?i)\b(release not found|could not find release)\b') {
        return
    }

    throw "Unable to verify whether GitHub Release '$Tag' exists (exit code $($result.ExitCode)).`n$($result.Details)"
}


<#
.SYNOPSIS
Runs every non-mutating release preflight check.

.OUTPUTS
PSCustomObject. The validated tool paths, version, tag, paths, and release notes.
#>
function Invoke-ReleasePreflight {
    # Resolve mandatory tools before inspecting repository state or contacting external services.
    $gitPath = Require-Command -Name 'git'
    $ghPath = Require-Command -Name 'gh'

    $manifestPath = Join-Path $ProjectRoot 'manifest.json'
    $changelogPath = Join-Path $ProjectRoot 'CHANGELOG.md'
    $buildScriptPath = Join-Path $PSScriptRoot 'package-extension.ps1'
    $firefoxTemplatePath = Join-Path $ProjectRoot 'manifests/firefox.manifest.json.template'

    foreach ($path in @($manifestPath, $changelogPath, $buildScriptPath, $firefoxTemplatePath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required release file is missing: $path"
        }
    }

    # The release script must never operate on a parent, sibling, or copied repository.
    $gitRoot = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('rev-parse', '--show-toplevel') -Description 'Checking Git repository root'
    if ([System.IO.Path]::GetFullPath($gitRoot) -ne [System.IO.Path]::GetFullPath($ProjectRoot)) {
        throw "Release script must run from its own repository root. Found: $gitRoot"
    }

    # A clean tree guarantees the later release commit contains only the finalized changelog.
    $workingTree = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('status', '--porcelain=v1', '--untracked-files=all') -Description 'Checking Git working tree'
    if (-not [string]::IsNullOrWhiteSpace($workingTree)) {
        throw "Git working tree is not clean. Commit, stash, or otherwise resolve changes before releasing.`n$workingTree"
    }

    $branch = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('branch', '--show-current') -Description 'Checking release branch'
    if ($branch -ne $ReleaseBranch) {
        throw "Release must run from '$ReleaseBranch', but the current branch is '$branch'."
    }

    $originUrl = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('remote', 'get-url', 'origin') -Description 'Checking GitHub origin remote'
    if ($originUrl -notmatch 'github\.com[/:]pedjas/SmartWindowSize(?:\.git)?$') {
        throw "origin must point to github.com/pedjas/SmartWindowSize, but is '$originUrl'."
    }

    # Refresh remote references before comparing branch ancestry and release-tag availability.
    Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('fetch', 'origin', '--tags') -Description 'Fetching origin release state' | Out-Null
    $syncCounts = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('rev-list', '--left-right', '--count', "$ReleaseBranch...origin/$ReleaseBranch") -Description 'Checking branch synchronization'
    if ($syncCounts -notmatch '^0\s+0$') {
        throw "Local '$ReleaseBranch' is not synchronized with origin/$ReleaseBranch (ahead behind: $syncCounts)."
    }

    Invoke-NativeCommand -Executable $ghPath -Arguments @('auth', 'status', '--hostname', 'github.com') -Description 'Checking GitHub CLI authentication' | Out-Null

    $version = Get-ManifestVersion -ManifestPath $manifestPath
    $template = Get-Content -LiteralPath $firefoxTemplatePath -Raw | ConvertFrom-Json
    if ($template.version -and $template.version -ne '__VERSION__' -and $template.version -ne $version) {
        throw "Firefox manifest version '$($template.version)' does not match root manifest version '$version'."
    }

    $unreleased = Get-UnreleasedChangelog -ChangelogPath $changelogPath
    $tag = "v$version"
    Test-TagAvailable -GitPath $gitPath -Tag $tag
    Test-GitHubReleaseAvailable -GhPath $ghPath -Tag $tag

    return [pscustomobject]@{
        GitPath = $gitPath
        GhPath = $ghPath
        ManifestPath = $manifestPath
        ChangelogPath = $changelogPath
        BuildScriptPath = $buildScriptPath
        Version = $version
        Tag = $tag
        Unreleased = $unreleased
    }
}


<#
.SYNOPSIS
Runs local release checks for a package-only dry run without mutating Git or GitHub.

.OUTPUTS
PSCustomObject. Local release inputs plus non-blocking warnings for a real release.
#>
function Invoke-DryRunPreflight {
    # Git is required for repository validation, while GitHub checks remain informational in a local dry run.
    $gitPath = Require-Command -Name 'git'
    $warnings = [System.Collections.Generic.List[string]]::new()
    $manifestPath = Join-Path $ProjectRoot 'manifest.json'
    $changelogPath = Join-Path $ProjectRoot 'CHANGELOG.md'
    $buildScriptPath = Join-Path $PSScriptRoot 'package-extension.ps1'
    $firefoxTemplatePath = Join-Path $ProjectRoot 'manifests/firefox.manifest.json.template'

    foreach ($path in @($manifestPath, $changelogPath, $buildScriptPath, $firefoxTemplatePath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required dry-run file is missing: $path"
        }
    }

    $gitRoot = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('rev-parse', '--show-toplevel') -Description 'Checking Git repository root'
    if ([System.IO.Path]::GetFullPath($gitRoot) -ne [System.IO.Path]::GetFullPath($ProjectRoot)) {
        throw "Dry run must execute from its own repository root. Found: $gitRoot"
    }

    # Report dirty state without blocking package testing; the real release keeps this as a hard stop.
    $workingTree = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('status', '--porcelain=v1', '--untracked-files=all') -Description 'Checking Git working tree'
    if (-not [string]::IsNullOrWhiteSpace($workingTree)) {
        $warnings.Add("Real release is blocked by a non-clean Git working tree:`n$workingTree")
    }

    $branch = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('branch', '--show-current') -Description 'Checking release branch'
    if ($branch -ne $ReleaseBranch) {
        $warnings.Add("Real release requires branch '$ReleaseBranch', but the current branch is '$branch'.")
    }

    $originUrl = Invoke-RepositoryGitCommand -GitPath $gitPath -Arguments @('remote', 'get-url', 'origin') -Description 'Checking GitHub origin remote'
    if ($originUrl -notmatch 'github\.com[/:]pedjas/SmartWindowSize(?:\.git)?$') {
        $warnings.Add("Real release requires origin github.com/pedjas/SmartWindowSize, but origin is '$originUrl'.")
    }

    $version = Get-ManifestVersion -ManifestPath $manifestPath
    $template = Get-Content -LiteralPath $firefoxTemplatePath -Raw | ConvertFrom-Json
    if ($template.version -and $template.version -ne '__VERSION__' -and $template.version -ne $version) {
        throw "Firefox manifest version '$($template.version)' does not match root manifest version '$version'."
    }

    $unreleased = Get-UnreleasedChangelog -ChangelogPath $changelogPath
    $tag = "v$version"

    # A dry run never fetches or alters remote-tracking references, so remote tag state is only reported as pending.
    $safeDirectory = $ProjectRoot -replace '\\', '/'
    $localTagResult = Get-NativeCommandResult -Executable $gitPath -Arguments @('-c', "safe.directory=$safeDirectory", '-C', $ProjectRoot, 'show-ref', '--tags', '--verify', '--quiet', "refs/tags/$tag") -Description "Checking local Git tag '$tag'"
    if ($localTagResult.ExitCode -eq 0) {
        $warnings.Add("Real release is blocked because local tag '$tag' already exists.")
    }
    elseif ($localTagResult.ExitCode -ne 1) {
        $warnings.Add("Local tag '$tag' could not be verified: $($localTagResult.StandardError)")
    }

    $ghCommand = Get-Command -Name 'gh' -ErrorAction SilentlyContinue
    if ($null -eq $ghCommand) {
        $warnings.Add('GitHub CLI gh is unavailable; GitHub authentication, remote tag, and existing Release checks were not performed.')
        $ghPath = $null
    }
    else {
        $ghPath = $ghCommand.Source
        $authOutput = @(& $ghPath auth status --hostname github.com 2>&1)
        if ($LASTEXITCODE -ne 0) {
            $warnings.Add("GitHub CLI is not authenticated for github.com:`n$(($authOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)")
        }
        else {
            $releaseResult = Get-GitHubReleaseViewResult -GhPath $ghPath -Tag $tag
            if ($releaseResult.ExitCode -eq 0) {
                $warnings.Add("Real release is blocked because GitHub Release '$tag' already exists.")
            }
            elseif ($releaseResult.ExitCode -ne 1 -or $releaseResult.Details -notmatch '(?i)\b(release not found|could not find release)\b') {
                $warnings.Add("GitHub Release '$tag' could not be verified during dry run (exit code $($releaseResult.ExitCode)):`n$($releaseResult.Details)")
            }
        }
    }

    return [pscustomobject]@{
        GitPath = $gitPath
        GhPath = $ghPath
        BuildScriptPath = $buildScriptPath
        Version = $version
        Tag = $tag
        Unreleased = $unreleased
        Warnings = $warnings
    }
}


<#
.SYNOPSIS
Verifies the generated browser packages and their manifest versions.

.PARAMETER Version
The root manifest version required in both generated package manifests and ZIP names.

.PARAMETER InstallRoot
The generated package root to validate. Defaults to the project install/ directory.

.OUTPUTS
System.String[]. Absolute paths to the verified Chrome and Firefox ZIP assets.
#>
function Confirm-ReleasePackages {
    param(
        [Parameter(Mandatory)]
        [string]$Version,

        [string]$InstallRoot = (Join-Path $ProjectRoot 'install')
    )

    $packageNames = @(
        "SmartWindowSize-Chrome-v$Version.zip",
        "SmartWindowSize-Firefox-v$Version.zip"
    )

    # Both versioned ZIP assets are mandatory; unpacked directories are not release assets.
    foreach ($packageName in $packageNames) {
        $packagePath = Join-Path $installRoot $packageName
        if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
            throw "Expected release package was not created: $packagePath"
        }
    }

    # Verify generated manifests rather than trusting names, especially the Firefox template output.
    foreach ($browserName in @('Chrome', 'Firefox')) {
        $generatedManifestPath = Join-Path $installRoot "SmartWindowSize-$browserName\\manifest.json"
        $generatedManifest = Get-Content -LiteralPath $generatedManifestPath -Raw | ConvertFrom-Json
        if ($generatedManifest.version -ne $Version) {
            throw "$browserName package manifest version '$($generatedManifest.version)' does not match '$Version'."
        }
    }

    return $packageNames | ForEach-Object { Join-Path $installRoot $_ }
}


try {
    if ($DryRun -and $WhatIfPreference) {
        throw 'Use either -DryRun or -WhatIf, not both.'
    }

    if ($DryRun) {
        $dryRunResult = Invoke-DryRunPreflight
        $DryRunInstallRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SmartWindowSize-release-dry-run-$([guid]::NewGuid().ToString('N'))"

        # Reuse the normal package script in a temporary location so no project release ZIP is replaced or created.
        & $dryRunResult.BuildScriptPath -Target all -TestInstallRoot $DryRunInstallRoot
        $packagePaths = Confirm-ReleasePackages -Version $dryRunResult.Version -InstallRoot $DryRunInstallRoot

        Write-Host ''
        Write-Host 'LOCAL RELEASE DRY RUN COMPLETED'
        Write-Host "Version: $($dryRunResult.Version)"
        Write-Host "Tag: $($dryRunResult.Tag)"
        Write-Host "Chrome test package: $($packagePaths[0])"
        Write-Host "Firefox test package: $($packagePaths[1])"
        Write-Host 'No changelog, Git history, remote, or GitHub Release changes were made.'
        Write-Host 'A real release would finalize CHANGELOG.md, commit it, create and push the tag, then create a Draft Release.'

        if ($dryRunResult.Warnings.Count -gt 0) {
            Write-Host 'Real-release blockers or unchecked external prerequisites:'
            $dryRunResult.Warnings | ForEach-Object { Write-Host "- $_" }
        }

        exit 0
    }

    $preflight = Invoke-ReleasePreflight

    if ($WhatIfPreference) {
        Write-Host 'RELEASE DRY RUN SUCCEEDED'
        Write-Host "Version: $($preflight.Version)"
        Write-Host "Tag: $($preflight.Tag)"
        Write-Host 'No changelog, build, Git, remote, or GitHub Release changes were made.'
        exit 0
    }

    # This is the first local mutation, reached only after every safety check above succeeds.
    $releaseDate = Get-Date -Format 'yyyy-MM-dd'
    Write-FinalizedChangelog -ChangelogPath $preflight.ChangelogPath -Unreleased $preflight.Unreleased -Version $preflight.Version -ReleaseDate $releaseDate
    $CompletedSteps.Add('CHANGELOG.md finalized locally (not committed)')

    & $preflight.BuildScriptPath -Target all

    $packagePaths = Confirm-ReleasePackages -Version $preflight.Version
    $CompletedSteps.Add('Chrome and Firefox packages created and verified')

    # Stage an explicit allowlist so release output and unrelated files cannot enter the commit.
    Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('add', '--', 'CHANGELOG.md') -Description 'Staging finalized changelog' | Out-Null
    $CompletedSteps.Add('Finalized CHANGELOG.md staged locally')
    $stagedPaths = Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('diff', '--cached', '--name-only') -Description 'Checking staged release files'
    if ($stagedPaths.Trim() -ne 'CHANGELOG.md') {
        throw "Release commit may stage only CHANGELOG.md, but staged files are:`n$stagedPaths"
    }

    Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('var', 'GIT_AUTHOR_IDENT') -Description 'Checking Git commit identity' | Out-Null
    Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('commit', '-m', "Release $($preflight.Tag)") -Description 'Creating release commit' | Out-Null
    $CompletedSteps.Add('Release commit created')

    Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('tag', '-a', $preflight.Tag, '-m', "Release $($preflight.Tag)") -Description 'Creating release tag' | Out-Null
    $releaseCommit = Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('rev-parse', 'HEAD') -Description 'Reading release commit'
    $tagCommit = Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('rev-parse', "$($preflight.Tag)^{commit}") -Description 'Verifying release tag target'
    if ($tagCommit -ne $releaseCommit) {
        throw "Tag $($preflight.Tag) does not point to the release commit."
    }
    $CompletedSteps.Add("Tag $($preflight.Tag) created and verified against the release commit")

    Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('push', 'origin', $ReleaseBranch) -Description 'Pushing release commit' | Out-Null
    $CompletedSteps.Add('Release commit pushed')

    Invoke-RepositoryGitCommand -GitPath $preflight.GitPath -Arguments @('push', 'origin', $preflight.Tag) -Description 'Pushing release tag' | Out-Null
    $CompletedSteps.Add("Tag $($preflight.Tag) pushed")

    # Pass the extracted Unreleased content as a file to preserve Markdown formatting in GitHub.
    $ReleaseNotesPath = Join-Path ([System.IO.Path]::GetTempPath()) "SmartWindowSize-release-notes-$([guid]::NewGuid().ToString('N')).md"
    [System.IO.File]::WriteAllText($ReleaseNotesPath, $preflight.Unreleased.Notes, [System.Text.UTF8Encoding]::new($false))
    $releaseUrl = Invoke-NativeCommand -Executable $preflight.GhPath -Arguments @('release', 'create', $preflight.Tag, $packagePaths[0], $packagePaths[1], '--repo', $ExpectedRepository, '--title', "Smart Window Size $($preflight.Tag)", '--draft', '--notes-file', $ReleaseNotesPath) -Description 'Creating GitHub Draft Release'
    $CompletedSteps.Add('GitHub Draft Release created with Chrome and Firefox ZIP assets')

    Write-Host ''
    Write-Host 'RELEASE DRAFT CREATED'
    Write-Host "Version: $($preflight.Version)"
    Write-Host "Tag: $($preflight.Tag)"
    Write-Host "Chrome: $($packagePaths[0])"
    Write-Host "Firefox: $($packagePaths[1])"
    Write-Host "GitHub: $releaseUrl"
    Write-Host 'Review and publish the Draft Release manually on GitHub.'
}
catch {
    Write-Host ''
    Write-Host 'RELEASE STOPPED'
    if ($CompletedSteps.Count -gt 0) {
        Write-Host 'Completed steps:'
        $CompletedSteps | ForEach-Object { Write-Host "- $_" }
    }
    else {
        Write-Host 'No release commit, tag, push, or GitHub Release was created.'
    }

    Write-Host "$($_.Exception.Message)`n$($_.ScriptStackTrace)"
    exit 1
}
finally {
    if ($null -ne $ReleaseNotesPath -and (Test-Path -LiteralPath $ReleaseNotesPath)) {
        Remove-Item -LiteralPath $ReleaseNotesPath -Force
    }

    if ($null -ne $DryRunInstallRoot -and (Test-Path -LiteralPath $DryRunInstallRoot)) {
        Remove-Item -LiteralPath $DryRunInstallRoot -Recurse -Force
    }
}
