// Personal Pond: a small Prestige progression system that produces normal
// loot-table fish on a timer. FishyTokens are deliberately separate from
// Treasury so the pond cannot replace the existing economy.
import { db } from './db.js';
import { TIERS } from './tiers.js';
import { fishWeight, fishTierForName } from './fish-weights.js';
import { withKeyLock, addInventoryItems, removeInventoryItems, isTreasuryItem, catchCountKey } from './inventory.js';
import { BAITS, baitFor, progressionKeys, readProgression } from './progression.js';
import { FISHDEX_FISH_KEYS, FISHDEX_FISH_TOTAL } from './dexcatalog.js';
import { getTreasuryBalance, shopKey } from './shop.js';
import { getAutoFishConfig, readAutoFishState } from './autofish.js';
import { getPrices, pondPerkPrice } from './pricing.js';
import { fortuneStatus, fortuneUncaughtBoost, uncaughtWeightFor } from './fortune.js';

export const POND_UNLOCK_PRESTIGE = 1;
export const POND_CHAT_UNLOCK_PRESTIGE = 2;
export const POND_BASE_INTERVAL_SECONDS = 180;
export const POND_BASE_CAPACITY = 3;
export const POND_MAX_LEVEL = 5;
export const POND_TREASURY_MODE_ID = 'treasuryWaters';
export const POND_TREASURY_MODE_LEVEL = 5;
export const POND_TREASURY_MODE_COST = 250;

const TOKEN_VALUES = {
  COMMON: 1,
  UNCOMMON: 3,
  RARE: 8,
  EPIC: 20,
  LEGENDARY: 60,
  GODLY: 200,
  SECRET: 750
};

const FISH_UNLOCK_COSTS = {
  COMMON: 0,
  UNCOMMON: 10,
  RARE: 35,
  EPIC: 100,
  LEGENDARY: 300,
  GODLY: 1000,
  SECRET: 3000
};

const POND_UPGRADE_COSTS = [0, 100, 350, 900, 2000];
const POND_FISH_MAX_UPGRADES = 2;
const POND_SELECTED_WEIGHT_BONUS = 0.25;
const POND_FISH_UPGRADE_COSTS = {
  COMMON: [20, 50],
  UNCOMMON: [35, 90],
  RARE: [60, 160],
  EPIC: [120, 300],
  LEGENDARY: [250, 650]
};


const POND_FEATURES = {
  deepWater: { label: 'Deep Water', max: 3, costs: [450, 900, 1800], desc: 'Higher-rarity tiers receive extra weight.' },
  luckyWater: { label: 'Lucky Water', max: 3, costs: [550, 1100, 2200], desc: 'Your normal Luck is amplified inside the pond.' },
  fishFinder: { label: 'Fish Finder', max: 1, costs: [800], desc: 'Shows the live weight and chance of every pond fish.' },
  baitSlots: { label: 'Bait Slots', max: 2, costs: [650, 1300], desc: 'Adds pond-only bait slots that are consumed when the pond spawns a fish.' },
  familiarity: { label: 'Familiarity', max: 3, costs: [700, 1400, 2800], desc: 'Fish you catch often slowly gain a small individual weight bonus.' }
};
const POND_FAMILIARITY_STEP = 5;
const POND_FAMILIARITY_BONUS_PER_STEP = 0.01;
const POND_DEEP_WATER_BONUS_PER_LEVEL = 0.10;
const POND_LUCKY_WATER_BONUS_PER_LEVEL = 0.10;
const POND_BAIT_SLOTS_MAX = 2;

// Treasury-funded Pond perks. These are deliberately small, affordable sinks:
// Treasury is slow to earn, so the first levels should feel attainable.
export const POND_TREASURY_PERKS = {
  treasuryWaters: { label: 'Treasury Waters', max: 1, costs: [POND_TREASURY_MODE_COST], desc: 'At Pond Level 5, uses Treasury Only catch odds. Misses are Mud; successful Treasury catches go straight to inventory.', requiresPondLevel: POND_TREASURY_MODE_LEVEL, mode: 'treasury-only' },
  speciesHunter: { label: 'Species Hunter', max: 5, costs: [10, 25, 50, 100, 175], desc: 'Every unique Fishdex fish you have caught adds +0.01x Luck, up to the level cap.', caps: [0, 10, 30, 60, 100, FISHDEX_FISH_TOTAL] },
  baitSaver: { label: 'Bait Saver', max: 5, costs: [15, 30, 50, 80, 125], desc: 'Gives a chance for premium Pond bait not to be consumed.', values: [5, 10, 15, 20, 25] },
  collectorInstinct: { label: "Collector's Instinct", max: 3, costs: [25, 60, 125], desc: 'Fish you have never caught receive extra individual weight.', values: [15, 30, 50] },
  stillWaters: { label: 'Still Waters', max: 3, costs: [30, 75, 150], desc: 'Reduces Common weight and redistributes it toward higher rarities.', values: [5, 10, 15] },
  deepCurrent: { label: 'Deep Current', max: 3, costs: [40, 90, 175], desc: 'Makes Pond cycles 1 minute longer and increases Rare+ weighting.', values: [10, 20, 30] },
  biggerHaul: { label: 'Bigger Haul', max: 3, costs: [20, 50, 100], desc: 'Adds extra fish when you collect a completed Pond haul.', values: [1, 2, 3] },
  fishyFortune: { label: 'Fishy Fortune', max: 3, costs: [35, 75, 150], desc: 'Common through Rare Pond fish convert into more FishyTokens.', values: [10, 20, 35] }
};

const POND_COLLECTOR_BONUS = [0, 0.15, 0.30, 0.50];
const POND_STILL_WATERS_BONUS_PER_LEVEL = 0.05;
const POND_DEEP_CURRENT_BONUS = [0, 0.10, 0.20, 0.30];
const POND_DEEP_CURRENT_TIMER_SECONDS = 60;
const POND_FISHY_FORTUNE_BONUS = [0, 0.10, 0.20, 0.35];

const NORMAL_TIERS = TIERS.filter((tier) => !['treasury', 'unique', 'godly'].includes(tier.id) && Array.isArray(tier.items));

export function treasuryPondPool(tiers = TIERS) {
  const tier = (Array.isArray(tiers) ? tiers : []).find((entry) => entry?.id === 'treasury');
  return (tier?.items || []).filter((item) => !/timeout/i.test(String(item)));
}
const TREASURY_ITEM_NAMES = new Set(treasuryPondPool(TIERS).map(String));

function pondTreasuryCatalog() {
  return treasuryPondPool(TIERS).map((name) => ({
    name,
    tier: 'TREASURY',
    tokenValue: 0,
    unlockCost: 0,
    treasuryOnly: true
  }));
}

const FISH_BY_NAME = new Map();
for (const tier of NORMAL_TIERS) {
  for (const item of tier.items) FISH_BY_NAME.set(String(item), tier);
}

function cleanUser(user) {
  return String(user || '').trim().replace(/^@+/, '').toLowerCase();
}

export function pondKeys(user) {
  const u = cleanUser(user);
  return {
    unlocked: `pond:unlocked:${u}`,
    level: `pond:level:${u}`,
    selected: `pond:selected:${u}`,
    pending: `pond:pending:${u}`,
    stash: `pond:stash:${u}`,
    nextSpawn: `pond:next_spawn:${u}`,
    tokens: `pond:tokens:${u}`,
    tokenTotal: `pond:tokens_earned:${u}`,
    fishUnlocked: `pond:fish_unlocked:${u}`,
    fishUpgrades: `pond:fish_upgrades:${u}`,
    featureUpgrades: `pond:feature_upgrades:${u}`,
    baitSlots: `pond:bait_slots:${u}`,
    familiarity: `pond:familiarity:${u}`,
    treasuryPerks: `pond:treasury_perks:${u}`,
    chatUnlocked: `pond:chat_unlocked:${u}`
  };
}

export function fishyTokenValue(item) {
  if (!isConvertibleFish(item)) return 0;
  const raw = String(item || '').trim();
  // Pond stash entries are stored as the raw fish name (without a [TIER]
  // suffix), while inventory entries normally include the suffix. Resolve
  // raw pond fish names through the catalog first so a Legendary/rare fish
  // does not accidentally get treated as Common during stash conversion.
  const catalogTier = FISH_BY_NAME.get(raw);
  const tier = catalogTier || tierForInventoryItem(raw);
  return TOKEN_VALUES[tier?.name] || 0;
}

function isConvertibleFish(item) {
  const lower = String(item || '').toLowerCase();
  if (isTreasuryItem(item)) return false;
  // Perk-granting catches should not be convertible after they have activated
  // their perk, otherwise a player could turn a one-time catch into permanent
  // value while keeping the perk itself.
  return !lower.includes('1.5x luck') && !lower.includes('2x luck') && !lower.includes('vipfish');
}

export function tierForInventoryItem(item) {
  const raw = String(item || '').trim();
  const match = raw.match(/\[([^\]]+)\]\s*$/);
  const name = (match?.[1] || 'COMMON').toUpperCase();
  return NORMAL_TIERS.find((tier) => tier.name === name) || NORMAL_TIERS.find((tier) => tier.id === 'common') || NORMAL_TIERS[0];
}

function pondLevelConfig(level) {
  const n = Math.max(1, Math.min(POND_MAX_LEVEL, Number(level) || 1));
  return {
    level: n,
    capacity: POND_BASE_CAPACITY + (n - 1),
    intervalSeconds: Math.max(60, POND_BASE_INTERVAL_SECONDS - (n - 1) * 20),
    nextUpgradeCost: n < POND_MAX_LEVEL ? POND_UPGRADE_COSTS[n] : null
  };
}

function pondEffectiveIntervalSeconds(level, deepCurrentLevel = 0) {
  const cfg = pondLevelConfig(level);
  return cfg.intervalSeconds + (Number(deepCurrentLevel) > 0 ? POND_DEEP_CURRENT_TIMER_SECONDS : 0);
}

function normalizeFishList(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(String).filter((name) => FISH_BY_NAME.has(name)))];
}

async function readJson(key, fallback) {
  const raw = await db.get(key);
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch (_) { return fallback; }
}

async function saveJson(key, value) {
  await db.set(key, JSON.stringify(value));
}

function pondFishWeight(name, selectedSet, upgrades) {
  const selected = selectedSet.has(name);
  const level = Math.max(0, Math.min(POND_FISH_MAX_UPGRADES, Number(upgrades?.[name]) || 0));
  // Selection is a light targeting bonus. Upgrades are additive and exact:
  // +50% at upgrade 1, +100% at upgrade 2.
  return (1 + (selected ? POND_SELECTED_WEIGHT_BONUS : 0) + level * 0.50) * fishWeight(fishTierForName(name)?.id, name);
}


function normalizePondTreasuryPerks(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(POND_TREASURY_PERKS).map(([id, cfg]) => [id, Math.max(0, Math.min(cfg.max, Number(source[id]) || 0))]));
}

// Pond perks are owned at their stored level, but each perk can be switched
// off without losing that level. No toggle key means ON, so existing players
// keep their current behaviour after this feature is introduced.
export async function getActivePondTreasuryPerks(user, rawLevels = null) {
  const u = cleanUser(user);
  const levels = rawLevels && typeof rawLevels === 'object'
    ? normalizePondTreasuryPerks(rawLevels)
    : normalizePondTreasuryPerks(await readJson(pondKeys(u).treasuryPerks, {}));
  const ids = Object.keys(POND_TREASURY_PERKS);
  const rawToggles = await db.mget(ids.map((id) => `toggle:pondPerk:${id}:${u}`)).catch(() => []);
  const toggles = Object.fromEntries(ids.map((id, i) => [id, rawToggles?.[i] !== 'off']));
  const activeLevels = Object.fromEntries(ids.map((id) => [id, toggles[id] ? levels[id] : 0]));
  return { levels, toggles, activeLevels };
}

function pondTreasuryPerkInfo(id, level, prices = null) {
  const cfg = POND_TREASURY_PERKS[id];
  const current = Math.max(0, Math.min(cfg?.max || 0, Number(level) || 0));
  const nextCost = current < (cfg?.max || 0) ? pondPerkPrice(prices, id, current, cfg?.costs?.[current]) : null;
  return { id, label: cfg?.label || id, level: current, max: cfg?.max || 0, nextCost, desc: cfg?.desc || '', value: cfg?.values?.[current] ?? null, cap: cfg?.caps?.[current] ?? null, costs: cfg?.costs || [] };
}

function pondCollectorBonusPercent(level) { return POND_COLLECTOR_BONUS[Math.max(0, Math.min(3, Number(level) || 0))] * 100; }

// Species Hunter is based on the real Fishdex collection, not the Pond's
// separate familiarity/pending-fish state. One MGET keeps this to a single
// database round trip even though the Fishdex contains many entries.
export async function getFishdexFishCount(user) {
  const u = cleanUser(user);
  if (!u || !FISHDEX_FISH_KEYS.length) return 0;
  const values = await db.mget(FISHDEX_FISH_KEYS.map((item) => catchCountKey(u, item))).catch(() => []);
  return values.reduce((count, raw) => count + (Number(raw) > 0 ? 1 : 0), 0);
}

export function speciesHunterBonus(level, fishdexCount) {
  const safeLevel = Math.max(0, Math.min(5, Number(level) || 0));
  const cap = POND_TREASURY_PERKS.speciesHunter.caps[safeLevel] || 0;
  return Math.min(Math.max(0, Number(fishdexCount) || 0), cap) * 0.01;
}

function pondFortuneMultiplier(level, tierName) {
  const tier = String(tierName || '').toUpperCase();
  if (!['COMMON', 'UNCOMMON', 'RARE'].includes(tier)) return 1;
  return 1 + (POND_FISHY_FORTUNE_BONUS[Math.max(0, Math.min(3, Number(level) || 0))] || 0);
}

function normalizeFeatureUpgrades(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(POND_FEATURES).map(([id, cfg]) => [id, Math.max(0, Math.min(cfg.max, Number(source[id]) || 0))]));
}

function normalizeBaitSlots(value, maxSlots = POND_BAIT_SLOTS_MAX) {
  const list = Array.isArray(value) ? value : [];
  const valid = new Set(BAITS.map((bait) => bait.id));
  return [...new Set(list.map(String).filter((id) => valid.has(id)))].slice(0, Math.max(0, Math.min(POND_BAIT_SLOTS_MAX, Number(maxSlots) || 0)));
}

function familiarityWeight(name, familiarity, level) {
  if (!level) return 1;
  const catches = Math.max(0, Number(familiarity?.[name]) || 0);
  const bonus = Math.min(level * 0.10, Math.floor(catches / POND_FAMILIARITY_STEP) * POND_FAMILIARITY_BONUS_PER_STEP);
  return 1 + bonus;
}

function featureUpgradeInfo(id, level) {
  const cfg = POND_FEATURES[id];
  const current = Math.max(0, Math.min(cfg?.max || 0, Number(level) || 0));
  return {
    id,
    label: cfg?.label || id,
    level: current,
    max: cfg?.max || 0,
    nextCost: current < (cfg?.max || 0) ? cfg.costs[current] : null,
    desc: cfg?.desc || ''
  };
}

function tierBaseProbability(tier) {
  const tiers = TIERS.filter((entry) => ['common', 'uncommon', 'rare', 'epic', 'legendary'].includes(entry.id));
  const index = tiers.findIndex((entry) => entry.id === tier.id);
  if (index < 0) return 0;
  const previousCutoff = index === 0 ? 0 : Number(tiers[index - 1].cutoff) || 0;
  return Math.max(0, (Number(tier.cutoff) || 0) - previousCutoff);
}

function pondTierWeights(luckMultiplier = 1, deepWaterLevel = 0, baitMultiplier = 1, stillWatersLevel = 0, deepCurrentLevel = 0) {
  const multiplier = Math.max(1, Number(luckMultiplier) || 1);
  const rarityBonus = 1 + Math.max(0, Number(deepWaterLevel) || 0) * POND_DEEP_WATER_BONUS_PER_LEVEL;
  const baitRarityBonus = Math.max(1, Number(baitMultiplier) || 1);
  const tiers = TIERS.filter((entry) => ['common', 'uncommon', 'rare', 'epic', 'legendary'].includes(entry.id));
  let nonCommonTotal = 0;
  const rows = [];
  for (const tier of tiers) {
    const base = tierBaseProbability(tier);
    const weight = tier.id === 'common' ? 0 : base * multiplier * rarityBonus * baitRarityBonus * (1 + Math.max(0, Math.min(3, Number(deepCurrentLevel) || 0)) * 0.10);
    if (tier.id !== 'common') nonCommonTotal += weight;
    rows.push({ tier, weight });
  }
  const commonBase = Math.max(0, 1 - nonCommonTotal);
  const common = commonBase * Math.max(0, 1 - Math.max(0, Math.min(3, Number(stillWatersLevel) || 0)) * POND_STILL_WATERS_BONUS_PER_LEVEL);
  const commonRow = rows.find((row) => row.tier.id === 'common');
  if (commonRow) commonRow.weight = common;
  const total = rows.reduce((sum, row) => sum + row.weight, 0) || 1;
  return new Map(rows.map((row) => [row.tier.id, row.weight / total]));
}

async function pondLuckMultiplier(user, speciesHunterLevel = null, familiarity = null) {
  const u = cleanUser(user);
  if (speciesHunterLevel == null || familiarity == null) {
    const perkState = normalizePondTreasuryPerks(await readJson(pondKeys(u).treasuryPerks, {}));
    speciesHunterLevel = perkState.speciesHunter;
    familiarity = await readJson(pondKeys(u).familiarity, {});
  }
  const keys = {
    custom: `luck:${u}`, perm: `perm_luck:${u}`, temp: `temp_luck:${u}`,
    shop: `shop_luck:${u}`, shopToggle: `toggle:luck125:${u}`,
    permToggle: `toggle:perm:${u}`, tempToggle: `toggle:temp:${u}`,
    event: 'global:event_luck', eventExpires: 'global:event_expires', eventToggle: `toggle:event:${u}`,
    vip: `game_vip:${u}`, vipToggle: `toggle:vip:${u}`
  };
  const raw = await Promise.all(Object.values(keys).map((key) => db.get(key).catch(() => null)));
  const state = Object.fromEntries(Object.keys(keys).map((key, i) => [key, raw[i]]));
  let multiplier = 1;
  const custom = Number.parseFloat(state.custom);
  if (Number.isFinite(custom)) multiplier = Math.max(1, custom);
  else if (state.vip === 'true' && state.vipToggle !== 'off') multiplier = 1.5;
  if (state.perm && state.permToggle !== 'off') multiplier *= 1.5;
  if (state.temp && state.tempToggle !== 'off') multiplier *= 2;
  if (state.shop && state.shopToggle !== 'off') multiplier *= 1.25;
  const eventExpires = Number(state.eventExpires) || 0;
  const event = Number.parseFloat(state.event);
  if (state.eventToggle !== 'off' && Number.isFinite(event) && event > 1 && (!eventExpires || Date.now() < eventExpires)) multiplier *= event;
  const fishdexCount = await getFishdexFishCount(u);
  multiplier += speciesHunterBonus(speciesHunterLevel, fishdexCount);
  return Number(multiplier.toFixed(2));
}

// Fisherman's Fortune's uncaught boost for the Pond. Same rules as !fish: the
// boost applies only to fish the viewer has not caught yet, keyed `Name [TIER]`.
async function pondUncaughtBoost(user) {
  const u = cleanUser(user);
  return fortuneUncaughtBoost(u, await fortuneStatus(u));
}

async function randomFish(user, selected, upgrades = {}, luckMultiplier = null, featureUpgrades = {}, familiarity = {}, baitMultiplier = 1, treasuryPerks = {}, uncaughtBoost = null) {
  const pool = pondFishCatalog().map((fish) => fish.name);
  if (!pool.length) return null;
  const selectedSet = new Set(normalizeFishList(selected));
  const luck = luckMultiplier == null ? await pondLuckMultiplier(user) : Number(luckMultiplier) || 1;
  const features = normalizeFeatureUpgrades(featureUpgrades);
  const treasuryPerksState = normalizePondTreasuryPerks(treasuryPerks);
  const tierWeights = pondTierWeights(luck * (1 + features.luckyWater * POND_LUCKY_WATER_BONUS_PER_LEVEL), features.deepWater, baitMultiplier, treasuryPerksState.stillWaters, treasuryPerksState.deepCurrent);
  const weighted = pool.map((name) => {
    const tier = FISH_BY_NAME.get(name);
    const tierWeight = tierWeights.get(tier?.id) || 0;
    const tierCount = Math.max(1, tier?.items?.length || 1);
    const collectorBonus = !Number(familiarity?.[name]) ? 1 + POND_COLLECTOR_BONUS[treasuryPerksState.collectorInstinct] : 1;
    const individual = pondFishWeight(name, selectedSet, upgrades) * familiarityWeight(name, familiarity, features.familiarity) * collectorBonus;
    const uncaught = uncaughtWeightFor(uncaughtBoost, `${name} [${tier?.name}]`);
    return { name, weight: (tierWeight / tierCount) * individual * uncaught };
  }).filter((entry) => entry.weight > 0);

  if (!weighted.length) return pool[0];
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll < 0) return entry.name;
  }
  return weighted[weighted.length - 1].name;
}

async function pondTreasuryRollSettings(user) {
  const u = cleanUser(user);
  const [config, progression, treasuryValues] = await Promise.all([
    getAutoFishConfig(),
    readProgression(u),
    db.mget([shopKey('treasuryLuck', u), `toggle:treasuryLuck:${u}`])
  ]);
  const autoState = await readAutoFishState(u, config);
  const prestige = Math.max(0, Math.min(5, parseInt(autoState.prestige, 10) || 0));
  const treasuryLuckOn = !!treasuryValues?.[0] && treasuryValues?.[1] !== 'off';
  const treasuryMultiplier = (treasuryLuckOn ? 1.5 : 1) * 12 + prestige * 0.5;
  const rodWeight = 1 + Math.max(0, Number(progression?.rod?.bonus) || 0);
  const treasuryTier = TIERS.find((tier) => tier.id === 'treasury');
  const basePct = Math.max(0, Number(treasuryTier?.basePct) || 2);
  const chance = Math.max(0, Math.min(1, basePct * treasuryMultiplier * rodWeight / 100));
  const pool = treasuryPondPool(TIERS);
  const totalWeight = pool.reduce((sum, item) => sum + fishWeight('treasury', item), 0) || 1;
  return { chance, pool, totalWeight, treasuryMultiplier, rodWeight, prestige, treasuryLuckOn };
}

function weightedTreasuryPondPick(settings) {
  const pool = Array.isArray(settings?.pool) ? settings.pool : treasuryPondPool(TIERS);
  const weighted = pool.map((name) => ({ name, weight: fishWeight('treasury', name) }))
    .filter((entry) => entry.weight > 0);
  if (!weighted.length) return null;
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll < 0) return entry.name;
  }
  return weighted[weighted.length - 1].name;
}

function pondTreasuryFishFinder(settings) {
  if (!settings) return [];
  const totalWeight = Math.max(1, Number(settings.totalWeight) || 1);
  return (settings.pool || []).map((name) => ({
    name,
    tier: 'TREASURY',
    weight: fishWeight('treasury', name),
    chance: Number(settings.chance || 0) * fishWeight('treasury', name) / totalWeight,
    bonusPercent: 0,
    selectedBonusPercent: 0,
    upgradeBonusPercent: 0,
    familiarityBonusPercent: 0,
    baitBonusPercent: 0,
    collectorBonusPercent: 0
  }));
}

async function consumePondBaitLocked(user, slots, baitSaverLevel = 0) {
  const active = normalizeBaitSlots(slots, slots.length);
  if (!active.length) return { id: 'worm', multiplier: 1, consumed: false };
  const available = [];
  for (const id of active) {
    const bait = baitFor(id);
    if (bait.id === 'worm') available.push({ bait, count: Infinity });
    else {
      const count = Number(await db.get(`${progressionKeys(user).baitPrefix}:${bait.id}`)) || 0;
      if (count > 0) available.push({ bait, count });
    }
  }
  if (!available.length) return { id: 'worm', multiplier: 1, consumed: false };
  const chosen = available[Math.floor(Math.random() * available.length)].bait;
  if (chosen.id !== 'worm') {
    const saveChance = Math.max(0, Math.min(25, Number(baitSaverLevel) * 5)) / 100;
    if (Math.random() < saveChance) return { id: chosen.id, multiplier: chosen.multiplier, consumed: false, saved: true };
    await db.incrby(`${progressionKeys(user).baitPrefix}:${chosen.id}`, -1);
    return { id: chosen.id, multiplier: chosen.multiplier, consumed: true, saved: false };
  }
  return { id: chosen.id, multiplier: 1, consumed: false };
}

async function pondActiveBaitOptions(user, baitSlots) {
  const active = normalizeBaitSlots(baitSlots, baitSlots.length);
  if (!active.length) return [{ id: 'worm', name: 'Worm Bait', multiplier: 1, slots: 0 }];
  const available = [];
  for (const id of active) {
    const bait = baitFor(id);
    if (bait.id === 'worm') {
      available.push({ id: bait.id, name: bait.name, multiplier: Number(bait.multiplier) || 1 });
      continue;
    }
    const count = Number(await db.get(`${progressionKeys(user).baitPrefix}:${bait.id}`)) || 0;
    if (count > 0) available.push({ id: bait.id, name: bait.name, multiplier: Number(bait.multiplier) || 1 });
  }
  return available.length ? available : [{ id: 'worm', name: 'Worm Bait', multiplier: 1 }];
}

async function pondRollPreview(user, selected, upgrades, featureUpgrades, familiarity, luckMultiplier, baitSlots = [], treasuryPerks = {}, uncaughtBoost = null) {
  const features = normalizeFeatureUpgrades(featureUpgrades);
  if (features.fishFinder < 1) return [];
  const selectedSet = new Set(normalizeFishList(selected));
  const baitOptions = await pondActiveBaitOptions(user, baitSlots);
  const perkState = normalizePondTreasuryPerks(treasuryPerks);
  const baitChance = 1 / Math.max(1, baitOptions.length);
  const rows = pondFishCatalog().map((fish) => {
    const tier = FISH_BY_NAME.get(fish.name);
    const tierCount = Math.max(1, tier?.items?.length || 1);
    const selectedBonusPercent = selectedSet.has(fish.name) ? POND_SELECTED_WEIGHT_BONUS * 100 : 0;
    const upgradeLevel = Math.max(0, Math.min(POND_FISH_MAX_UPGRADES, Number(upgrades?.[fish.name]) || 0));
    const upgradeBonusPercent = upgradeLevel * 50;
    const catches = Math.max(0, Number(familiarity?.[fish.name]) || 0);
    const familiarityBonusPercent = features.familiarity ? Math.min(features.familiarity * 10, Math.floor(catches / POND_FAMILIARITY_STEP)) : 0;
    const collectorBonusPercent = !catches ? pondCollectorBonusPercent(perkState.collectorInstinct) : 0;
    const fishBonusMultiplier = (1 + selectedBonusPercent / 100 + upgradeBonusPercent / 100 + familiarityBonusPercent / 100) * (1 + collectorBonusPercent / 100)
      * uncaughtWeightFor(uncaughtBoost, `${fish.name} [${tier?.name}]`);

    // Pond bait is selected from the currently usable bait slots at roll time.
    // Preview the exact expected chance across those same active choices so the
    // Fish Finder reflects the real server-side roll rather than ignoring bait.
    let chance = 0;
    let weight = 0;
    for (const bait of baitOptions) {
      const tierWeights = pondTierWeights(
        (Number(luckMultiplier) || 1) * (1 + features.luckyWater * POND_LUCKY_WATER_BONUS_PER_LEVEL),
        features.deepWater,
        bait.multiplier,
        perkState.stillWaters,
        perkState.deepCurrent
      );
      const tierWeight = tierWeights.get(tier?.id) || 0;
      const fishWeight = (tierWeight / tierCount) * fishBonusMultiplier;
      const baitTotal = pondFishCatalog().reduce((sum, other) => {
        const otherTier = FISH_BY_NAME.get(other.name);
        const otherTierCount = Math.max(1, otherTier?.items?.length || 1);
        const otherSelected = selectedSet.has(other.name) ? POND_SELECTED_WEIGHT_BONUS * 100 : 0;
        const otherUpgrade = Math.max(0, Math.min(POND_FISH_MAX_UPGRADES, Number(upgrades?.[other.name]) || 0)) * 50;
        const otherCatches = Math.max(0, Number(familiarity?.[other.name]) || 0);
        const otherFamiliarity = features.familiarity ? Math.min(features.familiarity * 10, Math.floor(otherCatches / POND_FAMILIARITY_STEP)) : 0;
        const otherCollector = !otherCatches ? 1 + POND_COLLECTOR_BONUS[perkState.collectorInstinct] : 1;
        const otherBonus = (1 + otherSelected / 100 + otherUpgrade / 100 + otherFamiliarity / 100) * otherCollector
          * uncaughtWeightFor(uncaughtBoost, `${other.name} [${otherTier?.name}]`);
        return sum + ((tierWeights.get(otherTier?.id) || 0) / otherTierCount) * otherBonus;
      }, 0) || 1;
      chance += (fishWeight / baitTotal) * baitChance;
      weight += fishWeight * baitChance;
    }
    return {
      name: fish.name, tier: fish.tier, weight, chance,
      selectedBonusPercent, upgradeBonusPercent, familiarityBonusPercent, collectorBonusPercent,
      baitOptions: baitOptions.map((bait) => ({ id: bait.id, name: bait.name, multiplier: bait.multiplier })),
      baitBonusPercent: Math.round((baitOptions.reduce((sum, bait) => sum + (bait.multiplier - 1) * 100, 0) / baitOptions.length) * 10) / 10,
      bonusPercent: (fishBonusMultiplier - 1) * 100
    };
  });
  return rows.sort((a, b) => b.weight - a.weight);
}

export function pondFishCatalog() {
  return NORMAL_TIERS.flatMap((tier) => tier.items.map((name) => ({
    name,
    tier: tier.name,
    tokenValue: TOKEN_VALUES[tier.name] || 0,
    unlockCost: FISH_UNLOCK_COSTS[tier.name] ?? 0
  })));
}

async function settlePondLocked(u, now = Date.now()) {
  const k = pondKeys(u);
  if (await db.get(k.unlocked) !== 'true') return { spawned: 0, pending: [] };
  const level = Math.max(1, Math.min(POND_MAX_LEVEL, Number(await db.get(k.level)) || 1));
  const featureUpgrades = normalizeFeatureUpgrades(await readJson(k.featureUpgrades, {}));
  const baitSlots = normalizeBaitSlots(await readJson(k.baitSlots, []), featureUpgrades.baitSlots);
  const familiarity = await readJson(k.familiarity, {});
  const treasuryPerksState = await getActivePondTreasuryPerks(u);
  const treasuryPerks = treasuryPerksState.activeLevels;
  const treasuryModeOn = level >= POND_TREASURY_MODE_LEVEL && Number(treasuryPerks[POND_TREASURY_MODE_ID]) > 0;
  const livePrices = await getPrices(db);
  const intervalSeconds = pondEffectiveIntervalSeconds(level, treasuryPerks.deepCurrent);
  let selected = normalizeFishList(await readJson(k.selected, []));
  const upgrades = await readJson(k.fishUpgrades, {});
  if (!selected.length) {
    const common = NORMAL_TIERS.find((tier) => tier.id === 'common');
    selected = [common?.items?.[0] || 'Common Carp'];
    await saveJson(k.selected, selected);
  }

  let pending = await readJson(k.pending, []);
  const luckMultiplier = treasuryModeOn ? 1 : await pondLuckMultiplier(u, treasuryPerks.speciesHunter, familiarity);
  if (!Array.isArray(pending)) pending = [];
  let nextSpawn = Number(await db.get(k.nextSpawn)) || (now + intervalSeconds * 1000);
  let spawned = 0;
  const baitUsed = [];
  let treasuryRollSettings = null;
  const uncaughtBoost = treasuryModeOn ? null : await pondUncaughtBoost(u);

  while (nextSpawn <= now && pending.length < pondLevelConfig(level).capacity) {
    if (treasuryModeOn) {
      // Match !fish Treasury Only semantics: a successful weighted Treasury
      // roll occupies a Pond slot; a miss is Mud and consumes no bait or slot.
      if (!treasuryRollSettings) treasuryRollSettings = await pondTreasuryRollSettings(u);
      if (Math.random() < treasuryRollSettings.chance) {
        const treasuryItem = weightedTreasuryPondPick(treasuryRollSettings);
        if (treasuryItem) {
          pending.push(treasuryItem);
          spawned++;
        }
      }
      nextSpawn += intervalSeconds * 1000;
      continue;
    }
    const bait = await consumePondBaitLocked(u, baitSlots, treasuryPerks.baitSaver);
    const fish = await randomFish(u, selected, upgrades, luckMultiplier, featureUpgrades, familiarity, bait.multiplier, treasuryPerks, uncaughtBoost);
    pending.push(fish);
    baitUsed.push(bait.id);
    spawned++;
    nextSpawn += intervalSeconds * 1000;
  }

  if (pending.length >= pondLevelConfig(level).capacity && nextSpawn <= now) nextSpawn = now + intervalSeconds * 1000;

  await Promise.all([
    saveJson(k.pending, pending),
    db.set(k.nextSpawn, String(nextSpawn))
  ]);
  return { spawned, pending, nextSpawn, baitUsed };
}

async function settlePond(user, now = Date.now()) {
  const u = cleanUser(user);
  return withKeyLock(db, `pond:${u}`, () => settlePondLocked(u, now));
}

export async function unlockPond(user, prestige) {
  const u = cleanUser(user);
  const p = Number(prestige) || 0;
  if (p < POND_UNLOCK_PRESTIGE) return { success: false, error: 'The Personal Pond unlocks at Prestige 1.' };
  const k = pondKeys(u);
  if (await db.get(k.unlocked) === 'true') return { success: false, error: 'Your Personal Pond is already unlocked.' };
  const common = NORMAL_TIERS.find((tier) => tier.id === 'common');
  const firstFish = common?.items?.includes('Common Carp') ? 'Common Carp' : common?.items?.[0];
  await Promise.all([
    db.set(k.unlocked, 'true'),
    db.set(k.level, '1'),
    saveJson(k.selected, firstFish ? [firstFish] : []),
    saveJson(k.pending, []),
    saveJson(k.stash, []),
    db.set(k.nextSpawn, String(Date.now() + POND_BASE_INTERVAL_SECONDS * 1000)),
    saveJson(k.fishUnlocked, firstFish ? [firstFish] : []),
    saveJson(k.fishUpgrades, {}),
    saveJson(k.featureUpgrades, normalizeFeatureUpgrades({})),
    saveJson(k.baitSlots, []),
    saveJson(k.familiarity, {}),
    saveJson(k.treasuryPerks, {})
  ]);
  return { success: true, message: 'Personal Pond unlocked.', fish: firstFish };
}

export async function pondStatus(user, prestige, { includeInventory = true } = {}) {
  const u = cleanUser(user);
  const p = Number(prestige) || 0;
  const k = pondKeys(u);
  const unlocked = await db.get(k.unlocked) === 'true';
  if (!unlocked && p >= POND_UNLOCK_PRESTIGE) await unlockPond(u, p);
  const now = Date.now();
  await settlePond(u, now);
  const [levelRaw, selectedRaw, pendingRaw, stashRaw, nextSpawnRaw, tokenRaw, unlockedFishRaw, fishUpgradesRaw, featureUpgradesRaw, baitSlotsRaw, familiarityRaw, treasuryPerksRaw] = await Promise.all([
    db.get(k.level), readJson(k.selected, []), readJson(k.pending, []), readJson(k.stash, []), db.get(k.nextSpawn), db.get(k.tokens), readJson(k.fishUnlocked, []), readJson(k.fishUpgrades, {}), readJson(k.featureUpgrades, {}), readJson(k.baitSlots, []), readJson(k.familiarity, {}), readJson(k.treasuryPerks, {})
  ]);
  const level = Math.max(1, Math.min(POND_MAX_LEVEL, Number(levelRaw) || 1));
  const cfg = pondLevelConfig(level);
  const treasuryPerksState = await getActivePondTreasuryPerks(u, treasuryPerksRaw);
  const treasuryPerks = treasuryPerksState.activeLevels;
  const ownedTreasuryPerks = treasuryPerksState.levels;
  const effectiveIntervalSeconds = pondEffectiveIntervalSeconds(level, treasuryPerks.deepCurrent);
  let inventory = [];
  if (includeInventory) {
    const items = await db.lrange(`fish:rares:${u}`, 0, -1);
    const counts = new Map();
    for (const item of items || []) {
      if (isTreasuryItem(item)) continue;
      const value = fishyTokenValue(item);
      if (value <= 0) continue;
      const itemTier = tierForInventoryItem(item);
      const entry = counts.get(item) || { item, count: 0, tokenValue: value, tier: itemTier.name, tierId: itemTier.id };
      entry.count++;
      counts.set(item, entry);
    }
    inventory = [...counts.values()];
  }
  const selected = normalizeFishList(selectedRaw);
  const unlockedFish = normalizeFishList(unlockedFishRaw);
  const fishUpgrades = {};
  for (const fish of unlockedFish) fishUpgrades[fish] = Math.max(0, Math.min(POND_FISH_MAX_UPGRADES, Number(fishUpgradesRaw?.[fish]) || 0));
  const stash = Array.isArray(stashRaw) ? stashRaw.filter((item) => FISH_BY_NAME.has(item)) : [];
  const featureUpgrades = normalizeFeatureUpgrades(featureUpgradesRaw);
  const baitSlots = normalizeBaitSlots(baitSlotsRaw, featureUpgrades.baitSlots);
  const familiarity = familiarityRaw && typeof familiarityRaw === 'object' && !Array.isArray(familiarityRaw) ? familiarityRaw : {};
  const livePrices = await getPrices(db);
  const featureInfo = Object.fromEntries(Object.keys(POND_FEATURES).map((id) => [id, featureUpgradeInfo(id, featureUpgrades[id], livePrices)]));
  const treasuryModeActive = level >= POND_TREASURY_MODE_LEVEL && Number(treasuryPerks[POND_TREASURY_MODE_ID]) > 0;
  const treasuryRollSettings = treasuryModeActive ? await pondTreasuryRollSettings(u) : null;
  const normalLuck = treasuryModeActive ? 1 : await pondLuckMultiplier(u, treasuryPerks.speciesHunter, familiarity);
  const finder = treasuryModeActive
    ? (Number(featureUpgrades.fishFinder) > 0 ? pondTreasuryFishFinder(treasuryRollSettings) : [])
    : await pondRollPreview(u, selected, fishUpgrades, featureUpgrades, familiarity, normalLuck, baitSlots, treasuryPerks, await pondUncaughtBoost(u));
  const baitCounts = {};
  await Promise.all(BAITS.map(async (bait) => { baitCounts[bait.id] = bait.id === 'worm' ? '∞' : (Number(await db.get(`${progressionKeys(u).baitPrefix}:${bait.id}`)) || 0); }));
  return {
    unlocked: true,
    chatUnlocked: await db.get(k.chatUnlocked) === 'true',
    level,
    capacity: cfg.capacity,
    intervalSeconds: effectiveIntervalSeconds,
    nextUpgradeCost: cfg.nextUpgradeCost,
    nextSpawnAt: Number(nextSpawnRaw) || now + effectiveIntervalSeconds * 1000,
    pending: Array.isArray(pendingRaw) ? pendingRaw.filter((item) => FISH_BY_NAME.has(item) || TREASURY_ITEM_NAMES.has(String(item))) : [],
    stash,
    selected,
    unlockedFish,
    fishUpgrades,
    fishMaxUpgrades: POND_FISH_MAX_UPGRADES,
    fishUpgradeCosts: POND_FISH_UPGRADE_COSTS,
    luckMultiplier: normalLuck,
    featureUpgrades,
    featureInfo,
    baitSlots,
    baitInventory: baitCounts,
    familiarity,
    familiarityStep: POND_FAMILIARITY_STEP,
    familiarityBonusPerStep: POND_FAMILIARITY_BONUS_PER_STEP,
    treasuryPerks: ownedTreasuryPerks,
    treasuryPerkToggles: treasuryPerksState.toggles,
    activeTreasuryPerks: treasuryPerks,
    speciesHunterFishdexCount: await getFishdexFishCount(u),
    treasuryPerkInfo: Object.fromEntries(Object.keys(POND_TREASURY_PERKS).map((id) => [id, pondTreasuryPerkInfo(id, ownedTreasuryPerks[id], livePrices)])),
    fishFinder: finder,
    selectedWeightBonus: POND_SELECTED_WEIGHT_BONUS * 100,
    tokens: Math.max(0, Number(tokenRaw) || 0),
    inventory,
    catalog: treasuryModeActive ? pondTreasuryCatalog() : pondFishCatalog(),
    treasuryCatalog: pondTreasuryCatalog(),
    treasuryItemNames: [...TREASURY_ITEM_NAMES],
    treasuryModeActive,
    treasuryModeUnlockLevel: POND_TREASURY_MODE_LEVEL,
    treasuryCatchChance: Number(treasuryRollSettings?.chance) || 0,
    treasuryMudChance: treasuryModeActive ? 1 - (Number(treasuryRollSettings?.chance) || 0) : 0,
    now
  };
}

export async function unlockPondFish(user, prestige, fishName) {
  const u = cleanUser(user);
  if ((Number(prestige) || 0) < POND_UNLOCK_PRESTIGE) return { success: false, error: 'The Personal Pond unlocks at Prestige 1.' };
  const k = pondKeys(u);
  if (await db.get(k.unlocked) !== 'true') await unlockPond(u, prestige);
  const tier = FISH_BY_NAME.get(String(fishName));
  if (!tier) return { success: false, error: 'That fish is not in the normal pond loot table.' };
  return withKeyLock(db, `pond:${u}`, async () => {
    const unlocked = normalizeFishList(await readJson(k.fishUnlocked, []));
    if (unlocked.includes(fishName)) return { success: true, alreadyOwned: true, fish: fishName };
    const cost = FISH_UNLOCK_COSTS[tier.name] ?? 0;
    const tokens = Number(await db.get(k.tokens)) || 0;
    if (tokens < cost) return { success: false, error: `Not enough FishyTokens. You need ${cost} to unlock ${fishName}, but you have ${tokens}.` };
    if (cost > 0) await db.incrby(k.tokens, -cost);
    unlocked.push(fishName);
    await saveJson(k.fishUnlocked, unlocked);
    return { success: true, fish: fishName, cost, tokens: tokens - cost };
  });
}

export async function upgradePondFish(user, prestige, fishName) {
  const u = cleanUser(user);
  if ((Number(prestige) || 0) < POND_UNLOCK_PRESTIGE) return { success: false, error: 'The Personal Pond unlocks at Prestige 1.' };
  const k = pondKeys(u);
  const tier = FISH_BY_NAME.get(String(fishName));
  if (!tier) return { success: false, error: 'That fish is not in the normal pond loot table.' };
  return withKeyLock(db, `pond:${u}`, async () => {
    const unlocked = new Set(normalizeFishList(await readJson(k.fishUnlocked, [])));
    if (!unlocked.has(String(fishName))) return { success: false, error: 'Unlock that fish before upgrading it.' };
    const upgrades = await readJson(k.fishUpgrades, {});
    const current = Math.max(0, Math.min(POND_FISH_MAX_UPGRADES, Number(upgrades?.[fishName]) || 0));
    if (current >= POND_FISH_MAX_UPGRADES) return { success: false, error: `${fishName} is already fully upgraded.` };
    const cost = Number(POND_FISH_UPGRADE_COSTS[tier.name]?.[current]) || 0;
    const tokens = Number(await db.get(k.tokens)) || 0;
    if (tokens < cost) return { success: false, error: `Not enough FishyTokens. You need ${cost} to upgrade ${fishName}, but you have ${tokens}.` };
    await db.incrby(k.tokens, -cost);
    upgrades[fishName] = current + 1;
    await saveJson(k.fishUpgrades, upgrades);
    return { success: true, fish: fishName, level: current + 1, weightBonus: (current + 1) * 50, weightMultiplier: 1 + (current + 1) * 0.50, cost, tokens: tokens - cost };
  });
}

export async function setPondFish(user, prestige, fishNames) {
  const u = cleanUser(user);
  if ((Number(prestige) || 0) < POND_UNLOCK_PRESTIGE) return { success: false, error: 'The Personal Pond unlocks at Prestige 1.' };
  const k = pondKeys(u);
  const unlocked = new Set(normalizeFishList(await readJson(k.fishUnlocked, [])));
  const wanted = normalizeFishList(fishNames).filter((name) => unlocked.has(name));
  if (!wanted.length) return { success: false, error: 'Choose at least one unlocked fish.' };
  const level = Math.max(1, Math.min(POND_MAX_LEVEL, Number(await db.get(k.level)) || 1));
  const maxFish = Math.min(3, level);
  if (wanted.length > maxFish) return { success: false, error: `Your pond can use ${maxFish} fish choice${maxFish === 1 ? '' : 's'} at Level ${level}.` };
  return withKeyLock(db, `pond:${u}`, async () => {
    await saveJson(k.selected, wanted);
    return { success: true, selected: wanted };
  });
}


export async function upgradePondFeature(user, prestige, featureId) {
  const u = cleanUser(user);
  if ((Number(prestige) || 0) < POND_UNLOCK_PRESTIGE) return { success: false, error: 'The Personal Pond unlocks at Prestige 1.' };
  const cfg = POND_FEATURES[String(featureId || '')];
  if (!cfg) return { success: false, error: 'Unknown pond feature.' };
  const k = pondKeys(u);
  return withKeyLock(db, `pond:${u}`, async () => {
    const currentState = normalizeFeatureUpgrades(await readJson(k.featureUpgrades, {}));
    const current = Number(currentState[String(featureId)] || 0);
    if (current >= cfg.max) return { success: false, error: `${cfg.label} is already fully upgraded.` };
    const cost = Number(cfg.costs[current]) || 0;
    const tokens = Number(await db.get(k.tokens)) || 0;
    if (tokens < cost) return { success: false, error: `Not enough FishyTokens. You need ${cost} to upgrade ${cfg.label}, but you have ${tokens}.` };
    currentState[String(featureId)] = current + 1;
    await db.incrby(k.tokens, -cost);
    await saveJson(k.featureUpgrades, currentState);
    return { success: true, feature: String(featureId), level: current + 1, cost, tokens: tokens - cost, featureInfo: featureUpgradeInfo(String(featureId), current + 1) };
  });
}

export async function setPondBaitSlots(user, prestige, baitSlots) {
  const u = cleanUser(user);
  if ((Number(prestige) || 0) < POND_UNLOCK_PRESTIGE) return { success: false, error: 'The Personal Pond unlocks at Prestige 1.' };
  const k = pondKeys(u);
  const features = normalizeFeatureUpgrades(await readJson(k.featureUpgrades, {}));
  const slots = normalizeBaitSlots(baitSlots, features.baitSlots);
  if (slots.length > features.baitSlots) return { success: false, error: `Upgrade Bait Slots first to use ${slots.length} slots.` };
  await saveJson(k.baitSlots, slots);
  return { success: true, baitSlots: slots };
}

export async function upgradePond(user, prestige) {
  const u = cleanUser(user);
  if ((Number(prestige) || 0) < POND_UNLOCK_PRESTIGE) return { success: false, error: 'The Personal Pond unlocks at Prestige 1.' };
  const k = pondKeys(u);
  return withKeyLock(db, `pond:${u}`, async () => {
    const now = Date.now();
    // Settle first so an upgrade cannot accidentally erase a fish that became
    // due while the player was upgrading. This runs inside the existing pond
    // lock so the timer cannot race with another pond action.
    await settlePondLocked(u, now);
    const level = Math.max(1, Math.min(POND_MAX_LEVEL, Number(await db.get(k.level)) || 1));
    const cfg = pondLevelConfig(level);
    if (!cfg.nextUpgradeCost) return { success: false, error: 'Your pond is fully upgraded.' };
    const tokens = Number(await db.get(k.tokens)) || 0;
    if (tokens < cfg.nextUpgradeCost) return { success: false, error: `Not enough FishyTokens. You need ${cfg.nextUpgradeCost} to upgrade your pond, but you have ${tokens}.` };

    const oldNextSpawn = Number(await db.get(k.nextSpawn)) || (now + cfg.intervalSeconds * 1000);
    const oldRemaining = Math.max(0, oldNextSpawn - now);
    const oldInterval = cfg.intervalSeconds * 1000;
    const progress = oldInterval > 0 ? Math.max(0, Math.min(1, 1 - (oldRemaining / oldInterval))) : 0;
    const nextLevel = level + 1;
    const nextCfg = pondLevelConfig(nextLevel);
    const nextRemaining = Math.max(1000, Math.round(nextCfg.intervalSeconds * 1000 * (1 - progress)));

    await db.incrby(k.tokens, -cfg.nextUpgradeCost);
    await db.set(k.level, String(nextLevel));
    // Preserve the current timer progress while applying the shorter new
    // interval. This prevents upgrading from resetting/stalling the pond timer.
    await db.set(k.nextSpawn, String(now + nextRemaining));
    const selected = normalizeFishList(await readJson(k.selected, []));
    if (selected.length < Math.min(3, nextLevel)) {
      const unlocked = normalizeFishList(await readJson(k.fishUnlocked, []));
      const next = unlocked.find((fish) => !selected.includes(fish));
      if (next) await saveJson(k.selected, [...selected, next]);
    }
    return { success: true, level: nextLevel, cost: cfg.nextUpgradeCost, tokens: tokens - cfg.nextUpgradeCost, nextSpawnAt: now + nextRemaining };
  });
}

export async function collectPond(user, { toInventory = false } = {}) {
  const u = cleanUser(user);
  const k = pondKeys(u);
  // Settle any fish whose timer has elapsed before collecting.
  await settlePond(u, Date.now());
  return withKeyLock(db, `pond:${u}`, async () => {
    if (await db.get(k.unlocked) !== 'true') return { success: false, error: 'Your Personal Pond is not unlocked.' };
    const rawPending = await readJson(k.pending, []);
    const pending = (Array.isArray(rawPending) ? rawPending : [])
      .filter((item) => FISH_BY_NAME.has(item) || TREASURY_ITEM_NAMES.has(String(item)));
    const normalPending = pending.filter((item) => FISH_BY_NAME.has(item));
    const treasuryPending = pending.filter((item) => TREASURY_ITEM_NAMES.has(String(item)));
    const treasuryPerksState = await getActivePondTreasuryPerks(u);
    const treasuryPerks = treasuryPerksState.activeLevels;
    if (!pending.length) return { success: true, count: 0, fish: [], tokens: Number(await db.get(k.tokens)) || 0 };
    const level = Math.max(1, Math.min(POND_MAX_LEVEL, Number(await db.get(k.level)) || 1));
    const haulExtra = Math.max(0, Math.min(3, treasuryPerks.biggerHaul));
    const haulFish = [...normalPending];
    for (let i = 0; i < haulExtra && normalPending.length; i++) haulFish.push(normalPending[i % normalPending.length]);

    // Treasury loot always goes to inventory as [TREASURY], even if it was
    // already pending when Treasury Waters was toggled off. It is never
    // converted to FishyTokens or mixed into the normal-fish stash.
    if (treasuryPending.length) {
      await addInventoryItems(db, u, treasuryPending.map((item) => `${item} [TREASURY]`));
    }
    if (toInventory && haulFish.length) {
      await addInventoryItems(db, u, haulFish.map((item) => `${item} [${FISH_BY_NAME.get(item)?.name || tierForInventoryItem(item).name}]`));
    } else if (haulFish.length) {
      const stash = (await readJson(k.stash, [])).filter((item) => FISH_BY_NAME.has(item));
      await saveJson(k.stash, [...stash, ...haulFish]);
    }
    await saveJson(k.pending, []);
    await db.set(k.nextSpawn, String(Date.now() + pondEffectiveIntervalSeconds(level, treasuryPerks.deepCurrent) * 1000));
    const familiarity = await readJson(k.familiarity, {});
    for (const item of haulFish) familiarity[item] = Math.max(0, Number(familiarity[item]) || 0) + 1;
    await saveJson(k.familiarity, familiarity);
    const collected = [...haulFish, ...treasuryPending];
    if (collected.length) await db.incrby(`pond:catches:${u}`, collected.length);
    return { success: true, count: collected.length, fish: collected, toInventory, normalCount: haulFish.length, treasuryCount: treasuryPending.length, baseCount: pending.length, bonusFish: Math.max(0, haulFish.length - normalPending.length) };
  });
}

export async function stashAction(user, action, items = null) {
  const u = cleanUser(user);
  const k = pondKeys(u);
  return withKeyLock(db, `pond:${u}`, async () => {
    const stash = (await readJson(k.stash, [])).filter((item) => FISH_BY_NAME.has(item));
    if (!stash.length) return { success: false, error: 'Your pond stash is empty.' };
    const wanted = items == null ? stash : normalizeFishList(items);
    const counts = new Map();
    for (const item of wanted) counts.set(item, (counts.get(item) || 0) + 1);
    const remaining = [...stash];
    const moved = [];
    for (const [item, count] of counts) {
      let left = count;
      for (let i = remaining.length - 1; i >= 0 && left > 0; i--) {
        if (remaining[i] === item) { moved.push(item); remaining.splice(i, 1); left--; }
      }
    }
    if (!moved.length) return { success: false, error: 'Those fish are not in your pond stash.' };
    const treasuryPerksState = await getActivePondTreasuryPerks(u);
    const treasuryPerks = treasuryPerksState.activeLevels;
    const livePrices = await getPrices(db);
    const fortuneLevel = treasuryPerks.fishyFortune;
    if (action === 'inventory') {
      await addInventoryItems(db, u, moved.map((item) => `${item} [${tierForInventoryItem(item).name}]`));
    } else if (action === 'tokens') {
      const value = moved.reduce((sum, item) => { const base = fishyTokenValue(item); const tier = FISH_BY_NAME.get(item)?.name; return sum + Math.round(base * pondFortuneMultiplier(fortuneLevel, tier)); }, 0);
      await db.incrby(k.tokens, value);
      await db.incrby(k.tokenTotal, value);
    } else {
      return { success: false, error: 'Unknown pond stash action.' };
    }
    await saveJson(k.stash, remaining);
    return { success: true, count: moved.length, value: moved.reduce((sum, item) => sum + fishyTokenValue(item), 0), action };
  });
}

export async function upgradePondTreasuryPerk(user, prestige, perkId) {
  const u = cleanUser(user);
  if ((Number(prestige) || 0) < POND_UNLOCK_PRESTIGE) return { success: false, error: 'The Personal Pond unlocks at Prestige 1.' };
  const cfg = POND_TREASURY_PERKS[String(perkId || '')];
  if (!cfg) return { success: false, error: 'Unknown Pond perk.' };
  const k = pondKeys(u);
  return withKeyLock(db, `shop-purchase:${u}`, async () => {
    const currentState = normalizePondTreasuryPerks(await readJson(k.treasuryPerks, {}));
    const current = currentState[String(perkId)] || 0;
    if (current >= cfg.max) return { success: false, error: `${cfg.label} is already fully upgraded.` };
    const cost = Number(cfg.costs[current]) || 0;
    const treasury = await getTreasuryBalance(db, u);
    if (treasury.balance < cost) return { success: false, error: `Not enough Treasury. You need ${cost} Treasury to upgrade ${cfg.label}, but you have ${treasury.balance}.` };
    if (cost > 0) {
      const removed = await removeInventoryItems(db, u, (entry) => isTreasuryItem(entry), cost, cost);
      if (removed.removed.length !== cost) return { success: false, error: `Not enough Treasury. You need ${cost} Treasury to upgrade ${cfg.label}, but you have ${removed.removed.length}.` };
      const afterItems = await db.lrange(`fish:rares:${u}`, 0, -1);
      const afterBalance = (afterItems || []).filter(isTreasuryItem).length;
      if (afterBalance !== treasury.balance - cost) return { success: false, error: 'Treasury inventory could not be updated safely. Please retry.' };
    }
    currentState[String(perkId)] = current + 1;
    await saveJson(k.treasuryPerks, currentState);
    return { success: true, perk: String(perkId), level: current + 1, cost, balance: treasury.balance - cost, perkInfo: pondTreasuryPerkInfo(String(perkId), current + 1) };
  });
}

export async function convertInventoryFish(user, item, count) {
  const u = cleanUser(user);
  const raw = String(item || '').trim();
  const wanted = raw.replace(/\s*[\[(][^\])]+[\])]\s*$/, '').trim();
  const wantedKey = wanted.toLowerCase();
  const amount = Math.max(1, Math.min(10000, Number(count) || 1));
  const tier = [...FISH_BY_NAME.entries()].find(([name]) => String(name).toLowerCase() === wantedKey)?.[1];
  if (!tier) return { success: false, error: 'That fish cannot be converted.' };
  if (!isConvertibleFish(`${tier.items.find((name) => String(name).toLowerCase() === wantedKey)} [${tier.name}]`)) return { success: false, error: 'That fish grants a perk and cannot be converted.' };
  return withKeyLock(db, `pond-convert:${u}`, async () => {
    const fullName = tier.items.find((name) => String(name).toLowerCase() === wantedKey);
    const fullKey = `${fullName} [${tier.name}]`.toLowerCase();
    const removed = await removeInventoryItems(db, u, (entry) => {
      const normalized = String(entry || '').trim().toLowerCase();
      const clean = normalized.replace(/\s*[\[(][^\])]+[\])]\s*$/, '').trim();
      return normalized === fullKey || (clean === wantedKey && normalized.endsWith(`[${tier.name.toLowerCase()}]`));
    }, amount, amount);
    if (removed.removed.length !== amount) return { success: false, error: `You do not have ${amount} × ${fullName}.` };
    const k = pondKeys(u);
    const treasuryPerksState = await getActivePondTreasuryPerks(u);
    const fortuneLevel = treasuryPerksState.activeLevels.fishyFortune;
    const value = Math.round(fishyTokenValue(`${fullName} [${tier.name}]`) * pondFortuneMultiplier(fortuneLevel, tier.name)) * amount;
    await db.incrby(k.tokens, value);
    await db.incrby(k.tokenTotal, value);
    return { success: true, count: amount, value, tokens: Number(await db.get(k.tokens)) || 0 };
  });
}

export async function enablePondChat(user, prestige) {
  const u = cleanUser(user);
  if ((Number(prestige) || 0) < POND_CHAT_UNLOCK_PRESTIGE) return { success: false, error: 'Pond chat collection unlocks at Prestige 2.' };
  const k = pondKeys(u);
  if (await db.get(k.unlocked) !== 'true') await unlockPond(u, prestige);
  await db.set(k.chatUnlocked, 'true');
  return { success: true, chatUnlocked: true };
}
