# OBS auto-start setup guide

## Downloads and verification

The Control Centre → OBS scripts page lists the Lua script and setup ZIP with release version, file size, compatibility note and SHA-256 checksum. Downloads are integrity-checked against `downloads/obs-scripts.json` before they are served. In browser mode the downloaded payload is checked again with Web Crypto when supported; Electron verifies the source before opening the Save dialog. If a check fails, do not use that file: reinstall/update Fishingbot or restore the original release files. Retry is safe because each download is a standalone copy.


The OBS integration is a standalone Lua script. It is deliberately separate from Windows sign-in startup: adding the script does not register Fishingbot to run when Windows starts.

## Install and add the script

1. Install Fishingbot Desktop normally. For a source checkout, run the project from the project root; for a built release, the usual executable is `Fishingbot.exe` in the installed Fishingbot folder (often `dist\Fishingbot.exe` during a build).
2. Close OBS if it is currently running, then open the installed/source folder containing `obs-scripts\fishingbot-autostart.lua`.
3. Start OBS Studio.
4. Open **Tools → Scripts**.
5. In the Scripts window, click **+** (Add Script) and select `obs-scripts\fishingbot-autostart.lua` from the Fishingbot folder.
6. Select **Fishingbot Auto-Start** in the script list. In the script properties, set **Fishingbot executable** to the actual `Fishingbot.exe` path. Do not select `FishingbotServer.exe`; the desktop app starts and supervises the server itself.
7. Leave **Launch Fishingbot when OBS starts** enabled. Optionally enable **Close Fishingbot on OBS exit (only if this script launched it)** if you want OBS to close the instance it started.
8. Close the Scripts window. OBS saves script options. On OBS startup, the script waits briefly, then launches the desktop app only if that executable is not already running. When OBS launches it, the desktop shell stays hidden. The local server starts and the Control Centre Overview opens in its own window. Starting Fishingbot again brings that window forward.

## Verify it

1. With OBS and Fishingbot closed, open OBS. Fishingbot Desktop should launch within a few seconds.
2. Open Task Manager and confirm that `Fishingbot.exe` is running. The desktop shell stays hidden; the Control Centre window opens instead. Check there that the local server is online.
3. Close Fishingbot manually, then restart OBS to verify the script launches it again.
4. If **Close Fishingbot on OBS exit** is enabled, close OBS and confirm that the app instance started by the script closes. If the app was already running before OBS, the script deliberately leaves it alone.
5. If it does not start, review OBS's **Tools → Scripts** log messages and `%APPDATA%\Fishingbot\obs-launch.log`. Verify that the executable path exists and that Windows PowerShell is available.

## Windows login startup is a separate setting

Open **Fishingbot Desktop → Settings → Startup**. **Start Fishingbot Desktop when Windows starts** keeps the current Windows sign-in behavior (the server also starts when the desktop opens). **Start the server when OBS starts** starts Fishingbot Desktop minimized at sign-in and waits to launch the server until OBS is detected, as long as the Windows-start checkbox is off. Closing the window exits Fishingbot and stops this watcher. To let OBS launch Fishingbot while the desktop app is closed, use the dedicated Lua script above; OBS must have that script registered once under **Tools → Scripts**. On each app launch, Fishingbot synchronizes the saved startup choices to the OS login registration, which also clears stale registrations from older versions.

## Twitch private command setup

Viewer management commands return via Twitch Whispers, so the connected bot account needs `user:manage:whispers` in addition to chat read/write permissions. After updating this build, open the Twitch settings/setup page and reconnect the bot account, accepting the new permission. Without it, the bot intentionally does not publish command results in public chat. The sending Twitch account must have a verified phone number. A viewer's privacy settings may still prevent whispers; Twitch can also silently drop some messages and caps unique whisper recipients at 40 per day. These limits are imposed by Twitch and cannot be raised by the bot.

## Remove the integration

In OBS **Tools → Scripts**, select **Fishingbot Auto-Start** and click **−**. This removes the Lua-script launch path only. In Fishingbot Settings → Startup, turn off **Start the server when OBS starts** and **Start Fishingbot Desktop when Windows starts** as well if you do not want either option registering a sign-in launch.
