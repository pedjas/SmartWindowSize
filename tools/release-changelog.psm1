<#
.SYNOPSIS
Parses SmartWindowSize commit milestones and the # Released boundary.

.DESCRIPTION
Owns changelog parsing used by normal commits and guarded official releases.
#>

Set-StrictMode -Version Latest


<#
.SYNOPSIS
Reads the canonical changelog layout shared by commit and release workflows.

.PARAMETER ChangelogPath
Root CHANGELOG.md to validate.
#>
function Get-ChangelogState {
    param([Parameter(Mandatory)][string]$ChangelogPath)

    if (-not (Test-Path -LiteralPath $ChangelogPath -PathType Leaf)) { throw "Required changelog is missing: $ChangelogPath" }
    $content = Get-Content -LiteralPath $ChangelogPath -Raw
    if ($content -notmatch '\A# CHANGELOG\r?\n') { throw 'CHANGELOG.md must begin with # CHANGELOG.' }
    if ($content -match '(?m)^## Unreleased\s*$') { throw 'CHANGELOG.md must not contain ## Unreleased.' }
    $markerMatches = [regex]::Matches($content, '(?m)^# Released\s*$')
    if ($markerMatches.Count -ne 1) { throw 'CHANGELOG.md must contain exactly one # Released marker.' }

    $marker = $markerMatches[0]
    $headerEnd = [regex]::Match($content, '\A# CHANGELOG\r?\n').Length
    $aboveMarker = $content.Substring($headerEnd, $marker.Index - $headerEnd)
    $sectionMatches = [regex]::Matches($aboveMarker, '(?m)^## (?<version>\d+\.\d+\.\d+) - (?<date>\d{4}-\d{2}-\d{2})\s*$')
    $firstSectionIndex = if ($sectionMatches.Count -gt 0) { $sectionMatches[0].Index } else { $aboveMarker.Length }
    $pendingNotes = $aboveMarker.Substring(0, $firstSectionIndex).Trim()
    if (-not [string]::IsNullOrWhiteSpace($pendingNotes)) {
        $remaining = [regex]::Replace($pendingNotes, '(?m)^-\s+\S.*(?:\r?\n[ \t]+\S.*)*', '')
        if ($remaining -match '\S') { throw 'Only unheaded bullet entries may appear before the first committed version milestone.' }
    }

    $milestones = [System.Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $sectionMatches.Count; $index++) {
        $match = $sectionMatches[$index]
        $endIndex = if ($index + 1 -lt $sectionMatches.Count) { $sectionMatches[$index + 1].Index } else { $aboveMarker.Length }
        $milestones.Add([pscustomobject]@{
            Version = $match.Groups['version'].Value
            Date = $match.Groups['date'].Value
            Block = ($aboveMarker.Substring($match.Index, $endIndex - $match.Index) -replace "`r?`n", "`r`n").Trim()
        })
    }

    $unreleasedText = if ($milestones.Count -gt 0) { ($milestones | ForEach-Object { $_.Block }) -join "`r`n`r`n" } else { '' }
    $history = $content.Substring($marker.Index + $marker.Length).Trim()
    return [pscustomobject]@{ Content = $content; PendingNotes = $pendingNotes; Milestones = $milestones; UnreleasedText = $unreleasedText; ReleasedHistory = $history }
}


<#
.SYNOPSIS
Returns unheaded pending bullets that must be closed during a normal code commit.
#>
function Get-PendingChangelogEntries {
    param([Parameter(Mandatory)][string]$ChangelogPath)
    return Get-ChangelogState -ChangelogPath $ChangelogPath
}


<#
.SYNOPSIS
Writes one current-version commit milestone from the captured pending bullets.
#>
function Write-CommitMilestoneChangelog {
    param(
        [Parameter(Mandatory)][string]$ChangelogPath,
        [Parameter(Mandatory)][pscustomobject]$PendingEntries,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$CommitDate
    )

    if ([string]::IsNullOrWhiteSpace($PendingEntries.PendingNotes)) { throw 'CHANGELOG.md has no pending entries to assign to a committed milestone.' }
    if ($Version -notmatch '^\d+\.\d+\.\d+$' -or $CommitDate -notmatch '^\d{4}-\d{2}-\d{2}$') { throw 'Commit milestone version and date must use X.Y.Z and YYYY-MM-DD formats.' }
    if (@($PendingEntries.Milestones | Where-Object { $_.Version -eq $Version }).Count -gt 0 -or $PendingEntries.ReleasedHistory -match "(?m)^## $([regex]::Escape($Version)) - ") { throw "CHANGELOG.md already contains a milestone for version $Version." }

    $notes = ($PendingEntries.PendingNotes -replace "`r?`n", "`r`n").Trim()
    $unreleased = ($PendingEntries.UnreleasedText -replace "`r?`n", "`r`n").Trim()
    $history = ($PendingEntries.ReleasedHistory -replace "`r?`n", "`r`n").Trim()
    $updated = "# CHANGELOG`r`n`r`n## $Version - $CommitDate`r`n`r`n$notes"
    if (-not [string]::IsNullOrWhiteSpace($unreleased)) { $updated += "`r`n`r`n$unreleased" }
    $updated += "`r`n`r`n# Released"
    if (-not [string]::IsNullOrWhiteSpace($history)) { $updated += "`r`n`r`n$history" }
    [System.IO.File]::WriteAllText($ChangelogPath, "$updated`r`n", [System.Text.UTF8Encoding]::new($false))
}


<#
.SYNOPSIS
Captures committed unreleased milestone blocks as the grouped official release body.
#>
function Get-UnreleasedMilestoneSections {
    param([Parameter(Mandatory)][string]$ChangelogPath, [Parameter(Mandatory)][string]$Version)

    $state = Get-ChangelogState -ChangelogPath $ChangelogPath
    if (-not [string]::IsNullOrWhiteSpace($state.PendingNotes)) { throw 'CHANGELOG.md contains pending changes that have not yet been assigned to a committed version milestone. Commit the current development work before releasing.' }
    if ($state.Milestones.Count -eq 0) { throw 'CHANGELOG.md must contain at least one committed version milestone above # Released before releasing.' }
    if (@($state.Milestones | Where-Object { $_.Version -eq $Version }).Count -eq 0) { throw "CHANGELOG.md must contain the current release version $Version as an unreleased committed milestone." }
    if ($state.ReleasedHistory -match "(?m)^## $([regex]::Escape($Version)) - ") { throw "CHANGELOG.md already contains a released section for version $Version." }
    return $state
}


<#
.SYNOPSIS
Moves # Released over captured milestone blocks after a successful official release.
#>
function Move-ReleasedMarker {
    param([Parameter(Mandatory)][string]$ChangelogPath, [Parameter(Mandatory)][pscustomobject]$UnreleasedMilestones)

    $unreleased = ($UnreleasedMilestones.UnreleasedText -replace "`r?`n", "`r`n").Trim()
    $history = ($UnreleasedMilestones.ReleasedHistory -replace "`r?`n", "`r`n").Trim()
    if ([string]::IsNullOrWhiteSpace($unreleased)) { throw 'Cannot move # Released because no unreleased milestone blocks were captured.' }
    $updated = "# CHANGELOG`r`n`r`n# Released`r`n`r`n$unreleased"
    if (-not [string]::IsNullOrWhiteSpace($history)) { $updated += "`r`n`r`n$history" }
    [System.IO.File]::WriteAllText($ChangelogPath, "$updated`r`n", [System.Text.UTF8Encoding]::new($false))
}


Export-ModuleMember -Function Get-PendingChangelogEntries, Write-CommitMilestoneChangelog, Get-UnreleasedMilestoneSections, Move-ReleasedMarker
