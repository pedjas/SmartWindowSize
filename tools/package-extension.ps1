<#
.SYNOPSIS
Builds verified SmartWindowSize installation artifacts for Chromium or Firefox.

.DESCRIPTION
Copies only allowlisted runtime files into install/, writes the target manifest,
creates a ZIP whose root contains manifest.json, and validates the ZIP layout.

.PARAMETER Target
The browser package family to build. The all value creates both release ZIP assets.

.PARAMETER FirefoxExtensionId
The Gecko extension identifier inserted only into the generated Firefox manifest.

.PARAMETER TestInstallRoot
An optional empty directory under the system temporary directory used only by
the release dry-run. Normal packaging always uses the project install/ directory.
#>

[CmdletBinding()]
param(
    [ValidateSet('chromium', 'firefox', 'all')]
    [string]$Target = 'chromium',

    [string]$FirefoxExtensionId = 'SmartWindowSize@pedjas',

    [string]$TestInstallRoot
)

<# Strict mode prevents incomplete package metadata from silently producing an invalid artifact. #>
Set-StrictMode -Version Latest

<# Every failed validation must stop before a later package artifact can be reported as valid. #>
$ErrorActionPreference = 'Stop'

<# The repository root derived from this script's known tools/ location. #>
$ProjectRoot = Split-Path -Parent $PSScriptRoot

<# The only runtime directories allowed in a release artifact. #>
$RuntimeDirectories = @('about', 'background', 'context', 'core', 'icons', 'options', 'popup', 'readme-viewer', 'rule-delete', 'size-picker')

<# The generated release output directory, either install/ or a guarded temporary dry-run location. #>
if ([string]::IsNullOrWhiteSpace($TestInstallRoot)) {
    $InstallRoot = Join-Path $ProjectRoot 'install'
}
else {
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $InstallRoot = [System.IO.Path]::GetFullPath($TestInstallRoot)
    $temporaryRootPrefix = $temporaryRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $InstallRoot.StartsWith($temporaryRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'TestInstallRoot must be located under the system temporary directory.'
    }
}

<# The only unpacked directories the packaging procedure owns and may replace. #>
$ControlledUnpackedDirectories = @(
    (Join-Path $InstallRoot 'SmartWindowSize-Chrome'),
    (Join-Path $InstallRoot 'SmartWindowSize-Firefox')
)

<# The versioned installation instructions copied into every release artifact. #>
$InstallReadmeSource = Join-Path $ProjectRoot 'readme.txt'


<#
.SYNOPSIS
Reads the application version from the root extension manifest.

.OUTPUTS
System.String. The version read exclusively from root manifest.json.
#>
function Get-ApplicationVersion {
    $manifestPath = Join-Path $ProjectRoot 'manifest.json'
    $manifestVersion = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version

    if ([string]::IsNullOrWhiteSpace($manifestVersion)) {
        throw 'The root manifest.json does not contain an application version.'
    }

    return [string]$manifestVersion
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

.OUTPUTS
None. Recreates only the controlled unpacked destination with approved runtime files.
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

    # Only the two stable local-testing directories are controlled by this procedure.
    if ($Destination -notin $ControlledUnpackedDirectories) {
        throw "Refusing to replace an unmanaged unpacked directory: $Destination"
    }

    if (Test-Path -LiteralPath $Destination) {
        # Stable unpacked directories are intentionally replaced so browsers retain their local extension paths.
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }

    New-Item -ItemType Directory -Path $Destination | Out-Null

    # The packaged user guide is required in both browser-specific artifacts.
    if (-not (Test-Path -LiteralPath $InstallReadmeSource -PathType Leaf)) {
        throw "Required installation readme is missing: $InstallReadmeSource"
    }

    Copy-Item -LiteralPath $InstallReadmeSource -Destination (Join-Path $Destination 'readme.txt')

    # Copy only the runtime allowlist so tests and private project material cannot leak into packages.
    foreach ($directory in $RuntimeDirectories) {
        $source = Join-Path $ProjectRoot $directory
        if (-not (Test-Path -LiteralPath $source -PathType Container)) {
            throw "Required runtime directory is missing: $source"
        }

        Copy-Item -LiteralPath $source -Destination $Destination -Recurse
    }

    # Chromium copies the root manifest, while Firefox receives its separate compatibility manifest.
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
Validates a ZIP whose root is the extension manifest.

.PARAMETER Archive
The ZIP path to validate.

.OUTPUTS
None. Throws when the ZIP does not contain the required root files and layout.
#>
function Test-ReleaseArchive {
    param(
        [Parameter(Mandatory)]
        [string]$Archive
    )

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
Creates and validates a ZIP whose root is the extension manifest.

.PARAMETER Directory
The prepared unpacked extension directory.

.PARAMETER Archive
The controlled ZIP path to replace after a verified temporary archive exists.

.OUTPUTS
None. Creates and validates a ZIP whose root contains manifest.json and readme.txt.
#>
function New-ReleaseArchive {
    param(
        [Parameter(Mandatory)]
        [string]$Directory,

        [Parameter(Mandatory)]
        [string]$Archive
    )

    # Build beside the final ZIP first so a failed compression does not remove the previous valid artifact.
    $temporaryArchive = Join-Path (Split-Path -Parent $Archive) ".$(Split-Path -Leaf $Archive).$([guid]::NewGuid().ToString('N')).tmp"

    try {
        # Archive directory contents rather than the directory itself so manifest.json remains at ZIP root.
        Compress-Archive -Path (Join-Path $Directory '*') -DestinationPath $temporaryArchive -CompressionLevel Optimal
        Test-ReleaseArchive -Archive $temporaryArchive

        # This exact versioned path is generated by New-TargetRelease and is the only existing ZIP this build may replace.
        if (Test-Path -LiteralPath $Archive) {
            Remove-Item -LiteralPath $Archive -Force
        }

        Move-Item -LiteralPath $temporaryArchive -Destination $Archive
    }
    finally {
        if (Test-Path -LiteralPath $temporaryArchive) {
            Remove-Item -LiteralPath $temporaryArchive -Force
        }
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

.OUTPUTS
None. Creates one stable unpacked directory and its versioned browser ZIP.
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

    # Stable unpacked names keep local browser loading paths unchanged across release versions.
    $browserName = if ($TargetBrowser -eq 'firefox') { 'Firefox' } else { 'Chrome' }
    $directoryName = "SmartWindowSize-$browserName"
    $archiveName = "SmartWindowSize-$browserName-v$Version.zip"
    $directory = Join-Path $InstallRoot $directoryName
    $archive = Join-Path $InstallRoot $archiveName

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
