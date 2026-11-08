// One reader for the desktop loot-table file. Rarity tiers, per-fish weights,
// area loot tables and custom perks all live in that file, so every module
// reads it through here instead of parsing it on its own.
//
// Only the local edition reads the file. The hosted edition keeps the
// code-owned defaults, exactly as before.
import fs from 'node:fs';
import path from 'node:path';

export const LOOT_FILE_PATH = process.env.LOCAL_LOOT_TABLE_PATH || path.resolve(process.cwd(), 'data', 'loot-table.json');

function readLootFile() {
  if (process.env.LOCAL_EDITION !== '1') return {};
  try {
    const value = JSON.parse(fs.readFileSync(LOOT_FILE_PATH, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[loot] Could not read the saved loot table; using defaults:', error?.message || error);
    return {};
  }
}

// Read once at boot. The desktop app restarts the server after every save,
// so one snapshot per process is the intended behaviour.
export const LOOT_CONFIG = Object.freeze(readLootFile());

// Weights are relative numbers inside one rarity (fish) or one area (area
// loot). 100 is neutral, so 200 doubles an entry and 0 keeps it out of rolls.
export const DEFAULT_WEIGHT = 100;
export const MAX_WEIGHT = 10000;

export function cleanWeight(value, fallback = DEFAULT_WEIGHT) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_WEIGHT ? n : fallback;
}
