<#
.SYNOPSIS
    Installs the obs-scramble OBS Studio plugin from this dist\ folder into
    OBS Studio's per-user plugin directory.

.DESCRIPTION
    This script is meant to be run from INSIDE the shared dist\ folder,
    sitting next to a "plugin\obs-scramble\" payload:

        dist\
          install.ps1          <- this script
          install.bat
          plugin\
            obs-scramble\
              bin\64bit\obs-scramble.dll
              data\...
          viewer\wtv-descramble.user.js
          master-key-preview.html
          README.md

    It copies plugin\obs-scramble\bin\64bit\obs-scramble.dll and
    plugin\obs-scramble\data\ into:

        %ProgramData%\obs-studio\plugins\obs-scramble\bin\64bit\obs-scramble.dll
        %ProgramData%\obs-studio\plugins\obs-scramble\data\...

    which OBS Studio >= 28 scans automatically at startup. No admin rights
    are needed and it never touches OBS's own Program Files installation.

    If you got this dist\ folder without the plugin\ subfolder (e.g. you
    only downloaded install.ps1 by itself), re-download the whole dist\
    folder -- this script has nothing to copy without it.

.EXAMPLE
    .\install.ps1

    Or just double-click install.bat, which runs this script for you and
    keeps the window open so you can read the output.
#>

$ErrorActionPreference = "Stop"

$distRoot = $PSScriptRoot
$payloadRoot = Join-Path $distRoot "plugin\obs-scramble"
$payloadDll = Join-Path $payloadRoot "bin\64bit\obs-scramble.dll"
$payloadData = Join-Path $payloadRoot "data"
$destRoot = Join-Path $env:ProgramData "obs-studio\plugins\obs-scramble"
$destBin = Join-Path $destRoot "bin\64bit"
$destData = Join-Path $destRoot "data"

Write-Host "obs-scramble installer" -ForegroundColor Cyan
Write-Host "-----------------------"

if (-not (Test-Path $payloadDll)) {
    Write-Host ""
    Write-Host "ERROR: $payloadDll not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "This installer expects to run from inside the shared dist\ folder, next to a" -ForegroundColor Red
    Write-Host "plugin\obs-scramble\bin\64bit\obs-scramble.dll payload. If that folder is" -ForegroundColor Red
    Write-Host "missing, you have an incomplete copy of dist\ -- get the whole dist\ folder" -ForegroundColor Red
    Write-Host "again rather than just this script, and re-run it from inside that folder." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $payloadData)) {
    Write-Host ""
    Write-Host "ERROR: $payloadData not found (expected next to the plugin DLL)." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $destBin | Out-Null
New-Item -ItemType Directory -Force -Path $destData | Out-Null

try {
    Copy-Item -Path $payloadDll -Destination $destBin -Force
    Copy-Item -Path (Join-Path $payloadData "*") -Destination $destData -Recurse -Force
}
catch {
    Write-Host ""
    Write-Host "ERROR: couldn't copy the plugin files." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "If OBS Studio is running, close it completely (check the system tray too) and" -ForegroundColor Yellow
    Write-Host "run this installer again -- OBS locks the plugin DLL while it's loaded." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Installed to:" -ForegroundColor Green
Write-Host "  $destBin\obs-scramble.dll"
Write-Host "  $destData\"

$obsRunning = Get-Process -Name "obs64", "obs32", "obs" -ErrorAction SilentlyContinue
if ($obsRunning) {
    Write-Host ""
    Write-Host "OBS Studio is currently running -- restart it to load this plugin." -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "OBS Studio isn't running -- just launch it normally; the plugin loads automatically." -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps in OBS:" -ForegroundColor Cyan
Write-Host "  1. Right-click your SCENE (not just one source) in the Scenes panel -> Filters."
Write-Host "     (Scene-level is recommended so any black letterbox padding gets scrambled"
Write-Host "      too, instead of inverting to a visible white bar for viewers.)"
Write-Host "  2. Under Effect Filters, click + -> Scramble."
Write-Host "  3. Set your key (seed / grid / flip / invert / permute), or paste a master"
Write-Host "     string someone already gave you."
Write-Host "  4. Copy the Master String field shown in the filter and share it with your"
Write-Host "     viewers out-of-band -- see README.md for the viewer side."
