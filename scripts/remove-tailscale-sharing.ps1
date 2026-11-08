[CmdletBinding()]
param([string]$ProjectRoot)
$ErrorActionPreference = 'Stop'

function Get-ProjectRoot {
    param([string]$Requested)
    $candidate = [string]$Requested
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = Split-Path -Parent $PSScriptRoot
    }
    $candidate = $candidate.Trim().Trim([char]34, [char]39, [char]0x201C, [char]0x201D)
    try {
        return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName
    } catch {
        $fallback = Split-Path -Parent $PSScriptRoot
        return (Get-Item -LiteralPath $fallback -ErrorAction Stop).FullName
    }
}

$root = Get-ProjectRoot -Requested $ProjectRoot
Write-Host "Removing retired Fishingbot Tailscale/Funnel integration from: $root"

$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile) {
    $lines = Get-Content -LiteralPath $envFile
    $kept = @($lines | Where-Object {
        $_ -notmatch '^\s*(TAILSCALE_FUNNEL_[A-Z0-9_]*|FISHINGBOT_TAILSCALE_[A-Z0-9_]*|PUBLIC_VIEWER_GATEWAY_[A-Z0-9_]*)\s*='
    })
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($envFile, [string[]]$kept, $utf8NoBom)
}

$relativeFiles = @(
    'local/tailscale-funnel.js',
    'local/viewer-gateway.js',
    'local/tunnel.js',
    'local/public-access.js',
    'scripts/tailscale-funnel-elevated.ps1',
    'scripts/fetch-tailscale-installer.ps1',
    'scripts/diagnose-public-hosting.ps1'
)
foreach ($relative in $relativeFiles) {
    $path = Join-Path $root ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
        Write-Host "Removed $relative"
    }
}

$payloads = @(
    'tools/tailscale-setup.exe',
    'dist/tools/tailscale-setup.exe',
    'installer-gui/staging/tools/tailscale-setup.exe'
)
foreach ($relative in $payloads) {
    $path = Join-Path $root ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
        Write-Host "Removed cached payload $relative"
    }
}

Write-Host 'Fishingbot public sharing is removed. The Tailscale Windows client and global Tailscale settings were left untouched.'
Write-Host 'If Tailscale was installed only for Fishingbot, uninstall it separately in Windows Settings > Apps.'
