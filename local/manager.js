// Local-only streamer control centre: password gate, loot-table editor,
// gameplay settings, Twitch controls and local website links.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, settingsReport } from './env.js';
import { TIERS } from '../lib/tiers.js';
import { db } from '../lib/db.js';
import { getAutoFishConfig, setAutoFishConfig } from '../lib/autofish.js';
import { AREA_IDS, FISHING_AREAS, DEFAULT_AREA_LOOT, AREAS_ENABLED_KEY, DOUBLE_CATCH_ENABLED_KEY, areaEnabledKey, isEnabledValue } from '../lib/areas.js';
import { FISH_WEIGHTS, DEFAULT_FISH_WEIGHT } from '../lib/fish-weights.js';
import { normalizeName, findNormalizedDuplicates } from '../lib/item-check.js';
import { ensureLocalBotBroadcasterAdmin } from '../lib/broadcaster-admin.js';
import { extensionPublisherStatus } from './twitch-extension-pubsub.js';
import { getExtensionMasterAdminBinding } from './twitch-extension-admin.js';
import { getPrices, savePrices, DEFAULT_PRICES } from '../lib/pricing.js';
import { getSystemMetrics } from './system-metrics.js';
import { readChatSettings, saveChatSettings, validateChatSettings } from '../lib/chat-settings.js';
import { ICON_PATHS } from './icons.js';

const AUTH_FILE = path.join(ROOT, 'data', 'local-admin.json');
const LOOT_FILE = path.join(ROOT, 'data', 'loot-table.json');
const APP_SETTINGS_FILE = path.join(ROOT, 'data', 'app-settings.json');
const AREA_PRICES_KEY = 'config:area:prices';
const SESSION_COOKIE = 'fb_local_admin';
const DEFAULT_SESSION_MAX_AGE = 8 * 60 * 60;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const FAILED_LOGINS = new Map();
const BOT_LOGIN_LAUNCHES = new Map();
const NORMAL_TIER_IDS = ['godly', 'legendary', 'epic', 'rare', 'uncommon', 'common'];
const PASSWORD_MIN = 12;

const APP_SETTINGS_DEFAULTS = Object.freeze({
  security: { sessionTimeoutMinutes: 60 },
  performance: { cpuAlertPercent: 85, ramLimitMb: 1536, networkAlertMbps: 50 },
  startup: { startOnPc: false, startWhenObsStarts: false }
});

function readAppSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')); } catch (_) { }
  const number = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  };
  return {
    security: {
      sessionTimeoutMinutes: number(raw?.security?.sessionTimeoutMinutes, APP_SETTINGS_DEFAULTS.security.sessionTimeoutMinutes, 5, 480)
    },
    performance: {
      cpuAlertPercent: number(raw?.performance?.cpuAlertPercent, APP_SETTINGS_DEFAULTS.performance.cpuAlertPercent, 5, 100),
      ramLimitMb: number(raw?.performance?.ramLimitMb, APP_SETTINGS_DEFAULTS.performance.ramLimitMb, 256, 8192),
      networkAlertMbps: number(raw?.performance?.networkAlertMbps, APP_SETTINGS_DEFAULTS.performance.networkAlertMbps, 1, 1000)
    },
    startup: {
      startOnPc: raw?.startup?.startOnPc === true,
      startWhenObsStarts: raw?.startup?.startWhenObsStarts === true
    }
  };
}

function writeAppSettings(settings) {
  fs.mkdirSync(path.dirname(APP_SETTINGS_FILE), { recursive: true });
  const temp = APP_SETTINGS_FILE + '.tmp';
  // Keep sections this page does not edit, such as interface.language written by setup.
  let kept = {};
  try { kept = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')) || {}; } catch (_) { }
  fs.writeFileSync(temp, JSON.stringify({ ...kept, ...settings }, null, 2), { encoding: 'utf8', mode: 0o600 });
  replaceFile(temp, APP_SETTINGS_FILE);
}

function readLootConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(LOOT_FILE, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (_) { return {}; }
}

function areaPriceDefaults() {
  return Object.fromEntries(AREA_IDS.map((id) => {
    const area = FISHING_AREAS[id];
    return [id, { unlockCost: area.unlockCost, levelCosts: [...area.levelCosts] }];
  }));
}

async function getAreaPrices() {
  try {
    const raw = await db.get(AREA_PRICES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const defaults = areaPriceDefaults();
    for (const id of AREA_IDS) {
      const entry = parsed?.[id];
      const clean = (value, fallback) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000000 ? Number(value) : fallback;
      defaults[id] = {
        unlockCost: clean(entry?.unlockCost, defaults[id].unlockCost),
        levelCosts: defaults[id].levelCosts.map((fallback, i) => clean(entry?.levelCosts?.[i], fallback))
      };
    }
    return defaults;
  } catch (_) { return areaPriceDefaults(); }
}

function sessionMaxAgeSeconds() {
  return readAppSettings().security.sessionTimeoutMinutes * 60 || DEFAULT_SESSION_MAX_AGE;
}

function replaceFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    try { fs.unlinkSync(destination); } catch (_) { }
    fs.renameSync(source, destination);
  }
}

function readAuth() {
  try {
    const value = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return value && typeof value.salt === 'string' && typeof value.hash === 'string' ? value : null;
  } catch (_) { return null; }
}

function writeAuth(password) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const temp = AUTH_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, salt, hash, changedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  replaceFile(temp, AUTH_FILE);
  ensureLocalBotBroadcasterAdmin().catch((error) => console.error('[control-centre] Could not enable Broadcaster Admin for the connected bot:', error?.message || error));
}

function passwordValid(password) {
  return typeof password === 'string' && password.length >= PASSWORD_MIN && password.length <= 128;
}

function verifyPassword(password) {
  const record = readAuth();
  if (!record || typeof password !== 'string') return false;
  try {
    const actual = crypto.scryptSync(password, record.salt, 64);
    const expected = Buffer.from(record.hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return ''; }
  }
  return '';
}

function signSession() {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET is missing. Restart Fishingbot to regenerate it.');
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + sessionMaxAgeSeconds() * 1000, nonce: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSession(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token || !SESSION_SECRET) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Date.now();
  } catch (_) { return false; }
}

export function isManagerAuthenticated(req) {
  return validSession(req);
}

export function hasManagerPassword() {
  return !!readAuth();
}

export function createBotLoginLaunchUrl(publicUrl, port) {
  const token = crypto.randomBytes(24).toString('base64url');
  BOT_LOGIN_LAUNCHES.set(token, Date.now() + 2 * 60 * 1000);
  const base = String(publicUrl || `http://localhost:${Number(port) || 3000}`).replace(/\/+$/, '');
  return `${base}/local/bot/login?launch=${encodeURIComponent(token)}`;
}

export function consumeBotLoginLaunch(token) {
  if (typeof token !== 'string' || !token) return false;
  const expires = BOT_LOGIN_LAUNCHES.get(token);
  BOT_LOGIN_LAUNCHES.delete(token);
  return Number(expires) > Date.now();
}

export function managerCookie(res) {
  const token = signSession();
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/local; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionMaxAgeSeconds()}`);
}

export function clearManagerCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/local; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export function sameOriginRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === String(host).toLowerCase() && ['http:', 'https:'].includes(parsed.protocol);
  } catch (_) { return false; }
}

function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}

function loginLocked(req) {
  const entry = FAILED_LOGINS.get(clientKey(req));
  if (!entry) return false;
  if (entry.until <= Date.now()) { FAILED_LOGINS.delete(clientKey(req)); return false; }
  return entry.count >= 5;
}

function failedLogin(req) {
  const key = clientKey(req);
  const entry = FAILED_LOGINS.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  if (entry.until <= Date.now()) { entry.count = 0; entry.until = Date.now() + 15 * 60 * 1000; }
  entry.count += 1;
  FAILED_LOGINS.set(key, entry);
}

export function setupManagerPassword(password) {
  if (hasManagerPassword()) return { ok: false, status: 409, error: 'An admin password is already configured.' };
  if (!passwordValid(password)) return { ok: false, status: 400, error: `Use a password with at least ${PASSWORD_MIN} characters (maximum 128).` };
  writeAuth(password);
  return { ok: true };
}

export function loginManager(req, password, res) {
  if (loginLocked(req)) return { ok: false, status: 429, error: 'Too many failed attempts. Try again in 15 minutes.' };
  if (!verifyPassword(password)) {
    failedLogin(req);
    return { ok: false, status: 401, error: 'Incorrect password.' };
  }
  FAILED_LOGINS.delete(clientKey(req));
  managerCookie(res);
  return { ok: true };
}

export function changeManagerPassword(currentPassword, newPassword, res) {
  if (!verifyPassword(currentPassword)) return { ok: false, status: 401, error: 'Current password is incorrect.' };
  if (!passwordValid(newPassword)) return { ok: false, status: 400, error: `Use a new password with at least ${PASSWORD_MIN} characters (maximum 128).` };
  writeAuth(newPassword);
  managerCookie(res);
  return { ok: true };
}

export function verifyManagerReauthentication(req, password) {
  if (loginLocked(req)) return { ok: false, status: 429, error: 'Too many failed password checks. Try again in 15 minutes.' };
  if (!passwordValid(password) || !verifyPassword(password)) {
    failedLogin(req);
    return { ok: false, status: 401, error: 'The existing Master Admin password is incorrect.' };
  }
  FAILED_LOGINS.delete(clientKey(req));
  return { ok: true };
}

function tierChanceMap() {
  const ordered = TIERS.filter((tier) => NORMAL_TIER_IDS.includes(tier.id));
  const result = {};
  let previous = 0;
  for (const tier of ordered) {
    const next = Math.max(previous, Math.min(1, Number(tier.cutoff) || 0));
    result[tier.id] = Number(((next - previous) * 100).toFixed(2));
    previous = next;
  }
  return result;
}

export async function getManagerSettings(botStatus) {
  const [rawCooldown, autoFish, areasMaster, doubleMaster, prices, areaPrices, metrics, ...areaFlags] = await Promise.all([
    db.get('settings:cooldown').catch(() => null),
    getAutoFishConfig(),
    db.get(AREAS_ENABLED_KEY),
    db.get(DOUBLE_CATCH_ENABLED_KEY),
    getPrices(db),
    getAreaPrices(),
    getSystemMetrics(),
    ...AREA_IDS.map((id) => db.get(areaEnabledKey(id)))
  ]);
  const parsedCooldown = rawCooldown === null ? 60 : Number(rawCooldown);
  return {
    tiers: TIERS.map((tier) => ({
      id: tier.id,
      name: tier.name,
      badge: tier.badge,
      items: [...(tier.items || [])],
      chance: tier.id === 'treasury' ? Number(tier.basePct || 2) : tierChanceMap()[tier.id]
    })),
    cooldownSeconds: Number.isFinite(parsedCooldown) ? Math.max(0, Math.min(240, parsedCooldown)) : 60,
    chat: await readChatSettings(),
    autoFish: {
      enabled: !!autoFish.enabled,
      licenseCost: autoFish.licenseCost,
      maxLevel: autoFish.maxLevel,
      xpPerLevel: autoFish.xpPerLevel,
      manualXp: autoFish.manualXp,
      autoXp: autoFish.autoXp,
      activeEventXp: autoFish.activeEventXp,
      baseIntervalSeconds: autoFish.baseIntervalSeconds,
      levelEfficiencyStart: autoFish.levelEfficiencyStart,
      levelEfficiencyStep: autoFish.levelEfficiencyStep,
      sessionMinutesStart: autoFish.sessionMinutesStart,
      sessionMinutesPerLevel: autoFish.sessionMinutesPerLevel,
      sessionMinutesPerPrestige: autoFish.sessionMinutesPerPrestige,
      attentionBase: autoFish.attentionBase,
      attentionEveryLevels: autoFish.attentionEveryLevels,
      attentionPerPrestige: autoFish.attentionPerPrestige,
      eventChancePercent: Number((autoFish.eventChancePerCast * 100).toFixed(1)),
      eventDurationSeconds: autoFish.eventDurationSeconds,
      eventCooldownSeconds: autoFish.eventCooldownSeconds,
      prestigeMax: autoFish.prestigeMax
    },
    areas: {
      enabled: isEnabledValue(areasMaster),
      doubleCatchEnabled: isEnabledValue(doubleMaster),
      items: AREA_IDS.map((id, i) => ({ id, name: FISHING_AREAS[id].name, enabled: isEnabledValue(areaFlags[i]) }))
    },
    prices,
    areaPrices,
    abilities: readLootConfig().abilities || {},
    weights: Object.fromEntries(TIERS.map((tier) => [tier.id, Object.fromEntries((tier.items || []).map((item) => [String(item), FISH_WEIGHTS[tier.id]?.[String(item)] ?? DEFAULT_FISH_WEIGHT]))])),
    areaLoot: Object.fromEntries(AREA_IDS.map((id) => {
      const area = FISHING_AREAS[id];
      return [id, {
        name: area.name,
        loot: area.loot.map(([name, tier, weight]) => ({ name, tier, weight, boost: Number(area.boost?.[name] || 0) })),
        defaults: {
          loot: DEFAULT_AREA_LOOT[id].loot.map(([name, tier, weight]) => ({ name, tier, weight, boost: Number(DEFAULT_AREA_LOOT[id].boost?.[name] || 0) }))
        }
      }];
    })),
    appSettings: readAppSettings(),
    systemMetrics: metrics,
    bot: typeof botStatus === 'function' ? botStatus() : null,
    extensionMasterAdmin: getExtensionMasterAdminBinding(),
    updateRepository: process.env.FISHINGBOT_UPDATE_REPOSITORY || '',
    twitchConfig: settingsReport(),
    twitchExtension: extensionPublisherStatus(),
    port: Number(process.env.PORT) || 3000,
    passwordMinLength: PASSWORD_MIN
  };
}

export async function saveCooldown(seconds) {
  const value = Number(seconds);
  if (!Number.isInteger(value) || value < 0 || value > 240) {
    return { ok: false, status: 400, error: 'Cooldown must be a whole number between 0 and 240 seconds.' };
  }
  await db.set('settings:cooldown', String(value));
  return { ok: true, seconds: value };
}

export async function saveGameplaySettings(payload = {}) {
  const cooldown = Number(payload.cooldownSeconds);
  if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 240) {
    return { ok: false, status: 400, error: 'Global cooldown must be a whole number from 0 to 240 seconds.' };
  }

  const chatCheck = validateChatSettings(payload.chat);
  if (!chatCheck.ok) return chatCheck;

  const auto = payload.autoFish || {};
  const numericRules = {
    licenseCost: [0, 100000],
    maxLevel: [1, 50],
    xpPerLevel: [1, 10000],
    manualXp: [0, 10000],
    autoXp: [0, 10000],
    activeEventXp: [0, 10000],
    baseIntervalSeconds: [30, 3600],
    levelEfficiencyStart: [1, 99],
    levelEfficiencyStep: [0, 20],
    sessionMinutesStart: [1, 1440],
    sessionMinutesPerLevel: [0, 120],
    sessionMinutesPerPrestige: [0, 240],
    attentionBase: [1, 20],
    attentionEveryLevels: [1, 10],
    attentionPerPrestige: [0, 5],
    eventChancePercent: [0, 100],
    eventDurationSeconds: [10, 300],
    eventCooldownSeconds: [0, 3600],
    prestigeMax: [0, 5]
  };
  const autoPatch = { enabled: auto.enabled === true };
  for (const [key, [min, max]] of Object.entries(numericRules)) {
    const value = Number(auto[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return { ok: false, status: 400, error: `${key} must be between ${min} and ${max}.` };
    }
    autoPatch[key === 'eventChancePercent' ? 'eventChancePerCast' : key] = key === 'eventChancePercent' ? value / 100 : Math.round(value);
  }

  const areaOptions = payload.areas || {};
  if (typeof areaOptions.enabled !== 'boolean' || typeof areaOptions.doubleCatchEnabled !== 'boolean' || !areaOptions.items || typeof areaOptions.items !== 'object') {
    return { ok: false, status: 400, error: 'World-feature settings are incomplete.' };
  }
  for (const id of AREA_IDS) {
    if (typeof areaOptions.items[id] !== 'boolean') return { ok: false, status: 400, error: `Missing enabled/disabled state for ${id}.` };
  }

  await db.set('settings:cooldown', String(cooldown));
  if (chatCheck.value) await saveChatSettings(chatCheck.value);
  await setAutoFishConfig(autoPatch);
  const writes = [
    db.set(AREAS_ENABLED_KEY, areaOptions.enabled ? 'on' : 'off'),
    db.set(DOUBLE_CATCH_ENABLED_KEY, areaOptions.doubleCatchEnabled ? 'on' : 'off'),
    ...AREA_IDS.map((id) => db.set(areaEnabledKey(id), areaOptions.items[id] ? 'on' : 'off'))
  ];
  await Promise.all(writes);
  return { ok: true };
}

function cleanFishName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return null;
  // No markup, control characters, path separators or bracketed tier suffixes.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'’!?()_-]{0,59}$/u.test(name)) return null;
  if (/\[[^\]]*\]$/.test(name)) return null;
  return name;
}

// Weights are relative numbers, kept to two decimals. 100 is neutral.
function cleanWeightValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10000) return null;
  return Math.round(n * 100) / 100;
}

// Perks are normalised here so the saved shape always matches what the game
// reads. Cooldown reduction stores its percentage in both fields; timeout uses
// only its own minutes; the multiplier effects use value and duration.
function normalizeAbility(fishName, raw) {
  const effectType = String(raw.effectType || '');
  if (!['luck', 'weight', 'treasuryLuck', 'cooldownReduction', 'timeout'].includes(effectType)) {
    return { error: `Unsupported effect type for ${fishName}.` };
  }
  const durationMinutes = Number(raw.durationMinutes ?? 10);
  const timeoutMinutes = Number(raw.timeoutMinutes ?? 5);
  const minutesOk = (n) => Number.isInteger(n) && n >= 1 && n <= 20;
  const base = {
    perkName: String(raw.perkName || `${fishName} Perk`).trim().slice(0, 48),
    description: String(raw.description || '').trim().slice(0, 240)
  };
  if (effectType === 'timeout') {
    if (!minutesOk(timeoutMinutes)) return { error: `Timeout for ${fishName} must be whole minutes between 1 and 20.` };
    return { value: { ...base, effectType, effectValue: 1, durationMinutes: timeoutMinutes, timeoutMinutes, cooldownReductionPct: 0 } };
  }
  if (!minutesOk(durationMinutes)) return { error: `Effect duration for ${fishName} must be whole minutes between 1 and 20.` };
  if (effectType === 'cooldownReduction') {
    const pct = Number(raw.cooldownReductionPct ?? raw.effectValue);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 80) return { error: `Cooldown reduction for ${fishName} must be above 0% and at most 80%.` };
    return { value: { ...base, effectType, effectValue: pct, durationMinutes, timeoutMinutes: durationMinutes, cooldownReductionPct: pct } };
  }
  const multiplier = Number(raw.effectValue ?? 1.25);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 10) return { error: `Multiplier for ${fishName} must be above 0 and at most 10.` };
  return { value: { ...base, effectType, effectValue: multiplier, durationMinutes, timeoutMinutes: durationMinutes, cooldownReductionPct: 0 } };
}

function savedAreaTables() {
  const saved = readLootConfig().areas;
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}

export function validateAndSaveLootTable(payload) {
  const inputTiers = Array.isArray(payload?.tiers) ? payload.tiers : [];
  const existingById = new Map(TIERS.map((tier) => [tier.id, tier]));
  if (inputTiers.length !== TIERS.length) return { ok: false, status: 400, error: 'The loot table is missing one or more rarity groups.' };

  const names = new Set();
  const allNames = [];
  const nextTiers = [];
  for (const current of TIERS) {
    const supplied = inputTiers.find((tier) => tier?.id === current.id);
    if (!supplied || !Array.isArray(supplied.items)) return { ok: false, status: 400, error: `Missing items for ${current.name}.` };
    if (supplied.items.length < 1 || supplied.items.length > 500) return { ok: false, status: 400, error: `${current.name} must contain between 1 and 500 entries.` };
    const items = [];
    for (const raw of supplied.items) {
      const name = cleanFishName(raw);
      if (!name) return { ok: false, status: 400, error: `Invalid fish name in ${current.name}. Use 1–60 letters, numbers, spaces or basic punctuation.` };
      const key = name.toLocaleLowerCase('en-US');
      if (names.has(key)) return { ok: false, status: 400, error: `“${name}” appears more than once. Fish names must be unique across rarities.` };
      names.add(key);
      allNames.push(name);
      items.push(name);
    }
    nextTiers.push({ id: current.id, items });
  }

  // Names that differ only by case, accents, apostrophes or spacing would be
  // hard to tell apart in the !fish output and the Fishdex, so they are refused.
  const lookalikes = findNormalizedDuplicates(allNames);
  if (lookalikes.length) {
    const pair = lookalikes[0].map((name) => `“${name}”`).join(' and ');
    return { ok: false, status: 400, error: `${pair} look like the same name. Rename one of them.` };
  }

  const chanceById = {};
  let totalBasisPoints = 0;
  for (const id of NORMAL_TIER_IDS) {
    const supplied = inputTiers.find((tier) => tier?.id === id);
    const raw = Number(supplied?.chance);
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) return { ok: false, status: 400, error: `Chance for ${id} must be between 0 and 100%.` };
    const bp = Math.round(raw * 100);
    chanceById[id] = bp;
    totalBasisPoints += bp;
  }
  if (totalBasisPoints !== 10000) return { ok: false, status: 400, error: `Normal rarity chances must add up to exactly 100%. Current total: ${(totalBasisPoints / 100).toFixed(2)}%.` };

  const treasuryRaw = Number(inputTiers.find((tier) => tier?.id === 'treasury')?.chance ?? 2);
  if (!Number.isFinite(treasuryRaw) || treasuryRaw < 0 || treasuryRaw > 25) return { ok: false, status: 400, error: 'Treasury chance must be between 0 and 25%.' };

  let cumulative = 0;
  for (const id of NORMAL_TIER_IDS) {
    cumulative += chanceById[id];
    const next = nextTiers.find((entry) => entry.id === id);
    next.cutoff = cumulative / 10000;
    next.basePct = chanceById[id] / 100;
  }
  const uniqueTier = nextTiers.find((entry) => entry.id === 'unique');
  uniqueTier.cutoff = 0;
  uniqueTier.basePct = 0;
  const treasuryTier = nextTiers.find((entry) => entry.id === 'treasury');
  treasuryTier.basePct = Number(treasuryRaw.toFixed(2));

  // Fish weights. Only values that differ from neutral are stored.
  const suppliedWeights = payload?.weights && typeof payload.weights === 'object' && !Array.isArray(payload.weights) ? payload.weights : {};
  const weights = {};
  for (const tier of nextTiers) {
    const tierWeights = {};
    let rollable = 0;
    for (const name of tier.items) {
      const raw = suppliedWeights[tier.id]?.[name];
      const weight = raw === undefined ? DEFAULT_FISH_WEIGHT : cleanWeightValue(raw);
      if (weight === null) return { ok: false, status: 400, error: `Weight for “${name}” must be a number from 0 to 10,000.` };
      if (weight > 0) rollable += 1;
      if (weight !== DEFAULT_FISH_WEIGHT) tierWeights[name] = weight;
    }
    if (rollable === 0) return { ok: false, status: 400, error: `${TIERS.find((t) => t.id === tier.id)?.name || tier.id} needs at least one fish with a weight above 0.` };
    if (Object.keys(tierWeights).length) weights[tier.id] = tierWeights;
  }

  const oldAbilities = readLootConfig().abilities || {};
  const suppliedAbilities = payload?.abilities && typeof payload.abilities === 'object' && !Array.isArray(payload.abilities) ? payload.abilities : oldAbilities;
  const validFish = new Set(nextTiers.flatMap((tier) => tier.items.map((name) => name.toLowerCase())));
  const abilities = {};
  for (const [fishNameRaw, raw] of Object.entries(suppliedAbilities)) {
    const fishName = cleanFishName(fishNameRaw);
    if (!fishName || !validFish.has(fishName.toLowerCase()) || !raw || typeof raw !== 'object') continue;
    const normalized = normalizeAbility(fishName, raw);
    if (normalized.error) return { ok: false, status: 400, error: normalized.error };
    abilities[fishName] = normalized.value;
  }

  // Area loot tables. An area that is not in the payload keeps its saved table.
  const savedAreas = savedAreaTables();
  const suppliedAreas = payload?.areas && typeof payload.areas === 'object' && !Array.isArray(payload.areas) ? payload.areas : null;
  const tierNames = new Set(TIERS.map((tier) => tier.name));
  const areas = {};
  for (const id of AREA_IDS) {
    const supplied = suppliedAreas?.[id];
    if (!supplied) {
      if (savedAreas[id]) areas[id] = savedAreas[id];
      continue;
    }
    if (!Array.isArray(supplied.loot) || supplied.loot.length < 1 || supplied.loot.length > 80) {
      return { ok: false, status: 400, error: `${FISHING_AREAS[id].name} needs between 1 and 80 catches.` };
    }
    const seen = new Set();
    const loot = [];
    const boost = {};
    for (const row of supplied.loot) {
      const name = cleanFishName(row?.name);
      if (!name) return { ok: false, status: 400, error: `Invalid catch name in ${FISHING_AREAS[id].name}. Use 1–60 letters, numbers, spaces or basic punctuation.` };
      const tier = String(row?.tier || '');
      if (!tierNames.has(tier)) return { ok: false, status: 400, error: `${name} in ${FISHING_AREAS[id].name} needs a valid rarity.` };
      const key = normalizeName(name);
      if (seen.has(key)) return { ok: false, status: 400, error: `“${name}” appears twice in ${FISHING_AREAS[id].name}.` };
      seen.add(key);
      const weight = cleanWeightValue(row?.weight);
      if (weight === null) return { ok: false, status: 400, error: `Weight for ${name} in ${FISHING_AREAS[id].name} must be a number from 0 to 10,000.` };
      const bonus = Number(row?.boost ?? 0);
      if (!Number.isFinite(bonus) || bonus < 0 || bonus > 50) return { ok: false, status: 400, error: `Boost for ${name} in ${FISHING_AREAS[id].name} must be between 0 and 50.` };
      loot.push([name, tier, weight]);
      if (bonus > 0) boost[name] = Math.round(bonus * 100) / 100;
    }
    if (!loot.some((row) => row[2] > 0)) return { ok: false, status: 400, error: `${FISHING_AREAS[id].name} needs at least one catch with a weight above 0.` };
    areas[id] = { loot, boost };
  }

  const saveData = {
    version: 3,
    savedAt: new Date().toISOString(),
    tiers: nextTiers,
    weights,
    abilities,
    areas
  };
  fs.mkdirSync(path.dirname(LOOT_FILE), { recursive: true });
  const temp = LOOT_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(saveData, null, 2), 'utf8');
  replaceFile(temp, LOOT_FILE);
  return { ok: true, restartRequired: true };
}

export function saveAppSettings(payload = {}) {
  const current = readAppSettings();
  const number = (value, min, max, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number between ${min} and ${max}.`);
    return n;
  };
  try {
    const next = {
      security: { sessionTimeoutMinutes: number(payload?.security?.sessionTimeoutMinutes, 5, 480, 'Session timeout') },
      performance: {
        cpuAlertPercent: number(payload?.performance?.cpuAlertPercent, 5, 100, 'CPU alert threshold'),
        ramLimitMb: number(payload?.performance?.ramLimitMb, 256, 8192, 'RAM heap limit'),
        networkAlertMbps: number(payload?.performance?.networkAlertMbps, 1, 1000, 'Network alert threshold')
      },
      startup: {
        startOnPc: payload?.startup?.startOnPc === true,
        startWhenObsStarts: payload?.startup?.startWhenObsStarts === true
      }
    };
    writeAppSettings(next);
    return { ok: true, settings: next, restartRequired: true };
  } catch (error) { return { ok: false, status: 400, error: error?.message || 'Invalid application settings.' }; }
}

export async function savePriceSettings(payload = {}) {
  try {
    const cleanPrice = (value, label) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 1000000000) throw new Error(`${label} must be a whole number from 0 to 1,000,000,000.`);
      return n;
    };

    // Validate both groups completely before writing either one. The shared
    // savePrices() normalizer intentionally provides safe defaults to game
    // code; an admin form must instead reject malformed or missing fields.
    const previousPrices = await getPrices(db);
    const suppliedPrices = payload.prices && typeof payload.prices === 'object' ? payload.prices : {};
    const nextPrices = {};
    for (const [category, defaults] of Object.entries(DEFAULT_PRICES)) {
      nextPrices[category] = {};
      for (const [id, fallback] of Object.entries(defaults)) {
        const oldValue = previousPrices?.[category]?.[id] ?? fallback;
        if (Array.isArray(fallback)) {
          const submitted = suppliedPrices?.[category]?.[id];
          nextPrices[category][id] = fallback.map((base, index) => cleanPrice(
            Array.isArray(submitted) ? (submitted[index] ?? oldValue?.[index] ?? base) : (oldValue?.[index] ?? base),
            `${category} ${id} level ${index + 1} price`
          ));
        } else {
          nextPrices[category][id] = cleanPrice(
            suppliedPrices?.[category]?.[id] ?? oldValue,
            `${category} ${id} price`
          );
        }
      }
    }

    const defaults = areaPriceDefaults();
    const existingAreas = await getAreaPrices();
    const suppliedAreas = payload.areaPrices && typeof payload.areaPrices === 'object' ? payload.areaPrices : {};
    const nextAreas = {};
    for (const id of AREA_IDS) {
      const item = suppliedAreas[id] || {};
      const current = existingAreas[id] || defaults[id];
      nextAreas[id] = {
        unlockCost: cleanPrice(item.unlockCost ?? current.unlockCost ?? defaults[id].unlockCost, `${FISHING_AREAS[id].name} unlock price`),
        levelCosts: defaults[id].levelCosts.map((fallback, i) => cleanPrice(item.levelCosts?.[i] ?? current.levelCosts?.[i] ?? fallback, `${FISHING_AREAS[id].name} level ${i + 2} price`))
      };
    }

    const previousAreaRaw = await db.get(AREA_PRICES_KEY);
    try {
      const prices = await savePrices(db, nextPrices);
      await db.set(AREA_PRICES_KEY, JSON.stringify(nextAreas));
      return { ok: true, prices, areaPrices: nextAreas };
    } catch (writeError) {
      // If the second write fails, restore the first write so the editor
      // cannot leave the shop and area prices half-updated.
      try { await savePrices(db, previousPrices); } catch (rollbackError) {
        console.error('[control-centre] Shop price rollback failed:', rollbackError?.message || rollbackError);
      }
      try {
        if (previousAreaRaw === null || previousAreaRaw === undefined) await db.del(AREA_PRICES_KEY);
        else await db.set(AREA_PRICES_KEY, previousAreaRaw);
      } catch (rollbackError) {
        console.error('[control-centre] Area price rollback failed:', rollbackError?.message || rollbackError);
      }
      throw writeError;
    }
  } catch (error) { return { ok: false, status: 400, error: error?.message || 'Could not save shop and area prices.' }; }
}

export async function exportViewerData(login) {
  if (typeof db.exportUserData !== 'function') throw new Error('User database export is available in the local SQLite edition only.');
  return db.exportUserData(login);
}

export async function importViewerData(payload, login) {
  if (typeof db.importUserData !== 'function') throw new Error('User database import is available in the local SQLite edition only.');
  return db.importUserData(payload, login);
}

export async function previewViewerData(payload, login) {
  if (typeof db.previewUserData !== 'function') throw new Error('User database import is available in the local SQLite edition only.');
  return db.previewUserData(payload, login);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function managerPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fishingbot Control Centre</title><link rel="stylesheet" href="/styles/overlay-alerts.css?v=19"><script src="/scripts/overlay-render.js?v=14"></script>
<link rel="stylesheet" href="/styles/control-centre.css?v=1"><link rel="stylesheet" href="/styles/loot-table.css?v=1"></head><body><div id="app"><div class="login-wrap"><div class="login-card"><div class="eyebrow">Fishingbot</div><h1>Loading control centre…</h1><p class="muted">Checking local access.</p></div></div></div>
<script src="/i18n/i18n.js"></script>
<script src="/scripts/control-centre-loot.js?v=2"></script>
<script>
(function(){
'use strict';
const FB_ICONS=${JSON.stringify(ICON_PATHS)};
function fbIcon(name,size){const d=FB_ICONS[name];if(!d)return '';const px=size||18;return '<svg class="ic" width="'+px+'" height="'+px+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="'+d+'"/></svg>';}
function tr(key,fallback){const v=window.FishingbotI18n?window.FishingbotI18n.t(key):null;return v&&v!==key?v:fallback;}
const app=document.getElementById('app');let settings=null;const validTabs=['overview','loot','game','twitch','extension','viewer','broadcaster'];let requestedTab=new URLSearchParams(location.search).get('tab');let currentTab=validTabs.includes(requestedTab)?requestedTab:'overview';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function call(path,body){const opt=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};const r=await fetch('/local/admin/'+path,opt);let data={};try{data=await r.json()}catch(_){}if(!r.ok)throw new Error(data.error||('Request failed ('+r.status+')'));return data;}
// Toasts: a stack at the bottom right. Hovering a toast pauses its timer. Identical messages
// replace each other, and at most four are shown. notice(message, type) is the single entry point.
const TOAST_TITLES={good:'Done',error:'Something went wrong',warn:'Heads up',info:'Notice'};
function toastHost(){
  let host=document.getElementById('toast-host');
  if(!host){host=document.createElement('div');host.id='toast-host';host.className='toast-host';host.setAttribute('aria-live','polite');document.body.appendChild(host);}
  return host;
}
function dismissToast(t){if(!t||t.dataset.out)return;t.dataset.out='1';t.classList.add('is-out');setTimeout(()=>t.remove(),240);}
function notice(message,type){
  const kind=['good','error','warn'].includes(type)?type:'info';
  const text=String(message==null?'':message);
  // Electron desktop apps share the shell toast system; browser mode keeps its local fallback.
  if (window.FishingbotDesktopToast) { window.FishingbotDesktopToast(text, kind); return; }
  const host=toastHost();
  const same=[...host.querySelectorAll('.toast:not([data-out])')].find(t=>t.dataset.msg===text&&t.dataset.kind===kind);
  if(same)dismissToast(same);
  const duration=5000;
  const t=document.createElement('div');
  t.className='toast toast-'+kind;
  t.dataset.msg=text;t.dataset.kind=kind;
  t.setAttribute('role',kind==='error'?'alert':'status');
  t.innerHTML='<span class="toast-mark" aria-hidden="true"></span><div class="toast-body"><strong class="toast-title">'+TOAST_TITLES[kind]+'</strong><span class="toast-msg">'+esc(text)+'</span></div><button class="toast-x" type="button" aria-label="Dismiss">×</button><span class="toast-bar" style="animation-duration:'+duration+'ms"></span>';
  t.querySelector('.toast-x').addEventListener('click',()=>dismissToast(t));
  // One 5 second timer per toast. Hovering pauses it, and the bar at the bottom shows the time left.
  t._left=duration;t._started=Date.now();
  t._timer=setTimeout(()=>dismissToast(t),duration);
  t.addEventListener('mouseenter',()=>{clearTimeout(t._timer);t._left-=Date.now()-t._started;});
  t.addEventListener('mouseleave',()=>{t._started=Date.now();t._timer=setTimeout(()=>dismissToast(t),Math.max(200,t._left));});
  host.appendChild(t);
  const live=host.querySelectorAll('.toast:not([data-out])');
  if(live.length>4)dismissToast(live[0]);
}

function loginFrame(title,desc,setup){app.innerHTML='<div class="login-wrap"><div class="login-card"><div class="eyebrow">Fishingbot / Local control</div><h1>'+title+'</h1><p class="muted">'+desc+'</p><form id="auth-form"><div class="field"><label>'+(setup?'Create admin password':'Admin password')+'</label><input id="password" type="password" minlength="'+(setup?12:1)+'" maxlength="128" autocomplete="'+(setup?'new-password':'current-password')+'" required></div>'+(setup?'<p class="small">Use at least 12 characters. This password protects streamer-only settings on this PC.</p>':'')+'<button class="btn primary" type="submit">'+(setup?'Create password':'Unlock control centre')+'</button></form></div></div>';
 document.getElementById('auth-form').addEventListener('submit',async e=>{e.preventDefault();const password=document.getElementById('password').value;try{await call(setup?'setup':'login',{password});await boot();}catch(err){notice(err.message,'error');}});
}
function shell(){const nav=[['overview','layout','page.overview','Overview'],['twitch','chat','page.twitch','Twitch bot'],['broadcaster','video','page.broadcaster','Broadcaster'],['game','sliders','page.game','Game settings'],['loot','package','page.loot','Loot table'],['extension','layers','page.extension','Twitch Extension'],['viewer','user','page.viewer','Viewers']];const items=nav.map(([id,ic,key,label])=>'<button type="button" data-tab="'+id+'" class="'+(id===currentTab?'active':'')+'">'+fbIcon(ic,18)+'<span data-i18n="'+key+'">'+label+'</span></button>').join('');app.innerHTML='<div class="shell"><aside class="rail"><nav class="nav">'+items+'</nav><div class="rail-foot"><span data-i18n="shell.footerA">LOCAL ADMIN SESSION</span><br><span data-i18n="shell.footerB">Settings stay on this PC.</span></div></aside><main class="main"><header class="top"><div class="top-text"><div class="title" id="page-title">Overview</div><div class="small" data-i18n="shell.lede">One place for game, viewer, broadcaster and application controls.</div></div><div class="actions top-actions"><button class="btn secondary" id="fb-lock" type="button">'+fbIcon('lock',16)+'<span data-i18n="button.lock">Lock</span></button><div class="status ok">● <span data-i18n="shell.session">LOCAL SESSION</span></div></div></header><section id="view"></section></main></div>';app.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{if(currentTab==='loot'&&b.dataset.tab!=='loot'){const pending=document.querySelector('#view [data-act="save"]:not([disabled])');if(pending)pending.click();}currentTab=b.dataset.tab;app.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));renderTab();}));if(window.FishingbotI18n){window.FishingbotI18n.loadLanguage(window.FishingbotI18n.getLanguage());}renderTab();}
function setView(html,title){document.getElementById('view').innerHTML=html;document.getElementById('page-title').textContent=title;}
async function reconnect(){try{const r=await fetch('/local/bot/reconnect',{method:'POST'});const data=await r.json().catch(()=>({}));if(r.ok&&data.ok){await refreshSettings();renderTab();notice('Twitch reconnected.','good');return;}if(r.status===409||data.configured===false){const link=await call('bot-login-link');location.href=link.url;return;}throw new Error(data.error||'Reconnect failed.');}catch(error){notice(error.message,'error');}}
async function disconnect(){if(!confirm('Disconnect the Twitch account from Fishingbot on this PC?'))return;try{const response=await fetch('/local/bot/disconnect',{method:'POST'});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Could not disconnect Twitch.');await refreshSettings();renderTab();notice('Twitch account disconnected from this PC.','good');}catch(error){notice(error.message,'error');}}
function statusPill(ok,text){return '<span class="status '+(ok?'ok':'bad')+'">'+(ok?'● ':'○ ')+esc(text)+'</span>';}
const VIEWER_COMMANDS=[['!fish','Catch a fish. Use !fish pond when your Pond chat collection is unlocked.'],['!buy [perk-id] [rarity]','List or buy Treasury shop perks; rarityBoost accepts a rarity.'],['!perks [enable|disable perk-id]','List perks or toggle an owned perk.'],['!autofish start [area-id] / stop','Start or stop your own Auto-Fish.'],['!areas [list|buy|select area-id|unselect]','List, unlock or select fishing areas.'],['!treasury','Show your Treasury balance, earnings and spending.'],['!inventory / !inv','Get a short count summary; use !inventory list [page] for details.'],['!stats','See casts, Fishdex progress, Auto-Fish and title.'],['!fishdex / !dex','See discovered species.'],['!pond','See Pond level, FishyTokens and waiting fish.'],['!leaderboard / !top','See the top three anglers by catches.'],['!help','Show available Fishingbot chat commands.']];
function goTab(id){currentTab=id;app.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x.dataset.tab===currentTab));renderTab();}
function meterHtml(percent,warn){const p=Math.max(0,Math.min(100,Number(percent)||0));return '<div class="meter'+(warn?' is-warn':'')+'" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(p)+'"><div class="meter-fill" style="width:'+p.toFixed(1)+'%"></div></div>';}
function copyText(text){
  const fail=()=>notice('Clipboard unavailable here. Select the link and copy it by hand.','warn');
  try{
    if(!navigator.clipboard)return fail();
    navigator.clipboard.writeText(text).then(()=>notice('Copied to clipboard.','good'),fail);
  }catch(_){fail();}
}
function renderOverview(){
  const bot=settings.bot||{};
  const m=settings.systemMetrics||{};
  const perf=settings.appSettings?.performance||{};
  const fmt=n=>{const v=Number(n)||0;if(v<1024)return Math.round(v)+' B';if(v<1048576)return (v/1024).toFixed(1)+' KB';if(v<1073741824)return (v/1048576).toFixed(1)+' MB';return (v/1073741824).toFixed(2)+' GB';};
  const hasValue=v=>v!==null&&v!==undefined&&v!=='';
  const pct=v=>Math.max(0,Math.min(100,Number(v)||0));
  const cpuLimit=Number(perf.cpuAlertPercent)||85;
  const netLimit=Number(perf.networkAlertMbps)||50;
  const netPeak=Math.max(Number(m.networkInBytesPerSecond||0),Number(m.networkOutBytesPerSecond||0))*8/1000000;
  const cpuWarn=hasValue(m.cpuPercent)&&m.cpuPercent>cpuLimit;
  const netWarn=netPeak>netLimit;
  const heapPct=m.nodeHeapLimitBytes?(Number(m.processHeapUsedBytes||0)/Number(m.nodeHeapLimitBytes))*100:0;
  const lagging=(Number(m.eventLoopDelayMs)||0)>50;
  const entries=settings.tiers.reduce((n,t)=>n+t.items.length,0);
  const botOnline=!!bot.connected;
  const base='http://localhost:'+Number(settings.port||3000);

  // Bento layout: each tile is one fact or one action. Sizes come from the
  // .oh-tile--* classes in the CSS below (12 columns, 6 below 1100px, 1 below 720px).
  const tile=(cls,inner)=>'<section class="oh-tile '+cls+'">'+inner+'</section>';
  const statTile=(cls,label,value,sub)=>tile('oh-tile--stat '+cls,'<span>'+label+'</span><strong>'+value+'</strong><small>'+sub+'</small>');

  // Hero: status and the single action that matters.
  const heroInner='<div class="oh-status">'+(botOnline?tr('ov.connected','Connected to Twitch'):tr('ov.notConnected','Not connected'))+'</div>'
    +'<p class="small">'+(botOnline?tr('ov.signedIn','Signed in as {0}.').replace('{0}',esc(bot.displayName||bot.login||tr('ov.yourAccount','your account'))):tr('ov.connectHint','Connect your account so the bot can answer chat.'))+'</p>'
    +'<button class="btn" id="overview-reconnect" type="button">'+(botOnline?tr('ov.reconnect','Reconnect'):tr('ov.connectTwitch','Connect Twitch'))+'</button>'
    +(botOnline?'<button class="btn danger" id="overview-disconnect" type="button">Disconnect Twitch</button>':'');
  const hero=tile('oh-tile--hero oh-hero',heroInner);

  // Three facts, each its own tile.
  const stats=statTile('oh-tile--loot',tr('ov.lootTable','Loot table'),entries,tr('ov.fish','fish'))
    +statTile('oh-tile--db',tr('ov.database','Database'),esc(m.databaseSize||'0 B'),tr('ov.sqliteFile','SQLite file'))
    +statTile('oh-tile--loop',tr('ov.eventLoop','Event loop'),(m.eventLoopDelayMs??0)+' ms',lagging?tr('ov.lagging','lagging'):tr('ov.healthy','healthy'));

  // Four bars. Warnings turn the bar yellow.
  const ovMeter=(label,value,level,warn)=>'<div class="oh-meter'+(warn?' is-warn':'')+'"><div class="oh-meter-top"><span>'+label+'</span><strong>'+value+'</strong></div><div class="meter"><div class="meter-fill" style="width:'+pct(level).toFixed(1)+'%"></div></div></div>';
  const perfInner='<div class="oh-card-head"><h2>'+tr('ov.performance','Performance')+'</h2></div>'
    +'<div class="oh-meters">'
    +ovMeter('CPU',hasValue(m.cpuPercent)?m.cpuPercent+'%':tr('ov.sampling','Sampling'),m.cpuPercent,cpuWarn)
    +ovMeter('RAM',(m.ramPercent??'—')+'%',m.ramPercent,false)
    +ovMeter(tr('ov.nodeHeap','Node heap'),fmt(m.processHeapUsedBytes)+' / '+fmt(m.nodeHeapLimitBytes),heapPct,heapPct>85)
    +ovMeter(tr('ov.network','Network'),netPeak.toFixed(2)+' Mbps',netPeak/netLimit*100,netWarn)
    +'</div><p class="small oh-foot">'+tr('ov.updated','Updated {0}. Warns above {1}% CPU or {2} Mbps.').replace('{0}',m.sampledAt?new Date(m.sampledAt).toLocaleTimeString():'—').replace('{1}',cpuLimit).replace('{2}',netLimit)+'</p>';
  const perfCard=tile('oh-tile--perf',perfInner);

  // Where to go next, as plain buttons.
  const go=[['viewer',tr('ov.viewers','Viewers')],['loot',tr('ov.lootTable','Loot table')],['game',tr('ov.gameSettings','Game settings')],['broadcaster',tr('ov.broadcaster','Broadcaster')],['twitch',tr('ov.twitchBot','Twitch bot')],['extension',tr('ov.extension','Extension')]];
  const actions=tile('oh-tile--actions','<span class="oh-label">'+tr('ov.goTo','Go to')+'</span><div class="oh-actions">'+go.map(([id,label])=>'<button class="oh-action" type="button" data-go="'+id+'">'+label+'</button>').join('')+'</div>');

  // Links for OBS and the local browser preview.
  const linksInner='<span class="oh-label">'+tr('ov.links','Links')+'</span><div class="oh-links"><a href="'+base+'/game" target="_blank" rel="noopener">'+tr('ov.openPreview','Open game preview')+'</a><button type="button" data-copy="'+esc(base+'/overlay.html')+'">'+tr('ov.copyObs','Copy OBS overlay URL')+'</button><button type="button" data-copy="'+esc(base)+'">'+tr('ov.copyLocal','Copy local website URL')+'</button></div>';
  const links=tile('oh-tile--links',linksInner);

  // Chat commands are reference material, so they stay closed until needed.
  const commands='<details class="oh-tile oh-tile--cmds oh-cmds"><summary>'+tr('ov.chatCommands','Chat commands for viewers')+'</summary><div class="cmd-list">'
    +VIEWER_COMMANDS.map(([c,d])=>'<div class="cmd"><code>'+esc(c)+'</code><span class="small">'+esc(d)+'</span></div>').join('')
    +'</div></details>';

  setView('<div class="ov oh-bento">'+hero+stats+perfCard+actions+links+commands+'</div>',tr('page.overview','Overview'));
  document.getElementById('overview-reconnect')?.addEventListener('click',reconnect);
  document.getElementById('overview-disconnect')?.addEventListener('click',disconnect);
  
  app.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>goTab(b.dataset.go)));
  app.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',()=>copyText(b.dataset.copy)));
}


// The loot table tab lives in scripts/control-centre-loot.js. It keeps its own
// unsaved draft, so re-rendering (language change, metrics refresh) is safe.
function renderLoot(){
  if(!window.FishingbotLoot){setView('<div class="card"><p class="small">The loot editor could not load. Reload the Control Centre.</p></div>',tr('page.loot','Loot table'));return;}
  window.FishingbotLoot.mount({settings,call,notice,setView,esc});
}
function renderGame(){
  const a=settings.autoFish||{};
  const w=settings.areas||{items:[]};
  const prices=settings.prices||{};
  const areaPrices=settings.areaPrices||{};
  const toggle=(id,label,on)=>'<label class="toggle-line"><input type="checkbox" id="'+id+'" '+(on?'checked':'')+'> '+label+'</label>';
  const numeric=(id,label,value,min,max,step)=>'<div class="inline-field"><label for="'+id+'">'+label+'</label><input id="'+id+'" type="number" min="'+min+'" max="'+max+'" step="'+step+'" value="'+Number(value)+'"></div>';
  const autoGroups=[
    {title:tr('game.s00','Progression and XP'),fields:[['maxLevel',tr('game.s01','Maximum Auto-Fish level'),1,50,1],['xpPerLevel',tr('game.s02','XP required per level'),1,10000,1],['manualXp',tr('game.s03','XP per manual catch'),0,10000,1],['autoXp',tr('game.s04','XP per Auto-Fish catch'),0,10000,1],['activeEventXp',tr('game.s05','XP per event catch'),0,10000,1],['levelEfficiencyStart',tr('game.s06','Starting efficiency (%)'),1,99,1],['levelEfficiencyStep',tr('game.s07','Efficiency gained per level (%)'),0,20,1],['prestigeMax',tr('game.s08','Maximum prestige level'),0,5,1]]},
    {title:tr('game.s09','License and session timing'),fields:[['licenseCost',tr('game.s10','Auto-Fish license cost (Treasury)'),0,100000,1],['baseIntervalSeconds',tr('game.s11','Base Auto-Fish interval (seconds)'),30,3600,1],['sessionMinutesStart',tr('game.s12','Starting session (minutes)'),1,1440,1],['sessionMinutesPerLevel',tr('game.s13','Extra minutes per level'),0,120,1],['sessionMinutesPerPrestige',tr('game.s14','Extra minutes per prestige'),0,240,1]]},
    {title:tr('game.s15','Fishy treat and event settings'),fields:[['attentionBase',tr('game.s16','Base treat slots'),1,20,1],['attentionEveryLevels',tr('game.s17','Levels per extra treat slot'),1,10,1],['attentionPerPrestige',tr('game.s18','Extra treat slots per prestige'),0,5,1],['eventChancePercent',tr('game.s19','Treasury event chance (%)'),0,100,0.1],['eventDurationSeconds',tr('game.s20','Event duration (seconds)'),10,300,1],['eventCooldownSeconds',tr('game.s21','Event cooldown (seconds)'),0,3600,1]]}
  ];
  const groupsHtml=autoGroups.map(group=>'<details class="card b-4"><summary><h3>'+group.title+'</h3></summary><div class="settings-grid">'+group.fields.map(([key,label,min,max,step])=>numeric('af-'+key,label,a[key],min,max,step)).join('')+'</div></details>').join('');
  const areaRows=(w.items||[]).map(item=>toggle('area-'+item.id,esc(item.name),item.enabled)).join('');
  const priceRows=(category,source)=>Object.entries(source||{}).map(([id,value])=>numeric('price-'+category+'-'+id,category.toUpperCase()+' · '+id,value,0,1000000000,1)).join('');
  const pondRows=Object.entries(prices.pond||{}).map(([id,values])=>'<div class="card"><h3>'+esc(id)+'</h3><div class="settings-grid">'+values.map((value,index)=>numeric('price-pond-'+id+'-'+index,tr('game.s22','Level ')+(index+1),value,0,1000000000,1)).join('')+'</div></div>').join('');
  const areaPriceRows=(w.items||[]).map(item=>{const entry=areaPrices[item.id]||{};return '<div class="card"><h3>'+esc(item.name)+'</h3>'+numeric('area-unlock-'+item.id,tr('game.s23','Unlock cost (Treasury)'),entry.unlockCost??0,0,1000000000,1)+'<div class="settings-grid">'+(entry.levelCosts||[]).map((value,index)=>numeric('area-level-'+item.id+'-'+index,tr('game.s22','Level ')+(index+2),value,0,1000000000,1)).join('')+'</div></div>';}).join('');

  // Save buttons sit at the top, so a long page never hides them.
  const bar='<div class="card b-12"><div class="row"><div><h2>'+tr('game.s24','Game settings')+'</h2><p class="small">'+tr('game.s25','Changes save as you make them. Prices use Treasury items; set a price to zero to make it free.')+'</p></div><div class="actions"><span class="small">'+tr('game.autosave','Saves automatically.')+'</span></div></div></div>';

  const chatS=settings.chat||{chatDetail:'full',cooldownReply:'reply',rareAnnounceTier:'off',chatCommandReply:'public'};
  const chatField=(id,label,list,val,names)=>'<div class="inline-field"><label for="'+id+'">'+label+'</label><select id="'+id+'">'+list.map(x=>'<option value="'+x+'"'+(x===val?' selected':'')+'>'+names[x]+'</option>').join('')+'</select></div>';
  const chat='<details class="card b-6" open><summary><h2>'+tr('game.s28','Fishing and chat')+'</h2></summary><p class="small">'+tr('game.s29','The cooldown is global. Auto-Fish availability is set here too.')+'</p>'+numeric('cooldown',tr('game.s30','Global !fish cooldown (seconds)'),settings.cooldownSeconds,0,240,1)+toggle('autofish-enabled',tr('game.s31','Allow Auto-Fish for viewers'),!!a.enabled)+'<h3>'+tr('game.s32','Chat messages')+'</h3><p class="small">'+tr('game.s33','These apply to everyone. Viewers still set their own wording.')+'</p><div class="settings-grid">'+chatField('chat-detail',tr('game.s34','Catch reply detail'),['full','short','off'],chatS.chatDetail,{full:tr('game.s35','Full'),short:tr('game.s36','Short (no luck, area or event extras)'),off:tr('game.s37','Off (no catch reply)')})+chatField('cooldown-reply',tr('game.s38','Cooldown reply'),['reply','silent'],chatS.cooldownReply,{reply:tr('game.s39','Reply in chat'),silent:tr('game.s40','Silent')})+chatField('rare-announce',tr('game.s41','Rare catch announcement'),['off','rare','epic','legendary'],chatS.rareAnnounceTier,{off:tr('game.s42','Off'),rare:tr('game.s43','Rare and above'),epic:tr('game.s44','Epic and above'),legendary:tr('game.s45','Legendary and above')})+chatField('chat-command-reply','Chat command reply visibility',['public','whisper'],chatS.chatCommandReply||'public',{public:'Public Twitch chat (default)',whisper:'Private Whisper'})+'</div></details>'; 
  const autoFish='<section class="card b-12"><h2>'+tr('game.s46','Auto-Fish')+'</h2></section>'+groupsHtml;
  const world='<details class="card b-6"><summary><h2>'+tr('game.s47','World features')+'</h2></summary><p class="small">'+tr('game.s48','Disabling a feature hides it for everyone. Player unlocks and progression are kept.')+'</p>'+toggle('areas-enabled',tr('game.s49','Enable fishing areas'),!!w.enabled)+toggle('double-catch-enabled',tr('game.s50','Enable double-catch progression'),!!w.doubleCatchEnabled)+'<div class="tier"><div class="badge">'+tr('game.s51','Individual areas')+'</div>'+areaRows+'</div></details>';
  const prices2='<details class="card b-6"><summary><h2>'+tr('game.s52','Shop, rod, bait and Pond prices')+'</h2></summary><h3>'+tr('game.s53','Shop perks')+'</h3><div class="price-grid">'+priceRows('shop',prices.shop)+'</div><h3>'+tr('game.s54','Fishing rods')+'</h3><div class="price-grid">'+priceRows('rods',prices.rods)+'</div><h3>'+tr('game.s55','Bait')+'</h3><div class="price-grid">'+priceRows('bait',prices.bait)+'</div>'+pondRows+'</details>';
  const areaPrices2='<details class="card b-6"><summary><h2>'+tr('game.s56','Area unlock and upgrade prices')+'</h2></summary><p class="small">'+tr('game.s57','Treasury costs for unlocking each area and upgrading it to levels 2 to 5. The world map uses the same values.')+'</p>'+areaPriceRows+'</details>';

  setView('<div class="bento">'+bar+chat+world+autoFish+prices2+areaPrices2+'</div>',tr('page.game',tr('game.s24','Game settings')));
  const read=id=>document.getElementById(id);
  window.saveGameSettingsNow=async function(quiet){
    const autoFishNext={enabled:read('autofish-enabled').checked};
    for(const group of autoGroups)for(const [key] of group.fields)autoFishNext[key]=Number(read('af-'+key).value);
    const payload={cooldownSeconds:Number(read('cooldown').value),chat:{chatDetail:read('chat-detail').value,cooldownReply:read('cooldown-reply').value,rareAnnounceTier:read('rare-announce').value,chatCommandReply:read('chat-command-reply').value},autoFish:autoFishNext,areas:{enabled:read('areas-enabled').checked,doubleCatchEnabled:read('double-catch-enabled').checked,items:Object.fromEntries((w.items||[]).map(item=>[item.id,read('area-'+item.id).checked]))}};
    try{await call('game-settings',payload);await refreshSettings();renderTab();if(!quiet)notice(tr('game.s58','Game settings saved.'),'good');}catch(e){if(!quiet)notice(e.message,'error');}
  };
  window.savePricesNow=async function(quiet){
    const pricesNext={shop:{},rods:{},bait:{},pond:{}};
    for(const category of ['shop','rods','bait'])for(const id of Object.keys(prices[category]||{}))pricesNext[category][id]=Number(read('price-'+category+'-'+id).value);
    for(const [id,values] of Object.entries(prices.pond||{}))pricesNext.pond[id]=values.map((_,index)=>Number(read('price-pond-'+id+'-'+index).value));
    const areaNext={};
    for(const item of w.items||[]){const entry=areaPrices[item.id]||{};areaNext[item.id]={unlockCost:Number(read('area-unlock-'+item.id).value),levelCosts:(entry.levelCosts||[]).map((_,index)=>Number(read('area-level-'+item.id+'-'+index).value))};}
    try{await call('price-settings',{prices:pricesNext,areaPrices:areaNext});await refreshSettings();renderTab();if(!quiet)notice(tr('game.s59','Shop, Pond and area prices saved.'),'good');}catch(e){if(!quiet)notice(e.message,'error');}
  };
}
function renderTwitch(){
  const bot=settings.bot||{};
  const cfg=settings.twitchConfig||{};
  const connected=!!bot.connected;
  const who=esc(bot.displayName||bot.login||'streamer');

  // Connection: the one thing a streamer needs to check before going live.
  const connection='<div class="card b-8"><div class="row"><div><h2>Streamer Twitch account</h2><p class="small">'
    +(connected?'Signed in as '+who+'. The bot answers chat commands for this channel.':'Connect the streamer account to let the bot answer chat commands.')
    +'</p></div><span class="badge">'+(connected?'CONNECTED':'NOT CONNECTED')+'</span></div>'
    +statusPill(bot.status==='live',bot.status||'disconnected')
    +(bot.lastError?'<p class="notice error">'+esc(bot.lastError)+'</p>':'')
    +'<div class="actions"><button class="btn" id="twitch-reconnect">'+(connected?'Reconnect Twitch':'Connect Twitch')+'</button>'
    +(connected?'<button class="btn danger" id="twitch-disconnect">Disconnect</button>':'')
    +'</div></div>';

  // Build status: whether this copy of Fishingbot can start the sign-in at all.
  const signIn='<div class="card b-4"><h2>Sign-in app</h2><p class="small">The official build includes its own Twitch app for Device Code sign-in. Streamers never enter a client ID.</p>'
    +'<p class="small">Device Code app: '+(bot.deviceCodeConfigured?'<span class="status ok">Ready</span>':'<span class="status bad">Not configured in this build</span>')+'</p></div>';

  // Advanced: legacy website OAuth. Hidden by default, because the bot does not need it.
  const advanced='<details class="card b-12"><summary><h2>Advanced: legacy website OAuth</h2></summary>'
    +'<p class="small">Not needed for bot sign-in or the Extension. Use it only if you separately run the legacy website OAuth flow.</p>'
    +'<p class="small">Legacy Client Secret: '+(cfg.clientSecret==='found'?'<span class="status ok">Saved</span>':'<span class="status warn">Not set</span>')+'</p>'
    +'<form id="twitch-config-form"><div class="field"><label for="twitch-client-secret">Legacy website OAuth Client Secret</label><input id="twitch-client-secret" type="password" maxlength="256" autocomplete="new-password"></div>'
    +'<div class="actions"><button class="btn secondary" type="submit">Save legacy secret</button></div></form>'
    +'<p class="small">Never enter the Extension Secret here. The hosted relay keeps that secret.</p></details>';

  const footer='<p class="small b-12">Settings file: <code>'+esc(cfg.file||'not found')+'</code></p>';

  setView('<div class="bento twitch-view">'+connection+signIn+advanced+footer+'</div>',tr('page.twitch','Twitch bot'));
  document.getElementById('twitch-reconnect').addEventListener('click',reconnect);
  document.getElementById('twitch-disconnect')?.addEventListener('click',disconnect);
  document.getElementById('twitch-config-form').addEventListener('submit',async e=>{
    e.preventDefault();
    try{
      const out=await call('twitch-settings',{clientId:cfg.clientIdValue||'',clientSecret:document.getElementById('twitch-client-secret').value});
      await refreshSettings();renderTab();
      notice(out.started?'Optional Twitch settings saved and the bot reconnected.':'Optional Twitch secret saved.','good');
    }catch(err){notice(err.message,'error');}
  });
}
function renderExtension(){
  const ext=settings.twitchExtension||{};
  const bot=settings.bot||{};
  const ready=!!ext.configured&&!!bot.connected&&!!ext.lastPublishedAt&&!ext.lastError;
  const last=ext.lastPublishedAt?new Date(ext.lastPublishedAt).toLocaleTimeString():'Not yet published';
  const relayText=!ext.configured?'The managed relay URL is not included in this development build yet.':!bot.connected?'Connect the streamer Twitch account to enable publishing.':ext.lastError?'The relay has not accepted the latest snapshot. Check the error below.':'Waiting for the first successful snapshot.';

  // Status first: is the channel publishing, and when did it last succeed.
  const status='<div class="card b-8"><div class="row"><div><h2>Video Component</h2><p class="small">Fishingbot manages the Extension centrally. Its ID and secret are not stored on this PC and are never shown to streamers.</p></div><span class="badge">'+(ready?'READY':'WAITING')+'</span></div>'
    +'<div class="notice '+(ready?'good':'warn')+'">'+(ready?'The streamer account is connected and the relay has accepted a channel snapshot.':relayText)+'</div>'
    +(ext.lastError?'<div class="notice error">'+esc(ext.lastError)+'</div>':'')
    +'<div class="metric-grid"><div class="metric"><span>Relay</span><strong>'+(ext.configured?'<span class="status ok">Configured</span>':'<span class="status warn">Not configured</span>')+'</strong></div><div class="metric"><span>Last published</span><strong>'+esc(last)+'</strong></div></div></div>';

  // What leaves this PC, stated plainly for the streamer.
  const privacy='<div class="card b-4"><h2>What is shared</h2><p class="small">Only public channel totals and the top anglers are sent to the relay. Private inventories, viewer tokens, admin settings and local files are never uploaded.</p><p class="small">The local server listens only on this PC and makes outbound HTTPS requests. It needs no router changes and no inbound ports.</p></div>';

  // One step the streamer must do in Twitch itself.
  const activation='<div class="card b-12"><h2>One-time channel activation</h2><p class="small">Twitch does not let an installer activate an Extension on a channel. The streamer completes these steps once in Twitch:</p><ol class="small"><li>Open the Twitch Creator Dashboard for your channel.</li><li>Open Extensions and find Fishingbot.</li><li>Activate the Fishingbot Video Component on the stream.</li><li>Click the Fishingbot icon in the video taskbar to open the widget.</li></ol><p class="small">After release, streamers need no Extension developer-console access, Extension ID or secret. Hosted test builds stay limited to the developer’s Twitch test allowlist.</p></div>';

  setView('<div class="bento extension-view">'+status+privacy+activation+'</div>',tr('page.extension','Twitch Extension'));
}
// Parsers for viewer import files. Written without backslashes or backticks, because this file
// embeds the browser script in a template literal.
const NL=String.fromCharCode(10),CR=String.fromCharCode(13),TICK=String.fromCharCode(96);
function parseCsvText(text){
  const rows=[];let row=[],field='',inQuotes=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQuotes){
      if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else inQuotes=false;}
      else field+=c;
    }else if(c==='"')inQuotes=true;
    else if(c===',' ){row.push(field);field='';}
    else if(c===CR){}
    else if(c===NL){row.push(field);rows.push(row);row=[];field='';}
    else field+=c;
  }
  if(field.length||row.length){row.push(field);rows.push(row);}
  return rows.filter(r=>r.some(x=>x.trim()!==''));
}
function payloadFromCsv(text){
  const clean=text.charCodeAt(0)===65279?text.slice(1):text;
  const rows=parseCsvText(clean);
  if(rows.length<2)throw new Error('The CSV file needs a header row and at least one data row.');
  const head=rows[0].map(h=>h.trim().toLowerCase());
  const at=(...names)=>{for(const n of names){const p=head.indexOf(n);if(p>=0)return p;}return -1;};
  const keyCol=at('key','k'),valueCol=at('value','v'),expCol=at('expires_at','exp'),indexCol=at('i','index');
  if(keyCol<0||valueCol<0)throw new Error('CSV needs columns "key" and "value" (or "k" and "v").');
  const data={kv:[],kv_list:[]};
  for(const r of rows.slice(1)){
    const key=(r[keyCol]||'').trim();
    if(!key)continue;
    const value=r[valueCol]??'';
    if(indexCol>=0)data.kv_list.push({k:key,i:Number((r[indexCol]||'0').trim()),v:value});
    else{const exp=expCol>=0?(r[expCol]||'').trim():'';data.kv.push({key,value,expires_at:exp===''||exp.toLowerCase()==='null'?null:exp});}
  }
  return data;
}
// Reads simple "INSERT INTO table (cols) VALUES (...), (...);" statements. Handles '' escapes, NULL and comments.
function parseSqlInserts(text){
  const out=[];let i=0;const n=text.length;
  const isSpace=c=>c!==undefined&&c.trim()==='';
  const skipSpace=()=>{while(i<n){if(isSpace(text[i]))i++;else if(text.startsWith('--',i)){while(i<n&&text[i]!==NL)i++;}else if(text.startsWith('/*',i)){const e=text.indexOf('*/',i+2);i=e<0?n:e+2;}else break;}};
  const readName=()=>{if(text[i]==='"'||text[i]===TICK){const q=text[i++];let s='';while(i<n&&text[i]!==q)s+=text[i++];i++;return s;}let s='';while(i<n&&/[A-Za-z0-9_.]/.test(text[i]))s+=text[i++];return s;};
  const readValue=()=>{skipSpace();if(text[i]==="'"){let s='';i++;while(i<n){if(text[i]==="'"){if(text[i+1]==="'"){s+="'";i+=2;continue;}i++;break;}s+=text[i++];}return s;}let s='';while(i<n&&text[i]!==','&&text[i]!==')'&&!isSpace(text[i]))s+=text[i++];return s.toLowerCase()==='null'?null:s;};
  while(i<n){
    skipSpace();
    if(i>=n)break;
    if(text.slice(i,i+11).toLowerCase()!=='insert into'){const semi=text.indexOf(';',i);i=semi<0?n:semi+1;continue;}
    i+=11;skipSpace();
    const table=readName().split('.').pop().toLowerCase();
    skipSpace();
    let columns=null;
    if(text[i]==='('){i++;columns=[];while(i<n&&text[i]!==')'){skipSpace();columns.push(readName().toLowerCase());skipSpace();if(text[i]===',')i++;}i++;}
    skipSpace();
    if(text.slice(i,i+6).toLowerCase()!=='values')throw new Error('Only INSERT ... VALUES statements are supported in SQL imports.');
    i+=6;
    const rows=[];
    while(i<n){
      skipSpace();
      if(text[i]!=='(')break;
      i++;
      const vals=[];
      while(i<n&&text[i]!==')'){vals.push(readValue());skipSpace();if(text[i]===',')i++;}
      i++;rows.push(vals);skipSpace();
      if(text[i]===',')i++;else break;
    }
    out.push({table,columns,rows});
    const semi=text.indexOf(';',i);i=semi<0?n:semi+1;
  }
  return out;
}
function payloadFromSql(text){
  const statements=parseSqlInserts(text);
  if(!statements.length)throw new Error('No INSERT statements found in this SQL file.');
  const data={kv:[],kv_list:[]};
  for(const st of statements){
    const isList=st.table.includes('list');
    const cols=st.columns||(isList?['k','i','v']:['key','value','expires_at']);
    const pos=name=>cols.indexOf(name);
    for(const vals of st.rows){
      const get=(...names)=>{for(const nm of names){const p=pos(nm);if(p>=0)return vals[p];}return undefined;};
      const key=get('key','k');
      if(key==null||key==='')continue;
      if(isList||pos('i')>=0||pos('index')>=0)data.kv_list.push({k:String(key),i:Number(get('i','index')??0),v:String(get('v','value')??'')});
      else{const value=get('value','v');data.kv.push({key:String(key),value:value==null?'':String(value),expires_at:get('expires_at','exp')??null});}
    }
  }
  return data;
}
// Picks the parser by file extension. JSON is parsed as before.
async function readViewerImportFile(file){
  const name=file.name.toLowerCase();
  const text=await file.text();
  if(name.endsWith('.csv'))return payloadFromCsv(text);
  if(name.endsWith('.sql'))return payloadFromSql(text);
  return JSON.parse(text);
}
const PERK_CHOICES=[['luck125','1.25x Luck','Permanent luck boost.'],['cooldown','15% cooldown reduction','Shorter wait between casts.'],['treasuryLuck','1.5x Treasury luck','Better odds for Treasury catches.'],['treasuryOnly','Treasury only mode','Unlocked and switched off, as after the normal milestone.'],['fishermansFortune',"Fisherman’s Fortune",'Permanent fishing bonus.']];
const INV_RARITY={unique:'#dd705f',godly:'#e4572e',legendary:'#c9a227',epic:'#a77bd1',rare:'#5b9bd5',uncommon:'#46a07b',common:'#8f8a80',treasury:'#d6aa4b',secret:'#dd705f',unmatched:'#c25b5b'};
let vtState=null;
let vtInv={login:'',items:[]};
let vtPendingImport=null;
// Inventory strings look like "Koi [RARE]". The name is matched without case,
// accents or spacing, so an exact-match miss no longer falls back to Common.
// When the name is not in the catalogue, the [RARITY] suffix decides the label
// and the item is marked as unmatched so it can be checked.
function normName(v){return String(v??'').normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'').replace(/[\\u2018\\u2019]/g,\"'\").replace(/\\s+/g,' ').trim().toLowerCase();}
function parseInvItem(raw){const text=String(raw??'').trim();const m=text.match(/^(.*?)\\s*[\\[(]([^\\[\\]()]+)[\\])]\\s*$/);const label=m?m[2].trim().toLowerCase():'';const suffix=m&&settings.tiers.find(t=>t.id===label||String(t.name).toLowerCase()===label);return suffix?{name:m[1].trim(),suffixId:suffix.id}:{name:text,suffixId:''};}
function invRarity(raw){const parsed=parseInvItem(raw);const want=normName(parsed.name);const byName=settings.tiers.find(t=>(t.items||[]).some(i=>normName(i)===want));if(byName)return byName.id;return parsed.suffixId||'unmatched';}
function baseFishName(item){const text=String(item||'');const at=text.indexOf(' [');return (at>0?text.slice(0,at):text).trim();}
function viewerLogin(){const v=(document.getElementById('vt-login')?.value||'').trim().replace(/^@+/,'').toLowerCase();if(!/^[a-z0-9_]{1,25}$/.test(v))throw new Error('Enter a valid Twitch login (letters, numbers and underscores).');return v;}
async function guard(task){try{await task();}catch(e){notice(e.message,'error');}}
function lootOptions(){return settings.tiers.map(t=>'<optgroup label="'+esc(t.name)+'">'+t.items.map(i=>'<option value="'+esc(i)+'">'+esc(i)+'</option>').join('')+'</optgroup>').join('');}
function vtChips(s){return '<span class="chip-static">'+s.fishInInventory+' fish</span><span class="chip-static'+(s.autoFishLicense?' on':'')+'">Auto-Fish '+(s.autoFishLicense?'licensed':'off')+'</span><span class="chip-static'+(s.pondUnlocked?' on':'')+'">Pond '+(s.pondUnlocked?'unlocked':'locked')+'</span>';}
function showViewerGate(){
  vtState=null;vtInv={login:'',items:[]};vtPendingImport=null;
  const gate=document.getElementById('vt-gate');if(gate)gate.classList.remove('hidden');
  const body=document.getElementById('vt-body');if(body)body.innerHTML='';
  const input=document.getElementById('vt-login');if(input){input.value='';input.focus();}
}
function renderViewer(){
  setView('<div class="vt">'
    +'<section class="card" id="vt-gate"><h2>Viewer login</h2>'
    +'<form id="vt-form" class="vt-pick-row"><input id="vt-login" maxlength="25" placeholder="twitch_login" autocomplete="off" aria-label="Viewer Twitch login"><button class="btn primary" id="vt-open" type="submit">Open viewer</button></form></section>'
    +'<div id="vt-body"></div></div>',tr('page.viewer','Viewers'));
  document.getElementById('vt-form').addEventListener('submit',e=>{e.preventDefault();openViewer();});
  if(vtState){document.getElementById('vt-gate').classList.add('hidden');renderViewerBody();}
}
async function openViewer(){
  let login;try{login=viewerLogin();}catch(e){notice(e.message,'error');return;}
  const button=document.getElementById('vt-open');if(button)button.disabled=true;
  try{
    vtState=await call('viewer-tools?login='+encodeURIComponent(login));
    vtInv={login:'',items:[]};
    document.getElementById('vt-gate').classList.add('hidden');
    renderViewerBody();
    await loadViewerInventory(login);
    notice('Viewer @'+login+' is selected.','good');
  }catch(e){notice(e.message,'error');}
  finally{if(button)button.disabled=false;}
}
async function refreshViewer(){
  if(!vtState)return;
  const login=vtState.user;
  vtState=await call('viewer-tools?login='+encodeURIComponent(login));
  renderViewerBody();
  await loadViewerInventory(login);
}
function applyViewerState(s){vtState=s;const chips=document.getElementById('vt-chips');if(chips)chips.innerHTML=vtChips(s);}
async function vtAct(body){
  const result=await call('viewer-tools',Object.assign({login:vtState.user},body));
  applyViewerState(result);
  notice(result.message,'good');
  return result;
}
function bindSwitch(el,body){
  el.addEventListener('change',async()=>{
    const wanted=el.checked;
    try{await vtAct(Object.assign({},body,{enabled:wanted}));}
    catch(e){el.checked=!wanted;notice(e.message,'error');}
  });
}
function importPreviewHtml(p){
  const sk=p.skipped||{};
  const total=p.importedKv+p.importedListRows;
  if(!total)return '<div class="notice warn">Nothing in this file belongs to @'+esc(p.login)+', so there is nothing to import.</div>';
  return '<div class="notice good">Ready to import into @'+esc(p.login)+': '+p.importedKv+' settings rows and '+p.importedListRows+' inventory or mail items.</div>'
    +importCheckHtml(p.itemCheck)
    +'<p class="small">Skipped: '+(sk.notThisViewer||0)+' rows for other viewers or global keys, '+(sk.expired||0)+' expired, '+(sk.invalid||0)+' without a key or value.</p>';
}
// Shows how the inventory names in the file match the current catalogue.
// Unknown names and rarity labels that disagree are listed with close matches.
function importCheckHtml(c){
  if(!c||!c.total)return '';
  const rows=[];
  const tierName=id=>{const t=settings.tiers.find(x=>x.id===id);return t?t.name:String(id).toUpperCase();};
  const summary=Object.entries(c.byRarity||{}).sort((a,b)=>b[1]-a[1]).map(([id,n])=>'<span class="chip-static">'+esc(id==='unmatched'?'Unmatched':tierName(id))+' · '+n+'</span>').join('');
  if(c.unknownCount)rows.push('<div class="notice warn">'+c.unknownCount+' of '+c.total+' inventory items are not in the current loot table. Check the names below before importing.</div>');
  if(c.mismatchCount)rows.push('<div class="notice warn">'+c.mismatchCount+' items are labelled with a different rarity than the loot table uses. The loot table is used for display.</div>');
  const list=(c.unknown||[]).slice(0,20).map(u=>'<li><code>'+esc(u.item)+'</code>'+(u.suggestions&&u.suggestions.length?' <span class="small">Did you mean '+u.suggestions.map(s=>esc(s.name)+' ('+esc(s.tierName)+')').join(', ')+'?</span>':' <span class="small">No close match.</span>')+'</li>').join('');
  const mismatch=(c.mismatched||[]).slice(0,10).map(m=>'<li><code>'+esc(m.item)+'</code> <span class="small">file says '+esc(m.claimedRarity)+', catalogue says '+esc(m.catalogueRarity)+'</span></li>').join('');
  return rows.join('')
    +'<div class="loot-import-check"><div class="small">Inventory check · '+c.matched+' matched of '+c.total+'</div><div class="chips">'+summary+'</div>'
    +(list?'<ul class="loot-import-list">'+list+'</ul>':'')
    +(mismatch?'<ul class="loot-import-list">'+mismatch+'</ul>':'')
    +'</div>';
}
function setImportEnabled(on){const b=document.getElementById('vt-import');if(b)b.disabled=!on;}
function renderViewerBody(){
  const s=vtState;if(!s)return;
  const perks=s.perks||{};
  const body=document.getElementById('vt-body');
  const sw=(attrs,title,desc,on)=>'<label class="switch-row"><span class="switch-text"><strong>'+title+'</strong><span class="small">'+desc+'</span></span><input type="checkbox" class="switch" '+attrs+(on?' checked':'')+'></label>';
  const areaRows=s.areas.map(a=>'<div class="area-row"><span class="area-name">'+esc(a.name)+'</span><input type="number" min="0" max="5" step="1" value="'+a.level+'" data-vt-area="'+esc(a.id)+'" aria-label="'+esc(a.name)+' level"></div>').join('');
  const backup='<p class="small">Export this viewer’s records as JSON, or import a file. Imports only write records that belong to this viewer. Global settings, admin data and other viewers are skipped.</p>'
    +'<div class="actions"><button class="btn secondary" type="button" id="vt-export">Export JSON</button></div>'
    +'<div class="divider"></div>'
    +'<div class="field"><label for="vt-import-file">Import a file (JSON, CSV or SQL)</label><input id="vt-import-file" type="file" accept=".json,.csv,.sql,application/json,text/csv,application/sql"></div>'
    +'<div id="vt-import-preview"></div>'
    +'<div class="actions"><button class="btn" type="button" id="vt-import" disabled>Import into @'+esc(s.user)+'</button></div>'
    +'<p class="small">Back up data/fishing.sqlite before a large import. Each import runs in one transaction.</p>';
  body.innerHTML='<section class="card vt-head b-12"><div><div class="vt-name">@'+esc(s.user)+'</div><div class="vt-chips" id="vt-chips">'+vtChips(s)+'</div></div><div class="actions"><button class="btn secondary" id="vt-change" type="button">Change viewer</button></div></section>'
    +'<div class="vt-grid bento">'
    +'<section class="card b-8"><h2>Inventory</h2><p class="small">What this viewer holds. Tick fish to delete them, then choose how many copies.</p><div id="vt-inventory"><p class="small">Loading inventory…</p></div></section>'
    +'<section class="card b-4"><h2>Give a fish</h2>'
      +'<div class="field"><label for="vt-give-fish">Fish from the loot table</label><select id="vt-give-fish">'+lootOptions()+'</select></div>'
      +'<div class="field"><label for="vt-give-qty">Quantity</label><input type="number" id="vt-give-qty" min="1" max="99" step="1" value="1"></div>'
      +'<div class="actions"><button class="btn" type="button" id="vt-give">Give fish</button></div>'
      +'<div class="divider"></div>'
      +'<h2>Remove a fish</h2>'
      +'<div class="field"><label for="vt-remove-fish">Fish they own</label><select id="vt-remove-fish"><option value="">Loading…</option></select></div>'
      +'<div class="field"><label for="vt-remove-qty">Quantity</label><input type="number" id="vt-remove-qty" min="1" max="99" step="1" value="1"></div>'
      +'<div class="actions"><button class="btn secondary" type="button" id="vt-remove">Remove fish</button></div>'
    +'</section>'
    +'<section class="card b-4"><h2>Access and perks</h2><p class="small">Each switch applies as soon as you change it. Perks are granted without charging points.</p>'
      +sw('data-vt-switch="autofish-license"','Auto-Fish license','Lets this viewer use Auto-Fish.',s.autoFishLicense)
      +sw('data-vt-switch="pond"','Personal Pond','Unlocks the Personal Pond.',s.pondUnlocked)
      +'<div class="divider"></div>'
      +PERK_CHOICES.map(([id,title,desc])=>sw('data-vt-perk="'+id+'"',esc(title),esc(desc),!!perks[id])).join('')
    +'</section>'
    +'<section class="card b-8"><h2>Fishing areas</h2><p class="small">Set the level from 0 (locked) to 5. The change applies when you release the slider.</p>'+areaRows+'</section>'
    +'<section class="card b-6"><h2>Backup and import</h2>'+backup+'</section>'
    +'<section class="card b-6"><h2>Advanced</h2><p class="small">Lists the stored keys for this viewer with short previews. Credentials and sessions are hidden.</p><div class="actions"><button class="btn secondary" type="button" id="vt-debug">Show stored keys</button></div><div id="vt-debug-out"></div></section>'
    +'<section class="card danger-card b-12"><h2>Wipe viewer data</h2><p class="small">Permanently deletes catches, progress, areas, Auto-Fish, Pond and shop data for this viewer. Type the login to confirm.</p><div class="field"><label for="vt-wipe-confirm">Type @'+esc(s.user)+' to confirm</label><input id="vt-wipe-confirm" maxlength="26" autocomplete="off"></div><div class="actions"><button class="btn danger" type="button" id="vt-wipe">Wipe data</button></div></section>'
    +'</div>';
  bindViewerControls();
}
function bindViewerControls(){
  
  document.getElementById('vt-change')?.addEventListener('click',showViewerGate);
  document.getElementById('vt-give')?.addEventListener('click',()=>guard(async()=>{
    const fish=document.getElementById('vt-give-fish').value;
    const quantity=Number(document.getElementById('vt-give-qty').value);
    await vtAct({action:'give-fish',fish:fish,quantity:quantity});
    await loadViewerInventory(vtState.user);
  }));
  document.getElementById('vt-remove')?.addEventListener('click',()=>guard(async()=>{
    const fish=document.getElementById('vt-remove-fish').value;
    if(!fish)throw new Error('Choose a fish they own.');
    const quantity=Number(document.getElementById('vt-remove-qty').value);
    if(!confirm('Remove up to '+quantity+' × '+fish+' from @'+vtState.user+'?'))return;
    await vtAct({action:'remove-fish',fish:fish,quantity:quantity});
    await loadViewerInventory(vtState.user);
  }));
  document.querySelectorAll('[data-vt-switch]').forEach(el=>bindSwitch(el,{action:el.dataset.vtSwitch}));
  document.querySelectorAll('[data-vt-perk]').forEach(el=>bindSwitch(el,{action:'shop-perk',perk:el.dataset.vtPerk}));
  document.querySelectorAll('[data-vt-area]').forEach(el=>el.addEventListener('change',()=>guard(()=>vtAct({action:'area',areaId:el.dataset.vtArea,level:Number(el.value)}))));
  document.getElementById('vt-export')?.addEventListener('click',()=>{location.href='/local/admin/viewer-data?login='+encodeURIComponent(vtState.user);});
  document.getElementById('vt-import-file')?.addEventListener('change',async e=>{
    vtPendingImport=null;setImportEnabled(false);
    const preview=document.getElementById('vt-import-preview');
    const file=e.target.files&&e.target.files[0];
    if(!file){preview.innerHTML='';return;}
    if(file.size>20*1024*1024){notice('Choose a file smaller than 20 MB.','error');e.target.value='';preview.innerHTML='';return;}
    try{
      const data=await readViewerImportFile(file);
      const result=await call('viewer-data-import',{login:vtState.user,data:data,dryRun:true});
      vtPendingImport=(result.importedKv+result.importedListRows)>0?data:null;
      preview.innerHTML=importPreviewHtml(result);
      setImportEnabled(!!vtPendingImport);
    }catch(err){preview.innerHTML='';notice('Could not read this file: '+err.message,'error');}
  });
  document.getElementById('vt-import')?.addEventListener('click',()=>guard(async()=>{
    if(!vtPendingImport)return;
    if(!confirm('Import this file into @'+vtState.user+'? Matching records will be replaced. Back up the database first.'))return;
    const result=await call('viewer-data-import',{login:vtState.user,data:vtPendingImport});
    notice('Imported '+result.importedKv+' settings rows and '+result.importedListRows+' inventory or mail items into @'+result.login+'.','good');
    vtPendingImport=null;
    document.getElementById('vt-import-file').value='';
    document.getElementById('vt-import-preview').innerHTML='';
    await refreshViewer();
  }));
  document.getElementById('vt-debug')?.addEventListener('click',()=>guard(async()=>{
    const r=await call('viewer-debug?login='+encodeURIComponent(vtState.user));
    const out=document.getElementById('vt-debug-out');
    out.innerHTML=(r.rows.length?r.rows.map(x=>'<div class="dbg-row"><code>'+esc(x.key)+'</code><span class="small">'+x.kind+' · '+x.size+'</span><span class="small dbg-prev">'+esc(x.preview)+'</span></div>').join(''):'<p class="small">No stored keys for this viewer.</p>')+(r.truncated?'<p class="small">Showing the first 200 keys.</p>':'');
  }));
  document.getElementById('vt-wipe')?.addEventListener('click',()=>guard(async()=>{
    const typed=(document.getElementById('vt-wipe-confirm').value||'').trim().replace(/^@+/,'').toLowerCase();
    if(typed!==vtState.user)throw new Error('Type the viewer login to confirm wiping their data.');
    if(!confirm('Permanently delete all Fishingbot data for @'+vtState.user+'? This cannot be undone.'))return;
    const result=await vtAct({action:'wipe',confirm:typed});
    notice(result.message,'good');
    showViewerGate();
  }));
  setImportEnabled(false);
  if(vtInv.items&&vtInv.login===vtState.user)renderViewerInventory();
}
async function loadViewerInventory(login){
  const r=await call('broadcaster',{action:'get-inventory',targetUser:login});
  vtInv={login:r.targetUser||login,items:r.items||[]};
  renderViewerInventory();
}
function renderViewerInventory(){
  const box=document.getElementById('vt-inventory');if(!box)return;
  box.innerHTML=invPanelHtml(vtInv.items,vtInv.login);
  bindInventoryPanel(box,vtInv.login,()=>loadViewerInventory(vtInv.login));
  const removeSelect=document.getElementById('vt-remove-fish');
  if(removeSelect){
    removeSelect.onchange=syncRemoveLimit;
    const counts=new Map();
    for(const name of vtInv.items){const base=baseFishName(name);counts.set(base,(counts.get(base)||0)+1);}
    const entries=[...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
    removeSelect.innerHTML=entries.length?entries.map(([n,c])=>'<option value="'+esc(n)+'">'+esc(n)+' × '+c+'</option>').join(''):'<option value="">Nothing to remove</option>';
  }
  syncRemoveLimit();
}
// The remove quantity can never exceed the copies the viewer owns (or 99).
function syncRemoveLimit(){
  const sel=document.getElementById('vt-remove-fish');const q=document.getElementById('vt-remove-qty');
  if(!sel||!q)return;
  const owned=(vtInv.items||[]).filter(n=>baseFishName(n)===sel.value).length;
  setNumberLimit(q,Math.max(1,Math.min(99,owned)));
}


function renderBroadcaster(){setView('<div id="bc-root"><div class="card"><h2>Broadcaster tools</h2><p class="small">Loading…</p></div></div>',tr('page.broadcaster','Broadcaster'));loadBroadcaster();}
async function loadBroadcaster(){try{drawBroadcaster(await call('broadcaster'));}catch(e){const root=document.getElementById('bc-root');if(root)root.innerHTML='<div class="card"><h2>Broadcaster tools</h2><div class="notice error">'+esc(e.message)+'</div></div>';}}
const OV_STYLES=['card','pill','banner','ticket','playful','glass','tag','terminal'];
const OV_ANIMS=['slide','fade','pop'];
const OV_FONTS=['display','body','mono','serif'];
const OV_LUCK=['bar','fade','pill','ticket','playful','glass','ribbon','terminal'];
const OV_SOUNDS=['chime','bell','pop','coin','harp'];
const OV_TIERS=['common','uncommon','rare','epic','legendary','godly'];
const OV_ALIGN=['left','center','right'];
const BC_TABS=[['stream','Stream'],['overlay','Overlay'],['upgrades','Upgrades']];
let bcTab='stream';
function bcOverlayFormHtml(ov,link,tierOpts,hideOn){
 const sel=(id,label,list,val)=>'<div class="field"><label for="'+id+'">'+label+'</label><select id="'+id+'">'+list.map(x=>'<option value="'+x+'"'+(x===val?' selected':'')+'>'+x+'</option>').join('')+'</select></div>';
 const num=(id,label,min,max,val)=>'<div class="field"><label for="'+id+'">'+label+' ('+min+'–'+max+')</label><input type="number" id="'+id+'" min="'+min+'" max="'+max+'" step="1" value="'+Number(val)+'"></div>';
 const col=(id,label,val)=>'<div class="field"><label for="'+id+'">'+label+'</label><input type="color" id="'+id+'" value="'+(/^#[0-9a-fA-F]{6}$/.test(val||'')?val:'#f5b942')+'"></div>';
 const cb=(id,label,on)=>'<label class="switch-row"><span class="switch-text"><strong>'+label+'</strong></span><input type="checkbox" class="switch" id="'+id+'"'+(on?' checked':'')+'></label>';
 const card=(title,desc,body)=>'<section class="card bc-card"><h2>'+title+'</h2>'+(desc?'<p class="small">'+desc+'</p>':'')+body+'</section>';
 return card('Overlay link','Add this link to OBS as a browser source. Rotate it if it leaks.','<div class="share-url">'+esc(link)+'</div><div class="actions"><a class="btn secondary" href="'+esc(link)+'" target="_blank" rel="noopener">Open overlay</a><button class="btn secondary" data-bc="rotate">Rotate link</button></div>')
  +card('Alerts','Shown when a catch is announced on stream.',cb('ov-enabled','Overlay enabled',ov.enabled)+cb('ov-sound','Play alert sound',ov.sound)+'<div class="settings-grid">'+sel('ov-tier','Minimum tier',OV_TIERS,ov.minTier)+sel('ov-sound-id','Sound',OV_SOUNDS,ov.soundId)+num('ov-volume','Sound volume %',0,100,ov.soundVolume)+num('ov-secs','Alert seconds',3,30,ov.alertSeconds)+'</div>')
  +card('Look','Style, colour, position and text size of the alert.','<div class="settings-grid">'+sel('ov-style','Alert style',OV_STYLES,ov.style)+sel('ov-anim','Animation',OV_ANIMS,ov.animation)+sel('ov-font','Font',OV_FONTS,ov.font)+col('ov-accent','Accent colour',ov.accent)+sel('ov-pos','Position',['top','bottom'],ov.position)+sel('ov-align','Alert alignment',OV_ALIGN,ov.alertHorizontalPosition)+num('ov-text','Text size %',60,180,ov.alertTextScale)+num('ov-size','Box size %',60,180,ov.alertSize)+'</div>'+cb('ov-rarity','Rarity colours',ov.rarityColors)+cb('ov-showtier','Show tier name',ov.showTier)+cb('ov-upper','Uppercase alert text',ov.alertUpper))
  +card('Luck banner','Shown while a luck event is running.',cb('ov-luckbanner','Show luck banner during events',ov.luckBanner)+cb('ov-lucktimer','Show timer on banner',ov.luckTimer)+'<div class="settings-grid">'+sel('ov-luckstyle','Banner style',OV_LUCK,ov.luckStyle)+col('ov-luckaccent','Banner colour',ov.luckAccent)+sel('ov-luckpos','Banner position',['top','bottom'],ov.luckPosition)+sel('ov-luckalign','Banner alignment',OV_ALIGN,ov.luckHorizontalPosition)+num('ov-luckscale','Banner size %',60,160,ov.luckScale)+'</div><div class="field"><label for="ov-lucktpl">Banner text (use {name}, {multiplier}, {time})</label><input id="ov-lucktpl" maxlength="100" value="'+esc(ov.luckTemplate||'')+'"></div>')
  +card('Points bar and extra alerts','',cb('ov-pointsbar','Show channel points bar',ov.pointsBar)+'<div class="settings-grid">'+sel('ov-pbgoal','Points bar goal',['luck','rarity','lucky-chat'],ov.pointsBarGoal)+col('ov-pbcolor','Points bar colour',ov.pointsBarColor)+'</div>'+cb('ov-pbauto','Use the banner colour for the points bar',!ov.pointsBarColor)+cb('ov-newfish','Alert new fish discoveries',ov.newFishAlert)+cb('ov-stats','Include viewer stats in alerts',ov.alertStats)+cb('ov-community','Include community totals in alerts',ov.alertCommunity))
  +card('Test and chat','Send a test alert to the overlay, or hide the !fish replies in chat.','<div class="field"><label for="bc-test-tier">Test alert rarity</label><select id="bc-test-tier">'+tierOpts+'</select></div><div class="actions"><p class="small bc-ov-status" id="bc-ov-status" aria-live="polite">Changes save automatically.</p><button class="btn secondary" data-bc="test">Send test alert</button><button class="btn secondary" data-bc="hide-chat" data-on="'+(!hideOn)+'">'+(hideOn?'Show !fish replies':'Hide !fish replies')+'</button></div>');
}
function bcOverlayValues(){
 const v=id=>document.getElementById(id);
 const c=id=>!!(v(id)&&v(id).checked);
 const t=id=>v(id)?v(id).value:'';
 return {enabled:c('ov-enabled'),sound:c('ov-sound'),minTier:t('ov-tier'),soundId:t('ov-sound-id'),soundVolume:Number(t('ov-volume')),alertSeconds:Number(t('ov-secs')),
  style:t('ov-style'),animation:t('ov-anim'),font:t('ov-font'),accent:t('ov-accent'),position:t('ov-pos'),alertHorizontalPosition:t('ov-align'),alertTextScale:Number(t('ov-text')),alertSize:Number(t('ov-size')),
  rarityColors:c('ov-rarity'),showTier:c('ov-showtier'),alertUpper:c('ov-upper'),
  luckBanner:c('ov-luckbanner'),luckStyle:t('ov-luckstyle'),luckAccent:t('ov-luckaccent'),luckPosition:t('ov-luckpos'),luckHorizontalPosition:t('ov-luckalign'),luckScale:Number(t('ov-luckscale')),luckTimer:c('ov-lucktimer'),luckTemplate:t('ov-lucktpl'),
  pointsBar:c('ov-pointsbar'),pointsBarGoal:t('ov-pbgoal'),pointsBarColor:c('ov-pbauto')?'':t('ov-pbcolor'),
  newFishAlert:c('ov-newfish'),alertStats:c('ov-stats'),alertCommunity:c('ov-community')};
}
// Approximate stand-in for the OBS overlay: it reflects the current form values. OBS shows the real
// animation and sound.
// Preview of the OBS overlay. It uses the same renderer and stylesheet as the overlay page, so the
// look here is the look on stream. Sample data only; the real values come from the game.

function updateOverlayPreview(){
  const top=document.getElementById('bc-pv-top');const bottom=document.getElementById('bc-pv-bottom');
  if(!top||!bottom||!window.OverlayRender)return;
  const R=window.OverlayRender;
  const look=bcOverlayValues();
  look.alertAlign=look.alertHorizontalPosition;
  look.luckAlign=look.luckHorizontalPosition;
  const tierId=bcVal('bc-test-tier')||look.minTier||'epic';
  const tierName=tierId.charAt(0).toUpperCase()+tierId.slice(1);
  const stats=[];
  if(look.alertStats)stats.push('Luck 2.5x · weight 1.2x');
  if(look.alertCommunity)stats.push('1,240 community catches');
  top.innerHTML='';bottom.innerHTML='';
  const alertZone=look.position==='bottom'?bottom:top;
  const card=R.build(look,{user:'viewer',fish:'Golden Koi',rarity:tierName,tierId:tierId,stats:stats.join(' · '),community:1240});
  alertZone.appendChild(card);
  R.enter(card,look.animation,undefined,look.alertHorizontalPosition);
  if(look.luckBanner||look.pointsBar){
    const luck=document.createElement('div');
    const luckZone=look.luckPosition==='bottom'?bottom:top;
    R.paintLuck(luck,Object.assign({},look,{accent:look.luckAccent}),{showText:!!look.luckBanner,name:'Golden Hour',multiplier:'2',time:look.luckTimer?R.countdown(299000):'',points:{pct:0.62,name:'Luck',available:62,cost:100,level:1,maxed:false}});
    luckZone.insertBefore(luck,luckZone.firstChild);
    R.enter(luck,"fade",600,look.luckAlign);
  }
}


function bcSelectTab(id){
 bcTab=id;
 document.querySelectorAll('[data-bc-tab]').forEach(b=>b.classList.toggle('active',b.dataset.bcTab===id));
 document.querySelectorAll('[data-pane]').forEach(p=>{p.hidden=p.dataset.pane!==id;});
 if(id==='overlay')updateOverlayPreview();
}
// Overlay settings save by themselves: one save shortly after the last change.
let bcSaveTimer=null;
function setOverlaySaveStatus(text,bad){const el=document.getElementById('bc-ov-status');if(!el)return;el.textContent=text;el.classList.toggle('is-bad',!!bad);}
function scheduleOverlaySave(){clearTimeout(bcSaveTimer);setOverlaySaveStatus('Saving…');bcSaveTimer=setTimeout(saveOverlayNow,400);}
async function saveOverlayNow(){
 bcSaveTimer=null;
 try{await call('broadcaster',{action:'set-overlay',settings:bcOverlayValues()});setOverlaySaveStatus('Saved. Changes apply to the overlay straight away.');}
 catch(e){setOverlaySaveStatus('Not saved: '+e.message,true);}
}
function bcVal(id){const el=document.getElementById(id);return el?el.value:'';}
function bcChecked(id){const el=document.getElementById(id);return !!(el&&el.checked);}

function drawBroadcaster(s){
 const root=document.getElementById('bc-root');if(!root)return;
 const p=s.progress||{};const ev=s.channelEvent||{};const g=s.globalEvent||{};const ov=s.overlay||{};
 const link=location.origin+'/overlay.html?channel='+encodeURIComponent(s.channel)+'&key='+encodeURIComponent(s.overlayKey||'');
 const upgrades=(p.upgrades||[]).map(u=>{const next=(u.nextCost===null||u.nextCost===undefined)?'MAX':(u.nextCost+' pts');const current=u.level>0?((u.values||[])[u.level-1]||''):'';return '<section class="card bc-card b-4 bc-tile"><div class="bc-row"><div><strong>'+esc(u.name)+'</strong> <span class="badge">LEVEL '+u.level+' / '+u.maxLevel+'</span><div class="small">'+esc(u.description)+(current?' · current '+esc(current):'')+'</div></div><button class="btn '+(u.affordable?'primary':'secondary')+'" data-bc="buy" data-id="'+esc(u.id)+'"'+(u.affordable?'':' disabled')+'>Buy · '+esc(next)+'</button></div></section>';}).join('');
 const tiers=['common','uncommon','rare','epic','legendary','godly'];
 const tierOpts=tiers.map(t=>'<option value="'+t+'"'+(ov.minTier===t?' selected':'')+'>'+t.toUpperCase()+'</option>').join('');
 const eventBox=ev.active
   ?'<p class="notice good">Active: '+esc(ev.name||'Channel event')+' · '+ev.multiplier+'x'+(ev.expiresAt?' · ends '+esc(new Date(ev.expiresAt).toLocaleString()):' · until ended')+'</p><button class="btn danger" data-bc="event-end">End event</button>'
   :'<div class="field"><label for="bc-ev-mult">Luck multiplier (1–5)</label><input id="bc-ev-mult" type="number" min="1" max="5" step="0.5" value="2"></div><div class="field"><label for="bc-ev-name">Event name</label><input id="bc-ev-name" maxlength="80" value="Channel Luck Event"></div><div class="field"><label for="bc-ev-min">Duration in minutes (0 = until ended)</label><input id="bc-ev-min" type="number" min="0" max="43200" step="1" value="30"></div><button class="btn primary" data-bc="event-start">Start event</button>';
 const streamPane='<div class="bento">'
   +'<section class="card bc-card b-4"><h2>Simple chat</h2><p class="small">Shorter fish messages in chat. Currently <strong>'+(s.simpleChat?'ON':'OFF')+'</strong>.</p><div class="actions"><button class="btn" data-bc="simple" data-on="'+(!s.simpleChat)+'">'+(s.simpleChat?'Turn off':'Turn on')+'</button></div></section>'
   +'<section class="card bc-card b-8"><h2>Channel luck event</h2>'+eventBox+'</section>'
   +'</div>';
 const upgradesPane='<div class="bento"><section class="card bc-card b-12"><h2>Channel upgrades</h2><p class="small">Spend channel points on upgrades for your chat.</p></section>'+(upgrades||'<section class="card bc-card b-12"><p class="small">No upgrades available.</p></section>')+'</div>';
 const hidden=id=>id===bcTab?'':' hidden';
 root.innerHTML=
   '<div class="bento"><div class="card bc-head b-12"><div class="row"><div><h2>Broadcaster · '+esc(s.channel)+'</h2><p class="small">Your connected channel, managed from this PC. No broadcaster website sign-in is needed.</p></div><span class="badge">Local owner</span></div>'
   +'<div class="metric-grid"><div class="metric"><span>Points available</span><strong>'+(p.available??0)+'</strong></div><div class="metric"><span>Points spent</span><strong>'+(p.spent??0)+'</strong></div><div class="metric"><span>Catches</span><strong>'+(p.catches??0)+'</strong></div><div class="metric"><span>Global event</span><strong style="font-size:13px">'+(g.active?esc(g.name||'Active')+' · '+g.multiplier+'x':'None')+'</strong></div></div></div>'
   +'<nav class="bc-tabs b-12" role="tablist">'+BC_TABS.map(([id,label])=>'<button type="button" role="tab" class="bc-tab'+(id===bcTab?' active':'')+'" data-bc-tab="'+id+'">'+label+'</button>').join('')+'</nav>'
   +'<section class="bc-pane b-12" data-pane="stream"'+hidden('stream')+'>'+streamPane+'</section>'
   +'<section class="bc-pane b-12" data-pane="overlay"'+hidden('overlay')+'><div class="bento"><div class="bc-ov-form b-8" id="bc-ov-form">'+bcOverlayFormHtml(ov,link,tierOpts,!!s.hideFishChat)+'</div><aside class="bc-ov-preview b-4"><div class="eyebrow">Live preview</div><div id="bc-ov-preview" class="ov-preview-stage"><div id="bc-pv-top"></div><div id="bc-pv-bottom"></div></div><p class="small pv-note">Same renderer and stylesheet as the OBS overlay, with sample data. OBS plays the sound.</p></aside></div></section>'
   +'<section class="bc-pane b-12" data-pane="upgrades"'+hidden('upgrades')+'>'+upgradesPane+'</section></div>';
 root.querySelectorAll('[data-bc]').forEach(b=>b.addEventListener('click',()=>bcHandle(b)));
 root.querySelectorAll('[data-bc-tab]').forEach(b=>b.addEventListener('click',()=>bcSelectTab(b.dataset.bcTab)));
 const form=document.getElementById('bc-ov-form');
 form.addEventListener('input',updateOverlayPreview);
 form.addEventListener('change',updateOverlayPreview);
 form.addEventListener('change',scheduleOverlaySave);
 updateOverlayPreview();
}
async function bcHandle(b){
 const k=b.dataset.bc;let body=null;
 if(k==='simple')body={action:'set-simple-chat',enabled:b.dataset.on==='true'};
 else if(k==='event-start')body={action:'start-channel-event',multiplier:Number(bcVal('bc-ev-mult')),eventName:bcVal('bc-ev-name'),durationSeconds:Math.round((Number(bcVal('bc-ev-min'))||0)*60)};
 else if(k==='event-end')body={action:'end-channel-event'};
 else if(k==='buy')body={action:'buy-channel-upgrade',upgrade:b.dataset.id};
 else if(k==='overlay-save')body={action:'set-overlay',settings:bcOverlayValues()};
 else if(k==='hide-chat')body={action:'set-hide-fish-chat',enabled:b.dataset.on==='true'};
 else if(k==='rotate'){if(!confirm('Rotate the overlay link? The old link will stop working.'))return;body={action:'overlay-rotate-key'};}
 else if(k==='test')body={action:'overlay-test',tierId:bcVal('bc-test-tier'),preview:bcOverlayValues()};
 if(!body)return;
 b.disabled=true;
 try{const r=await call('broadcaster',body);notice(r.message||'Saved.','good');}catch(e){notice(e.message,'error');}
 finally{b.disabled=false;}
 await loadBroadcaster();
}

// One inventory list for the viewer tools and the broadcaster tab: searchable, scrollable,
// with a per-fish copies slider. Used by both places so they behave the same way.
function invPanelHtml(items,login){
  const counts=new Map();
  for(const name of items)counts.set(name,(counts.get(name)||0)+1);
  const entries=[...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  if(!entries.length)return '<p class="small">'+(login?'@'+esc(login)+' has no fish right now.':'Load a viewer to see their fish.')+'</p>';
  const rows=entries.map(([name,count])=>{const rarity=invRarity(name);const color=INV_RARITY[rarity]||'#8f8a80';return '<div class="inv-item" data-inv-row data-name="'+esc(name.toLowerCase())+'"><input type="checkbox" data-inv-name="'+esc(name)+'" aria-label="Select '+esc(name)+'"><span class="inv-name">'+esc(name)+'</span><span class="inv-rarity" style="color:'+color+'">'+esc(rarity.toUpperCase())+'</span><span class="inv-owned">× '+count+'</span><input type="number" min="1" max="'+Math.min(count,99)+'" step="1" value="'+Math.min(count,99)+'" data-inv-qty aria-label="Copies to delete of '+esc(name)+'"></div>';}).join('');
  return '<div class="inv-panel">'
    +'<div class="inv-bar"><input type="search" class="inv-search" placeholder="Search fish" aria-label="Search fish"><button class="btn secondary" type="button" data-inv-all>Select visible</button><button class="btn danger" type="button" data-inv-delete disabled>Delete selected</button></div>'
    +'<div class="inv-status"><span data-inv-count>Nothing selected</span><span class="small">'+items.length+' items, '+entries.length+' different fish</span></div>'
    +'<div class="inv-scroll"><div class="inv-item inv-item-head"><span></span><span>Fish</span><span>Rarity</span><span>Owned</span><span>Copies to delete</span></div>'+rows+'</div>'
    +'</div>';
}
function bindInventoryPanel(root,login,onDelete){
  const panel=root.querySelector('.inv-panel');if(!panel)return;
  const rows=[...panel.querySelectorAll('[data-inv-row]')];
  const countEl=panel.querySelector('[data-inv-count]');
  const delBtn=panel.querySelector('[data-inv-delete]');
  const copiesOf=r=>{const q=r.querySelector('[data-inv-qty]');return Math.min(Number(q.max)||1,Math.max(1,Number(q.value)||1));};
  const refresh=()=>{
    let types=0,copies=0;
    rows.forEach(r=>{if(r.querySelector('input[data-inv-name]').checked){types++;copies+=copiesOf(r);}});
    countEl.textContent=types?types+' fish · '+copies+' copies selected':'Nothing selected';
    delBtn.disabled=!types;
  };
  panel.addEventListener('input',refresh);
  panel.addEventListener('change',refresh);
  panel.querySelector('.inv-search').addEventListener('input',e=>{const q=e.target.value.trim().toLowerCase();rows.forEach(r=>{r.hidden=!!q&&!r.dataset.name.includes(q);});});
  panel.querySelector('[data-inv-all]').addEventListener('click',()=>{rows.forEach(r=>{if(!r.hidden)r.querySelector('input[data-inv-name]').checked=true;});refresh();});
  delBtn.addEventListener('click',async()=>{
    const picks=[];
    rows.forEach(r=>{const cb=r.querySelector('input[data-inv-name]');if(!cb.checked)return;for(let n=0;n<copiesOf(r);n++)picks.push(cb.dataset.invName);});
    if(!picks.length)return;
    if(!confirm('Delete '+picks.length+' item(s) from @'+login+'? This cannot be undone.'))return;
    try{await call('broadcaster',{action:'multi-delete-fish',targetUser:login,items:picks});notice('Deleted '+picks.length+' item(s) from @'+login+'.','good');await onDelete();}
    catch(e){notice(e.message,'error');}
  });
}

// Turns every number field into a slider with a live readout. The original input stays in the
// DOM (hidden) so existing reads such as document.getElementById(id).value keep working.
function enhanceNumberInputs(root){
  root.querySelectorAll('input[type=number]').forEach(function(input){
    if(input.dataset.sliderReady||input.hasAttribute('data-no-slider')||!input.parentNode)return;
    input.dataset.sliderReady='1';
    const step=Number(input.step)>0?Number(input.step):1;
    const min=input.min!==''&&!isNaN(Number(input.min))?Number(input.min):0;
    const current=input.value!==''&&!isNaN(Number(input.value))?Number(input.value):min;
    const max=input.max!==''&&!isNaN(Number(input.max))?Number(input.max):Math.max(100,current*2);
    const decimals=step<1?String(step).split('.')[1].length:0;
    const show=function(v){return Number(v).toFixed(decimals);};
    const wrap=document.createElement('div');
    wrap.className='slider-field';
    const range=document.createElement('input');
    range.type='range';range.min=String(min);range.max=String(max);range.step=String(step);range.value=String(current);
    range.setAttribute('aria-label',input.getAttribute('aria-label')||input.id||'Value');
    input.parentNode.insertBefore(wrap,input);
    wrap.appendChild(range);
    wrap.appendChild(input);
    input.classList.add('slider-value');
    input.value=show(current);
    input._range=range;
    const paint=function(){const lo=Number(range.min),hi=Number(range.max),span=hi-lo;range.style.setProperty('--fill',((span>0?(Number(range.value)-lo)/span:0)*100).toFixed(1)+'%');};
    const clampTo=function(v){return Math.min(Number(range.max),Math.max(Number(range.min),v));};
    input._sync=function(){range.value=String(input.value);paint();};
    paint();
    range.addEventListener('input',function(){paint();input.value=show(range.value);input.dispatchEvent(new Event('input',{bubbles:true}));});
    range.addEventListener('change',function(){paint();input.value=show(range.value);input.dispatchEvent(new Event('change',{bubbles:true}));});
    input.addEventListener('input',function(){const v=parseFloat(input.value);if(!isNaN(v)){range.value=String(clampTo(v));paint();}});
    input.addEventListener('change',function(){const v=parseFloat(input.value);const c=clampTo(isNaN(v)?Number(range.value):v);range.value=String(c);input.value=show(c);paint();});
    input.addEventListener('keydown',function(e){if(e.key==='Enter')input.blur();});
  });
}
// Browser file pickers are drawn in the browser's language and do not match the page. This puts each one
// behind a button in the page's own style, with the chosen file's name beside it.
function enhanceFileInputs(root){
  root.querySelectorAll('input[type=file]').forEach(function(input){
    if(input.dataset.pickReady||!input.parentNode)return;
    input.dataset.pickReady='1';
    const pick=document.createElement('label');
    pick.className='file-pick';
    const button=document.createElement('span');
    button.className='btn secondary file-pick-btn';
    button.textContent=tr('file.choose','Choose file');
    const name=document.createElement('span');
    name.className='file-pick-name';
    name.textContent=tr('file.none','No file chosen');
    input.parentNode.insertBefore(pick,input);
    pick.append(button,name,input);
    input.classList.add('file-pick-input');
    input.addEventListener('change',function(){const f=input.files&&input.files[0];name.textContent=f?f.name:tr('file.none','No file chosen');});
  });
}
function watchNumberInputs(){
  enhanceNumberInputs(app);
  enhanceFileInputs(app);
  new MutationObserver(function(){enhanceNumberInputs(app);enhanceFileInputs(app);}).observe(app,{childList:true,subtree:true});
}
// Changes the upper limit of a number field that has become a slider. The value is clamped to it.
function setNumberLimit(input,max){
  input.max=String(max);
  if(!input._range)return;
  input._range.max=String(max);
  if(Number(input.value)>max)input.value=String(max);
  input._sync();
}

window.addEventListener('fishingbot:language-changed',()=>{if(settings&&typeof renderTab==='function'){document.documentElement.lang=(window.FishingbotI18n&&window.FishingbotI18n.getLanguage())||'en';renderTab();}});
function renderTab(){if(!settings)return;if(currentTab==='loot')renderLoot();else if(currentTab==='game')renderGame();else if(currentTab==='twitch')renderTwitch();else if(currentTab==='extension')renderExtension();else if(currentTab==='viewer')renderViewer();else if(currentTab==='broadcaster')renderBroadcaster();else renderOverview();}
async function refreshSettings(){settings=await call('settings');}
window.fishingbotRefreshActiveTab=async function(){try{await refreshSettings();renderTab();}catch(e){notice('Could not refresh this tab: '+e.message,'error');}};
async function boot(){try{const state=await call('state');if(state.setupRequired){loginFrame('Create your admin password','Set up the password that protects all streamer-only controls on this computer.',true);return;}if(!state.authenticated){loginFrame('Streamer sign-in','Enter your local admin password to manage Fishingbot.',false);return;}await refreshSettings();shell();watchNumberInputs();
    // Game settings save as they change. A value the server rejects stays on screen without a notice on every change.
    document.getElementById('view').addEventListener('change',(event)=>{if(currentTab!=='game')return;if(String(event.target.id||'').startsWith('price-')){if(window.savePricesNow)window.savePricesNow(true);}else if(window.saveGameSettingsNow)window.saveGameSettingsNow(true);});document.getElementById('fb-lock').addEventListener('click',async()=>{try{await call('logout',{});}catch(_){}location.reload();});}catch(e){app.innerHTML='<div class="login-wrap"><div class="login-card"><h1>Could not load control centre</h1><p class="notice error">'+esc(e.message)+'</p><button class="btn" onclick="location.reload()">Retry</button></div></div>';}}
boot();
})();
</script></body></html>`;
}
