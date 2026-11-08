const INVENTORY_LOCK_TTL_SECONDS = 20;
const INVENTORY_LOCK_RETRIES = 60;
const INVENTORY_LOCK_DELAY_MS = 50;
const CATCH_LOG_RETENTION = 500;

// The catch log is a per-user ring of slots driven by one atomic sequence
// bump, matching the Twitch catch audit in lib/audit.js.
const CATCH_LOG_SEQUENCE_PREFIX = 'fish:log:seq:';
const CATCH_LOG_SLOT_PREFIX = 'fish:log:slot:';
// Reads of pre-ring logs still work, so nobody loses history on deploy.
const LEGACY_CATCH_LOG_PREFIX = 'fish:log:';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withKeyLock(db, lockName, callback) {
  const lockKey = `lock:${lockName}`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let acquired = false;

  for (let attempt = 0; attempt < INVENTORY_LOCK_RETRIES; attempt++) {
    const result = await db.set(lockKey, token, { nx: true, ex: INVENTORY_LOCK_TTL_SECONDS });
    if (result) {
      acquired = true;
      break;
    }
    await delay(INVENTORY_LOCK_DELAY_MS + Math.random() * INVENTORY_LOCK_DELAY_MS);
  }

  if (!acquired) throw new Error('The inventory is busy. Please retry shortly.');

  try {
    return await callback();
  } finally {
    await db.unlock(lockKey, token);
  }
}

export function catchCountKey(userKey, inventoryItem) {
  const normalizedItem = String(inventoryItem || '').trim().toLowerCase();
  return `fish:caught:${userKey}:${encodeURIComponent(normalizedItem)}`;
}

export async function ensureCatchHistoryCount(db, userKey, inventoryItem, count) {
  if (!inventoryItem || count <= 0) return;
  const key = catchCountKey(userKey, inventoryItem);
  const existing = await db.get(key);
  if (existing === null || existing === undefined) await db.set(key, count);
}

function parseCatchRecord(inventoryItem, source, caughtAt, sequence = null) {
  const match = String(inventoryItem).match(/^(.*?)\s*[\[(]([a-z]+)[\])]\s*$/i);
  return {
    item: match ? match[1].trim() : String(inventoryItem),
    tier: match ? match[2].toUpperCase() : '',
    source,
    caughtAt,
    ...(sequence != null ? { sequence } : {})
  };
}

export function catchLogSequenceKey(userKey) {
  return `${CATCH_LOG_SEQUENCE_PREFIX}${userKey}`;
}

export function catchLogSlotKey(userKey, slot) {
  return `${CATCH_LOG_SLOT_PREFIX}${userKey}:${slot}`;
}

// Returns a Map of inventoryItem -> how many times the player has now caught
// it. A total of 1 means this was the first catch ever, which is how !fish
// decides "NEW FISH DISCOVERED" without a separate read beforehand.
export async function recordCatches(db, userKey, inventoryItems, source = 'fish') {
  const entries = (Array.isArray(inventoryItems) ? inventoryItems : [inventoryItems]).filter(Boolean);
  if (!entries.length) return new Map();

  const counts = new Map();
  for (const item of entries) counts.set(item, (counts.get(item) || 0) + 1);

  // The per-item totals and the log sequence do not depend on each other, so
  // they run side by side instead of one after the other. The catch log is a
  // ring of slots driven by one atomic sequence bump sized to the batch plus
  // parallel slot writes, never a rewrite of the whole history.
  const [totals, sequenceRaw] = await Promise.all([
    Promise.all([...counts].map(([item, count]) => db.incrby(catchCountKey(userKey, item), count))),
    db.incrby(catchLogSequenceKey(userKey), entries.length)
  ]);
  const sequence = Number(sequenceRaw);
  const firstSequence = sequence - entries.length + 1;
  const caughtAt = new Date().toISOString();

  await Promise.all(entries.map((item, index) => {
    const recordSequence = firstSequence + index;
    const slot = ((recordSequence - 1) % CATCH_LOG_RETENTION) + 1;
    return db.set(
      catchLogSlotKey(userKey, slot),
      JSON.stringify(parseCatchRecord(item, source, caughtAt, recordSequence))
    );
  }));

  return new Map([...counts.keys()].map((item, i) => [item, Number(totals[i])]));
}

export async function recordCatch(db, userKey, inventoryItem, source = 'fish') {
  return recordCatches(db, userKey, [inventoryItem], source);
}

// Hot-path version used by /api/fish. It atomically appends inventory, updates
// discovery totals, and advances/writes the bounded catch log. The existing
// recordCatches() is also used by admin/grant flows as the migration-safe fallback.
export async function recordFishingCatch(db, userKey, inventoryItems, source = 'fish', options = {}) {
  const entries = (Array.isArray(inventoryItems) ? inventoryItems : [inventoryItems]).filter(Boolean);
  if (!entries.length) return new Map();

  const countKeys = entries.map((item) => catchCountKey(userKey, item));
  const result = await db.recordFishingCatch({
    inventoryKey: `fish:rares:${userKey}`,
    items: entries,
    countKeys,
    sequenceKey: catchLogSequenceKey(userKey),
    slotPrefix: CATCH_LOG_SLOT_PREFIX + userKey + ':',
    source,
    retention: CATCH_LOG_RETENTION,
    ...options
  });

  if (result && Array.isArray(result.totals)) {
    return new Map(entries.map((item, index) => [item, Number(result.totals[index]) || 0]));
  }

  // Migration not installed: keep the old two-operation behavior. Inventory
  // is written here too so callers get one fallback function instead of having
  // to coordinate separate history and inventory promises.
  const totals = await recordCatches(db, userKey, entries, source);
  await addInventoryItems(db, userKey, entries);
  if (options.leaderboardKey) await db.incrby(options.leaderboardKey, entries.length);
  if (options.bestTierKey && options.bestTierValue != null) await db.set(options.bestTierKey, options.bestTierValue);
  if (options.bestItemKey && options.bestItemValue != null) await db.set(options.bestItemKey, options.bestItemValue);
  return totals;
}

async function readLegacyCatchLog(db, userKey, limit) {
  const raw = await db.get(`${LEGACY_CATCH_LOG_PREFIX}${userKey}`);
  if (!raw) return [];
  try {
    const records = JSON.parse(raw);
    if (!Array.isArray(records)) return [];
    return records.slice(-Math.max(1, limit)).reverse();
  } catch (_err) {
    return [];
  }
}

export async function getRecentCatchLog(db, userKey, limit = 100) {
  const wanted = Math.max(1, Math.min(CATCH_LOG_RETENTION, Number(limit) || 100));
  const sequence = Number(await db.get(catchLogSequenceKey(userKey))) || 0;
  if (!sequence) return readLegacyCatchLog(db, userKey, limit);

  const firstSequence = Math.max(1, sequence - wanted + 1);
  const sequences = [];
  for (let current = firstSequence; current <= sequence; current++) sequences.push(current);

  const raws = await db.mget(sequences.map((current) => {
    const slot = ((current - 1) % CATCH_LOG_RETENTION) + 1;
    return catchLogSlotKey(userKey, slot);
  }));
  const records = [];
  for (let index = 0; index < sequences.length; index++) {
    try {
      const record = JSON.parse(raws?.[index] || 'null');
      // A wrapped slot may contain a newer record. Never expose it as an
      // older history entry. During the first retention window, tolerate
      // pre-sequence records created by an earlier build; there cannot yet be
      // an older wrap-around record occupying the same slot.
      const recordSequence = Number(record?.sequence);
      if (record && (recordSequence === sequences[index] ||
          (sequence <= CATCH_LOG_RETENTION && !Number.isFinite(recordSequence)))) {
        records.push(record);
      }
    } catch (_err) { console.error('[lib/inventory.js:179] ignored error:', _err?.message || _err); }
  }
  return records.reverse();
}

export async function deleteUserCatchData(db, userKey) {
  // The pattern is narrowed to this user instead of scanning every player's
  // catch-history rows and filtering afterwards. `_` is a LIKE wildcard, so
  // the startsWith filter below still guards against look-alike names.
  const [caughtResult, slotResult] = await Promise.all([
    db.scan('0', { match: `fish:caught:${userKey}:*` }),
    db.scan('0', { match: `${CATCH_LOG_SLOT_PREFIX}${userKey}:*` })
  ]);
  const caughtKeys = (caughtResult?.[1] || []).filter((key) => key.startsWith(`fish:caught:${userKey}:`));
  const slotKeys = slotResult?.[1] || [];
  await db.del([
    ...caughtKeys,
    ...slotKeys,
    catchLogSequenceKey(userKey),
    `${LEGACY_CATCH_LOG_PREFIX}${userKey}`
  ]);
}

export async function readInventoryItems(db, userKey) {
  return (await db.lrange(`fish:rares:${userKey}`, 0, -1)) || [];
}

export async function addInventoryItems(db, userKey, items) {
  const values = (Array.isArray(items) ? items : [items]).filter((item) => typeof item === 'string' && item.length);
  if (!values.length) return 0;
  // Deliberately lock-free: kv_rpush is a single atomic statement, so two
  // concurrent catches can neither interleave nor drop an entry. Taking the
  // inventory lock here cost four extra round trips (set-nx, rpush, get,
  // del) on every single !fish, and the lock only ever guards the
  // read-modify-write paths below.
  await db.rpush(`fish:rares:${userKey}`, ...values);
  // Keep the Treasury copy in step (write-through). Purchases only read it
  // once the per-player check has passed.
  const treasuryValues = values.filter(isTreasuryItem);
  if (treasuryValues.length) await db.rpush(treasuryListKey(userKey), ...treasuryValues);
  return values.length;
}

function inventoryListsEqual(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (String(left[i]) !== String(right[i])) return false;
  }
  return true;
}

// Replace an inventory list and verify what the database actually stored.
// Some deployments may still have an older/missing kv_lreplace RPC; in that
// case db.lreplace already falls back. If a present RPC returns successfully
// without producing the requested list, retry through the primitive DEL/RPUSH
// path and verify again. Callers hold the per-user inventory lock.
async function replaceFullInventoryList(db, userKey, items) {
  const listKey = `fish:rares:${userKey}`;
  const wanted = (Array.isArray(items) ? items : []).map(String);

  await db.lreplace(listKey, wanted);
  let actual = (await db.lrange(listKey, 0, -1)) || [];
  if (inventoryListsEqual(actual, wanted)) return actual;

  // Retry once through the underlying primitives. This is deliberately
  // verified afterward so a broken deployment fails loudly instead of
  // charging/spending an item while leaving the old inventory in place.
  await db.del(listKey);
  if (wanted.length) await db.rpush(listKey, ...wanted);
  actual = (await db.lrange(listKey, 0, -1)) || [];
  if (!inventoryListsEqual(actual, wanted)) {
    throw new Error('Inventory could not be updated safely. Please retry.');
  }
  return actual;
}

export async function removeInventoryItems(db, userKey, predicate, maxCount = Infinity, requiredCount = 0) {
  return withKeyLock(db, `inventory:${userKey}`, async () => {
    const listKey = `fish:rares:${userKey}`;
    const items = (await db.lrange(listKey, 0, -1)) || [];
    const remaining = [];
    const removed = [];
    const cap = Number.isFinite(maxCount) ? Math.max(0, maxCount) : Infinity;

    for (const item of items) {
      if (removed.length < cap && predicate(item)) removed.push(item);
      else remaining.push(item);
    }

    if (removed.length < requiredCount) return { removed: [], items };
    if (!removed.length) return { removed, items };

    // Promote the current inventory list to durable catch history before any
    // entries leave it, so shop spending, shield use, admin removal, and a
    // future trade never erase fishdex discoveries.
    await seedCatchCountsForItems(db, userKey, items);
    await replaceInventoryItems(db, userKey, remaining);
    return { removed, items: remaining };
  });
}

export function isShieldfish(item) {
  return typeof item === 'string' && item.toLowerCase().includes('shieldfish');
}

export function isTreasuryItem(item) {
  return typeof item === 'string' && /[\[(]treasury[\])]\s*$/i.test(item.trim());
}

export async function seedCatchCountsForItems(db, userKey, items) {
  const counts = new Map();
  for (const item of items || []) {
    if (typeof item === 'string') counts.set(item, (counts.get(item) || 0) + 1);
  }
  // One mget for every item's history key, then only the missing ones are
  // written, all at once. This used to be a get+set pair per item in series.
  const pending = [...counts].filter(([item, count]) => item && count > 0);
  if (!pending.length) return;
  const existing = await db.mget(pending.map(([item]) => catchCountKey(userKey, item)));
  await Promise.all(pending.map(([item, count], index) => (
    existing?.[index] === null || existing?.[index] === undefined
      ? db.set(catchCountKey(userKey, item), count)
      : null
  )));
}

// ---------- Treasury copy (fish:treasury:<user>) ----------
// A second list that holds only Treasury items, so a purchase can read the
// currency without reading every catch. The full list stays the source of
// truth for everything else. All writes pass through the helpers above, so
// the copy is kept in step by the same code paths.
export const treasuryListKey = (userKey) => `fish:treasury:${userKey}`;
export const treasurySyncedKey = (userKey) => `fish:treasury-synced:${userKey}`;
const treasuryOf = (items) => (items || []).filter(isTreasuryItem);

export async function replaceInventoryItems(db, userKey, items) {
  const result = await replaceFullInventoryList(db, userKey, items);
  const after = Array.isArray(result) ? result : (Array.isArray(items) ? items : []).map(String);
  await db.lreplace(treasuryListKey(userKey), treasuryOf(after));
  return result;
}

// Compare the Treasury copy with the Treasury items in the full list.
export async function treasuryListMatches(db, userKey) {
  const [full, copy] = await Promise.all([
    db.lrange(`fish:rares:${userKey}`, 0, -1),
    db.lrange(treasuryListKey(userKey), 0, -1)
  ]);
  const expected = treasuryOf(full || []);
  const actual = copy || [];
  return { ok: inventoryListsEqual(expected, actual), expected: expected.length, copy: actual.length };
}

// Copy the Treasury items into the Treasury list. Safe to run again. Writes
// that happen during the copy are caught by re-reading the full list; the
// copy is retried a few times before giving up.
export async function backfillTreasuryList(db, userKey) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = (await db.lrange(`fish:rares:${userKey}`, 0, -1)) || [];
    const expected = treasuryOf(before);
    await db.lreplace(treasuryListKey(userKey), expected);
    const after = (await db.lrange(`fish:rares:${userKey}`, 0, -1)) || [];
    if (inventoryListsEqual(treasuryOf(after), expected)) {
      await db.set(treasurySyncedKey(userKey), '1');
      return { ok: true, count: expected.length, attempts: attempt };
    }
  }
  return { ok: false, count: null, attempts: 3 };
}

