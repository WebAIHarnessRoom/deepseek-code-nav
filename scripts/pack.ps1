<#
.SYNOPSIS
  Pack the DeepSeek Code Navigator extension into a zip for store upload.
.DESCRIPTION
  Packs the contents of src/ (including _locales) into dist/deepseek-code-nav.zip,
  ensuring manifest.json sits at the zip root, then verifies required files.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\pack.ps1
#>

[CmdletBinding()]
param(
    [string]$OutFile = "dist\deepseek-code-nav.zip"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Resolve paths
$Root    = Split-Path -Parent $PSScriptRoot
$SrcDir  = Join-Path $Root "src"
$OutPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $Root $OutFile }
$OutDir  = Split-Path -Parent $OutPath

if (-not (Test-Path (Join-Path $SrcDir "manifest.json"))) {
    throw "Cannot find src\manifest.json. Run this script from the repository root."
}

# Required files
$Required = @(
    "manifest.json",
    "content.js",
    "icon-16.png",
    "icon-32.png",
    "icon-48.png",
    "icon-128.png"
)

$Missing = $Required | Where-Object { -not (Test-Path (Join-Path $SrcDir $_)) }
if ($Missing) {
    throw ("Missing required files in src: " + ($Missing -join ", "))
}

# Read manifest and validate i18n setup
$manifest = [System.IO.File]::ReadAllText((Join-Path $SrcDir "manifest.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$defaultLocale = $manifest.default_locale

$LocaleWarnings = @()
if ($defaultLocale) {
    $localePath = Join-Path $SrcDir ("_locales\" + $defaultLocale + "\messages.json")
    if (-not (Test-Path $localePath)) {
        $LocaleWarnings += "manifest declares default_locale=$defaultLocale but _locales\$defaultLocale\messages.json is missing."
    }
} else {
    if (Test-Path (Join-Path $SrcDir "_locales")) {
        $LocaleWarnings += "_locales exists but manifest.json has no default_locale; browsers will ignore it."
    }
}

$nameIsMsg = $manifest.name -match '^__MSG_.+__$'
$descIsMsg = $manifest.description -match '^__MSG_.+__$'
if ($defaultLocale -and (-not $nameIsMsg -or -not $descIsMsg)) {
    $LocaleWarnings += "default_locale is set but name/description do not use __MSG_xxx__ placeholders; i18n will not work."
}

# Clean output
if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Pack: contents of src/ go to zip root
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $SrcDir,
    $OutPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)

# Verify zip
$zip = [System.IO.Compression.ZipFile]::OpenRead($OutPath)
try {
    $entries = $zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') }

    if ($entries -notcontains "manifest.json") {
        throw "Packing failed: manifest.json is not at the zip root."
    }

    $missingInZip = $Required | Where-Object { $entries -notcontains $_ }
    if ($missingInZip) {
        throw ("Packing failed: zip is missing " + ($missingInZip -join ", "))
    }

    if ($entries -match '^src/') {
        Write-Warning "zip entries contain a 'src/' prefix; the folder was nested incorrectly."
    }

    $size = [math]::Round((Get-Item $OutPath).Length / 1KB, 1)

    Write-Host ""
    Write-Host "Packed OK: $OutPath ($size KB)" -ForegroundColor Green
    Write-Host "zip contents:" -ForegroundColor Cyan
    $entries | Sort-Object | ForEach-Object { Write-Host ("  " + $_) }
}
finally {
    $zip.Dispose()
}

if ($LocaleWarnings.Count -gt 0) {
    Write-Host ""
    Write-Host "i18n warnings:" -ForegroundColor Yellow
    $LocaleWarnings | ForEach-Object { Write-Host ("  ! " + $_) -ForegroundColor Yellow }
}

Write-Host ""