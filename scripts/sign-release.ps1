[CmdletBinding()]
param(
    [string]$TargetDirectory,
    [string[]]$Files = @(),
    [string]$CertThumbprint = $env:FISHINGBOT_SIGN_CERT_SHA1,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

function Find-SignTool {
    $fromPath = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
    if ($fromPath) { return $fromPath.Source }

    $roots = @()
    if (${env:ProgramFiles(x86)}) { $roots += (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin') }
    if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'Windows Kits\10\bin') }

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $versions = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object -Property Name -Descending
        foreach ($version in $versions) {
            foreach ($arch in @('x64', 'arm64', 'x86')) {
                $candidate = Join-Path $version.FullName (Join-Path $arch 'signtool.exe')
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
            }
        }
    }

    throw 'SignTool.exe was not found. Install the Windows 10/11 SDK, or add signtool.exe to PATH.'
}

$targets = New-Object 'System.Collections.Generic.List[string]'
if ($TargetDirectory) {
    if (-not (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
        throw "Target directory does not exist: $TargetDirectory"
    }
    Get-ChildItem -LiteralPath $TargetDirectory -Filter '*.exe' -File -Recurse | ForEach-Object {
        $targets.Add($_.FullName)
    }
}
foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Requested executable does not exist: $file"
    }
    $resolved = (Resolve-Path -LiteralPath $file).Path
    if (-not $targets.Contains($resolved)) { $targets.Add($resolved) }
}

$uniqueTargets = @($targets | Select-Object -Unique | Sort-Object)
if ($uniqueTargets.Count -eq 0) { throw 'No .exe files were found to sign or verify.' }

$signtool = Find-SignTool
Write-Host "Using SignTool: $signtool"

$certificate = $null
if (-not $VerifyOnly) {
    $thumbprint = ($CertThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    if ($thumbprint.Length -ne 40) {
        throw 'Set FISHINGBOT_SIGN_CERT_SHA1 to the 40-character thumbprint of a trusted code-signing certificate in CurrentUser\My.'
    }

    $certificate = Get-ChildItem -Path 'Cert:\CurrentUser\My' |
        Where-Object { $_.Thumbprint -eq $thumbprint } |
        Select-Object -First 1
    if (-not $certificate) { throw "Code-signing certificate $thumbprint was not found in Cert:\CurrentUser\My." }
    if (-not $certificate.HasPrivateKey) { throw 'The selected certificate has no accessible private key.' }
    $now = Get-Date
    if ($now -lt $certificate.NotBefore -or $now -gt $certificate.NotAfter) {
        throw 'The selected code-signing certificate is not currently within its validity period.'
    }

    $hasCodeSigningEku = $false
    foreach ($extension in $certificate.Extensions) {
        if ($extension.Oid.Value -eq '2.5.29.37') {
            foreach ($oid in $extension.EnhancedKeyUsages) {
                if ($oid.Value -eq '1.3.6.1.5.5.7.3.3') { $hasCodeSigningEku = $true }
            }
        }
    }
    if (-not $hasCodeSigningEku) {
        throw 'The selected certificate does not contain the Code Signing EKU (1.3.6.1.5.5.7.3.3).'
    }

    Write-Host "Signing identity: $($certificate.Subject)"
}

$failed = New-Object 'System.Collections.Generic.List[string]'
foreach ($target in $uniqueTargets) {
    Write-Host ''
    Write-Host "Checking: $target"
    $signature = Get-AuthenticodeSignature -LiteralPath $target

    if ($signature.Status -eq 'Valid') {
        Write-Host "  Existing trusted signature preserved: $($signature.SignerCertificate.Subject)"
        continue
    }

    if ($signature.Status -ne 'NotSigned') {
        Write-Error "  Existing signature state is '$($signature.Status)'. Refusing to replace or ignore it. Investigate this file before release."
        $failed.Add($target)
        continue
    }

    if ($VerifyOnly) {
        Write-Error '  File is unsigned.'
        $failed.Add($target)
        continue
    }

    Write-Host '  Applying SHA-256 Authenticode signature and RFC 3161 timestamp...'
    & $signtool sign /sha1 $certificate.Thumbprint /s My /fd SHA256 /tr $TimestampUrl /td SHA256 /d 'Fishingbot' $target
    if ($LASTEXITCODE -ne 0) {
        Write-Error "  SignTool failed with exit code $LASTEXITCODE."
        $failed.Add($target)
        continue
    }

    & $signtool verify /pa /all /v $target
    if ($LASTEXITCODE -ne 0) {
        Write-Error '  SignTool could not verify the resulting signature.'
        $failed.Add($target)
        continue
    }

    $after = Get-AuthenticodeSignature -LiteralPath $target
    if ($after.Status -ne 'Valid') {
        Write-Error "  Windows reports the resulting signature as '$($after.Status)'."
        $failed.Add($target)
        continue
    }

    Write-Host "  Signed and verified: $($after.SignerCertificate.Subject)"
}

if ($failed.Count -gt 0) {
    Write-Error ("Signing/verification failed for {0} file(s):`n - {1}" -f $failed.Count, ($failed -join "`n - "))
    exit 1
}

Write-Host ''
if ($VerifyOnly) {
    Write-Host ("Verified {0} executable(s)." -f $uniqueTargets.Count)
} else {
    Write-Host ("All {0} executable(s) are now signed or already carry a valid trusted signature." -f $uniqueTargets.Count)
}
exit 0
