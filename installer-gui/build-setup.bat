@echo off
rem Builds installer-gui\Output\Fishingbot_Setup_v1.0.0-beta.exe from dist\ (run build.bat first).
rem If FISHINGBOT_SIGN_CERT_SHA1 is set, signs the final installer after compilation.
rem Uses the C# compiler that comes with Windows (.NET Framework 4.6.2+).
setlocal
cd /d "%~dp0"

if exist "..\scripts\remove-tailscale-sharing.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "..\scripts\remove-tailscale-sharing.ps1" -ProjectRoot "%~dp0.."
  if errorlevel 1 (
    echo Could not remove retired Tailscale viewer-sharing components.
    if not defined FISHINGBOT_NO_PAUSE pause
    exit /b 1
  )
)

if not exist "..\dist\Fishingbot.exe" (
  echo dist\Fishingbot.exe was not found. Run build.bat first.
  if not defined FISHINGBOT_NO_PAUSE pause
  exit /b 1
)
if not exist "..\dist\FishingbotServer.exe" (
  echo dist\FishingbotServer.exe was not found. Run build.bat first.
  if not defined FISHINGBOT_NO_PAUSE pause
  exit /b 1
)

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo The .NET Framework compiler was not found at %CSC%.
  if not defined FISHINGBOT_NO_PAUSE pause
  exit /b 1
)

echo [1/4] Preparing the payload...
if exist staging rmdir /s /q staging
robocopy "..\dist" staging /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo Copying dist failed.
  if not defined FISHINGBOT_NO_PAUSE pause
  exit /b 1
)
del /q "staging\fishingsys-local.cjs" 2>nul
if exist payload.zip del /q payload.zip
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory((Resolve-Path 'staging').Path, (Join-Path (Get-Location).Path 'payload.zip'))"
if errorlevel 1 (
  echo Creating payload.zip failed.
  if not defined FISHINGBOT_NO_PAUSE pause
  exit /b 1
)
rem Verify the payload contains the program files. A payload without Fishingbot.exe, FishingbotServer.exe or
rem lib\db-manager-worker.mjs would produce a setup that cannot install anything.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead((Join-Path (Get-Location).Path 'payload.zip')); $names=@($z.Entries | ForEach-Object { $_.FullName.Replace([string][char]92,'/') }); $z.Dispose(); foreach($f in 'Fishingbot.exe','FishingbotServer.exe','lib/db-manager-worker.mjs'){ if(-not ($names -contains $f)){ Write-Host ('Payload is missing ' + $f); exit 1 } }"
if errorlevel 1 (
  echo The payload is incomplete. Run build.bat again.
  if not defined FISHINGBOT_NO_PAUSE pause
  exit /b 1
)

echo [2/4] Compiling the setup program...
if not exist Output mkdir Output
"%CSC%" /nologo /target:winexe /optimize+ /platform:x64 /win32icon:"..\desktop-electron\renderer\assets\app.ico" /out:"Output\Fishingbot_Setup_v1.0.0-beta.exe" /resource:payload.zip,Payload.zip /resource:..\desktop-electron\renderer\assets\app.ico,AppIcon.ico /resource:..\desktop-electron\renderer\assets\app.png,AppMark.png /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Web.Extensions.dll ..\desktop\src\Loc.cs FishingbotSetup.cs
if errorlevel 1 (
  echo Compile failed. See the messages above.
  if not defined FISHINGBOT_NO_PAUSE pause
  exit /b 1
)

echo [3/4] Signing/verifying final executables...
if defined FISHINGBOT_SIGN_CERT_SHA1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\sign-release.ps1" -TargetDirectory "%~dp0..\dist" -Files "%~dp0Output\Fishingbot_Setup_v1.0.0-beta.exe" -CertThumbprint "%FISHINGBOT_SIGN_CERT_SHA1%"
  if errorlevel 1 (
    echo Signing failed. The installer is not ready for release.
    if not defined FISHINGBOT_NO_PAUSE pause
    exit /b 1
  )
) else (
  echo WARNING: no trusted code-signing certificate configured. The installer will remain unsigned.
  echo See docs\CODE_SIGNING.md to configure Authenticode signing.
)

echo [4/4] Cleaning up...
rmdir /s /q staging
del /q payload.zip

echo.
echo Setup built: installer-gui\Output\Fishingbot_Setup_v1.0.0-beta.exe
if not defined FISHINGBOT_NO_PAUSE pause
exit /b 0
