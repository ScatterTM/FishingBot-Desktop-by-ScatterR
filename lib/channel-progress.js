// Channel progress: per-broadcaster points, community catches and channel upgrades.
//
// Points are earned by manual !fish casts in that channel only. Auto-Fish and
// Admin grants do not count. Points are spent in the Broadcaster Admin Shop on
// upgrades that apply to every !fish cast in that channel. Spending is final.

import { withKeyLock } from './inventory.js';

// Points per catch, by tier id (lib/tiers.js). Mud is a cast with no catch.
export const CHANNEL_POINTS = {
  mud: 0,
  common: 1,
  uncommon: 2,
  rare: 4,
  epic: 8,
  legendary: 15,
  godly: 250,
  treasury: 5,
  unique: 0
};

// Cost of level 1, 2 and 3. The same for every upgrade.
export const CHANNEL_UPGRADE_COSTS = [500, 750, 1000];
const MAX_LEVEL = CHANNEL_UPGRADE_COSTS.length;

// Upgrade definitions for the panel. The numbers below must match CHANNEL_EFFECTS.
export const CHANNEL_UPGRADES = [
  { id: 'luck', name: 'Channel luck', description: 'Luck bonus for every cast in your chat.', values: ['+3%', '+7%', '+10%'] },
  { id: 'rarity', name: 'Rare hunter', description: 'More luck for Godly, Legendary and Epic catches.', values: ['+7%', '+14%', '+20%'] },
  { id: 'lucky-chat', name: 'Lucky chat', description: 'Treasury luck multiplier in your chat.', values: ['1.2x', '1.35x', '1.5x'] }
];

// Effect of each level (level 1, 2, 3). Luck and rarity add a percentage;
// lucky chat is a multiplier on Treasury luck.
export const CHANNEL_EFFECTS = {
  luck: [0.03, 0.07, 0.10],
  rarity: [0.07, 0.14, 0.20],
  'lucky-chat': [1.2, 1.35, 1.5]
};

export const RARE_BONUS_TIERS = ['godly', 'legendary', 'epic'];

export function pointsForTier(tierId) {
  return CHANNEL_POINTS[tierId] ?? 0;
}

export function clampLevel(value) {
  return Math.max(0, Math.min(MAX_LEVEL, parseInt(value, 10) || 0));
}

function channelKeys(channel) {
  return {
    points: `channel:points:${channel}`,
    spent: `channel:points_spent:${channel}`,
    catches: `channel:catches:${channel}`
  };
}

// Each viewer can switch a channel's upgrades off for their own !fish casts in
// that channel. Missing means on, which is the default.
export function channelPerkKey(viewer, channel) {
  return `toggle:channelPerk:${viewer}:${channel}`;
}

export function upgradeLevelKey(channel, upgradeId) {
  return `channel:upgrade:${upgradeId}:${channel}`;
}

// The effect values in play for a channel, given its upgrade levels.
// Level 0 means no effect (luck 0, rarity 0, lucky chat 1x).
export function channelEffects(levels = {}) {
  const at = (id) => clampLevel(levels[id]);
  const luck = at('luck');
  const rarity = at('rarity');
  const lucky = at('lucky-chat');
  return {
    luckPct: luck ? CHANNEL_EFFECTS.luck[luck - 1] : 0,
    rarityPct: rarity ? CHANNEL_EFFECTS.rarity[rarity - 1] : 0,
    luckyMult: lucky ? CHANNEL_EFFECTS['lucky-chat'][lucky - 1] : 1
  };
}

// Recent casts per channel, kept for the Master Admin debug view.
const CAST_LOG_LIMIT = 50;
const CAST_LOG_TRIM_EVERY = 25;
export function channelLogKey(channel) {
  return `channel:log:${channel}`;
}

// One manual cast in a channel. `tierIds` lists the caught tiers (empty for Mud).
// Community catches count casts, the same way the global fish count does.
// `details` ({ user, items }) is written to the channel's recent-cast log.
export async function recordChannelCast(db, channel, tierIds, details = null) {
  if (!db || !channel) return;
  const keys = channelKeys(channel);
  const points = tierIds.reduce((sum, id) => sum + pointsForTier(id), 0);
  const writes = [db.incr(keys.catches)];
  if (points > 0) writes.push(db.incrby(keys.points, points));
  if (details) {
    const entry = JSON.stringify({ at: Date.now(), user: details.user || '', points, items: details.items || [] });
    writes.push(db.rpush(channelLogKey(channel), entry));
  }
  await Promise.all(writes);
  // Trim the log now and then, not on every cast, so the cast path stays cheap.
  if (details && Math.random() < 1 / CAST_LOG_TRIM_EVERY) await trimChannelLog(db, channel);
}

export async function trimChannelLog(db, channel) {
  const values = await db.lrange(channelLogKey(channel), 0, -1).catch(() => []);
  if (values.length > CAST_LOG_LIMIT) {
    await db.lreplace(channelLogKey(channel), values.slice(-CAST_LOG_LIMIT));
  }
}

export async function readChannelLog(db, channel, limit = 20) {
  const values = await db.lrange(channelLogKey(channel), 0, -1).catch(() => []);
  return values.slice(-limit).reverse().map((raw) => {
    try { return JSON.parse(raw); } catch { return null; }
  }).filter(Boolean);
}

export async function readChannelProgress(db, channel) {
  const empty = { points: 0, spent: 0, available: 0, catches: 0, levels: { luck: 0, rarity: 0, 'lucky-chat': 0 } };
  if (!db || !channel) return empty;
  const keys = channelKeys(channel);
  const upgradeIds = CHANNEL_UPGRADES.map((u) => u.id);
  const [pointsRaw, spentRaw, catchesRaw, ...levelRaw] = await Promise.all([
    db.get(keys.points).catch(() => null),
    db.get(keys.spent).catch(() => null),
    db.get(keys.catches).catch(() => null),
    ...upgradeIds.map((id) => db.get(upgradeLevelKey(channel, id)).catch(() => null))
  ]);
  const points = Math.max(0, parseInt(pointsRaw, 10) || 0);
  const spent = Math.max(0, parseInt(spentRaw, 10) || 0);
  const levels = Object.fromEntries(upgradeIds.map((id, i) => [id, clampLevel(levelRaw[i])]));
  return {
    points,
    spent,
    available: Math.max(0, points - spent),
    catches: Math.max(0, parseInt(catchesRaw, 10) || 0),
    levels
  };
}

// The next channel upgrade to buy, and how far the points are toward its cost.
// Used by the banner's points bar. Once every upgrade is at its maximum, maxed is true.
export function nextUpgradeGoal(progress) {
  const levels = progress?.levels || {};
  const available = Math.max(0, Number(progress?.available) || 0);
  const next = CHANNEL_UPGRADES.find((u) => clampLevel(levels[u.id]) < MAX_LEVEL);
  if (!next) return { maxed: true, available, cost: 0, name: '', level: MAX_LEVEL, pct: 1 };
  const level = clampLevel(levels[next.id]);
  const cost = CHANNEL_UPGRADE_COSTS[level];
  return { maxed: false, available, cost, name: next.name, level: level + 1, pct: Math.min(1, available / cost) };
}

// Progress toward a broadcaster-selected upgrade goal. If that upgrade is maxed,
// the bar stays on the chosen goal and reports it as maxed rather than silently
// switching to a different upgrade.
export function upgradeGoal(progress, upgradeId) {
  const levels = progress?.levels || {};
  const available = Math.max(0, Number(progress?.available) || 0);
  const goal = CHANNEL_UPGRADES.find((u) => u.id === upgradeId) || CHANNEL_UPGRADES[0];
  const level = clampLevel(levels[goal.id]);
  if (level >= MAX_LEVEL) return { maxed: true, available, cost: 0, name: goal.name, level: MAX_LEVEL, pct: 1 };
  const cost = CHANNEL_UPGRADE_COSTS[level];
  return { maxed: false, available, cost, name: goal.name, level: level + 1, pct: Math.min(1, available / cost) };
}

// Spend points on the next level of one upgrade. The lock keeps two purchases
// from spending the same points. Throws with a readable message on refusal.
export async function buyChannelUpgrade(db, channel, upgradeId) {
  const upgrade = CHANNEL_UPGRADES.find((u) => u.id === upgradeId);
  if (!upgrade) throw new Error('Unknown channel upgrade.');
  return withKeyLock(db, `channel-shop:${channel}`, async () => {
    const progress = await readChannelProgress(db, channel);
    const level = progress.levels[upgradeId];
    if (level >= MAX_LEVEL) throw new Error(`${upgrade.name} is already at its maximum level.`);
    const cost = CHANNEL_UPGRADE_COSTS[level];
    if (progress.available < cost) {
      throw new Error(`Not enough channel points (need ${cost}, you have ${progress.available}).`);
    }
    await db.set(upgradeLevelKey(channel, upgradeId), String(level + 1));
    await db.incrby(channelKeys(channel).spent, cost);
    return { upgrade: upgradeId, level: level + 1, cost, available: progress.available - cost };
  });
}
