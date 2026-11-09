# OBS auto-start setup guide

The OBS integration is a standalone Lua script. It is deliberately separate from Windows sign-in startup: adding the script does not register Fishingbot to run when Windows starts.

## Install and add the script

1. Install Fishingbot Desktop normally. For a source checkout, run the project from the project root; for a built release, the usual executable is `Fishingbot.exe` in the installed Fishingbot folder (often `dist\Fishingbot.exe` during a build).
2. Close OBS if it is currently running, then open the installed/source folder containing `obs-scripts\fishingbot-autostart.lua`.
3. Start OBS Studio.
4. Open **Tools → Scripts**.
5. In the Scripts window, click **+** (Add Script) and select `obs-scripts\fishingbot-autostart.lua` from the Fishingbot folder.
6. Select **Fishingbot Auto-Start** in the script list. In the script properties, set **Fishingbot executable** to the actual `Fishingbot.exe` path. Do not select `FishingbotServer.exe`; the desktop app starts and supervises the server itself.
7. Leave **Launch Fishingbot when OBS starts** enabled. Optionally enable **Close Fishingbot on OBS exit (only if this script launched it)** if you want OBS to close the instance it started.
8. Close the Scripts window. OBS saves script options. On OBS startup, the script waits briefly, then launches the desktop app only if that executable is not already running.

## Verify it

1. With OBS and Fishingbot closed, open OBS. Fishingbot Desktop should launch within a few seconds.
2. Open Task Manager and confirm that `Fishingbot.exe` is running. Check that the local server becomes online in the desktop's status pill.
3. Close Fishingbot manually, then restart OBS to verify the script launches it again.
4. If **Close Fishingbot on OBS exit** is enabled, close OBS and confirm that the app instance started by the script closes. If the app was already running before OBS, the script deliberately leaves it alone.
5. If it does not start, review OBS's **Tools → Scripts** log messages and `%APPDATA%\Fishingbot\obs-launch.log`. Verify that the executable path exists and that Windows PowerShell is available.

## Windows login startup is a separate setting

Open **Fishingbot Desktop → Settings → Startup**. **Start Fishingbot Desktop when Windows starts** keeps the current Windows sign-in behavior (the server also starts when the desktop opens). **Start the server when OBS starts** starts Fishingbot Desktop minimized at sign-in and waits to launch the server until OBS is detected, as long as the Windows-start checkbox is off. Closing the window minimizes Fishingbot while this watcher is enabled; use the app's **Quit** command to exit. The dedicated Lua script above is the alternative when you want OBS to launch Fishingbot even if the desktop app was not already running. On each app launch, Fishingbot synchronizes the saved startup choices to the OS login registration, which also clears stale registrations from older versions.

## Twitch private command setup

Viewer management commands return via Twitch Whispers, so the connected bot account needs `user:manage:whispers` in addition to chat read/write permissions. After updating this build, open the Twitch settings/setup page and reconnect the bot account, accepting the new permission. Without it, the bot intentionally does not publish command results in public chat. The sending Twitch account must have a verified phone number. A viewer's privacy settings may still prevent whispers; Twitch can also silently drop some messages and caps unique whisper recipients at 40 per day. These limits are imposed by Twitch and cannot be raised by the bot.

## Remove the integration

In OBS **Tools → Scripts**, select **Fishingbot Auto-Start** and click **−**. This removes the Lua-script launch path only. In Fishingbot Settings → Startup, turn off **Start the server when OBS starts** and **Start Fishingbot Desktop when Windows starts** as well if you do not want either option registering a sign-in launch.
