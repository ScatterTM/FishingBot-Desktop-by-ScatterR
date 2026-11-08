// Fisherman's Fortune: a shop perk whose level grows with the user's total
// catches (manual + Auto-Fish + pond). Each level adds luck and boosts the
// weight of fish the user has not caught yet.
import { db } from './db.js';
import { shopKey } from './shop.js';
import { FISHDEX_FISH_KEYS } from './dexcatalog.js';
import { catchCountKey } from './inventory.js';

export const FORTUNE_ITEM = 'fishermansFortune';
export const FORTUNE_THRESHOLDS = [200, 370, 680, 1250, 2300, 4200, 7700, 14100, 19000, 25000];
export const FORTUNE_LUCK_PER_LEVEL = 0.05;
export const FORTUNE_UNCAUGHT_WEIGHT_PER_LEVEL = 0.05;

// Pond catches get their own total. They never touch the manual leaderboard counter.
export const pondCatchKey = (user) => `pond:catches:${user}`;

const toCount = (value) => Math.max(0, parseInt(value, 10) || 0);

export function fortuneLevelFor(total) {
  return FORTUNE_THRESHOLDS.filter((threshold) => total >= threshold).length;
}

export function fortuneProgress(total) {
  const level = fortuneLevelFor(total);
  const previous = level > 0 ? FORTUNE_THRESHOLDS[level - 1] : 0;
  const next = level < FORTUNE_THRESHOLDS.length ? FORTUNE_THRESHOLDS[level] : null;
  const percent = next === null
    ? 100
    : Math.max(0, Math.min(100, Math.floor(((total - previous) / (next - previous)) * 100)));
  return { level, maxLevel: FORTUNE_THRESHOLDS.length, nextAt: next, percent };
}

export async function fortuneTotals(userKey) {
  const [manual, auto, pond] = await Promise.all([
    db.get(`fish:count:${userKey}`).catch(() => null),
    db.get(`autofish:auto_casts:${userKey}`).catch(() => null),
    db.get(pondCatchKey(userKey)).catch(() => null)
  ]);
  const manualCount = toCount(manual);
  const autoCount = toCount(auto);
  const pondCount = toCount(pond);
  return { manual: manualCount, auto: autoCount, pond: pondCount, total: manualCount + autoCount + pondCount };
}

export async function fortuneStatus(userKey) {
  const [owned, toggle, totals] = await Promise.all([
    db.get(shopKey(FORTUNE_ITEM, userKey)).catch(() => null),
    db.get(`toggle:${FORTUNE_ITEM}:${userKey}`).catch(() => null),
    fortuneTotals(userKey)
  ]);
  const isOwned = !!owned;
  const toggleOn = toggle !== 'off';
  const progress = fortuneProgress(totals.total);
  const active = isOwned && toggleOn;
  return {
    owned: isOwned,
    toggleOn,
    active,
    catches: totals,
    level: progress.level,
    maxLevel: progress.maxLevel,
    nextAt: progress.nextAt,
    percent: progress.percent,
    luckAdd: active ? progress.level * FORTUNE_LUCK_PER_LEVEL : 0,
    uncaughtWeightMultiplier: active ? 1 + progress.level * FORTUNE_UNCAUGHT_WEIGHT_PER_LEVEL : 1
  };
}

export async function fortuneLuckAdd(userKey) {
  const status = await fortuneStatus(userKey);
  return status.luckAdd;
}

// Uncaught boost: for a viewer whose Fortune is active, fish they have not
// caught yet get a heavier weight. Returns null when there is nothing to apply.
// The caught set uses the same `Name [TIER]` keys the Fishdex stores counts
// under, so callers must pass the tier-qualified key to uncaughtWeightFor.
export async function fortuneUncaughtBoost(userKey, status = null) {
  const fortune = status || await fortuneStatus(userKey);
  if (!fortune.active || !(fortune.uncaughtWeightMultiplier > 1)) return null;
  const values = await db.mget(FISHDEX_FISH_KEYS.map((item) => catchCountKey(userKey, item))).catch(() => []);
  const caught = new Set(FISHDEX_FISH_KEYS.filter((_, i) => Number(values?.[i]) > 0));
  return { mult: fortune.uncaughtWeightMultiplier, caught };
}

// fishKey is `${name} [${tierName}]`. Returns the weight multiplier for that fish.
export function uncaughtWeightFor(boost, fishKey) {
  if (!boost) return 1;
  return boost.caught.has(fishKey) ? 1 : boost.mult;
}
