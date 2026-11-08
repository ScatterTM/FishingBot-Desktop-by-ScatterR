import { db } from '../db.js';
import { fortuneStatus, fortuneUncaughtBoost, uncaughtWeightFor, FORTUNE_ITEM } from '../fortune.js';
import { TIERS } from '../tiers.js';
import { fishWeightTable } from '../fish-weights.js';
import { getSessionUser } from '../session.js';
import { activeCustomEffectTotals } from '../fish-abilities.js';
import { countOwnedShields, getAvailableShields } from '../shields.js';
import { SHOP_ITEMS, BOOSTABLE_RARITIES, TREASURY_ONLY_MANUAL_CATCH_UNLOCK, shopKey, getTreasuryBalance, getShopItemsWithPrices, ensureTreasuryOnlyUnlocked } from '../shop.js';
import { isTreasuryItem, removeInventoryItems, withKeyLock } from '../inventory.js';
import { autoFishStatus } from '../autofish.js';
import { pondKeys, POND_TREASURY_PERKS, getFishdexFishCount, speciesHunterBonus } from '../pond.js';
import { selectedStreamerFor } from './streamer.js';
import { readChannelProgress, CHANNEL_UPGRADES, CHANNEL_UPGRADE_COSTS, channelPerkKey } from '../channel-progress.js';
import { getBroadcasterTwitchRecord, recordIsComplete, resolveTwitchLevel } from '../broadcaster-twitch.js';

// Every shop item id doubles as a valid toggle id too, so owning a Treasury
// Shop perk can be flipped on/off the same way perm/temp/vip/event luck can.
const VALID_PERKS = ['perm', 'temp', 'vip', 'event', 'shield', ...Object.keys(SHOP_ITEMS)];
const POND_TOGGLE_PREFIX = 'pond:';

// Perks Shop endpoint for the logged-in user (identified via the session
// cookie, same as fishdex.js - never from a client-supplied username).
//   GET  /api/perks  -> current perk status (ownership, active buffs, toggles)
//   POST /api/perks  body: { perk: 'perm'|'temp'|'vip'|'event'|<shop item id>, enabled }
//        -> flips that perk's luck toggle on/off
//   POST /api/perks  body: { buy: <shop item id>, rarity? }
//        -> buys a Treasury Shop item with treasury catches (see lib/shop.js).
//           'rarityBoost' lasts 15 minutes and can be bought again for 20
//           Treasury after it expires; each purchase may choose a new rarity.
// Combined into a single file (rather than two) to keep the project's
// Keep route handling bounded for responsive local operation.

export async function perksHandler(req, res) {
  // Same-origin dashboard only: no CORS wildcard, so no other website can
  // read this logged-in user's perk and inventory state.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ error: 'Not logged in.' });
  }

  if (!db) {
    return res.status(503).json({ error: 'Local database not connected.' });
  }

  const userKey = sessionUser.login.toLowerCase().replace('@', '').trim();

  // A verified broadcaster connection is authoritative for live VIP/Sub/Mod
  // luck. Refresh the mirror when the logged-in player opens Perks so the UI
  // does not have to wait for another !fish cast to discover a role change.
  // Viewer chat OAuth is intentionally not used for role detection:
  // user:write:chat proves the viewer can send chat, not that they are a
  // subscriber/VIP/mod in the selected broadcaster's channel.
  let liveTwitchRole = null;
  let liveTwitchChannel = null;
  // The role check reads the 5-minute role cache, so a Perks load only pays for a
  // Twitch lookup when the cache has expired. The zero-cost check loads (?check=...)
  // skip it entirely: their results do not depend on VIP/sub status.
  if (req.method === 'GET' && !req.query?.check) {
    try {
      const selected = await selectedStreamerFor(userKey);
      if (selected) {
        const record = await getBroadcasterTwitchRecord(selected);
        if (recordIsComplete(record)) {
          const level = await resolveTwitchLevel(selected, userKey);
          liveTwitchChannel = selected;
          liveTwitchRole = level >= 1500 ? 'broadcaster'
            : level >= 500 ? 'mod'
            : level >= 400 ? 'vip'
            : level >= 250 ? 'sub'
            : 'viewer';
          await db.set(`real_vip:${userKey}`, level >= 250 ? 'true' : 'false');
        }
      }
    } catch (error) {
      console.warn(`[Perks] Twitch role refresh failed for ${userKey}: ${error?.message || error}`);
    }
  }

  // ---------- POST: buy a Treasury Shop item ----------
  //   body: { buy: 'luck125'|'cooldown'|'treasuryLuck'|'rarityBoost', rarity? }
  if (req.method === 'POST' && req.body && req.body.buy) {
    const { buy, rarity } = req.body;
    // hasOwn, not a truthiness lookup: SHOP_ITEMS['__proto__'] resolves via
    // the prototype chain and would otherwise pass as a "known" item.
    const pricedShop = await getShopItemsWithPrices(db);
    const item = (typeof buy === 'string' && Object.prototype.hasOwnProperty.call(pricedShop, buy)) ? pricedShop[buy] : null;
    if (!item) {
      return res.status(400).json({ error: 'Unknown shop item.' });
    }
    if (buy === 'treasuryOnly') {
      const unlocked = await ensureTreasuryOnlyUnlocked(db, userKey);
      if (!unlocked) {
        const catches = Math.max(0, parseInt(await db.get(`fish:count:${userKey}`), 10) || 0);
        return res.status(400).json({ error: `Treasury Only unlocks after ${TREASURY_ONLY_MANUAL_CATCH_UNLOCK} manual catches (${catches}/${TREASURY_ONLY_MANUAL_CATCH_UNLOCK}).` });
      }
      return res.status(200).json({ success: true, message: 'Treasury Only Mode unlocked for free after your manual-catch milestone.', balance: (await getTreasuryBalance(db, userKey)).balance });
    }

    if (buy === 'rarityBoost' && !BOOSTABLE_RARITIES.includes(rarity)) {
      return res.status(400).json({ error: 'Pick a valid rarity for the boost.' });
    }

    try {
      return await withKeyLock(db, `shop-purchase:${userKey}`, async () => {
        const purchaseKey = shopKey(buy, userKey);
        const pausedKey = buy === 'rarityBoost' ? `paused_shop_rarity_boost:${userKey}` : null;
        // These reads do not depend on each other, so they run together (they were
        // four round trips in a row). The inventory list is read here as well; the
        // balance check below uses it. Nothing is written by these reads.
        const [owned, ttlRaw, pausedRaw, rares] = await Promise.all([
          db.get(purchaseKey),
          item.ttl ? db.ttl(purchaseKey) : Promise.resolve(-1),
          pausedKey ? db.get(pausedKey) : Promise.resolve(null),
          db.lrange(`fish:rares:${userKey}`, 0, -1)
        ]);
        const ttl = item.ttl ? Number(ttlRaw) : -1;

        // Rarity Boost is reusable: while the current 15-minute purchase is
        // active it cannot be retargeted for free. If it is paused, it is still
        // the player's current purchase and must be resumed rather than bought
        // a second time. An expired live key is cleared so a fresh 15-minute
        // window can be purchased.
        if (buy === 'rarityBoost') {
          if (owned && ttl > 0) {
            const mins = Math.ceil(ttl / 60);
            return res.status(400).json({ error: `2x Rarity Luck is already active for about ${mins} more minute${mins === 1 ? '' : 's'}.` });
          }
          if (pausedRaw) {
            return res.status(400).json({ error: '2x Rarity Luck is paused. Turn it back on to resume the remaining time.' });
          }
          if (owned && ttl <= 0) await db.del(purchaseKey);
        } else if (owned) {
          return res.status(400).json({ error: 'You already own this perk.' });
        }

        const { balance } = await getTreasuryBalance(db, userKey, rares);
        if (balance < item.cost) {
          return res.status(400).json({ error: `Not enough treasury items (need ${item.cost}, you have ${balance}).` });
        }

        const purchaseValue = buy === 'rarityBoost' ? rarity : 'true';
        const setOptions = item.ttl ? { ex: item.ttl } : { nx: true };
        if (item.ttl) {
          await db.set(purchaseKey, purchaseValue, setOptions);
        } else {
          const ok = await db.set(purchaseKey, purchaseValue, setOptions);
          if (!ok) return res.status(400).json({ error: 'You already own this perk.' });
        }

        try {
          const removed = await removeInventoryItems(db, userKey, isTreasuryItem, item.cost, item.cost);
          if (removed.removed.length !== item.cost) {
            await db.del(purchaseKey);
            return res.status(400).json({ error: 'Treasury inventory changed. Please try again.' });
          }
          // Verify the spend against the actual post-write inventory. This
          // prevents a stale/broken list write from leaving the Treasury
          // catches visible and spendable after a successful purchase.
          const afterItems = await db.lrange(`fish:rares:${userKey}`, 0, -1);
          const afterBalance = afterItems.filter(isTreasuryItem).length;
          if (afterBalance !== balance - item.cost) {
            await db.del(purchaseKey);
            return res.status(409).json({ error: 'Treasury inventory could not be updated safely. Please retry.' });
          }
        } catch (err) {
          await db.del(purchaseKey);
          throw err;
        }

        // A fresh Rarity Boost purchase always starts enabled.
        if (buy === 'rarityBoost') await db.set(`toggle:rarityBoost:${userKey}`, 'on');

        const itemName = SHOP_ITEMS[buy].name;
        const message = buy === 'rarityBoost'
          ? `Successfully bought ${itemName} for 15 minutes, targeting ${rarity.toUpperCase()}.`
          : `Successfully bought ${itemName} and added to your perks!`;
        return res.status(200).json({ 
          success: true, 
          item: buy, 
          balance: balance - item.cost,
          inventoryTreasuryBalance: balance - item.cost,
          rarity: buy === 'rarityBoost' ? rarity : undefined,
          remainingSeconds: item.ttl || undefined,
          message
        });
      });
    } catch (err) {
      console.error('Shop Purchase Error:', err);
      return res.status(500).json({ error: 'Database error. Please try again.' });
    }
  }

  // ---------- POST: toggle a perk on/off ----------
  if (req.method === 'POST') {
    const { perk, enabled } = req.body || {};

    // Channel upgrades: the viewer switches them on or off for their own casts
    // in the channel they picked on their Profile. The channel is taken from the
    // server's selection, never from the request.
    if (perk === 'channelPerk') {
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Requires a boolean "enabled".' });
      const channel = await selectedStreamerFor(userKey);
      if (!channel) {
        return res.status(400).json({ error: 'Pick a streamer on your Profile first.' });
      }
      await db.set(channelPerkKey(userKey, channel), enabled ? 'on' : 'off');
      return res.status(200).json({ success: true, perk, enabled, channel });
    }

    // Pond perk toggles only change whether an owned level is active. They
    // never remove the player's purchased level/progress. Missing toggle keys
    // intentionally mean ON for backwards compatibility.
    if (typeof perk === 'string' && perk.startsWith(POND_TOGGLE_PREFIX)) {
      const pondId = perk.slice(POND_TOGGLE_PREFIX.length);
      if (!Object.prototype.hasOwnProperty.call(POND_TREASURY_PERKS, pondId) || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Requires a valid Pond perk and boolean "enabled".' });
      }
      try {
        const raw = await db.get(pondKeys(userKey).treasuryPerks);
        let levels = {};
        try { levels = raw ? JSON.parse(raw) : {}; } catch (_) { console.error('[lib/game-routes/perks.js:224] ignored error:', _?.message || _); }
        const level = Math.max(0, Math.min(POND_TREASURY_PERKS[pondId].max, Number(levels?.[pondId]) || 0));
        if (level <= 0) return res.status(400).json({ error: 'You do not own this Pond perk yet.' });
        await db.set(`toggle:pondPerk:${pondId}:${userKey}`, enabled ? 'on' : 'off');
        return res.status(200).json({ success: true, perk, enabled, level });
      } catch (err) {
        console.error('Pond perk toggle error:', err);
        return res.status(500).json({ error: 'Could not update Pond perk.' });
      }
    }

    if (!VALID_PERKS.includes(perk) || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Requires a valid "perk" (perm/temp/vip/event) and a boolean "enabled".' });
    }

    const toggleKey = `toggle:${perk}:${userKey}`;

    try {
      // Timed perks need special handling when switched off: deleting the
      // live key pauses its TTL instead of letting Redis keep counting down.
      // When switched back on, the saved seconds are restored as a fresh TTL.
      if (perk === 'temp' || perk === 'rarityBoost') {
        const liveKey = perk === 'temp' ? `temp_luck:${userKey}` : shopKey('rarityBoost', userKey);
        const pausedKey = perk === 'temp' ? `paused_temp_luck:${userKey}` : `paused_shop_rarity_boost:${userKey}`;

        if (enabled) {
          const liveValue = await db.get(liveKey);
          const pausedRaw = await db.get(pausedKey);
          if (!liveValue && pausedRaw) {
            let remainingSeconds = 0;
            let restoreValue = 'true';
            if (perk === 'temp') {
              remainingSeconds = parseInt(pausedRaw, 10);
            } else {
              try {
                const paused = JSON.parse(pausedRaw);
                remainingSeconds = parseInt(paused.seconds, 10);
                restoreValue = String(paused.rarity || '');
              } catch (_) {
                remainingSeconds = 0;
              }
            }
            if (Number.isFinite(remainingSeconds) && remainingSeconds > 0) {
              await db.set(liveKey, restoreValue, { ex: remainingSeconds });
            }
            await db.del(pausedKey);
          }
          await db.set(toggleKey, 'on');
        } else {
          const liveValue = await db.get(liveKey);
          const ttl = liveValue ? Number(await db.ttl(liveKey)) : -2;
          if (liveValue && ttl > 0) {
            if (perk === 'temp') {
              await db.set(pausedKey, String(ttl));
            } else {
              await db.set(pausedKey, JSON.stringify({ rarity: liveValue, seconds: ttl }));
            }
            await db.del(liveKey);
          }
          await db.set(toggleKey, 'off');
        }
      } else if (enabled) {
        // Store 'on' explicitly to distinguish forced-on from default
        await db.set(toggleKey, 'on');
      } else {
        await db.set(toggleKey, 'off');
      }

      return res.status(200).json({ success: true, perk, enabled });
    } catch (err) {
      console.error('Toggle Luck Error:', err);
      return res.status(500).json({ error: 'Database error. Please try again.' });
    }
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  }

  // Per-viewer loot table odds for the Loot Table page. Fortune's uncaught boost
  // depends on this viewer's catches, so the public static tier table cannot
  // carry it. Treasury and SECRET rows are never boosted by the roll, so they
  // stay at base weight here as well.
  if (String(req.query?.check || '') === 'fortuneOdds') {
    try {
      const fortune = await fortuneStatus(userKey);
      const boost = await fortuneUncaughtBoost(userKey, fortune);
      const tiers = TIERS.map((tier) => {
        const boostable = boost && tier.id !== 'treasury' && tier.id !== 'unique';
        const rows = fishWeightTable(tier, (item) => (boostable ? uncaughtWeightFor(boost, `${item} [${tier.name}]`) : 1));
        return {
          id: tier.id,
          name: tier.name,
          basePct: tier.basePct,
          isCommon: !!tier.isCommon,
          luckImmune: !!tier.luckImmune,
          items: rows.map((row) => ({
            item: row.item, tier: tier.name, baseWeight: row.baseWeight, liveWeight: row.liveWeight, categoryChance: row.categoryChance
          }))
        };
      });
      return res.status(200).json({
        fortune: {
          owned: fortune.owned,
          active: fortune.active,
          level: fortune.level,
          luckAdd: fortune.luckAdd,
          uncaughtWeightMultiplier: fortune.uncaughtWeightMultiplier
        },
        tiers
      });
    } catch (err) {
      console.error('Fortune odds error:', err);
      return res.status(500).json({ error: 'Could not load odds.' });
    }
  }

  // Lightweight tutorial check. The normal GET builds the complete Shop/Perks
  // dashboard and performs many inventory/status reads. The tutorial only
  // needs to know whether Treasury Only is currently enabled, so keep this
  // path to two tiny reads and return immediately.
  if (String(req.query?.check || '') === 'treasuryOnly') {
    try {
      const [ownedRaw, toggleRaw] = await Promise.all([
        db.get(shopKey('treasuryOnly', userKey)),
        db.get(`toggle:treasuryOnly:${userKey}`)
      ]);
      return res.status(200).json({
        treasuryOnly: {
          owned: !!ownedRaw,
          enabled: !!ownedRaw && toggleRaw === 'on'
        }
      });
    } catch (err) {
      console.error('Treasury Only tutorial check error:', err);
      return res.status(500).json({ error: 'Could not check Treasury Only status.' });
    }
  }

  // ---------- GET: current perk status ----------
  try {
    await ensureTreasuryOnlyUnlocked(db, userKey);

    // Pond Treasury perks are part of the same profile/perk response.
    // Start this MGET immediately so it runs alongside the scalar perk reads below.
    const pondKeySet = pondKeys(userKey);
    const pondPerkIds = Object.keys(POND_TREASURY_PERKS);
    const pondStateKeys = [
      pondKeySet.unlocked,
      pondKeySet.treasuryPerks,
      ...pondPerkIds.map((id) => `toggle:pondPerk:${id}:${userKey}`)
    ];
    const pondStatePromise = db.mget(pondStateKeys).catch(() => []).then(async (values) => {
      const pondUnlocked = values?.[0] === 'true';
      let pondPerks = {};
      try {
        const parsed = values?.[1] ? JSON.parse(values[1]) : {};
        pondPerks = Object.fromEntries(Object.entries(POND_TREASURY_PERKS).map(([id, cfg]) => [
          id, Math.max(0, Math.min(cfg.max, Number(parsed?.[id]) || 0))
        ]));
      } catch (_) {
        pondPerks = Object.fromEntries(pondPerkIds.map((id) => [id, 0]));
      }
      const rawToggles = (Array.isArray(values) ? values : []).slice(2, 2 + pondPerkIds.length);
      const pondPerkToggles = Object.fromEntries(pondPerkIds.map((id, i) => [id, rawToggles[i] !== 'off']));
      const activePondPerks = Object.fromEntries(pondPerkIds.map((id) => [id, pondPerkToggles[id] ? pondPerks[id] : 0]));
      const speciesHunterFishdexCount = activePondPerks.speciesHunter > 0
        ? await getFishdexFishCount(userKey)
        : 0;
      return {
        pondUnlocked,
        pondPerks,
        pondPerkToggles,
        activePondPerks,
        speciesHunterFishdexCount,
        speciesHunterBonusValue: speciesHunterBonus(activePondPerks.speciesHunter, speciesHunterFishdexCount)
      };
    });
    // 3 round trips in parallel (inventory list, temp-luck TTL, and ONE mget
    // for every plain key) instead of 24 separate reads.
    const scalarKeys = [
      `perm_luck:${userKey}`,
      `game_vip:${userKey}`,
      `real_vip:${userKey}`,
      `toggle:perm:${userKey}`,
      `toggle:temp:${userKey}`,
      `toggle:vip:${userKey}`,
      `toggle:event:${userKey}`,
      `paused_temp_luck:${userKey}`,
      `paused_shop_rarity_boost:${userKey}`,
      'global:event_luck',
      'global:event_name',
      'global:event_expires',
      shopKey('luck125', userKey),
      `toggle:luck125:${userKey}`,
      shopKey('cooldown', userKey),
      `toggle:cooldown:${userKey}`,
      shopKey('treasuryLuck', userKey),
      `toggle:treasuryLuck:${userKey}`,
      shopKey('rarityBoost', userKey),
      `toggle:rarityBoost:${userKey}`,
      shopKey('treasuryOnly', userKey),
      `toggle:treasuryOnly:${userKey}`,
      `cooldown:${userKey}`,
      `timeout:${userKey}`,
      'settings:cooldown'
    ];
    const [rares, tempLuckTtl, scalarValues, rarityBoostTtl, pondState] = await Promise.all([
      db.lrange(`fish:rares:${userKey}`, 0, -1),
      db.ttl(`temp_luck:${userKey}`),
      db.mget(scalarKeys),
      db.ttl(`shop_rarity_boost:${userKey}`),
      pondStatePromise
    ]);
    const {
      pondUnlocked,
      pondPerks,
      pondPerkToggles,
      activePondPerks,
      speciesHunterFishdexCount,
      speciesHunterBonusValue
    } = pondState;
    const [
      permLuckRaw,
      gameVipRaw,
      realVipRaw,
      permToggleRaw,
      tempToggleRaw,
      vipToggleRaw,
      eventToggleRaw,
      pausedTempLuckRaw,
      pausedRarityBoostRaw,
      globalLuckRaw,
      globalNameRaw,
      globalExpiresRaw,
      shopLuckRaw,
      shopLuckToggleRaw,
      shopCooldownRaw,
      shopCooldownToggleRaw,
      shopTreasuryRaw,
      shopTreasuryToggleRaw,
      rarityBoostRaw,
      rarityBoostToggleRaw,
      treasuryOnlyRaw,
      treasuryOnlyToggleRaw,
      cooldownEndRaw,
      timeoutEndRaw,
      cooldownSettingRaw
    ] = scalarKeys.map((_key, index) => scalarValues?.[index] ?? null);

    const items = Array.isArray(rares) ? rares : [];
    // Lifetime catches are stored separately from the current inventory, so
    // consumed items do not erase fishdex progress.
    const ownsItemLike = (needle) =>
      items.some((i) => typeof i === 'string' && i.toLowerCase().includes(needle));

    // A perk is "owned" if EITHER the perk key exists (admin grant or shop
    // purchase) OR the item is sitting in the inventory (natural catch).
    // The two are different sources and either one alone is enough - a perk
    // granted by an admin never touches the inventory, and a caught item is
    // removed from the inventory once consumed.
    // Timed perks can be paused. While paused, the live Redis key is removed
    // and the remaining seconds are stored without a TTL, so the countdown
    // cannot continue while the player has the perk switched off.
    const activeTempRemainingSeconds = (typeof tempLuckTtl === 'number' && tempLuckTtl > 0) ? tempLuckTtl : 0;
    const pausedTempRemainingSeconds = pausedTempLuckRaw ? Math.max(0, parseInt(pausedTempLuckRaw, 10) || 0) : 0;
    const tempRemainingSeconds = activeTempRemainingSeconds > 0 ? activeTempRemainingSeconds : pausedTempRemainingSeconds;

    let pausedRarity = '';
    let pausedRarityRemainingSeconds = 0;
    if (pausedRarityBoostRaw) {
      try {
        const paused = JSON.parse(pausedRarityBoostRaw);
        pausedRarity = String(paused.rarity || '');
        pausedRarityRemainingSeconds = Math.max(0, parseInt(paused.seconds, 10) || 0);
      } catch (_) { console.error('[lib/game-routes/perks.js:499] ignored error:', _?.message || _); }
    }

    const hasPermLuck = !!permLuckRaw || ownsItemLike('1.5x luck');
    const hasTempLuck = activeTempRemainingSeconds > 0 || pausedTempRemainingSeconds > 0 || ownsItemLike('2x luck');
    const hasVip = !!gameVipRaw || ownsItemLike('vipfish') || realVipRaw === 'true';
    const hasShopLuck = !!shopLuckRaw;
    const hasShopCooldown = !!shopCooldownRaw;
    const hasShopTreasuryLuck = !!shopTreasuryRaw;
    const activeRarityBoostRemainingSeconds = (typeof rarityBoostTtl === 'number' && rarityBoostTtl > 0) ? rarityBoostTtl : 0;
    const rarityBoostRemainingSeconds = activeRarityBoostRemainingSeconds > 0
      ? activeRarityBoostRemainingSeconds
      : pausedRarityRemainingSeconds;
    const hasRarityBoost = (!!rarityBoostRaw && activeRarityBoostRemainingSeconds > 0) || pausedRarityRemainingSeconds > 0;
    const hasTreasuryOnly = !!treasuryOnlyRaw;

    // Remaining shields are the Shieldfish entries still present in the
    // consumable inventory; lifetime catches remain in the separate index data.
    const ownedShields = countOwnedShields(items);
    const [shieldCount, treasury] = await Promise.all([
      getAvailableShields(db, userKey, ownedShields, items),
      getTreasuryBalance(db, userKey, items)
    ]);

    // Timed perks can be paused. While paused, the live Redis key is removed
    // and the remaining seconds are stored without a TTL, so the countdown
    // cannot continue while the player has the perk switched off.
    let globalLuck = parseFloat(globalLuckRaw);
    if (isNaN(globalLuck)) globalLuck = 1.0;
    const globalActive = globalLuck > 1.0;

    let globalExpiresAt = (globalExpiresRaw !== null && globalExpiresRaw !== undefined)
      ? parseInt(globalExpiresRaw, 10)
      : null;
    if (globalExpiresAt !== null && isNaN(globalExpiresAt)) globalExpiresAt = null;

    const globalRemainingSeconds = (globalActive && globalExpiresAt)
      ? Math.max(0, Math.round((globalExpiresAt - Date.now()) / 1000))
      : null;


    // ---- Fishing status: cooldown ("tangled line") + timeout ("rod broke") ----
    // Both are stored in the database as an absolute expiry timestamp (ms) - same
    // values api/fish.js itself checks on every !fish call - so this always
    // matches what the chat bot would tell the user right now.
    const nowTs = Date.now();

    let cooldownEndsAt = (cooldownEndRaw !== null && cooldownEndRaw !== undefined) ? parseInt(cooldownEndRaw, 10) : null;
    if (cooldownEndsAt !== null && isNaN(cooldownEndsAt)) cooldownEndsAt = null;
    const cooldownRemainingMs = (cooldownEndsAt && cooldownEndsAt > nowTs) ? (cooldownEndsAt - nowTs) : 0;

    let timeoutEndsAt = (timeoutEndRaw !== null && timeoutEndRaw !== undefined) ? parseInt(timeoutEndRaw, 10) : null;
    if (timeoutEndsAt !== null && isNaN(timeoutEndsAt)) timeoutEndsAt = null;
    const timeoutRemainingMs = (timeoutEndsAt && timeoutEndsAt > nowTs) ? (timeoutEndsAt - nowTs) : 0;

    // Base cooldown (seconds) — includes the 15% reduction if the user owns
    // and has enabled the cooldown reduction perk.
    let baseCooldownSeconds = 60;
    if (cooldownSettingRaw !== null && cooldownSettingRaw !== undefined) {
      baseCooldownSeconds = parseInt(cooldownSettingRaw, 10);
    }
    if (shopCooldownRaw && shopCooldownToggleRaw !== 'off') {
      baseCooldownSeconds = Math.round(baseCooldownSeconds * 0.85);
    }

    // These reads do not depend on each other, so they run together.
    const [pricedShop, fortune, channelPerk, autoFish, manualCatchesRaw, shieldToggleRaw, customEffectsRaw] = await Promise.all([
      getShopItemsWithPrices(db),
      fortuneStatus(userKey),
      channelPerkStatus(userKey),
      autoFishStatus(userKey),
      db.get(`fish:count:${userKey}`),
      db.get(`toggle:shield:${userKey}`),
      process.env.LOCAL_EDITION === '1' ? db.get(`fish:custom_effects:${userKey}`) : Promise.resolve(null)
    ]);
    const customFishPerks = activeCustomEffectTotals(customEffectsRaw).active.map((effect) => ({
      fishName: String(effect.fishName || '').slice(0, 80),
      perkName: String(effect.perkName || 'Custom fish perk').slice(0, 48),
      description: String(effect.description || '').slice(0, 240),
      type: String(effect.type || ''),
      value: Number(effect.value) || 1,
      cooldownReductionPct: Number(effect.cooldownReductionPct ?? (effect.type === 'cooldownReduction' ? effect.value : 0)) || 0,
      expiresAt: Number(effect.expiresAt) || 0,
      remainingSeconds: Math.max(0, Math.ceil((Number(effect.expiresAt) - Date.now()) / 1000))
    }));
    return res.status(200).json({
      customFishPerks,
      channelPerk,
      treasury,
      fortune,
      autoFish,
      fishing: {
        ready: cooldownRemainingMs === 0 && timeoutRemainingMs === 0,
        cooldownRemainingMs,
        timeoutRemainingMs,
        baseCooldownSeconds
      },
      // Most shop perks are permanent. Rarity Boost is reusable: each purchase
      // lasts 15 minutes, then disappears and can be bought again for 20 Treasury.
      shop: {
        luck125: { owned: !!shopLuckRaw, toggleOn: shopLuckToggleRaw !== 'off', cost: pricedShop.luck125.cost },
        cooldown: { owned: !!shopCooldownRaw, toggleOn: shopCooldownToggleRaw !== 'off', cost: pricedShop.cooldown.cost },
        treasuryLuck: { owned: !!shopTreasuryRaw, toggleOn: shopTreasuryToggleRaw !== 'off', cost: pricedShop.treasuryLuck.cost },
        rarityBoost: {
          owned: hasRarityBoost,
          rarity: hasRarityBoost ? (rarityBoostRaw || pausedRarity || '') : '',
          toggleOn: rarityBoostToggleRaw !== 'off',
          active: hasRarityBoost && activeRarityBoostRemainingSeconds > 0 && rarityBoostToggleRaw !== 'off',
          remainingSeconds: rarityBoostRemainingSeconds,
          cost: pricedShop.rarityBoost.cost
        },
        [FORTUNE_ITEM]: { owned: fortune.owned, toggleOn: fortune.toggleOn, cost: pricedShop[FORTUNE_ITEM].cost, level: fortune.level, percent: fortune.percent },
        treasuryOnly: {
          owned: !!treasuryOnlyRaw,
          toggleOn: treasuryOnlyToggleRaw === 'on',
          cost: 0,
          manualCatches: Math.max(0, parseInt(manualCatchesRaw, 10) || 0),
          unlockCatches: TREASURY_ONLY_MANUAL_CATCH_UNLOCK
        }
      },
      pond: {
        unlocked: pondUnlocked,
        treasuryPerks: pondPerks,
        treasuryPerkToggles: pondPerkToggles,
        activeTreasuryPerks: activePondPerks,
        speciesHunter: {
          level: pondPerks.speciesHunter || 0,
          active: !!activePondPerks.speciesHunter,
          max: POND_TREASURY_PERKS.speciesHunter.max,
          fishdexCaught: speciesHunterFishdexCount,
          bonus: speciesHunterBonusValue,
          bonusText: `+${speciesHunterBonusValue.toFixed(2)}x Luck`
        }
      },
      shield: {
        owned: ownsItemLike('shieldfish'),
        count: shieldCount,
        toggleOn: shieldToggleRaw !== 'off'
      },
      permLuck: {
        owned: hasPermLuck,
        // Active = the perk key is set AND the player has not toggled it off.
        // Reading the key alone was the old behaviour, which lit up a perk
        // the player had switched off.
        active: !!permLuckRaw && permToggleRaw !== 'off',
        toggleOn: permToggleRaw !== 'off'
      },
      tempLuck: {
        owned: hasTempLuck,
        active: tempRemainingSeconds > 0 && tempToggleRaw !== 'off',
        remainingSeconds: tempRemainingSeconds,
        toggleOn: tempToggleRaw !== 'off'
      },
      vip: {
        // A player owns the VIP luck perk if they have the permanent game
        // Vipfish effect or currently hold a real Twitch VIP/Sub/Mod role in
        // the selected verified broadcaster channel.
        owned: hasVip,
        active: (!!gameVipRaw || realVipRaw === 'true') && vipToggleRaw !== 'off',
        toggleOn: vipToggleRaw !== 'off',
        twitchRole: liveTwitchRole,
        twitchChannel: liveTwitchChannel
      },
      event: {
        active: globalActive,
        multiplier: globalLuck,
        name: globalNameRaw || '',
        remainingSeconds: globalRemainingSeconds,
        toggleOn: eventToggleRaw !== 'off'
      }
    });
  } catch (err) {
    console.error('Perks API Error:', err);
    return res.status(500).json({ error: 'Database error. Please try again.' });
  }
}

// The viewer's channel (their selection on the Profile), the upgrade levels
// in that channel, and whether this viewer has the perk switched on.
async function channelPerkStatus(user) {
  const channel = await selectedStreamerFor(user);
  if (!channel) return { channel: null, enabled: false, upgrades: [] };
  const [progress, toggle] = await Promise.all([
    readChannelProgress(db, channel),
    db.get(channelPerkKey(user, channel)).catch(() => null)
  ]);
  const maxLevel = CHANNEL_UPGRADE_COSTS.length;
  return {
    channel,
    enabled: toggle !== 'off',
    upgrades: CHANNEL_UPGRADES.map((upgrade) => {
      const level = progress.levels[upgrade.id] || 0;
      return {
        id: upgrade.id,
        name: upgrade.name,
        level,
        maxLevel,
        effect: level ? upgrade.values[level - 1] : null
      };
    })
  };
}
