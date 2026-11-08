// The Fish Index catalog: the normal loot table (lib/tiers.js) plus every
// specialized catch from the fishing areas (lib/areas.js).
//
// Area fish are stored in inventory and catch history exactly like normal
// fish - "${name} [${TIER}]" - but they must NOT be added to lib/tiers.js,
// because !fish rolls its normal table straight from that file and would start
// handing out area fish everywhere. This module only feeds the Index and the
// leaderboard's collection progress, so adding an area or a new area fish
// updates both automatically.

import { TIERS } from './tiers.js';
import { FISHING_AREAS } from './areas.js';

// "Lionfish|RARE" -> { id, name, icon } of the area it can be caught in.
const AREA_SOURCE = new Map();
const EXTRA_BY_TIER = new Map();

for (const area of Object.values(FISHING_AREAS)) {
  for (const [itemName, tierName] of area.loot) {
    const tier = TIERS.find((t) => t.name === tierName);
    if (!tier) continue;
    const key = `${itemName}|${tier.name}`;
    // A fish that already exists in the normal table (same name, same tier)
    // is already in the Index; just remember that an area can drop it too.
    const inNormalTable = tier.items.includes(itemName);
    if (inNormalTable || AREA_SOURCE.has(key)) continue;
    if (!EXTRA_BY_TIER.has(tier.id)) EXTRA_BY_TIER.set(tier.id, []);
    EXTRA_BY_TIER.get(tier.id).push(itemName);
    AREA_SOURCE.set(key, { id: area.id, name: area.name, icon: area.icon });
  }
}

// Same shape as TIERS, with area fish appended to the end of their tier.
export const DEX_TIERS = TIERS
  .map((tier) => ({ ...tier, items: [...tier.items, ...(EXTRA_BY_TIER.get(tier.id) || [])] }));

export function areaSourceFor(itemName, tierName) {
  return AREA_SOURCE.get(`${itemName}|${tierName}`) || null;
}

export const DEX_KEYS = DEX_TIERS.flatMap((tier) => tier.items.map((itemName) => `${itemName} [${tier.name}]`));

// Fishdex entries that represent actual fish/creatures. Treasury rewards are
// part of the Fishdex UI, but they are loot items rather than fish and do not
// count toward Species Hunter. SECRET fish remain included.
export const FISHDEX_FISH_KEYS = DEX_TIERS
  .filter((tier) => tier.id !== 'treasury')
  .flatMap((tier) => tier.items.map((itemName) => `${itemName} [${tier.name}]`));
export const FISHDEX_FISH_TOTAL = FISHDEX_FISH_KEYS.length;

// The keys that count toward the Fish Index percentage. SECRET items are
// one-of-a-kind trophies, so the profile page leaves them out of the total;
// the leaderboard must use the exact same set or the two numbers disagree.
export const DEX_PROGRESS_KEYS = DEX_TIERS
  .filter((tier) => tier.id !== 'unique' && tier.name !== 'SECRET')
  .flatMap((tier) => tier.items.map((itemName) => `${itemName} [${tier.name}]`));
