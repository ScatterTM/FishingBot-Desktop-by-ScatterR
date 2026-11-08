// Read-only Twitch chat commands for the self-hosted edition.
// Commands are scoped to the sender's Twitch login; they never accept an
// arbitrary target username, so chat users cannot inspect other inventories.

import { db } from '../lib/db.js';
import { readInventoryItems, catchCountKey } from '../lib/inventory.js';
import { SHOP_ITEMS, shopKey } from '../lib/shop.js';
import { TIERS } from '../lib/tiers.js';
import { progressionKeys, readProgression } from '../lib/progression.js';
import { autoFishKeys, readAutoFishState } from '../lib/autofish.js';
import { pondKeys, POND_TREASURY_PERKS, POND_CHAT_UNLOCK_PRESTIGE } from '../lib/pond.js';
import { DEX_PROGRESS_KEYS } from '../lib/dexcatalog.js';

const COMMAND_COOLDOWN_MS = 15000;
const lastCommandAt = new Map();
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

export function isChatInfoCommand(text) {
  return /^!(?:inventory|inv|perks|stats|fishdex|dex|pond|leaderboard|top|help)(?:\s|$)/i.test(String(text || '').trim());
}

export async function runChatInfoCommand({ text, user }) {
  const login = cleanLogin(user);
  if (!login) return null;
  const match = String(text || '').trim().match(/^!(inventory|inv|perks|stats|fishdex|dex|pond|leaderboard|top|help)(?:\s+(.*))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const args = String(match[2] || '').trim();

  let inventoryPage = 0;
  if (command === 'inventory' || command === 'inv') {
    if (args) {
      const pageMatch = args.match(/^(?:list|page)(?:\s+(\d+))?$/i);
      if (!pageMatch) return null;
      inventoryPage = Math.max(1, Math.min(999, Number(pageMatch[1]) || 1));
    }
  } else if (args) {
    // Personal commands never accept a target username. This prevents chat
    // users from querying another player's inventory or progression.
    return `@${login}: this command does not accept a username or extra arguments.`;
  }

  const now = Date.now();
  const cooldownCommand = ({ inv: 'inventory', dex: 'fishdex', top: 'leaderboard' })[command] || command;
  const cooldownKey = `${login}:${cooldownCommand}`;
  const last = lastCommandAt.get(cooldownKey) || 0;
  if (now - last < COMMAND_COOLDOWN_MS) return null;
  lastCommandAt.set(cooldownKey, now);
  if (lastCommandAt.size > 2000) {
    for (const [key, at] of lastCommandAt) if (now - at > 60000) lastCommandAt.delete(key);
  }

  switch (command) {
    case 'inventory':
    case 'inv': return inventoryReply(login, inventoryPage);
    case 'perks': return perksReply(login);
    case 'stats': return statsReply(login);
    case 'fishdex':
    case 'dex': return fishdexReply(login);
    case 'pond': return pondReply(login);
    case 'leaderboard':
    case 'top': return leaderboardReply();
    case 'help': return '!fish [pond] · !inventory · !inventory list [page] · !perks · !stats · !fishdex · !pond · !leaderboard';
    default: return null;
  }
}
