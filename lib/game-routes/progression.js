import { db } from '../db.js';
import { getSessionUser } from '../session.js';
import { readProgression, achievementSnapshot, RODS, BAITS, COSMETICS, baitFor, grantBait, progressionKeys, spendTreasuryForRod, getPricedGear } from '../progression.js';
import { getTreasuryBalance } from '../shop.js';
import { withKeyLock, isTreasuryItem, removeInventoryItems, addInventoryItems } from '../inventory.js';
import { TIERS } from '../tiers.js';
import { autoFishKeys } from '../autofish.js';

// One-time tutorial reward: 10 random Treasury items. Timeout items are left
// out because a reward must never be a penalty.
const TUTORIAL_REWARD_COUNT = 10;
const TUTORIAL_REWARD_EXCLUDED = /timeout/i;
function tutorialRewardKey(user) { return `tutorial:reward:${user}`; }
function rollTutorialReward() {
  const tier = TIERS.find((t) => t.id === 'treasury');
  const pool = (tier?.items || []).filter((name) => !TUTORIAL_REWARD_EXCLUDED.test(name));
  if (!tier || !pool.length) throw new Error('Treasury reward pool is empty.');
  return Array.from({ length: TUTORIAL_REWARD_COUNT }, () => `${pool[Math.floor(Math.random() * pool.length)]} [${tier.name}]`);
}

function userKey(req) {
  const user = getSessionUser(req);
  return user?.login ? String(user.login).toLowerCase().replace('@', '').trim() : null;
}

export async function progressionHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!db) return res.status(503).json({ error: 'Local database not connected.' });
  const user = userKey(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });

  try {
    if (req.method === 'GET') {
      const mode = String(req.query?.mode || 'all');
      if (mode === 'achievements') return res.status(200).json(await achievementSnapshot(user));
      const progression = await readProgression(user);
      const gear = await getPricedGear(db);
      const rares = await db.lrange(`fish:rares:${user}`, 0, -1);
      const { balance } = await getTreasuryBalance(db, user, rares);
      const snapshot = await achievementSnapshot(user);
      return res.status(200).json({ ...snapshot, rods: gear.rods, baits: gear.baits, cosmetics: COSMETICS, treasury: balance });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.action === 'claim-tutorial-reward') {
        // Server-side checks: the tutorial's last task is buying the Auto-Fishing
        // License, so the reward requires it. The claim is atomic and one-time.
        if ((await db.get(autoFishKeys(user).license)) !== 'true') {
          return res.status(400).json({ error: 'Unlock Auto-Fish first to claim the tutorial reward.' });
        }
        const won = await db.set(tutorialRewardKey(user), new Date().toISOString(), { nx: true });
        if (!won) return res.status(200).json({ success: true, alreadyClaimed: true, items: [] });
        try {
          const items = rollTutorialReward();
          await addInventoryItems(db, user, items);
          return res.status(200).json({ success: true, alreadyClaimed: false, items: items.map((i) => i.replace(/\s*\[TREASURY\]$/i, '')) });
        } catch (err) {
          await db.del(tutorialRewardKey(user)); // let the player retry
          throw err;
        }
      }
      if (body.action === 'select-bait') {
        const bait = baitFor(body.bait);
        if (!bait) return res.status(400).json({ error: 'Unknown bait.' });
        await db.set(progressionKeys(user).selectedBait, bait.id);
        return res.status(200).json({ success: true, bait });
      }
      if (body.action === 'buy-bait') {
        const bait = baitFor(body.bait);
        const packs = Math.max(1, Math.min(100, Number(body.packs) || 1));
        if (!bait || bait.id === 'worm') return res.status(400).json({ error: 'That bait does not need to be purchased.' });
        let pricedBait = bait;
        let cost = bait.cost * packs;
        const result = await withKeyLock(db, `progression-bait:${user}`, async () => {
          const pricedGear = await getPricedGear(db);
          pricedBait = pricedGear.baits.find((b) => b.id === bait.id) || bait;
          cost = pricedBait.cost * packs;
          const rares = await db.lrange(`fish:rares:${user}`, 0, -1);
          const { balance } = await getTreasuryBalance(db, user, rares);
          if (balance < cost) throw new Error(`Not enough Treasury. Need ${cost}, have ${balance}.`);
          const removed = await removeInventoryItems(db, user, isTreasuryItem, cost, cost);
          if (removed.removed.length !== cost) throw new Error('Treasury inventory changed. Please retry.');
          await grantBait(db, user, bait.id, packs);
          const left = (await db.lrange(`fish:rares:${user}`, 0, -1)).filter(isTreasuryItem).length;
          return { balance: left };
        });
        return res.status(200).json({ success: true, bait: pricedBait, ...result, message: `Bought ${packs} ${bait.name} pack${packs === 1 ? '' : 's'}.` });
      }
      if (body.action === 'upgrade-rod') {
        const result = await spendTreasuryForRod(user, body.rod);
        return res.status(200).json({ success: true, ...result });
      }
      if (body.action === 'equip-cosmetic') {
        const cosmetic = COSMETICS.find((c) => c.id === body.cosmetic);
        if (!cosmetic) return res.status(400).json({ error: 'Unknown cosmetic.' });
        const snap = await achievementSnapshot(user);
        const unlockedTitles = new Set(snap.titles || []);
        const allowed = cosmetic.unlock === 'Default' ||
          (cosmetic.unlock === '100 casts' && snap.progression.casts >= 100) ||
          (cosmetic.unlock === '500 casts' && snap.progression.casts >= 500) ||
          unlockedTitles.has(cosmetic.unlock);
        if (!allowed) return res.status(400).json({ error: 'That cosmetic is still locked.' });
        const current = snap.progression.cosmetics || {};
        await db.set(progressionKeys(user).cosmetics, JSON.stringify({ ...current, [cosmetic.category]: cosmetic.id }));
        return res.status(200).json({ success: true, cosmetic });
      }
      if (body.action === 'equip-title') {
        const snap = await achievementSnapshot(user);
        const wanted = String(body.title || '').trim();
        if (wanted && !snap.titles.includes(wanted)) return res.status(400).json({ error: 'That title is not unlocked.' });
        const titleKey = progressionKeys(user).title;
        await db.set(titleKey, wanted);
        const savedTitle = String((await db.get(titleKey)) || '');
        if (savedTitle !== wanted) throw new Error('Title could not be saved. Please retry.');
        return res.status(200).json({ success: true, title: savedTitle, equippedTitle: savedTitle });
      }
    }
    return res.status(400).json({ error: 'Unknown progression action.' });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Progression update failed.' });
  }
}
