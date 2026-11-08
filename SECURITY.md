# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Email the maintainer instead: fishingsyshub@gmail.com. Include what you found, the steps to reproduce it and the version (Fishingbot 1.0.0 Beta).

## Secrets and private data

Never commit or share these. The repository's `.gitignore` already excludes most of them, but check before every push:

- `.env` and `.env.*` files (Twitch Extension secret, OAuth and admin values)
- `data/` (SQLite databases, encrypted Twitch tokens, local admin credentials, `extension-master-admin.json`)
- Update backups, startup and crash logs, and any exported viewer data
- Signing certificates and their passwords

The Twitch Extension secret belongs only in the relay's hosting environment (Render), never in the desktop app or this repository.
