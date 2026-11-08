// Per-fish weights. Each weight is relative to the other fish in the same
// rarity. 100 is neutral; saved values from the desktop loot table override it.
// A weight of 0 keeps that fish out of normal rolls. A rarity whose saved
// weights are all zero falls back to neutral weights, so a roll never returns
// nothing.
import { TIERS } from './tiers.js';
import { LOOT_CONFIG, DEFAULT_WEIGHT, cleanWeight } from './loot-config.js';

export { DEFAULT_WEIGHT };
export const DEFAULT_FISH_WEIGHT = DEFAULT_WEIGHT;

const savedWeights = LOOT_CONFIG.weights && typeof LOOT_CONFIG.weights === 'object' ? LOOT_CONFIG.weights : {};

function tierWeights(tier) {
  const saved = savedWeights[tier.id] && typeof savedWeights[tier.id] === 'object' ? savedWeights[tier.id] : {};
  const items = (tier.items || []).map(String);
  const weights = Object.fromEntries(items.map((item) => [item, cleanWeight(saved[item], DEFAULT_WEIGHT)]));
  const anyRollable = Object.values(weights).some((value) => value > 0);
  if (!anyRollable) return Object.fromEntries(items.map((item) => [item, DEFAULT_WEIGHT]));
  return weights;
}

const byTier = Object.fromEntries(TIERS.map((tier) => [tier.id, tierWeights(tier)]));

for (const tier of Object.values(byTier)) Object.freeze(tier);
Object.freeze(byTier);

export const FISH_WEIGHTS = byTier;

export function fishWeight(tierId, itemName) {
  const value = FISH_WEIGHTS?.[tierId]?.[String(itemName)];
  return value === undefined ? DEFAULT_FISH_WEIGHT : cleanWeight(value, DEFAULT_FISH_WEIGHT);
}

export function fishWeightByName(itemName) {
  const name = String(itemName);
  for (const tier of TIERS) {
    if ((tier.items || []).some((item) => String(item) === name)) {
      return fishWeight(tier.id, name);
    }
  }
  return DEFAULT_FISH_WEIGHT;
}

export function fishTierForName(itemName) {
  const name = String(itemName);
  return TIERS.find((tier) => (tier.items || []).some((item) => String(item) === name)) || null;
}

export function fishWeightsForTier(tier) {
  return (tier?.items || []).map((item) => ({ item: String(item), weight: fishWeight(tier.id, item) }));
}

export function weightedFishPick(tier, modifier = null) {
  const options = fishWeightsForTier(tier)
    .map((entry) => ({
      ...entry,
      weight: entry.weight * (typeof modifier === 'function' ? Math.max(0, Number(modifier(entry.item, entry.weight)) || 0) : 1)
    }))
    .filter((entry) => entry.weight > 0);
  if (!options.length) return null;
  const total = options.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of options) {
    roll -= entry.weight;
    if (roll < 0) return entry.item;
  }
  return options[options.length - 1].item;
}

export function fishWeightTable(tier, modifier = null) {
  const rows = fishWeightsForTier(tier).map((entry) => {
    const modifierValue = typeof modifier === 'function'
      ? Math.max(0, Number(modifier(entry.item, entry.weight)) || 0)
      : 1;
    return { item: entry.item, baseWeight: entry.weight, liveWeight: entry.weight * modifierValue };
  }).filter((row) => row.liveWeight > 0);
  const total = rows.reduce((sum, row) => sum + row.liveWeight, 0) || 1;
  return rows.map((row) => ({ ...row, categoryChance: row.liveWeight / total }));
}

export function validateFishWeightCatalog() {
  const errors = [];
  for (const tier of TIERS) {
    for (const item of tier.items || []) {
      if (!(String(item) in (FISH_WEIGHTS[tier.id] || {}))) errors.push(`${tier.id}:${item}`);
    }
  }
  return errors;
}