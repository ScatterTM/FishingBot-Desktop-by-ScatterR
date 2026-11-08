// Server-side Auto-Fish progression/state. All actual catches are delegated to
// the same fishing engine used by /api/fish; this module only owns automation,
// progression, licensing, sessions and admin-tunable values.

import { db } from './db.js';
import { FISHING_AREAS, AREA_IDS, areaLevelKey, areaEnabledKey, AREAS_ENABLED_KEY, isEnabledValue, readUserAreaLevels } from './areas.js';
import { getTreasuryBalance } from './shop.js';
import { addInventoryItems, removeInventoryItems, isTreasuryItem, withKeyLock, replaceInventoryItems } from './inventory.js';
import { TIERS } from './tiers.js';

export const AUTO_FISH_CONFIG_KEY = 'settings:autofish_config';
export const AUTO_FISH_GLOBAL_KEY = 'settings:autofish_enabled';

let configCache = null;
let configCacheAt = 0;
const CONFIG_CACHE_MS = 5000;

export const AUTO_FISH_DEFAULTS = {
  enabled: true,
  licenseCost: 150,
  maxLevel: 10,
  xpPerLevel: 100,
  manualXp: 5,
  autoXp: 1,
  activeEventXp: 12,
  baseIntervalSeconds: 90,
  levelEfficiencyStart: 55,
  levelEfficiencyStep: 4,
  sessionMinutesStart: 30,
  sessionMinutesPerLevel: 8,
  sessionMinutesPerPrestige: 15,
  attentionBase: 1,
  attentionEveryLevels: 3,
  attentionPerPrestige: 1,
  eventChancePerCast: 0.5,
  eventLogicVersion: 2,
  eventDurationSeconds: 45,
  eventCooldownSeconds: 300,
  prestigeMax: 5
};

export const AUTO_FISH_PRESTIGES = [
  { level: 5, areaProgress: 3, manualCasts: 100, treasuryEarned: 25, eventsCompleted: 2, name: 'Apprentice' },
  { level: 7, areaProgress: 6, manualCasts: 300, treasuryEarned: 75, eventsCompleted: 5, name: 'Skilled' },
  { level: 9, areaProgress: 10, manualCasts: 700, treasuryEarned: 150, eventsCompleted: 10, name: 'Expert' },
  { level: 10, areaProgress: 15, manualCasts: 1500, treasuryEarned: 300, eventsCompleted: 20, name: 'Master' },
  { level: 10, areaProgress: 20, manualCasts: 3000, treasuryEarned: 600, eventsCompleted: 35, name: 'Grandmaster' }
];

export function prestigePerks(tier, config = AUTO_FISH_DEFAULTS) {
  const n = Math.max(1, Number(tier) || 1);
  const session = Number(config.sessionMinutesPerPrestige) || 0;
  const attention = Number(config.attentionPerPrestige) || 0;
  const treasuryMulti = 0.5;
  const efficiency = 1;
  const name = AUTO_FISH_PRESTIGES[n - 1]?.name || `Prestige ${n}`;
  const perks = [
    `+${session} min session duration`,
    `+${attention} Fishy treat slot${attention === 1 ? '' : 's'}`,
    `+${treasuryMulti}x Treasury multiplier`,
    `+${efficiency}% efficiency`
  ];
  if (n === 1) perks.unshift('Unlocks the Apprentice prestige title');
  if (n === 2) perks.unshift('Unlocks the Skilled prestige title');
  if (n === 3) perks.unshift('Unlocks the Expert prestige title');
  if (n === 4) perks.unshift('Unlocks the Master prestige title');
  if (n === 5) perks.unshift('Unlocks the Grandmaster title and completes Auto-Fish progression');
  return { name, perks };
}

function cleanConfig(raw) {
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { console.error('[lib/autofish.js:73] ignored error:', _?.message || _); }
  const out = { ...AUTO_FISH_DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  // Migrate older Auto-Fish configs to Fishy's Treasury-event logic. Existing
  // deployments used an 8% bite event; the new system is a 50% Treasury event.
  if (Number(parsed?.eventLogicVersion || 0) < 2) {
    out.eventChancePerCast = 0.5;
    out.eventLogicVersion = 2;
  }
  const integerKeys = [
    'licenseCost','maxLevel','xpPerLevel','manualXp','autoXp','activeEventXp',
    'baseIntervalSeconds','sessionMinutesStart','sessionMinutesPerLevel',
    'sessionMinutesPerPrestige','attentionBase','attentionEveryLevels',
    'attentionPerPrestige','eventDurationSeconds','eventCooldownSeconds','prestigeMax'
  ];
  integerKeys.forEach((key) => {
    out[key] = Math.max(0, Math.round(Number(out[key]) || 0));
  });
  out.maxLevel = Math.max(1, Math.min(50, out.maxLevel));
  out.prestigeMax = Math.max(0, Math.min(5, out.prestigeMax));
  out.levelEfficiencyStart = Math.max(1, Math.min(99, Number(out.levelEfficiencyStart) || 55));
  out.levelEfficiencyStep = Math.max(0, Math.min(20, Number(out.levelEfficiencyStep) || 4));
  out.eventChancePerCast = Math.max(0, Math.min(1, Number(out.eventChancePerCast) || 0));
  out.eventDurationSeconds = Math.max(10, Math.min(300, out.eventDurationSeconds));
  out.eventCooldownSeconds = Math.max(0, Math.min(3600, out.eventCooldownSeconds));
  return out;
}

export async function getAutoFishConfig() {
  if (configCache && Date.now() - configCacheAt < CONFIG_CACHE_MS) return { ...configCache };
  const [raw, global] = await Promise.all([
    db.get(AUTO_FISH_CONFIG_KEY),
    db.get(AUTO_FISH_GLOBAL_KEY)
  ]);
  const config = cleanConfig(raw);
  if (global !== null && global !== undefined) config.enabled = global !== 'off' && global !== 'false' && global !== '0';
  configCache = config;
  configCacheAt = Date.now();
  return { ...config };
}

export async function setAutoFishConfig(patch) {
  const current = await getAutoFishConfig();
  const next = cleanConfig(JSON.stringify({ ...current, ...(patch || {}) }));
  await db.set(AUTO_FISH_CONFIG_KEY, JSON.stringify(next));
  await db.set(AUTO_FISH_GLOBAL_KEY, next.enabled ? 'on' : 'off');
  configCache = next;
  configCacheAt = Date.now();
  return next;
}

export const autoFishKeys = (userKey) => ({
  license: `autofish:license:${userKey}`,
  xp: `autofish:xp:${userKey}`,
  level: `autofish:level:${userKey}`,
  prestige: `autofish:prestige:${userKey}`,
  active: `autofish:active:${userKey}`,
  sessionExpires: `autofish:session_expires:${userKey}`,
  nextCast: `autofish:next_cast:${userKey}`,
  lastCast: `autofish:last_cast:${userKey}`,
  manualCasts: `autofish:manual_casts:${userKey}`,
  autoCasts: `autofish:auto_casts:${userKey}`,
  eventsCompleted: `autofish:events_completed:${userKey}`,
  treasuryEarned: `autofish:treasury_earned:${userKey}`,
  event: `autofish:event:${userKey}`,
  eventCooldown: `autofish:event_cooldown:${userKey}`,
  targetArea: `autofish:target_area:${userKey}`,
  stopAfter: `autofish:stop_after:${userKey}`,
  trophyMode: `autofish:trophy_mode:${userKey}`,
  trophyUnlocked: `autofish:trophy_unlocked:${userKey}`,
  sessionLoot: `autofish:session_loot:${userKey}`,
  sessionCasts: `autofish:session_casts:${userKey}`,
  timeout: `autofish:timeout:${userKey}`,
  leaderboardManualCasts: `fish:count:${userKey}`
});

export function prestigeTitle(prestige) {
  return AUTO_FISH_PRESTIGES[Math.max(0, Math.min(5, Number(prestige) || 0)) - 1]?.name || '';
}

export function xpForLevel(level, config) {
  const lvl = Math.max(1, Number(level) || 1);
  return lvl >= config.maxLevel ? Infinity : lvl * config.xpPerLevel;
}

export function efficiencyForLevel(level, prestige, config) {
  return Math.min(98, config.levelEfficiencyStart + Math.max(0, level - 1) * config.levelEfficiencyStep + Math.max(0, prestige) * 1);
}

export function attentionCapacity(level, prestige, config) {
  return Math.max(1, config.attentionBase + Math.floor(Math.max(0, level - 1) / Math.max(1, config.attentionEveryLevels)) + prestige * config.attentionPerPrestige);
}

export function sessionDurationSeconds(level, prestige, config) {
  return Math.max(60, (config.sessionMinutesStart +
    Math.max(0, level - 1) * config.sessionMinutesPerLevel +
    Math.max(0, prestige) * config.sessionMinutesPerPrestige) * 60);
}

export function autoIntervalSeconds(level, prestige, config) {
  const efficiency = efficiencyForLevel(level, prestige, config) / 100;
  // Never faster than the configured manual engine interval. Lower efficiency
  // means fewer opportunities, not worse rarity rolls.
  return Math.max(config.baseIntervalSeconds, Math.ceil(config.baseIntervalSeconds / Math.max(0.01, efficiency)));
}

export async function readAutoFishState(userKey, config = null) {
  const c = config || await getAutoFishConfig();
  const k = autoFishKeys(userKey);
  const keys = Object.values(k);
  const values = await db.mget(keys);
  const s = Object.fromEntries(Object.keys(k).map((name, i) => [name, values?.[i] ?? null]));
  const level = Math.max(1, Math.min(c.maxLevel, parseInt(s.level, 10) || 1));
  const prestige = Math.max(0, Math.min(c.prestigeMax, parseInt(s.prestige, 10) || 0));
  const xp = Math.max(0, parseInt(s.xp, 10) || 0);
  const active = s.active === 'on';
  const expiresAt = parseInt(s.sessionExpires, 10) || 0;
  const nextCastAt = parseInt(s.nextCast, 10) || 0;
  const autoBrokenUntil = parseInt(s.timeout, 10) || 0;
  let events = [];
  if (s.event) {
    try {
      const parsed = JSON.parse(s.event);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      events = list.filter((item) => item && item.expiresAt > Date.now());
      if (events.length !== list.length) {
        if (events.length) await db.set(k.event, JSON.stringify(events), { ex: Math.max(1, Math.ceil((Math.max(...events.map((e) => e.expiresAt)) - Date.now()) / 1000)) });
        else await db.del(k.event);
      }
    } catch (_) { await db.del(k.event); }
  }
  const trophyUnlocked = s.trophyUnlocked === 'true' || level >= 5 || prestige >= 1;
  if (trophyUnlocked && s.trophyUnlocked !== 'true') {
    await db.set(k.trophyUnlocked, 'true');
  }
  const targetArea = FISHING_AREAS[s.targetArea] ? s.targetArea : null;
  return {
    config: c,
    licensed: s.license === 'true',
    level,
    prestige,
    prestigeTitle: prestigeTitle(prestige),
    xp,
    xpToNext: xpForLevel(level, c),
    active: active && expiresAt > Date.now(),
    // True from start until the session has been settled+closed, i.e. it stays
    // true after expiresAt so casts that were due before the end can still be
    // credited. `active` above is only the UI-facing "still running" flag.
    sessionOpen: active && expiresAt > 0,
    expiresAt,
    nextCastAt,
    efficiency: efficiencyForLevel(level, prestige, c),
    attentionCapacity: attentionCapacity(level, prestige, c),
    onScreenTreasuryCount: attentionCapacity(level, prestige, c),
    sessionDurationSeconds: sessionDurationSeconds(level, prestige, c),
    intervalSeconds: autoIntervalSeconds(level, prestige, c),
    featureUnlocks: {
      areaTargeting: level >= 3,
      trophyFishing: trophyUnlocked,
      stopConditions: level >= 7,
      advancedSettings: level >= 9
    },
    // Manual-cast progression intentionally mirrors the public leaderboard
    // count. Auto-Fish never increments fish:count, so automated catches cannot
    // manufacture the active-play requirement for Prestige.
    manualCasts: Math.max(0, parseInt(s.leaderboardManualCasts, 10) || 0),
    autoCasts: Math.max(0, parseInt(s.autoCasts, 10) || 0),
    eventsCompleted: Math.max(0, parseInt(s.eventsCompleted, 10) || 0),
    treasuryEarned: Math.max(0, parseInt(s.treasuryEarned, 10) || 0),
    event: events[0] || null,
    events,
    targetArea,
    stopAfter: Math.max(0, parseInt(s.stopAfter, 10) || 0),
    trophyMode: s.trophyMode === 'on' && trophyUnlocked,
    trophyFishingUnlocked: trophyUnlocked
  };
}

// Full Auto-Fish payload used by /api/autofish AND /api/perks. Both must go
// through this one builder: /api/perks used to return the bare state, which has
// no area levels, so the page-load render showed Area progress 0 until the next
// /api/autofish poll or admin action.
export async function autoFishStatus(userKey, config = null) {
  config = config || await getAutoFishConfig();
  const state = await readAutoFishState(userKey, config);
  const areaLevels = await readUserAreaLevels(db, userKey);
  const areas = Object.fromEntries(AREA_IDS.map((id) => [
    id,
    { name: FISHING_AREAS[id].name, level: Math.max(0, Math.min(5, Number(areaLevels[id]) || 0)) }
  ]));
  // Prestige requirements are canonical gameplay data, not admin-configurable values.
  // Always derive them from the current prestige so a stale/malformed client payload
  // cannot turn the requirement cards into 0/0.
  const nextReq = prestigeRequirements(Math.max(0, Math.min(AUTO_FISH_PRESTIGES.length, Number(state.prestige) || 0)));
  const areaProgress = Object.values(areas).reduce((sum, a) => sum + a.level, 0);
  const prestigeChecks = nextReq ? [
    { key: 'level', label: 'Auto-Fish level', current: Number(state.level || 0), required: Number(nextReq.level || 0) },
    { key: 'areaProgress', label: 'Area progress', current: areaProgress, required: Number(nextReq.areaProgress || 0) },
    { key: 'manualCasts', label: 'Lifetime manual casts', current: Number(state.manualCasts || 0), required: Number(nextReq.manualCasts || 0) },
    { key: 'treasuryEarned', label: 'Treasury earned', current: Number(state.treasuryEarned || 0), required: Number(nextReq.treasuryEarned || 0) },
    { key: 'eventsCompleted', label: 'Fishy treats collected', current: Number(state.eventsCompleted || 0), required: Number(nextReq.eventsCompleted || 0) }
  ] : [];
  const prestigeMissing = prestigeChecks
    .filter((item) => item.current < item.required)
    .map((item) => ({ ...item, shortfall: Math.max(0, item.required - item.current) }));
  const prestigeReady = !!nextReq && state.prestige < config.prestigeMax && prestigeMissing.length === 0;
  const area1 = areas.forest;
  const areaLevel3Eligible = Number(area1?.level || 0) >= 3;
  return {
    ...state,
    serverNow: Date.now(),
    areas,
    areaProgress,
    areaLevel3Eligible,
    areaLevel3Area: areaLevel3Eligible ? { id: 'forest', name: area1.name, level: area1.level } : null,
    prestigeRequirements: nextReq,
    prestigeChecks,
    prestigeMissing,
    prestigeReady,
    prestigeTable: AUTO_FISH_PRESTIGES.slice(0, config.prestigeMax).map((p, i) => ({ ...p, perks: prestigePerks(i + 1, config).perks })),
    levelTable: Array.from({ length: config.maxLevel }, (_, index) => {
      const level = index + 1;
      const efficiency = efficiencyForLevel(level, 0, config);
      const sessionMinutes = Math.round(sessionDurationSeconds(level, 0, config) / 60);
      return {
        level, efficiency, sessionMinutes, attention: attentionCapacity(level, 0, config),
        features: [
          level >= 3 ? 'Area targeting' : null,
          level >= 7 ? 'Stop conditions' : null,
          level >= 9 ? 'Advanced settings' : null
        ].filter(Boolean)
      };
    }),
    masteryComplete: state.prestige >= config.prestigeMax
  };
}

export async function addAutoXp(userKey, amount, config = null, incrementCasts = false) {
  const c = config || await getAutoFishConfig();
  const n = Math.max(0, Math.round(Number(amount) || 0));
  if (!n) return readAutoFishState(userKey, c);
  const k = autoFishKeys(userKey);
  const fast = await db.autofishProgress({
    xpKey: k.xp,
    levelKey: k.level,
    trophyKey: k.trophyUnlocked,
    amount: n,
    maxLevel: c.maxLevel,
    xpPerLevel: c.xpPerLevel,
    incrementCastsKey: incrementCasts ? k.autoCasts : null
  });
  if (fast) return { ...fast, xp: Number(fast.xp), level: Number(fast.level), levelsGained: Number(fast.levelsGained || 0), autoCasts: fast.autoCasts == null ? null : Number(fast.autoCasts) };

  // Pre-migration fallback: retain the original semantics.
  const xp = Number(await db.incrby(k.xp, n));
  let level = Math.max(1, parseInt(await db.get(k.level), 10) || 1);
  let levelsGained = 0;
  while (level < c.maxLevel && xp >= xpForLevel(level, c)) {
    level += 1;
    levelsGained += 1;
  }
  await db.set(k.level, String(level));
  if (level >= 5) await db.set(k.trophyUnlocked, 'true');
  let autoCasts = null;
  if (incrementCasts) autoCasts = Number(await db.incr(k.autoCasts));
  return { xp, level, levelsGained, autoCasts };
}

export async function recordManualAutoProgress(userKey, config = null, licensed = true) {
  const k = autoFishKeys(userKey);
  // The public leaderboard's fish:count is the single source of truth for
  // lifetime manual casts. Do not maintain a second counter here.
  if (!licensed) return { xp: 0, level: 1, levelsGained: 0 };
  const c = config || await getAutoFishConfig();
  return addAutoXp(userKey, c.manualXp, c, false);
}

export async function recordAutoCatchProgress(userKey, config = null) {
  const c = config || await getAutoFishConfig();
  const k = autoFishKeys(userKey);
  return addAutoXp(userKey, c.autoXp, c, true);
}

export async function recordTreasuryEarned(userKey, amount) {
  const n = Math.max(0, Number(amount) || 0);
  if (n) await db.incrby(autoFishKeys(userKey).treasuryEarned, n);
}

export async function maybeCreateActiveEvent(userKey, config, state, source = 'manual') {
  const k = autoFishKeys(userKey);
  const treasuryCount = Math.max(1, attentionCapacity(state.level, state.prestige, config));
  if ((state.events || []).length >= treasuryCount) return null;
  // Fishy's Treasury slot has a 50% default chance per successful manual !fish cast.
  // Auto-Fish casts intentionally never call this helper.
  if (Math.random() >= config.eventChancePerCast) return null;
  const cooldown = Number(await db.ttl(k.eventCooldown));
  if (cooldown > 0) return null;
  const now = Date.now();
  const maxReward = Math.max(1, treasuryCount);
  const treasuryAmount = 1 + Math.floor(Math.random() * maxReward);
  const treasuryTier = TIERS.find((t) => t.id === 'treasury');
  const treasuryItems = Array.isArray(treasuryTier?.items) ? treasuryTier.items : [];
  const rewards = Array.from({ length: treasuryAmount }, () => treasuryItems[Math.floor(Math.random() * treasuryItems.length)]).filter(Boolean);
  const event = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'treasury',
    createdAt: now,
    expiresAt: now + config.eventDurationSeconds * 1000,
    treasuryAmount,
    treasuryCount,
    rewards,
    source: source === 'manual' ? 'manual' : 'manual'
  };
  const current = Array.isArray(state.events) ? state.events : [];
  const next = [...current, event];
  await db.set(k.event, JSON.stringify(next), { ex: config.eventDurationSeconds });
  if (config.eventCooldownSeconds > 0) await db.set(k.eventCooldown, '1', { ex: config.eventCooldownSeconds });
  return event;
}

export async function completeActiveEvent(userKey, eventId, config = null) {
  const c = config || await getAutoFishConfig();
  const k = autoFishKeys(userKey);
  return withKeyLock(db, `autofish-event:${userKey}`, async () => {
    const raw = await db.get(k.event);
    if (!raw) return { success: false, error: 'That fishing event has expired.' };
    let events;
    try {
      const parsed = JSON.parse(raw);
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) { events = []; }
    const event = events.find((item) => item?.id === eventId && item.expiresAt > Date.now());
    if (!event) {
      const remaining = events.filter((item) => item?.expiresAt > Date.now());
      if (remaining.length) await db.set(k.event, JSON.stringify(remaining), { ex: Math.max(1, Math.ceil((Math.max(...remaining.map((e) => e.expiresAt)) - Date.now()) / 1000)) });
      else await db.del(k.event);
      return { success: false, error: 'That fishing event has expired.' };
    }
    const remaining = events.filter((item) => item?.id !== eventId && item?.expiresAt > Date.now());
    if (remaining.length) await db.set(k.event, JSON.stringify(remaining), { ex: Math.max(1, Math.ceil((Math.max(...remaining.map((e) => e.expiresAt)) - Date.now()) / 1000)) });
    else await db.del(k.event);
    const treasuryAmount = Math.max(0, Number(event.treasuryAmount) || 0);
    const rewards = Array.isArray(event.rewards) ? event.rewards.filter(Boolean).slice(0, treasuryAmount) : [];
    if (rewards.length) {
      await addInventoryItems(db, userKey, rewards);
      await db.incrby(k.treasuryEarned, rewards.length);
    }
    await db.incr(k.eventsCompleted);
    const xp = await addAutoXp(userKey, c.activeEventXp, c);
    return {
      success: true,
      type: event.type || 'treasury',
      treasuryAmount: rewards.length,
      rewards,
      xp: c.activeEventXp,
      level: xp.level,
      levelsGained: xp.levelsGained
    };
  });
}


export async function adminSpawnTreasurySlot(userKey, requestedAmount = 0) {
  const c = await getAutoFishConfig();
  const k = autoFishKeys(userKey);
  return withKeyLock(db, `autofish-event:${userKey}`, async () => {
    const state = await readAutoFishState(userKey, c);
    const capacity = Math.max(1, attentionCapacity(state.level, state.prestige, c));
    const existing = Array.isArray(state.events) ? state.events.filter((e) => e?.expiresAt > Date.now()) : [];
    if (existing.length >= capacity) {
      return { success: false, error: `All ${capacity} Fishy treat slots in the tank are currently occupied.` };
    }

    const amount = Math.max(1, Math.min(capacity, parseInt(requestedAmount, 10) || capacity));
    const treasuryTier = TIERS.find((t) => t.id === 'treasury');
    const treasuryItems = Array.isArray(treasuryTier?.items) ? treasuryTier.items : [];
    if (!treasuryItems.length) return { success: false, error: 'Treasury reward table is unavailable.' };

    const now = Date.now();
    const event = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'treasury',
      createdAt: now,
      expiresAt: now + c.eventDurationSeconds * 1000,
      treasuryAmount: amount,
      treasuryCount: capacity,
      rewards: Array.from({ length: amount }, () => treasuryItems[Math.floor(Math.random() * treasuryItems.length)]).filter(Boolean),
      source: 'admin'
    };
    const next = [...existing, event];
    await db.set(k.event, JSON.stringify(next), { ex: Math.max(1, c.eventDurationSeconds) });
    return {
      success: true,
      event,
      capacity,
      message: `Spawned a Fishy treat (${amount} Treasury reward) for @${userKey}.`
    };
  });
}

export async function hasAreaLevel3(userKey) {
  // Use the same canonical area reader as the prestige system so unlock
  // checks cannot disagree with the persisted area levels after a refresh.
  const levels = await readUserAreaLevels(db, userKey);
  return Number(levels.forest || 0) >= 3;
}

export async function buyAutoFishLicense(userKey, config = null) {
  const c = config || await getAutoFishConfig();
  return withKeyLock(db, `autofish-license:${userKey}`, async () => {
    const k = autoFishKeys(userKey);
    if (await db.get(k.license) === 'true') return { success: false, error: 'You already own the Auto-Fishing License.' };
    if (!await hasAreaLevel3(userKey)) return { success: false, error: 'Reach Area 1 Level 3 first.' };
    const items = await db.lrange(`fish:rares:${userKey}`, 0, -1);
    const { balance } = await getTreasuryBalance(db, userKey, items);
    if (balance < c.licenseCost) return { success: false, error: `You need ${c.licenseCost} Treasury to buy the Auto-Fishing License (you have ${balance}).` };
    const removed = await removeInventoryItems(db, userKey, isTreasuryItem, c.licenseCost, c.licenseCost);
    if (removed.removed.length !== c.licenseCost) return { success: false, error: 'Treasury inventory changed. Please try again.' };
    await db.set(k.license, 'true');
    await db.set(k.level, '1');
    return { success: true, message: 'Auto-Fishing License purchased. Auto-Fish starts at Level 1.' };
  });
}

export async function startAutoFish(userKey, config = null, targetArea = null) {
  const c = config || await getAutoFishConfig();
  return withKeyLock(db, `autofish-session:${userKey}`, async () => {
    if (!c.enabled) return { success: false, error: 'Auto-Fish is currently disabled by the operator.' };
    const k = autoFishKeys(userKey);
    if (await db.get(k.license) !== 'true') return { success: false, error: 'Purchase the Auto-Fishing License first.' };
    const existingExpiry = parseInt(await db.get(k.sessionExpires), 10) || 0;
    if (await db.get(k.active) === 'on' && existingExpiry > Date.now()) return { success: false, error: 'An Auto-Fish session is already running.' };
    const level = Math.max(1, Math.min(c.maxLevel, parseInt(await db.get(k.level), 10) || 1));
    const prestige = Math.max(0, Math.min(c.prestigeMax, parseInt(await db.get(k.prestige), 10) || 0));
    if (targetArea) {
      if (level < 3) return { success: false, error: 'Area targeting unlocks at Auto-Fish Level 3.' };
      if (!FISHING_AREAS[targetArea]) return { success: false, error: 'Unknown fishing area.' };
      const [master, enabled, levelRaw] = await Promise.all([
        db.get(AREAS_ENABLED_KEY),
        db.get(areaEnabledKey(targetArea)),
        db.get(areaLevelKey(userKey, targetArea))
      ]);
      if (!isEnabledValue(master) || !isEnabledValue(enabled)) return { success: false, error: 'That fishing area is currently disabled.' };
      if ((parseInt(levelRaw, 10) || 0) < 1) return { success: false, error: 'Unlock that fishing area before targeting it.' };

    }
    const now = Date.now();
    const duration = sessionDurationSeconds(level, prestige, c) * 1000;
    await Promise.all([
      db.set(k.active, 'on'),
      db.set(k.sessionExpires, String(now + duration)),
      db.set(k.nextCast, String(now)),
      db.del(k.sessionLoot),
      db.del(k.sessionCasts),
      targetArea ? db.set(k.targetArea, targetArea) : null
    ]);
    return { success: true, expiresAt: now + duration };
  });
}

export async function stopAutoFish(userKey) {
  const k = autoFishKeys(userKey);
  const raw = await db.get(k.event);
  const keep = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      keep.push(...list.filter((item) => (item?.source === 'manual' || item?.source === 'admin') && item?.expiresAt > Date.now()));
    } catch (_) { console.error('[lib/autofish.js:541] ignored error:', _?.message || _); }
  }
  const ops = [db.del(k.active), db.del(k.sessionExpires), db.del(k.nextCast)];
  if (keep.length) {
    ops.push(db.set(k.event, JSON.stringify(keep), { ex: Math.max(1, Math.ceil((Math.max(...keep.map((e) => e.expiresAt)) - Date.now()) / 1000)) }));
  } else {
    ops.push(db.del(k.event));
  }
  await Promise.all(ops);
  return { success: true };
}

export async function prestigeAutoFish(userKey, config = null) {
  const c = config || await getAutoFishConfig();
  return withKeyLock(db, `autofish-prestige:${userKey}`, async () => {
    const k = autoFishKeys(userKey);
    const state = await readAutoFishState(userKey, c);
    if (state.prestige >= c.prestigeMax) return { success: false, error: 'Auto-Fish mastery is complete at Prestige 5.' };
    const req = AUTO_FISH_PRESTIGES[state.prestige];
    if (!req) return { success: false, error: 'No further prestige is configured.' };
    const areaProgress = await totalAreaProgressForUser(userKey);
    const checks = [
      { key: 'level', label: 'Auto-Fish level', current: state.level, required: req.level },
      { key: 'areaProgress', label: 'Area progress', current: areaProgress, required: req.areaProgress },
      { key: 'manualCasts', label: 'Lifetime manual casts', current: state.manualCasts, required: req.manualCasts },
      { key: 'treasuryEarned', label: 'Treasury earned', current: state.treasuryEarned, required: req.treasuryEarned },
      { key: 'eventsCompleted', label: 'Fishy treats collected', current: state.eventsCompleted, required: req.eventsCompleted }
    ];
    const missing = checks
      .filter((item) => Number(item.current) < Number(item.required))
      .map((item) => ({
        ...item,
        shortfall: Math.max(0, Number(item.required) - Number(item.current))
      }));
    if (missing.length) {
      const summary = missing.map((item) => `${item.label}: ${item.current}/${item.required} (need ${item.shortfall} more)`).join('; ');
      return {
        success: false,
        error: `Prestige ${state.prestige + 1} is not ready. Missing: ${summary}.`,
        requirements: req,
        missing,
        current: { level: state.level, areaProgress, manualCasts: state.manualCasts, treasuryEarned: state.treasuryEarned, eventsCompleted: state.eventsCompleted }
      };
    }
    const nextPrestige = state.prestige + 1;
    await Promise.all([
      db.set(k.prestige, String(nextPrestige)),
      db.set(k.level, '1'),
      db.set(k.xp, '0'),
      db.del(k.active, k.sessionExpires, k.nextCast, k.event)
    ]);
    return { success: true, prestige: nextPrestige, title: AUTO_FISH_PRESTIGES[nextPrestige - 1].name };
  });
}

async function totalAreaProgressForUser(userKey) {
  const levels = await readUserAreaLevels(db, userKey);
  return Object.values(levels).reduce((sum, level) => sum + Math.max(0, Math.min(5, Number(level) || 0)), 0);
}

export function prestigeRequirements(prestige) {
  return AUTO_FISH_PRESTIGES[Math.max(0, Number(prestige) || 0)] || null;
}

export function sanitizeAdminConfig(body) {
  const allowed = [
    'enabled','licenseCost','maxLevel','xpPerLevel','manualXp','autoXp','activeEventXp',
    'baseIntervalSeconds','levelEfficiencyStart','levelEfficiencyStep',
    'sessionMinutesStart','sessionMinutesPerLevel','sessionMinutesPerPrestige',
    'attentionBase','attentionEveryLevels','attentionPerPrestige',
    'eventChancePerCast','eventDurationSeconds','eventCooldownSeconds','prestigeMax'
  ];
  const patch = {};
  allowed.forEach((key) => {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
  });
  return patch;
}
