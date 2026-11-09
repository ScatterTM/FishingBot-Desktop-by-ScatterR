# OBS auto-start setup guide

Fishingbot can be launched by OBS using the included Lua script. This is separate from Windows login startup: using the OBS script does not register Fishingbot to run when Windows starts.

## Download the script and guide from Fishingbot Desktop

1. Open **Fishingbot Desktop → Settings → General → Startup**.
2. Tick **Set up OBS auto-start (show script download)**. A **Download OBS script + guide** button appears.
3. Click the button and save `Fishingbot-OBS-Setup.zip`. The ZIP contains `fishingbot-autostart.lua` and this setup guide. Extract the ZIP to a folder you can find again.
4. Open OBS Studio and go to **Tools → Scripts**.
5. Click **+** (Add Script) and select the extracted `fishingbot-autostart.lua` file.
6. Select **Fishingbot Auto-Start** in the script list. For **Fishingbot executable**, choose the installed `Fishingbot.exe` path. Do not choose `FishingbotServer.exe`; Fishingbot Desktop starts and supervises its server.
7. Leave **Launch Fishingbot when OBS starts** enabled. Optionally enable **Close Fishingbot on OBS exit (only if this script launched it)** if OBS should close the instance it launched.
8. Close the Scripts window. OBS saves the settings. The script waits briefly when OBS starts, then launches Fishingbot only if it is not already running.

The checkbox in Fishingbot only reveals the download button; OBS must still load the Lua script from **Tools → Scripts**. Once configured, the Lua script is saved in OBS and normally does not need to be imported again after restarting OBS.

## Verify it

1. Close OBS and Fishingbot. Start OBS. Fishingbot Desktop should launch within a few seconds.
2. Confirm `Fishingbot.exe` is running in Task Manager and that the server status turns online in Fishingbot Desktop.
3. Close Fishingbot manually and restart OBS to confirm the script launches it again.
4. If **Close Fishingbot on OBS exit** is enabled, close OBS and confirm that the instance started by the script closes. An instance that was running before OBS started is deliberately left alone.
5. If launch fails, inspect the **Tools → Scripts** log and `%APPDATA%\Fishingbot\obs-launch.log`. Confirm that the executable path exists and Windows PowerShell is available.

## Windows login startup is a separate setting

In **Fishingbot Desktop → Settings → General → Startup**, **Start Fishingbot Desktop when Windows starts** controls Windows sign-in startup and is unchecked by default. Leave it unchecked if Fishingbot should only start when OBS opens. Fishingbot synchronizes this checkbox to the OS login registration on app startup, clearing stale registrations created by older versions. The OBS script remains independent of this option.

## Viewer chat-command reply visibility

Open the Control Centre and choose **Game settings → Fishing and chat → Viewer management command replies**. Select **Private Whisper (default)** to keep `!buy`, `!perks`, `!autofish`, `!areas` and `!treasury` responses private, or **Public Twitch chat** to reply in the channel. Public mode is visible to every viewer and can clutter chat, so choose it deliberately. The command cooldowns and validation apply in either mode. Only Whisper mode needs the bot's `user:manage:whispers` scope; if you choose Whisper, reconnect the bot account after updating so Twitch grants that permission. Twitch may still restrict whispers because of account verification, recipient privacy, or its daily recipient limit.

Viewers can use commands from Twitch desktop or mobile:

| Command | What it does |
|---|---|
| `!buy` | List available perks/items and prices |
| `!buy <perk-id>` | Purchase a perk |
| `!perks` | See active perks and the available shop |
| `!perks enable <perk-id>` | Enable an owned perk |
| `!perks disable <perk-id>` | Disable an owned perk |
| `!autofish start` | Start autofishing |
| `!autofish start <area-id>` | Start autofishing toward an area |
| `!autofish stop` | Stop autofishing |
| `!areas` or `!areas list` | List available/owned areas and Treasury |
| `!areas buy <area-id>` | Buy an area |
| `!areas select <area-id>` | Select an unlocked area |
| `!areas unselect` | Clear the selected area |
| `!treasury` | Show earned, available and spent/used Treasury |

## Remove the integration

In OBS **Tools → Scripts**, select **Fishingbot Auto-Start** and click **−**. OBS will stop launching Fishingbot. If needed, disable Windows login startup separately in Fishingbot Desktop settings.
