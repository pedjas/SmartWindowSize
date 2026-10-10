<#
.SYNOPSIS
Validates the intentional SmartWindowSize source version mirrors.

.DESCRIPTION
Root manifest.json is the product, package, and release-version authority.
This module validates source mirrors only. Generated package manifests remain
the responsibility of package-output verification after a build.
#>

Set-StrictMode -Version Latest


function New-VersionConsistencyDiagnostic {
    param([Parameter(Mandatory)][string]$File, [Parameter(Mandatory)][string]$Field, [Parameter(Mandatory)][string]$Expected, [Parameter(Mandatory)][string]$Actual)
    return "${File} ${Field}: expected $Expected; found $Actual."
}


function Test-VersionConsistency {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $root = [System.IO.Path]::GetFullPath($ProjectRoot)
    $diagnostics = [System.Collections.Generic.List[string]]::new()
    $paths = [ordered]@{
        Manifest = Join-Path $root 'manifest.json'
        AppVersion = Join-Path $root 'core/app-version.js'
        ServiceWorker = Join-Path $root 'background/service-worker.js'
        FirefoxTemplate = Join-Path $root 'manifests/firefox.manifest.json.template'
    }

    if (-not (Test-Path -LiteralPath $paths.Manifest -PathType Leaf)) {
        $diagnostics.Add((New-VersionConsistencyDiagnostic -File 'manifest.json' -Field 'source' -Expected 'readable file' -Actual 'missing'))
        return [pscustomobject]@{ IsValid = $false; Version = $null; Diagnostics = @($diagnostics) }
    }
    try { $manifest = Get-Content -LiteralPath $paths.Manifest -Raw | ConvertFrom-Json }
    catch {
        $diagnostics.Add((New-VersionConsistencyDiagnostic -File 'manifest.json' -Field 'JSON' -Expected 'valid JSON' -Actual $_.Exception.Message))
        return [pscustomobject]@{ IsValid = $false; Version = $null; Diagnostics = @($diagnostics) }
    }

    $version = [string]$manifest.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
        $actual = if ([string]::IsNullOrWhiteSpace($version)) { 'missing' } else { $version }
        $diagnostics.Add((New-VersionConsistencyDiagnostic -File 'manifest.json' -Field 'version' -Expected 'X.Y.Z' -Actual $actual))
        return [pscustomobject]@{ IsValid = $false; Version = $null; Diagnostics = @($diagnostics) }
    }

    $actionTitle = [string]$manifest.action.default_title
    $titleMatch = [regex]::Match($actionTitle, 'SmartWindowSize\s+(?<version>\d+\.\d+\.\d+)\s*:')
    if (-not $titleMatch.Success) {
        $actual = if ([string]::IsNullOrWhiteSpace($actionTitle)) { 'missing' } else { $actionTitle }
        $diagnostics.Add((New-VersionConsistencyDiagnostic -File 'manifest.json' -Field 'action.default_title version' -Expected $version -Actual $actual))
    }
    elseif ($titleMatch.Groups['version'].Value -ne $version) {
        $diagnostics.Add((New-VersionConsistencyDiagnostic -File 'manifest.json' -Field 'action.default_title version' -Expected $version -Actual $titleMatch.Groups['version'].Value))
    }

    foreach ($source in @(
        [pscustomobject]@{ Path = $paths.AppVersion; File = 'core/app-version.js'; RequireAppVersion = $true },
        [pscustomobject]@{ Path = $paths.ServiceWorker; File = 'background/service-worker.js'; RequireAppVersion = $false }
    )) {
        if (-not (Test-Path -LiteralPath $source.Path -PathType Leaf)) {
            $diagnostics.Add((New-VersionConsistencyDiagnostic -File $source.File -Field 'source' -Expected 'readable file' -Actual 'missing'))
            continue
        }
        $contents = Get-Content -LiteralPath $source.Path -Raw
        if ($source.RequireAppVersion) {
            $appVersionMatch = [regex]::Match($contents, 'export\s+const\s+APP_VERSION\s*=\s*["''](?<version>[^"'']+)["''];')
            if (-not $appVersionMatch.Success) {
                $diagnostics.Add((New-VersionConsistencyDiagnostic -File $source.File -Field 'APP_VERSION export' -Expected $version -Actual 'missing'))
            }
            elseif ($appVersionMatch.Groups['version'].Value -ne $version) {
                $diagnostics.Add((New-VersionConsistencyDiagnostic -File $source.File -Field 'APP_VERSION' -Expected $version -Actual $appVersionMatch.Groups['version'].Value))
            }
        }
        $headerMatch = [regex]::Match($contents, '(?m)SmartWindowSize\s*\|\s*Version:\s*(?<version>[^|\r\n*]+)')
        if (-not $headerMatch.Success) {
            $diagnostics.Add((New-VersionConsistencyDiagnostic -File $source.File -Field 'source header version' -Expected $version -Actual 'missing'))
        }
        elseif ($headerMatch.Groups['version'].Value.Trim() -ne $version) {
            $diagnostics.Add((New-VersionConsistencyDiagnostic -File $source.File -Field 'source header version' -Expected $version -Actual $headerMatch.Groups['version'].Value.Trim()))
        }
    }

    if (-not (Test-Path -LiteralPath $paths.FirefoxTemplate -PathType Leaf)) {
        $diagnostics.Add((New-VersionConsistencyDiagnostic -File 'manifests/firefox.manifest.json.template' -Field 'source' -Expected 'readable file with __VERSION__ placeholder' -Actual 'missing'))
    }
    else {
        try { $firefoxTemplate = Get-Content -LiteralPath $paths.FirefoxTemplate -Raw | ConvertFrom-Json }
        catch {
            $diagnostics.Add((New-VersionConsistencyDiagnostic -File 'manifests/firefox.manifest.json.template' -Field 'JSON' -Expected 'valid JSON with __VERSION__ placeholder' -Actual $_.Exception.Message))
            $firefoxTemplate = $null
        }
        if ($null -ne $firefoxTemplate -and $firefoxTemplate.version -ne '__VERSION__') {
            $actual = if ([string]::IsNullOrWhiteSpace([string]$firefoxTemplate.version)) { 'missing' } else { [string]$firefoxTemplate.version }
            $diagnostics.Add((New-VersionConsistencyDiagnostic -File 'manifests/firefox.manifest.json.template' -Field 'version placeholder' -Expected '__VERSION__' -Actual $actual))
        }
    }

    return [pscustomobject]@{ IsValid = ($diagnostics.Count -eq 0); Version = $version; Diagnostics = @($diagnostics) }
}


function Assert-VersionConsistency {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $result = Test-VersionConsistency -ProjectRoot $ProjectRoot
    if (-not $result.IsValid) {
        throw "Version consistency validation failed:
$($result.Diagnostics | ForEach-Object { "- $_" } | Out-String)"
    }
    return $result
}


Export-ModuleMember -Function Assert-VersionConsistency, Test-VersionConsistency
