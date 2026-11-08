[CmdletBinding()]
param([string]$ProjectRoot)
$ErrorActionPreference = 'Stop'

# Remove accidental wrapping quotes from paths passed by Windows batch files.
# Also avoids a literal trailing quote becoming part of the path value.
if ($null -ne $ProjectRoot) {
    $ProjectRoot = $ProjectRoot.Trim()
    $ProjectRoot = $ProjectRoot.Trim([char[]]@([char]34, [char]39, [char]0x201C, [char]0x201D)).Trim()
}
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$root = (Get-Item -LiteralPath $ProjectRoot -ErrorAction Stop).FullName
$configPath = Join-Path $root 'local/release-config.js'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Release config not found: $configPath" }

$current = Get-Content -LiteralPath $configPath -Raw
$websiteMatch = [regex]::Match($current, 'websiteTwitchClientId:\s*["'']([A-Za-z0-9]{10,128})["'']')
$websiteClientId = if ($websiteMatch.Success) { $websiteMatch.Groups[1].Value } else { '' }
if ($websiteClientId -notmatch '^[A-Za-z0-9]{10,128}$') {
    throw 'The legacy websiteTwitchClientId in local/release-config.js is invalid.'
}

# This must be a Twitch OAuth app created as a Public client. It is deliberately
# separate from the optional legacy website OAuth app, whose secret is not shipped.
$botClientId = [string]$env:FISHINGBOT_TWITCH_CLIENT_ID
$botClientId = $botClientId.Trim()
if ($botClientId -and $botClientId -notmatch '^[A-Za-z0-9]{10,128}$') {
    throw 'FISHINGBOT_TWITCH_CLIENT_ID must be a valid Twitch Public app Client ID.'
}

$relayUrl = [string]$env:FISHINGBOT_EXTENSION_RELAY_URL
$relayUrl = $relayUrl.Trim().TrimEnd('/')
if ($relayUrl) {
    if (-not $botClientId) {
        throw 'Set FISHINGBOT_TWITCH_CLIENT_ID to the Twitch Public app Client ID when building with an Extension relay.'
    }
    $uri = $null
    if (-not [Uri]::TryCreate($relayUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'FISHINGBOT_EXTENSION_RELAY_URL must be an HTTPS base URL without credentials, a query, or a fragment.'
    }
    $relayUrl = $uri.AbsoluteUri.TrimEnd('/')
}

$content = @"
// Public Fishingbot release configuration.
// websiteTwitchClientId is the optional legacy website Authorization Code OAuth app.
// botTwitchClientId is a separate Twitch OAuth app registered as a Public client.
// The Extension Secret is stored only on the hosted relay.
export const RELEASE_CONFIG = Object.freeze({
  websiteTwitchClientId: "$websiteClientId",
  botTwitchClientId: "$botClientId",
  extensionRelayUrl: "$relayUrl"
});
"@
[System.IO.File]::WriteAllText($configPath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "Release config written. Public Device Code app: $(if ($botClientId) { 'configured' } else { 'not configured (Twitch sign-in disabled in this build)' }). Extension relay: $(if ($relayUrl) { 'configured' } else { 'not configured (Extension publishing disabled)' })."
