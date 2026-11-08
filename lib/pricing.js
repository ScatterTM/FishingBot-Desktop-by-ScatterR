// Live, admin-editable prices. Defaults are kept in code so a fresh install
// behaves exactly as before; overrides live in the database and are read by
// purchase endpoints before money/items are removed.

export const DEFAULT_PRICES = Object.freeze({
  shop: Object.freeze({
    luck125: 80,
    cooldown: 45,
    treasuryLuck: 55,
    rarityBoost: 25,
    treasuryOnly: 0
  }),
  rods: Object.freeze({
    old: 0,
    sturdy: 50,
    deepwater: 150,
    master: 400,
    celestial: 1000
  }),
  bait: Object.freeze({
    worm: 0,
    minnow: 5,
    rare: 7,
    legend: 8
  }),
  pond: Object.freeze({
    speciesHunter: Object.freeze([10, 25, 50, 100, 175]),
    baitSaver: Object.freeze([15, 30, 50, 80, 125]),
    collectorInstinct: Object.freeze([25, 60, 125]),
    stillWaters: Object.freeze([30, 75, 150]),
    deepCurrent: Object.freeze([40, 90, 175]),
    biggerHaul: Object.freeze([20, 50, 100]),
    fishyFortune: Object.freeze([35, 75, 150])
  })
});

const KEY = 'config:shop:prices';

function cleanNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000000) return fallback;
  return Math.floor(n);
}

export function normalizePrices(raw = {}) {
  return {
    shop: Object.fromEntries(Object.entries(DEFAULT_PRICES.shop).map(([id, fallback]) => [id, cleanNumber(raw?.shop?.[id], fallback)])),
    rods: Object.fromEntries(Object.entries(DEFAULT_PRICES.rods).map(([id, fallback]) => [id, cleanNumber(raw?.rods?.[id], fallback)])),
    bait: Object.fromEntries(Object.entries(DEFAULT_PRICES.bait).map(([id, fallback]) => [id, cleanNumber(raw?.bait?.[id], fallback)])),
    pond: Object.fromEntries(Object.entries(DEFAULT_PRICES.pond).map(([id, fallback]) => [
      id, Array.from({ length: fallback.length }, (_, index) => cleanNumber(raw?.pond?.[id]?.[index], fallback[index]))
    ]))
  };
}

export function pondPerkPrice(prices, id, levelIndex, fallback = 0) {
  const list = prices?.pond?.[id];
  const index = Math.max(0, Number(levelIndex) || 0);
  const value = Array.isArray(list) ? list[index] : undefined;
  return Number.isFinite(Number(value)) ? Number(value) : Number(fallback) || 0;
}

export async function setPondPerkPrice(db, id, levelIndex, value) {
  const prices = await getPrices(db);
  if (!Object.prototype.hasOwnProperty.call(prices.pond, id)) throw new Error('Unknown Pond perk.');
  const index = Number(levelIndex);
  if (!Number.isInteger(index) || index < 0 || index >= prices.pond[id].length) throw new Error('Invalid Pond perk level.');
  const next = cleanNumber(value, NaN);
  if (!Number.isFinite(next)) throw new Error('Price must be a whole number from 0 to 1,000,000,000.');
  prices.pond[id][index] = next;
  await db.set(KEY, JSON.stringify(prices));
  return prices;
}

export async function getPrices(db) {
  if (!db) return normalizePrices();
  try {
    const raw = await db.get(KEY);
    if (!raw) return normalizePrices();
    return normalizePrices(JSON.parse(raw));
  } catch (_error) {
    return normalizePrices();
  }
}

export async function savePrices(db, raw = {}) {
  const prices = normalizePrices(raw);
  await db.set(KEY, JSON.stringify(prices));
  return prices;
}

export async function setPrice(db, category, id, value) {
  const prices = await getPrices(db);
  if (!Object.prototype.hasOwnProperty.call(prices, category) ||
      !Object.prototype.hasOwnProperty.call(prices[category], id)) {
    throw new Error('Unknown price target.');
  }
  const next = cleanNumber(value, NaN);
  if (!Number.isFinite(next)) throw new Error('Price must be a whole number from 0 to 1,000,000,000.');
  prices[category][id] = next;
  await db.set(KEY, JSON.stringify(prices));
  return prices;
}
