# Pingnet — Windows Dev Launcher
# Run from PowerShell: .\run-dev.ps1
# If blocked by execution policy: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

Set-Location $PSScriptRoot

# Prepend known install locations — terminals opened before install won't have these on PATH yet
$extraPaths = @(
    "$env:USERPROFILE\.cargo\bin",
    "C:\Program Files\nodejs",
    "C:\Strawberry\perl\bin",
    "C:\Strawberry\c\bin",
    "C:\Program Files\NASM"
) | Where-Object { Test-Path $_ }
if ($extraPaths.Count -gt 0) {
    $env:Path = ($extraPaths -join ';') + ';' + $env:Path
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Pingnet — Dev Build" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# ── Check required tools ──────────────────────────────────────────────────────

$missing = $false

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "X  Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    $missing = $true
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "X  Rust/Cargo not found. Install from https://rustup.rs" -ForegroundColor Red
    $missing = $true
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "X  npm not found (should ship with Node.js)." -ForegroundColor Red
    $missing = $true
}

# ssh2 vendored-openssl requires Perl and NASM on Windows
if (-not (Get-Command perl -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "X  Perl not found — required to compile OpenSSL (used by ssh2)." -ForegroundColor Yellow
    Write-Host "   Install Strawberry Perl: https://strawberryperl.com" -ForegroundColor Yellow
    Write-Host "   Or via winget:  winget install StrawberryPerl.StrawberryPerl" -ForegroundColor Yellow
    $missing = $true
}

if (-not (Get-Command nasm -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "X  NASM not found — required to compile OpenSSL (used by ssh2)." -ForegroundColor Yellow
    Write-Host "   Install NASM: https://www.nasm.us/pub/nasm/releasebuilds" -ForegroundColor Yellow
    Write-Host "   Or via winget:  winget install NASM.NASM" -ForegroundColor Yellow
    $missing = $true
}

if ($missing) {
    Write-Host ""
    Write-Host "Please install the missing tools above, then re-run this script." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "OK  Node $(node --version)" -ForegroundColor Green
Write-Host "OK  $(cargo --version)" -ForegroundColor Green
Write-Host "OK  Perl $(perl -e 'print $^V')" -ForegroundColor Green
Write-Host ""

# ── Install npm dependencies ──────────────────────────────────────────────────

Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install failed." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

# ── Free port 1420 ────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Clearing port 1420..." -ForegroundColor Cyan
$procs = Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue |
         Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pid in $procs) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# ── Launch ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Starting Tauri dev server..." -ForegroundColor Cyan
Write-Host ""
Write-Host "  NOTE: If this is your first run, the ssh2 crate compiles OpenSSL" -ForegroundColor Yellow
Write-Host "  from source. This takes 3-5 minutes. Subsequent builds are fast." -ForegroundColor Yellow
Write-Host ""

npm run tauri dev
