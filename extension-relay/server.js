// Fishingbot Twitch Extension Backend Service (EBS) relay.
// The Extension Secret stays here. Desktop clients authenticate with their own
// Twitch user token, publish public snapshots, and keep an outbound WebSocket
// open for viewer requests. The relay validates Twitch Extension JWTs and
// routes only allowlisted requests to the desktop attached to that channel.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { resolveBroadcasterViewer, resolveLinkedViewerIdentity } from './viewer-identity.js';
import { createSnapshotPublishGate } from './snapshot-gate.js';

const PORT = Number(process.env.PORT) || 8787;
const RELAY_BUILD_ID = 'relay-snapshot-recovery-2026-11-01.1';
const DESKTOP_WS_PATH = '/v1/desktop';
const MAX_BODY_BYTES = 32_768;
const MAX_WS_MESSAGE_BYTES = 160_000;
const MAX_PUBSUB_BYTES = 4_700;
const MIN_CHANNEL_INTERVAL_MS = 8_000;
const TOKEN_CACHE_MAX_MS = 30_000;
const VIEWER_RATE_WINDOW_MS = 60_000;
// Account pages issue small parallel batches (overview, map, shop). Keep a
// meaningful per-viewer cap without blocking normal navigation and purchases.
const VIEWER_RATE_LIMIT = 90;
const PUBLIC_RATE_LIMIT = 90;
const RPC_TIMEOUT_MS = 20_000;
const DESKTOP_AUTH_TIMEOUT_MS = 10_000;
const MAX_DESKTOP_CONNECTIONS = 1_000;

const TWITCH_CLIENT_ID = String(process.env.FISHINGBOT_TWITCH_CLIENT_ID || '').trim();
// Optional compatibility allowlist for existing installations. This is a
// public Client ID, never a Client Secret.
const LEGACY_TWITCH_CLIENT_ID = String(process.env.FISHINGBOT_LEGACY_TWITCH_CLIENT_ID || '').trim();
const EXTENSION_ID = String(process.env.TWITCH_EXTENSION_ID || '').trim();
const EXTENSION_OWNER_ID = String(process.env.TWITCH_EXTENSION_OWNER_ID || '').trim();
const EXTENSION_SECRET_B64 = String(process.env.TWITCH_EXTENSION_SECRET || '').trim();
const EXTENSION_SECRET = Buffer.from(EXTENSION_SECRET_B64, 'base64');

const tokenCache = new Map();
const viewerProfileCache = new Map();
const snapshotPublishGate = createSnapshotPublishGate(MIN_CHANNEL_INTERVAL_MS);
const requestRate = new Map();
const connectedDesktops = new Map();
const pendingRequests = new Map();
let desktopUpgradeAttempts = 0;
let desktopUpgradeAccepted = 0;
let desktopPathWithoutUpgrade = 0;
let desktopUpgradeRejected = 0;

function configStatus() {
  return {
    twitchClientId: /^[A-Za-z0-9]{10,128}$/.test(TWITCH_CLIENT_ID),
    legacyTwitchClientId: !LEGACY_TWITCH_CLIENT_ID || /^[A-Za-z0-9]{10,128}$/.test(LEGACY_TWITCH_CLIENT_ID),
    extensionId: /^[A-Za-z0-9]{10,128}$/.test(EXTENSION_ID),
    extensionOwnerId: /^\d{5,20}$/.test(EXTENSION_OWNER_ID),
    extensionSecret: EXTENSION_SECRET.length >= 32
  };
}

function configReady() {
  return Object.values(configStatus()).every(Boolean);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Fishingbot-Relay-Build': RELAY_BUILD_ID,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Extension-JWT, X-Helix-JWT, Authorization',
    ...extraHeaders
  });
  res.end(payload);
}

function sendUpgradeRequired(res) {
  const payload = JSON.stringify({
    ok: false,
    code: 'websocket_upgrade_required',
    error: 'This endpoint requires a WebSocket upgrade. Use wss://<relay-host>/v1/desktop.',
    relayBuild: RELAY_BUILD_ID
  });
  res.writeHead(426, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Connection': 'close',
    'Upgrade': 'websocket',
    'X-Fishingbot-Relay-Build': RELAY_BUILD_ID,
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

function rejectUpgrade(socket, status, code, message) {
  desktopUpgradeRejected += 1;
  const payload = JSON.stringify({ ok: false, code, error: message, relayBuild: RELAY_BUILD_ID });
  const reason = status === 404 ? 'Not Found' : status === 405 ? 'Method Not Allowed' : 'Bad Request';
  const response = [
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(payload)}`,
    'Cache-Control: no-store',
    'Connection: close',
    'X-Fishingbot-Relay-Build: ' + RELAY_BUILD_ID,
    '',
    payload
  ].join('\r\n');
  try { socket.end(response); } catch (_error) { try { socket.destroy(); } catch (_ignored) { } }
}

function corsPreflight(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Extension-JWT, X-Helix-JWT, Authorization',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store'
  });
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_error) {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeName(value, max = 25) {
  return String(value || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, max);
}

function safeText(value, max = 70) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function safeCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return 0;
  return Math.min(count, 9_000_000_000_000);
}

function normalizeSnapshot(input, channelLogin) {
  if (!input || input.type !== 'fishingbot.snapshot' || input.schema !== 1) {
    throw Object.assign(new Error('Unsupported snapshot format.'), { status: 400 });
  }
  const rows = Array.isArray(input.leaderboard) ? input.leaderboard.slice(0, 10) : [];
  const leaderboard = rows.map((row, index) => ({
    rank: index + 1,
    username: safeName(row?.username) || 'Angler',
    casts: safeCount(row?.casts),
    bestCatch: safeText(row?.bestCatch, 56),
    bestTier: safeText(row?.bestTier, 20).toUpperCase()
  }));
  const snapshot = {
    type: 'fishingbot.snapshot', schema: 1, sentAt: Date.now(),
    channel: safeName(channelLogin),
    totalAnglers: safeCount(input.totalAnglers),
    totalCasts: safeCount(input.totalCasts), leaderboard
  };
  let message = JSON.stringify(snapshot);
  if (Buffer.byteLength(message, 'utf8') > MAX_PUBSUB_BYTES) {
    snapshot.leaderboard = leaderboard.slice(0, 5);
    message = JSON.stringify(snapshot);
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_PUBSUB_BYTES) {
    throw Object.assign(new Error('Snapshot exceeds the Twitch Extension PubSub message size limit.'), { status: 413 });
  }
  return message;
}

async function validateStreamerToken(token) {
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const cached = tokenCache.get(key);
  if (cached && cached.validUntil > Date.now()) return cached.identity;

  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
    signal: AbortSignal.timeout(6_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.user_id) {
    throw Object.assign(new Error('Twitch sign-in expired. Reconnect Twitch in Fishingbot.'), { status: 401 });
  }
  const supportedClient = data.client_id === TWITCH_CLIENT_ID ||
    (LEGACY_TWITCH_CLIENT_ID && data.client_id === LEGACY_TWITCH_CLIENT_ID);
  if (!supportedClient) {
    throw Object.assign(new Error('This Twitch account was authorized through an unsupported Fishingbot app.'), { status: 403 });
  }
  const requiredScopes = ['user:read:chat', 'user:write:chat'];
  const grantedScopes = Array.isArray(data.scopes) ? data.scopes : [];
  if (requiredScopes.some((scope) => !grantedScopes.includes(scope))) {
    throw Object.assign(new Error('The Twitch connection is missing required Fishingbot permissions.'), { status: 403 });
  }
  const identity = { userId: String(data.user_id), login: String(data.login || '') };
  const ttl = Math.max(1_000, Math.min(TOKEN_CACHE_MAX_MS, (Number(data.expires_in) || 60) * 1000 - 5_000));
  tokenCache.set(key, { identity, validUntil: Date.now() + ttl });
  if (tokenCache.size > 2_000) {
    for (const [cacheKey, item] of tokenCache) if (item.validUntil <= Date.now()) tokenCache.delete(cacheKey);
  }
  return identity;
}

function signExternalJwt(channelId) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ exp: now + 60, user_id: EXTENSION_OWNER_ID, role: 'external', channel_id: String(channelId), pubsub_perms: { send: ['broadcast'] } });
  const input = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', EXTENSION_SECRET).update(input).digest('base64url');
  return `${input}.${signature}`;
}

async function publishSnapshot(identity, message) {
  const jwt = signExternalJwt(identity.userId);
  const response = await fetch('https://api.twitch.tv/helix/extensions/pubsub', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Client-Id': EXTENSION_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: ['broadcast'], broadcaster_id: identity.userId, message }),
    signal: AbortSignal.timeout(8_000)
  });
  if (response.status !== 204) {
    const detail = await response.text().catch(() => '');
    const safeDetail = String(detail).replace(/[\r\n]+/g, ' ').slice(0, 180);
    const retryAfterSeconds = Math.max(0, Number(response.headers.get('retry-after')) || 0);
    throw Object.assign(new Error(`Twitch PubSub returned HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ''}`), {
      status: response.status === 429 ? 429 : 502,
      code: response.status === 429 ? 'twitch_pubsub_rate_limited' : 'twitch_pubsub_failed',
      retryAfterSeconds
    });
  }
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function verifyExtensionJwt(token) {
  if (!configReady()) throw Object.assign(new Error('The Fishingbot Extension relay is not configured.'), { status: 503 });
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw Object.assign(new Error('A valid Twitch Extension authorization token is required.'), { status: 401 });
  }
  let header;
  let claims;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]));
    claims = JSON.parse(decodeBase64Url(parts[1]));
  } catch (_error) {
    throw Object.assign(new Error('The Twitch Extension token is malformed.'), { status: 401 });
  }
  if (header?.alg !== 'HS256' || (header.typ && header.typ !== 'JWT')) {
    throw Object.assign(new Error('Unsupported Twitch Extension token signature.'), { status: 401 });
  }
  const input = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', EXTENSION_SECRET).update(input).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw Object.assign(new Error('Twitch Extension token signature is invalid.'), { status: 401 });
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= now ||
      (claims.iat != null && Number(claims.iat) > now + 60)) {
    throw Object.assign(new Error('Twitch Extension authorization has expired. Refresh the Extension.'), { status: 401 });
  }
  if (!/^\d{5,20}$/.test(String(claims.channel_id || ''))) {
    throw Object.assign(new Error('The Twitch Extension token does not identify a valid channel.'), { status: 401 });
  }
  if (!['viewer', 'moderator', 'broadcaster'].includes(String(claims.role || ''))) {
    throw Object.assign(new Error('This Twitch Extension role cannot access viewer data.'), { status: 403 });
  }
  return claims;
}

function extensionJwtFromRequest(req) {
  const custom = String(req.headers['x-extension-jwt'] || '').trim();
  if (custom) return custom;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return match?.[1]?.trim() || '';
}

async function resolveViewer(claims, helixToken) {
  // Twitch deliberately does not offer requestIdShare on the broadcaster's
  // own channel. For that one signed role, derive the owner identity from the
  // desktop socket already authenticated against Twitch and keyed by the same
  // signed channel_id. Never accept a browser-supplied username or user ID.
  const broadcasterViewer = resolveBroadcasterViewer(
    claims,
    connectedDesktops.get(String(claims.channel_id || ''))
  );
  if (broadcasterViewer) return broadcasterViewer;

  const userId = String(claims.user_id || '');
  // Validate signed viewer identity before asking Helix to resolve the profile.
  resolveLinkedViewerIdentity(claims, helixToken, { id: userId, login: 'pending_viewer' });

  // Bind the short profile cache to the viewer's Helix token as well as the
  // signed user ID. A copied Extension JWT cannot be paired with an arbitrary
  // viewer token to reuse someone else's cached profile.
  const cacheKey = crypto.createHash('sha256').update(`${userId}:${helixToken}`).digest('hex');
  const cached = viewerProfileCache.get(cacheKey);
  if (cached && cached.validUntil > Date.now()) return cached.profile;

  const response = await fetch(`https://api.twitch.tv/helix/users`, {
    headers: { Authorization: `Extension ${helixToken}`, 'Client-Id': EXTENSION_ID },
    signal: AbortSignal.timeout(6_000)
  });
  const data = await response.json().catch(() => ({}));
  const user = Array.isArray(data.data) ? data.data[0] : null;
  if (!response.ok) {
    throw Object.assign(new Error('Twitch could not verify the shared viewer identity. Refresh the Extension and try again.'), { status: 401, code: 'identity_verification_failed' });
  }
  const profile = resolveLinkedViewerIdentity(claims, helixToken, user);
  viewerProfileCache.set(cacheKey, { profile, validUntil: Date.now() + 5 * 60_000 });
  if (viewerProfileCache.size > 5_000) {
    for (const [key, value] of viewerProfileCache) if (value.validUntil <= Date.now()) viewerProfileCache.delete(key);
  }
  return profile;
}

function takeRateLimit(key, limit) {
  const now = Date.now();
  let entry = requestRate.get(key);
  if (!entry || now - entry.startedAt >= VIEWER_RATE_WINDOW_MS) {
    entry = { startedAt: now, count: 0 };
    requestRate.set(key, entry);
  }
  entry.count += 1;
  if (requestRate.size > 10_000) {
    for (const [rateKey, rate] of requestRate) if (now - rate.startedAt >= VIEWER_RATE_WINDOW_MS) requestRate.delete(rateKey);
  }
  return entry.count <= limit;
}

function sendToDesktop(channelId, message, res, envelope = {}) {
  const socket = connectedDesktops.get(String(channelId));
  if (!socket || socket.readyState !== WebSocket.OPEN || !socket.fishingbotAuthenticated) {
    return sendJson(res, 503, { ok: false, code: 'streamer_offline', error: 'This channel’s Fishingbot desktop is not connected. The streamer must start Fishingbot and connect Twitch.' });
  }
  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => {
    pendingRequests.delete(requestId);
    if (!res.writableEnded) sendJson(res, 504, { ok: false, code: 'desktop_timeout', error: 'Fishingbot did not respond in time. Please retry.' });
  }, RPC_TIMEOUT_MS);
  timer.unref?.();
  pendingRequests.set(requestId, { res, timer, envelope, socket, channelId: String(channelId) });
  try {
    socket.send(JSON.stringify({ ...message, requestId }));
  } catch (_error) {
    clearTimeout(timer);
    pendingRequests.delete(requestId);
    return sendJson(res, 503, { ok: false, code: 'desktop_disconnected', error: 'The streamer’s Fishingbot connection was interrupted.' });
  }
}

function validateViewerRequest(input) {
  const route = String(input?.route || '').toLowerCase();
  const method = String(input?.method || 'GET').toUpperCase();
  const allowed = new Set(['whoami', 'inventory', 'fishdex', 'perks', 'trades', 'areas', 'fish-settings', 'autofish', 'progression', 'pond']);
  if (!allowed.has(route) || !['GET', 'POST'].includes(method)) {
    throw Object.assign(new Error('That Fishingbot account action is not available in the Extension.'), { status: 400 });
  }
  const query = input.query && typeof input.query === 'object' && !Array.isArray(input.query) ? input.query : {};
  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
  if (JSON.stringify(query).length > 2_000 || JSON.stringify(body).length > 12_000) {
    throw Object.assign(new Error('The account request is too large.'), { status: 413 });
  }
  if (route === 'whoami' || route === 'inventory' || route === 'fishdex') {
    if (method !== 'GET') throw Object.assign(new Error('This account view is read-only.'), { status: 405 });
  }
  return { route, method, query, body };
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'OPTIONS') return corsPreflight(res);
  if (req.method === 'GET' && url.pathname === DESKTOP_WS_PATH) {
    // If this arrives as an ordinary HTTP request, an upstream proxy/client
    // did not preserve the WebSocket Upgrade handshake. Do not hide that as a
    // generic 404: return a diagnostic 426 with the deployed relay build ID.
    desktopPathWithoutUpgrade += 1;
    return sendUpgradeRequired(res);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, configReady() ? 200 : 503, {
      ok: configReady(),
      service: 'fishingbot-extension-relay',
      relayBuild: RELAY_BUILD_ID,
      deployCommit: String(process.env.RENDER_GIT_COMMIT || '').slice(0, 40) || null,
      renderService: String(process.env.RENDER_SERVICE_NAME || '').slice(0, 80) || null,
      configuration: configStatus(),
      privateProfile: {
        broadcasterOwnerResolution: true,
        regularViewerIdentityLinkRequired: true
      },
      features: {
        publicLeaderboard: true,
        publicLoot: true,
        publicWorldMap: false,
        privateAccountWorldMap: true,
        websiteStyleMapPurchases: true
      },
      masterAdmin: {
        enabled: true,
        signedBroadcasterOnly: true,
        localOneTimePairing: true
      },
      desktopConnections: connectedDesktops.size,
      snapshotPublishing: {
        minimumChannelIntervalSeconds: MIN_CHANNEL_INTERVAL_MS / 1_000,
        cooldownStartsAfterTwitchAccept: true,
        concurrentPublishesCoalesced: true
      },
      websocket: {
        path: DESKTOP_WS_PATH,
        upgradeListener: true,
        upgradeAttempts: desktopUpgradeAttempts,
        upgradeAccepted: desktopUpgradeAccepted,
        httpRequestsWithoutUpgrade: desktopPathWithoutUpgrade,
        upgradeRejected: desktopUpgradeRejected
      }
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/snapshot') {
    if (!configReady()) return sendJson(res, 503, { ok: false, error: 'The Fishingbot Extension relay is not configured.' });
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json.' });
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    const userToken = match?.[1]?.trim() || '';
    if (userToken.length < 20 || userToken.length > 4096) return sendJson(res, 401, { ok: false, error: 'A valid Fishingbot Twitch sign-in is required.' });
    try {
      const input = await readJson(req);
      const identity = await validateStreamerToken(userToken);
      const message = normalizeSnapshot(input, identity.login);
      const publishResult = await snapshotPublishGate.publish(identity.userId, () => publishSnapshot(identity, message));
      if (!publishResult.accepted) {
        const retryAfterSeconds = publishResult.retryAfterSeconds;
        return sendJson(res, 429, {
          ok: false,
          code: 'snapshot_rate_limited',
          error: 'A snapshot for this channel was published moments ago. Fishingbot will retry automatically.',
          retryAfterSeconds
        }, { 'Retry-After': String(retryAfterSeconds) });
      }
      return sendJson(res, 202, {
        ok: true,
        coalesced: publishResult.coalesced === true,
        publishedAt: new Date(publishResult.publishedAt).toISOString()
      });
    } catch (error) {
      const status = Number(error?.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 502;
      if (status >= 500) console.error('[relay] Snapshot request failed:', String(error?.message || error).slice(0, 240));
      const retryAfterSeconds = Math.max(0, Number(error?.retryAfterSeconds) || 0);
      const body = { ok: false, code: String(error?.code || ''), error: error?.message || 'Relay request failed.' };
      if (retryAfterSeconds) body.retryAfterSeconds = retryAfterSeconds;
      return sendJson(res, status, body, retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {});
    }
  }

  if (req.method === 'POST' && url.pathname === '/v1/public') {
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json.' });
    try {
      const claims = verifyExtensionJwt(extensionJwtFromRequest(req));
      if (!takeRateLimit(`public:${claims.channel_id}:${claims.opaque_user_id || claims.user_id || 'anon'}`, PUBLIC_RATE_LIMIT)) {
        return sendJson(res, 429, { ok: false, code: 'rate_limited', error: 'Please slow down and try again shortly.' });
      }
      const input = await readJson(req);
      const action = String(input.action || '').toLowerCase();
      if (!['leaderboard', 'loot'].includes(action)) return sendJson(res, 400, { ok: false, error: 'Unknown public Extension request.' });
      return sendToDesktop(claims.channel_id, { type: 'public.request', action }, res);
    } catch (error) {
      const status = Number(error?.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 502;
      return sendJson(res, status, { ok: false, code: error?.code || '', error: error?.message || 'Could not load public Fishingbot data.' });
    }
  }

  if (req.method === 'POST' && ['/v1/admin/pair', '/v1/admin/action', '/v1/admin/logout'].includes(url.pathname)) {
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json.' });
    try {
      const claims = verifyExtensionJwt(extensionJwtFromRequest(req));
      if (String(claims.role || '') !== 'broadcaster') {
        throw Object.assign(new Error('Master Admin is restricted to the signed broadcaster identity.'), { status: 403, code: 'master_admin_owner_only' });
      }
      const viewer = resolveBroadcasterViewer(claims, connectedDesktops.get(String(claims.channel_id || '')));
      if (!viewer) throw Object.assign(new Error('The broadcaster identity could not be verified.'), { status: 403, code: 'master_admin_owner_only' });
      const input = await readJson(req);
      let request;
      if (url.pathname === '/v1/admin/pair') {
        if (!takeRateLimit(`admin-pair:${viewer.userId}`, 5)) {
          throw Object.assign(new Error('Too many pairing attempts. Wait a moment and generate a new code.'), { status: 429, code: 'rate_limited' });
        }
        const code = String(input.code || '').trim();
        if (!/^[A-Za-z0-9_-]{40,60}$/.test(code)) {
          throw Object.assign(new Error('Enter the one-time pairing code from the local Fishingbot Control Centre.'), { status: 400, code: 'invalid_pairing_code' });
        }
        request = { action: 'pair', code };
      } else if (url.pathname === '/v1/admin/action') {
        if (!takeRateLimit(`admin-action:${viewer.userId}`, 45)) {
          throw Object.assign(new Error('Master Admin action rate limit reached. Wait before trying again.'), { status: 429, code: 'rate_limited' });
        }
        const sessionId = String(input.sessionId || '');
        if (!/^[A-Za-z0-9_-]{40,60}$/.test(sessionId)) {
          throw Object.assign(new Error('Master Admin is locked. Pair it again from the local Control Centre.'), { status: 401, code: 'admin_session_missing' });
        }
        const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : null;
        if (!payload || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 18_000) {
          throw Object.assign(new Error('Admin action parameters must be a JSON object under 18 KB.'), { status: 413, code: 'admin_payload_invalid' });
        }
        request = { action: 'execute', sessionId, payload };
      } else {
        if (!takeRateLimit(`admin-logout:${viewer.userId}`, 10)) {
          throw Object.assign(new Error('Too many logout requests. Wait a moment.'), { status: 429, code: 'rate_limited' });
        }
        const sessionId = String(input.sessionId || '');
        if (!/^[A-Za-z0-9_-]{40,60}$/.test(sessionId)) {
          return sendJson(res, 200, { ok: true, data: { loggedOut: true } });
        }
        request = { action: 'logout', sessionId };
      }
      return sendToDesktop(claims.channel_id, { type: 'admin.request', viewer, request }, res, { viewer });
    } catch (error) {
      const status = Number(error?.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 502;
      return sendJson(res, status, { ok: false, code: error?.code || '', error: error?.message || 'Could not process the Master Admin request.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/v1/viewer') {
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) return sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json.' });
    try {
      const claims = verifyExtensionJwt(extensionJwtFromRequest(req));
      const input = await readJson(req);
      const request = validateViewerRequest(input);
      const viewer = await resolveViewer(claims, String(req.headers['x-helix-jwt'] || '').trim());
      if (!takeRateLimit(`viewer:${claims.channel_id}:${viewer.userId}`, VIEWER_RATE_LIMIT)) {
        return sendJson(res, 429, { ok: false, code: 'rate_limited', error: 'You have made many account requests in a short period. Wait briefly and retry.' }, { 'Retry-After': '60' });
      }
      return sendToDesktop(claims.channel_id, { type: 'viewer.request', viewer, request }, res, { viewer });
    } catch (error) {
      const status = Number(error?.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 502;
      return sendJson(res, status, { ok: false, code: error?.code || '', error: error?.message || 'Could not process your Fishingbot account request.' });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('[relay] Unhandled request error:', String(error?.message || error).slice(0, 240));
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal relay error.' });
    else res.end();
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
server.on('upgrade', (req, socket, head) => {
  desktopUpgradeAttempts += 1;
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch (_error) {
    rejectUpgrade(socket, 400, 'invalid_upgrade_url', 'The WebSocket request URL is invalid.');
    return;
  }

  if (req.method !== 'GET') {
    rejectUpgrade(socket, 405, 'websocket_get_required', 'WebSocket connections must use GET.');
    return;
  }
  if (url.pathname !== DESKTOP_WS_PATH) {
    rejectUpgrade(socket, 404, 'websocket_route_not_found', `The WebSocket route ${DESKTOP_WS_PATH} was not found.`);
    console.warn(`[relay] Rejected WebSocket upgrade for unknown path ${String(url.pathname).slice(0, 100)}.`);
    return;
  }

  const connectionTokens = String(req.headers.connection || '')
    .split(',').map((value) => value.trim().toLowerCase());
  const upgradeHeader = String(req.headers.upgrade || '').trim().toLowerCase();
  const websocketVersion = String(req.headers['sec-websocket-version'] || '').trim();
  const websocketKey = String(req.headers['sec-websocket-key'] || '').trim();
  if (!connectionTokens.includes('upgrade') || upgradeHeader !== 'websocket' || websocketVersion !== '13' || !websocketKey) {
    rejectUpgrade(socket, 400, 'invalid_websocket_handshake', 'The request did not contain a valid WebSocket upgrade handshake.');
    console.warn('[relay] Rejected malformed WebSocket handshake for /v1/desktop.');
    return;
  }

  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      desktopUpgradeAccepted += 1;
      console.log(`[relay] WebSocket upgrade accepted for ${DESKTOP_WS_PATH} (build ${RELAY_BUILD_ID}).`);
      wss.emit('connection', ws, req);
    });
  } catch (error) {
    desktopUpgradeRejected += 1;
    console.error('[relay] WebSocket upgrade handler failed:', String(error?.message || error).slice(0, 180));
    try { socket.destroy(); } catch (_socketError) { }
  }
});

wss.on('connection', (ws) => {
  if (wss.clients.size > MAX_DESKTOP_CONNECTIONS) {
    ws.close(1013, 'Relay is at connection capacity');
    return;
  }
  ws.fishingbotAuthenticated = false;
  const authTimer = setTimeout(() => {
    if (!ws.fishingbotAuthenticated) {
      try { ws.close(4008, 'Desktop authentication timed out'); } catch (_error) { }
    }
  }, DESKTOP_AUTH_TIMEOUT_MS);
  authTimer.unref?.();
  ws.on('message', async (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch (_error) { ws.close(1003, 'Invalid JSON'); return; }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'desktop.auth' && !ws.fishingbotAuthenticated) {
      try {
        const token = String(message.token || '');
        if (token.length < 20 || token.length > 4096) throw Object.assign(new Error('Invalid desktop token.'), { status: 401 });
        const identity = await validateStreamerToken(token);
        ws.channelId = identity.userId;
        ws.channelLogin = identity.login;
        ws.fishingbotAuthenticated = true;
        clearTimeout(authTimer);
        const previous = connectedDesktops.get(identity.userId);
        if (previous && previous !== ws) {
          try { previous.close(4001, 'Replaced by a newer Fishingbot connection'); } catch (_error) { }
        }
        connectedDesktops.set(identity.userId, ws);
        ws.send(JSON.stringify({ type: 'desktop.ready', channelId: identity.userId }));
        console.log(`[relay] Desktop connected for channel ${safeName(identity.login) || 'unknown'}.`);
      } catch (error) {
        ws.send(JSON.stringify({ type: 'desktop.rejected', error: String(error?.message || 'Twitch authentication failed.').slice(0, 180) }));
        ws.close(4003, 'Twitch authentication failed');
      }
      return;
    }

    if (message.type === 'desktop.heartbeat' && ws.fishingbotAuthenticated) {
      ws.send(JSON.stringify({ type: 'desktop.heartbeat', at: Date.now() }));
      return;
    }

    if (message.type === 'rpc.response' && ws.fishingbotAuthenticated) {
      const requestId = String(message.requestId || '');
      const pending = pendingRequests.get(requestId);
      if (!pending || pending.channelId !== ws.channelId) return;
      pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      const status = Number(message.status);
      const safeStatus = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 500;
      const envelope = pending.envelope?.viewer ? { viewer: pending.envelope.viewer } : {};
      const responseEnvelope = { ok: safeStatus < 400, data: message.body ?? null, ...envelope };
      if (safeStatus >= 400 && message.body?.error) responseEnvelope.error = String(message.body.error).slice(0, 220);
      sendJson(pending.res, safeStatus, responseEnvelope);
      return;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws.fishingbotAuthenticated && connectedDesktops.get(ws.channelId) === ws) {
      connectedDesktops.delete(ws.channelId);
      console.log(`[relay] Desktop disconnected for channel ${safeName(ws.channelLogin) || 'unknown'}.`);
    }
    for (const [requestId, pending] of pendingRequests) {
      if (pending.socket === ws) {
        clearTimeout(pending.timer);
        if (!pending.res.writableEnded) sendJson(pending.res, 503, { ok: false, code: 'desktop_disconnected', error: 'The streamer’s Fishingbot connection was interrupted.' });
        pendingRequests.delete(requestId);
      }
    }
  });
  ws.on('error', () => { /* close handler performs cleanup; never log tokens */ });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] Fishingbot Extension relay listening on port ${PORT} (build ${RELAY_BUILD_ID}).`);
  console.log(`[relay] WebSocket upgrade route registered: GET ${DESKTOP_WS_PATH}.`);
  if (!configReady()) console.warn('[relay] Configure the Twitch Client ID, Extension ID, owner ID and Extension Secret.');
});

function closeAll() {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    if (!pending.res.writableEnded) sendJson(pending.res, 503, { ok: false, code: 'relay_shutdown', error: 'The Fishingbot relay is restarting. Please retry.' });
  }
  pendingRequests.clear();
  for (const ws of connectedDesktops.values()) { try { ws.close(1001, 'Relay shutting down'); } catch (_error) { } }
  connectedDesktops.clear();
  wss.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', closeAll);
process.on('SIGTERM', closeAll);
