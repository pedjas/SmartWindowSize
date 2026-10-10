<# Shared native Git execution for SmartWindowSize repository workflows. #>
Set-StrictMode -Version Latest

function Get-SharedNativeCommandResult {
    param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string[]]$Arguments)

    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "SmartWindowSize-native-$([guid]::NewGuid().ToString('N')).stderr"
    $previousErrorActionPreference = $ErrorActionPreference
    $previousWhatIfPreference = $WhatIfPreference
    try {
        # Read-only inspection must run during a caller's WhatIf; only workflow mutations honor it.
        $WhatIfPreference = $false
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $stdout = @(& $Executable @Arguments 2> $stderrPath)
        $stderr = ''
        if (Test-Path -LiteralPath $stderrPath) { $stderr = [string]::Empty + (Get-Content -LiteralPath $stderrPath -Raw) }
        $standardOutput = [string]::Empty + (($stdout | ForEach-Object ToString) -join [Environment]::NewLine)
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; StandardOutput = $standardOutput.Trim(); StandardError = $stderr.Trim() }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if (Test-Path -LiteralPath $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }
        $WhatIfPreference = $previousWhatIfPreference
    }
}

function Invoke-SharedNativeCommand {
    param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][string]$Description)

    $result = Get-SharedNativeCommandResult -Executable $Executable -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        $details = @($result.StandardOutput, $result.StandardError | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
        throw "$Description failed with exit code $($result.ExitCode).`n$details"
    }
    return $result.StandardOutput
}

function Invoke-SharedRepositoryGitCommand {
    param([Parameter(Mandatory)][string]$GitPath, [Parameter(Mandatory)][string]$RepositoryPath, [Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][string]$Description)

    $repository = [System.IO.Path]::GetFullPath($RepositoryPath)
    $safeDirectory = $repository -replace '\\', '/'
    return Invoke-SharedNativeCommand -Executable $GitPath -Arguments (@('-c', "safe.directory=$safeDirectory", '-C', $repository) + $Arguments) -Description $Description
}

function ConvertFrom-SharedGitPathOutput {
    param([AllowEmptyString()][string]$Output)
    return @($Output -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

Export-ModuleMember -Function Get-SharedNativeCommandResult, Invoke-SharedNativeCommand, Invoke-SharedRepositoryGitCommand, ConvertFrom-SharedGitPathOutput
