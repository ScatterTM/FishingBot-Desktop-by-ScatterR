import { db } from '../db.js';
import { TIERS } from '../tiers.js';

// The shared table carries rankScore too, so best-catch validation reads
// the same ordering !fish rolls against. Unknown tiers fall back to COMMON
// explicitly - never to a positional index, which would silently change
// meaning if the table is ever reordered.
const COMMON_TIER = TIERS.find((t) => t.name === 'COMMON');

// Same logic as fishdex.js: count how many distinct items from the master
// tier list appear (at least once) in this user's raw catch list, keyed
// exactly the way fish.js stores them: "${itemName} [${tier.name}]".
// The dex key list never changes, so it is built once per instance instead of
// re-concatenating ~250 strings for every player on every request.
import { DEX_PROGRESS_KEYS } from '../dexcatalog.js';
import { catchCountKey } from '../inventory.js';
import { progressionKeys, readCustomTitleCatalog, getTitleStyle } from '../progression.js';

// Mirrors lib/game-routes/fishdex.js so the leaderboard % always equals the
// profile %: an item counts as caught if its lifetime catch history says so,
// or - for items with no history entry yet - if it is in the inventory. Using
// the inventory alone missed anything traded, consumed or spent since.
function computeDexStats(rareCatches, history) {
  const inventory = new Set(rareCatches);
  let totalCaught = 0;
  for (let i = 0; i < DEX_PROGRESS_KEYS.length; i++) {
    const stored = history ? history[i] : null;
    const caught = stored === null || stored === undefined
      ? inventory.has(DEX_PROGRESS_KEYS[i])
      : (parseInt(stored, 10) || 0) > 0;
    if (caught) totalCaught++;
  }

  const totalItems = DEX_PROGRESS_KEYS.length;
  const dexPct = totalItems > 0 ? Math.round((totalCaught / totalItems) * 100) : 0;
  return { dexCaught: totalCaught, dexTotal: totalItems, dexPct };
}

// The board is the same for every visitor and rebuilding it costs one query
// per player, so a warm instance serves a short-lived copy, and the CDN gets
// the same window (with stale-while-revalidate) via Cache-Control.
const BOARD_CACHE_MS = 5000;
// Was s-maxage=15 + stale-while-revalidate=60, i.e. an inventory change could
// take over a minute to show. Now at most ~30s behind what the admin panel sees.
const BOARD_CDN_CACHE = 'public, s-maxage=10, stale-while-revalidate=20';
let boardCache = null; // { at, body }
const INVENTORY_CONCURRENCY = 10;

async function mapCapped(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next++;
      results[index] = await fn(list[index], index);
    }
  }));
  return results;
}

export async function leaderboardHandler(req, res) {
  // Public, read-only board: allow the standalone fishing window to read it.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!db) {
    return res.status(503).json({ error: 'Local database not connected.' });
  }

  // The master item list is the same module !fish itself rolls against, so
  // the leaderboard % can never drift out of sync with the actual loot
  // table - and no Host header is trusted to fetch it.
  const fullTiers = TIERS;

  // The admin panel reads inventories live. A manual refresh on the board sends
  // ?fresh=<timestamp> so it skips the instance cache and the CDN and shows the
  // same live inventories; ordinary visitors keep the short-lived shared copy.
  const wantsFresh = req.query?.fresh !== undefined;
  if (!wantsFresh && boardCache && Date.now() - boardCache.at < BOARD_CACHE_MS) {
    res.setHeader('Cache-Control', BOARD_CDN_CACHE);
    return res.status(200).json(boardCache.body);
  }

  try {
    // Fast path: one query returns every player's count, best catch and
    // inventory (sql/003_performance.sql). Falls back to the older
    // scan + mget + per-player lrange path if that function is not installed.
    let usernames;
    let countValues;
    let tierValues;
    let itemValues;
    let inventories;

    const rows = await db.fishPlayers();
    if (rows) {
      usernames = rows.map((row) => row.username);
      countValues = rows.map((row) => row.cnt);
      tierValues = rows.map((row) => row.besttier);
      itemValues = rows.map((row) => row.bestitem);

      // IMPORTANT: kv_fish_players is optimized for leaderboard aggregates,
      // but its `items` field can lag behind the authoritative inventory list
      // after Treasury purchases, trades, admin removals, etc. The Admin panel
      // reads fish:rares:<user> directly, so the public leaderboard must do
      // the same for its vault/inventory display. Keep the fast RPC for counts
      // and best-catch metadata, but never trust its cached item array.
      inventories = await mapCapped(usernames, INVENTORY_CONCURRENCY, async (username) => {
        try {
          return (await db.lrange(`fish:rares:${username}`, 0, -1)) || [];
        } catch (err) {
          console.error(`Error loading live inventory for ${username}:`, err);
          return [];
        }
      });
    } else {
      let cursor = "0";
      const keys = [];
      do {
        const [nextCursor, matchingKeys] = await db.scan(cursor, { match: 'fish:count:*', count: 100 });
        cursor = nextCursor;
        if (matchingKeys && matchingKeys.length > 0) keys.push(...matchingKeys);
      } while (cursor !== "0" && cursor !== 0);

      usernames = keys.map((k) => k.replace('fish:count:', ''));
      if (usernames.length) {
        const bestTierKeys = usernames.map((u) => `fish:besttier:${u}`);
        const bestItemKeys = usernames.map((u) => `fish:bestitem:${u}`);
        [countValues, tierValues, itemValues, inventories] = await Promise.all([
          db.mget(...keys),
          db.mget(...bestTierKeys),
          db.mget(...bestItemKeys),
          mapCapped(usernames, INVENTORY_CONCURRENCY, async (username) => {
            try {
              return (await db.lrange(`fish:rares:${username}`, 0, -1)) || [];
            } catch (err) {
              console.error(`Error loading inventory list for ${username}:`, err);
              return [];
            }
          })
        ]);
      }
    }

    if (usernames.length === 0) {
      return res.status(200).json({
        catches: [],
        rares: [],
        debug: `No fishing data found yet. Try typing '!fish' in chat!`
      });
    }

    // Lifetime catch history for the Fish Index %, the same source the
    // profile page reads. One mget per player, a few at a time.
    const dexHistories = await mapCapped(usernames, INVENTORY_CONCURRENCY, async (username) => {
      try {
        return await db.mget(DEX_PROGRESS_KEYS.map((key) => catchCountKey(username, key)));
      } catch (err) {
        console.error(`Error loading catch history for ${username}:`, err);
        return null;
      }
    });

    const healWrites = [];
    const customTitleCatalog = await readCustomTitleCatalog(db);
    const titleValues = await db.mget(usernames.map((u) => progressionKeys(u).title)).catch(() => []);
    const cosmeticValues = await db.mget(usernames.map((u) => progressionKeys(u).cosmetics)).catch(() => []);

    let catchBoard = [];
    let rareBoard = [];

    for (let i = 0; i < usernames.length; i++) {
      const username = usernames[i];
      const count = parseInt(countValues[i], 10) || 0;
      let tierScore = parseInt(tierValues[i], 10) || 0;
      let bestItem = itemValues[i] || 'None';

      // Fetch this user's full catch list once, and reuse it both for the
      // dex % and for the existing peak-catch validation below.
      const rareCatches = inventories[i];

      const dexStats = computeDexStats(rareCatches, dexHistories[i]);

      const title = String(titleValues?.[i] || '');
      const titleColor = title ? getTitleStyle(title, customTitleCatalog) : '';
      let cosmetics = { frame: 'frame_default', nameplate: 'nameplate_default', effect: 'effect_none' };
      try { cosmetics = { ...cosmetics, ...(JSON.parse(cosmeticValues?.[i] || '{}') || {}) }; } catch (err) { console.error('[lib/game-routes/leaderboard.js:189] ignored error:', err?.message || err); }
      catchBoard.push({ username, count, title, titleColor, cosmetics, ...dexStats });

      // --- PEAK CATCH VALIDATION CHECK ---
      if (rareCatches.length === 0) {
        tierScore = 0;
        bestItem = 'None';
      } else {
        // Extract plain name of current best item stored (e.g. "Shark (UNIQUE)" -> "shark")
        const cleanBestItemName = bestItem.includes('(') 
          ? bestItem.split('(')[0].toLowerCase().trim() 
          : bestItem.toLowerCase().trim();

        // Check if the current best item still exists in the user's list
        const peakExists = rareCatches.some(item => {
          const itemName = typeof item === 'string' ? item.split(' [')[0].toLowerCase().trim() : '';
          return itemName === cleanBestItemName;
        });

        // If it doesn't exist anymore, recalculate highest available from inventory
        if (!peakExists) {
          let highestTierObj = null;
          let newBestItemString = 'None';

          for (const item of rareCatches) {
            const match = item.match(/^(.*?)\s*\[([A-Z]+)\]$/);
            // Older catches were saved with the tier name "UNIQUE" before it
            // was renamed to "SECRET" - normalize so both still match.
            let tierName = match ? match[2].trim().toUpperCase() : 'COMMON';
            if (tierName === 'UNIQUE') tierName = 'SECRET';
            const tierObj = TIERS.find(t => t.name === tierName) || COMMON_TIER;

            if (!highestTierObj || tierObj.rankScore > highestTierObj.rankScore) {
              highestTierObj = tierObj;
              newBestItemString = `${match ? match[1].trim() : item} (${tierObj.name})`;
            }
          }

          if (highestTierObj) {
            tierScore = highestTierObj.rankScore;
            bestItem = newBestItemString;
            // Optionally self-heal the cached values asynchronously
            healWrites.push(
              db.set(`fish:besttier:${username}`, tierScore),
              db.set(`fish:bestitem:${username}`, bestItem)
            );
          } else {
            tierScore = 0;
            bestItem = 'None';
          }
        }
      }

      rareBoard.push({ 
        username,
        title,
        titleColor,
        cosmetics,
        tierScore, 
        bestItem, 
        rareCatches,
        ...dexStats
      });
    }

    // Self-heal writes are awaited together (a serverless function can be
    // frozen once the reply is sent) but no longer one by one.
    if (healWrites.length) await Promise.all(healWrites.map((w) => w.catch((e) => console.error('Best-catch heal failed:', e))));

    catchBoard.sort((a, b) => b.count - a.count);
    rareBoard.sort((a, b) => b.tierScore - a.tierScore);

    const body = {
      catches: catchBoard.slice(0, 50),
      rares: rareBoard.slice(0, 50)
    };
    boardCache = { at: Date.now(), body };
    res.setHeader('Cache-Control', wantsFresh ? 'no-store' : BOARD_CDN_CACHE);
    return res.status(200).json(body);

  } catch (err) {
    console.error('Leaderboard API Error:', err);
    return res.status(500).json({ error: 'Database error. Please try again.' });
  }
}
