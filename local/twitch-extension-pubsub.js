// Sends public channel snapshots to the centrally hosted Fishingbot Extension
// relay. The desktop app never receives the Twitch Extension ID/Secret and
// never signs Extension JWTs. It authenticates to the relay with the Twitch
// user access token belonging to the connected streamer.
import { db } from '../lib/db.js';
import { getBotAccessToken } from './twitch-bot.js';
import { RELEASE_CONFIG } from './release-config.js';

const PUBLISH_INTERVAL_MS = 12_000;
// Render Free can need about one minute to cold-start. Do not abort the
// desktop-to-relay request while the instance is still starting.
const RELAY_PUBLISH_TIMEOUT_MS = 90_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const MAX_MESSAGE_BYTES = 4_700;
let timer = null;
let busy = false;
let lastErrorLogAt = 0;
let lastPublishAt = 0;
let lastAttemptAt = 0;
let lastAttemptDurationMs = 0;
let lastError = null;
let consecutiveFailures = 0;
let nextAttemptAt = 0;

function relayUrl() {
  const configured = String(process.env.FISHINGBOT_EXTENSION_RELAY_URL || RELEASE_CONFIG.extensionRelayUrl || '').trim();
  if (!configured) return '';
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function publicName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 25);
}

function publicText(value, max = 70) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

async function buildSnapshot(identity) {
  const [, keys] = await db.scan('0', { match: 'fish:count:*', count: 5000 });
  const usernames = [...new Set((keys || []).map((key) => String(key).slice('fish:count:'.length)).filter(Boolean))];
  if (!usernames.length) {
    return {
      type: 'fishingbot.snapshot', schema: 1, sentAt: Date.now(),
      channel: publicName(identity.login), totalAnglers: 0, totalCasts: 0, leaderboard: []
    };
  }

  const countKeys = usernames.map((name) => `fish:count:${name}`);
  const bestItemKeys = usernames.map((name) => `fish:bestitem:${name}`);
  const bestTierKeys = usernames.map((name) => `fish:besttier:${name}`);
  const [counts, bestItems, bestTiers] = await Promise.all([
    db.mget(countKeys), db.mget(bestItemKeys), db.mget(bestTierKeys)
  ]);

  const rows = [];
  let totalCasts = 0;
  for (let i = 0; i < usernames.length; i++) {
    const count = Math.max(0, Number.parseInt(counts?.[i], 10) || 0);
    if (count <= 0) continue;
    totalCasts += count;
    rows.push({
      username: publicName(usernames[i]),
      casts: count,
      bestCatch: publicText(bestItems?.[i] || '', 56),
      bestTier: publicText(bestTiers?.[i] || '', 20).toUpperCase()
    });
  }
  rows.sort((a, b) => b.casts - a.casts || a.username.localeCompare(b.username));
  return {
    type: 'fishingbot.snapshot', schema: 1, sentAt: Date.now(),
    channel: publicName(identity.login),
    totalAnglers: rows.length,
    totalCasts,
    leaderboard: rows.slice(0, 10).map((row, index) => ({ rank: index + 1, ...row }))
  };
}

function safeErrorText(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '[URL]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240);
}

function retryDelayMs(failureCount, retryAfterSeconds = 0, httpStatus = 0) {
  const serverDelay = Math.min(RETRY_MAX_MS, Math.max(0, Number(retryAfterSeconds) || 0) * 1000);
  if (Number(httpStatus) === 429) return Math.min(RETRY_MAX_MS, Math.max(1_500, serverDelay + 500));
  const exponent = Math.min(Math.max(0, failureCount - 1), 4);
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exponent));
  return Math.max(backoff, serverDelay);
}

function describePublishError(error) {
  const message = String(error?.message || error || 'Unknown relay publishing error.');
  if (error?.name === 'TimeoutError' || /operation was aborted due to timeout/i.test(message)) {
    if (!error?.httpStatus) {
      return `The Render relay did not respond within ${Math.round(RELAY_PUBLISH_TIMEOUT_MS / 1000)} seconds. It may still be waking or temporarily unreachable. Fishingbot will retry automatically.`;
    }
    return 'The Render relay responded, but its upstream Twitch PubSub request timed out. Fishingbot will retry automatically.';
  }
  if (error?.name === 'AbortError') {
    return 'The relay publish request was cancelled before a response arrived. Fishingbot will retry automatically.';
  }
  return safeErrorText(message);
}

async function publishOnce(getIdentity) {
  if (busy || Date.now() < nextAttemptAt) return;
  const target = relayUrl();
  if (!target) return; // Dev/source builds can run without Extension publishing.
  const identity = getIdentity?.();
  if (!identity?.userId) return;

  busy = true;
  const attemptStartedAt = Date.now();
  lastAttemptAt = attemptStartedAt;
  try {
    const token = await getBotAccessToken();
    if (!token) return;
    const snapshot = await buildSnapshot(identity);
    let payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) {
      snapshot.leaderboard = snapshot.leaderboard.slice(0, 5);
      payload = JSON.stringify(snapshot);
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new Error('The public Extension snapshot exceeded Twitch’s 5 KB PubSub message limit.');
    }

    const response = await fetch(`${target}/v1/snapshot`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: payload,
      signal: AbortSignal.timeout(RELAY_PUBLISH_TIMEOUT_MS)
    });
    if (response.status !== 202 && response.status !== 200) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.error || `Fishingbot Extension relay returned HTTP ${response.status}.`);
      error.httpStatus = response.status;
      error.code = data.code || '';
      error.retryAfterSeconds = data.retryAfterSeconds || Number(response.headers.get('retry-after')) || 0;
      throw error;
    }
    lastPublishAt = Date.now();
    lastError = null;
    consecutiveFailures = 0;
    nextAttemptAt = 0;
  } catch (error) {
    const isSnapshotRateLimit = Number(error?.httpStatus) === 429 && error?.code === 'snapshot_rate_limited';
    if (isSnapshotRateLimit) {
      // A second desktop process may already have published for this channel.
      // This is a scheduling response, not a failed Twitch connection.
      const delayMs = retryDelayMs(consecutiveFailures, error?.retryAfterSeconds, error?.httpStatus);
      nextAttemptAt = Date.now() + delayMs;
      lastError = null;
      if (Date.now() - lastErrorLogAt > 60_000) {
        lastErrorLogAt = Date.now();
        console.info('[twitch-extension] Snapshot already published for this channel; retrying shortly.');
      }
    } else {
      consecutiveFailures += 1;
      lastError = describePublishError(error);
      const delayMs = retryDelayMs(consecutiveFailures, error?.retryAfterSeconds, error?.httpStatus);
      nextAttemptAt = Date.now() + delayMs;
      if (Date.now() - lastErrorLogAt > 60_000) {
        lastErrorLogAt = Date.now();
        console.error('[twitch-extension] Relay publish failed:', lastError, `(retry in ${Math.ceil(delayMs / 1000)}s)`);
      }
    }
  } finally {
    lastAttemptDurationMs = Math.max(0, Date.now() - attemptStartedAt);
    busy = false;
  }
}

export function extensionPublisherStatus() {
  const now = Date.now();
  return {
    configured: !!relayUrl(),
    transport: 'https',
    lastPublishedAt: lastPublishAt || null,
    lastAttemptAt: lastAttemptAt || null,
    lastAttemptDurationMs: lastAttemptAt ? lastAttemptDurationMs : null,
    lastError,
    consecutiveFailures,
    retryInSeconds: nextAttemptAt > now ? Math.ceil((nextAttemptAt - now) / 1000) : 0,
    timeoutSeconds: RELAY_PUBLISH_TIMEOUT_MS / 1000,
    intervalSeconds: PUBLISH_INTERVAL_MS / 1000
  };
}

export function startExtensionPublisher(getIdentity) {
  stopExtensionPublisher();
  publishOnce(getIdentity).catch(() => {});
  timer = setInterval(() => publishOnce(getIdentity).catch(() => {}), PUBLISH_INTERVAL_MS);
  timer.unref?.();
  return stopExtensionPublisher;
}

export function stopExtensionPublisher() {
  if (timer) clearInterval(timer);
  timer = null;
}
