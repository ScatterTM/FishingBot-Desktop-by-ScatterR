// Read-only Twitch chat commands for the self-hosted edition.
// Commands are scoped to the sender's Twitch login; they never accept an
// arbitrary target username, so chat users cannot inspect other inventories.

import { db } from '../lib/db.js';
import { readInventoryItems, catchCountKey, isTreasuryItem, removeInventoryItems, withKeyLock } from '../lib/inventory.js';
import { SHOP_ITEMS, shopKey, getShopItemsWithPrices, getTreasuryBalance, ensureTreasuryOnlyUnlocked, BOOSTABLE_RARITIES } from '../lib/shop.js';
import { TIERS } from '../lib/tiers.js';
import { readProgression } from '../lib/progression.js';
import { autoFishKeys, readAutoFishState, getAutoFishConfig, startAutoFish, stopAutoFish } from '../lib/autofish.js';
import { pondKeys, POND_TREASURY_PERKS, POND_CHAT_UNLOCK_PRESTIGE } from '../lib/pond.js';
import { FISHING_AREAS, AREA_IDS, areaLevelKey, selectedAreaKey, readUserAreaLevels, areaEnabledKey, AREAS_ENABLED_KEY, isEnabledValue } from '../lib/areas.js';
import { DEX_PROGRESS_KEYS } from '../lib/dexcatalog.js';

const COMMAND_COOLDOWN_MS = 10000;
const USER_COMMAND_GAP_MS = 2500;
const lastCommandAt = new Map();
const lastAnyCommandAt = new Map();
const tierRank = new Map(TIERS.map((tier) => [String(tier.name).toUpperCase(), Number(tier.rankScore) || 0]));

function cleanLogin(value) {
  const login = String(value || '').trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(login) ? login : '';
}

function compact(text, max = 450) {
  const clean = String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function parseInventoryEntry(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*?)\s*\[([A-Z]+)\]\s*$/i);
  return {
    raw,
    name: match ? match[1].trim() : raw,
    tier: match ? match[2].toUpperCase() : 'COMMON',
    rank: match ? (tierRank.get(match[2].toUpperCase()) || 0) : 0
  };
}

async function inventoryReply(user, page = 0) {
  const items = (await readInventoryItems(db, user)).filter((item) => typeof item === 'string');
  const counts = new Map();
  for (const raw of items) counts.set(raw, (counts.get(raw) || 0) + 1);
  const treasury = items.filter((item) => /[\[(]treasury[\])]\s*$/i.test(String(item).trim())).length;
  const unique = counts.size;

  // The default command is intentionally a single, compact summary. Viewers
  // can explicitly ask for one small page when they want individual fish.
  if (!page) return compact(`Inventory: ${items.length} fish · ${unique} unique · ${treasury} Treasury.`, 180);

  const ordered = [...counts.entries()]
    .map(([raw, count]) => ({ ...parseInventoryEntry(raw), count }))
    .filter((item) => item.name)
    .sort((a, b) => b.rank - a.rank || b.count - a.count || a.name.localeCompare(b.name));
  const pageSize = 4;
  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
  const safePage = Math.min(pageCount, Math.max(1, Number(page) || 1));
  const rows = ordered.slice((safePage - 1) * pageSize, safePage * pageSize)
    .map((item) => `${item.name} [${item.tier}] ×${item.count}`);
  return compact(`Inventory ${safePage}/${pageCount}: ${rows.length ? rows.join(' · ') : 'No fish recorded yet'}.`, 360);
}
async function perksReply(user) {
  const ids = Object.keys(SHOP_ITEMS);
  const scalarKeys = [
    `perm_luck:${user}`, `game_vip:${user}`, `real_vip:${user}`,
    `toggle:perm:${user}`, `toggle:temp:${user}`, `toggle:vip:${user}`,
    `paused_temp_luck:${user}`,
    ...ids.map((id) => shopKey(id, user)),
    ...ids.map((id) => `toggle:${id}:${user}`),
    `pond:treasury_perks:${user}`
  ];
  const [values, items, tempTtl, rarityTtl] = await Promise.all([
    db.mget(scalarKeys),
    readInventoryItems(db, user),
    db.ttl(`temp_luck:${user}`),
    db.ttl(`shop_rarity_boost:${user}`)
  ]);
  let i = 0;
  const permLuck = values[i++];
  const gameVip = values[i++];
  const realVip = values[i++];
  const permToggle = values[i++];
  const tempToggle = values[i++];
  const vipToggle = values[i++];
  const pausedTemp = values[i++];
  const shopOwned = Object.fromEntries(ids.map((id) => [id, values[i++]]));
  const shopToggles = Object.fromEntries(ids.map((id) => [id, values[i++]]));
  const pondPerksRaw = values[i++];
  const ownedItems = new Set(items.map((item) => String(item).toLowerCase()));
  const active = [];

  const hasPerm = !!permLuck || [...ownedItems].some((item) => item.includes('1.5x luck'));
  if (hasPerm && permToggle !== 'off') active.push('1.5x Luck');
  const hasTemp = Number(tempTtl) > 0 || !!pausedTemp || [...ownedItems].some((item) => item.includes('2x luck'));
  if (hasTemp && tempToggle !== 'off') active.push(Number(tempTtl) > 0 ? `2x Luck (${Math.ceil(Number(tempTtl) / 60)}m)` : '2x Luck (paused/owned)');
  const hasVip = !!gameVip || realVip === 'true' || [...ownedItems].some((item) => item.includes('vipfish'));
  if (hasVip && vipToggle !== 'off') active.push('VIP Fishing');

  for (const id of ids) {
    if (!shopOwned[id]) continue;
    if (id === 'rarityBoost' && Number(rarityTtl) <= 0) continue;
    if (shopToggles[id] === 'off') continue;
    const label = SHOP_ITEMS[id]?.name || id;
    active.push(id === 'rarityBoost' ? `${label} (${Math.ceil(Number(rarityTtl) / 60)}m)` : label);
  }

  let pondLevels = {};
  try { pondLevels = JSON.parse(pondPerksRaw || '{}') || {}; } catch { pondLevels = {}; }
  const pondIds = Object.keys(POND_TREASURY_PERKS);
  const pondToggles = await db.mget(pondIds.map((id) => `toggle:pondPerk:${id}:${user}`));
  for (let n = 0; n < pondIds.length; n++) {
    const id = pondIds[n];
    const level = Math.max(0, Math.min(POND_TREASURY_PERKS[id].max, Number(pondLevels[id]) || 0));
    if (level > 0 && pondToggles?.[n] !== 'off') active.push(`${POND_TREASURY_PERKS[id].label} Lv${level}`);
  }

  if (!active.length) return `@${user}: no active perks found. Check your Perks page in the game.`;
  const visible = active.slice(0, 4);
  const rest = active.length - visible.length;
  return compact(`@${user} perks: ${visible.join(', ')}${rest > 0 ? `, +${rest} more` : ''}.`);
}

async function fishdexReply(user) {
  const inventory = new Set(await readInventoryItems(db, user));
  const keys = DEX_PROGRESS_KEYS.map((item) => catchCountKey(user, item));
  const history = await db.mget(keys);
  let caught = 0;
  for (let index = 0; index < DEX_PROGRESS_KEYS.length; index++) {
    const stored = history?.[index];
    const hasCaught = stored === null || stored === undefined
      ? inventory.has(DEX_PROGRESS_KEYS[index])
      : Number(stored) > 0;
    if (hasCaught) caught++;
  }
  const total = DEX_PROGRESS_KEYS.length;
  const percent = total ? Math.round((caught / total) * 100) : 0;
  return `@${user} Fishdex: ${caught}/${total} species discovered (${percent}%).`;
}

async function statsReply(user) {
  const [progress, fishdex, auto, catchCount] = await Promise.all([
    readProgression(user),
    fishdexReply(user),
    readAutoFishState(user),
    db.get(`fish:count:${user}`)
  ]);
  const title = progress.title ? `; Title: ${progress.title}` : '';
  const autoText = auto.licensed
    ? `; Auto-Fish Lv${auto.level}, Prestige ${auto.prestige}${auto.active ? ' (running)' : ''}`
    : '; Auto-Fish not licensed';
  const dexText = fishdex.replace(`@${user} Fishdex: `, '').replace('.', '');
  return compact(`@${user}: ${Number(catchCount) || 0} manual casts; ${dexText}${autoText}${title}.`);
}

async function pondReply(user) {
  const auto = await readAutoFishState(user);
  const keys = pondKeys(user);
  const [unlocked, level, tokens, pendingRaw, chatUnlocked] = await db.mget([
    keys.unlocked, keys.level, keys.tokens, keys.pending, keys.chatUnlocked
  ]);
  if (unlocked !== 'true') {
    return `@${user}: Personal Pond unlocks at Auto-Fish Prestige 1 (you are Prestige ${auto.prestige}).`;
  }
  let pending = [];
  try { pending = JSON.parse(pendingRaw || '[]'); } catch { pending = []; }
  const chat = chatUnlocked === 'true' ? 'chat collection unlocked' : `chat collection unlocks at Prestige ${POND_CHAT_UNLOCK_PRESTIGE}`;
  return `@${user} Pond: Level ${Math.max(1, Number(level) || 1)}, ${Math.max(0, Number(tokens) || 0)} FishyTokens, ${Array.isArray(pending) ? pending.length : 0} fish waiting; ${chat}.`;
}

async function leaderboardReply() {
  const result = await db.scan('0', { match: 'fish:count:*', count: 500 });
  const keys = (result?.[1] || []).filter((key) => /^fish:count:[a-z0-9_]{1,25}$/i.test(key));
  if (!keys.length) return 'Leaderboard: no catches have been recorded yet.';
  const values = await db.mget(keys);
  const rows = keys.map((key, index) => ({
    user: key.slice('fish:count:'.length),
    casts: Math.max(0, Number(values?.[index]) || 0)
  })).filter((row) => row.casts > 0)
    .sort((a, b) => b.casts - a.casts || a.user.localeCompare(b.user))
    .slice(0, 3);
  if (!rows.length) return 'Leaderboard: no catches have been recorded yet.';
  return compact(`Top anglers: ${rows.map((row, index) => `${index + 1}. ${row.user} (${row.casts})`).join(' | ')}.`);
}

const SHOP_IDS = Object.keys(SHOP_ITEMS);
const CHAT_PERKS = new Set(['perm', 'temp', 'vip', 'event', 'shield', ...SHOP_IDS, ...Object.keys(POND_TREASURY_PERKS)]);
const VALID_RARITIES = new Set(BOOSTABLE_RARITIES.map((value) => value.toLowerCase()));

function usageReply(command) {
  const usage = {
    buy: '!buy <perk-id> [rarity] — !buy to list prices',
    perks: '!perks [enable <perk-id>|disable <perk-id>]',
    autofish: '!autofish start [area-id] | !autofish stop',
    areas: '!areas [list|buy <area-id>|select <area-id>|unselect]',
    treasury: '!treasury'
  };
  return `Usage: ${usage[command] || `!${command}`}`;
}

function isValidLogin(value) {
  return /^[a-z0-9_]{1,25}$/.test(String(value || ''));
}

async function shopListReply() {
  const catalog = await getShopItemsWithPrices(db);
  const rows = Object.entries(catalog).map(([id, item]) => `${id} (${item.cost})`);
  return compact(`Shop — costs in Treasury: ${rows.join(' · ')}. Buy with !buy <perk-id>; Rarity Boost also needs a rarity.`, 440);
}

async function buyChatPerk(user, itemId, rarity) {
  if (!Object.prototype.hasOwnProperty.call(SHOP_ITEMS, itemId)) return `Unknown perk ID. ${await shopListReply()}`;
  if (itemId === 'rarityBoost' && !VALID_RARITIES.has(String(rarity || '').toLowerCase())) {
    return `Rarity Boost needs a rarity: ${BOOSTABLE_RARITIES.join(', ')}.`;
  }
  const priced = await getShopItemsWithPrices(db);
  const item = priced[itemId];
  if (itemId === 'treasuryOnly') {
    const unlocked = await ensureTreasuryOnlyUnlocked(db, user);
    if (!unlocked) {
      const catches = Math.max(0, Number(await db.get(`fish:count:${user}`)) || 0);
      return `Treasury Only unlocks after 25 manual catches (${Math.min(catches, 25)}/25).`;
    }
    return 'Treasury Only is already unlocked for your account. Enable it with !perks enable treasuryOnly.';
  }
  return withKeyLock(db, `shop-purchase:${user}`, async () => {
    const purchaseKey = shopKey(itemId, user);
    const pausedKey = itemId === 'rarityBoost' ? `paused_shop_rarity_boost:${user}` : null;
    const [owned, ttlRaw, pausedRaw, items] = await Promise.all([
      db.get(purchaseKey), item.ttl ? db.ttl(purchaseKey) : Promise.resolve(-1),
      pausedKey ? db.get(pausedKey) : Promise.resolve(null), readInventoryItems(db, user)
    ]);
    const ttl = item.ttl ? Number(ttlRaw) : -1;
    if (itemId === 'rarityBoost') {
      if (owned && ttl > 0) return `Rarity Boost is already active for about ${Math.ceil(ttl / 60)} more minute(s).`;
      if (pausedRaw) return 'Rarity Boost is paused. Enable it with !perks enable rarityBoost before buying another.';
      if (owned && ttl <= 0) await db.del(purchaseKey);
    } else if (owned) return `You already own ${item.name}.`;
    const { balance } = await getTreasuryBalance(db, user, items);
    if (balance < item.cost) return `Not enough Treasury: ${item.name} costs ${item.cost}; you have ${balance}.`;
    const value = itemId === 'rarityBoost' ? String(rarity).toLowerCase() : 'true';
    const set = await db.set(purchaseKey, value, item.ttl ? { ex: item.ttl } : { nx: true });
    if (!set) return `You already own ${item.name}.`;
    try {
      const removed = await removeInventoryItems(db, user, isTreasuryItem, item.cost, item.cost);
      if (removed.removed.length !== item.cost) {
        await db.del(purchaseKey);
        return 'Treasury inventory changed during purchase; no purchase was completed. Please retry.';
      }
      if (itemId === 'rarityBoost') await db.set(`toggle:rarityBoost:${user}`, 'on');
      await db.incrby(`progression:chat_treasury_spent:${user}`, item.cost);
      return `Purchased ${item.name} for ${item.cost} Treasury. Remaining: ${balance - item.cost}.`;
    } catch (error) {
      await db.del(purchaseKey);
      throw error;
    }
  });
}

async function toggleChatPerk(user, perkId, enabled) {
  if (!CHAT_PERKS.has(perkId)) return `Unknown perk ID. Use !perks to see available perks; IDs are case-sensitive except for capitalization.`;
  if (Object.prototype.hasOwnProperty.call(POND_TREASURY_PERKS, perkId)) {
    let levels = {};
    try { levels = JSON.parse(await db.get(pondKeys(user).treasuryPerks) || '{}'); } catch { levels = {}; }
    if (!(Number(levels?.[perkId]) > 0)) return `You do not own Pond perk ${perkId}.`;
    await db.set(`toggle:pondPerk:${perkId}:${user}`, enabled ? 'on' : 'off');
    return `${POND_TREASURY_PERKS[perkId].label} ${enabled ? 'enabled' : 'disabled'}.`;
  }
  if (SHOP_IDS.includes(perkId)) {
    if (perkId === 'treasuryOnly') {
      const unlocked = await ensureTreasuryOnlyUnlocked(db, user);
      if (!unlocked) {
        const catches = Math.max(0, Number(await db.get(`fish:count:${user}`)) || 0);
        return `Treasury Only unlocks after 25 manual catches (${Math.min(catches, 25)}/25).`;
      }
    }
    const owned = await db.get(shopKey(perkId, user));
    if (!owned) return `You do not own ${perkId}. Use !buy ${perkId} first if it is purchasable.`;
    if (perkId === 'rarityBoost') {
      const liveKey = shopKey('rarityBoost', user);
      const pausedKey = `paused_shop_rarity_boost:${user}`;
      if (enabled) {
        const live = await db.get(liveKey);
        const pausedRaw = await db.get(pausedKey);
        if (!live && pausedRaw) {
          let paused = null;
          try { paused = JSON.parse(pausedRaw); } catch { paused = null; }
          const seconds = Math.max(0, Number(paused?.seconds) || 0);
          if (seconds > 0 && VALID_RARITIES.has(String(paused?.rarity || '').toLowerCase())) {
            await db.set(liveKey, String(paused.rarity), { ex: seconds });
          }
          await db.del(pausedKey);
        }
        if (!await db.get(liveKey)) return 'Rarity Boost has expired. Buy it again with !buy rarityBoost <rarity>.';
        await db.set(`toggle:rarityBoost:${user}`, 'on');
      } else {
        const live = await db.get(liveKey);
        const ttl = live ? Number(await db.ttl(liveKey)) : -2;
        if (live && ttl > 0) {
          await db.set(pausedKey, JSON.stringify({ rarity: live, seconds: ttl }));
          await db.del(liveKey);
        }
        await db.set(`toggle:rarityBoost:${user}`, 'off');
      }
      return `Rarity Boost ${enabled ? 'enabled' : 'disabled'}.`;
    }
    await db.set(`toggle:${perkId}:${user}`, enabled ? 'on' : 'off');
    return `${SHOP_ITEMS[perkId].name} ${enabled ? 'enabled' : 'disabled'}.`;
  }
  const inventory = await readInventoryItems(db, user);
  const hasPerm = !!(await db.get(`perm_luck:${user}`)) || inventory.some((item) => /1\.5x luck/i.test(item));
  const hasTemp = Number(await db.ttl(`temp_luck:${user}`)) > 0 || !!(await db.get(`paused_temp_luck:${user}`)) || inventory.some((item) => /2x luck/i.test(item));
  const hasVip = !!(await db.get(`game_vip:${user}`)) || (await db.get(`real_vip:${user}`)) === 'true' || inventory.some((item) => /vipfish/i.test(item));
  if (perkId === 'perm' && !hasPerm) return 'You do not own Permanent Luck.';
  if (perkId === 'temp' && !hasTemp) return 'You do not own Temporary Luck.';
  if (perkId === 'vip' && !hasVip) return 'VIP Fishing is not available on your account.';
  if (perkId === 'temp') {
    const liveKey = `temp_luck:${user}`;
    const pausedKey = `paused_temp_luck:${user}`;
    if (enabled) {
      const live = await db.get(liveKey);
      const remaining = await db.get(pausedKey);
      if (!live && remaining && Number(remaining) > 0) await db.set(liveKey, 'true', { ex: Number(remaining) });
      await db.del(pausedKey);
    } else {
      const live = await db.get(liveKey);
      const ttl = live ? Number(await db.ttl(liveKey)) : -2;
      if (live && ttl > 0) { await db.set(pausedKey, String(ttl)); await db.del(liveKey); }
    }
  }
  await db.set(`toggle:${perkId}:${user}`, enabled ? 'on' : 'off');
  return `${perkId} ${enabled ? 'enabled' : 'disabled'}.`;
}

async function configuredAreaPrices() {
  let configured = {};
  try { configured = JSON.parse(await db.get('config:area:prices') || '{}') || {}; } catch { configured = {}; }
  return Object.fromEntries(AREA_IDS.map((id) => {
    const raw = Number(configured?.[id]?.unlockCost);
    const cost = Number.isFinite(raw) && raw >= 0 && raw <= 1_000_000_000
      ? Math.floor(raw) : FISHING_AREAS[id].unlockCost;
    return [id, cost];
  }));
}

async function areasReply(user, action, areaId) {
  const areaPrices = await configuredAreaPrices();
  const levels = await readUserAreaLevels(db, user);
  const selectedRaw = await db.get(selectedAreaKey(user));
  const selected = FISHING_AREAS[selectedRaw] ? selectedRaw : null;
  const balance = (await getTreasuryBalance(db, user, await readInventoryItems(db, user))).balance;
  if (action === 'list' || !action) {
    const rows = AREA_IDS.map((id) => {
      const area = FISHING_AREAS[id];
      return `${id}:${levels[id] ? `Lv${levels[id]}${selected === id ? '*' : ''}` : `${areaPrices[id]}T`}`;
    });
    return compact(`Areas (* selected; unowned shows unlock cost): ${rows.join(' · ')}. Balance ${balance} Treasury. Use !areas buy <id>, !areas select <id>, or !areas unselect.`, 450);
  }
  if (action === 'unselect') {
    await db.del(selectedAreaKey(user));
    return 'Fishing area unselected; normal waters are active.';
  }
  if (!FISHING_AREAS[areaId]) return `Unknown area ID. Valid IDs: ${AREA_IDS.join(', ')}.`;
  const area = FISHING_AREAS[areaId];
  if (action === 'select') {
    if ((await db.get(AREAS_ENABLED_KEY)) === 'off' || (await db.get(areaEnabledKey(areaId))) === 'off') return `${area.name} is disabled by the streamer.`;
    if (!(levels[areaId] > 0)) return `You have not unlocked ${area.name}. Use !areas buy ${areaId} (cost ${areaPrices[areaId]} Treasury).`;
    await db.set(selectedAreaKey(user), areaId);
    return `${area.name} selected.`;
  }
  if (action !== 'buy') return usageReply('areas');
  return withKeyLock(db, `area-purchase:${user}`, async () => {
    const currentLevels = await readUserAreaLevels(db, user);
    if ((await db.get(AREAS_ENABLED_KEY)) === 'off' || (await db.get(areaEnabledKey(areaId))) === 'off') return `${area.name} is disabled by the streamer.`;
    if (currentLevels[areaId] > 0) return `You already own ${area.name} at Level ${currentLevels[areaId]}.`;
    const items = await readInventoryItems(db, user);
    const currentBalance = (await getTreasuryBalance(db, user, items)).balance;
    const cost = areaPrices[areaId];
    if (currentBalance < cost) return `${area.name} costs ${cost} Treasury; you have ${currentBalance}.`;
    const removed = await removeInventoryItems(db, user, isTreasuryItem, cost, cost);
    if (removed.removed.length !== cost) return 'Treasury inventory changed during purchase; please retry.';
    await db.set(areaLevelKey(user, areaId), '1');
    await db.incr(`progression:areas:${user}`);
    await db.incrby(`progression:chat_treasury_spent:${user}`, cost);
    if (!await db.get(selectedAreaKey(user))) await db.set(selectedAreaKey(user), areaId);
    return `Unlocked ${area.name} for ${cost} Treasury. Remaining: ${currentBalance - cost}.`;
  });
}

async function treasuryReply(user) {
  const [items, progression, trackedSpent] = await Promise.all([
    readInventoryItems(db, user), readProgression(user), db.get(`progression:chat_treasury_spent:${user}`)
  ]);
  const balance = await getTreasuryBalance(db, user, items);
  const earned = Math.max(0, Number(progression.treasury) || 0);
  // The older database tracks catches and currently-held items, but not every historical purchase.
  // Prefer exact spend tracked by the new chat flows; otherwise show the inferred net amount explicitly.
  const inferredSpent = Math.max(0, earned - balance.balance);
  const spent = Math.max(inferredSpent, Number(trackedSpent) || 0);
  return `Treasury — available: ${balance.balance}; caught/earned: ${earned}; net spent/used: ${spent}.`;
}

export function isChatInfoCommand(text) {
  return /^!(?:inventory|inv|perks|stats|fishdex|dex|pond|leaderboard|top|help|buy|areas|autofish|treasury)(?:\s|$)/i.test(String(text || '').trim());
}

export async function runChatInfoCommand({ text, user, userId }) {
  const login = String(user || '').trim().replace(/^@+/, '').toLowerCase();
  if (!isValidLogin(login)) return null;
  const input = String(text || '').trim();
  if (input.length > 250) return null;
  const match = input.match(/^!(inventory|inv|perks|stats|fishdex|dex|pond|leaderboard|top|help|buy|areas|autofish|treasury)(?:\s+(.*))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const args = String(match[2] || '').trim();
  const parts = args ? args.split(/\s+/) : [];
  if (command === 'buy' && parts[0]) parts[0] = SHOP_IDS.find((id) => id.toLowerCase() === parts[0].toLowerCase()) || parts[0].toLowerCase();
  if (command === 'areas' && parts[1]) parts[1] = parts[1].toLowerCase();
  if (command === 'autofish' && parts[1]) parts[1] = parts[1].toLowerCase();
  if (command === 'perks' && parts[1]) parts[1] = [...CHAT_PERKS].find((id) => id.toLowerCase() === parts[1].toLowerCase()) || parts[1].toLowerCase();
  const canonical = ({ inv: 'inventory', dex: 'fishdex', top: 'leaderboard' })[command] || command;

  // Rate-limit every recognized command, including malformed usage attempts, so invalid
  // arguments cannot be used to flood private replies or repeatedly exercise parsers.
  const now = Date.now();
  const lastAny = lastAnyCommandAt.get(login) || 0;
  const last = lastCommandAt.get(`${login}:${canonical}`) || 0;
  if (now - lastAny < USER_COMMAND_GAP_MS || now - last < COMMAND_COOLDOWN_MS) return null;
  lastAnyCommandAt.set(login, now);
  lastCommandAt.set(`${login}:${canonical}`, now);
  if (lastCommandAt.size > 4000) {
    for (const [key, at] of lastCommandAt) if (now - at > 120000) lastCommandAt.delete(key);
    for (const [key, at] of lastAnyCommandAt) if (now - at > 120000) lastAnyCommandAt.delete(key);
  }

  // Command shape and every argument are validated before touching player state.
  if (command === 'inventory' || command === 'inv') {
    if (args && !/^(?:list|page)(?:\s+\d{1,3})?$/i.test(args)) return usageReply('inventory');
  } else if (command === 'buy') {
    if (parts.length > 2 || (parts.length === 2 && (parts[0] !== 'rarityBoost' || !VALID_RARITIES.has(parts[1].toLowerCase())))) return usageReply('buy');
    if (parts.length === 1 && !Object.prototype.hasOwnProperty.call(SHOP_ITEMS, parts[0]) && parts[0].toLowerCase() !== 'treasuryonly') return usageReply('buy');
  } else if (command === 'perks') {
    if (parts.length && !(parts.length === 2 && /^(enable|disable)$/i.test(parts[0]) && CHAT_PERKS.has(parts[1]))) return usageReply('perks');
  } else if (command === 'autofish') {
    if (parts.length < 1 || parts.length > 2 || !/^(start|stop)$/i.test(parts[0]) || (parts[0].toLowerCase() === 'stop' && parts.length !== 1) || (parts.length === 2 && !Object.prototype.hasOwnProperty.call(FISHING_AREAS, parts[1]))) return usageReply('autofish');
  } else if (command === 'areas') {
    if (!(parts.length === 0 || (parts.length === 1 && /^(list|unselect)$/i.test(parts[0])) || (parts.length === 2 && /^(buy|select)$/i.test(parts[0]) && Object.prototype.hasOwnProperty.call(FISHING_AREAS, parts[1])))) return usageReply('areas');
  } else if (args) {
    return usageReply(command);
  }

  try {
    switch (command) {
      case 'inventory':
      case 'inv': return inventoryReply(login, args ? Math.max(1, Math.min(999, Number(args.match(/\d+/)?.[0]) || 1)) : 0);
      case 'perks':
        if (!parts.length) {
          const active = await perksReply(login);
          const shop = await shopListReply();
          return compact(`${active} ${shop}`, 490);
        }
        return toggleChatPerk(login, parts[1], parts[0].toLowerCase() === 'enable');
      case 'buy':
        if (!parts.length) return shopListReply();
        return buyChatPerk(login, parts[0], parts[1]);
      case 'autofish': {
        if (parts[0].toLowerCase() === 'stop') {
          await stopAutoFish(login);
          return 'Auto-Fish stopped.';
        }
        const config = await getAutoFishConfig();
        const result = await startAutoFish(login, config, parts[1] || null);
        if (!result.success) return result.error || 'Auto-Fish could not be started.';
        const state = await readAutoFishState(login, config);
        return `Auto-Fish started at Level ${state.level} for about ${Math.round((result.expiresAt - Date.now()) / 60000)} minutes${parts[1] ? ` targeting ${FISHING_AREAS[parts[1]].name}` : ''}.`;
      }
      case 'areas': return areasReply(login, parts[0]?.toLowerCase() || 'list', parts[1]?.toLowerCase());
      case 'treasury': return treasuryReply(login);
      case 'stats': return statsReply(login);
      case 'fishdex':
      case 'dex': return fishdexReply(login);
      case 'pond': return pondReply(login);
      case 'leaderboard':
      case 'top': return leaderboardReply();
      case 'help': return 'Fishingbot commands: !fish [pond]; !buy [perk-id] [rarity]; !perks [enable|disable perk-id]; !autofish start [area-id] / stop; !areas [list|buy|select area-id|unselect]; !treasury; !inventory or !inv [list page]; !stats; !fishdex or !dex; !pond; !leaderboard or !top; !help.';
      default: return null;
    }
  } catch (error) {
    console.error(`[chat-command] ${command} failed for ${login}:`, error?.message || error);
    return `Could not complete !${command}: ${compact(error?.message || 'unexpected error', 180)} Please retry in a moment.`;
  }
}
