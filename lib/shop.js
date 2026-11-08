// Treasury Shop: perks bought with Treasury-tier catches instead of fished up.
// Inventory is the spendable wallet; catch history is stored separately so
// purchases never erase fishdex discoveries. Lives in lib/ to preserve the
// existing local API route count.
//
// Most Treasury Shop perks are permanent, one-time purchases. Rarity Boost is
// the exception: it carries a 15-minute TTL and can be purchased again for 20
// Treasury after it expires. It still uses the same toggle mechanism as the
// other shop perks while active.

import { removeInventoryItems, seedCatchCountsForItems, withKeyLock, readInventoryItems } from './inventory.js';
import { getPrices } from './pricing.js';

export const TREASURY_ONLY_MANUAL_CATCH_UNLOCK = 25;

export const SHOP_ITEMS = {
  luck125: { name: '1.25x Luck (Permanent)', cost: 80, key: 'shop_luck' },
  cooldown: { name: '15% Cooldown Reduction', cost: 45, key: 'shop_cooldown' },
  treasuryLuck: { name: '1.5x Treasury Luck', cost: 55, key: 'shop_treasury_luck' },
  rarityBoost: { name: '2x Rarity Luck (15 min)', cost: 25, key: 'shop_rarity_boost', ttl: 900 },
  treasuryOnly: { name: 'Treasury Only Mode', cost: 0, key: 'shop_treasury_only' },
  fishermansFortune: { name: "Fisherman's Fortune", cost: 60, key: 'shop_fortune' }
};

// Grants Treasury Only if the manual-catch milestone is reached. The NX write
// makes the grant one-time even when two casts race. Returns true only for the
// call that actually performed the unlock.
async function grantTreasuryOnlyIfEligible(db, userKey, manualCatches = null) {
  const key = shopKey('treasuryOnly', userKey);
  const catches = manualCatches == null
    ? Math.max(0, parseInt(await db.get(`fish:count:${userKey}`), 10) || 0)
    : Math.max(0, Number(manualCatches) || 0);
  if (catches < TREASURY_ONLY_MANUAL_CATCH_UNLOCK) return false;
  const won = await db.set(key, 'true', { nx: true });
  if (!won) return false;
  // Treasury Only is unlocked but MUST start disabled; the tutorial explicitly
  // requires the player to opt into the mode before moving to Areas.
  await db.set(`toggle:treasuryOnly:${userKey}`, 'off');
  return true;
}

export async function ensureTreasuryOnlyUnlocked(db, userKey, manualCatches = null) {
  const key = shopKey('treasuryOnly', userKey);
  if (await db.get(key)) return true;
  if (await grantTreasuryOnlyIfEligible(db, userKey, manualCatches)) return true;
  return !!(await db.get(key));
}

// Same unlock, but answers only "did this call just unlock Treasury Only?", so
// the !fish reply can announce the unlock exactly once.
export async function unlockTreasuryOnlyNow(db, userKey, manualCatches = null) {
  if (await db.get(shopKey('treasuryOnly', userKey))) return false;
  return grantTreasuryOnlyIfEligible(db, userKey, manualCatches);
}

export async function getShopItemsWithPrices(db) {
  const prices = await getPrices(db);
  return Object.fromEntries(Object.entries(SHOP_ITEMS).map(([id, item]) => [id, { ...item, cost: prices.shop[id] ?? item.cost }]));
}

// Tiers the "2x Rarity Luck" boost can target. The selected rarity applies
// for the perk's 15-minute active window; choosing another rarity requires a
// new 20-Treasury purchase after the current window expires.
export const BOOSTABLE_RARITIES = ['godly', 'legendary', 'epic', 'rare', 'uncommon'];

export function shopKey(itemId, userKey) {
  return `${SHOP_ITEMS[itemId].key}:${userKey}`;
}

export function allShopKeys(userKey) {
  return [
    ...Object.values(SHOP_ITEMS).map((i) => `${i.key}:${userKey}`),
    ...Object.keys(SHOP_ITEMS).map((id) => `toggle:${id}:${userKey}`),
    `treasury_spent:${userKey}`
  ];
}

export function countTreasuryItems(items) {
  return (items || []).filter(
    (i) => typeof i === 'string' && /[\[(]treasury[\])]\s*$/i.test(i.trim())
  ).length;
}

export async function getTreasuryBalance(db, userKey, knownItems) {
  // Fast path. The lock below only protects the one-time conversion of the
  // legacy `treasury_spent` counter; when that counter is absent (the normal
  // case) the balance is just a count over the inventory, so skip the lock
  // (set-nx, get, del) and reuse the caller's list when it has one.
  const spentRaw = await db.get(`treasury_spent:${userKey}`);
  if (!(Math.max(0, parseInt(spentRaw, 10) || 0) > 0)) {
    const items = Array.isArray(knownItems) ? knownItems : await readInventoryItems(db, userKey);
    const total = countTreasuryItems(items);
    return { total, spent: 0, balance: total };
  }

  return withKeyLock(db, `treasury-migration:${userKey}`, async () => {
    let items = await readInventoryItems(db, userKey);
    const spent = Math.max(0, parseInt(await db.get(`treasury_spent:${userKey}`), 10) || 0);

    if (spent > 0) {
      const treasuryItems = items.filter((item) => typeof item === 'string' && /[\[(]treasury[\])]\s*$/i.test(item.trim()));
      await seedCatchCountsForItems(db, userKey, treasuryItems);
      const migrationAmount = Math.min(spent, treasuryItems.length);
      if (migrationAmount > 0) {
        await removeInventoryItems(db, userKey, (item) => typeof item === 'string' && /[\[(]treasury[\])]\s*$/i.test(item.trim()), migrationAmount, migrationAmount);
      }
      await db.del(`treasury_spent:${userKey}`);
      items = await readInventoryItems(db, userKey);
    }

    const total = countTreasuryItems(items);
    return { total, spent: 0, balance: total };
  });
}
