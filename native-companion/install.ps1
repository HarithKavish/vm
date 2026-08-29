<#
.SYNOPSIS
  Installs, uninstalls, or diagnoses the VM Desktop native messaging companion for Edge (Chromium) on Windows.

.DESCRIPTION
  Copies vm-desktop-companion.exe and a generated native messaging host manifest into a stable
  per-user install directory, then registers the manifest with Edge via the HKCU
  NativeMessagingHosts registry key so the "VM Desktop Bridge" extension can launch it.

.PARAMETER Uninstall
  Remove the registry entry and the installed files instead of installing.

.PARAMETER Diagnose
  Check the current install state (registry entry, manifest, executable, extension id) and report
  pass/fail for each, without changing anything.

.PARAMETER ExePath
  Path to a prebuilt vm-desktop-companion.exe. Defaults to .\vm-desktop-companion.exe next to this
  script. If not found and Go is available, the script builds it from source in this directory.

.PARAMETER ExtensionId
  The MV3 extension id allowed to invoke this host. Defaults to the id derived from the "key"
  field committed in extension/public/manifest.json (mkceajnjaipdpkegbgponncjaknnnece). Override
  only if you are running a fork with a different signing key.

.EXAMPLE
  .\install.ps1
  Builds/copies the companion and registers it for Edge.

.EXAMPLE
  .\install.ps1 -Diagnose

.EXAMPLE
  .\install.ps1 -Uninstall
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Uninstall')]
    [switch]$Uninstall,

    [Parameter(ParameterSetName = 'Diagnose')]
    [switch]$Diagnose,

    [Parameter(ParameterSetName = 'Install')]
    [string]$ExePath,

    [string]$ExtensionId = 'mkceajnjaipdpkegbgponncjaknnnece'
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.harith.vm_desktop'
$InstallDir = Join-Path $env:LOCALAPPDATA 'VMDesktop\native-companion'
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$InstalledExePath = Join-Path $InstallDir 'vm-desktop-companion.exe'
$RegistryKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"

function Write-Status {
    param([bool]$Pass, [string]$Message)
    if ($Pass) {
        Write-Host "[OK]   $Message" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $Message" -ForegroundColor Red
    }
}

function Get-CompanionExePath {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) {
            throw "ExePath '$Explicit' does not exist."
        }
        return (Resolve-Path $Explicit).Path
    }

    $scriptDir = $PSScriptRoot
    $candidate = Join-Path $scriptDir 'vm-desktop-companion.exe'
    if (Test-Path $candidate) {
        return (Resolve-Path $candidate).Path
    }

    $goSource = Join-Path $scriptDir 'main.go'
    if (Test-Path $goSource) {
        $go = Get-Command go -ErrorAction SilentlyContinue
        if (-not $go) {
            throw "vm-desktop-companion.exe not found next to install.ps1, and Go is not on PATH to build it. Build it manually with 'go build -o vm-desktop-companion.exe .' in $scriptDir, or pass -ExePath."
        }
        Write-Host "Building vm-desktop-companion.exe from source ($scriptDir)..."
        Push-Location $scriptDir
        try {
            & go build -o $candidate .
            if ($LASTEXITCODE -ne 0) {
                throw "go build failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
        return (Resolve-Path $candidate).Path
    }

    throw "Could not locate vm-desktop-companion.exe. Pass -ExePath, or run this script from the native-companion source directory."
}

function Install-Companion {
    $sourceExe = Get-CompanionExePath -Explicit $ExePath

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item -Path $sourceExe -Destination $InstalledExePath -Force

    $manifest = [ordered]@{
        name             = $HostName
        description      = 'VM Desktop native SSH companion'
        path             = $InstalledExePath
        type             = 'stdio'
        allowed_origins  = @("chrome-extension://$ExtensionId/")
    }
    ($manifest | ConvertTo-Json -Depth 5) | Set-Content -Path $ManifestPath -Encoding UTF8

    New-Item -Path $RegistryKey -Force | Out-Null
    Set-ItemProperty -Path $RegistryKey -Name '(Default)' -Value $ManifestPath

    Write-Host ""
    Write-Host "Installed VM Desktop native companion." -ForegroundColor Cyan
    Write-Host "  Executable: $InstalledExePath"
    Write-Host "  Manifest:   $ManifestPath"
    Write-Host "  Registry:   $RegistryKey -> $ManifestPath"
    Write-Host "  Extension:  chrome-extension://$ExtensionId/"
    Write-Host ""
    Write-Host "Run '.\install.ps1 -Diagnose' to verify the install."
}

function Uninstall-Companion {
    if (Test-Path $RegistryKey) {
        Remove-Item -Path $RegistryKey -Force
        Write-Host "Removed registry key $RegistryKey"
    } else {
        Write-Host "Registry key $RegistryKey was not present."
    }

    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
        Write-Host "Removed install directory $InstallDir"
    } else {
        Write-Host "Install directory $InstallDir was not present."
    }
}

function Diagnose-Companion {
    Write-Host "VM Desktop native companion diagnostics" -ForegroundColor Cyan
    Write-Host "----------------------------------------"

    $allPass = $true

    $regValue = $null
    $regExists = Test-Path $RegistryKey
    if ($regExists) {
        $regValue = (Get-ItemProperty -Path $RegistryKey -Name '(Default)' -ErrorAction SilentlyContinue).'(Default)'
    }
    $regOk = $regExists -and $regValue
    Write-Status -Pass $regOk -Message "Registry entry $RegistryKey"
    if ($regOk) { Write-Host "       -> $regValue" } else { $allPass = $false }

    $manifestFile = if ($regValue) { $regValue } else { $ManifestPath }
    $manifestExists = Test-Path $manifestFile
    Write-Status -Pass $manifestExists -Message "Manifest file exists at $manifestFile"
    if (-not $manifestExists) { $allPass = $false }

    $manifestJson = $null
    if ($manifestExists) {
        try {
            $manifestJson = Get-Content -Path $manifestFile -Raw | ConvertFrom-Json
        } catch {
            Write-Status -Pass $false -Message "Manifest file is valid JSON"
            $allPass = $false
        }
    }

    if ($manifestJson) {
        $nameOk = $manifestJson.name -eq $HostName
        Write-Status -Pass $nameOk -Message "Manifest 'name' is '$HostName'"
        if (-not $nameOk) { $allPass = $false; Write-Host "       found: '$($manifestJson.name)'" }

        $typeOk = $manifestJson.type -eq 'stdio'
        Write-Status -Pass $typeOk -Message "Manifest 'type' is 'stdio'"
        if (-not $typeOk) { $allPass = $false }

        $exePathFromManifest = $manifestJson.path
        $exeExists = $exePathFromManifest -and (Test-Path $exePathFromManifest)
        Write-Status -Pass $exeExists -Message "Executable exists at manifest 'path' ($exePathFromManifest)"
        if (-not $exeExists) { $allPass = $false }

        $expectedOrigin = "chrome-extension://$ExtensionId/"
        $originOk = $manifestJson.allowed_origins -and ($manifestJson.allowed_origins -contains $expectedOrigin)
        Write-Status -Pass $originOk -Message "allowed_origins contains $expectedOrigin"
        if (-not $originOk) {
            $allPass = $false
            Write-Host "       found: $($manifestJson.allowed_origins -join ', ')"
        }
    } else {
        $allPass = $false
    }

    Write-Host "----------------------------------------"
    if ($allPass) {
        Write-Host "All checks passed." -ForegroundColor Green
    } else {
        Write-Host "One or more checks failed. Run '.\install.ps1' to (re)install." -ForegroundColor Yellow
    }
}

switch ($PSCmdlet.ParameterSetName) {
    'Uninstall' { Uninstall-Companion }
    'Diagnose'  { Diagnose-Companion }
    default     { Install-Companion }
}
