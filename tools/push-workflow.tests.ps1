<# Focused policy tests for the coordinated push workflow; no remote is contacted. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'push-workflow.psm1') -Force

function New-PushState {
    param([string]$Name, [int]$Ahead = 0, [int]$Behind = 0, [string]$Status = '')
    return [pscustomobject]@{ Name = $Name; Ahead = $Ahead; Behind = $Behind; Status = $Status; Branch = 'test'; Upstream = 'origin/test'; Remote = 'origin'; Path = 'test' }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Expected)
    try { & $Action } catch { if ($_.Exception.Message -match [regex]::Escape($Expected)) { return }; throw "Expected '$Expected', got '$($_.Exception.Message)'" }
    throw "Expected failure containing '$Expected'."
}

$bothAhead = Get-CoordinatedPushPlan -Repository @((New-PushState Source -Ahead 2), (New-PushState Documentation -Ahead 1))
if (($bothAhead.Action -join ',') -ne 'push,push') { throw 'Both ahead repositories must be planned for push.' }

$oneAhead = Get-CoordinatedPushPlan -Repository @((New-PushState Source -Ahead 1), (New-PushState Documentation))
if (($oneAhead.Action -join ',') -ne 'push,skip') { throw 'A synchronized repository must be skipped.' }

$synchronized = Get-CoordinatedPushPlan -Repository @((New-PushState Source), (New-PushState Documentation))
if (($synchronized.Action -join ',') -ne 'skip,skip') { throw 'Both synchronized repositories must be skipped.' }

Assert-Throws -Expected 'Source' -Action { Get-CoordinatedPushPlan -Repository @((New-PushState Source -Status ' M file'), (New-PushState Documentation -Ahead 1)) | Out-Null }
Assert-Throws -Expected 'Documentation' -Action { Get-CoordinatedPushPlan -Repository @((New-PushState Source -Ahead 1), (New-PushState Documentation -Status '?? file')) | Out-Null }
Assert-Throws -Expected 'behind or diverged' -Action { Get-CoordinatedPushPlan -Repository @((New-PushState Source -Behind 1), (New-PushState Documentation)) | Out-Null }
Assert-Throws -Expected 'behind or diverged' -Action { Get-CoordinatedPushPlan -Repository @((New-PushState Source -Ahead 1 -Behind 1), (New-PushState Documentation)) | Out-Null }

$missingUpstreamRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SmartWindowSize-push-test-$([guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Path $missingUpstreamRoot | Out-Null
    & git -C $missingUpstreamRoot init -q
    & git -C $missingUpstreamRoot config user.email push-test@example.invalid
    & git -C $missingUpstreamRoot config user.name PushTest
    [System.IO.File]::WriteAllText((Join-Path $missingUpstreamRoot 'fixture.txt'), 'fixture', [System.Text.UTF8Encoding]::new($false))
    & git -C $missingUpstreamRoot add -- fixture.txt
    & git -C $missingUpstreamRoot commit -qm fixture
    Assert-Throws -Expected 'no usable configured upstream' -Action { Get-PushRepositoryState -GitPath (Get-Command git).Source -RepositoryPath $missingUpstreamRoot -Name Fixture | Out-Null }
}
finally { if (Test-Path -LiteralPath $missingUpstreamRoot) { Remove-Item -LiteralPath $missingUpstreamRoot -Recurse -Force } }

$pushCalls = [System.Collections.Generic.List[string]]::new()
Invoke-CoordinatedPushPlan -Plan $bothAhead -PushAction { param($repository) $pushCalls.Add($repository.Name) } | Out-Null
if (($pushCalls -join ',') -ne 'Source,Documentation') { throw 'Push plan must call both repositories in order.' }

Assert-Throws -Expected 'Source' -Action {
    Invoke-CoordinatedPushPlan -Plan $bothAhead -PushAction { param($repository) if ($repository.Name -eq 'Documentation') { throw 'simulated remote failure' } } | Out-Null
}

$pushSource = Get-Content (Join-Path $PSScriptRoot 'push.ps1') -Raw
if ($pushSource -notmatch '\[CmdletBinding\(SupportsShouldProcess = \$true\)\]' -or $pushSource -notmatch '\$WhatIfPreference') { throw 'Push script must expose a no-push WhatIf path.' }
if ($pushSource -match "'commit'|'tag'|'rebase'|'merge'|'push', '--force'") { throw 'Push script must not contain prohibited mutating Git operations.' }
if ((Get-Content (Join-Path $PSScriptRoot 'push.bat') -Raw) -notmatch '%~dp0push\.ps1') { throw 'Batch entry point must resolve push.ps1 from its own directory.' }

Write-Host 'Coordinated push workflow PowerShell tests passed.'
