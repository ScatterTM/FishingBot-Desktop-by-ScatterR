// Outbound authenticated WebSocket bridge between this local Fishingbot
// installation and the shared Render Extension relay. No inbound port is
// opened. The relay sends only allowlisted viewer/public requests; game data
// remains in this install's local SQLite database.
import { RELEASE_CONFIG } from './release-config.js';
import { botIdentity, getBotAccessToken } from './twitch-bot.js';
import { executeExtensionAdminRequest, executeExtensionPublicRequest, executeExtensionViewerRequest } from './twitch-extension-rpc.js';
import { revokeExtensionMasterAdminSessions } from './twitch-extension-admin.js';

const HEARTBEAT_MS = 25_000;
const TOKEN_CHECK_MS = 45_000;
const MAX_IN_FLIGHT = 8;

let running = false;
let socket = null;
let connectPromise = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let tokenCheckTimer = null;
let reconnectDelay = 2_000;
let connectedToken = '';
let authenticated = false;
let authenticatedChannelId = '';
const inFlight = new Set();

function relayWebSocketUrl() {
  const configured = String(process.env.FISHINGBOT_EXTENSION_RELAY_URL || RELEASE_CONFIG.extensionRelayUrl || '').trim();
  if (!configured) return '';
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    url.protocol = 'wss:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/desktop`;
    return url.toString();
  } catch (_error) {
    return '';
  }
}

function clearSocketTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleReconnect(delay = reconnectDelay) {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((error) => {
      console.warn('[twitch-extension] Relay reconnect failed:', String(error?.message || error).slice(0, 180));
      scheduleReconnect();
    });
  }, delay);
  reconnectTimer.unref?.();
  reconnectDelay = Math.min(60_000, Math.max(2_000, Math.round(reconnectDelay * 1.7)));
}

function send(message, target = socket) {
  if (!target || target.readyState !== 1) return false;
  try {
    target.send(JSON.stringify(message));
    return true;
  } catch (_error) {
    return false;
  }
}

async function replyToRequest(ws, message) {
  const requestId = String(message.requestId || '');
  if (!/^[a-f0-9-]{20,64}$/i.test(requestId) || inFlight.has(requestId)) return;
  if (inFlight.size >= MAX_IN_FLIGHT) {
    send({ type: 'rpc.response', requestId, status: 429, body: { error: 'Fishingbot is busy. Please retry in a moment.' } }, ws);
    return;
  }

  inFlight.add(requestId);
  try {
    let result;
    if (message.type === 'public.request') {
      result = await executeExtensionPublicRequest(message.action);
    } else if (message.type === 'viewer.request') {
      result = await executeExtensionViewerRequest(message.viewer, message.request);
    } else if (message.type === 'admin.request') {
      result = await executeExtensionAdminRequest(message.viewer, message.request, authenticatedChannelId);
    } else {
      return;
    }
    send({
      type: 'rpc.response',
      requestId,
      status: Number(result?.status) || 200,
      body: result?.body === undefined ? null : result.body
    }, ws);
  } catch (error) {
    send({
      type: 'rpc.response',
      requestId,
      status: Number(error?.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 500,
      body: { error: String(error?.message || 'Fishingbot could not complete the request.').slice(0, 220) }
    }, ws);
  } finally {
    inFlight.delete(requestId);
  }
}

function onMessage(ws, event) {
  let raw = event?.data;
  if (typeof raw !== 'string') {
    if (raw && typeof raw.toString === 'function') raw = raw.toString();
    else return;
  }
  if (raw.length > 160_000) {
    try { ws.close(1009, 'Message too large'); } catch (_error) { }
    return;
  }
  let message;
  try { message = JSON.parse(raw); } catch (_error) { return; }
  if (!message || typeof message !== 'object') return;

  if (message.type === 'desktop.ready') {
    const relayChannelId = String(message.channelId || '');
    const localIdentity = botIdentity();
    if (!/^\d{5,20}$/.test(relayChannelId) || !localIdentity || String(localIdentity.userId) !== relayChannelId) {
      console.warn('[twitch-extension] Relay desktop identity did not match the locally connected Twitch account.');
      try { ws.close(4003, 'Desktop identity mismatch'); } catch (_error) { }
      return;
    }
    authenticatedChannelId = relayChannelId;
    authenticated = true;
    reconnectDelay = 2_000;
    console.log('[twitch-extension] Secure relay connection is ready.');
    clearSocketTimers();
    heartbeatTimer = setInterval(() => {
      if (!send({ type: 'desktop.heartbeat', at: Date.now() }, ws)) {
        try { ws.close(); } catch (_error) { }
      }
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
    return;
  }
  if (message.type === 'desktop.heartbeat') return;
  if (message.type === 'desktop.rejected') {
    console.warn('[twitch-extension] Relay rejected the desktop connection:', String(message.error || 'Twitch authentication failed.').slice(0, 180));
    revokeExtensionMasterAdminSessions().catch(() => {});
    try { ws.close(4003, 'Relay authentication rejected'); } catch (_error) { }
    return;
  }
  if (authenticated && authenticatedChannelId && (message.type === 'viewer.request' || message.type === 'public.request' || message.type === 'admin.request')) {
    replyToRequest(ws, message).catch(() => {});
  }
}

async function connect() {
  if (!running || connectPromise || (socket && (socket.readyState === 0 || socket.readyState === 1))) return;
  const url = relayWebSocketUrl();
  if (!url) {
    console.warn('[twitch-extension] Secure relay URL is not configured in this build.');
    scheduleReconnect(30_000);
    return;
  }
  const WebSocketClient = globalThis.WebSocket;
  if (typeof WebSocketClient !== 'function') {
    console.warn('[twitch-extension] This build requires Node.js 22 or newer for WebSocket support.');
    scheduleReconnect(60_000);
    return;
  }

  connectPromise = (async () => {
    const identityToken = await getBotAccessToken();
    if (!running) return;
    if (!identityToken) {
      scheduleReconnect(15_000);
      return;
    }

    const ws = new WebSocketClient(url);
    socket = ws;
    connectedToken = identityToken;
    authenticated = false;

    ws.addEventListener('open', () => {
      if (socket !== ws || !running) return;
      send({ type: 'desktop.auth', token: identityToken }, ws);
    });
    ws.addEventListener('message', (event) => onMessage(ws, event));
    ws.addEventListener('error', () => { /* close event handles retry; never log tokens */ });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      connectedToken = '';
      authenticated = false;
      authenticatedChannelId = '';
      clearSocketTimers();
      inFlight.clear();
      if (running) scheduleReconnect();
    });
  })().catch((error) => {
    console.warn('[twitch-extension] Could not open the relay connection:', String(error?.message || error).slice(0, 180));
    scheduleReconnect();
  }).finally(() => {
    connectPromise = null;
  });
  return connectPromise;
}

export function twitchExtensionBridgeStatus() {
  return {
    connected: !!(authenticated && authenticatedChannelId && socket && socket.readyState === 1),
    channelId: authenticatedChannelId || null
  };
}

export function startTwitchExtensionBridge() {
  stopTwitchExtensionBridge();
  running = true;
  connect().catch(() => {});
  tokenCheckTimer = setInterval(async () => {
    if (!running) return;
    try {
      const latestToken = await getBotAccessToken();
      if (!latestToken) {
        if (socket && socket.readyState < 2) socket.close(4001, 'Twitch account disconnected');
        return;
      }
      if (socket && socket.readyState === 1 && connectedToken && latestToken !== connectedToken) {
        // Twitch rotated/refreshed the token. Re-authenticate the desktop with
        // the new token instead of letting a long-lived socket outlive OAuth.
        socket.close(4001, 'Twitch token refreshed');
      } else if (!socket || socket.readyState === 3) {
        connect().catch(() => {});
      }
    } catch (_error) {
      if (socket && socket.readyState < 2) socket.close(4001, 'Twitch token refresh failed');
    }
  }, TOKEN_CHECK_MS);
  tokenCheckTimer.unref?.();
}

export function stopTwitchExtensionBridge() {
  running = false;
  // A deliberate bridge stop (app shutdown, Twitch logout or bridge restart)
  // also locks the Extension Master Admin session and clears pending codes.
  revokeExtensionMasterAdminSessions().catch((error) => {
    console.warn('[twitch-extension] Could not revoke Extension Master Admin sessions:', String(error?.message || error).slice(0, 160));
  });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (tokenCheckTimer) clearInterval(tokenCheckTimer);
  reconnectTimer = null;
  tokenCheckTimer = null;
  clearSocketTimers();
  inFlight.clear();
  const old = socket;
  socket = null;
  connectedToken = '';
  authenticated = false;
  authenticatedChannelId = '';
  if (old && old.readyState < 2) {
    try { old.close(1000, 'Fishingbot stopped'); } catch (_error) { }
  }
}
