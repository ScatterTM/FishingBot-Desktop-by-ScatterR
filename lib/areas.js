// Fishing Areas: small specialized loot pools layered on top of the normal
// fishing table. An area never removes the normal fish table; it adds a chance
// to land one of its own catches and can boost a few existing fish.

import { LOOT_CONFIG } from './loot-config.js';

export const FISHING_AREAS = {
  forest: {
    id: 'forest', name: 'Whispering Forest', icon: 'i-leaf', unlockCost: 15,
    levelCosts: [10, 15, 20, 30],
    description: 'A quiet woodland stream full of freshwater life and old forest finds.',
    boost: { 'Forest Trout': 3, 'Koi': 2, 'bass': 2 },
    loot: [
      ['Forest Trout', 'UNCOMMON', 10], ['Mossback Carp', 'UNCOMMON', 9], ['Golden Minnow', 'RARE', 5],
      ['Spotted Bass', 'UNCOMMON', 9], ['River Crayfish', 'COMMON', 10], ['Mossback Turtle', 'RARE', 4],
      ['Wild Berry', 'COMMON', 12], ['Tree Sap', 'COMMON', 10], ['Forest Mushroom', 'COMMON', 10],
      ['Freshwater Pearl', 'EPIC', 2], ['Old Fishing Hook', 'UNCOMMON', 7], ['Ancient Forest Relic', 'LEGENDARY', 1]
    ]
  },
  shieldlake: {
    id: 'shieldlake', name: 'Shieldbreaker Lake', icon: 'i-shield', unlockCost: 35,
    levelCosts: [15, 20, 30, 35],
    description: 'A deep lake where armored fish gather around sunken ruins.',
    boost: { 'Shieldfish (protect from next timeout)': 12, 'Pufferfish': 2, 'Turtle': 2 },
    loot: [
      ['Shieldfish (protect from next timeout)', 'EPIC', 14], ['Armored Puffer', 'RARE', 6], ['Ironback Turtle', 'EPIC', 4],
      ['Lake Silverfin', 'UNCOMMON', 10], ['Guardian Carp', 'RARE', 5], ['Deepwater Bass', 'UNCOMMON', 10],
      ['Iron Scrap', 'COMMON', 12], ['Broken Shield Fragment', 'UNCOMMON', 8], ['Ancient Scale', 'RARE', 5],
      ['Lake Pearl', 'EPIC', 3], ['Guardian Fragment', 'LEGENDARY', 1], ['Ancient Lake Relic', 'LEGENDARY', 1]
    ]
  },
  reef: {
    id: 'reef', name: 'Coral Reef', icon: 'i-drop', unlockCost: 60,
    levelCosts: [25, 30, 40, 60],
    description: 'A bright tropical reef with unusual fish and valuable sea finds.',
    boost: { 'Clownfish': 5, 'Lionfish': 4, 'Angelfish': 3 },
    loot: [
      ['Coral Grouper', 'UNCOMMON', 10], ['Reef Eel', 'UNCOMMON', 10], ['Mini Reef Shark', 'EPIC', 3],
      ['Blue Tang', 'RARE', 6], ['Lionfish', 'RARE', 8], ['Stingray', 'UNCOMMON', 9],
      ['Seashell', 'COMMON', 12], ['Coral Fragment', 'COMMON', 11], ['Starfish', 'COMMON', 10],
      ['Pearl', 'EPIC', 4], ['Golden Shell', 'RARE', 3], ['Reef Relic', 'LEGENDARY', 1]
    ]
  },
  frozen: {
    id: 'frozen', name: 'Frozen Lake', icon: 'i-snowflake', unlockCost: 90,
    levelCosts: [30, 45, 60, 80],
    description: 'An icy lake hiding cold-water fish beneath a glassy surface.',
    boost: { 'Arctic Char': 6, 'Tiger Trout': 4, 'Pike': 2 },
    loot: [
      ['Frost Trout', 'UNCOMMON', 10], ['Icefish', 'UNCOMMON', 10], ['Snowfin', 'RARE', 6],
      ['Frozen Eel', 'RARE', 5], ['Glacier Pike', 'EPIC', 3], ['Crystal Icefish', 'EPIC', 2],
      ['Ice Chunk', 'COMMON', 12], ['Frozen Bait', 'COMMON', 11], ['Ice Crystal', 'UNCOMMON', 8],
      ['Frost Pearl', 'RARE', 4], ['Ancient Ice', 'EPIC', 2], ['Frost Relic', 'LEGENDARY', 1]
    ]
  },
  emberpool: {
    id: 'emberpool', name: 'Emberpool', icon: 'i-flame', unlockCost: 145,
    levelCosts: [45, 60, 85, 115],
    description: 'A volcanic pool where heat-resistant fish swim through molten rock.',
    boost: { 'Lava Fish': 8, 'Golden Fish': 2, 'Pike': 2 },
    loot: [
      ['Emberfish', 'UNCOMMON', 10], ['Magma Eel', 'RARE', 6], ['Ashfin', 'UNCOMMON', 10],
      ['Lava Puffer', 'RARE', 5], ['Cinder Carp', 'EPIC', 3], ['Molten Koi', 'EPIC', 2],
      ['Coal', 'COMMON', 12], ['Ash', 'COMMON', 12], ['Lava Rock', 'COMMON', 10],
      ['Obsidian', 'UNCOMMON', 8], ['Cinder Pearl', 'RARE', 4], ['Volcanic Relic', 'LEGENDARY', 1]
    ]
  },
  whalebone: {
    id: 'whalebone', name: 'Whalebone Shallows', icon: 'i-fish', unlockCost: 110,
    levelCosts: [35, 50, 70, 95],
    description: 'Shallow water around a giant skeleton, where bone-shelled fish hide between the ribs.',
    boost: { 'Bonefish': 7, 'Ghost Ray': 4, 'Whalefall Eel': 2 },
    loot: [
      ['Bonefish', 'UNCOMMON', 10], ['Ghost Ray', 'RARE', 6], ['Whalefall Eel', 'RARE', 5],
      ['Ribcage Crab', 'COMMON', 12], ['Marrow Shrimp', 'COMMON', 11], ['Barnacle Ray', 'UNCOMMON', 9],
      ['Sea Ivory', 'UNCOMMON', 8], ['Driftbone Shark', 'EPIC', 3], ['Leviathan Scale', 'EPIC', 2],
      ['Ancient Vertebra', 'EPIC', 2], ['Pearl of the Deep', 'RARE', 4], ['Whale Heart Relic', 'LEGENDARY', 1]
    ]
  }
};

// Built-in loot and boosts, kept so the Control Centre can restore an area.
export const DEFAULT_AREA_LOOT = Object.freeze(Object.fromEntries(Object.entries(FISHING_AREAS).map(([id, area]) => [id, {
  loot: area.loot.map(([name, tier, weight]) => [name, tier, weight]),
  boost: { ...area.boost }
}])));

// Saved area tables from the desktop loot table replace the built-in loot and
// boosts for that area only. Anything malformed is ignored, so a bad file can
// never leave an area with no catches.
function sanitizeAreaLoot(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  const clean = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const name = String(row[0] ?? '').trim();
    const tier = String(row[1] ?? '').trim();
    const weight = Number(row[2]);
    const key = name.toLowerCase();
    if (!name || !tier || seen.has(key) || !Number.isFinite(weight) || weight < 0 || weight > 10000) continue;
    seen.add(key);
    clean.push([name, tier, weight]);
  }
  return clean.length && clean.some((row) => row[2] > 0) ? clean : null;
}

const savedAreas = LOOT_CONFIG.areas && typeof LOOT_CONFIG.areas === 'object' ? LOOT_CONFIG.areas : {};
for (const id of Object.keys(FISHING_AREAS)) {
  const saved = savedAreas[id];
  if (!saved || typeof saved !== 'object') continue;
  const loot = sanitizeAreaLoot(saved.loot);
  if (loot) FISHING_AREAS[id].loot = loot;
  if (saved.boost && typeof saved.boost === 'object' && !Array.isArray(saved.boost)) {
    const boost = {};
    for (const [name, value] of Object.entries(saved.boost)) {
      const n = Number(value);
      if (String(name).trim() && Number.isFinite(n) && n >= 0 && n <= 50) boost[String(name).trim()] = n;
    }
    FISHING_AREAS[id].boost = boost;
  }
}

export const AREA_IDS = Object.keys(FISHING_AREAS);

export const AREA_SETTINGS_PREFIX = 'settings:area_enabled:';
export const AREAS_ENABLED_KEY = 'settings:fishing_areas_enabled';
export const DOUBLE_CATCH_ENABLED_KEY = 'settings:double_catch_enabled';

// Per-player switches. These never touch the player's unlocked levels or
// their selected area, so turning them back on restores everything.
export const userAreasOffKey = (userKey) => `settings:user_areas_off:${userKey}`;
export const userDoubleOffKey = (userKey) => `settings:user_double_off:${userKey}`;

export function areaEnabledKey(areaId) {
  return `${AREA_SETTINGS_PREFIX}${areaId}`;
}

export function isEnabledValue(value) {
  return value !== 'off' && value !== 'false' && value !== '0';
}


export function getArea(id) {
  return FISHING_AREAS[id] || null;
}

export function areaLevelKey(userKey, areaId) {
  return `fishing_area_level:${userKey}:${areaId}`;
}

function normalizeMgetValues(result, keys) {
  // kv_mget normally returns an array, but tolerate object-shaped RPC
  // responses as well. Without this normalization a page refresh could turn
  // valid persisted area levels into 0/0 in the Auto-Fish prestige UI.
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    return keys.map((key) => result[key] ?? result[String(key)] ?? null);
  }
  return keys.map(() => null);
}

export async function readUserAreaLevels(db, userKey) {
  const ids = AREA_IDS;
  const canonicalKeys = ids.map((id) => areaLevelKey(userKey, id));
  const canonical = normalizeMgetValues(await db.mget(canonicalKeys), canonicalKeys);
  const levels = Object.fromEntries(ids.map((id, i) => [
    id,
    Math.max(0, Math.min(5, parseInt(canonical[i], 10) || 0))
  ]));

  // Keep prestige/Auto-Fish in sync with older area records created before
  // the current fishing_area_level:<user>:<area> key format was introduced.
  // Only consult legacy keys when the canonical records are all empty.
  if (Object.values(levels).some((level) => level > 0)) return levels;

  const legacyTemplates = [
    (id) => `area:${userKey}:${id}`,
    (id) => `areas:${userKey}:${id}`,
    (id) => `area_level:${userKey}:${id}`,
    (id) => `areaLevel:${userKey}:${id}`,
    (id) => `fishing:area:${userKey}:${id}`
  ];

  for (const makeKey of legacyTemplates) {
    const legacyKeys = ids.map(makeKey);
    const values = normalizeMgetValues(await db.mget(legacyKeys), legacyKeys);
    const legacy = Object.fromEntries(ids.map((id, i) => [
      id,
      Math.max(0, Math.min(5, parseInt(values[i], 10) || 0))
    ]));
    if (Object.values(legacy).some((level) => level > 0)) {
      return legacy;
    }
  }

  return levels;
}

export function selectedAreaKey(userKey) {
  return `fishing_area_selected:${userKey}`;
}

export function totalAreaProgress(levels) {
  return Object.values(levels || {}).reduce((sum, level) => sum + Math.max(0, Number(level) || 0), 0);
}

const DOUBLE_THRESHOLDS = [1, 3, 6, 9, 12, 15, 18, 21, 23, 25];
const DOUBLE_CHANCES = [3, 5, 7, 9, 11, 13, 15, 17, 19, 22];

export function doubleCatchProgress(levels) {
  const points = totalAreaProgress(levels);
  if (points <= 0) return { level: 0, chance: 0, points, nextPoints: 1 };
  let level = 1;
  for (let i = 0; i < DOUBLE_THRESHOLDS.length; i++) {
    if (points >= DOUBLE_THRESHOLDS[i]) level = i + 1;
  }
  const chance = DOUBLE_CHANCES[level - 1];
  const nextPoints = level < DOUBLE_THRESHOLDS.length ? DOUBLE_THRESHOLDS[level] : null;
  return { level, chance, points, nextPoints };
}

export function areaCatchChance(level) {
  const lvl = Math.max(1, Math.min(5, Number(level) || 1));
  return 0.08 + (lvl - 1) * 0.035; // 8% -> 22% at level 5
}

export function pickWeighted(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.reduce((sum, entry) => sum + Math.max(0, Number(entry[2]) || 0), 0);
  if (!total) return null;
  let roll = Math.random() * total;
  for (const entry of list) {
    roll -= Math.max(0, Number(entry[2]) || 0);
    if (roll < 0) return entry;
  }
  return list[list.length - 1] || null;
}
