# Implemented changes

## 1. Private viewer chat commands

- `local/chat-commands.js`: validated `!buy`, `!perks enable|disable`, `!autofish start|stop`, `!areas list|buy|select|unselect`, and `!treasury`; per-user cooldowns and argument allowlists; purchases/area costs use existing game helpers and configured area prices.
- `local/twitch-bot.js`: uses Twitch Whispers for management/read replies, adds the `user:manage:whispers` OAuth scope and a paced, daily-recipient-capped queue. No private-response failure falls back to public chat.
- `docs/CHAT-COMMANDS.md`: full command syntax table, shop IDs, limits and privacy notes.
- **Setup**: reconnect the Twitch bot account and grant the new whisper scope. Twitch recipient limits and recipient privacy controls still apply.

## 2 and 5. OBS auto-start and Windows startup separation

- `desktop-electron/main.js`: Windows login registration is based only on the saved `startOnPc` checkbox and is synchronized at startup, which clears stale registrations from older builds.
- `desktop-electron/renderer/desktop.html`: Startup checkbox copy clarifies that OBS auto-start is separate.
- `obs-scripts/fishingbot-autostart.lua`: adds an OBS Lua script with executable-path selection, launch-on-OBS-start and optional close-on-OBS-exit. It avoids starting a second instance and only closes a PID it launched.
- `build.bat`: packages the new database worker (in addition to the existing database worker).
- `docs/OBS-SETUP.md`: step-by-step OBS install, configuration, verification and troubleshooting.

### Root cause and fix

The previous settings path treated the legacy `startWhenObsStarts` setting as sufficient to enable `app.setLoginItemSettings({ openAtLogin: ... })`, conflating OBS startup with Windows sign-in startup. The old OBS detection watcher also ran inside the desktop app, so it could only react when Fishingbot itself was already running; it could not reliably launch an app that was closed when OBS started. The watcher also depended on detecting an OBS process after app startup. The fix removes that watcher, registers Windows login startup only from `startOnPc`, synchronizes that setting each launch, and delegates OBS lifecycle to a dedicated OBS script.

## 3. Full database batch import

- `lib/db-import-worker.mjs`: JSON/CSV/SQL parsing, source validation, line-numbered errors, 500-row progress checkpoints, duplicate handling, safe allow-listed SQL parsing, transaction/rollback, cancellation and pre-import database snapshot.
- `desktop-electron/db-import-manager.js`: native file picker, extension/size validation, worker/job lifecycle, cancellation and progress status.
- `desktop-electron/main.js` and `desktop-electron/preload.js`: trusted IPC bridge for choose/start/status/cancel.
- `desktop-electron/renderer/desktop.html` and `renderer/apps/settings.js`: Security-tab controls, duplicate policy, progress bar, row counts, ETA and validation errors.
- `desktop-electron/renderer/desktop.css`: import progress and validation error styling.
- `build.bat`: copies `lib/db-import-worker.mjs` into the distributable `dist\lib` folder.
- `docs/DATABASE-IMPORT.md`: accepted formats, policy and recovery notes.

## 4. Dropdown readability

- `desktop-electron/renderer/dropdown.css`: near-opaque dark backing, `backdrop-filter`/WebKit blur, border and shadow ensure menu entries remain legible even if the surrounding glass variables are unavailable.

## Validation performed

The final ZIP should be checked with the Node syntax checks and desktop check script. Windows-specific behavior (OBS Lua integration, login registration and installer packaging) still requires a run on an actual Windows/OBS installation; this Linux container cannot verify those OS integrations end-to-end.


## Follow-up update

- `lib/chat-settings.js`, `local/manager.js`, `local/twitch-bot.js`, and `local/chat-commands.js`: added a streamer setting for viewer management-command replies. **Private Whisper** remains the default; **Public Twitch chat** posts replies via the existing rate-limited public chat queue.
- `desktop-electron/renderer/desktop.html`, `desktop-electron/renderer/apps/settings.js`, `desktop-electron/preload.js`, and `desktop-electron/main.js`: the Startup settings now have an OBS integration checkbox; checking it reveals a **Download OBS script + guide** button. The save dialog writes a ZIP containing the Lua script and setup guide.
- `desktop-electron/obs-download/Fishingbot-OBS-Setup.zip`: a prebuilt setup bundle also included as an Electron extra resource so the button works in packaged installs.
- `docs/OBS-SETUP.md`: updated download-first setup steps, Windows-vs-OBS startup distinctions, reply-visibility option and full viewer command list.
