// Keeps a copy of the Game settings the Control Centre last loaded, so the desktop app can
// show and queue changes while the server is stopped. Written on every settings read.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';

export const GAME_SNAPSHOT_FILE = path.join(ROOT, 'data', 'game-settings-snapshot.json');

export function writeGameSettingsSnapshot(settings) {
  try {
    const snapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      cooldownSeconds: settings.cooldownSeconds,
      chat: settings.chat,
      autoFish: settings.autoFish,
      areas: {
        enabled: settings.areas.enabled,
        doubleCatchEnabled: settings.areas.doubleCatchEnabled,
        items: settings.areas.items.map(({ id, name, enabled }) => ({ id, name, enabled })),
      },
      loot: {
        tiers: settings.tiers || [],
        weights: settings.weights || {},
        abilities: settings.abilities || {},
        areaLoot: settings.areaLoot || {},
      },
    };
    fs.mkdirSync(path.dirname(GAME_SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(GAME_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.warn('[snapshot] Could not save game settings copy: ' + (error?.message || error));
  }
}
