# Fishingbot Desktop – v1.0.0 Beta

A desktop environment for Fishingbot. One window, with apps inside it:

- **Desktop**: wallpaper, clock, app icons on the left, widgets on the right (local server,
  Twitch bot, live log preview). The wallpaper can be your own image, and the accent colour,
  glass, icon size, clock format and widgets can be changed (Settings > Appearance).
- **Apps**: one per Control Centre tab (Overview, Loot table, Game settings, Twitch bot,
  Twitch Extension, Viewers, Broadcaster), plus Settings and Live log. Every app opens in its
  own window that can be moved, resized, minimised, maximised and closed. Open windows and their
  positions are remembered.
- **Taskbar**: Menu button (all apps, Lock, Quit) and Settings button, a divider, a button per open
  window, and on the right a status pill each for the server and Twitch, then the clock.
- Links that ask for a new window open as an app inside the desktop. Nothing opens a system
  browser.

Keyboard: Ctrl+1 to Ctrl+7 open a Control Centre app, Ctrl+L the live log, Ctrl+, the settings.

## Settings

Settings is opened from the button right of the Start menu (Ctrl+, also works). Its tabs run down the left side: General (interface, startup, performance, queued changes), Appearance,
Security (session timeout, admin password), Updates (automatic check, update source) and Twitch
(legacy OAuth, Master Admin pairing and unlink). Arrow keys move between tabs.

Every setting saves automatically as you change it. Only actions that need the admin password or
change the server keep a button (Change password, Generate pairing code, Save update source, Save
Twitch settings). Appearance: Undo last change goes back to the look before it.
Options: upload a wallpaper (PNG, JPEG, WebP or GIF, up to 15 MB), choose how it fits, dim and blur
it, or use a solid colour instead; pick an accent colour (six presets or any custom colour); set the
window glass and corner rounding; the icon size and names; the clock (on or off, small, medium or
large, 12 or 24 hour, with seconds, and on the lock screen); the date; the widgets; the taskbar
(size, opacity, full width, auto-hide, clock and server status); the interface font; and reduced motion. The uploaded image is copied to `data\appearance\`. Settings are kept in
`data\app-settings.json` under `appearance`. The look applies to the desktop; Control Centre pages
keep their own colours.

## Sign-in

Fishingbot Desktop starts on a sign-in screen. The first start asks you to create the admin
password (12 characters or more). After that, one sign-in with the admin password unlocks every
app. The session is kept in the Control Centre session, so all app windows are signed in.
Start menu > Lock signs out and locks the desktop again. The Control Centre pages inside app
windows have no sign-in or Lock button of their own; while a page loads, a skeleton loader is shown.

## Build

From the project root, `build.bat` builds everything: server, this app (through
`desktop-electron\build-desktop.bat`), the Twitch Extension package and the installer.
`build-desktop.bat` alone writes `dist\Fishingbot.exe`. The first run downloads Electron (about 100 MB).
The icon is written into the EXE after the build (rcedit), so no admin rights or Developer Mode are needed.

To run from source: `desktop-electron\Start-Desktop.bat`.

## Files

| File | Role |
|------|------|
| `main.js` | Main window, server lifecycle, IPC, settings, updates, explicit Windows login startup |
| `server-manager.js` | Starts or attaches to the server (`OPEN_BROWSER=0`), polls `/local/status`, restarts on exit code 75 |
| `admin.js` | Admin API calls with login cookie and Origin header |
| `settings.js` | `data/app-settings.json` and `.env` values (same defaults and limits as the server) |
| `update.js` | GitHub release check, SHA-256 verification, installer helper |
| `preload.js` | The only bridge to the desktop page. Control Centre pages in webviews get none. |
| `tabs.js` | Control Centre section ids and labels (must match `data-tab` in `local/manager.js`) |
| `renderer/desktop.html`, `desktop.js`, `desktop.css` | Desktop, window manager, taskbar, widgets |
| `renderer/apps/settings.js`, `log.js` | Settings and live log apps (mounted into windows) |
| `appearance.js` | Wallpaper files: checks the image content, copies it into `data/appearance/`, reads it back as a data URL |
| `renderer/appearance.js` | Applies the saved look (accent, glass, icon size, clock, widgets, wallpaper layer) |
| `renderer/i18n.js`, `i18n/desktop.json` | Desktop language: translates the page and the scripts' text (German, Spanish, French, Chinese) |
| `tests/test-appearance.js` | Tests for the settings model, wallpaper files and appearance code (`npm test`) |

## Troubleshooting startup

Each start writes `%APPDATA%\Fishingbot Desktop\startup.log`: the version, when Electron was ready,
when the window was shown and why (page ready, fallback after 4 seconds, or page failed to load).
A crash is written to `crash.log` in the same folder.

## Environment overrides

- `FISHINGBOT_ROOT`: the folder with `local/`, `.env` and `data/`. Default: the parent folder in
  development, the exe's folder when installed.
- `FISHINGBOT_NODE`: path to `node` or `node.exe` (default: `node` on PATH).
- `PORT` or `.env` `PORT`: server port (default 3000).

The server needs Node.js 22.5 or newer, because it uses `node:sqlite`. Electron's own Node is too
old, so the server always runs with a system Node. An installed build uses `FishingbotServer.exe`
instead when it is next to the app.

## OBS launch

OBS launching is controlled by `obs-scripts/fishingbot-autostart.lua`, not the Windows login checkbox. Add it from OBS **Tools → Scripts**, choose `Fishingbot.exe`, and see [`docs/OBS-SETUP.md`](../docs/OBS-SETUP.md). `Start Fishingbot Desktop when Windows starts` affects Windows sign-in only.

## Known gaps

- The desktop is English only. The language choice is saved and applies to the Control Centre.
- The window's title bar uses Windows' overlay buttons. The layout was checked only in code, not on Windows.
- Not yet compiled or run on Windows. Test against `desktop/TEST_PLAN.md` before the release.
  The appearance code is covered by `npm test`; the window, icon and installer launch need a Windows run.
