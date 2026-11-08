import { db } from '../db.js';
import { getSessionUser } from '../session.js';
import { removeInventoryItems, readInventoryItems, isTreasuryItem, withKeyLock } from '../inventory.js';
import { FISHING_AREAS, AREA_IDS, areaLevelKey, selectedAreaKey, readUserAreaLevels, doubleCatchProgress, totalAreaProgress, areaEnabledKey, AREAS_ENABLED_KEY, DOUBLE_CATCH_ENABLED_KEY, isEnabledValue, userAreasOffKey, userDoubleOffKey } from '../areas.js';
import { getTreasuryBalance } from '../shop.js';
import { progressionKeys } from '../progression.js';
import { DEX_TIERS } from '../dexcatalog.js';

// Every Fish Index fish with the fishing areas it can be caught in. The map search
// uses this to show where a fish is found. Built once, from the same loot tables
// the areas use. Fish that only come from the normal table have an empty list.
const FISH_LOCATIONS = (() => {
  const areasByCatch = new Map();
  for (const area of Object.values(FISHING_AREAS)) {
    for (const [name, tier] of area.loot) {
      const key = `${name}|${tier}`;
      if (!areasByCatch.has(key)) areasByCatch.set(key, []);
      areasByCatch.get(key).push(area.id);
    }
  }
  const rows = [];
  const seen = new Set();
  for (const tier of DEX_TIERS) {
    if (tier.id === 'treasury') continue;
    for (const name of tier.items) {
      const key = `${name}|${tier.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([name, tier.name, areasByCatch.get(key) || []]);
    }
  }
  return rows;
})();

function userKeyFromSession(req) {
  const user = getSessionUser(req);
  return user ? user.login.toLowerCase().replace('@', '').trim() : null;
}

async function readConfiguredAreaPrices() {
  const defaults = Object.fromEntries(AREA_IDS.map((id) => [id, {
    unlockCost: FISHING_AREAS[id].unlockCost,
    levelCosts: [...FISHING_AREAS[id].levelCosts]
  }]));
  try {
    const raw = await db.get('config:area:prices');
    const parsed = raw ? JSON.parse(raw) : {};
    for (const id of AREA_IDS) {
      const source = parsed?.[id];
      const clean = (value, fallback) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000000 ? Number(value) : fallback;
      defaults[id] = {
        unlockCost: clean(source?.unlockCost, defaults[id].unlockCost),
        levelCosts: defaults[id].levelCosts.map((fallback, index) => clean(source?.levelCosts?.[index], fallback))
      };
    }
  } catch (_) { }
  return defaults;
}

async function readAreaState(userKey) {
  // These reads do not depend on each other, so issue them together. That is
  // one round trip of latency instead of a chain of them.
  const [levels, selectedRaw, userAreasOff, userDoubleOff, areasMaster, doubleMaster, ...areaFlags] = await Promise.all([
    readUserAreaLevels(db, userKey),
    db.get(selectedAreaKey(userKey)),
    db.get(userAreasOffKey(userKey)),
    db.get(userDoubleOffKey(userKey)),
    db.get(AREAS_ENABLED_KEY),
    db.get(DOUBLE_CATCH_ENABLED_KEY),
    ...AREA_IDS.map((id) => db.get(areaEnabledKey(id)))
  ]);
  let selected = selectedRaw;
  if (!FISHING_AREAS[selected]) selected = null;
  const areasEnabled = isEnabledValue(areasMaster);
  const doubleCatchEnabled = isEnabledValue(doubleMaster);
  const enabled = Object.fromEntries(AREA_IDS.map((id, i) => [id, areasEnabled && isEnabledValue(areaFlags[i])]));
  if (!selected || !enabled[selected] || levels[selected] < 1) selected = null;
  const progression = doubleCatchEnabled ? doubleCatchProgress(levels) : { ...doubleCatchProgress(levels), chance: 0, disabled: true };
  const userAreasEnabled = userAreasOff !== 'on';
  const userDoubleEnabled = userDoubleOff !== 'on';
  return { levels, selected, progression, areasEnabled, doubleCatchEnabled, enabled, userAreasEnabled, userDoubleEnabled };
}

export async function areasHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const userKey = userKeyFromSession(req);
  if (!userKey) return res.status(401).json({ error: 'Not logged in.' });
  if (!db) return res.status(500).json({ error: 'Database not configured.' });

  try {
    if (req.method === 'GET') {
      // Loot tables are only needed by the loot popup, so they are sent on request.
      const includeLoot = String(req.query?.include || '') === 'loot';
      const [state, items, configuredPrices] = await Promise.all([readAreaState(userKey), readInventoryItems(db, userKey), readConfiguredAreaPrices()]);
      const treasury = await getTreasuryBalance(db, userKey, items);
      return res.status(200).json({
        areas: AREA_IDS.map((id) => {
          const area = FISHING_AREAS[id];
          const level = state.levels[id];
          return {
            id, name: area.name, icon: area.icon, description: area.description,
            unlockCost: configuredPrices[id].unlockCost, levelCosts: configuredPrices[id].levelCosts,
            level, unlocked: level > 0, selected: state.selected === id,
            catchChance: level ? Math.round((0.08 + (level - 1) * 0.035) * 100) : 0,
            boost: area.boost,
            ...(includeLoot ? { loot: area.loot.map(([name, tier, weight]) => ({ name, tier, weight })) } : {}),
            lootCount: area.loot.length,
            enabled: state.areasEnabled && state.enabled[id]
          };
        }),
        selected: state.selected,
        active: state.userAreasEnabled ? state.selected : null,
        userAreasEnabled: state.userAreasEnabled,
        userDoubleEnabled: state.userDoubleEnabled,
        areasEnabled: state.areasEnabled,
        doubleCatchEnabled: state.doubleCatchEnabled,
        treasury: treasury.balance,
        doubleCatch: state.progression,
        totalAreaProgress: totalAreaProgress(state.levels),
        fish: FISH_LOCATIONS
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    const { action, areaId } = req.body || {};

    if (action === 'toggleAreas' || action === 'toggleDouble') {
      const on = req.body?.enabled === true;
      const key = action === 'toggleAreas' ? userAreasOffKey(userKey) : userDoubleOffKey(userKey);
      if (on) await db.del(key); else await db.set(key, 'on');
      const label = action === 'toggleAreas' ? 'Fishing areas' : 'Double Catch';
      return res.status(200).json({ success: true, enabled: on, message: `${label} ${on ? 'turned on' : 'turned off'}.` });
    }

    if (action === 'select' && !areaId) {
      await db.del(selectedAreaKey(userKey));
      return res.status(200).json({ success: true, selected: null, message: 'Fishing location reset to normal waters.' });
    }
    if (!FISHING_AREAS[areaId]) return res.status(400).json({ error: 'Unknown fishing area.' });

    if (action === 'select') {
      const state = await readAreaState(userKey);
      if (!state.areasEnabled || !state.enabled[areaId]) return res.status(400).json({ error: 'This fishing area is currently disabled.' });
      const level = state.levels[areaId] || 0;
      if (level < 1) return res.status(400).json({ error: 'Unlock this fishing area first.' });
      await db.set(selectedAreaKey(userKey), areaId);
      return res.status(200).json({ success: true, selected: areaId, message: `Fishing location changed to ${FISHING_AREAS[areaId].name}.` });
    }

    if (action !== 'buy' && action !== 'upgrade') return res.status(400).json({ error: 'Unknown area action.' });

    return await withKeyLock(db, `area-purchase:${userKey}`, async () => {
      const state = await readAreaState(userKey);
      if (!state.areasEnabled || !state.enabled[areaId]) return res.status(400).json({ error: 'This fishing area is currently disabled.' });
      const area = FISHING_AREAS[areaId];
      const key = areaLevelKey(userKey, areaId);
      const current = state.levels[areaId] || 0;
      if (action === 'buy' && current > 0) return res.status(400).json({ error: 'You already own this area.' });
      if (action === 'upgrade' && (current < 1 || current >= 5)) return res.status(400).json({ error: current >= 5 ? 'This area is already level 5.' : 'Unlock this area first.' });
      const configuredPrices = await readConfiguredAreaPrices();
      const cost = action === 'buy' ? configuredPrices[areaId].unlockCost : configuredPrices[areaId].levelCosts[current - 1];
      const items = await readInventoryItems(db, userKey);
      const { balance } = await getTreasuryBalance(db, userKey, items);
      if (balance < cost) return res.status(400).json({ error: `Not enough treasury items (need ${cost}, you have ${balance}).` });
      const removed = await removeInventoryItems(db, userKey, isTreasuryItem, cost, cost);
      if (removed.removed.length !== cost) return res.status(400).json({ error: 'Treasury inventory changed. Please try again.' });
      const next = action === 'buy' ? 1 : current + 1;
      await db.set(key, String(next));
      if (action === 'buy') await db.incr(progressionKeys(userKey).areas);
      if (action === 'buy' && !(await db.get(selectedAreaKey(userKey)))) await db.set(selectedAreaKey(userKey), areaId);
      // The purchase already has the current area levels in `state`; don't
      // perform another full read of every area flag just to build the response.
      // This used to add a noticeable extra round-trip after every unlock.
      const responseLevels = { ...state.levels, [areaId]: next };
      const responseProgression = state.doubleCatchEnabled
        ? doubleCatchProgress(responseLevels)
        : { ...doubleCatchProgress(responseLevels), chance: 0, disabled: true };
      return res.status(200).json({
        success: true,
        areaId,
        level: next,
        balance: balance - cost,
        doubleCatch: responseProgression,
        message: action === 'buy' ? `Unlocked ${area.name}.` : `${area.name} is now level ${next}.`
      });
    });
  } catch (error) {
    console.error('[Areas API]', error);
    return res.status(500).json({ error: 'Could not update fishing areas.' });
  }
}
