// The chat bot for the local edition.
//
// The streamer signs in once with Twitch. That account becomes the bot:
//   - it reads its own channel's chat through EventSub (WebSocket),
//   - "!fish" is answered by the same handler used by the website, called
//     in-process; read-only player commands expose only the sender’s own data,
//   - replies are posted back with the Helix chat API as the streamer.
//
// Tokens are stored in the local SQLite file, encrypted with a key derived
// from SESSION_SECRET. Refresh tokens rotate on every use, so the new one is
// saved each time.

import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import fishHandler from '../api/fish.js';
import { isChatInfoCommand, runChatInfoCommand } from './chat-commands.js';
import { RELEASE_CONFIG } from './release-config.js';
import { readChatSettings, takeAnnouncements } from '../lib/chat-settings.js';

const ACCOUNT_KEY = 'local:bot:account';
const SCOPES = ['user:read:chat', 'user:write:chat', 'user:manage:whispers'];
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const HELIX = 'https://api.twitch.tv/helix';
const EVENTSUB_WS = 'wss://eventsub.wss.twitch.tv/ws';
const SEND_INTERVAL_MS = 1100;      // stays well inside Twitch's chat rate limit
const WHISPER_INTERVAL_MS = 750;    // below Twitch's 100/min whisper ceiling
const FISH_TIMEOUT_MS = 15000;
const WATCHDOG_MS = 15000;
const STALE_AFTER_MS = 40000;       // EventSub keepalives normally arrive every ~10s

const state = {
  status: 'disconnected',           // disconnected | connecting | live | error
  lastError: null,
  lastChatAt: null,
  lastReplyAt: null
};

let account = null;                  // { userId, login, displayName, scopes, refreshToken }
let accessToken = null;
let accessExpiresAt = 0;
let socket = null;
let sessionId = null;
let stopping = false;
let retryTimer = null;
let retryDelay = 2000;
let lastFrameAt = 0;
let watchdog = null;
const pendingStates = new Map();
const sendQueue = [];
let sending = false;
const whisperQueue = [];
let sendingWhispers = false;
let whisperDay = '';
const whisperedRecipientsToday = new Set();

// ---- Settings and token storage --------------------------------------------

function websiteClientId() { return process.env.TWITCH_CLIENT_ID || RELEASE_CONFIG.websiteTwitchClientId || ''; }
function botClientId() { return process.env.BOT_TWITCH_CLIENT_ID || RELEASE_CONFIG.botTwitchClientId || ''; }
function activeClientId() { return account?.authFlow === 'device_code' ? botClientId() : websiteClientId(); }
function clientSecret() { return process.env.TWITCH_CLIENT_SECRET || ''; }
function baseUrl() { return String(process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''); }
export function redirectUri() { return `${baseUrl()}/local/bot/callback`; }

// Device Code is the public-client flow for desktop apps. It avoids shipping
// a shared Twitch Client Secret in every user's installation.
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
let pendingDeviceLogin = null;

function sealKey() {
  return crypto.createHash('sha256').update(`${process.env.SESSION_SECRET || ''}|local-bot`).digest();
}

function seal(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

function unseal(sealed) {
  const [iv, tag, body] = String(sealed).split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

async function loadAccount() {
  const raw = await db.get(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw);
    return {
      userId: stored.userId,
      login: stored.login,
      displayName: stored.displayName,
      scopes: stored.scopes || [],
      connectedAt: stored.connectedAt,
      authFlow: stored.authFlow || 'authorization_code',
      refreshToken: unseal(stored.refreshSealed)
    };
  } catch (error) {
    console.error('[bot] Stored bot account could not be read (did SESSION_SECRET change?):', error.message);
    return null;
  }
}

async function saveAccount(next) {
  account = next;
  await db.set(ACCOUNT_KEY, JSON.stringify({
    userId: next.userId,
    login: next.login,
    displayName: next.displayName,
    scopes: next.scopes,
    connectedAt: next.connectedAt,
    authFlow: next.authFlow || 'authorization_code',
    refreshSealed: seal(next.refreshToken)
  }));
}

// ---- Twitch HTTP helpers ----------------------------------------------------

async function postToken(params, { includeSecret = true, clientId: requestedClientId } = {}) {
  const body = { client_id: requestedClientId || websiteClientId(), ...params };
  if (includeSecret && clientSecret()) body.client_secret = clientSecret();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !!data.access_token, status: res.status, data };
}

// Device Code refresh tokens are single-use: Twitch rotates them on every call.
// Two callers refreshing at the same moment (e.g. EventSub and a Helix call during
// startup) used to send the same old token twice, and the second was refused.
// All refreshes now share one in-flight request, and a refused refresh is retried
// once with the newest token saved in the database.
let refreshInFlight = null;

async function refreshAccessToken() {
  if (!account) throw new Error('No bot account is connected.');
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefresh(retried = false) {
  const usedToken = account.refreshToken;
  // Public Device Code clients must rotate their one-time refresh token on
  // every refresh and must not send a Client Secret.
  const result = await postToken(
    { grant_type: 'refresh_token', refresh_token: usedToken },
    {
      includeSecret: account.authFlow !== 'device_code',
      clientId: account.authFlow === 'device_code' ? botClientId() : websiteClientId()
    }
  );
  if (!result.ok) {
    // Another process may have rotated the token after we loaded it. Use the stored one.
    if (!retried) {
      const latest = await loadAccount().catch(() => null);
      if (latest && latest.refreshToken && latest.refreshToken !== usedToken) {
        account = latest;
        return doRefresh(true);
      }
    }
    accessToken = null;
    const reason = result.data?.message || `HTTP ${result.status}`;
    throw new Error(`Twitch refused the bot token (${reason}). Connect the bot account again on the setup page.`);
  }
  accessToken = result.data.access_token;
  accessExpiresAt = Date.now() + Number(result.data.expires_in || 3600) * 1000;
  if (result.data.refresh_token && result.data.refresh_token !== account.refreshToken) {
    await saveAccount({ ...account, refreshToken: result.data.refresh_token });
  }
  return accessToken;
}

async function currentToken() {
  if (accessToken && Date.now() < accessExpiresAt - 60000) return accessToken;
  return refreshAccessToken();
}

// Calls the Helix API as the bot account. One retry after a forced refresh on 401.
async function helix(path, { method = 'GET', body } = {}, retried = false) {
  const token = await currentToken();
  const res = await fetch(`${HELIX}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': activeClientId(),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && !retried) {
    accessToken = null;
    return helix(path, { method, body }, true);
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---- Public status and login -------------------------------------------------

export function botIdentity() {
  return account?.userId ? { userId: String(account.userId), login: account.login || '' } : null;
}

export function botStatus() {
  return {
    configured: !!botClientId(),
    deviceCodeConfigured: !!botClientId(),
    connected: !!account,
    authFlow: account?.authFlow || null,
    userId: account?.userId ? String(account.userId) : null,
    login: account?.login || null,
    displayName: account?.displayName || null,
    connectedAt: account?.connectedAt || null,
    status: state.status,
    lastError: state.lastError,
    lastChatAt: state.lastChatAt,
    lastReplyAt: state.lastReplyAt
  };
}

export async function beginDeviceLogin() {
  if (!botClientId()) throw new Error('This Fishingbot build is missing its public Twitch Device Code Client ID.');
  // Only one pending device login is needed for a single local Fishingbot
  // instance. Replacing it invalidates the earlier code.
  pendingDeviceLogin = null;
  const res = await fetch('https://id.twitch.tv/oauth2/device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: botClientId(), scopes: SCOPES.join(' ') })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(data.message || `Twitch device sign-in could not start (HTTP ${res.status}).`);
  }
  const intervalSeconds = Math.max(5, Number(data.interval) || 5);
  pendingDeviceLogin = {
    deviceCode: String(data.device_code),
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 1800) * 1000,
    intervalSeconds,
    nextPollAt: Date.now() + intervalSeconds * 1000
  };
  return {
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    verificationUriComplete: typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : '',
    expiresIn: Math.max(60, Number(data.expires_in) || 1800),
    intervalSeconds
  };
}

export async function pollDeviceLogin() {
  const pending = pendingDeviceLogin;
  if (!pending) return { ok: false, state: 'missing', message: 'Start a new Twitch sign-in.' };
  if (Date.now() >= pending.expiresAt) {
    pendingDeviceLogin = null;
    return { ok: false, state: 'expired', message: 'The Twitch sign-in code expired. Start again.' };
  }
  if (Date.now() < pending.nextPollAt) {
    return { ok: true, state: 'pending', retryAfterSeconds: Math.max(1, Math.ceil((pending.nextPollAt - Date.now()) / 1000)) };
  }

  pending.nextPollAt = Date.now() + pending.intervalSeconds * 1000;
  const result = await postToken({
    grant_type: DEVICE_GRANT,
    device_code: pending.deviceCode,
    scopes: SCOPES.join(' ')
  }, { includeSecret: false, clientId: botClientId() });

  if (!result.ok) {
    const reason = String(result.data?.message || result.data?.error || '').toLowerCase();
    if (reason.includes('authorization_pending') || reason.includes('authorization pending')) {
      return { ok: true, state: 'pending', retryAfterSeconds: pending.intervalSeconds };
    }
    if (reason.includes('slow_down') || reason.includes('slow down')) {
      pending.intervalSeconds = Math.min(30, pending.intervalSeconds + 5);
      pending.nextPollAt = Date.now() + pending.intervalSeconds * 1000;
      return { ok: true, state: 'pending', retryAfterSeconds: pending.intervalSeconds };
    }
    if (reason.includes('access_denied') || reason.includes('access denied')) {
      pendingDeviceLogin = null;
      return { ok: false, state: 'denied', message: 'Twitch sign-in was cancelled.' };
    }
    if (reason.includes('expired') || reason.includes('invalid device')) {
      pendingDeviceLogin = null;
      return { ok: false, state: 'expired', message: 'The Twitch sign-in code expired. Start again.' };
    }
    return { ok: false, state: 'error', message: result.data?.message || `Twitch sign-in failed (HTTP ${result.status}).` };
  }

  const accessTokenValue = result.data.access_token;
  const check = await fetch(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessTokenValue}` } });
  const info = await check.json().catch(() => ({}));
  if (!check.ok || !info.user_id) {
    pendingDeviceLogin = null;
    return { ok: false, state: 'error', message: 'Twitch could not verify the signed-in account.' };
  }
  const granted = Array.isArray(info.scopes) ? info.scopes : (Array.isArray(result.data.scope) ? result.data.scope : []);
  const missing = SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    pendingDeviceLogin = null;
    return { ok: false, state: 'error', message: `Twitch did not grant the required chat permissions: ${missing.join(', ')}.` };
  }
  if (!result.data.refresh_token) {
    pendingDeviceLogin = null;
    return { ok: false, state: 'error', message: 'Twitch did not return a refresh token. Please sign in again.' };
  }

  accessToken = accessTokenValue;
  accessExpiresAt = Date.now() + Number(result.data.expires_in || 14400) * 1000;
  await saveAccount({
    userId: String(info.user_id),
    login: String(info.login || '').toLowerCase(),
    displayName: String(info.login || ''),
    scopes: granted,
    connectedAt: new Date().toISOString(),
    authFlow: 'device_code',
    refreshToken: result.data.refresh_token
  });
  pendingDeviceLogin = null;
  console.log(`[bot] Connected bot account with Device Code: ${account.login}`);
  restartEventSub();
  return { ok: true, state: 'connected', message: `Bot account connected: ${account.login}.` };
}

// Legacy Authorization Code flow is retained for existing installations and
// callback links. New installations use beginDeviceLogin()/pollDeviceLogin().
export function beginLogin() {
  if (!websiteClientId() || !clientSecret()) {
    throw new Error('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in the .env file first.');
  }
  const stateToken = crypto.randomBytes(16).toString('hex');
  pendingStates.set(stateToken, Date.now() + 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: websiteClientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: stateToken,
    force_verify: 'true'
  });
  return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
}

// Called from /local/bot/callback. Returns { ok, message }.
export async function finishLogin({ code, stateToken, error }) {
  if (error) return { ok: false, message: 'Twitch login was cancelled or denied.' };
  const expires = pendingStates.get(stateToken);
  pendingStates.delete(stateToken);
  if (!expires || expires < Date.now()) {
    return { ok: false, message: 'This login link has expired. Start again from the setup page.' };
  }
  if (!code) return { ok: false, message: 'Twitch did not return a login code.' };

  const exchange = await postToken(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri() },
    { includeSecret: true, clientId: websiteClientId() }
  );
  if (!exchange.ok || !exchange.data.refresh_token) {
    return { ok: false, message: `Token exchange failed: ${exchange.data?.message || 'HTTP ' + exchange.status}.` };
  }
  accessToken = exchange.data.access_token;
  accessExpiresAt = Date.now() + Number(exchange.data.expires_in || 3600) * 1000;

  const check = await fetch(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } });
  const info = await check.json().catch(() => ({}));
  if (!check.ok || !info.user_id) return { ok: false, message: 'Could not read the Twitch account for this token.' };

  const granted = Array.isArray(info.scopes) ? info.scopes : [];
  const missing = SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) {
    return { ok: false, message: `Twitch did not grant every permission (missing: ${missing.join(', ')}). Connect again and accept all of them.` };
  }

  await saveAccount({
    userId: String(info.user_id),
    login: String(info.login || '').toLowerCase(),
    displayName: String(info.login || ''),
    scopes: granted,
    connectedAt: new Date().toISOString(),
    authFlow: 'authorization_code',
    refreshToken: exchange.data.refresh_token
  });
  console.log(`[bot] Connected bot account: ${account.login}`);
  restartEventSub();
  return { ok: true, message: `Bot account connected: ${account.login}.` };
}

export async function getBotAccessToken() {
  if (!account) return null;
  return currentToken();
}

export async function disconnectBot() {
  stopEventSub();
  const current = account || await loadAccount();
  if (current?.refreshToken) {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: current.authFlow === 'device_code' ? botClientId() : websiteClientId(),
        token: current.refreshToken
      })
    }).catch(() => null);
  }
  account = null;
  accessToken = null;
  await db.del(ACCOUNT_KEY);
  state.status = 'disconnected';
  state.lastError = null;
  console.log('[bot] Bot account disconnected.');
}

// ---- EventSub (chat) ----------------------------------------------------------

export function stopBot() {
  stopEventSub();
}

export async function startBot() {
  account = await loadAccount();
  if (!account) {
    state.status = 'disconnected';
    return false;
  }
  if (account.authFlow === 'device_code' && !botClientId()) {
    state.status = 'error';
    state.lastError = 'The public Twitch Device Code Client ID is missing from this Fishingbot build.';
    return false;
  }
  if (account.authFlow !== 'device_code' && (!websiteClientId() || !clientSecret())) {
    state.status = 'error';
    state.lastError = 'This saved Twitch connection uses the legacy Authorization Code flow. Reconnect with Twitch to switch to secure Device Code sign-in.';
    return false;
  }
  restartEventSub();
  return true;
}

function restartEventSub() {
  stopEventSub();
  stopping = false;
  if (!account) return;
  connectEventSub(EVENTSUB_WS, false);
  if (!watchdog) watchdog = setInterval(checkStale, WATCHDOG_MS);
}

function stopEventSub() {
  stopping = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (socket) {
    try { socket.close(); } catch (_e) { /* already closed */ }
    socket = null;
  }
  sessionId = null;
  state.status = 'disconnected';
}

function connectEventSub(url, isReconnect) {
  state.status = 'connecting';
  const ws = new WebSocket(url);
  let welcomed = false;
  lastFrameAt = Date.now();

  ws.addEventListener('message', (event) => {
    lastFrameAt = Date.now();
    let frame;
    try { frame = JSON.parse(String(event.data)); } catch (_e) { return; }
    const type = frame.metadata?.message_type;

    if (type === 'session_welcome') {
      welcomed = true;
      const previous = socket;
      socket = ws;
      sessionId = frame.payload.session.id;
      retryDelay = 2000;
      if (previous && previous !== ws) {
        try { previous.close(); } catch (_e) { /* replaced */ }
      }
      if (isReconnect) {
        state.status = 'live';        // Twitch moves subscriptions to the new session
        console.log('[bot] EventSub reconnected.');
      } else {
        subscribeChat().then(() => {
          state.status = 'live';
          console.log(`[bot] Listening for Fishingbot chat commands in ${account?.login}'s chat.`);
        }).catch((error) => {
          state.status = 'error';
          state.lastError = error.message;
          console.error('[bot] Chat subscription failed:', error.message);
        });
      }
      return;
    }

    if (type === 'session_reconnect') {
      const next = frame.payload.session.reconnect_url;
      if (next) connectEventSub(next, true);
      return;
    }

    if (type === 'notification') {
      const subType = frame.payload?.subscription?.type;
      if (subType === 'channel.chat.message') {
        handleChatEvent(frame.payload.event).catch((error) => {
          console.error('[bot] Chat handling failed:', error?.message || error);
        });
      }
      return;
    }

    if (type === 'revocation') {
      const reason = frame.payload?.subscription?.status || 'revoked';
      state.status = 'error';
      state.lastError = `Twitch revoked the chat subscription (${reason}). Connect the bot account again.`;
      console.error('[bot]', state.lastError);
    }
  });

  const onGone = () => {
    if (stopping) return;
    // The live connection dropped: reconnect from scratch.
    if (socket === ws) {
      socket = null;
      scheduleRetry();
      return;
    }
    // A socket that was replaced after a Twitch reconnect, or a reconnect
    // attempt that never finished while the old one is gone: retry only in
    // the second case.
    if (!socket && !welcomed) scheduleRetry();
  };
  ws.addEventListener('close', onGone);
  ws.addEventListener('error', () => {
    state.lastError = 'EventSub connection error. Retrying.';
  });
}

function scheduleRetry() {
  if (stopping || !account) return;
  clearTimeout(retryTimer);
  state.status = 'connecting';
  retryTimer = setTimeout(() => {
    if (!stopping && account) connectEventSub(EVENTSUB_WS, false);
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}

function checkStale() {
  if (stopping || !socket || !account) return;
  if (Date.now() - lastFrameAt > STALE_AFTER_MS) {
    console.warn('[bot] EventSub went quiet, reconnecting.');
    try { socket.close(); } catch (_e) { /* ignore */ }
    socket = null;
    scheduleRetry();
  }
}

async function subscribeChat() {
  const result = await helix('/eventsub/subscriptions', {
    method: 'POST',
    body: {
      type: 'channel.chat.message',
      version: '1',
      condition: { broadcaster_user_id: account.userId, user_id: account.userId },
      transport: { method: 'websocket', session_id: sessionId }
    }
  });
  if (result.ok || result.status === 409) return;
  throw new Error(result.data?.message || `Helix returned HTTP ${result.status} for the chat subscription.`);
}

// ---- Commands ------------------------------------------------------------------

// Twitch badges -> the level number the fish handler already understands.
export function levelFromBadges(badges) {
  const sets = new Set((Array.isArray(badges) ? badges : []).map((b) => b?.set_id));
  if (sets.has('broadcaster')) return 1500;
  if (sets.has('moderator')) return 500;
  if (sets.has('vip')) return 400;
  if (sets.has('subscriber') || sets.has('founder')) return 250;
  return 100;
}

// Calls api/fish.js in-process and returns the text it would have sent.
export async function runFish({ user, channel, msg, level }) {
  const captured = captureResponse();
  const req = {
    method: 'GET',
    url: '/api/fish',
    headers: {},
    body: {},
    query: {
      user,
      channel,
      msg: msg || '',
      level: String(level),
      secret: process.env.BOT_SECRET || ''
    }
  };
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), FISH_TIMEOUT_MS));
  const work = Promise.resolve(fishHandler(req, captured.res)).then(() => captured.body());
  return Promise.race([work, timer]);
}

// Message IDs of our own replies. The streamer's account is also the bot, so
// filtering by sender would also drop the streamer's own !fish commands.
const sentMessageIds = new Set();
function rememberSent(id) {
  sentMessageIds.add(String(id));
  if (sentMessageIds.size > 500) sentMessageIds.delete(sentMessageIds.values().next().value);
}

export async function handleChatEvent(event) {
  if (!account || !event) return;
  if (String(event.broadcaster_user_id) !== String(account.userId)) return;
  if (event.message_id && sentMessageIds.has(String(event.message_id))) return;   // our own reply
  state.lastChatAt = new Date().toISOString();

  const text = String(event.message?.text || '').trim();
  const user = String(event.chatter_user_login || event.chatter_user_name || '').toLowerCase();
  const channel = String(event.broadcaster_user_login || account.login).toLowerCase();
  const fishMatch = text.match(/^!fish(?:\s+([\s\S]*))?$/i);
  if (fishMatch) {
    console.log(`[bot] !fish from ${user} in ${channel}`);
    const reply = await runFish({
      user,
      channel,
      msg: (fishMatch[1] || '').trim(),
      level: levelFromBadges(event.badges)
    });
    if (reply === null || reply === undefined) {
      console.error('[bot] !fish did not answer in time.');
      return;
    }
    const chatMode = (await readChatSettings().catch(() => null))?.chatDetail;
    if (reply && chatMode !== 'off') {
      console.log(`[bot] Replying: ${reply.slice(0, 80)}`);
      enqueueChat(reply);
    }
    for (const announcement of takeAnnouncements()) enqueueChat(announcement);
    return;
  }

  if (!isChatInfoCommand(text)) return;
  const replyMode = (await readChatSettings().catch(() => null))?.chatCommandReply || 'public';
  console.log(`[bot] ${replyMode === 'whisper' ? 'Private' : 'Public'} chat command from ${user}: ${text.split(/\s+/, 1)[0]}`);
  const chatterId = String(event.chatter_user_id || '');
  if (replyMode === 'whisper' && !/^\d{1,30}$/.test(chatterId)) {
    console.warn(`[bot] Cannot privately reply to ${user}: Twitch did not include a valid chatter ID.`);
    return;
  }
  const reply = await runChatInfoCommand({ text, user, userId: chatterId });
  if (reply) {
    if (replyMode === 'whisper') enqueueWhisper(chatterId, reply);
    else enqueueChat(reply);
  }
}

// ---- Sending chat -----------------------------------------------------------------

export function enqueueChat(text, replyParentMessageId = '') {
  const parentId = /^[a-zA-Z0-9-]{8,64}$/.test(String(replyParentMessageId || ''))
    ? String(replyParentMessageId)
    : '';
  sendQueue.push({ text: String(text), replyParentMessageId: parentId });
  if (!sending) drainQueue();
}

async function drainQueue() {
  sending = true;
  while (sendQueue.length) {
    const queued = sendQueue.shift() || {};
    const text = String(queued.text || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
    try {
      await sendChatMessage(text, queued.replyParentMessageId || '');
    } catch (error) {
      console.error('[bot] Could not send chat message:', error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
  }
  sending = false;
}

export async function sendChatMessage(text, replyParentMessageId = '') {
  if (!account) throw new Error('No bot account is connected.');
  const body = { broadcaster_id: account.userId, sender_id: account.userId, message: text };
  if (/^[a-zA-Z0-9-]{8,64}$/.test(String(replyParentMessageId || ''))) {
    body.reply_parent_message_id = String(replyParentMessageId);
  }
  const result = await helix('/chat/messages', {
    method: 'POST',
    body
  });
  const item = result.data?.data?.[0];
  if (!result.ok || !item) {
    throw new Error(result.data?.message || `Helix returned HTTP ${result.status}.`);
  }
  if (!item.is_sent) {
    throw new Error(`Twitch dropped the message: ${item.drop_reason?.message || 'no reason given'}.`);
  }
  state.lastReplyAt = new Date().toISOString();
  if (item.message_id) rememberSent(item.message_id);
  return true;
}


// Command responses are sent as Twitch Whispers, never as public chat messages.
// Twitch limits a bot to 40 unique recipients/day and applies its own per-minute
// limits as well; this process enforces both before making a request.
export function enqueueWhisper(toUserId, text) {
  const recipient = String(toUserId || '');
  if (!/^\d{1,30}$/.test(recipient)) return;
  if (whisperQueue.length >= 100) {
    console.warn('[bot] Private-response queue is full; dropping a command response.');
    return;
  }
  whisperQueue.push({ recipient, text: String(text || '').replace(/[\r\n]+/g, ' ').slice(0, 500) });
  if (!sendingWhispers) drainWhispers();
}

async function drainWhispers() {
  sendingWhispers = true;
  while (whisperQueue.length) {
    const item = whisperQueue.shift();
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== whisperDay) { whisperDay = today; whisperedRecipientsToday.clear(); }
      if (!whisperedRecipientsToday.has(item.recipient) && whisperedRecipientsToday.size >= 40) {
        console.warn('[bot] Twitch daily unique-whisper recipient limit reached; command response was not sent.');
      } else {
        await sendWhisper(item.recipient, item.text);
        whisperedRecipientsToday.add(item.recipient);
      }
    } catch (error) {
      // Do not fall back to public chat: privacy is the command response contract.
      console.error('[bot] Could not send private command response:', error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, WHISPER_INTERVAL_MS));
  }
  sendingWhispers = false;
}

export async function sendWhisper(toUserId, text) {
  if (!account) throw new Error('No bot account is connected.');
  if (!account.scopes?.includes('user:manage:whispers')) {
    throw new Error('Private command replies need the Twitch user:manage:whispers permission. Reconnect the Twitch bot account and grant the new permission.');
  }
  const recipient = String(toUserId || '');
  const message = String(text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  if (!/^\d{1,30}$/.test(recipient) || !message) throw new Error('Invalid whisper recipient or message.');
  const query = new URLSearchParams({ from_user_id: String(account.userId), to_user_id: recipient });
  const result = await helix(`/whispers?${query.toString()}`, { method: 'POST', body: { message } });
  if (!result.ok) {
    const reason = result.data?.message || result.data?.error || `HTTP ${result.status}`;
    throw new Error(`Twitch whisper failed (${reason}). The command was not posted publicly.`);
  }
  state.lastReplyAt = new Date().toISOString();
  return true;
}

// Collects whatever the handler writes, without a real HTTP response.
function captureResponse() {
  let body = null;
  let finished = false;
  const res = {
    statusCode: 200,
    headersSent: false,
    _headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this._headers[name.toLowerCase()] = value; return this; },
    getHeader(name) { return this._headers[name.toLowerCase()]; },
    writeHead(code) { this.statusCode = code; return this; },
    send(value) { finish(typeof value === 'string' ? value : JSON.stringify(value)); return this; },
    json(value) { finish(JSON.stringify(value)); return this; },
    end(value) { finish(value === undefined ? '' : String(value)); return this; }
  };
  function finish(text) {
    if (finished) return;
    finished = true;
    res.headersSent = true;
    body = text;
  }
  return { res, body: () => body };
}
