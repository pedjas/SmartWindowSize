<# Focused fixture tests for the shared PowerShell version validator. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot 'version-consistency.psm1'
Import-Module $modulePath -Force

function New-VersionFixture {
    param([hashtable]$Files = @{})
    $root = Join-Path ([System.IO.Path]::GetTempPath()) "SmartWindowSize-version-test-$([guid]::NewGuid().ToString('N'))"
    $defaults = [ordered]@{
        'manifest.json' = '{"version":"1.1.25","action":{"default_title":"SmartWindowSize 1.1.25: enabled"}}'
        'core/app-version.js' = '/** SmartWindowSize | Version: 1.1.25 | Last updated: now */' + "`r`n" + 'export const APP_VERSION = "1.1.25";' + "`r`n"
        'background/service-worker.js' = '/** SmartWindowSize | Version: 1.1.25 | Last updated: now */' + "`r`n"
        'manifests/firefox.manifest.json.template' = '{"version":"__VERSION__"}'
    }
    foreach ($name in $Files.Keys) { $defaults[$name] = $Files[$name] }
    foreach ($name in $defaults.Keys) {
        $path = Join-Path $root $name
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        [System.IO.File]::WriteAllText($path, $defaults[$name], [System.Text.UTF8Encoding]::new($false))
    }
    return $root
}

function Invoke-VersionFixtureTest {
    param([hashtable]$Files, [scriptblock]$Assertion)
    $root = New-VersionFixture -Files $Files
    try { & $Assertion $root } finally { Remove-Item -LiteralPath $root -Recurse -Force }
}

Invoke-VersionFixtureTest -Files @{} -Assertion {
    param($root)
    $result = Test-VersionConsistency -ProjectRoot $root
    if (-not $result.IsValid -or $result.Version -ne '1.1.25') { throw 'Matching source mirrors should pass validation.' }
}

Invoke-VersionFixtureTest -Files @{
    'manifest.json' = '{"version":"1.1.25","action":{"default_title":"SmartWindowSize 1.1.24: enabled"}}'
    'core/app-version.js' = '/** SmartWindowSize | Version: 1.1.24 | Last updated: now */' + "`r`n" + 'export const APP_VERSION = "1.1.24";'
    'background/service-worker.js' = '/** SmartWindowSize | Version: 1.1.24 | Last updated: now */'
    'manifests/firefox.manifest.json.template' = '{"version":"1.1.24"}'
} -Assertion {
    param($root)
    $result = Test-VersionConsistency -ProjectRoot $root
    $report = $result.Diagnostics -join "
"
    foreach ($required in @('action.default_title version', 'APP_VERSION', 'core/app-version.js source header version', 'background/service-worker.js source header version', 'version placeholder')) {
        if ($report -notmatch [regex]::Escape($required)) { throw "Missing expected diagnostic: $required" }
    }
}

Invoke-VersionFixtureTest -Files @{ 'core/app-version.js' = 'export const OTHER_VERSION = "1.1.25";'; 'background/service-worker.js' = 'export {};' } -Assertion {
    param($root)
    $result = Test-VersionConsistency -ProjectRoot $root
    if ($result.IsValid) { throw 'Missing required metadata should fail validation.' }
}

Invoke-VersionFixtureTest -Files @{ 'install/SmartWindowSize-Chrome/manifest.json' = '{"version":"0.0.1"}' } -Assertion {
    param($root)
    $result = Test-VersionConsistency -ProjectRoot $root
    if (-not $result.IsValid) { throw 'Stale generated package output must not affect source validation.' }
}

Write-Host 'Version consistency PowerShell tests passed.'
