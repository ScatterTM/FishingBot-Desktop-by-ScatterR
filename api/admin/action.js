import { db } from '../../lib/db.js';
import { applyItemEffects as applyItemEffectsShared } from '../../lib/effects.js';
import { SHOP_ITEMS, BOOSTABLE_RARITIES, allShopKeys } from '../../lib/shop.js';
import { addInventoryItems, backfillTreasuryList, deleteUserCatchData, getRecentCatchLog, recordCatch, recordCatches, removeInventoryItems, treasuryListMatches, withKeyLock } from '../../lib/inventory.js';
import { deleteAdminAuditEntry, getRecentAdminAudit, recordAdminAudit } from '../../lib/audit.js';
import { recordUserMail } from '../../lib/user-mail.js';
import { TIERS } from '../../lib/tiers.js';
import { FISHING_AREAS, AREA_IDS, areaLevelKey, selectedAreaKey, userAreasOffKey, userDoubleOffKey, areaEnabledKey, AREAS_ENABLED_KEY, DOUBLE_CATCH_ENABLED_KEY, isEnabledValue } from '../../lib/areas.js';
import { validateSession, cleanupExpiredSessions } from '../admin-tools.js';
import { adminGetAutoFish, adminSetAutoFish } from '../../lib/game-routes/autofish.js';
import { getAutoFishConfig, adminSpawnTreasurySlot, autoFishKeys } from '../../lib/autofish.js';
import { pondKeys, pondStatus, POND_TREASURY_PERKS, getFishdexFishCount, speciesHunterBonus } from '../../lib/pond.js';
import '../../lib/pond-extensions.js';
import { computeLuck, rollCatch, weightedTierTable, readState as readFishState } from '../fish.js';
import { rodFor, baitFor } from '../../lib/progression.js';
import { getPrices, setPrice, setPondPerkPrice } from '../../lib/pricing.js';
import { progressionKeys, customTitlesKey, CUSTOM_TITLES_KEY, CUSTOM_ACHIEVEMENTS_KEY, readCustomTitleCatalog, readAssignedCustomTitles, readCustomAchievementCatalog, achievementIconFor, ACHIEVEMENT_TYPES, ACHIEVEMENTS, ACHIEVEMENT_OVERRIDES_KEY, RESERVED_TITLE_NAMES, readAchievementOverrides, applyAchievementOverrides } from '../../lib/progression.js';
import { FISH_MESSAGE_DEFAULTS, resetAllCustomTemplates } from '../../lib/fish-format.js';
import { deleteBroadcasterAdmin, listBroadcasterAdmins, saveBroadcasterAdmin } from '../../lib/broadcaster-admin.js';
import { readChannelProgress, readChannelLog, CHANNEL_UPGRADES } from '../../lib/channel-progress.js';
import { BROADCASTER_PERMISSIONS, readDeniedPermissions, setPermissionDenied } from '../../lib/broadcaster-permissions.js';
import { deleteUserData } from '../../lib/delete-user.js';


const FIRST_FISH_TUTORIAL_KEY_PREFIX = 'fish:first_tutorial:';
const FIRST_FISH_TUTORIAL_RESET_PREFIX = 'fish:first_tutorial_reset:';
const TUTORIAL_REWARD_KEY_PREFIX = 'tutorial:reward:';

async function writeAdminAudit(event) {
  try { await recordAdminAudit(db, event); }
  catch (error) { console.error('Admin audit write failed:', error); }
}

async function writeUserFeedback(user, event) {
  try { await recordUserMail(db, user, event); }
  catch (error) { console.error('User mail write failed:', error); }
}

// Perks an admin can add/remove from the "Manage Perks" button in the
// Inspect & Multi-Delete Inventory panel (actions: getPerks / setPerk).
// `toggleId` maps to that perk's own player-facing on/off switch
// (toggle:<toggleId>:<user> - see VALID_PERKS in api/perks.js) so that
// granting a perk here also clears any stale "player turned it off" flag -
// otherwise an admin-granted perk could sit owned-but-invisible in-game if
// the player had it toggled off before.
const ADMIN_PERKS = {
  permLuck: { name: '1.5x Luck (Permanent)', key: 'perm_luck', toggleId: 'perm' },
  tempLuck: { name: '2x Luck (10 min)', key: 'temp_luck', ttl: 600, toggleId: 'temp' },
  vip: { name: 'Vipfish VIP Luck', key: 'game_vip', toggleId: 'vip' },
  ...Object.fromEntries(Object.entries(SHOP_ITEMS).map(([id, i]) => [id, { name: i.name, key: i.key, ttl: i.ttl, toggleId: id }]))
};

// Unknown tiers fall back to COMMON explicitly - never to a positional
// index, which would silently change meaning if the table is reordered.
const COMMON_TIER = TIERS.find((t) => t.name === 'COMMON');
const SECRET_TIER = TIERS.find((t) => t.name === 'SECRET');

// Older catches were persisted with the tier name "UNIQUE" before it was
// renamed to "SECRET". Normalizing here means both old and new entries
// still resolve to the same TIERS entry everywhere tier names are looked up.
function normalizeTierName(name) {
  const upper = (name || '').toString().trim().toUpperCase();
  return upper === 'UNIQUE' ? 'SECRET' : upper;
}

// Tier of one raw inventory entry ("Moonfish [GODLY]", legacy "[UNIQUE]",
// "(TIER)" style). Entries without a recognised tier tag count as COMMON,
// exactly like the admin inventory grid and the best-catch logic treat them.
function itemTierName(item) {
  if (typeof item !== 'string') return null;
  const match = item.trim().match(/[\[(]([a-z]+)[\])]\s*$/i);
  const name = match ? normalizeTierName(match[1]) : 'COMMON';
  return TIERS.some((t) => t.name === name) ? name : 'COMMON';
}

function parseItem(str) {
  if (typeof str !== 'string') return { base: '', tier: '', full: '' };
  const trimmed = str.trim();
  const lower = trimmed.toLowerCase();
  
  const match = lower.match(/^(.*?)\s*(?:\[|\()([a-z]+)(?:\]|\))$/);
  if (match) {
    return {
      base: match[1].trim(),
      tier: normalizeTierName(match[2]),
      full: lower
    };
  }
  return {
    base: lower,
    tier: '',
    full: lower
  };
}

export async function recalculateBestCatch(cleanTarget, updatedMembers) {
  const bestTierKey = `fish:besttier:${cleanTarget}`;
  const bestItemKey = `fish:bestitem:${cleanTarget}`;

  if (!updatedMembers || updatedMembers.length === 0) {
    await db.del(bestTierKey, bestItemKey);
    return { cleared: true };
  }

  let highestTierObj = null;
  let bestItemString = '';

  for (const item of updatedMembers) {
    const parsed = parseItem(item);
    const tierName = parsed.tier || 'COMMON';
    const tierObj = TIERS.find(t => t.name === tierName) || COMMON_TIER;

    if (!highestTierObj || tierObj.rankScore > highestTierObj.rankScore) {
      highestTierObj = tierObj;
      const originalBaseMatch = item.match(/^(.*?)\s*(?:\[|\()/);
      const displayName = originalBaseMatch ? originalBaseMatch[1].trim() : item;
      bestItemString = `${displayName} (${tierObj.name})`;
    }
  }

  if (highestTierObj) {
    await Promise.all([
      db.set(bestTierKey, highestTierObj.rankScore),
      db.set(bestItemKey, bestItemString)
    ]);
    return { cleared: false, bestItem: bestItemString, bestTier: highestTierObj.name };
  } else {
    await db.del(bestTierKey, bestItemKey);
    return { cleared: true };
  }
}


// Fish that grant the corresponding admin-manageable perk. When an admin
// revokes a perk, remove the granting fish too so ownership stays consistent
// in both directions: fish -> perk and perk -> fish.
const PERK_FISH_MATCHERS = {
  permLuck: '1.5x luck',
  tempLuck: '2x luck',
  vip: 'vipfish'
};

async function removePerkFish(cleanTarget, perk) {
  const matcher = PERK_FISH_MATCHERS[perk];
  if (!matcher) return { removed: [], items: null };

  const result = await removeInventoryItems(
    db,
    cleanTarget,
    (item) => typeof item === 'string' && item.toLowerCase().includes(matcher),
    Infinity
  );

  if (result.removed.length) {
    await recalculateBestCatch(cleanTarget, result.items);
    await checkAndCleanLuckStatus(cleanTarget, result.items, result.removed);
  }

  return result;
}

// Called after items leave an inventory. A perk is only revoked when the
// items that were just removed actually granted it (the 1.5x Luck / Vipfish
// fish) and no copy is left. Previously every delete re-checked the whole
// inventory with a loose match (anything containing "x" or "luck"), which
// could strip an admin-granted perk during an unrelated delete, or keep a
// perk alive because of an unrelated fish like "axolotl".
export async function checkAndCleanLuckStatus(cleanTarget, updatedMembers, removedItems) {
  const holds = (list, needle) =>
    (Array.isArray(list) ? list : []).some((item) => typeof item === 'string' && item.toLowerCase().includes(needle));

  if (holds(removedItems, '1.5x luck') && !holds(updatedMembers, '1.5x luck')) {
    await db.del(`perm_luck:${cleanTarget}`);
  }
  // No Vipfish left, so revoke the game-granted VIP bonus that came from it.
  // Real Twitch sub/VIP status (real_vip:<user>) is tracked independently
  // and is left untouched.
  if (holds(removedItems, 'vipfish') && !holds(updatedMembers, 'vipfish')) {
    await db.del(`game_vip:${cleanTarget}`);
  }
}


// Returns '' (no award), a clean title string, or false when invalid.
function cleanAwardTitle(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length < 2 || t.length > 32 || RESERVED_TITLE_NAMES.includes(t.toLowerCase())) return false;
  return t;
}

export default async function handler(req, res) {
  // No Access-Control-Allow-Origin wildcard: the dashboard calls this
  // same-origin, and StreamElements calls it server-to-server. A wildcard
  // would let any website read admin responses in a visitor's browser.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!db) {
    console.error('[Admin Action Error] Local database is not configured.');
    return res.status(500).json({ error: 'Database connection failed.' });
  }

  // Handle GET request to check current global event luck status for public UI / admin dashboard
  if (req.method === 'GET') {
    try {
      let globalLuck = parseFloat(await db.get('global:event_luck')) || 1.0;
      let eventName = await db.get('global:event_name') || '';
      let eventExpiresRaw = await db.get('global:event_expires');
      let eventExpires = (eventExpiresRaw !== null && eventExpiresRaw !== undefined) ? parseInt(eventExpiresRaw, 10) : null;

      // Auto-disable the event once its duration has passed
      if (eventExpires && !isNaN(eventExpires) && Date.now() >= eventExpires) {
        await db.del('global:event_luck');
        await db.del('global:event_name');
        await db.del('global:event_expires');
        globalLuck = 1.0;
        eventName = '';
        eventExpires = null;
      }

      const cooldownRaw = await db.get('settings:cooldown');
      const cooldown = (cooldownRaw === null || cooldownRaw === undefined) ? 0 : parseInt(cooldownRaw, 10);
      return res.status(200).json({ success: true, globalLuck, eventName, eventExpires, cooldown });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch global event luck.' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST or GET.' });
  }

  // Validate session via Authorization header (Bearer token)
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  
  cleanupExpiredSessions();
  const session = validateSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized: Session expired or invalid.' });
  }

  // The admin name comes from the validated session token, never from the
  // request body - otherwise anyone could spoof the audit log's actor field.
  const providedUser = session.username;

  const { action, targetUser, partnerUser, tier, fish, items, entryId, multiplier, eventName, durationSeconds, perk, enabled, rarity, areaId, areaIds, level, feature, titleId, titleName, titleDescription, titleColor, achievementType, achievementRequirement, achievementAward, achievementId: bodyAchievementId } = req.body || {};
  const pondPerkId = String(req.body?.pondPerk || '');
  const pondPerkLevel = Number(req.body?.pondLevel);
  const streamChannel = String(req.body?.channel || req.body?.broadcaster || '').trim().toLowerCase().replace(/^@/, '');
  const streamCooldown = Number(req.body?.seconds);

  if (action === 'shop-price') {
    const category = String(req.body?.category || '');
    const id = String(req.body?.id || '');
    try {
      const prices = await setPrice(db, category, id, req.body?.price);
      await writeAdminAudit({ actor: session.username, action: 'shopPriceUpdated', target: `${category}:${id}`, details: `Price changed to ${prices[category][id]} Treasury.`, status: 'success' });
      return res.status(200).json({ success: true, prices });
    } catch (error) {
      return res.status(400).json({ error: error?.message || 'Could not update price.' });
    }
  }

  if (action === 'shop-prices') {
    return res.status(200).json({ success: true, prices: await getPrices(db) });
  }

  if (action === 'pond-perk-price') {
    try {
      const prices = await setPondPerkPrice(db, pondPerkId, pondPerkLevel, req.body?.price);
      await writeAdminAudit({ actor: session.username, action: 'pondPerkPriceUpdated', target: `${pondPerkId}:level${pondPerkLevel + 1}`, details: `Pond perk price changed to ${prices.pond[pondPerkId][pondPerkLevel]} Treasury.` });
      return res.status(200).json({ success: true, prices });
    } catch (error) {
      return res.status(400).json({ error: error?.message || 'Could not update Pond perk price.' });
    }
  }

  // Usernames become database keys, so they are normalized once, here:
  // lowercase, no @, trimmed, capped at 32 chars (Twitch allows 25).
  const cleanTarget = (() => {
    const clean = String(targetUser || '').toLowerCase().replace('@', '').trim();
    if (!clean || clean.length > 32) return null;
    return clean;
  })();
  const requireTarget = () => {
    if (!cleanTarget) return { error: 'Valid target user is required.' };
    return null;
  };

  try {
    switch (action) {
      case 'treasuryBackfillBatch':
      case 'treasuryCheck': {
        // Works through the player list in small batches, so each request stays
        // well inside the serverless time limit. Call again with the returned
        // `next` cursor until it is null.
        const rows = await db.fishPlayers();
        if (rows === null) return res.status(501).json({ error: 'The player list is not available on this database.' });
        const users = rows.map((row) => row.username).filter(Boolean).sort();
        const cursor = Math.max(0, Number(req.body?.cursor) || 0);
        const size = Math.min(50, Math.max(1, Number(req.body?.size) || 25));
        const batch = users.slice(cursor, cursor + size);
        const results = [];
        for (const user of batch) {
          if (action === 'treasuryCheck') {
            results.push({ user, ...(await treasuryListMatches(db, user)) });
          } else {
            results.push({ user, ...(await backfillTreasuryList(db, user)) });
          }
        }
        const failed = results.filter((r) => !r.ok).map((r) => r.user);
        const next = cursor + batch.length < users.length ? cursor + batch.length : null;
        await writeAdminAudit({ actor: session.username, action, target: `batch:${cursor}`, details: `${batch.length} players checked, ${failed.length} need attention` });
        return res.status(200).json({ success: true, total: users.length, processed: batch.length, next, failed, results });
      }
      case 'tutorialDebugInspect':
      case 'tutorialDebugResetFirstFish':
      case 'tutorialDebugClearReward':
      case 'tutorialDebugResetServer': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        const firstKey = `${FIRST_FISH_TUTORIAL_KEY_PREFIX}${cleanTarget}`;
        const resetKey = `${FIRST_FISH_TUTORIAL_RESET_PREFIX}${cleanTarget}`;
        const rewardKey = `${TUTORIAL_REWARD_KEY_PREFIX}${cleanTarget}`;
        if (action === 'tutorialDebugResetFirstFish' || action === 'tutorialDebugResetServer') {
          await db.del(firstKey);
          await db.set(resetKey, '1');
        }
        if (action === 'tutorialDebugClearReward' || action === 'tutorialDebugResetServer') await db.del(rewardKey);
        const pondKeySet = pondKeys(cleanTarget);
        const [first, reset, reward, pondUnlocked, pondLevel] = await db.mget([firstKey, resetKey, rewardKey, pondKeySet.unlocked, pondKeySet.level]).catch(() => []);
        if (action !== 'tutorialDebugInspect') {
          await writeAdminAudit({ actor: providedUser, action, target: cleanTarget, details: action === 'tutorialDebugResetFirstFish' ? 'Reset first-fish tutorial marker for debugging.' : action === 'tutorialDebugClearReward' ? 'Cleared tutorial reward claim for debugging.' : 'Reset first-fish tutorial and tutorial reward server state for debugging.' });
        }
        return res.status(200).json({ success: true, user: cleanTarget, server: { firstFishTutorialClaimed: !!first, firstFishTutorialResetPending: !!reset, tutorialRewardClaimed: !!reward }, pond: { unlocked: pondUnlocked === 'true', level: Number(pondLevel) || 0 } });
      }

      case 'listCustomTitles': {
        const catalog = await readCustomTitleCatalog(db);
        return res.status(200).json({ success: true, titles: catalog });
      }
      case 'listCustomAchievements': {
        const achievements = await readCustomAchievementCatalog(db);
        const overrides = await readAchievementOverrides(db);
        const builtins = applyAchievementOverrides(ACHIEVEMENTS, overrides).map((a) => ({ ...a, builtin: true }));
        return res.status(200).json({ success: true, achievements, builtins, types: ACHIEVEMENT_TYPES });
      }
      case 'createCustomAchievement': {
        const name = String(titleName || '').replace(/\s+/g, ' ').trim();
        const description = String(titleDescription || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Global achievement.';
        const type = String(achievementType || '').trim();
        const requirement = Math.floor(Number(achievementRequirement));
        if (!name || name.length < 2 || name.length > 48) return res.status(400).json({ error: 'Achievement title must be 2–48 characters.' });
        if (!ACHIEVEMENT_TYPES.some((t) => t.id === type)) return res.status(400).json({ error: 'Choose a valid achievement type.' });
        if (!Number.isFinite(requirement) || requirement < 1 || requirement > 1000000000) return res.status(400).json({ error: 'Requirement must be a whole number greater than 0.' });
        const catalog = await readCustomAchievementCatalog(db);
        if (catalog.some((a) => String(a.name).toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A global achievement with that name already exists.' });
        const id = `global_ach_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const award = cleanAwardTitle(achievementAward);
        if (award === false) return res.status(400).json({ error: 'Award title must be 2–32 characters and cannot be "Admin".' });
        const icon = achievementIconFor(name, type);
        const achievement = { id, name, desc: description, target: requirement, stat: type, icon, reward: award ? `Title: ${award}` : 'Global achievement', ...(award ? { award } : {}), createdBy: session.username, createdAt: new Date().toISOString() };
        catalog.push(achievement);
        await db.set(CUSTOM_ACHIEVEMENTS_KEY, JSON.stringify(catalog));
        await writeAdminAudit({ actor: session.username, action: 'createCustomAchievement', target: name, details: `Created global achievement ${name} (${type} ${requirement}).` });
        return res.status(200).json({ success: true, achievement, achievements: catalog });
      }
      case 'updateCustomAchievement': {
        const id = String(bodyAchievementId || req.body?.achievementId || '');
        const catalog = await readCustomAchievementCatalog(db);
        const idx = catalog.findIndex((a) => a.id === id);
        if (idx < 0) return res.status(404).json({ error: 'Global achievement not found.' });
        const name = String(titleName || '').replace(/\s+/g, ' ').trim();
        const description = String(titleDescription || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Global achievement.';
        const type = String(achievementType || '').trim();
        const requirement = Math.floor(Number(achievementRequirement));
        if (name.length < 2 || name.length > 48) return res.status(400).json({ error: 'Achievement title must be 2–48 characters.' });
        if (!ACHIEVEMENT_TYPES.some((t) => t.id === type)) return res.status(400).json({ error: 'Choose a valid achievement type.' });
        if (!Number.isFinite(requirement) || requirement < 1 || requirement > 1000000000) return res.status(400).json({ error: 'Requirement must be a whole number of at least 1.' });
        if (catalog.some((a, i) => i !== idx && String(a.name).toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A global achievement with that name already exists.' });
        const award = cleanAwardTitle(achievementAward);
        if (award === false) return res.status(400).json({ error: 'Award title must be 2–32 characters and cannot be "Admin".' });
        const prev = catalog[idx];
        const next = { ...prev, name, desc: description, stat: type, target: requirement, icon: achievementIconFor(name, type), reward: award ? `Title: ${award}` : 'Global achievement' };
        if (award) next.award = award; else delete next.award;
        catalog[idx] = next;
        await db.set(CUSTOM_ACHIEVEMENTS_KEY, JSON.stringify(catalog));
        await writeAdminAudit({ actor: session.username, action: 'updateCustomAchievement', target: name, details: `Edited global achievement ${prev.name} -> ${name} (${type} ${requirement}${award ? `, award ${award}` : ''}).` });
        return res.status(200).json({ success: true, achievement: next, achievements: catalog, message: 'Achievement updated.' });
      }
      case 'updateBuiltinAchievement': {
        const id = String(bodyAchievementId || req.body?.achievementId || '');
        const base = ACHIEVEMENTS.find((a) => a.id === id);
        if (!base) return res.status(404).json({ error: 'Built-in achievement not found.' });
        const name = String(titleName || '').replace(/\s+/g, ' ').trim();
        const description = String(titleDescription || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        const requirement = Math.floor(Number(achievementRequirement));
        if (name.length < 2 || name.length > 48) return res.status(400).json({ error: 'Achievement name must be 2–48 characters.' });
        if (!description) return res.status(400).json({ error: 'Description is required.' });
        if (!Number.isFinite(requirement) || requirement < 1 || requirement > 1000000000) return res.status(400).json({ error: 'Requirement must be a whole number of at least 1.' });
        const overrides = await readAchievementOverrides(db);
        overrides[id] = { name, desc: description, target: requirement };
        await db.set(ACHIEVEMENT_OVERRIDES_KEY, JSON.stringify(overrides));
        await writeAdminAudit({ actor: session.username, action: 'updateBuiltinAchievement', target: id, details: `Edited built-in achievement ${base.name} -> ${name} (requirement ${requirement}).` });
        return res.status(200).json({ success: true, achievement: { ...base, ...overrides[id] }, message: 'Achievement updated.' });
      }
      case 'updateCustomTitle': {
        const id = String(titleId || '');
        const catalog = await readCustomTitleCatalog(db);
        const idx = catalog.findIndex((t) => t.id === id);
        if (idx < 0) return res.status(404).json({ error: 'Custom title not found.' });
        const name = String(titleName || '').replace(/\s+/g, ' ').trim();
        const description = String(titleDescription || 'Admin-created title.').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Admin-created title.';
        const color = String(titleColor || '#D7DDD9').trim();
        if (!/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ error: 'Title color must be a valid 6-digit hex color.' });
        if (name.length < 2 || name.length > 32) return res.status(400).json({ error: 'Title name must be 2–32 characters.' });
        if (RESERVED_TITLE_NAMES.includes(name.toLowerCase())) return res.status(400).json({ error: 'That title name is reserved.' });
        if (catalog.some((t, i) => i !== idx && String(t.name).toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A custom title with that name already exists.' });
        const prev = catalog[idx];
        const next = { ...prev, name, description, color: color.toUpperCase() };
        catalog[idx] = next;
        await db.set(CUSTOM_TITLES_KEY, JSON.stringify(catalog));
        // Players keep the title equipped under its new name.
        let renamedEquipped = 0;
        if (prev.name !== name) {
          const assignedKeys = (await db.scan('0', { match: 'progression:custom_titles:*', count: 1000 }).catch(() => ['0', []]))[1] || [];
          for (const key of assignedKeys || []) {
            let ids = [];
            try { ids = JSON.parse(await db.get(key) || '[]'); } catch (error) { console.error(`[Admin] Could not read custom titles at ${key}:`, error?.message || error); }
            if (!Array.isArray(ids) || !ids.includes(id)) continue;
            const user = String(key).slice('progression:custom_titles:'.length);
            const titleKey = progressionKeys(user).title;
            if (String(await db.get(titleKey) || '') === prev.name) { await db.set(titleKey, name); renamedEquipped++; }
          }
        }
        await writeAdminAudit({ actor: session.username, action: 'updateCustomTitle', target: name, details: `Edited custom title ${prev.name} -> ${name} (${color.toUpperCase()}). ${renamedEquipped} equipped.` });
        return res.status(200).json({ success: true, title: next, titles: catalog, message: 'Title updated.' });
      }
      case 'deleteCustomAchievement': {
        const id = String(req.body?.achievementId || '');
        if (!id) return res.status(400).json({ error: 'Achievement id is required.' });
        const catalog = await readCustomAchievementCatalog(db);
        const next = catalog.filter((a) => a.id !== id);
        if (next.length === catalog.length) return res.status(404).json({ error: 'Global achievement not found.' });
        const removed = catalog.find((a) => a.id === id);
        await db.set(CUSTOM_ACHIEVEMENTS_KEY, JSON.stringify(next));
        await writeAdminAudit({ actor: session.username, action: 'deleteCustomAchievement', target: removed?.name || id, details: `Deleted global achievement ${removed?.name || id}.` });
        return res.status(200).json({ success: true, achievement: removed, achievements: next });
      }
      case 'createCustomTitle': {
        const name = String(titleName || '').replace(/\s+/g, ' ').trim();
        const description = String(titleDescription || 'Admin-created title.').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Admin-created title.';
        const color = String(titleColor || '#D7DDD9').trim();
        if (!/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ error: 'Title color must be a valid 6-digit hex color.' });
        if (!name || name.length < 2 || name.length > 32) return res.status(400).json({ error: 'Title name must be 2–32 characters.' });
        const catalog = await readCustomTitleCatalog(db);
        if (catalog.some((t) => String(t.name).toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A custom title with that name already exists.' });
        const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const title = { id, name, description, color: color.toUpperCase(), createdBy: session.username, createdAt: new Date().toISOString() };
        catalog.push(title);
        await db.set(CUSTOM_TITLES_KEY, JSON.stringify(catalog));
        await writeAdminAudit({ actor: session.username, action: 'createCustomTitle', target: name, details: `Created custom title ${name}.` });
        return res.status(200).json({ success: true, title, titles: catalog });
      }
      case 'assignCustomTitle':
      case 'revokeCustomTitle': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        const catalog = await readCustomTitleCatalog(db);
        const title = catalog.find((t) => t.id === String(titleId || ''));
        if (!title) return res.status(404).json({ error: 'Custom title not found.' });
        const key = customTitlesKey(cleanTarget);
        const current = await readAssignedCustomTitles(cleanTarget, db);
        const next = new Set(current);
        if (action === 'assignCustomTitle') next.add(title.id); else next.delete(title.id);
        await db.set(key, JSON.stringify([...next]));
        if (action === 'revokeCustomTitle' && String(await db.get(progressionKeys(cleanTarget).title) || '') === title.name) await db.del(progressionKeys(cleanTarget).title);
        await writeAdminAudit({ actor: session.username, action, target: cleanTarget, details: `${action === 'assignCustomTitle' ? 'Assigned' : 'Revoked'} custom title ${title.name}.` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'title', title: action === 'assignCustomTitle' ? 'Custom title granted' : 'Custom title revoked', message: `@${session.username} ${action === 'assignCustomTitle' ? 'granted' : 'revoked'} the title “${title.name}”.`, actor: session.username, meta: { titleId: title.id, title: title.name } });
        return res.status(200).json({ success: true, title, assigned: action === 'assignCustomTitle', targetUser: cleanTarget, assignedIds: [...next] });
      }
      case 'getTradeInventory': {
        const sender = cleanTarget;
        const receiver = String(partnerUser || '').toLowerCase().replace('@', '').trim();
        if (!sender || !receiver || receiver.length > 32) {
          return res.status(400).json({ error: 'Two valid Twitch usernames are required.' });
        }
        if (sender === receiver) {
          return res.status(400).json({ error: 'Choose two different players for a trade.' });
        }

        // One authenticated function call loads both sides. Keeping this as an
        // action on the existing admin function avoids creating another
        // legacy hosted function (the project remains at its current
        // function count, safely below the Hobby limit).
        const [senderRaw, receiverRaw] = await Promise.all([
          db.lrange(`fish:rares:${sender}`, 0, -1),
          db.lrange(`fish:rares:${receiver}`, 0, -1)
        ]);

        const rank = { secret: 7, godly: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1, treasury: 0 };
        const summarize = (rawList) => {
          const counts = new Map();
          for (const raw of (Array.isArray(rawList) ? rawList : [])) {
            const text = String(raw || '').trim();
            const match = text.match(/^(.*?)\s*[\[(]([A-Za-z]+)[\])]\s*$/);
            const name = match ? match[1].trim() : text;
            const tierName = normalizeTierName(match ? match[2] : 'COMMON');
            const key = `${name} [${tierName}]`;
            const existing = counts.get(key);
            if (existing) existing.count += 1;
            else counts.set(key, { raw: key, name, tier: tierName.toLowerCase(), count: 1 });
          }
          return [...counts.values()].sort((a, b) => {
            const tierDiff = (rank[b.tier] || 0) - (rank[a.tier] || 0);
            return tierDiff || a.name.localeCompare(b.name);
          });
        };

        return res.status(200).json({
          success: true,
          testMode: true,
          sender: { username: sender, items: summarize(senderRaw) },
          receiver: { username: receiver, items: summarize(receiverRaw) }
        });
      }

      // Live, uncached read of one player's inventory for the admin panel.
      // The panel used to read the public leaderboard, which only lists the
      // top 50 players and is cached for up to a minute: anyone outside the
      // top 50 could not be inspected, and a refresh right after an award or
      // delete showed stale items.
      case 'getInventory': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        const members = (await db.lrange(`fish:rares:${cleanTarget}`, 0, -1)) || [];
        return res.status(200).json({ success: true, targetUser: cleanTarget, items: members.map(String) });
      }

      // Removes every inventory entry of ONE rarity from ONE player and
      // nothing else: other rarities, catch history / Fishdex, perks, areas
      // and Auto-Fish are not touched (unlike clearUser).
      case 'wipeRarity': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        const wantedTier = normalizeTierName(rarity);
        const wipeTier = TIERS.find((t) => t.name === wantedTier);
        if (!wipeTier) {
          return res.status(400).json({ error: 'Choose a valid rarity to wipe.' });
        }

        // removeInventoryItems runs under the inventory lock and first saves
        // the current items to the lifetime catch history, so the wiped fish
        // stay discovered in the Fishdex.
        const wiped = await removeInventoryItems(db, cleanTarget, (item) => itemTierName(item) === wipeTier.name);
        if (!wiped.removed.length) {
          return res.status(404).json({ error: `@${cleanTarget} has no ${wipeTier.name} items to wipe.` });
        }
        const wipedCount = wiped.removed.length;

        // The stored best catch is derived from the inventory, so re-derive
        // it (same as every other admin delete). Perks are left alone.
        await recalculateBestCatch(cleanTarget, wiped.items);

        await writeAdminAudit({ actor: providedUser, action: 'wipeRarity', target: cleanTarget, details: `Wiped all ${wipeTier.name} items (${wipedCount}).` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'fish_removed', title: 'Rarity wiped by admin', message: `@${providedUser} removed all ${wipeTier.name} items (${wipedCount}) from your inventory.`, actor: providedUser, meta: { rarity: wipeTier.name, amount: wipedCount } });
        return res.status(200).json({
          success: true,
          wiped: wipedCount,
          rarity: wipeTier.name,
          message: `Wiped ${wipedCount} ${wipeTier.name} item${wipedCount === 1 ? '' : 's'} from @${cleanTarget}. Nothing else was changed.`
        });
      }

      case 'setGlobalEventLuck': {
        const mult = parseFloat(multiplier);
        if (isNaN(mult) || mult < 1.0 || mult > 100) {
          return res.status(400).json({ error: 'Invalid global event luck multiplier (1.0 - 100).' });
        }
        const cleanEventName = eventName ? String(eventName).trim() : 'Global Luck Event';
        if (cleanEventName.length > 80) {
          return res.status(400).json({ error: 'Event name is too long (max 80 characters).' });
        }

        await db.set('global:event_luck', mult);
        await db.set('global:event_name', cleanEventName);

        // Optional duration: if a valid positive number of seconds is provided,
        // the event will auto-disable itself once that time has passed.
        // Omitting/zeroing it out keeps the event running until manually ended.
        // Capped at 30 days so a typo cannot schedule an event for years.
        const durSecs = Math.min(parseInt(durationSeconds, 10) || 0, 30 * 24 * 3600);
        let expiresAt = null;
        if (!isNaN(durSecs) && durSecs > 0) {
          expiresAt = Date.now() + (durSecs * 1000);
          await db.set('global:event_expires', expiresAt);
        } else {
          await db.del('global:event_expires');
        }

        await writeAdminAudit({ actor: providedUser, action: 'setGlobalEventLuck', target: 'global', details: `${mult}x · ${cleanEventName}` });
        return res.status(200).json({
          success: true,
          message: `Successfully set Global Event Luck to ${mult}x (${cleanEventName})!`,
          eventExpires: expiresAt
        });
      }

      case 'clearGlobalEventLuck': {
        await db.del('global:event_luck');
        await db.del('global:event_name');
        await db.del('global:event_expires');
                  await writeAdminAudit({ actor: providedUser, action: 'clearGlobalEventLuck', target: 'global', details: 'Ended the global luck event.' });
        return res.status(200).json({
          success: true,
          message: 'Successfully ended the Global Event Luck.'
        });
      }

      case 'resetAllFishMessages': {
        const resetCount = await resetAllCustomTemplates();
        await writeAdminAudit({ actor: providedUser, action: 'resetAllFishMessages', target: 'global', details: `Reset custom !fish message templates to the system default for ${resetCount} saved template${resetCount === 1 ? '' : 's'}.` });
        return res.status(200).json({
          success: true,
          resetCount,
          message: resetCount
            ? `Reset ${resetCount} saved custom message template${resetCount === 1 ? '' : 's'} to the system default.`
            : 'No custom message templates were saved - everyone is already on the system default.'
        });
      }

      case 'giveFish':
      case 'givefish': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        if (!fish) {
          return res.status(400).json({ error: 'Fish name is required.' });
        }
        if (String(fish).length > 120) {
          return res.status(400).json({ error: 'Fish name is too long.' });
        }

        const selectedTierName = normalizeTierName(tier || 'SECRET');
        const tierObj = TIERS.find(t => t.name === selectedTierName) || SECRET_TIER;

        const inventoryItem = `${fish} [${tierObj.name}]`;
        await addInventoryItems(db, cleanTarget, inventoryItem);
        await recordCatch(db, cleanTarget, inventoryItem, 'admin');

        const bestTierKey = `fish:besttier:${cleanTarget}`;
        const currentBest = await db.get(bestTierKey);
        
        if (!currentBest || tierObj.rankScore > parseInt(currentBest, 10)) {
          await db.set(bestTierKey, tierObj.rankScore);
          await db.set(`fish:bestitem:${cleanTarget}`, `${fish} (${tierObj.name})`);
        }

        const countKey = `fish:count:${cleanTarget}`;
        const currentCount = await db.get(countKey);
        if (!currentCount) {
          await db.set(countKey, 1);
        } else {
          await db.incr(countKey);
        }

        const effects = await applyItemEffectsShared(db, cleanTarget, fish);
        const appliedStatMessage = effects.length ? ` and ${effects.join(', ')}!` : '';

        await writeAdminAudit({ actor: providedUser, action: 'giveFish', target: cleanTarget, details: `${fish} [${tierObj.name}]${appliedStatMessage}` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'fish_added', title: 'Fish added by admin', message: `@${providedUser} added ${fish} [${tierObj.name}] to your inventory.`, actor: providedUser, meta: { fish, tier: tierObj.name } });
        return res.status(200).json({ 
          success: true, 
          message: `Successfully gave ${fish} [${tierObj.name}] to @${cleanTarget}!${appliedStatMessage}` 
        });
      }

      case 'giveFishBatch': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        if (!items || !Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ error: 'No items provided to award.' });
        }
        if (items.length > 500) {
          return res.status(400).json({ error: 'Too many items at once (max 500).' });
        }

        const pushList = [];
        let totalGiven = 0;
        let bestTierObj = null;
        let bestItemString = '';
        let allEffects = [];
        const effectJobs = [];

        for (const entry of items) {
          const fishName = (entry && entry.fish ? entry.fish : '').toString().trim();
          if (!fishName) continue;

          const amount = Math.max(1, Math.min(99, parseInt(entry.amount, 10) || 1));
          const selectedTierName = normalizeTierName(entry.tier || 'SECRET');
          const tierObj = TIERS.find(t => t.name === selectedTierName) || SECRET_TIER;

          for (let i = 0; i < amount; i++) {
            pushList.push(`${fishName} [${tierObj.name}]`);
          }
          totalGiven += amount;

          if (!bestTierObj || tierObj.rankScore > bestTierObj.rankScore) {
            bestTierObj = tierObj;
            bestItemString = `${fishName} (${tierObj.name})`;
          }

          effectJobs.push(applyItemEffectsShared(db, cleanTarget, fishName, amount));
        }
        for (const effects of await Promise.all(effectJobs)) allEffects.push(...effects);

        if (pushList.length === 0) {
          return res.status(400).json({ error: 'No valid items to award.' });
        }
        if (totalGiven > 500) {
          return res.status(400).json({ error: 'Too many items at once (max 500 total).' });
        }

        await addInventoryItems(db, cleanTarget, pushList);
        await recordCatches(db, cleanTarget, pushList, 'admin');

        const bestTierKey = `fish:besttier:${cleanTarget}`;
        const currentBest = await db.get(bestTierKey);
        if (bestTierObj && (!currentBest || bestTierObj.rankScore > parseInt(currentBest, 10))) {
          await db.set(bestTierKey, bestTierObj.rankScore);
          await db.set(`fish:bestitem:${cleanTarget}`, bestItemString);
        }

        const countKey = `fish:count:${cleanTarget}`;
        const currentCount = await db.get(countKey);
        await db.set(countKey, (parseInt(currentCount, 10) || 0) + totalGiven);

        const uniqueNames = [...new Set(items.map(i => (i && i.fish ? i.fish : '').toString().trim()).filter(Boolean))];
        const uniqueEffects = [...new Set(allEffects)];
        const appliedStatMessage = uniqueEffects.length ? ` and ${uniqueEffects.join(', ')}!` : '';

        await writeAdminAudit({ actor: providedUser, action: 'giveFishBatch', target: cleanTarget, details: `${totalGiven} item${totalGiven === 1 ? '' : 's'} · ${uniqueNames.join(', ')}` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'fish_added', title: 'Fish added by admin', message: `@${providedUser} added ${totalGiven} fish/item${totalGiven === 1 ? '' : 's'} to your inventory.`, actor: providedUser, meta: { items: uniqueNames, amount: totalGiven } });
        return res.status(200).json({
          success: true,
          message: `Successfully gave ${totalGiven} item${totalGiven === 1 ? '' : 's'} (${uniqueNames.join(', ')}) to @${cleanTarget}!${appliedStatMessage}`
        });
      }

      case 'removeFish':
      case 'removefish': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        if (!fish) {
          return res.status(400).json({ error: 'Fish name is required.' });
        }

        const listKey = `fish:rares:${cleanTarget}`;
        const members = await db.lrange(listKey, 0, -1);
        if (!members || members.length === 0) {
          return res.status(404).json({ error: `User @${cleanTarget} has no inventory items.` });
        }

        const targetParsed = parseItem(fish);
        const result = await removeInventoryItems(db, cleanTarget, (item) => {
          const memberParsed = parseItem(item);
          const memberRaw = typeof item === 'string' ? item.toLowerCase().trim() : '';
          const targetRaw = String(fish).toLowerCase().trim();
          return memberRaw === targetRaw || memberParsed.full === targetParsed.full ||
            (targetParsed.base && memberParsed.base === targetParsed.base && (!targetParsed.tier || memberParsed.tier === targetParsed.tier));
        }, 1, 1);
        if (!result.removed.length) {
          return res.status(404).json({ error: `Fish "${fish}" was not found in @${cleanTarget}'s inventory.` });
        }
        const updatedMembers = result.items;

        await recalculateBestCatch(cleanTarget, updatedMembers);
        await checkAndCleanLuckStatus(cleanTarget, updatedMembers, result.removed);

        await writeAdminAudit({ actor: providedUser, action: 'removeFish', target: cleanTarget, details: `Removed ${fish} from inventory.` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'fish_removed', title: 'Fish removed by admin', message: `@${providedUser} removed ${fish} from your inventory.`, actor: providedUser, meta: { fish } });
        return res.status(200).json({ 
          success: true, 
          message: `Successfully removed ${fish} from @${cleanTarget}!` 
        });
      }

      case 'multiDeleteFish': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        if (!items || !Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ error: 'No items provided for multi-delete.' });
        }
        if (items.length > 500) {
          return res.status(400).json({ error: 'Too many items at once (max 500).' });
        }

        const listKey = `fish:rares:${cleanTarget}`;
        const members = await db.lrange(listKey, 0, -1);
        if (!members || members.length === 0) {
          return res.status(404).json({ error: `User @${cleanTarget} has no items.` });
        }

        const remainingTargets = [...items];
        const result = await removeInventoryItems(db, cleanTarget, (member) => {
          for (let index = 0; index < remainingTargets.length; index++) {
            const itemToDelete = remainingTargets[index];
            const targetParsed = parseItem(itemToDelete);
            const memberParsed = parseItem(member);
            const memberRaw = typeof member === 'string' ? member.toLowerCase().trim() : '';
            const targetRaw = typeof itemToDelete === 'string' ? itemToDelete.toLowerCase().trim() : '';
            if (memberRaw === targetRaw || memberParsed.full === targetParsed.full ||
              (targetParsed.base && memberParsed.base === targetParsed.base && (!targetParsed.tier || memberParsed.tier === targetParsed.tier))) {
              remainingTargets.splice(index, 1);
              return true;
            }
          }
          return false;
        }, items.length);
        const removedCount = result.removed.length;
        const updatedMembers = result.items;
        if (removedCount === 0) {
          return res.status(400).json({ error: 'None of the selected items could be located in user inventory.' });
        }

        await recalculateBestCatch(cleanTarget, updatedMembers);
        await checkAndCleanLuckStatus(cleanTarget, updatedMembers, result.removed);

        await writeAdminAudit({ actor: providedUser, action: 'multiDeleteFish', target: cleanTarget, details: `Deleted ${removedCount} inventory items.` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'fish_removed', title: 'Fish removed by admin', message: `@${providedUser} removed ${removedCount} item${removedCount === 1 ? '' : 's'} from your inventory.`, actor: providedUser, meta: { amount: removedCount } });
        return res.status(200).json({
          success: true,
          message: `Successfully deleted ${removedCount} items from @${cleanTarget}!`
        });
      }

      case 'getAutoFish': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        try {
          return res.status(200).json({ success: true, autoFish: await adminGetAutoFish(cleanTarget) });
        } catch (error) {
          return res.status(500).json({ error: error.message || 'Could not load Auto-Fish state.' });
        }
      }

      case 'getAutoFishGlobal': {
        try {
          return res.status(200).json({ success: true, autoFish: { config: await getAutoFishConfig() } });
        } catch (error) {
          return res.status(500).json({ error: error.message || 'Could not load global Auto-Fish settings.' });
        }
      }

      case 'addPondTokens': {
        const cleanTarget = String(targetUser || '').trim().replace(/^@+/, '').toLowerCase();
        const amount = Number(req.body?.amount);
        if (!/^[a-zA-Z0-9_]{1,25}$/.test(cleanTarget)) return res.status(400).json({ error: 'Enter a valid Twitch username.' });
        if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) return res.status(400).json({ error: 'FishyTokens amount must be a whole number from 1 to 1,000,000.' });
        const key = pondKeys(cleanTarget).tokens;
        const balance = Number(await db.incrby(key, amount));
        await writeAdminAudit({ actor: providedUser, action: 'addPondTokens', target: cleanTarget, details: `Added ${amount.toLocaleString()} FishyTokens. New balance: ${balance.toLocaleString()}.` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'pond_tokens_added', title: 'FishyTokens added by admin', message: `@${providedUser} added ${amount.toLocaleString()} FishyTokens to your Pond.`, actor: providedUser, meta: { amount, balance } });
        return res.status(200).json({ success: true, targetUser: cleanTarget, amount, balance });
      }

      case 'spawnTreasurySlot': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        try {
          const amount = Math.max(0, Math.min(50, parseInt(req.body?.amount, 10) || 0));
          const result = await adminSpawnTreasurySlot(cleanTarget, amount);
          if (!result.success) return res.status(400).json(result);
          await writeAdminAudit({
            actor: providedUser,
            action: 'spawnTreasurySlot',
            target: cleanTarget,
            details: `Spawned ${result.event?.treasuryAmount || 0} Treasury reward(s) as a Fishy treat in the tank.`
          });
          return res.status(200).json(result);
        } catch (error) {
          return res.status(500).json({ error: error.message || 'Could not spawn the Fishy treat.' });
        }
      }

      case 'setAutoFish': {
        try {
          const result = await adminSetAutoFish(req.body || {}, providedUser);
          return res.status(200).json(result);
        } catch (error) {
          return res.status(400).json({ error: error.message || 'Could not update Auto-Fish.' });
        }
      }

      case 'adminDebugSnapshot': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        try {
          const [inventory, fishdexCount, pond, autoFish, prestigeRaw] = await Promise.all([
            db.lrange(`fish:rares:${cleanTarget}`, 0, -1),
            getFishdexFishCount(cleanTarget),
            pondStatus(cleanTarget, 0, { includeInventory: false }).catch(() => ({ unlocked: false })),
            adminGetAutoFish(cleanTarget),
            db.get(`autofish:prestige:${cleanTarget}`)
          ]);
          const state = await readFishState(cleanTarget);
          const luck = await computeLuck({ ...state, userKey: cleanTarget }, false, false, 'manual', '');
          return res.status(200).json({
            success: true,
            snapshot: {
              user: cleanTarget,
              inventoryCount: Array.isArray(inventory) ? inventory.length : 0,
              fishdexCount,
              luck,
              luckInputs: {
                customLuck: state.customLuck,
                vipSubModMirror: state.realVip === 'true',
                vipSubModLuck: luck.vipLuckApplied ? luck.vipLuckMultiplier : 1,
                vipBaseApplied: !!luck.vipBaseApplied,
                vipLuckApplied: !!luck.vipLuckApplied,
                vipLuckMultiplier: Number(luck.vipLuckMultiplier || 1),
                vipSubModRoleActive: !!luck.vipSubModRoleActive,
                vipLuckSource: luck.vipLuckSource,
                vipLuckBlockedByCustom: !!luck.vipLuckBlockedByCustom,
                vipLuckBlockedByToggle: !!luck.vipLuckBlockedByToggle,
                gameVipActive: !!luck.gameVipActive,
                permanentLuck: !!state.permLuck && state.togglePerm !== 'off',
                temporaryLuck: !!state.tempLuck && state.toggleTemp !== 'off',
                shopLuck: !!state.shopLuck && state.toggleLuck125 !== 'off',
                treasuryLuck: !!state.shopTreasuryLuck && state.toggleTreasuryLuck !== 'off',
                rarityBoost: state.shopRarityBoost || null,
                speciesHunterLevel: (() => { try { return Number(JSON.parse(state.pondTreasuryPerks || '{}')?.speciesHunter) || 0; } catch (_) { return 0; } })(),
                speciesHunterBonus: (() => { try { const lvl = Number(JSON.parse(state.pondTreasuryPerks || '{}')?.speciesHunter) || 0; return speciesHunterBonus(lvl, fishdexCount); } catch (_) { return 0; } })()
              },
              pond: {
                unlocked: !!pond?.unlocked,
                level: pond?.level || 0,
                treasuryPerks: pond?.treasuryPerks || {},
                activeTreasuryPerks: pond?.activeTreasuryPerks || {},
                toggles: pond?.treasuryPerkToggles || {}
              },
              autoFish: autoFish || {},
              prestige: Math.max(0, parseInt(prestigeRaw, 10) || 0)
            }
          });
        } catch (error) {
          return res.status(500).json({ error: error.message || 'Could not build debug snapshot.' });
        }
      }

      case 'adminLuckBreakdown': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        try {
          const state = await readFishState(cleanTarget);
          const luck = await computeLuck({ ...state, userKey: cleanTarget }, false, false, 'manual', '');
          const fishdexCount = await getFishdexFishCount(cleanTarget);
          let speciesLevel = 0;
          try { speciesLevel = Math.max(0, Math.min(POND_TREASURY_PERKS.speciesHunter.max, Number(JSON.parse(state.pondTreasuryPerks || '{}')?.speciesHunter) || 0)); } catch (_) { console.error('[api/admin/action.js:973] ignored error:', _?.message || _); }
          const customLuckActive = Number.isFinite(Number(state.customLuck));
          const vipSubModActive = state.realVip === 'true';
          const gameVipActive = !!state.gameVip;
          const factors = [
            { name: 'Base / custom Luck', value: customLuckActive ? Number(state.customLuck) : 1 },
            { name: 'VIP / Sub / Mod Luck', value: vipSubModActive && state.toggleVip !== 'off' ? 1.5 : 1, active: vipSubModActive && state.toggleVip !== 'off', source: 'Nightbot Twitch role / stored mirror', multiplier: true },
            { name: 'Vipfish Luck', value: gameVipActive && !vipSubModActive && !customLuckActive ? 1.5 : 1, active: gameVipActive && !vipSubModActive && !customLuckActive, source: 'permanent Vipfish unlock' },
            { name: 'Permanent 1.5× Luck', value: state.permLuck && state.togglePerm !== 'off' ? 1.5 : 1 },
            { name: 'Temporary 2× Luck', value: state.tempLuck && state.toggleTemp !== 'off' ? 2 : 1 },
            { name: 'Shop 1.25× Luck', value: state.shopLuck && state.toggleLuck125 !== 'off' ? 1.25 : 1 },
            { name: 'Species Hunter', value: speciesHunterBonus(speciesLevel, fishdexCount), additive: true, level: speciesLevel, fishdexCount },
            { name: 'Event Luck', value: luck.eventShown ? Number(luck.eventLuck || 1) : 1 },
            { name: 'Prestige Treasury bonus', value: Number(luck.totalTreasuryMult || 1), additive: true, treasuryOnly: luck.treasuryOnlyOn }
          ];
          return res.status(200).json({ success:true, breakdown:{ factors, finalLuck: luck.multiplier, baseLuck: luck.baseLuck, customLuckActive: luck.customLuckActive, vipSubModMirror: luck.vipSubModMirror, vipSubModRoleActive: luck.vipSubModRoleActive, vipLuckSource: luck.vipLuckSource, vipLuckBlockedByCustom: luck.vipLuckBlockedByCustom, vipLuckBlockedByToggle: luck.vipLuckBlockedByToggle, gameVipActive: luck.gameVipActive, vipBaseApplied: luck.vipBaseApplied, vipLuckApplied: luck.vipLuckApplied, vipLuckMultiplier: luck.vipLuckMultiplier, note: 'VIP/Sub/Mod status is mirrored when that user runs !fish. The admin diagnostic cannot read a live Twitch role directly; the stored mirror is what the server can verify for this user outside the chat request.', treasuryMultiplier: luck.totalTreasuryMult, treasuryOnly: luck.treasuryOnlyOn, rarityBoost: luck.rarityBoostTier || null } });
        } catch (error) {
          return res.status(500).json({ error: error.message || 'Could not calculate Luck breakdown.' });
        }
      }

      case 'adminTestFishRoll': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        try {
          const state = await readFishState(cleanTarget);
          const luck = await computeLuck({ ...state, userKey: cleanTarget }, false, false, 'manual', '');
          const rod = rodFor(state.progressionRod);
          const bait = baitFor(state.progressionSelectedBait);
          const table = weightedTierTable(luck.multiplier * (1 + Number(rod?.bonus || 0)) * Math.max(1, Number(bait?.multiplier || 1)), luck.rarityBoostTier);
          const roll = rollCatch(luck, null, Number(rod?.bonus || 0), Number(bait?.multiplier || 1));
          return res.status(200).json({ success:true, dryRun:true, roll:{ item: roll.item || null, tier: roll.tier?.name || null, mud: !!roll.mud, treasuryChance: roll.treasuryChance, tierChance: roll.tierChance }, luck: luck.multiplier, baseLuck: luck.baseLuck, vipSubModMirror: luck.vipSubModMirror, vipSubModRoleActive: luck.vipSubModRoleActive, vipLuckSource: luck.vipLuckSource, vipLuckBlockedByCustom: luck.vipLuckBlockedByCustom, vipLuckBlockedByToggle: luck.vipLuckBlockedByToggle, vipBaseApplied: luck.vipBaseApplied, vipLuckApplied: luck.vipLuckApplied, vipLuckMultiplier: luck.vipLuckMultiplier, rod: rod?.name, bait: bait?.name, odds: table.map(r => ({ tier:r.tier?.name, chance:Number((r.probability*100).toFixed(3)) })) });
        } catch (error) {
          return res.status(500).json({ error: error.message || 'Could not test !fish roll.' });
        }
      }

      case 'adminTestPondRoll': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        try {
          const pond = await pondStatus(cleanTarget, 0, { includeInventory: false });
          if (!pond?.unlocked) return res.status(400).json({ error:'User has not unlocked the Personal Pond.' });
          return res.status(200).json({ success:true, dryRun:true, pondRoll:{ level:pond.level, selected:pond.selected, activeTreasuryPerks:pond.activeTreasuryPerks, finder:pond.fishFinder || null } });
        } catch (error) {
          return res.status(500).json({ error: error.message || 'Could not test Pond roll.' });
        }
      }

      case 'adminRepairUserState': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        const dryRun = req.body?.dryRun !== false;
        const changes = [];
        const fixes = [];
        const stateRaw = await db.get(`pond:treasury_perks:${cleanTarget}`);
        let pondLevels = {};
        try { pondLevels = JSON.parse(stateRaw || '{}') || {}; } catch (_) { changes.push('Pond Treasury perk JSON is malformed.'); }
        const defs = Object.fromEntries(Object.entries(POND_TREASURY_PERKS).map(([id,d]) => [id,d.max]));
        const normalized = {};
        for (const [id,max] of Object.entries(defs)) {
          const n = Math.max(0, Math.min(max, Number(pondLevels[id]) || 0));
          if (pondLevels[id] !== undefined && Number(pondLevels[id]) !== n) changes.push(`${id}: ${pondLevels[id]} → ${n}`);
          if (n > 0) normalized[id] = n;
        }
        if (JSON.stringify(normalized) !== JSON.stringify(pondLevels)) fixes.push({ key:`pond:treasury_perks:${cleanTarget}`, value:JSON.stringify(normalized) });
        const featureKey = `pond:feature_upgrades:${cleanTarget}`;
        const featureRaw = await db.get(featureKey);
        let features = {}; try { features = JSON.parse(featureRaw || '{}') || {}; } catch (_) { changes.push('Pond feature JSON is malformed.'); }
        const featureDefs = { deepWater:3,luckyWater:3,fishFinder:1,baitSlots:2,familiarity:3 };
        const normalizedFeatures = {};
        for (const [id,max] of Object.entries(featureDefs)) { const n=Math.max(0,Math.min(max,Number(features[id])||0)); if(n>0) normalizedFeatures[id]=n; if(features[id]!==undefined && Number(features[id])!==n) changes.push(`${id}: ${features[id]} → ${n}`); }
        if (JSON.stringify(normalizedFeatures)!==JSON.stringify(features)) fixes.push({key:featureKey,value:JSON.stringify(normalizedFeatures)});
        if (!dryRun) {
          for (const fix of fixes) await db.set(fix.key, fix.value);
          await writeAdminAudit({ actor: providedUser, action:'repairUserState', target:cleanTarget, details:`Repaired ${fixes.length} derived state record(s).` });
        }
        return res.status(200).json({ success:true, dryRun, changes, fixes:fixes.map(f=>f.key), message: dryRun ? (fixes.length ? 'Repair preview ready.' : 'No repairs needed.') : `Applied ${fixes.length} repair(s).` });
      }

      case 'getPerks': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }

        const entries = Object.entries(ADMIN_PERKS);
        const values = await Promise.all(entries.map(([, p]) => db.get(`${p.key}:${cleanTarget}`)));
        const ttls = await Promise.all(entries.map(([, p]) => (p.ttl ? db.ttl(`${p.key}:${cleanTarget}`) : -1)));
        const toggles = await Promise.all(entries.map(([, p]) => (p.toggleId ? db.get(`toggle:${p.toggleId}:${cleanTarget}`) : null)));

        // Same ownership rule as api/perks.js: the perk key OR a matching
        // item in the inventory. Checking only the key made a perk that the
        // player caught - and whose item was since consumed - look unowned,
        // so the panel greyed it out and refused to act on it.
        const rares = (await db.lrange(`fish:rares:${cleanTarget}`, 0, -1)) || [];
        const inventoryHas = (needle) =>
          rares.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes(needle));
        const INVENTORY_MATCHERS = {
          permLuck: '1.5x luck',
          tempLuck: '2x luck',
          vip: 'vipfish'
        };

        const pondKeySet = pondKeys(cleanTarget);
        let pondFeatureLevels = {};
        let pondTreasuryLevels = {};
        let pondUnlocked = (await db.get(pondKeySet.unlocked)) === 'true';
        try { pondFeatureLevels = JSON.parse((await db.get(pondKeySet.featureUpgrades)) || '{}') || {}; } catch (_) { console.error('[api/admin/action.js:1081] ignored error:', _?.message || _); }
        try { pondTreasuryLevels = JSON.parse((await db.get(pondKeySet.treasuryPerks)) || '{}') || {}; } catch (_) { console.error('[api/admin/action.js:1082] ignored error:', _?.message || _); }
        const pondDefinitions = {
          features: { deepWater: { name:'Deep Water', max:3 }, luckyWater:{name:'Lucky Water',max:3}, fishFinder:{name:'Fish Finder',max:1}, baitSlots:{name:'Bait Slots',max:2}, familiarity:{name:'Familiarity',max:3} },
          treasury: { speciesHunter:{name:'Species Hunter',max:5}, baitSaver:{name:'Bait Saver',max:5}, collectorInstinct:{name:"Collector's Instinct",max:3}, stillWaters:{name:'Still Waters',max:3}, deepCurrent:{name:'Deep Current',max:3}, biggerHaul:{name:'Bigger Haul',max:3}, fishyFortune:{name:'Fishy Fortune',max:3}, treasuryWaters:{name:'Treasury Waters',max:1} }
        };
        const perks = {};
        entries.forEach(([id, p], i) => {
          const remainingSeconds = ttls[i] > 0 ? ttls[i] : 0;
          const toggleOn = toggles[i] !== 'off';
          const hasKey = !!values[i];
          const heldInInventory = INVENTORY_MATCHERS[id] ? inventoryHas(INVENTORY_MATCHERS[id]) : false;
          const owned = hasKey || heldInInventory;
          const active = p.ttl ? remainingSeconds > 0 && toggleOn : (hasKey && toggleOn);
          perks[id] = {
            name: p.name,
            owned,
            active,
            remainingSeconds,
            rarity: id === 'rarityBoost' && active ? values[i] : ''
          };
        });

        const [areasMasterValue, doubleCatchValue, ...areaEnabledValues] = await Promise.all([
          db.get(AREAS_ENABLED_KEY),
          db.get(DOUBLE_CATCH_ENABLED_KEY),
          ...AREA_IDS.map((id) => db.get(areaEnabledKey(id)))
        ]);
        const targetAreaLevels = await Promise.all(AREA_IDS.map((id) => db.get(areaLevelKey(cleanTarget, id))));
        const areas = Object.fromEntries(AREA_IDS.map((id, i) => [id, {
          name: FISHING_AREAS[id].name,
          icon: FISHING_AREAS[id].icon,
          level: Math.max(0, Math.min(5, parseInt(targetAreaLevels[i], 10) || 0)),
          enabled: isEnabledValue(areaEnabledValues[i])
        }]));
        const autoFish = await adminGetAutoFish(cleanTarget);
        return res.status(200).json({
          success: true, perks, rarities: BOOSTABLE_RARITIES, autoFish,
          pond: { unlocked: pondUnlocked, level: Math.max(1, Math.min(5, Number(await db.get(pondKeySet.level)) || 1)), tokens: Number(await db.get(pondKeySet.tokens)) || 0, features: pondDefinitions.features, featureLevels: pondFeatureLevels, treasury: pondDefinitions.treasury, treasuryLevels: pondTreasuryLevels },
          areaSettings: {
            masterEnabled: isEnabledValue(areasMasterValue),
            doubleCatchEnabled: isEnabledValue(doubleCatchValue),
            areas
          }
        });
      }

      case 'setAreaFeature': {
        if (feature === 'areas') {
          if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'A boolean enabled value is required.' });
          await db.set(AREAS_ENABLED_KEY, enabled ? 'on' : 'off');
          await writeAdminAudit({ actor: providedUser, action: 'setAreaFeature', target: 'global', details: `${enabled ? 'Enabled' : 'Disabled'} all fishing areas.` });
          return res.status(200).json({ success: true, message: `Fishing areas ${enabled ? 'enabled' : 'disabled'}.` });
        }
        if (feature === 'doubleCatch') {
          if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'A boolean enabled value is required.' });
          await db.set(DOUBLE_CATCH_ENABLED_KEY, enabled ? 'on' : 'off');
          await writeAdminAudit({ actor: providedUser, action: 'setAreaFeature', target: 'global', details: `${enabled ? 'Enabled' : 'Disabled'} Double Catch.` });
          return res.status(200).json({ success: true, message: `Double Catch ${enabled ? 'enabled' : 'disabled'}.` });
        }
        if (!FISHING_AREAS[areaId] || typeof enabled !== 'boolean') return res.status(400).json({ error: 'Valid areaId and enabled value are required.' });
        await db.set(areaEnabledKey(areaId), enabled ? 'on' : 'off');
        await writeAdminAudit({ actor: providedUser, action: 'setAreaFeature', target: 'global', details: `${enabled ? 'Enabled' : 'Disabled'} ${FISHING_AREAS[areaId].name}.` });
        return res.status(200).json({ success: true, message: `${FISHING_AREAS[areaId].name} ${enabled ? 'enabled' : 'disabled'}.` });
      }

      case 'setUserAreas': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        const ids = areaIds === 'all' || (Array.isArray(areaIds) && areaIds.includes('all')) ? AREA_IDS : (Array.isArray(areaIds) ? [...new Set(areaIds)] : []);
        if (!ids.length || ids.some((id) => !FISHING_AREAS[id])) return res.status(400).json({ error: 'Select at least one valid fishing area.' });
        const nextLevel = Math.max(0, Math.min(5, parseInt(level, 10) || 0));
        if (nextLevel < 0 || nextLevel > 5) return res.status(400).json({ error: 'Area level must be between 0 and 5.' });
        await Promise.all(ids.map((id) => nextLevel > 0 ? db.set(areaLevelKey(cleanTarget, id), String(nextLevel)) : db.del(areaLevelKey(cleanTarget, id))));
        if (nextLevel === 0) {
          const selected = await db.get(selectedAreaKey(cleanTarget));
          if (ids.includes(selected)) await db.del(selectedAreaKey(cleanTarget));
        }
        const names = ids.map((id) => FISHING_AREAS[id].name).join(', ');
        const verb = nextLevel > 0 ? `Set to level ${nextLevel}` : 'Removed';
        await writeAdminAudit({ actor: providedUser, action: 'setUserAreas', target: cleanTarget, details: `${verb}: ${names}` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: nextLevel > 0 ? 'area_added' : 'area_removed', title: nextLevel > 0 ? 'Fishing area granted' : 'Fishing area removed', message: `@${providedUser} ${nextLevel > 0 ? `granted ${names} at level ${nextLevel}` : `removed ${names}`} from your account.`, actor: providedUser, meta: { areas: ids, level: nextLevel } });
        return res.status(200).json({ success: true, message: `${verb} ${names} for @${cleanTarget}.` });
      }

      case 'setPondLevel': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        const nextLevel = Number(req.body?.level);
        if (!Number.isInteger(nextLevel) || nextLevel < 1 || nextLevel > 5) return res.status(400).json({ error: 'Pond Level must be an integer from 1 to 5.' });
        const k = pondKeys(cleanTarget);
        await db.set(k.level, String(nextLevel));
        await db.set(k.unlocked, 'true');
        await writeAdminAudit({ actor: providedUser, action: 'setPondLevel', target: cleanTarget, details: `Set Pond Level to ${nextLevel}.` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'pond_level_changed', title: 'Pond level changed by admin', message: `@${providedUser} set your Pond to Level ${nextLevel}.`, actor: providedUser, meta: { level: nextLevel } });
        return res.status(200).json({ success: true, targetUser: cleanTarget, level: nextLevel });
      }

      case 'setPondPerk': {
        const targetError = requireTarget();
        if (targetError) return res.status(400).json(targetError);
        const kind = String(req.body?.kind || '');
        const id = String(req.body?.pondPerk || '');
        const nextLevel = Number(req.body?.level);
        const keySet = pondKeys(cleanTarget);
        if (await db.get(keySet.unlocked) !== 'true') return res.status(400).json({ error: 'User has not unlocked the Personal Pond.' });
        const defs = kind === 'feature'
          ? { deepWater:3, luckyWater:3, fishFinder:1, baitSlots:2, familiarity:3 }
          : kind === 'treasury'
            ? { speciesHunter:5, baitSaver:5, collectorInstinct:3, stillWaters:3, deepCurrent:3, biggerHaul:3, fishyFortune:3, treasuryWaters:1 }
            : null;
        if (!defs || !Object.prototype.hasOwnProperty.call(defs, id) || !Number.isInteger(nextLevel) || nextLevel < 0 || nextLevel > defs[id]) return res.status(400).json({ error: 'Invalid Pond perk or level.' });
        if (kind === 'treasury' && id === 'treasuryWaters' && nextLevel > 0 && (Number(await db.get(keySet.level)) || 1) < 5) return res.status(400).json({ error: 'Treasury Waters requires Pond Level 5.' });
        const key = kind === 'feature' ? keySet.featureUpgrades : keySet.treasuryPerks;
        let state = {}; try { state = JSON.parse((await db.get(key)) || '{}') || {}; } catch (_) { console.error('[api/admin/action.js:1195] ignored error:', _?.message || _); }
        state[id] = nextLevel;
        if (kind === 'feature' && id === 'baitSlots' && nextLevel === 0) await db.del(keySet.baitSlots);
        await db.set(key, JSON.stringify(state));
        await writeAdminAudit({ actor: providedUser, action:'setPondPerk', target:cleanTarget, details:`Set Pond ${kind} perk ${id} to level ${nextLevel}.` });
        await writeUserFeedback(cleanTarget, { type:'admin', subtype:'pond_perk_changed', title:'Pond perk changed by admin', message:`@${providedUser} set your Pond ${id} to level ${nextLevel}.`, actor:providedUser, meta:{ kind, perk:id, level:nextLevel } });
        return res.status(200).json({ success:true, message:`Set ${id} to level ${nextLevel} for @${cleanTarget}.` });
      }

      case 'setPerk': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        const p = ADMIN_PERKS[perk];
        if (!p || typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'Requires a valid "perk" and a boolean "enabled".' });
        }
        if (perk === 'rarityBoost' && enabled && !BOOSTABLE_RARITIES.includes(rarity)) {
          return res.status(400).json({ error: 'Pick a valid rarity for the boost.' });
        }

        const dbKey = `${p.key}:${cleanTarget}`;
        // Ownership is the same test getPerks uses: the perk key, or the
        // item sitting in the inventory. Key-only rejected every perk the
        // player had actually caught, because catching an item never writes
        // the perk key - the effect is applied at cast time instead.
        if (enabled) {
          const ownsPerk = await db.get(dbKey);
          let ownsIt = !!ownsPerk;
          if (!ownsIt) {
            const matcher = { permLuck: '1.5x luck', tempLuck: '2x luck', vip: 'vipfish' }[perk];
            if (matcher) {
              const held = (await db.lrange(`fish:rares:${cleanTarget}`, 0, -1)) || [];
              ownsIt = held.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes(matcher));
            }
          }
          if (!ownsIt) {
            return res.status(400).json({ error: `User does not own ${p.name}.` });
          }
          const value = perk === 'rarityBoost' ? rarity : 'true';
          if (p.ttl) await db.set(dbKey, value, { ex: p.ttl });
          else await db.set(dbKey, value);
          if (p.toggleId) await db.set(`toggle:${p.toggleId}:${cleanTarget}`, 'on');
          // `real_vip` is intentionally left alone - see grantPerk.
        } else {
          await db.del(dbKey);
          if (p.toggleId) await db.del(`toggle:${p.toggleId}:${cleanTarget}`);
          const removedFish = await removePerkFish(cleanTarget, perk);
          if (removedFish.removed.length) {
            console.log(`[Admin] Removing ${removedFish.removed.length} fish that granted ${p.name} from ${cleanTarget}.`);
          }
        }

        await writeAdminAudit({ actor: providedUser, action: 'setPerk', target: cleanTarget, details: `${enabled ? 'Enabled' : 'Removed'} ${p.name}${perk === 'rarityBoost' && enabled ? ` · ${rarity}` : ''}` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: enabled ? 'perk_added' : 'perk_removed', title: enabled ? 'Perk added by admin' : 'Perk removed by admin', message: `@${providedUser} ${enabled ? 'enabled' : 'removed'} ${p.name}${perk === 'rarityBoost' && enabled ? ` (${rarity})` : ''} on your account.`, actor: providedUser, meta: { perk, rarity: rarity || null, enabled } });
        return res.status(200).json({
          success: true,
          message: `${enabled ? 'Added' : 'Removed'} ${p.name} ${enabled ? 'to' : 'from'} @${cleanTarget}.`
        });
      }

      case 'grantPerk': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        const gp = ADMIN_PERKS[perk];
        if (!gp) {
          return res.status(400).json({ error: 'Requires a valid "perk".' });
        }
        if (perk === 'rarityBoost' && !BOOSTABLE_RARITIES.includes(rarity)) {
          return res.status(400).json({ error: 'Pick a valid rarity for the boost.' });
        }

        const gdbKey = `${gp.key}:${cleanTarget}`;
        const alreadyOwns = await db.get(gdbKey);
        if (alreadyOwns) {
          return res.status(400).json({ error: `User already owns ${gp.name}.` });
        }

        const gvalue = perk === 'rarityBoost' ? rarity : 'true';
        if (gp.ttl) await db.set(gdbKey, gvalue, { ex: gp.ttl });
        else await db.set(gdbKey, gvalue);
        if (gp.toggleId) await db.set(`toggle:${gp.toggleId}:${cleanTarget}`, 'on');

        // Deliberately NOT touching `real_vip` here. That key mirrors the
        // player's ACTUAL Twitch role and is rewritten by the chat bot on
        // every !fish, so writing it from the panel would hand a stranger
        // permanent VIP luck the moment the bot corrected it back to
        // 'false'. `game_vip` (set just above) is the grantable flag, and
        // perks.js already treats it as sufficient on its own.

        await writeAdminAudit({ actor: providedUser, action: 'grantPerk', target: cleanTarget, details: `Granted ${gp.name}${perk === 'rarityBoost' ? ` · ${rarity}` : ''}` });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'perk_added', title: 'Perk added by admin', message: `@${providedUser} granted ${gp.name}${perk === 'rarityBoost' ? ` (${rarity})` : ''} to your account.`, actor: providedUser, meta: { perk, rarity: rarity || null, enabled: true } });
        return res.status(200).json({
          success: true,
          message: `Granted ${gp.name} to @${cleanTarget}.`
        });
      }

      case 'recalcBestCatch': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }

        const listKey = `fish:rares:${cleanTarget}`;
        const members = await db.lrange(listKey, 0, -1);

        if (!members || members.length === 0) {
          await db.del(`fish:besttier:${cleanTarget}`);
          await db.del(`fish:bestitem:${cleanTarget}`);
          return res.status(404).json({ error: `User @${cleanTarget} has no inventory items to recalculate.` });
        }

        const result = await recalculateBestCatch(cleanTarget, members);

        await writeAdminAudit({ actor: providedUser, action: 'recalcBestCatch', target: cleanTarget, details: result.cleared ? 'Cleared best catch; no valid items remained.' : `Best catch is now ${result.bestItem}.` });
        return res.status(200).json({
          success: true,
          message: result.cleared
            ? `No valid items found for @${cleanTarget} — best catch cleared.`
            : `Recalculated best catch for @${cleanTarget}: ${result.bestItem}`,
          bestItem: result.cleared ? null : result.bestItem,
          bestTier: result.cleared ? null : result.bestTier
        });
      }

      case 'getCatchLog': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        const catchLog = await getRecentCatchLog(db, cleanTarget, 100);
        return res.status(200).json({ success: true, targetUser: cleanTarget, catchLog });
      }

      case 'getAuditLog': {
        const requestedLimit = Math.max(1, Math.min(50, Number((req.body || {}).limit) || 50));
        const auditLog = await getRecentAdminAudit(db, requestedLimit);
        return res.status(200).json({ success: true, auditLog });
      }

      case 'deleteAuditEntry': {
        if (!entryId || typeof entryId !== 'string' || entryId.length > 80) {
          return res.status(400).json({ error: 'Valid audit entry id is required.' });
        }
        const removed = await deleteAdminAuditEntry(db, entryId);
        if (!removed) {
          return res.status(404).json({ error: 'Audit entry was not found.' });
        }
        // The deletion itself is audited, so wiping the log still leaves a
        // trace that something was wiped.
        await writeAdminAudit({ actor: providedUser, action: 'deleteAuditEntry', target: 'audit-log', details: `Deleted audit entry ${entryId}.` });
        return res.status(200).json({ success: true, message: 'Deleted audit entry.' });
      }

      case 'clearUser':
      case 'delete': {
        {
          const targetError = requireTarget();
          if (targetError) return res.status(400).json(targetError);
        }
        
        // One batched delete (run with capped concurrency inside db.del)
        // instead of ~25 sequential round trips. Catch history is cleared
        // alongside it since the two are independent.
        //
        // Auto-Fish is user-owned state as well: license, level, XP, prestige,
        // running session, timers, counters, Treasury slots, target/stop
        // settings, trophy unlock and pending session loot. The wipe runs
        // under the same lock the session settler uses, so a session that is
        // mid-cast cannot write inventory or state back after the wipe.
        const autoFishUserKeys = Object.values(autoFishKeys(cleanTarget));
        const pondUserKeys = Object.values(pondKeys(cleanTarget));
        await withKeyLock(db, `autofish-settle:${cleanTarget}`, () => Promise.all([
          db.del(
            `fish:count:${cleanTarget}`,
            `fish:besttier:${cleanTarget}`,
            `fish:bestitem:${cleanTarget}`,
            `fish:rares:${cleanTarget}`,
            `shield_inventory_v2:${cleanTarget}`,
            `luck:${cleanTarget}`,
            `perm_luck:${cleanTarget}`,
            `temp_luck:${cleanTarget}`,
            `timeout:${cleanTarget}`,
            `cooldown:${cleanTarget}`,
            `shields:${cleanTarget}`,
            `shields_used:${cleanTarget}`,
            `game_vip:${cleanTarget}`,
            // Fishing-area progression is user-owned state too. Remove the
            // unlocked levels, selected area, and per-user area toggles so a
            // wiped account does not retain its old area progression.
            selectedAreaKey(cleanTarget),
            userAreasOffKey(cleanTarget),
            userDoubleOffKey(cleanTarget),
            ...AREA_IDS.map((areaId) => areaLevelKey(cleanTarget, areaId)),
            ...allShopKeys(cleanTarget),
            progressionKeys(cleanTarget).casts, progressionKeys(cleanTarget).treasury, progressionKeys(cleanTarget).unique,
            progressionKeys(cleanTarget).rare, progressionKeys(cleanTarget).legendary, progressionKeys(cleanTarget).godly, progressionKeys(cleanTarget).areas,
            progressionKeys(cleanTarget).rod, progressionKeys(cleanTarget).selectedBait, progressionKeys(cleanTarget).title,
            progressionKeys(cleanTarget).unlockedTitles, progressionKeys(cleanTarget).cosmetics, customTitlesKey(cleanTarget),
            ...['worm','minnow','rare','legend'].map((id) => `${progressionKeys(cleanTarget).baitPrefix}:${id}`),
            `fish_format:normal:${cleanTarget}`, `fish_format:double:${cleanTarget}`,
            ...['showChance','showLuck','showArea','showNew','showEvent','showBoost','showDoubleChance'].map((id) => `fish_format:${id}:${cleanTarget}`),
            ...autoFishUserKeys,
            ...pondUserKeys
          ),
          deleteUserCatchData(db, cleanTarget)
        ]));

                // Wipe the Twitch first-!fish onboarding state too. The reset marker
        // guarantees that the next normal !fish shows the welcome response
        // instead of performing a normal roll.
        await db.del(`${FIRST_FISH_TUTORIAL_KEY_PREFIX}${cleanTarget}`);
        await db.set(`${FIRST_FISH_TUTORIAL_RESET_PREFIX}${cleanTarget}`, '1');

await writeAdminAudit({ actor: providedUser, action: 'clearUser', target: cleanTarget, details: 'Wiped inventory, Fishdex history, normal perks, Pond itself, all Pond feature upgrades, all Pond Treasury perks, Pond stash/pending fish/tokens, fishing-area progression, Auto-Fish progress, rods, bait, titles, cosmetics, chat customisation, and user state.' });
        await writeUserFeedback(cleanTarget, { type: 'admin', subtype: 'account_wiped', title: 'Account data wiped by admin', message: `@${providedUser} wiped your inventory, Fishdex history, normal perks, Personal Pond and all Pond perks, fishing-area progression, Auto-Fish progress, rods, bait, titles, cosmetics, chat customisation, and player state.`, actor: providedUser, meta: { wiped: true } });
        return res.status(200).json({ 
          success: true, 
          message: `Data for @${cleanTarget} successfully wiped.` 
        });
      }

      case 'list-broadcaster-admins': {
        return res.status(200).json({ success: true, accounts: await listBroadcasterAdmins() });
      }

      case 'create-broadcaster-admin':
      case 'update-broadcaster-admin': {
        const channel = String(req.body?.channel || '').trim().toLowerCase().replace(/^@/, '');
        const twitchLogin = String(req.body?.twitchLogin || channel).trim().toLowerCase().replace(/^@/, '');
        const enabledValue = req.body?.enabled;
        const enabled = enabledValue === undefined ? true : !!enabledValue;
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!/^[a-z0-9_]{1,25}$/.test(channel) || !/^[a-z0-9_]{1,25}$/.test(twitchLogin)) {
          return res.status(400).json({ error: 'Enter valid Twitch usernames for the channel and account.' });
        }
        if (action === 'create-broadcaster-admin' && !password) {
          return res.status(400).json({ error: 'A password is required when creating a broadcaster Admin account.' });
        }
        try {
          const account = await saveBroadcasterAdmin({
            channel,
            twitchLogin,
            password,
            enabled,
            preservePassword: action === 'update-broadcaster-admin'
          });
          await writeAdminAudit({
            actor: providedUser,
            action: action === 'create-broadcaster-admin' ? 'createBroadcasterAdmin' : 'updateBroadcasterAdmin',
            target: channel,
            details: `${action === 'create-broadcaster-admin' ? 'Created' : 'Updated'} broadcaster Admin account for ${twitchLogin}. Enabled=${enabled}. Password changed=${!!password}.`
          });
          return res.status(200).json({ success: true, account });
        } catch (error) {
          return res.status(400).json({ error: error?.message || 'Could not save the broadcaster Admin account.' });
        }
      }

      case 'delete-broadcaster-admin': {
        const channel = String(req.body?.channel || '').trim().toLowerCase().replace(/^@/, '');
        if (!/^[a-z0-9_]{1,25}$/.test(channel)) {
          return res.status(400).json({ error: 'A valid Twitch broadcaster username is required.' });
        }
        await deleteBroadcasterAdmin(channel);
        await writeAdminAudit({ actor: providedUser, action: 'deleteBroadcasterAdmin', target: channel, details: `Removed broadcaster Admin access for ${channel}.` });
        return res.status(200).json({ success: true, channel });
      }

      case 'set-stream-cooldown': {
        // This action is intentionally behind the existing MasterAdmin session.
        // Broadcaster Admin sessions use a separate endpoint and cannot reach
        // /api/admin/action at all.
        if (!streamChannel || !/^[a-z0-9_]{1,25}$/.test(streamChannel)) {
          return res.status(400).json({ error: 'A valid Twitch broadcaster username is required.' });
        }
        if (!Number.isFinite(streamCooldown) || streamCooldown < 0 || streamCooldown > 86400) {
          return res.status(400).json({ error: 'Cooldown must be between 0 and 86400 seconds.' });
        }
        await db.set(`settings:cooldown:${streamChannel}`, Math.round(streamCooldown));
        const globalCooldownRaw = await db.get('settings:cooldown').catch(() => null);
        const parsedGlobalCooldown = globalCooldownRaw === null || globalCooldownRaw === undefined || String(globalCooldownRaw).trim() === '' ? NaN : Number(globalCooldownRaw);
        const systemDefaultCooldown = Number.isFinite(parsedGlobalCooldown) && parsedGlobalCooldown >= 0 ? Math.round(parsedGlobalCooldown) : 60;
        await writeAdminAudit({
          actor: providedUser,
          action: 'setStreamCooldown',
          target: streamChannel,
          details: Math.round(streamCooldown) > 0
            ? `Fishing cooldown for ${streamChannel} set to ${Math.round(streamCooldown)} seconds.`
            : `Fishing cooldown for ${streamChannel} set to system default (${systemDefaultCooldown} seconds).`
        });
        return res.status(200).json({
          success: true,
          channel: streamChannel,
          cooldown: Math.round(streamCooldown) > 0 ? Math.round(streamCooldown) : 0,
          systemDefaultCooldown
        });
      }

      case 'get-stream-cooldown': {
        if (!streamChannel || !/^[a-z0-9_]{1,25}$/.test(streamChannel)) {
          return res.status(400).json({ error: 'A valid Twitch broadcaster username is required.' });
        }
        const [raw, globalRaw] = await Promise.all([
          db.get(`settings:cooldown:${streamChannel}`).catch(() => null),
          db.get('settings:cooldown').catch(() => null)
        ]);
        const parsed = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
        const global = globalRaw === null || globalRaw === undefined || String(globalRaw).trim() === '' ? NaN : Number(globalRaw);
        return res.status(200).json({
          success: true,
          channel: streamChannel,
          cooldown: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
          systemDefaultCooldown: Number.isFinite(global) && global >= 0 ? global : 60
        });
      }

      case 'broadcaster-overview': {
        const accounts = await listBroadcasterAdmins();
        const globalCooldownRaw = await db.get('settings:cooldown').catch(() => null);
        const parsedGlobalCooldown = globalCooldownRaw === null || globalCooldownRaw === undefined || String(globalCooldownRaw).trim() === '' ? NaN : Number(globalCooldownRaw);
        const systemDefaultCooldown = Number.isFinite(parsedGlobalCooldown) && parsedGlobalCooldown >= 0 ? Math.round(parsedGlobalCooldown) : 60;
        const rows = await Promise.all(accounts.map(async (account) => {
          const ch = account.channel;
          const [progress, denied, cooldownRaw] = await Promise.all([
            readChannelProgress(db, ch),
            readDeniedPermissions(db, ch),
            db.get(`settings:cooldown:${ch}`).catch(() => null)
          ]);
          const cooldown = Number(cooldownRaw);
          return {
            channel: ch,
            twitchLogin: account.twitchLogin,
            enabled: !!account.enabled,
            streamCooldown: Number.isFinite(cooldown) && cooldownRaw !== null && cooldown > 0 ? cooldown : null,
            systemDefaultCooldown,
            points: progress.points,
            available: progress.available,
            catches: progress.catches,
            denied
          };
        }));
        return res.status(200).json({ success: true, rows, permissions: BROADCASTER_PERMISSIONS });
      }

      case 'broadcaster-permission-set': {
        if (!streamChannel || !/^[a-z0-9_]{1,25}$/.test(streamChannel)) {
          return res.status(400).json({ error: 'A valid Twitch broadcaster username is required.' });
        }
        const permission = String(req.body?.permission || '');
        if (!Object.prototype.hasOwnProperty.call(BROADCASTER_PERMISSIONS, permission)) {
          return res.status(400).json({ error: 'Unknown broadcaster permission.' });
        }
        const denied = req.body?.denied === true || req.body?.denied === 'true';
        const list = await setPermissionDenied(db, streamChannel, permission, denied);
        await writeAdminAudit({
          actor: providedUser,
          action: 'setBroadcasterPermission',
          target: streamChannel,
          details: `${denied ? 'Denied' : 'Allowed'} "${BROADCASTER_PERMISSIONS[permission]}" for ${streamChannel}.`
        });
        return res.status(200).json({ success: true, channel: streamChannel, denied: list });
      }

      case 'broadcaster-debug': {
        if (!streamChannel || !/^[a-z0-9_]{1,25}$/.test(streamChannel)) {
          return res.status(400).json({ error: 'A valid Twitch broadcaster username is required.' });
        }
        const ch = streamChannel;
        const [progress, denied, cooldownRaw, simpleRaw, luckRaw, nameRaw, expiresRaw, ledgerRaw, recentCasts] = await Promise.all([
          readChannelProgress(db, ch),
          readDeniedPermissions(db, ch),
          db.get(`settings:cooldown:${ch}`).catch(() => null),
          db.get(`settings:simplechat:${ch}`).catch(() => null),
          db.get(`channel:event_luck:${ch}`).catch(() => null),
          db.get(`channel:event_name:${ch}`).catch(() => null),
          db.get(`channel:event_expires:${ch}`).catch(() => null),
          db.get(`test:channel-ledger:${ch}`).catch(() => null),
          readChannelLog(db, ch, 20)
        ]);
        // Viewers who switched this channel's upgrades off: count the stored "off" toggles.
        let perkOff = 0;
        let cursor = '0';
        let pages = 0;
        do {
          const [next, keys] = await db.scan(cursor, { match: `toggle:channelPerk:*:${ch}`, count: 200 });
          cursor = next;
          pages += 1;
          if (keys?.length) {
            const values = await db.mget(keys).catch(() => []);
            perkOff += values.filter((value) => value === 'off').length;
          }
        } while (cursor !== '0' && cursor !== 0 && pages < 25);
        let testData = null;
        try { testData = ledgerRaw ? JSON.parse(ledgerRaw) : null; } catch { testData = null; }
        const upgradeNames = Object.fromEntries(CHANNEL_UPGRADES.map((u) => [u.id, u.name]));
        return res.status(200).json({
          success: true,
          channel: ch,
          progress,
          upgradeNames,
          denied,
          cooldown: Number.isFinite(Number(cooldownRaw)) && cooldownRaw !== null ? Number(cooldownRaw) : 60,
          simpleChat: simpleRaw === 'on',
          channelEvent: luckRaw ? { multiplier: Number(luckRaw), name: nameRaw || '', expiresAt: expiresRaw ? Number(expiresRaw) : null } : null,
          viewersPerkOff: perkOff,
          recentCasts,
          testData
        });
      }

      case 'broadcaster-debug-clear-test': {
        if (!streamChannel || !/^[a-z0-9_]{1,25}$/.test(streamChannel)) {
          return res.status(400).json({ error: 'A valid Twitch broadcaster username is required.' });
        }
        const ch = streamChannel;
        const ledgerRaw = await db.get(`test:channel-ledger:${ch}`);
        if (!ledgerRaw) return res.status(400).json({ error: 'No test data is recorded for this channel.' });
        const ledger = JSON.parse(ledgerRaw);
        if (ledger.points) await db.incrby(`channel:points:${ch}`, -ledger.points);
        if (ledger.catches) await db.incrby(`channel:catches:${ch}`, -ledger.catches);
        const names = (ledger.names || []).filter((name) => /^test_fish_\d+$/.test(name));
        for (const name of names) await deleteUserData(name);
        await db.del(`test:channel-ledger:${ch}`);
        await writeAdminAudit({
          actor: providedUser,
          action: 'clearBroadcasterTestData',
          target: ch,
          details: `Removed ${names.length} test viewers and took back ${ledger.points || 0} points and ${ledger.catches || 0} catches from ${ch}.`
        });
        return res.status(200).json({ success: true, removed: names.length, points: ledger.points || 0, catches: ledger.catches || 0 });
      }

      default:
        return res.status(400).json({ error: `Unknown action type: ${action}` });
    }

  } catch (err) {
    console.error('[Admin Panel Error]:', err);
    return res.status(500).json({ error: 'Internal server error processing admin action.' });
  }
}
