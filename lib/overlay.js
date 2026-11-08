// OBS overlay: settings, alerts, luck banner and the Twitch live check.
//
// Data is per channel and lives in the same database as the rest of the game.
// The overlay page polls api/overlay.js with the channel's secret link key.
// Every catch writes one small event. Alerts use only manual !fish catches.
// The live check asks Twitch at most every 15 minutes, and only while an
// overlay is polling. When the live state changes, the session feed is cleared.
import crypto from 'node:crypto';
import { db } from './db.js';
import { TIERS } from './tiers.js';

const LIVE_CHECK_MS = 15 * 60 * 1000;
const EVENT_LIMIT = 30;
const EVENT_LOCK_TTL_SECONDS = 10;
const EVENT_LOCK_RETRIES = 60;
const EVENT_LOCK_DELAY_MS = 35;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TIER_RANK = Object.fromEntries(TIERS.map((t) => [t.id, t.rankScore]));
const MIN_TIER_IDS = TIERS.map((t) => t.id);
export const OVERLAY_STYLES = ['card', 'pill', 'banner', 'ticket', 'playful', 'glass', 'tag', 'terminal'];
export const OVERLAY_ANIMATIONS = ['slide', 'fade', 'pop'];
export const OVERLAY_FONTS = ['display', 'body', 'mono', 'serif'];
export const OVERLAY_LUCK_STYLES = ['bar', 'fade', 'pill', 'ticket', 'playful', 'glass', 'ribbon', 'terminal'];
export const OVERLAY_ALIGNS = ['left', 'center', 'right'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const OVERLAY_SOUNDS = ['chime', 'bell', 'pop', 'coin', 'harp'];

export const OVERLAY_DEFAULTS = {
  enabled: false,
  alertSeconds: 6,
  minTier: 'rare',
  sound: false,
  position: 'top',
  alertHorizontalPosition: 'center',
  accent: '#f5b942',
  luckBanner: true,
  luckStyle: 'bar',
  style: 'card',
  animation: 'slide',
  rarityColors: false,
  font: 'display',
  soundId: 'chime',
  animationMs: 420,
  alertTextScale: 100,
  alertSize: 100,
  luckAccent: '#C9A227',
  luckTemplate: '{name} · {multiplier}x luck · {time}',
  luckTimer: true,
  luckScale: 100,
  luckPosition: 'top',
  luckHorizontalPosition: 'center',
  soundVolume: 80,
  alertUpper: false,
  showTier: true,
  alertStats: false,
  alertCommunity: false,
  newFishAlert: false,
  pointsBar: false,
  pointsBarGoal: 'luck',
  pointsBarColor: '',
  ignoredViewers: [],
  alertTemplate: '{user} caught {fish}',
  alertAlign: 'center',
  alertBg: '',
  alertBgTransparency: 0,
  luckAlign: 'center',
  luckBg: '',
  luckBgTransparency: 0
};

const K = {
  settings: (c) => `overlay:settings:${c}`,
  key: (c) => `overlay:key:${c}`,
  seq: (c) => `overlay:seq:${c}`,
  events: (c) => `overlay:events:${c}`,
  eventLock: (c) => `lock:overlay-events:${c}`,
  live: (c) => `overlay:live:${c}`,
  hideChat: (c) => `settings:hidefishchat:${c}`,
  communityCatches: (c) => `channel:catches:${c}`,
  luck: (c) => `channel:event_luck:${c}`,
  luckName: (c) => `channel:event_name:${c}`,
  luckExpires: (c) => `channel:event_expires:${c}`
};

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// Twitch logins are letters, digits and underscores. Anything else is dropped. At most 50 names, no repeats.
function parseViewerList(value) {
  const parts = Array.isArray(value) ? value : String(value).split(/[\s,;]+/);
  const names = parts.map((n) => String(n).trim().toLowerCase()).filter((n) => /^[a-z0-9_]{2,25}$/.test(n));
  return [...new Set(names)].slice(0, 50);
}

// Keeps only known, valid values. Anything else falls back to the default.
export function sanitizeOverlaySettings(input = {}, current = OVERLAY_DEFAULTS) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...OVERLAY_DEFAULTS, ...current };
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.rarityColors === 'boolean') out.rarityColors = src.rarityColors;
  if (typeof src.sound === 'boolean') out.sound = src.sound;
  if (typeof src.luckBanner === 'boolean') out.luckBanner = src.luckBanner;
  if (MIN_TIER_IDS.includes(src.minTier)) out.minTier = src.minTier;
  if (['top', 'bottom'].includes(src.position)) out.position = src.position;
  if (OVERLAY_ALIGNS.includes(src.alertHorizontalPosition)) out.alertHorizontalPosition = src.alertHorizontalPosition;
  if (/^#[0-9a-fA-F]{6}$/.test(String(src.accent || ''))) out.accent = String(src.accent);
  if (/^#[0-9a-fA-F]{6}$/.test(String(src.luckAccent || ''))) out.luckAccent = String(src.luckAccent);
  const seconds = Number(src.alertSeconds);
  if (Number.isFinite(seconds)) out.alertSeconds = Math.min(30, Math.max(3, Math.round(seconds)));
  if (typeof src.alertTemplate === 'string') {
    const tpl = src.alertTemplate.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
    if (tpl) out.alertTemplate = tpl;
  }
  if (OVERLAY_STYLES.includes(src.style)) out.style = src.style;
  if (OVERLAY_ANIMATIONS.includes(src.animation)) out.animation = src.animation;
  if (OVERLAY_FONTS.includes(src.font)) out.font = src.font;
  if (OVERLAY_LUCK_STYLES.includes(src.luckStyle)) out.luckStyle = src.luckStyle;
  if (OVERLAY_ALIGNS.includes(src.alertAlign)) out.alertAlign = src.alertAlign;
  if (OVERLAY_ALIGNS.includes(src.luckAlign)) out.luckAlign = src.luckAlign;
  // '' means no custom colour: the style's own background is used.
  if (typeof src.alertBg === 'string' && (src.alertBg === '' || HEX_COLOR.test(src.alertBg))) out.alertBg = src.alertBg;
  if (typeof src.luckBg === 'string' && (src.luckBg === '' || HEX_COLOR.test(src.luckBg))) out.luckBg = src.luckBg;
  const alertTr = Number(src.alertBgTransparency);
  if (Number.isFinite(alertTr)) out.alertBgTransparency = Math.min(90, Math.max(0, Math.round(alertTr / 5) * 5));
  const luckTr = Number(src.luckBgTransparency);
  if (Number.isFinite(luckTr)) out.luckBgTransparency = Math.min(90, Math.max(0, Math.round(luckTr / 5) * 5));
  if (OVERLAY_SOUNDS.includes(src.soundId)) out.soundId = src.soundId;
  if (typeof src.luckTimer === 'boolean') out.luckTimer = src.luckTimer;
  if (typeof src.luckTemplate === 'string') {
    const lt = src.luckTemplate.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100);
    if (lt) out.luckTemplate = lt;
  }
  const textScale = Number(src.alertTextScale);
  if (Number.isFinite(textScale)) out.alertTextScale = Math.min(180, Math.max(60, Math.round(textScale)));
  const alertSize = Number(src.alertSize);
  if (Number.isFinite(alertSize)) out.alertSize = Math.min(180, Math.max(60, Math.round(alertSize)));
  const lScale = Number(src.luckScale);
  if (Number.isFinite(lScale)) out.luckScale = Math.min(160, Math.max(60, Math.round(lScale)));
  if (['top', 'bottom'].includes(src.luckPosition)) out.luckPosition = src.luckPosition;
  if (OVERLAY_ALIGNS.includes(src.luckHorizontalPosition)) out.luckHorizontalPosition = src.luckHorizontalPosition;
  else if (!Object.prototype.hasOwnProperty.call(src, 'luckHorizontalPosition') && OVERLAY_ALIGNS.includes(src.luckAlign)) out.luckHorizontalPosition = src.luckAlign;
  const volume = Number(src.soundVolume);
  if (Number.isFinite(volume)) out.soundVolume = Math.min(100, Math.max(0, Math.round(volume)));
  if (typeof src.alertUpper === 'boolean') out.alertUpper = src.alertUpper;
  if (typeof src.showTier === 'boolean') out.showTier = src.showTier;
  if (typeof src.alertStats === 'boolean') out.alertStats = src.alertStats;
  if (typeof src.alertCommunity === 'boolean') out.alertCommunity = src.alertCommunity;
  if (typeof src.newFishAlert === 'boolean') out.newFishAlert = src.newFishAlert;
  if (typeof src.pointsBar === 'boolean') out.pointsBar = src.pointsBar;
  if (['luck', 'rarity', 'lucky-chat'].includes(src.pointsBarGoal)) out.pointsBarGoal = src.pointsBarGoal;
  // '' means the bar follows the banner colour.
  if (typeof src.pointsBarColor === 'string' && (src.pointsBarColor === '' || HEX_COLOR.test(src.pointsBarColor))) out.pointsBarColor = src.pointsBarColor;
  if (typeof src.ignoredViewers === 'string' || Array.isArray(src.ignoredViewers)) out.ignoredViewers = parseViewerList(src.ignoredViewers);
  const animMs = Number(src.animationMs);
  if (Number.isFinite(animMs)) out.animationMs = Math.min(2000, Math.max(150, Math.round(animMs / 10) * 10));
  return out;
}

export async function readOverlaySettings(channel) {
  const raw = await db.get(K.settings(channel)).catch(() => null);
  return sanitizeOverlaySettings(parseJson(raw, {}), OVERLAY_DEFAULTS);
}

export async function saveOverlaySettings(channel, input) {
  const current = await readOverlaySettings(channel);
  const next = sanitizeOverlaySettings(input, current);
  await db.set(K.settings(channel), JSON.stringify(next));
  // The hide switch works only while the overlay is on. Turning the overlay off clears it.
  if (!next.enabled) await db.set(K.hideChat(channel), 'off');
  return next;
}

// The link key is created on first use. Rotating it makes the old link stop working.
export async function ensureOverlayKey(channel) {
  const existing = await db.get(K.key(channel)).catch(() => null);
  if (existing) return existing;
  const key = crypto.randomBytes(24).toString('base64url');
  await db.set(K.key(channel), key);
  return key;
}

export async function rotateOverlayKey(channel) {
  const key = crypto.randomBytes(24).toString('base64url');
  await db.set(K.key(channel), key);
  return key;
}

export async function verifyOverlayKey(channel, given) {
  const stored = await db.get(K.key(channel)).catch(() => null);
  if (!stored || typeof given !== 'string' || !given) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Hiding is active only when the switch is on AND the overlay is on.
export async function hideFishChatOn(channel) {
  if (!channel) return false;
  const [flag, settings] = await Promise.all([
    db.get(K.hideChat(channel)).catch(() => null),
    readOverlaySettings(channel)
  ]);
  return flag === 'on' && settings.enabled;
}

// Returns the value that is actually stored. With the overlay off it is always false.
export async function setHideFishChat(channel, enabled) {
  const settings = await readOverlaySettings(channel);
  const on = !!enabled && settings.enabled;
  await db.set(K.hideChat(channel), on ? 'on' : 'off');
  return on;
}

async function withOverlayEventLock(channel, callback) {
  const lockKey = K.eventLock(channel);
  const token = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  let acquired = false;

  // Serialise sequence allocation and event-list writes. Without this lock,
  // simultaneous !fish requests can both read the same JSON list and overwrite
  // each other's alert while still incrementing the sequence counter.
  for (let attempt = 0; attempt < EVENT_LOCK_RETRIES; attempt++) {
    try {
      const won = await db.set(lockKey, token, { nx: true, ex: EVENT_LOCK_TTL_SECONDS });
      if (won) { acquired = true; break; }
    } catch (error) {
      // A timed-out NX request may still have acquired the lock. Reuse the same
      // token so a read-back can safely confirm ownership before trying again.
      try {
        if (await db.get(lockKey) === token) { acquired = true; break; }
      } catch (_readError) { /* Retry within the bounded wait below. */ }
    }
    await delay(EVENT_LOCK_DELAY_MS + Math.random() * EVENT_LOCK_DELAY_MS);
  }

  if (!acquired) throw new Error('The overlay event feed is busy; alert write could not be locked.');
  try {
    return await callback();
  } finally {
    await db.unlock(lockKey, token).catch((error) => {
      console.error('[overlay] Could not release event-feed lock:', error?.message || error);
    });
  }
}

// One event per manual catch. Writes only when the overlay is turned on, so a
// channel without the overlay pays nothing extra on the !fish path.
export async function recordOverlayCatch(channel, catchInfo, { force = false } = {}) {
  if (!channel || !catchInfo) return;
  if (!force) {
    const settings = await readOverlaySettings(channel);
    if (!settings.enabled) return;
  }
  // Community catches: the channel's total manual casts. Shown in the header when Show community catches is on.
  // The {community} token still works in alert text saved before v3.87.
  const community = Math.max(0, parseInt(await db.get(K.communityCatches(channel)).catch(() => 0), 10) || 0);

  return withOverlayEventLock(channel, async () => {
    const seq = Number(await db.incr(K.seq(channel))) || 0;
    if (!seq) throw new Error('Could not allocate an overlay event sequence.');
    const list = parseJson(await db.get(K.events(channel)), []);
    list.push({
      seq,
      ts: Date.now(),
      user: String(catchInfo.user || '').slice(0, 40),
      item: String(catchInfo.item || '').slice(0, 80),
      tierId: String(catchInfo.tierId || ''),
      tierName: String(catchInfo.tierName || '').slice(0, 20),
      // Shown as text in the alert header when Show luck and weight is on, e.g. "☘️2.5x" and "1.2x".
      luck: String(catchInfo.luck || '').slice(0, 12),
      weight: String(catchInfo.weight || '').slice(0, 12),
      discovery: !!catchInfo.discovery,
      community,
      test: !!catchInfo.test,
      look: catchInfo.look || null
    });
    await db.set(K.events(channel), JSON.stringify(list.slice(-EVENT_LIMIT)));
    return seq;
  });
}

// Alerts from events after the given sequence number, filtered by the minimum rarity.
export async function readOverlayEvents(channel, after, settings) {
  const list = parseJson(await db.get(K.events(channel)).catch(() => null), []);
  // Do not use the separate sequence counter as the polling cursor. A catch used
  // to increment it before writing the JSON event list, so a poll between those
  // writes could advance past an alert that was not yet readable. The highest
  // sequence actually persisted with an event is the safe high-water mark.
  const seq = list.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0);
  const minRank = TIER_RANK[settings.minTier] ?? 0;
  const ignored = new Set(settings.ignoredViewers || []);
  // Test alerts always show, so the preview check is never hidden by the rarity or the ignore list.
  // A new fish discovery also shows when its rarity is below the minimum, if the option is on.
  const alerts = after === null ? [] : list
    .filter((e) => Number(e.seq) > after && (e.test || (!ignored.has(String(e.user).toLowerCase()) && ((TIER_RANK[e.tierId] ?? 0) >= minRank || (settings.newFishAlert && e.discovery)))))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  return { seq, alerts };
}

// A snapshot of the look used by a test alert. It is validated like the saved settings.
export function sanitizeLook(input) {
  const s = sanitizeOverlaySettings(input || {}, OVERLAY_DEFAULTS);
  return {
    style: s.style, animation: s.animation, font: s.font, accent: s.accent,
    rarityColors: s.rarityColors, alertTemplate: s.alertTemplate, sound: s.sound, soundId: s.soundId,
    animationMs: s.animationMs, alertTextScale: s.alertTextScale, alertSize: s.alertSize,
    soundVolume: s.soundVolume, alertUpper: s.alertUpper, showTier: s.showTier, alertStats: s.alertStats, alertCommunity: s.alertCommunity,
    alertAlign: s.alertAlign, alertHorizontalPosition: s.alertHorizontalPosition,
    alertBg: s.alertBg, alertBgTransparency: s.alertBgTransparency
  };
}

// The rarity the test alert uses, taken from the preview picker. Unknown ids fall back to Legendary.
export function testTierFor(id) {
  // The preview calls Secret "secret"; the game's tier id is "unique".
  const wanted = id === 'secret' ? 'unique' : id;
  const tier = TIERS.find((t) => t.id === wanted && t.id !== 'treasury') || TIERS.find((t) => t.id === 'legendary');
  return { tierId: tier.id, tierName: tier.name };
}

export async function readLuckEvent(channel) {
  const [luck, name, expires] = await Promise.all([
    db.get(K.luck(channel)).catch(() => null),
    db.get(K.luckName(channel)).catch(() => null),
    db.get(K.luckExpires(channel)).catch(() => null)
  ]);
  const mult = Number(luck);
  const exp = expires == null ? null : Number(expires);
  const active = Number.isFinite(mult) && mult > 1 && (!exp || Date.now() < exp);
  return active ? { active: true, multiplier: mult, name: name || 'Luck event', expires: exp } : { active: false };
}

// Global event luck uses the same event as the fishing roll. It takes priority
// over a channel event while active, so the OBS banner can display the event
// that currently wins when both scopes are configured.
export async function readGlobalLuckEvent() {
  const [luck, name, expires] = await Promise.all([
    db.get('global:event_luck').catch(() => null),
    db.get('global:event_name').catch(() => null),
    db.get('global:event_expires').catch(() => null)
  ]);
  const mult = Number(luck);
  const parsedExpires = expires == null ? null : Number(expires);
  const exp = Number.isFinite(parsedExpires) && parsedExpires > 0 ? parsedExpires : null;
  const active = Number.isFinite(mult) && mult > 1 && (!exp || Date.now() < exp);
  return active
    ? { active: true, multiplier: mult, name: name || 'Global Luck Event', expires: exp }
    : { active: false };
}

// --- Twitch live check -------------------------------------------------------

let appToken = null;
let appTokenExpiresAt = 0;

async function appAccessToken() {
  if (appToken && Date.now() < appTokenExpiresAt - 60_000) return appToken;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Twitch client credentials are not configured.');
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(2500)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error('Twitch app token request failed.');
  appToken = data.access_token;
  appTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return appToken;
}

async function twitchSaysLive(channel) {
  const token = await appAccessToken();
  const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`, {
    headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2500)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twitch streams request failed (${res.status}).`);
  return Array.isArray(data.data) && data.data.length > 0;
}

// Returns whether the channel is live. Twitch is asked at most every 15 minutes.
// When the live state changes, the feed is cleared, so every stream starts fresh.
export async function liveCheck(channel) {
  const prev = parseJson(await db.get(K.live(channel)).catch(() => null), { live: false, checkedAt: 0 });
  if (Date.now() - prev.checkedAt < LIVE_CHECK_MS) return !!prev.live;

  let live = !!prev.live;
  try {
    live = await twitchSaysLive(channel);
  } catch (err) {
    // Keep the last known state and wait for the next check instead of retrying on every poll.
    console.error('[overlay] live check failed:', err?.message || err);
  }
  await db.set(K.live(channel), JSON.stringify({ live, checkedAt: Date.now() }));
  if (live !== !!prev.live) await db.del(K.events(channel)).catch(() => {});
  return live;
}
