# Fishingbot Extension relay (EBS)

This Node.js service is the shared Twitch Extension Backend Service for Fishingbot. It is hosted on Render. The Twitch Extension Secret stays here; it is never included in the Windows app or source patch.

The relay has three jobs:

1. Accept and publish public streamer snapshots to Twitch Extension PubSub.
2. Validate Twitch-signed Extension JWTs for public leaderboard and loot requests; the interactive map is private to linked accounts.
3. Validate a viewer's explicitly shared Twitch identity, or securely resolve the channel owner from Twitch's signed broadcaster role and the matching authenticated desktop, then route allowlisted private game requests to that channel's locally running Fishingbot desktop over an authenticated outbound WebSocket.

The relay does not store game inventories, balances, purchases, trades or SQLite data. Those remain on the streamer's PC. The local desktop listens only on `127.0.0.1`; it opens the outbound `wss://.../v1/desktop` connection to this service. No router port forwarding is required.

## Requirements

- Node.js 22 or newer.
- Public HTTPS endpoint (Render supplies HTTPS).
- Twitch Extension ID and its base64 Extension Secret.
- A separate Twitch OAuth app registered as Public for Fishingbot desktop Device Code sign-in.

## Render settings

Use these service settings when the repository contains the relay files at its root:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

If the relay folder is nested in the connected GitHub repository, set Render's Root Directory to `extension-relay`. Keep the Start Command as `npm start`; the relay package runs `node server.js` and checks syntax before startup. If the GitHub repository contains only the contents of the relay folder at its root, leave Root Directory blank instead.

## Environment variables

Set these in Render's Environment panel (never commit real values):

| Variable | Value |
| --- | --- |
| `PORT` | Supplied automatically by Render; default `8787` for local tests. |
| `FISHINGBOT_TWITCH_CLIENT_ID` | Public Client ID used by Fishingbot Desktop Device Code sign-in. |
| `FISHINGBOT_LEGACY_TWITCH_CLIENT_ID` | Optional allowlist for migrated legacy installations. No Client Secret is accepted here. |
| `TWITCH_EXTENSION_ID` | Twitch Extension ID. |
| `TWITCH_EXTENSION_OWNER_ID` | Numeric Twitch user ID of the Extension owner. |
| `TWITCH_EXTENSION_SECRET` | Base64-encoded Twitch Extension Secret Key. |

The Extension Secret is distinct from the Fishingbot Publisher OAuth Client Secret. Do not put either secret in the desktop installer.

## HTTP endpoints

- `GET /health` — configuration readiness, connected desktop count, deployed relay build ID/commit, and in-memory WebSocket upgrade counters. It never returns credentials.
- `POST /v1/snapshot` — public snapshot from a streamer desktop. The relay validates the streamer OAuth token, signs an external Extension JWT and publishes to Twitch PubSub.
- `POST /v1/public` — Extension JWT-authenticated `leaderboard` or `loot` request. The public map endpoint is retired; all map and area ownership data is available only through authenticated private viewer routes.
- `POST /v1/viewer` — Extension JWT-authenticated private viewer request. Regular viewers must explicitly share identity; the relay validates the signed user ID against Twitch Helix. When the role is `broadcaster`, the relay instead derives the owner identity from the signed `channel_id` and the authenticated desktop socket for that exact channel. Only allowlisted game actions are routed to the local desktop.
- `POST /v1/admin/pair` — broadcaster-only one-time Master Admin pairing. The relay validates the signed broadcaster JWT, matches it to the authenticated desktop and forwards the short-lived pairing code without storing it.
- `POST /v1/admin/action` — broadcaster-only Master Admin operation. The relay forwards an opaque session ID and an allowlisted action to the matching desktop; it never receives the actual signed Master Admin token.
- `POST /v1/admin/logout` — locks the in-memory Master Admin session on the desktop.
- `wss://<host>/v1/desktop` — outbound desktop connection, authenticated with the streamer's Twitch user token. The relay sends `public.request`, `viewer.request` and `admin.request` messages; desktop responses use `rpc.response`.

A plain HTTP `GET /v1/desktop` intentionally returns `426 Upgrade Required` (not `404`), identifying that the route exists but the request did not arrive as a WebSocket upgrade. Successful unauthenticated upgrade diagnostics return `101 Switching Protocols`; the socket then closes with `4008` after 10 seconds if no `desktop.auth` message is sent. The `/health` response identifies the deployed code with `relayBuild` and, on Render, `deployCommit`. It also reports `websocket.upgradeAttempts`, `upgradeAccepted`, `httpRequestsWithoutUpgrade`, and `upgradeRejected`. These counters reset on each service restart.

## Twitch Extension configuration

- Enable **Identity Linking** in Extension Capabilities (Request Identity Link).
- Add `https://<your-render-host>` to the Extension URL Fetching allowlist.
- Regular viewers must approve **Share Twitch identity** before private account routes work. Twitch does not show this prompt to a broadcaster viewing their own channel; that owner path is verified against the matching authenticated desktop connection.
- Twitch does not let a broadcaster invoke identity sharing while viewing their own channel; test using a separate viewer account on another channel.

## Local desktop requirements

The desktop build must include `local/twitch-extension-bridge.js`, `local/twitch-extension-rpc.js`, `local/twitch-extension-admin.js` and `local/twitch-extension-admin-policy.js`. It uses Node.js' built-in WebSocket client (Node 22+) and the existing encrypted local Twitch bot token. The bridge reconnects on relay restarts and token refresh. It forwards only the explicit route/action allowlists in the local RPC module.

Each streamer has their own local SQLite game database. A viewer's inventory and progression in this Extension are the records associated with that Twitch username in the currently watched streamer's installation. Those records are not globally synchronized between streamers' PCs.

## Security notes

- Do not expose or bind the local game server to a public interface. Keep it on `127.0.0.1`.
- Do not commit `.env`, Extension secrets, OAuth tokens or SQLite databases.
- Regular viewer identity is derived from the signed Twitch Extension JWT and confirmed with its Helix JWT. For the broadcaster role only, identity is derived from the signed channel ID and the matching desktop socket authenticated by Twitch OAuth. The browser never supplies a trusted username or user ID.
- The local desktop creates short-lived internal sessions in memory and calls existing game handlers. It does not add a second account database.
- Master Admin is enrolled locally: an operator must be signed into the loopback-only Control Centre and re-enter the existing local admin password. The Control Centre generates a random 256-bit pairing code, valid for two minutes and usable once. The password never enters the Twitch iframe or Render.
- The pairing code is held as a SHA-256 digest in desktop memory and is bound to the numeric Twitch user ID verified by the desktop OAuth connection. The username is display-only and is never an authorization key. The binding is stored locally in `data/extension-master-admin.json`, which must remain private and is excluded from source-control delivery.
- After pairing, the actual signed Master Admin API token remains in desktop memory. The Twitch Extension receives only a separate random opaque session ID; it is not persisted in browser storage. Sessions expire after 15 minutes idle or 60 minutes maximum and are revoked by local Control Centre logout, password change, unlink, or desktop bridge shutdown.
- Every Master Admin request requires a fresh signed broadcaster JWT, exact channel-ID match with the authenticated desktop, the local binding, and the opaque session ID. Only the explicit allowlist of existing Admin API operations is accepted. Admin action calls continue through the existing local admin API and audit trail.
- Purchases, trades and upgrades are validated by the existing local game handlers. The Extension UI cannot set balances or item ownership directly.
- The free Render instance may sleep when idle; the next request may be delayed while it wakes. This is a testing/hobby deployment, not a production availability guarantee.

## Deploy and verify the WebSocket route

When updating the relay, commit the changed files under `extension-relay/` (do not commit `.env` or real credentials), push to the branch connected to Render, and wait for the deployment to become Live. Confirm `/health` returns `relayBuild: "relay-snapshot-recovery-2026-11-01.1"` and `privateProfile.broadcasterOwnerResolution: true`, and a `websocket` object containing `path: "/v1/desktop"` and `upgradeListener: true`. A working unauthenticated upgrade test returns HTTP `101 Switching Protocols`; send no token, so it never attempts desktop authentication. If `/health` does not show the relay build ID, Render has not deployed this source/revision or is running a different service/root directory. If `/health` shows the build ID but the handshake still returns an ordinary HTTP response, inspect Render's service logs for the `WebSocket upgrade` messages and verify the public host points at this Web Service.


## Twitch Extension Master Admin enrollment

1. Connect the intended broadcaster account in Fishingbot Desktop. In the Control Centre, confirm the displayed Twitch login is the account you want to enroll.
2. Open Control Centre → Security. Sign in locally, then re-enter the existing Master Admin password and generate a one-time pairing code.
3. In the broadcaster's Twitch Extension, open My Account → Master Admin and redeem the code within two minutes.
4. The first successful redemption binds the broadcaster's numeric Twitch ID locally. A later Twitch username change does not transfer or revoke ownership. Switching accounts requires the local password and an explicit unlink.
5. The real Master Admin token remains in the desktop process. Only an opaque session ID is held in Extension memory. A fresh pairing replaces any previous Extension Master Admin session for the same owner.

The pairing workflow requires the matching authenticated desktop connection. Regular viewers cannot enter the Master Admin area even if they can use the normal private profile features. Never copy the pairing code into chat, public messages, screenshots or support tickets.


## Snapshot publishing and rate-limit recovery

The desktop publishes the public channel snapshot every 12 seconds. The relay enforces an 8-second minimum interval per broadcaster, coalesces concurrent requests for the same broadcaster, and starts its cooldown only after Twitch accepts the PubSub publish. Failed Twitch publishes do not consume the cooldown. A genuine cooldown response uses HTTP `429`, code `snapshot_rate_limited`, and a `Retry-After` header; the desktop treats this as a scheduling collision and retries without marking the relay disconnected. `/health` exposes a `snapshotPublishing` object describing these rules. Run `npm test` before deploying; it includes the snapshot gate concurrency, cooldown and failure-recovery tests.
