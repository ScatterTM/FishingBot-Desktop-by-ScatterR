// Queue of changes made while the local server was stopped (from the desktop app).
// The desktop writes data/pending-changes.json. On start, the server applies each entry
// with the same save functions the Control Centre uses, so the same checks run.
// Entries that the checks reject stay in the file with the reason, until cleared.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';
import { saveGameplaySettings, validateAndSaveLootTable, saveAppSettings, savePriceSettings, saveCooldown } from './manager.js';

export const QUEUE_FILE = path.join(ROOT, 'data', 'pending-changes.json');

const APPLIERS = Object.freeze({
  gameplaySettings: (payload) => saveGameplaySettings(payload),
  lootTable: (payload) => validateAndSaveLootTable(payload),
  appSettings: (payload) => saveAppSettings(payload),
  pricing: (payload) => savePriceSettings(payload),
  cooldown: (payload) => saveCooldown(payload?.seconds),
});

export function queueKinds() {
  return Object.keys(APPLIERS);
}

export function readQueue() {
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

function writeQueue(items) {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({ version: 1, items }, null, 2));
}

// Whole-state kinds (loot, gameplay, app settings, cooldown) keep only the newest pending save of each kind.
// Pricing sends partial saves, so its pending saves are merged into one (newer values win).
const REPLACE = new Set(['lootTable', 'gameplaySettings', 'appSettings', 'cooldown']);
const MERGE = new Set(['pricing']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return b;
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = isPlainObject(value) && isPlainObject(a[key]) ? deepMerge(a[key], value) : value;
  }
  return out;
}

export async function applyPendingChanges() {
  const items = readQueue();
  const pending = items.filter((item) => item.status === 'pending');
  if (!pending.length) return { applied: 0, failed: 0, superseded: 0 };

  // Collapse the batch per kind before anything is applied.
  const byKind = new Map();
  for (const item of pending) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, []);
    byKind.get(item.kind).push(item);
  }
  const keep = new Set();
  let superseded = 0;
  for (const [kind, list] of byKind) {
    if (REPLACE.has(kind) || MERGE.has(kind)) {
      const last = list[list.length - 1];
      if (MERGE.has(kind)) last.payload = list.reduce((acc, item) => deepMerge(acc, item.payload), {});
      for (const item of list) {
        if (item !== last) {
          item.status = 'superseded';
          item.error = null;
          superseded += 1;
        }
      }
      keep.add(last);
    } else {
      list.forEach((item) => keep.add(item));
    }
  }
  const toApply = pending.filter((item) => keep.has(item));

  // One pass over the batch, in the order the changes were made, then one write of the queue file.
  let applied = 0;
  let failed = 0;
  for (const item of toApply) {
    const apply = APPLIERS[item.kind];
    try {
      if (!apply) throw new Error('Unknown change type.');
      const result = await apply(item.payload);
      if (result && result.ok === false) throw new Error(result.error || 'The change was rejected.');
      item.status = 'applied';
      item.error = null;
      item.appliedAt = new Date().toISOString();
      applied += 1;
    } catch (error) {
      item.status = 'failed';
      item.error = error.message || String(error);
      failed += 1;
    }
  }
  writeQueue(items);
  console.log(`[queue] Applied ${applied} queued change(s); ${failed} rejected; ${superseded} replaced by a newer save.`);
  return { applied, failed, superseded };
}

// Removes entries that are applied or rejected. Pending entries are kept.
export function clearFinished() {
  const items = readQueue().filter((item) => item.status === 'pending');
  writeQueue(items);
  return items.length;
}
