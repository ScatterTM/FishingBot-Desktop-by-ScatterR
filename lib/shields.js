import {
  ensureCatchHistoryCount,
  isShieldfish,
  readInventoryItems,
  removeInventoryItems,
  seedCatchCountsForItems,
  withKeyLock
} from './inventory.js';

const LEGACY_SHIELD_KEY_PREFIX = 'shields:';
const USED_SHIELD_KEY_PREFIX = 'shields_used:';
const SHIELD_MIGRATION_PREFIX = 'shield_inventory_v2:';

export function countOwnedShields(items) {
  return Array.isArray(items) ? items.filter(isShieldfish).length : 0;
}

// The migration is a one-time conversion of the old shield counters, but it
// was re-running its lock (set-nx, get, del) on every timeout catch, and
// twice per catch because both getAvailableShields and consumeOneShield call
// it. Memoize per warm instance so repeat catches skip it entirely.
const migratedUsers = new Set();

// Returns true only when the migration actually ran (and so may have changed
// the inventory); false when it was already done or memoized.
async function migrateShieldInventory(db, userKey) {
  if (migratedUsers.has(userKey)) return false;
  const migrationKey = `${SHIELD_MIGRATION_PREFIX}${userKey}`;
  // Lock-free fast path: once the marker exists there is nothing to do, so a
  // cold instance pays one read instead of a set-nx / get / del lock cycle.
  if (await db.get(migrationKey)) {
    migratedUsers.add(userKey);
    return false;
  }
  let ran = false;
  await withKeyLock(db, `shield-migration:${userKey}`, async () => {
    if (await db.get(migrationKey)) {
      migratedUsers.add(userKey);
      return;
    }
    ran = true;

    const items = await readInventoryItems(db, userKey);
    const owned = countOwnedShields(items);
    let usedRaw = await db.get(`${USED_SHIELD_KEY_PREFIX}${userKey}`);

    if (usedRaw === null || usedRaw === undefined) {
      const legacyRaw = await db.get(`${LEGACY_SHIELD_KEY_PREFIX}${userKey}`);
      const legacyRemaining = (legacyRaw !== null && legacyRaw !== undefined && !isNaN(legacyRaw))
        ? parseInt(legacyRaw, 10)
        : owned;
      usedRaw = Math.max(0, owned - legacyRemaining);
    }

    const used = Math.min(owned, Math.max(0, parseInt(usedRaw, 10) || 0));
    const shieldItems = items.filter(isShieldfish);
    await seedCatchCountsForItems(db, userKey, shieldItems);
    if (used > 0) await removeInventoryItems(db, userKey, isShieldfish, used, used);

    await db.del(`${USED_SHIELD_KEY_PREFIX}${userKey}`, `${LEGACY_SHIELD_KEY_PREFIX}${userKey}`);
    await db.set(migrationKey, 'true');
    migratedUsers.add(userKey);
  });
  return ran;
}

// `knownItems` is the caller's inventory read from this same request. It is
// reused when the migration did nothing, which saves a full second list read.
export async function getAvailableShields(db, userKey, _ownedCount, knownItems) {
  const migrated = await migrateShieldInventory(db, userKey);
  const items = (!migrated && Array.isArray(knownItems))
    ? knownItems
    : await readInventoryItems(db, userKey);
  return countOwnedShields(items);
}

export async function consumeOneShield(db, userKey) {
  await migrateShieldInventory(db, userKey);
  const result = await removeInventoryItems(db, userKey, isShieldfish, 1, 1);
  if (!result.removed.length) return null;
  await ensureCatchHistoryCount(db, userKey, result.removed[0], 1);
  return result.removed[0];
}

export async function applyTimeoutWithShield(db, userKey, itemName, opts = {}) {
  let timeoutSeconds = 0;
  if (String(itemName).toLowerCase().includes('soggyboot (self-timeout 5m)')) timeoutSeconds = 300;
  else if (String(itemName).toLowerCase().includes('seamine (10min timeout)')) timeoutSeconds = 600;
  if (timeoutSeconds === 0) return { applied: false, timedOut: false, message: '' };
  return applyTimeoutWithShieldDuration(db, userKey, timeoutSeconds, opts);
}

export async function applyTimeoutWithShieldDuration(db, userKey, seconds, { timeoutKey = `timeout:${userKey}` } = {}) {
  const timeoutSeconds = Math.max(1, Math.min(20 * 60, Math.floor(Number(seconds) || 0)));
  if (!timeoutSeconds) return { applied: false, timedOut: false, message: '' };
  const cleanUser = String(userKey || '').trim().replace(/^@+/, '').toLowerCase();
  const shieldEnabled = (await db.get(`toggle:shield:${cleanUser}`)) !== 'off';
  const consumed = shieldEnabled ? await consumeOneShield(db, cleanUser) : null;
  if (consumed) {
    const timeLabel = `${Math.ceil(timeoutSeconds / 60)}m`;
    return {
      applied: true,
      timedOut: false,
      consumedShield: consumed,
      message: ` 🛡️ (Shield activated! Your Shieldfish saved you from a ${timeLabel} timeout!)`
    };
  }
  const expireTimestamp = Date.now() + timeoutSeconds * 1000;
  await db.set(timeoutKey, expireTimestamp);
  const timeLabelMin = Math.ceil(timeoutSeconds / 60);
  return {
    applied: true,
    timedOut: true,
    expiresAt: expireTimestamp,
    message: ` 💥 (Ouch! You are locked out for ${timeLabelMin} minute${timeLabelMin > 1 ? 's' : ''}!)`
  };
}
