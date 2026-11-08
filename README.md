# Fishingbot v1.0.0 Beta

Fishingbot is a local-first Twitch fishing game. The Windows desktop app launches a Node.js server and a local SQLite database. The local HTTP service binds to loopback; the optional public Twitch relay forwards authenticated requests and does not host player inventories or balances.

## 1.0.0 Beta

First beta release. It includes the desktop app with its Control Centre, Folder database viewer, Start menu search, OBS-triggered start, the Twitch Extension world map and the relay. The full change history is in `VERSION_LOG.txt`.

## Requirements

- Windows 10/11 for the desktop shell and installer.
- Node.js 22.5 or newer.
- A Twitch application Client ID for the publisher build.
- Optional hosted Twitch relay credentials for the Extension build.

## Development start

1. Copy `.env.example` to `.env` and configure the local Twitch application values.
2. Install dependencies with `npm install`.
3. Run `npm start`.
4. Open the local Control Centre from the desktop shell or visit the loopback URL printed by the launcher.

Never share `.env`, `data/`, SQLite database files, local admin credentials, Twitch tokens, extension secrets or update backups.

## Build and release

- `npm test` runs the automated local policy, Extension structure, private-map, multi-viewer identity, fish-effect and viewer-import tests.
- `npm run test:extension-admin-policy` runs the existing admin-policy test.
- `scripts/package-twitch-extension.ps1` creates `dist/Fishingbot_Twitch_Extension_v1.0.0-beta.zip` and verifies its nine required root-level assets.
- `build.bat` builds the server, the desktop app and the installer in one run.

## Data import

Use the Viewers tab in the local Control Centre. Select a Twitch login and upload a JSON export produced by Fishingbot's viewer export or by a Supabase `kv_store` table export containing `key`, `value` and optional `expires_at` fields. The importer only accepts records under the selected viewer's namespace; it intentionally excludes global configuration, admin credentials, sessions, auth tokens and other viewers. A raw Supabase Auth `users` export is not a supported import format.

## Operational limitations

CPU and network values are monitoring thresholds, not hard OS resource throttles. The RAM control limits the Node.js V8 heap after the next server restart; it does not cap total machine or process RSS. The OBS option starts the local app when OBS is detected; PC startup uses the current Windows user's Run registration.

The automated JavaScript tests do not replace a live Twitch Extension release test. The C# WinForms desktop and installer must be compiled and tested on Windows. OBS startup, manual Supabase imports against a real broadcaster database, and live multi-viewer sign-in should be verified in the intended production setup.

## Licence

Copyright (c) 2026 [Your name or company]. All rights reserved.

This project is proprietary. See `LICENSE`. Viewing the source in this repository does not give permission to use, copy, modify or distribute it. Third-party packages keep their own licences.

## Security

Please report security problems privately, not in a public issue. See `SECURITY.md`.
