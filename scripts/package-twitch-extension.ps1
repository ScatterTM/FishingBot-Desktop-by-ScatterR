param(
  [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ExtensionRoot = Join-Path $ProjectRoot "twitch-extension"
$OutputRoot = Join-Path $ProjectRoot $OutputDirectory
$OutputFile = Join-Path $OutputRoot "Fishingbot_Twitch_Extension_v1.0.0-beta.zip"

$RequiredFiles = @(
  "component.html",
  "component.css",
  "component.js",
  "account.js",
  "config.html",
  "world-map/map.css",
  "world-map/map.js",
  "world-map/land-layer.svg",
  "world-map/sea-layer.svg"
)

foreach ($RelativePath in $RequiredFiles) {
  $FullPath = Join-Path $ExtensionRoot $RelativePath
  if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
    throw "Required Twitch Extension asset is missing: $RelativePath"
  }
}

$ComponentHtml = Get-Content -LiteralPath (Join-Path $ExtensionRoot "component.html") -Raw
foreach ($Reference in @("component.css", "account.js", "component.js", "world-map/map.css", "world-map/map.js")) {
  if ($ComponentHtml -notmatch [regex]::Escape($Reference)) {
    throw "component.html does not reference the expected asset: $Reference"
  }
}

if ($ComponentHtml -match '<iframe\b') {
  throw "Twitch Extensions cannot contain nested iframes; the world map must be mounted inline."
}
$TopLevelNav = [regex]::Match($ComponentHtml, '(?s)<nav class="tabs"[^>]*>(.*?)</nav>')
if (-not $TopLevelNav.Success) { throw "The public Extension navigation is missing." }
$PublicViews = [regex]::Matches($TopLevelNav.Groups[1].Value, 'data-view="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$ExpectedPublicViews = @("account", "legal")
if (($PublicViews -join ',') -ne ($ExpectedPublicViews -join ',')) {
  throw "Public navigation must contain only World Map and Legal & policy."
}
if ($ComponentHtml -notmatch '<button class="tab active"[^>]*data-view="account">World Map</button>') {
  throw "The World Map must be the default Extension view."
}
if ($ComponentHtml -notmatch 'id="extension-refresh"') {
  throw "The Extension Refresh control is missing."
}
if ($ComponentHtml -notmatch 'data-view="legal"[^>]*>Legal &amp; policy</button>' -or $ComponentHtml -notmatch 'non-monetized community feature') {
  throw "The Legal & policy view and free/non-monetized disclosure are required."
}
if ($ComponentHtml -notmatch '<section id="view-account" class="view active"') {
  throw "The map-first account workspace must be active by default."
}
if ([regex]::Matches($ComponentHtml, 'id="world-map-root"').Count -ne 1) {
  throw "Exactly one staged world-map root is required."
}
if ($ComponentHtml -notmatch 'id="world-map-root"') { throw "World Map root is missing." }
$AccountJs = Get-Content -LiteralPath (Join-Path $ExtensionRoot "account.js") -Raw
if ($AccountJs -notmatch 'FishingbotProfileMap\.mount\(mapViewport, data\)' -or $AccountJs -notmatch "gamePost\('areas', body\)") {
  throw "The World Map must mount in its account workspace and send area actions to the existing private areas handler."
}
$ComponentJs = Get-Content -LiteralPath (Join-Path $ExtensionRoot "component.js") -Raw
if ($ComponentJs -notmatch "currentView !== 'account'") {
  throw "Map actions must be rejected unless the World Map view is active."
}

$MapJs = Get-Content -LiteralPath (Join-Path $ExtensionRoot "world-map/map.js") -Raw
if ($MapJs -match "(?:win|window|mapWindow)\.addEventListener\('keydown'") {
  throw "Map-specific keyboard shortcuts are not permitted by Twitch Extension policy."
}
if ($MapJs -notmatch 'normalizeMapData') {
  throw "Map payload validation must remain enabled before dynamic data is rendered."
}
if ($ComponentHtml -notmatch 'data-map-src="world-map/sea-layer\.svg' -or $ComponentHtml -notmatch 'data-map-src="world-map/land-layer\.svg') {
  throw "Map artwork must remain lazy-loaded after the viewer opens the map."
}

foreach ($FrontEnd in @("component.html", "config.html")) {
  $FrontEndHtml = Get-Content -LiteralPath (Join-Path $ExtensionRoot $FrontEnd) -Raw
  $FirstScript = [regex]::Match($FrontEndHtml, '<script\b[^>]*>')
  if (-not $FirstScript.Success -or $FirstScript.Value -notmatch 'extension-files\.twitch\.tv/helper/v1/twitch-ext\.min\.js') {
    throw "The Twitch Extension Helper must be the first script in $FrontEnd."
  }
}

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("Fishingbot-Twitch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Stage -Force | Out-Null
try {
  foreach ($RelativePath in $RequiredFiles) {
    $Destination = Join-Path $Stage $RelativePath
    $Parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $Parent)) { New-Item -ItemType Directory -Path $Parent -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $ExtensionRoot $RelativePath) -Destination $Destination
  }

  if (Test-Path -LiteralPath $OutputFile) { Remove-Item -LiteralPath $OutputFile -Force }
  Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $OutputFile -CompressionLevel Optimal

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Archive = [System.IO.Compression.ZipFile]::OpenRead($OutputFile)
  try {
    $Names = @($Archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
    foreach ($RelativePath in $RequiredFiles) {
      if ($Names -notcontains $RelativePath) { throw "Packaged ZIP is missing: $RelativePath" }
    }
    foreach ($Name in $Names) {
      if ($Name -match '(^|/)(\.env[^/]*|node_modules|data|dist)(/|$)|\.(db|sqlite|sqlite3)$') {
        throw "Forbidden runtime/private file in Extension ZIP: $Name"
      }
    }
  }
  finally { $Archive.Dispose() }

  Write-Host "Created and verified: $OutputFile"
  Write-Host "Upload component.html and config.html as configured in the Twitch Developer Console. Only World Map and Legal & policy are exposed as public Extension views."
  Write-Host "Upload taskbar-icon.png separately; it is intentionally not included in this ZIP."
}
finally {
  if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
}
