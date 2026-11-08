// Twitch verification for broadcasters.
//
// A streamer connects their Twitch account from the Broadcaster Admin panel.
// We keep their refresh token and use it to ask Twitch whether a viewer is a
// moderator, VIP, or subscriber in that channel. This replaces the Fossabot
// role lookup for verified channels: Twitch is the source of truth.
import { db } from './db.js';
import { parseCookies } from './session.js';
import { normalizeBroadcasterLogin, verifyBroadcasterAdminSession } from './broadcaster-admin.js';

// Twitch scopes the broadcaster must grant. Each one maps to one Helix check.
export const BROADCASTER_SCOPES = [
  'moderation:read',            // GET /moderation/moderators
  'channel:read:vips',          // GET /channels/vips
  'channel:read:subscriptions'  // GET /subscriptions/user
];

const ADMIN_COOKIE = 'fh_broadcaster_admin';
const HELIX = 'https://api.twitch.tv/helix';
const REQUEST_TIMEOUT_MS = 2500;
const RESULT_TTL_SECONDS = 60;           // keep role changes reasonably fresh; Twitch remains source of truth
const USER_ID_TTL_SECONDS = 7 * 24 * 3600;

const LEVEL = { broadcaster: 1500, mod: 500, vip: 400, sub: 250, viewer: 100 };

const accessCache = new Map();   // channel -> { token, expiresAt }
const refreshInFlight = new Map(); // channel -> Promise (one refresh at a time)

const recordKey = (channel) => `broadcaster_twitch:${normalizeBroadcasterLogin(channel)}`;

export function getBroadcasterAdminSession(req) {
  return verifyBroadcasterAdminSession(parseCookies(req)[ADMIN_COOKIE]);
}

export async function getBroadcasterTwitchRecord(channel) {
  const raw = await db.get(recordKey(channel)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function saveBroadcasterTwitchRecord(channel, record) {
  await db.set(recordKey(channel), JSON.stringify(record));
}

export async function deleteBroadcasterTwitchRecord(channel) {
  const key = normalizeBroadcasterLogin(channel);
  accessCache.delete(key);
  await db.del(recordKey(key));
}

// True only when the stored grant exists and includes every required scope.
export function recordIsComplete(record) {
  const granted = Array.isArray(record?.scopes) ? record.scopes : [];
  return !!record?.refreshToken && BROADCASTER_SCOPES.every((s) => granted.includes(s));
}

function clientCredentials() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Twitch client credentials are not configured.');
  return { clientId, clientSecret };
}

// Returns a valid broadcaster access token. Refresh tokens rotate on every use,
// so the new one is saved immediately. Concurrent casts share one refresh.
async function accessTokenFor(channel) {
  const key = normalizeBroadcasterLogin(channel);
  const cached = accessCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);

  const work = (async () => {
    const record = await getBroadcasterTwitchRecord(key);
    if (!recordIsComplete(record)) throw new Error('channel is not connected to Twitch');
    const { clientId, clientSecret } = clientCredentials();
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      // Twitch's error text (for example "Invalid refresh token") is safe to show: it never includes tokens.
      const reason = typeof data.message === 'string' && data.message ? `: ${data.message.slice(0, 160)}` : '';
      console.error(`Broadcaster token refresh failed for ${key} (HTTP ${res.status})${reason}`);
      throw new Error(`token refresh failed (HTTP ${res.status})${reason}`);
    }
    await saveBroadcasterTwitchRecord(key, {
      ...record,
      refreshToken: data.refresh_token || record.refreshToken,
      scopes: Array.isArray(data.scope) ? data.scope : record.scopes,
      refreshedAt: new Date().toISOString()
    });
    accessCache.set(key, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
    return data.access_token;
  })();

  refreshInFlight.set(key, work);
  try { return await work; } finally { refreshInFlight.delete(key); }
}

async function helix(path, token, clientId) {
  return fetch(`${HELIX}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

async function viewerIdFor(login, token, clientId) {
  const cacheKey = `twitch_uid:${login}`;
  const cached = await db.get(cacheKey).catch(() => null);
  if (cached) return String(cached);
  const res = await helix(`/users?login=${encodeURIComponent(login)}`, token, clientId);
  if (!res.ok) throw new Error(`users lookup failed (HTTP ${res.status})`);
  const id = (await res.json())?.data?.[0]?.id;
  if (!id) return null;
  await db.set(cacheKey, String(id), { ex: USER_ID_TTL_SECONDS }).catch(() => {});
  return String(id);
}

// Turns the three Twitch list checks into one role. A check that failed (for
// example a 401 on the subscriptions endpoint) counts as "no match" instead of
// cancelling the whole lookup, so a confirmed VIP/Mod still gets its luck.
async function readListCheck(res, name) {
  if (!res.ok) {
    // Keep Twitch's own reason (its JSON "message") so the diagnostic can show it.
    const body = await res.json().catch(() => ({}));
    const message = String(body?.message || body?.error || '').trim() || null;
    console.warn(`[Broadcaster Twitch] ${name} check returned HTTP ${res.status}${message ? `: ${message}` : ''}`);
    return { ok: false, match: false, status: res.status, message };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, match: Array.isArray(data?.data) && data.data.length > 0, status: res.status };
}

function roleFromChecks(checks) {
  if (checks.moderator?.match) return 'mod';
  if (checks.vip?.match) return 'vip';
  if (checks.subscriber?.match) return 'sub';
  return 'viewer';
}

// Asks Twitch who owns a token and which scopes it really carries. Read-only.
async function validateTwitchToken(token) {
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) return { error: `validate HTTP ${res.status}` };
    const data = await res.json();
    return { userId: String(data.user_id || ''), login: data.login || null, scopes: Array.isArray(data.scopes) ? data.scopes : [] };
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

// Run a fresh, non-cached role diagnostic. This deliberately returns only
// safe metadata (never access/refresh tokens) so Broadcaster Admin can explain
// why a verified channel is or is not granting role-based luck.
export async function diagnoseTwitchRole(channel, viewerLogin) {
  const ch = normalizeBroadcasterLogin(channel);
  const login = normalizeBroadcasterLogin(viewerLogin);
  const record = await getBroadcasterTwitchRecord(ch);
  const granted = Array.isArray(record?.scopes) ? record.scopes : [];
  const missingScopes = BROADCASTER_SCOPES.filter((scope) => !granted.includes(scope));
  const result = {
    channel: ch, viewer: login,
    configured: !!process.env.TWITCH_CLIENT_ID && !!process.env.TWITCH_CLIENT_SECRET,
    verified: recordIsComplete(record), broadcasterLogin: record?.login || null,
    broadcasterId: record?.broadcasterId || null, connectedAt: record?.connectedAt || null,
    scopes: granted, missingScopes, tokenHealthy: false, viewerFound: false, viewerId: null,
    role: null, level: null, checks: { moderator: null, vip: null, subscriber: null }, error: null
  };
  if (!recordIsComplete(record)) {
    result.error = missingScopes.length ? `Missing Twitch permissions: ${missingScopes.join(', ')}` : 'No complete Twitch broadcaster connection is stored.';
    return result;
  }
  if (!result.configured) { result.error = 'TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is missing.'; return result; }
  if (!login) { result.error = 'Enter a Twitch username to test.'; return result; }
  try {
    const { clientId } = clientCredentials();
    const token = await accessTokenFor(ch); result.tokenHealthy = true;
    const tokenInfo = await validateTwitchToken(token);
    const notes = [];
    if (tokenInfo.error) {
      notes.push(`Could not validate the stored token (${tokenInfo.error}).`);
    } else {
      result.tokenUserId = tokenInfo.userId; result.tokenLogin = tokenInfo.login;
      if (tokenInfo.userId !== String(record.broadcasterId)) {
        notes.push(`The stored token belongs to @${tokenInfo.login || tokenInfo.userId}, not the verified broadcaster @${record.login || ch}. Reconnect Twitch while logged in as the broadcaster.`);
      }
      const missingOnToken = BROADCASTER_SCOPES.filter((scope) => !tokenInfo.scopes.includes(scope));
      if (missingOnToken.length) {
        notes.push(`The live token is missing: ${missingOnToken.join(', ')}. Reconnect Twitch to grant them.`);
      }
    }
    const viewerId = await viewerIdFor(login, token, clientId);
    if (!viewerId) { result.error = `Twitch could not find @${login}.`; return result; }
    result.viewerFound = true; result.viewerId = viewerId;
    if (viewerId === String(record.broadcasterId)) { result.role = 'broadcaster'; result.level = LEVEL.broadcaster; return result; }
    const q = `broadcaster_id=${encodeURIComponent(record.broadcasterId)}&user_id=${encodeURIComponent(viewerId)}`;
    const [mods, vips, subs] = await Promise.all([
      helix(`/moderation/moderators?${q}`, token, clientId),
      helix(`/channels/vips?${q}`, token, clientId),
      helix(`/subscriptions/user?${q}`, token, clientId)
    ]);
    const parseListCheck = async (res, name) => {
      if (res.status === 404 && name === 'subscriber') return { ok: true, match: false, status: 404 };
      return readListCheck(res, name);
    };
    result.checks.moderator = await parseListCheck(mods, 'moderator');
    result.checks.vip = await parseListCheck(vips, 'vip');
    result.checks.subscriber = await parseListCheck(subs, 'subscriber');
    const failed = Object.entries(result.checks).filter(([, check]) => !check?.ok);
    if (failed.length === Object.keys(result.checks).length) {
      result.error = [...notes, `All Twitch role checks failed: ${failed.map(([name, check]) => `${name} HTTP ${check.status}${check.message ? ` (Twitch: ${check.message})` : ''}`).join(', ')}.`].join(' ');
      return result;
    }
    const role = roleFromChecks(result.checks);
    result.role = role; result.level = LEVEL[role];
    if (notes.length) result.error = notes.join(' ');
    if (failed.length) {
      result.error = [...notes, `Role resolved from the other checks. Failed: ${failed.map(([name, check]) => `${name} HTTP ${check.status}${check.message ? ` (Twitch: ${check.message})` : ''}`).join(', ')}.`].join(' ');
    }
    return result;
  } catch (error) { result.error = error?.message || String(error); return result; }
}

// Returns the viewer's level in a channel from Twitch's own data:
// broadcaster 1500, mod 500, VIP 400, sub 250, otherwise 100.
// Returns null when the channel hasn't connected Twitch, so the caller can
// fall back to its older sources. Throws on Twitch errors.
export async function resolveTwitchLevel(channel, viewerLogin, { forceRefresh = false } = {}) {
  const ch = normalizeBroadcasterLogin(channel);
  const login = normalizeBroadcasterLogin(viewerLogin);
  if (!ch || !login) return null;

  const record = await getBroadcasterTwitchRecord(ch);
  if (!recordIsComplete(record)) return null;

  const resultKey = `twitch_level:${ch}:${login}`;
  const cached = await db.get(resultKey).catch(() => null);
  if (!forceRefresh && cached !== null && cached !== undefined && cached !== '') return Number(cached);

  const { clientId } = clientCredentials();
  const token = await accessTokenFor(ch);
  const viewerId = await viewerIdFor(login, token, clientId);
  if (!viewerId) return LEVEL.viewer;

  let level;
  if (viewerId === String(record.broadcasterId)) {
    level = LEVEL.broadcaster;
  } else {
    const q = `broadcaster_id=${encodeURIComponent(record.broadcasterId)}&user_id=${encodeURIComponent(viewerId)}`;
    const [mods, vips, subs] = await Promise.all([
      helix(`/moderation/moderators?${q}`, token, clientId),
      helix(`/channels/vips?${q}`, token, clientId),
      helix(`/subscriptions/user?${q}`, token, clientId)
    ]);
    // Twitch answers 404 when the viewer is not subscribed.
    const checks = {
      moderator: await readListCheck(mods, 'moderator'),
      vip: await readListCheck(vips, 'vip'),
      subscriber: subs.status === 404 ? { ok: true, match: false, status: 404 } : await readListCheck(subs, 'subscriber')
    };
    if (!Object.values(checks).some((check) => check.ok)) {
      throw new Error(`Twitch role checks failed (moderator ${checks.moderator.status}, vip ${checks.vip.status}, subscriber ${checks.subscriber.status})`);
    }
    level = LEVEL[roleFromChecks(checks)];
  }

  await db.set(resultKey, String(level), { ex: RESULT_TTL_SECONDS }).catch(() => {});
  return level;
}

export async function revokeBroadcasterTwitch(channel) {
  try {
    const token = await accessTokenFor(channel);
    const { clientId } = clientCredentials();
    await fetch('https://id.twitch.tv/oauth2/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    console.warn('[Broadcaster Twitch] revoke skipped:', error?.message || error);
  }
}
