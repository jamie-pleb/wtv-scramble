<#
.SYNOPSIS
    Installs the already-built obs-scramble plugin into OBS Studio's
    per-user plugin directory.

.DESCRIPTION
    Copies build/obs-scramble.dll and build/data/ into
    %ProgramData%\obs-studio\plugins\obs-scramble\{bin\64bit, data}, which
    OBS Studio >= 28 scans automatically at startup -- no admin rights
    needed, and it never touches OBS's own Program Files installation.

    This script does NOT compile the plugin. Run `cmake --build build` (or
    just re-run this after building) first if build/obs-scramble.dll
    doesn't exist yet -- see README.md "Building".

.EXAMPLE
    .\install.ps1
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDll = Join-Path $repoRoot "build\obs-scramble.dll"
$buildData = Join-Path $repoRoot "build\data"
$destRoot = Join-Path $env:ProgramData "obs-studio\plugins\obs-scramble"
$destBin = Join-Path $destRoot "bin\64bit"
$destData = Join-Path $destRoot "data"

Write-Host "obs-scramble installer" -ForegroundColor Cyan
Write-Host "-----------------------"

if (-not (Test-Path $buildDll)) {
    Write-Host ""
    Write-Host "ERROR: $buildDll not found." -ForegroundColor Red
    Write-Host "Build the plugin first:"
    Write-Host "  cmake -S . -B build -DLIBOBS_INCLUDE_DIR=<...> -DLIBOBS_LIB=<...>"
    Write-Host "  cmake --build build --config RelWithDebInfo"
    Write-Host "(see README.md `"Building`" for exact flags)"
    exit 1
}

if (-not (Test-Path $buildData)) {
    Write-Host ""
    Write-Host "ERROR: $buildData not found (expected next to the built DLL)." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $destBin | Out-Null
New-Item -ItemType Directory -Force -Path $destData | Out-Null

Copy-Item -Path $buildDll -Destination $destBin -Force
Copy-Item -Path (Join-Path $buildData "*") -Destination $destData -Recurse -Force

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
    Write-Host "OBS Studio isn't running -- just launch it normally." -ForegroundColor Green
}

Write-Host ""
Write-Host "Next: right-click a source -> Filters -> + -> `"Scramble`", set your key." -ForegroundColor Cyan
