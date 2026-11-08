import { db } from '../db.js';
import { getSessionUser } from '../session.js';
import { DEX_TIERS, areaSourceFor } from '../dexcatalog.js';
import { catchCountKey, ensureCatchHistoryCount } from '../inventory.js';

export async function fishdexHandler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ error: 'Not logged in.' });
  }

  if (!db) {
    return res.status(500).json({ error: 'Database not configured.' });
  }

  const userKey = sessionUser.login.toLowerCase().replace('@', '').trim();

  try {
    // The normal loot table (the one !fish rolls against) plus every fishing
    // area's specialized catches, so the index can never drift out of sync.
    const tiers = DEX_TIERS;

    const itemEntries = tiers.flatMap((tier) => tier.items.map((itemName) => ({
      tier, itemName, inventoryItem: `${itemName} [${tier.name}]`
    })));
    const historyKeys = itemEntries.map(({ inventoryItem }) => catchCountKey(userKey, inventoryItem));
    // Inventory and catch history do not depend on each other: one round trip
    // of waiting instead of two.
    const [caughtRaw, historyValues] = await Promise.all([
      db.lrange(`fish:rares:${userKey}`, 0, -1).then((list) => list || []),
      historyKeys.length ? db.mget(historyKeys) : []
    ]);
    const inventoryCounts = caughtRaw.reduce((counts, entry) => {
      counts[entry] = (counts[entry] || 0) + 1;
      return counts;
    }, {});

    // Build the dex synchronously with a running index (the old code did an
    // O(n) findIndex per item), collecting backfill writes to run together.
    const backfills = [];
    let itemIndex = 0;
    const dex = tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      badge: tier.badge,
      items: tier.items.map((itemName) => {
        const inventoryItem = `${itemName} [${tier.name}]`;
        const stored = historyValues?.[itemIndex++];
        let count = parseInt(stored, 10) || 0;
        if (stored === null || stored === undefined) {
          count = inventoryCounts[inventoryItem] || 0;
          if (count > 0) backfills.push(ensureCatchHistoryCount(db, userKey, inventoryItem, count));
        }
        const area = areaSourceFor(itemName, tier.name);
        return area ? { name: itemName, caught: count > 0, count, area } : { name: itemName, caught: count > 0, count };
      })
    }));
    if (backfills.length) await Promise.all(backfills);

    const totalItems = dex.reduce((sum, t) => sum + t.items.length, 0);
    const totalCaught = dex.reduce((sum, t) => sum + t.items.filter((i) => i.caught).length, 0);

    return res.status(200).json({
      user: {
        login: sessionUser.login,
        displayName: sessionUser.displayName,
        avatar: sessionUser.avatar
      },
      totalItems,
      totalCaught,
      tiers: dex
    });
  } catch (err) {
    console.error('Fishdex Error:', err);
    return res.status(500).json({ error: 'Failed to build your fish index.' });
  }
}
