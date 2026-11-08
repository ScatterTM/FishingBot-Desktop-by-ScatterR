import { db } from './db.js';
import { getPrices } from './pricing.js';
import { getTreasuryBalance } from './shop.js';
import { DEX_PROGRESS_KEYS } from './dexcatalog.js';
import { catchCountKey, withKeyLock, isTreasuryItem, removeInventoryItems } from './inventory.js';
import { AREA_IDS, readUserAreaLevels } from './areas.js';

export const RODS = [
  { id: 'old', name: 'Old Rod', icon: 'rod', cost: 0, bonus: 0, desc: 'The reliable starter rod. No bonus, no downside.' },
  { id: 'sturdy', name: 'Sturdy Rod', icon: 'rod-sturdy', cost: 50, bonus: 0.06, desc: '+6% effective rarity weighting for all catches, including Treasury.' },
  { id: 'deepwater', name: 'Deepwater Rod', icon: 'rod-deepwater', cost: 150, bonus: 0.12, desc: '+12% effective rarity weighting for all catches, including Treasury.' },
  { id: 'master', name: 'Master Rod', icon: 'rod-master', cost: 400, bonus: 0.20, desc: '+20% effective rarity weighting for all catches, including Treasury.' },
  { id: 'celestial', name: 'Celestial Rod', icon: 'rod-celestial', cost: 1000, bonus: 0.30, desc: '+30% effective rarity weighting for all catches, including Treasury.' }
];

export const BAITS = [
  { id: 'worm', name: 'Worm Bait', icon: 'worm', cost: 0, count: 0, multiplier: 1.00, desc: 'Free basic bait. No rarity modifier.' },
  { id: 'minnow', name: 'Minnow Bait', icon: 'minnow', cost: 5, count: 50, multiplier: 1.08, desc: '50 casts per pack. +8% effective rarity weighting on non-Treasury catches.' },
  { id: 'rare', name: 'Rare Bait', icon: 'rare-bait', cost: 7, count: 50, multiplier: 1.16, desc: '50 casts per pack. +16% effective rarity weighting on non-Treasury catches.' },
  { id: 'legend', name: 'Legend Bait', icon: 'legend-bait', cost: 8, count: 50, multiplier: 1.28, desc: '50 casts per pack. +28% effective rarity weighting on non-Treasury catches.' }
];

export const CUSTOM_TITLES_KEY = 'admin:custom_titles';
export const customTitlesKey = (user) => `progression:custom_titles:${user}`;

export const CUSTOM_ACHIEVEMENTS_KEY = 'admin:custom_achievements';
export const ACHIEVEMENT_OVERRIDES_KEY = 'admin:achievement_overrides';
export const RESERVED_TITLE_NAMES = ['admin'];
export const ACHIEVEMENT_TYPES = [
  { id: 'casts', name: 'Casts', desc: 'Lifetime fishing casts.' },
  { id: 'treasury', name: 'Treasury catches', desc: 'Treasury items caught.' },
  { id: 'unique', name: 'Unique fish', desc: 'Unique Fishdex discoveries.' },
  { id: 'rare', name: 'Rare+ catches', desc: 'Rare, Epic, Legendary or higher catches.' },
  { id: 'legendary', name: 'Legendary+ catches', desc: 'Legendary or higher catches.' },
  { id: 'godly', name: 'Godly+ catches', desc: 'Godly or higher catches.' },
  { id: 'areas', name: 'Areas unlocked', desc: 'Fishing areas unlocked.' }
];

export function achievementIconFor(title, type = '') {
  const text = `${String(title || '')} ${String(type || '')}`.toLowerCase();
  if (/treasure|treasury|vault|coin|wealth/.test(text)) return 'coin';
  if (/legend|myth|star/.test(text)) return 'star';
  if (/godly|divine|odds|impossible/.test(text)) return 'flame';
  if (/collect|completion|dex|discover|unique/.test(text)) return 'book';
  if (/explor|area|world|journey/.test(text)) return 'globe';
  if (/luck|lucky|fortune/.test(text)) return 'clover';
  if (/cast|angler|fish|catch|hook|rod/.test(text)) return 'rod';
  if (/rank|champion|master|king|queen/.test(text)) return 'crown';
  return 'trophy';
}

export async function readCustomAchievementCatalog(dbRef = db) {
  const raw = await dbRef.get(CUSTOM_ACHIEVEMENTS_KEY).catch(() => null);
  try { const parsed = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export async function readAchievementOverrides(dbRef = db) {
  const raw = await dbRef.get(ACHIEVEMENT_OVERRIDES_KEY).catch(() => null);
  try { const parsed = JSON.parse(raw || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

// Built-in achievements live in code. Admin edits are stored as per-id
// overrides. Only name, description and target can change: the awarded title
// is fixed because cosmetics unlock by title name.
export function applyAchievementOverrides(list, overrides = {}) {
  return list.map((a) => {
    const o = overrides?.[a.id];
    if (!o) return a;
    const target = Math.floor(Number(o.target));
    return {
      ...a,
      name: o.name ? String(o.name) : a.name,
      desc: o.desc ? String(o.desc) : a.desc,
      target: Number.isFinite(target) && target >= 1 ? target : a.target
    };
  });
}

export const BUILTIN_ADMIN_TWITCH_USERS = ['tm_scatterr', 'sys_fishinghub', 'joeschmoeeee'];

export function configuredAdminUsers() {
  const configured = String([process.env.ADMIN_USERNAMES || '', process.env.ADMIN_USERNAME || ''].filter(Boolean).join(','))
    .split(',').map((u) => u.trim().toLowerCase().replace(/^@+/, '')).filter(Boolean);
  return [...new Set([...BUILTIN_ADMIN_TWITCH_USERS, ...configured])];
}

export const BUILTIN_TITLE_COLORS = {
  'Rookie Angler': '#9AA7AD', 'Dedicated Angler': '#58B7D4', 'Hooked': '#9B7BEA',
  'Legendary Angler': '#FFD166', 'Treasure Hunter': '#E0A84B', 'Vault Keeper': '#D6B45A',
  'Collector': '#63D6A2', 'Completionist': '#F08B5B', 'Rare Chaser': '#5BC7DF',
  'Legend Chaser': '#FF6B8A', 'Against the Odds': '#FF5B5B', 'Explorer': '#9BD36A',
  'Admin': '#FF4D32'
};

export function getTitleStyle(title, customTitles = []) {
  const name = String(title || '').trim();
  const custom = Array.isArray(customTitles) ? customTitles.find((t) => String(t?.name || '') === name) : null;
  const customColor = String(custom?.color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(customColor)) return customColor.toUpperCase();
  return BUILTIN_TITLE_COLORS[name] || '#D7DDD9';
}

export async function readCustomTitleCatalog(dbRef = db) {
  const raw = await dbRef.get(CUSTOM_TITLES_KEY).catch(() => null);
  try { const parsed = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export async function readAssignedCustomTitles(user, dbRef = db) {
  const raw = await dbRef.get(customTitlesKey(user)).catch(() => null);
  try { const parsed = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export const COSMETICS = [
  { id: 'frame_default', category: 'frame', name: 'Classic Frame', icon: 'circle', desc: 'The clean default profile frame.', unlock: 'Default' },
  { id: 'frame_brass', category: 'frame', name: 'Brass Frame', icon: 'gem', desc: 'A warm brass profile frame.', unlock: '100 casts' },
  { id: 'frame_signal', category: 'frame', name: 'Signal Frame', icon: 'target', desc: 'A bright signal-accent profile frame.', unlock: '500 casts' },
  { id: 'nameplate_default', category: 'nameplate', name: 'Classic Nameplate', icon: 'layers', desc: 'The default player nameplate.', unlock: 'Default' },
  { id: 'nameplate_brass', category: 'nameplate', name: 'Brass Nameplate', icon: 'layers', desc: 'A brass-accented player nameplate.', unlock: 'Dedicated Angler' },
  { id: 'nameplate_signal', category: 'nameplate', name: 'Signal Nameplate', icon: 'layers', desc: 'A signal-accented player nameplate.', unlock: 'Collector' },
  { id: 'effect_none', category: 'effect', name: 'No Effect', icon: 'circle', desc: 'Keep the profile presentation minimal.', unlock: 'Default' },
  { id: 'effect_spark', category: 'effect', name: 'Spark Effect', icon: 'sparkle', desc: 'A subtle catchers sparkle.', unlock: 'Treasure Hunter' },
  { id: 'effect_stars', category: 'effect', name: 'Star Effect', icon: 'star', desc: 'A rare-looking star effect.', unlock: 'Legendary Angler' }
];

export const ACHIEVEMENTS = [
  { id: 'first_cast', icon: 'rod', name: 'First Cast', desc: 'Cast your line once.', target: 1, stat: 'casts', reward: 'Title: Rookie Angler', title: 'Rookie Angler' },
  { id: 'hundred_casts', icon: 'anchor', name: 'Getting Serious', desc: 'Make 100 casts.', target: 100, stat: 'casts', reward: 'Title: Dedicated Angler', title: 'Dedicated Angler' },
  { id: 'thousand_casts', icon: 'flame', name: 'Hooked', desc: 'Make 1,000 casts.', target: 1000, stat: 'casts', reward: 'Title: Hooked', title: 'Hooked' },
  { id: 'ten_thousand', icon: 'crown', name: 'Legendary Angler', desc: 'Make 10,000 casts.', target: 10000, stat: 'casts', reward: 'Title: Legendary Angler', title: 'Legendary Angler' },
  { id: 'treasury_10', icon: 'coin', name: 'Treasure Hunter', desc: 'Catch 10 Treasury items.', target: 10, stat: 'treasury', reward: 'Title: Treasure Hunter', title: 'Treasure Hunter' },
  { id: 'treasury_100', icon: 'gem', name: 'Vault Keeper', desc: 'Catch 100 Treasury items.', target: 100, stat: 'treasury', reward: 'Title: Vault Keeper', title: 'Vault Keeper' },
  { id: 'unique_10', icon: 'book', name: 'Collector', desc: 'Discover 10 unique Fishdex entries.', target: 10, stat: 'unique', reward: 'Title: Collector', title: 'Collector' },
  { id: 'unique_50', icon: 'trophy', name: 'Completionist', desc: 'Discover 50 unique Fishdex entries.', target: 50, stat: 'unique', reward: 'Title: Completionist', title: 'Completionist' },
  { id: 'rare_1', icon: 'drop', name: 'Rare Find', desc: 'Catch a Rare or better fish.', target: 1, stat: 'rare', reward: 'Title: Rare Chaser', title: 'Rare Chaser' },
  { id: 'legendary_1', icon: 'star', name: 'Legendary Catch', desc: 'Catch a Legendary or better fish.', target: 1, stat: 'legendary', reward: 'Title: Legend Chaser', title: 'Legend Chaser' },
  { id: 'godly_1', icon: 'flame', name: 'Against the Odds', desc: 'Catch a Godly or better fish.', target: 1, stat: 'godly', reward: 'Title: Against the Odds', title: 'Against the Odds' },
  { id: 'area_1', icon: 'globe', name: 'Explorer', desc: 'Unlock your first fishing area.', target: 1, stat: 'areas', reward: 'Title: Explorer', title: 'Explorer' }
];

const key = (user, suffix) => `progression:${suffix}:${user}`;
export const progressionKeys = (user) => ({
  casts: key(user, 'casts'), treasury: key(user, 'treasury'), unique: key(user, 'unique'),
  rare: key(user, 'rare'), legendary: key(user, 'legendary'), godly: key(user, 'godly'),
  areas: key(user, 'areas'), rod: key(user, 'rod'), selectedBait: key(user, 'bait:selected'),
  title: key(user, 'title'), unlockedTitles: key(user, 'titles'), cosmetics: key(user, 'cosmetics'), baitPrefix: key(user, 'bait')
});

export function rodFor(id) { return RODS.find((r) => r.id === id) || RODS[0]; }
export function baitFor(id) { return BAITS.find((b) => b.id === id) || BAITS[0]; }

export async function getPricedGear(dbRef = db) {
  const prices = await getPrices(dbRef);
  return {
    rods: RODS.map((r) => ({ ...r, cost: prices.rods[r.id] ?? r.cost })),
    baits: BAITS.map((b) => ({ ...b, cost: prices.bait[b.id] ?? b.cost }))
  };
}

async function readJson(keyName, fallback) {
  const raw = await db.get(keyName).catch(() => null);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function readProgression(user) {
  const keys = progressionKeys(user);
  const values = await db.mget([
    keys.casts, keys.treasury, keys.unique, keys.rare, keys.legendary, keys.godly, keys.areas,
    keys.rod, keys.selectedBait, keys.title, keys.unlockedTitles, keys.cosmetics,
    ...BAITS.map((b) => `${keys.baitPrefix}:${b.id}`)
  ]).catch(() => []);
  const n = (i) => Number(values?.[i]) || 0;
  let titles = [];
  try { titles = JSON.parse(values?.[10] || '[]'); } catch (err) { console.error('[lib/progression.js:178] ignored error:', err?.message || err); }
  let cosmetics = { frame: 'frame_default', nameplate: 'nameplate_default', effect: 'effect_none' };
  try { cosmetics = { ...cosmetics, ...(JSON.parse(values?.[11] || '{}') || {}) }; } catch (err) { console.error('[lib/progression.js:180] ignored error:', err?.message || err); }
  return {
    casts: n(0), treasury: n(1), unique: n(2), rare: n(3), legendary: n(4), godly: n(5), areas: n(6),
    rod: rodFor(values?.[7]), selectedBait: baitFor(values?.[8]), title: values?.[9] || '', unlockedTitles: titles, cosmetics,
    bait: Object.fromEntries(BAITS.map((b, i) => [b.id, n(12 + i)]))
  };
}

export async function recordProgress(user, { catches = [], cast = true, newDiscoveries = 0 } = {}) {
  if (!db) return;
  const keys = progressionKeys(user);
  const ops = [];
  if (cast) ops.push({ op: 'incrby', key: keys.casts, amount: 1 });
  if (newDiscoveries > 0) ops.push({ op: 'incrby', key: keys.unique, amount: Number(newDiscoveries) || 0 });
  for (const c of catches) {
    const score = Number(c.tier.rankScore) || 0;
    if (c.tier.id === 'treasury') ops.push({ op: 'incrby', key: keys.treasury, amount: 1 });
    else {
      if (score >= 3) ops.push({ op: 'incrby', key: keys.rare, amount: 1 });
      if (score >= 6) ops.push({ op: 'incrby', key: keys.legendary, amount: 1 });
      if (score >= 7) ops.push({ op: 'incrby', key: keys.godly, amount: 1 });
    }
  }
  if (!ops.length) return;
  await db.batch(ops).catch(async () => {
    await Promise.all(ops.map((op) => db.incrby(op.key, op.amount).catch(() => null)));
  });
}

export async function grantBait(dbRef, user, baitId, packs = 1) {
  const bait = baitFor(baitId);
  if (!bait || bait.id === 'worm') return;
  await dbRef.incrby(`${progressionKeys(user).baitPrefix}:${bait.id}`, bait.count * Math.max(1, Number(packs) || 1));
}

export async function unlockTitleIfNeeded(user, title) {
  if (!title) return;
  const keys = progressionKeys(user);
  const titles = await readJson(keys.unlockedTitles, []);
  if (!Array.isArray(titles) || titles.includes(title)) return;
  titles.push(title);
  await db.set(keys.unlockedTitles, JSON.stringify(titles));
}

async function readAuthoritativeAchievementStats(user) {
  // Use the same lifetime catch counter used by Fishdex rather than the
  // separate progression counters. This keeps achievements correct after
  // trades, spending, admin inventory changes, and old saves.
  const catchCountKeyName = `fish:count:${user}`;
  const historyKeys = DEX_PROGRESS_KEYS.map((item) => catchCountKey(user, item));
  const [leaderboardCountRaw, historyValues, rareCatches, areaLevels] = await Promise.all([
    db.get(catchCountKeyName).catch(() => null),
    historyKeys.length ? db.mget(historyKeys).catch(() => []) : [],
    db.lrange(`fish:rares:${user}`, 0, -1).catch(() => []),
    readUserAreaLevels(db, user).catch(() => ({}))
  ]);

  // Keep the achievement's unique-fish number identical to the Fishdex:
  // count distinct caught entries from the same non-SECRET catalog, using
  // lifetime catch history when it exists and the raw catch list only as the
  // same legacy/backfill fallback Fishdex uses. This prevents old players
  // whose history keys were created later from showing 0 unique fish.
  const inventory = new Set(Array.isArray(rareCatches) ? rareCatches : []);
  let unique = 0;
  let treasury = 0;
  let rare = 0;
  let legendary = 0;
  let godly = 0;
  for (let i = 0; i < DEX_PROGRESS_KEYS.length; i++) {
    const stored = historyValues?.[i];
    // This mirrors fishdex.js exactly: an explicit 0 means not caught; a
    // missing history key falls back to the player's legacy raw catch list.
    const count = stored === null || stored === undefined
      ? (inventory.has(DEX_PROGRESS_KEYS[i]) ? 1 : 0)
      : (Number(stored) || 0);
    if (count <= 0) continue;
    unique++;
    const tierMatch = String(DEX_PROGRESS_KEYS[i]).match(/\s\[([A-Z]+)\]$/);
    const tier = tierMatch ? tierMatch[1] : '';
    if (tier === 'TREASURY') treasury += count;
    if (['RARE', 'EPIC', 'LEGENDARY', 'GODLY', 'SECRET', 'MYTHIC'].includes(tier)) rare += count;
    if (['LEGENDARY', 'GODLY', 'SECRET', 'MYTHIC'].includes(tier)) legendary += count;
    if (['GODLY', 'SECRET', 'MYTHIC'].includes(tier)) godly += count;
  }

  const areas = AREA_IDS.reduce((total, id) => total + (Number(areaLevels?.[id]) > 0 ? 1 : 0), 0);
  return {
    casts: Math.max(0, Number(leaderboardCountRaw) || 0),
    treasury,
    unique,
    rare,
    legendary,
    godly,
    areas
  };
}

export async function achievementSnapshot(user) {
  const p = await readProgression(user);
  const authoritative = await readAuthoritativeAchievementStats(user);
  const progression = { ...p, ...authoritative };
  const [customCatalog, assignedCustomIds, globalAchievements, overrides] = await Promise.all([
    readCustomTitleCatalog(db),
    readAssignedCustomTitles(user, db),
    readCustomAchievementCatalog(db),
    readAchievementOverrides(db)
  ]);
  const builtins = applyAchievementOverrides(ACHIEVEMENTS, overrides);
  const assignedCustom = customCatalog.filter((t) => assignedCustomIds.includes(t.id));
  const allAchievements = [...builtins.map((a) => ({ ...a, builtin: true })), ...globalAchievements];
  const allProgress = Object.fromEntries(allAchievements.map((a) => [a.id, Math.min(Number(a.target) || 0, Number(progression[a.stat]) || 0)]));
  const isDone = (a) => (allProgress[a.id] || 0) >= Number(a.target || 0);
  const adminUser = configuredAdminUsers().includes(String(user || '').toLowerCase().replace(/^@+/, ''));
  // Built-ins grant their fixed title; global achievements grant their admin-set award title.
  const achievementTitles = allAchievements.filter(isDone)
    .map((a) => (a.title || a.award || '')).filter((t) => t && !RESERVED_TITLE_NAMES.includes(String(t).toLowerCase()));
  const titles = [...new Set([...(p.unlockedTitles || []), ...achievementTitles, ...assignedCustom.map((t) => t.name), ...(adminUser ? ['Admin'] : [])])];
  const titleStyles = Object.fromEntries(titles.map((title) => [title, getTitleStyle(title, assignedCustom)]));
  return {
    progression,
    achievements: allAchievements.map((a) => ({
      ...a,
      icon: a.icon || achievementIconFor(a.name, a.stat),
      reward: a.award ? `Title: ${a.award}` : (a.reward || 'Global achievement'),
      progress: allProgress[a.id] || 0,
      unlocked: isDone(a)
    })),
    titles,
    titleStyles,
    customTitles: assignedCustom,
    equippedTitle: p.title || ''
  };
}

export async function spendTreasuryForRod(user, rodId) {
  const rod = rodFor(rodId);
  const current = await db.get(progressionKeys(user).rod);
  const currentIndex = Math.max(0, RODS.findIndex((r) => r.id === current));
  const nextIndex = RODS.findIndex((r) => r.id === rod.id);
  if (nextIndex !== currentIndex + 1) throw new Error('Upgrade rods one level at a time.');
  // Use the same inventory lock as Treasury purchases so two upgrades cannot spend the same catches.
  return withKeyLock(db, `progression-rod:${user}`, async () => {
    const prices = await getPrices(db);
    const purchaseCost = prices.rods[rod.id] ?? rod.cost;
    const liveCurrent = await db.get(progressionKeys(user).rod);
    const liveIndex = Math.max(0, RODS.findIndex((r) => r.id === liveCurrent));
    if (nextIndex !== liveIndex + 1) throw new Error('That rod upgrade is no longer available. Refresh your gear.');
    const live = await db.lrange(`fish:rares:${user}`, 0, -1);
    const liveBalance = live.filter(isTreasuryItem).length;
    if (liveBalance < purchaseCost) throw new Error(`Not enough Treasury. Need ${purchaseCost}, have ${liveBalance}.`);
    const removed = await removeInventoryItems(db, user, isTreasuryItem, purchaseCost, purchaseCost);
    if (removed.removed.length !== purchaseCost) throw new Error('Treasury inventory changed. Please retry.');
    await db.set(progressionKeys(user).rod, rod.id);
    return { rod: { ...rod, cost: purchaseCost }, balance: liveBalance - purchaseCost };
  });
}
