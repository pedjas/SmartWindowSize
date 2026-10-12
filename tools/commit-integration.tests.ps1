<# Real disposable-repository integration checks for coordinated commits. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$git = (Get-Command git -ErrorAction Stop).Source
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "SmartWindowSize-commit-integration-$([guid]::NewGuid().ToString('N'))"

function Write-TestFile {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, ($Content -replace "`r?`n", "`r`n"), [Text.UTF8Encoding]::new($false))
}

function Invoke-TestGit {
    param([string]$Repository, [string[]]$ArgumentList)
    $output = @(& $git -C $Repository @ArgumentList)
    if ($LASTEXITCODE -ne 0) { throw "git $($ArgumentList -join ' ') failed: $($output -join [Environment]::NewLine)" }
    return $output
}

function Copy-CommitTools {
    param([string]$SourceRoot)
    foreach ($name in @('commit.ps1', 'commit-milestone.ps1', 'git-workflow.psm1', 'release-changelog.psm1', 'version-consistency.psm1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $SourceRoot "tools/$name")
    }
}

function New-CommitFixture {
    param([string]$Name)
    $source = Join-Path $testRoot $Name
    $docs = Join-Path $source 'project-docs'
    New-Item -ItemType Directory -Path (Join-Path $source 'tools'), (Join-Path $source 'core'), (Join-Path $source 'background'), (Join-Path $source 'manifests'), $docs -Force | Out-Null
    Copy-CommitTools -SourceRoot $source
    Write-TestFile -Path (Join-Path $source '.gitignore') -Content "project-docs/"
    Write-TestFile -Path (Join-Path $source 'manifest.json') -Content '{"version":"1.2.14","action":{"default_title":"SmartWindowSize 1.2.14: enabled"}}'
    Write-TestFile -Path (Join-Path $source 'core/app-version.js') -Content ('/** SmartWindowSize | Version: 1.2.14 | Last updated: now */' + "`n" + 'export const APP_VERSION = "1.2.14";')
    Write-TestFile -Path (Join-Path $source 'background/service-worker.js') -Content '/** SmartWindowSize | Version: 1.2.14 | Last updated: now */'
    Write-TestFile -Path (Join-Path $source 'manifests/firefox.manifest.json.template') -Content '{"version":"__VERSION__"}'
    Write-TestFile -Path (Join-Path $source 'CHANGELOG.md') -Content "# CHANGELOG`n`n- Fixture pending source milestone.`n`n# Released`n`n## 1.0.0 - 2026-01-01`n- Fixture."
    Invoke-TestGit -Repository $source -ArgumentList @('init', '-q') | Out-Null
    Invoke-TestGit -Repository $source -ArgumentList @('config', 'user.email', 'commit-test@example.invalid') | Out-Null
    Invoke-TestGit -Repository $source -ArgumentList @('config', 'user.name', 'Commit Test') | Out-Null
    Invoke-TestGit -Repository $source -ArgumentList @('add', '--', '.') | Out-Null
    Invoke-TestGit -Repository $source -ArgumentList @('commit', '-qm', 'source base') | Out-Null
    Invoke-TestGit -Repository $docs -ArgumentList @('init', '-q') | Out-Null
    Invoke-TestGit -Repository $docs -ArgumentList @('config', 'user.email', 'commit-test@example.invalid') | Out-Null
    Invoke-TestGit -Repository $docs -ArgumentList @('config', 'user.name', 'Commit Test') | Out-Null
    Write-TestFile -Path (Join-Path $docs 'MANUAL-TESTS.md') -Content 'base manual'
    Write-TestFile -Path (Join-Path $docs 'nested/SMOKE-TESTS.md') -Content 'base nested'
    Write-TestFile -Path (Join-Path $docs 'file with spaces.md') -Content 'base spaces'
    Invoke-TestGit -Repository $docs -ArgumentList @('add', '--', '.') | Out-Null
    Invoke-TestGit -Repository $docs -ArgumentList @('commit', '-qm', 'docs base') | Out-Null
    return [pscustomobject]@{ Source = $source; Docs = $docs }
}

function Add-SourceDeletion {
    param([pscustomobject]$Fixture)
    Write-TestFile -Path (Join-Path $Fixture.Source 'retired.txt') -Content 'retired source file'
    Invoke-TestGit -Repository $Fixture.Source -ArgumentList @('add', '--', 'retired.txt') | Out-Null
    Invoke-TestGit -Repository $Fixture.Source -ArgumentList @('commit', '-qm', 'track retired source file') | Out-Null
    Remove-Item -LiteralPath (Join-Path $Fixture.Source 'retired.txt')
}

function Add-DocumentationChanges {
    param([pscustomobject]$Fixture)
    Write-TestFile -Path (Join-Path $Fixture.Docs 'MANUAL-TESTS.md') -Content 'changed manual'
    Write-TestFile -Path (Join-Path $Fixture.Docs 'nested/SMOKE-TESTS.md') -Content 'changed nested'
    Write-TestFile -Path (Join-Path $Fixture.Docs 'file with spaces.md') -Content 'changed spaces'
    Write-TestFile -Path (Join-Path $Fixture.Docs 'SMART-WINDOW-SIZE-HANDOFF-2026-10-10.md') -Content 'new handoff'
}

function Invoke-CommitWorkflow {
    param([pscustomobject]$Fixture, [switch]$WhatIf, [switch]$AllowFailure)
    $arguments = @('-NoProfile', '-File', (Join-Path $Fixture.Source 'tools/commit.ps1'))
    if ($WhatIf) { $arguments += '-WhatIf' }
    $output = @(& $pwsh @arguments 2>&1 | ForEach-Object ToString)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) { throw "Coordinated commit failed: $($output -join [Environment]::NewLine)" }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output -join [Environment]::NewLine }
}

function Assert-CleanRepository {
    param([string]$Repository)
    $status = @(Invoke-TestGit -Repository $Repository -ArgumentList @('status', '--porcelain=v1', '--untracked-files=all'))
    if ($status.Count -ne 0) { throw "Repository was not clean: $Repository" }
}

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null

    $docsOnly = New-CommitFixture -Name 'docs-only'
    Add-DocumentationChanges -Fixture $docsOnly
    $sourceBefore = @(Invoke-TestGit -Repository $docsOnly.Source -ArgumentList @('rev-parse', 'HEAD'))[0]
    $docsBefore = @(Invoke-TestGit -Repository $docsOnly.Docs -ArgumentList @('rev-parse', 'HEAD'))[0]
    $result = Invoke-CommitWorkflow -Fixture $docsOnly
    if ($result.Output -notmatch 'Source: clean; skipped' -or $result.Output -notmatch 'Documentation: would commit') { throw 'Docs-only plan did not report source skip and documentation commit.' }
    if (@(Invoke-TestGit -Repository $docsOnly.Source -ArgumentList @('rev-parse', 'HEAD'))[0] -ne $sourceBefore) { throw 'Docs-only commit must not create a source commit.' }
    if (@(Invoke-TestGit -Repository $docsOnly.Docs -ArgumentList @('rev-parse', 'HEAD'))[0] -eq $docsBefore) { throw 'Docs-only commit must create a documentation commit.' }
    $committedDocs = @(Invoke-TestGit -Repository $docsOnly.Docs -ArgumentList @('show', '--format=', '--name-only', 'HEAD'))
    foreach ($path in @('MANUAL-TESTS.md', 'nested/SMOKE-TESTS.md', 'file with spaces.md', 'SMART-WINDOW-SIZE-HANDOFF-2026-10-10.md')) { if ($committedDocs -notcontains $path) { throw "Documentation commit omitted '$path'." } }
    if ($committedDocs.Count -ne 4) { throw 'Documentation commit staged an unexpected path.' }
    Assert-CleanRepository -Repository $docsOnly.Docs

    $both = New-CommitFixture -Name 'both'
    Add-DocumentationChanges -Fixture $both
    Add-SourceDeletion -Fixture $both
    Write-TestFile -Path (Join-Path $both.Source 'core/tooling-change.js') -Content 'export const toolingChange = true;'
    $sourceBefore = @(Invoke-TestGit -Repository $both.Source -ArgumentList @('rev-parse', 'HEAD'))[0]
    $docsBefore = @(Invoke-TestGit -Repository $both.Docs -ArgumentList @('rev-parse', 'HEAD'))[0]
    $result = Invoke-CommitWorkflow -Fixture $both
    $sourceAfter = @(Invoke-TestGit -Repository $both.Source -ArgumentList @('rev-parse', 'HEAD'))[0]
    $docsAfter = @(Invoke-TestGit -Repository $both.Docs -ArgumentList @('rev-parse', 'HEAD'))[0]
    if ($sourceAfter -eq $sourceBefore -or $docsAfter -eq $docsBefore) { throw 'Both-dirty commit must create separate source and documentation commits.' }
    $sourceSubject = @(Invoke-TestGit -Repository $both.Source -ArgumentList @('log', '-1', '--format=%s'))[0]
    $docsSubject = @(Invoke-TestGit -Repository $both.Docs -ArgumentList @('log', '-1', '--format=%s'))[0]
    $sourceShortHash = @(Invoke-TestGit -Repository $both.Source -ArgumentList @('rev-parse', '--short', 'HEAD'))[0]
    $docsShortHash = @(Invoke-TestGit -Repository $both.Docs -ArgumentList @('rev-parse', '--short', 'HEAD'))[0]
    $sourceReport = "(?s)Source\s+commit:\s+$([regex]::Escape($sourceShortHash))\s+subject:\s+$([regex]::Escape($sourceSubject))"
    $docsReport = "(?s)Documentation\s+commit:\s+$([regex]::Escape($docsShortHash))\s+subject:\s+$([regex]::Escape($docsSubject))"
    if ($result.Output -notmatch $sourceReport -or $result.Output -notmatch $docsReport -or $result.Output -notmatch '(?s)Result\s+Source:\s+committed\s+Documentation:\s+committed\s+Nothing pushed\.') {
        throw 'Both-dirty result omitted the completed commit reporting summary.'
    }
    Assert-CleanRepository -Repository $both.Source; Assert-CleanRepository -Repository $both.Docs

    $zeroSuccessFailure = New-CommitFixture -Name 'zero-success-failure'
    Add-SourceDeletion -Fixture $zeroSuccessFailure
    Write-TestFile -Path (Join-Path $zeroSuccessFailure.Source 'hooks/pre-commit') -Content "#!/bin/sh`nexit 1"
    Invoke-TestGit -Repository $zeroSuccessFailure.Source -ArgumentList @('config', 'core.hooksPath', 'hooks') | Out-Null
    $result = Invoke-CommitWorkflow -Fixture $zeroSuccessFailure -AllowFailure
    if ($result.ExitCode -eq 0 -or $result.Output -notmatch 'Coordinated commit stopped after: none\. No rollback was performed\.' -or $result.Output -match "property 'Name' cannot be found") {
        throw 'A zero-success source failure must report no completed commits without a StrictMode property error.'
    }

    $dryRun = New-CommitFixture -Name 'dry-run'
    Add-DocumentationChanges -Fixture $dryRun
    $docsBefore = @(Invoke-TestGit -Repository $dryRun.Docs -ArgumentList @('rev-parse', 'HEAD'))[0]
    $result = Invoke-CommitWorkflow -Fixture $dryRun -WhatIf
    if ($result.Output -notmatch 'Documentation: would commit' -or $result.Output -match 'commit:\s+[0-9a-f]+') { throw 'Dry run must plan without reporting a created commit.' }
    if (@(Invoke-TestGit -Repository $dryRun.Docs -ArgumentList @('rev-parse', 'HEAD'))[0] -ne $docsBefore) { throw 'Dry run must not create a documentation commit.' }

    $clean = New-CommitFixture -Name 'clean'
    $sourceBefore = @(Invoke-TestGit -Repository $clean.Source -ArgumentList @('rev-parse', 'HEAD'))[0]
    $docsBefore = @(Invoke-TestGit -Repository $clean.Docs -ArgumentList @('rev-parse', 'HEAD'))[0]
    Invoke-CommitWorkflow -Fixture $clean | Out-Null
    if (@(Invoke-TestGit -Repository $clean.Source -ArgumentList @('rev-parse', 'HEAD'))[0] -ne $sourceBefore -or @(Invoke-TestGit -Repository $clean.Docs -ArgumentList @('rev-parse', 'HEAD'))[0] -ne $docsBefore) { throw 'A clean coordinated commit must not create an empty commit.' }

    $partial = New-CommitFixture -Name 'partial'
    Add-DocumentationChanges -Fixture $partial
    Write-TestFile -Path (Join-Path $partial.Source 'core/tooling-change.js') -Content 'export const toolingChange = true;'
    $sourceBefore = @(Invoke-TestGit -Repository $partial.Source -ArgumentList @('rev-parse', 'HEAD'))[0]
    $docsBefore = @(Invoke-TestGit -Repository $partial.Docs -ArgumentList @('rev-parse', 'HEAD'))[0]
    Write-TestFile -Path (Join-Path $partial.Docs 'hooks/pre-commit') -Content "#!/bin/sh`nexit 1"
    Invoke-TestGit -Repository $partial.Docs -ArgumentList @('config', 'core.hooksPath', 'hooks') | Out-Null
    $result = Invoke-CommitWorkflow -Fixture $partial -AllowFailure
    $sourceAfter = @(Invoke-TestGit -Repository $partial.Source -ArgumentList @('rev-parse', 'HEAD'))[0]
    $docsAfter = @(Invoke-TestGit -Repository $partial.Docs -ArgumentList @('rev-parse', 'HEAD'))[0]
    if ($result.ExitCode -eq 0 -or $sourceAfter -eq $sourceBefore -or $docsAfter -ne $docsBefore) { throw 'Partial failure fixture must retain only the completed source commit.' }
    $sourceShortHash = @(Invoke-TestGit -Repository $partial.Source -ArgumentList @('rev-parse', '--short', 'HEAD'))[0]
    $sourceSubject = @(Invoke-TestGit -Repository $partial.Source -ArgumentList @('log', '-1', '--format=%s'))[0]
    $sourceReport = "(?s)Source\s+commit:\s+$([regex]::Escape($sourceShortHash))\s+subject:\s+$([regex]::Escape($sourceSubject))"
    if ($result.Output -notmatch $sourceReport -or $result.Output -notmatch 'Coordinated commit stopped after: Source' -or $result.Output -notmatch 'No rollback was performed\.') {
        throw 'Partial-failure result omitted the completed source commit or no-rollback reporting.'
    }
    Assert-CleanRepository -Repository $partial.Source
    Write-Host 'Coordinated commit disposable-repository integration tests passed.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
