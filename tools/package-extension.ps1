<#
.SYNOPSIS
Builds verified SmartWindowSize installation artifacts for Chromium or Firefox.

.DESCRIPTION
Copies only allowlisted runtime files into install/, writes the target manifest,
creates a ZIP whose root contains manifest.json, and validates the ZIP layout.
#>

[CmdletBinding()]
param(
    [ValidateSet('chromium', 'firefox', 'all')]
    [string]$Target = 'chromium',

    [string]$FirefoxExtensionId = 'SmartWindowSize@pedjas'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<# The repository root derived from this script's known tools/ location. #>
$ProjectRoot = Split-Path -Parent $PSScriptRoot

<# The only runtime directories allowed in a release artifact. #>
$RuntimeDirectories = @('about', 'background', 'context', 'core', 'icons', 'options', 'popup', 'readme-viewer', 'rule-delete', 'size-picker')

<# The generated, Git-ignored release output directory. #>
$InstallRoot = Join-Path $ProjectRoot 'install'

<# The versioned installation instructions copied into every release artifact. #>
$InstallReadmeSource = Join-Path $ProjectRoot 'readme.txt'


<#
.SYNOPSIS
Reads and verifies the single application version shared by source and manifest.

.OUTPUTS
System.String
#>
function Get-ApplicationVersion {
    $manifestPath = Join-Path $ProjectRoot 'manifest.json'
    $versionModulePath = Join-Path $ProjectRoot 'core/app-version.js'
    $manifestVersion = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version
    $versionModule = Get-Content -LiteralPath $versionModulePath -Raw
    $match = [regex]::Match($versionModule, 'APP_VERSION = "([^"]+)"')

    if (-not $match.Success) {
        throw 'The central APP_VERSION value could not be read.'
    }

    $moduleVersion = $match.Groups[1].Value
    if ($manifestVersion -ne $moduleVersion) {
        throw "manifest.json version $manifestVersion does not match APP_VERSION $moduleVersion."
    }

    return $manifestVersion
}


<#
.SYNOPSIS
Creates a clean release directory from the approved runtime file list.

.PARAMETER Destination
The empty target directory for the unpacked extension.

.PARAMETER TargetBrowser
The manifest family to write into the target directory.

.PARAMETER Version
The validated application version inserted into a Firefox manifest template.

.PARAMETER GeckoId
The AMO extension identifier required for Firefox packaging.
#>
function New-ReleaseDirectory {
    param(
        [Parameter(Mandatory)]
        [string]$Destination,

        [Parameter(Mandatory)]
        [ValidateSet('chromium', 'firefox')]
        [string]$TargetBrowser,

        [Parameter(Mandatory)]
        [string]$Version,

        [string]$GeckoId
    )

    if (Test-Path -LiteralPath $Destination) {
        # The stable Chromium unpacked directory is intentionally replaced so Brave keeps its local extension ID.
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }

    New-Item -ItemType Directory -Path $Destination | Out-Null

    if (-not (Test-Path -LiteralPath $InstallReadmeSource -PathType Leaf)) {
        throw "Required installation readme is missing: $InstallReadmeSource"
    }

    Copy-Item -LiteralPath $InstallReadmeSource -Destination (Join-Path $Destination 'readme.txt')

    foreach ($directory in $RuntimeDirectories) {
        $source = Join-Path $ProjectRoot $directory
        if (-not (Test-Path -LiteralPath $source -PathType Container)) {
            throw "Required runtime directory is missing: $source"
        }

        Copy-Item -LiteralPath $source -Destination $Destination -Recurse
    }

    $manifestDestination = Join-Path $Destination 'manifest.json'
    if ($TargetBrowser -eq 'chromium') {

        # Firefox uses a separate background entry and it is not shipped in Chromium artifacts.
        Remove-Item -LiteralPath (Join-Path $Destination 'background/firefox-background.js') -Force
        Copy-Item -LiteralPath (Join-Path $ProjectRoot 'manifest.json') -Destination $manifestDestination
        return
    }

    if ([string]::IsNullOrWhiteSpace($GeckoId)) {
        throw 'Firefox packaging requires -FirefoxExtensionId with the AMO Gecko identifier.'
    }

    $templatePath = Join-Path $ProjectRoot 'manifests/firefox.manifest.json.template'
    $template = Get-Content -LiteralPath $templatePath -Raw
    $manifest = $template.Replace('__VERSION__', $Version).Replace('__FIREFOX_EXTENSION_ID__', $GeckoId)
    $parsedManifest = $manifest | ConvertFrom-Json

    if ($parsedManifest.version -ne $Version -or $parsedManifest.permissions -contains 'system.display') {
        throw 'The generated Firefox manifest is invalid for the selected target.'
    }

    [System.IO.File]::WriteAllText($manifestDestination, $manifest.Replace("`r`n", "`n").Replace("`n", "`r`n"), [System.Text.UTF8Encoding]::new($false))
}


<#
.SYNOPSIS
Creates and validates a ZIP whose root is the extension manifest.

.PARAMETER Directory
The prepared unpacked extension directory.

.PARAMETER Archive
The ZIP path to create.
#>
function New-ReleaseArchive {
    param(
        [Parameter(Mandatory)]
        [string]$Directory,

        [Parameter(Mandatory)]
        [string]$Archive
    )

    if (Test-Path -LiteralPath $Archive) {
        throw "Release archive already exists: $Archive. Remove it manually before rebuilding."
    }

    Compress-Archive -Path (Join-Path $Directory '*') -DestinationPath $Archive -CompressionLevel Optimal
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)

    try {
        $entryNames = @($zip.Entries | ForEach-Object FullName)
        if ($entryNames -notcontains 'manifest.json') {
            throw 'The ZIP does not contain manifest.json at its root.'
        }

        if ($entryNames -notcontains 'readme.txt') {
            throw 'The ZIP does not contain readme.txt at its root.'
        }

        if ($entryNames | Where-Object { $_ -match '(^|/)install/' }) {
            throw 'The ZIP must not contain an install/ directory.'
        }
    }
    finally {
        $zip.Dispose()
    }
}


<#
.SYNOPSIS
Builds the unpacked directory and ZIP for one browser target.

.PARAMETER TargetBrowser
The browser manifest family to package.

.PARAMETER Version
The validated application version used in artifact names.

.PARAMETER GeckoId
The Firefox AMO identifier passed to the Firefox manifest template.
#>
function New-TargetRelease {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('chromium', 'firefox')]
        [string]$TargetBrowser,

        [Parameter(Mandatory)]
        [string]$Version,

        [string]$GeckoId
    )

    $suffix = if ($TargetBrowser -eq 'firefox') { '-firefox' } else { '-chrome' }
    $releaseName = "SmartWindowSize-$Version$suffix"
    $directoryName = if ($TargetBrowser -eq 'chromium') { 'SmartWindowSize-chrome' } else { $releaseName }
    $directory = Join-Path $InstallRoot $directoryName
    $archive = Join-Path $InstallRoot "$releaseName.zip"

    if ($TargetBrowser -eq 'firefox' -and [string]::IsNullOrWhiteSpace($GeckoId)) {
        throw 'Firefox packaging requires -FirefoxExtensionId with the AMO Gecko identifier.'
    }

    New-ReleaseDirectory -Destination $directory -TargetBrowser $TargetBrowser -Version $Version -GeckoId $GeckoId
    New-ReleaseArchive -Directory $directory -Archive $archive
    Write-Host "Created $directory and $archive"
}


$version = Get-ApplicationVersion
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

if ($Target -in @('chromium', 'all')) {
    New-TargetRelease -TargetBrowser 'chromium' -Version $version
}

if ($Target -in @('firefox', 'all')) {
    New-TargetRelease -TargetBrowser 'firefox' -Version $version -GeckoId $FirefoxExtensionId
}
