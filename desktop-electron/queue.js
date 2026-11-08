'use strict';

// Desktop side of the change queue: writes data/pending-changes.json for the server to apply
// on its next start. The server file format is defined in local/pending-changes.js.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KINDS = ['gameplaySettings', 'lootTable', 'appSettings', 'pricing', 'cooldown'];

function queueFile(root) {
  return path.join(root, 'data', 'pending-changes.json');
}

function read(root) {
  try {
    const data = JSON.parse(fs.readFileSync(queueFile(root), 'utf8'));
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

function write(root, items) {
  fs.mkdirSync(path.dirname(queueFile(root)), { recursive: true });
  fs.writeFileSync(queueFile(root), JSON.stringify({ version: 1, items }, null, 2));
}

function list(root) {
  return read(root);
}

// Whole-state kinds (the full loot table, gameplay, app settings, cooldown): the newest pending save of a kind
// replaces the older one, because each save already holds the complete state. Partial kinds (pricing, which
// may send only some prices) are merged into one pending save, newer values winning.
const MERGE = new Set(['pricing']);

// Object keys merge, arrays and values are replaced by the newer one. Used for partial saves (pricing).
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

function enqueue(root, kind, payload) {
  if (!KINDS.includes(kind)) throw new Error('Unknown change type.');
  let items = read(root);
  const incoming = payload ?? {};
  const older = items.filter((item) => item.kind === kind && item.status === 'pending');
  let next = incoming;
  if (older.length && MERGE.has(kind)) {
    next = older.reduce((acc, item) => deepMerge(acc, item.payload), {});
    next = deepMerge(next, incoming);
  }
  if (older.length) items = items.filter((item) => !older.includes(item));
  items.push({
    id: crypto.randomUUID(),
    kind,
    payload: next,
    status: 'pending',
    error: null,
    createdAt: new Date().toISOString(),
  });
  write(root, items);
  return items.length;
}

// Removes entries that are applied or rejected. Pending entries stay.
function clearFinished(root) {
  const items = read(root).filter((item) => item.status === 'pending');
  write(root, items);
  return items.length;
}

module.exports = { KINDS, list, enqueue, clearFinished };
