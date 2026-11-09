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


## Additional reliability improvements

- OBS auto-start now attempts to find `Fishingbot.exe` in common per-user/system installation folders and Windows uninstall registry entries when no executable path is configured. The detected path is written to `%APPDATA%\Fishingbot\detected-exe-path.txt`; explicit OBS path configuration remains supported.
- Twitch reconnect now allows the previous EventSub socket to close before reopening and returns the bot's actual failure reason instead of a generic reconnect response.
- Desktop automatic update checks log skipped, successful, and failed attempts; retry at six-hour intervals; and recheck on Windows unlock. If a new version is discovered while locked, the modal prompt is deferred until unlock.
- Control Centre notifications in the desktop webview are bridged to the desktop's shared toast stack. The standalone browser experience retains its local toast fallback.

Validation: Electron syntax checks, Node syntax checks for the Twitch server/manager, and the project test suite passed. OBS auto-detection, Windows lock-screen behavior, and Twitch network reconnection still require end-to-end verification on Windows with a live Twitch connection.


## 9. Chat visibility, dropdown appearance and performance

- Game settings now choose public chat (default) or private Whisper for information/management command replies. `!help` and Overview list the full command set.
- Twitch can be disconnected directly from Overview as well as the Twitch tab.
- Custom dropdown menus consume the desktop's live glass, accent, corner-radius and performance-mode CSS variables. The dropdown observer now processes only changed/added subtrees instead of rescanning every select after unrelated DOM updates.
- Validation is static/unit-level only; public Twitch delivery and appearance changes still need runtime verification in the packaged Windows app.


## 10. Searchable dropdown headers

- `desktop-electron/renderer/dropdown.js`: every custom dropdown now includes a search field in its sticky menu header. Typing filters fish/items/options by visible label and value; Enter chooses the first match, arrow keys move through visible results, and Escape closes the menu. Empty searches show all results, while unmatched queries show a no-results message.
- Dropdown option nodes are only rebuilt when the underlying option list changes, so ordinary selection changes and keystrokes do not recreate large fish/inventory menus. The same search UI is used in desktop Settings and injected Control Centre dropdowns.
- `desktop-electron/renderer/dropdown.css`: styles the sticky search header, focus state, filtered results and empty state using the existing app glass/accent variables and performance-mode setting.


### Minimized embedded-app resource usage

- Embedded Control Centre webviews are now scheduled for a pause 5 seconds after their desktop window is minimized (previously 20 seconds). Clean pages are snapshotted and unloaded to `about:blank`, stopping page scripts and polling; they reload when restored. Pages with unsaved edits are deliberately kept loaded to avoid losing work, while Chromium throttles background-page timers. Unfocused but visible pages retain the longer 60-second pause policy. This is implemented in the desktop renderer; runtime resource usage still needs confirmation in a packaged Windows build.
