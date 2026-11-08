import { db } from '../lib/db.js';
import { getSessionUser, checkBotSecret } from '../lib/session.js';
import { getAutoFishConfig, readAutoFishState } from '../lib/autofish.js';
import { TIERS } from '../lib/tiers.js';
import { addInventoryItems } from '../lib/inventory.js';
import {
  pondStatus, unlockPond, unlockPondFish, setPondFish, upgradePond, upgradePondFish, upgradePondFeature, upgradePondTreasuryPerk, setPondBaitSlots,
  collectPond, stashAction, convertInventoryFish, enablePondChat,
  POND_UNLOCK_PRESTIGE, pondKeys, getActivePondTreasuryPerks
} from '../lib/pond.js';
import { POND_TREASURY_MODE_ID, POND_TREASURY_MODE_LEVEL, treasuryPondPool } from '../lib/pond-extensions.js';

function cleanUser(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function sessionUser(req) {
  const user = getSessionUser(req);
  return user?.login ? cleanUser(user.login) : null;
}

async function prestigeFor(user) {
  const config = await getAutoFishConfig();
  const state = await readAutoFishState(user, config);
  return { prestige: Number(state.prestige) || 0, config, state };
}

function isTreasuryItemName(value) {
  // Treasury Pond excludes timeout/self-timeout loot just like !fish's
  // Treasury Only table. Never preserve those items as valid Pond catches.
  return treasuryPondPool(TIERS).includes(String(value));
}

async function treasuryModeActive(user) {
  const k = pondKeys(user);
  const level = Math.max(1, Math.min(5, Number(await db.get(k.level)) || 1));
  if (level < POND_TREASURY_MODE_LEVEL) return false;
  const perks = await getActivePondTreasuryPerks(user);
  return Number(perks.activeLevels?.[POND_TREASURY_MODE_ID]) > 0;
}

// pondStatus() already settles the timer. In Treasury Waters, never turn a
// previously spawned normal fish into a free Treasury catch: move legacy normal
// pending fish into the normal Pond stash, and leave only Treasury loot in the
// active Pond water.
async function settleTreasuryPending(user) {
  if (!(await treasuryModeActive(user))) return { active: false, pending: [] };
  const k = pondKeys(user);
  let pending = [];
  try { pending = JSON.parse((await db.get(k.pending)) || '[]'); } catch (_) { console.error('[api/pond.js:50] ignored error:', _?.message || _); }
  if (!Array.isArray(pending)) pending = [];
  const isNormalPondFish = (item) => TIERS.some((tier) =>
    !['treasury', 'unique', 'godly'].includes(tier.id) && (tier.items || []).includes(String(item))
  );
  const normalPending = pending.filter((item) => !isTreasuryItemName(item) && isNormalPondFish(item));
  if (normalPending.length) {
    let stash = [];
    try { stash = JSON.parse((await db.get(k.stash)) || '[]'); } catch (_) { console.error('[api/pond.js:58] ignored error:', _?.message || _); }
    if (!Array.isArray(stash)) stash = [];
    await db.set(k.stash, JSON.stringify([...stash, ...normalPending]));
  }
  const treasuryPending = pending.filter(isTreasuryItemName);
  if (normalPending.length || treasuryPending.length !== pending.length) {
    await db.set(k.pending, JSON.stringify(treasuryPending));
  }
  return { active: true, pending: treasuryPending };
}

async function treasuryCollect(user, prestige) {
  // One normal settlement per request.
  await pondStatus(user, prestige, { includeInventory: false });
  const active = await settleTreasuryPending(user);
  if (!active.active) return null;
  const k = pondKeys(user);
  if (!active.pending.length) return { success: true, count: 0, fish: [], treasuryMode: true, toInventory: true };
  const items = active.pending.slice();
  await addInventoryItems(db, user, items.map((item) => `${item} [TREASURY]`));
  const level = Math.max(1, Math.min(5, Number(await db.get(k.level)) || 1));
  const perks = await getActivePondTreasuryPerks(user);
  const deepCurrent = Number(perks.activeLevels?.deepCurrent) || 0;
  const intervalSeconds = Math.max(60, 180 - (level - 1) * 20) + (deepCurrent > 0 ? 60 : 0);
  await Promise.all([db.set(k.pending, '[]'), db.set(k.nextSpawn, String(Date.now() + intervalSeconds * 1000))]);
  return { success: true, count: items.length, fish: items, toInventory: true, treasuryMode: true };
}

async function statusWithTreasuryMode(user, prestige) {
  const status = await pondStatus(user, prestige);
  const mode = await settleTreasuryPending(user);
  if (!mode.active) return status;
  // Treasury-mode settlement may have moved normal fish that were already
  // pending before activation into the normal stash; return its fresh value.
  let stash = status.stash;
  try {
    const rawStash = await db.get(pondKeys(user).stash);
    const parsedStash = rawStash ? JSON.parse(rawStash) : [];
    if (Array.isArray(parsedStash)) stash = parsedStash;
  } catch (_) { console.error('[api/pond.js:97] ignored error:', _?.message || _); }
  return { ...status, stash, pending: mode.pending, treasuryMode: true, treasuryModeUnlockLevel: POND_TREASURY_MODE_LEVEL, treasuryModeActive: true };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!db) return res.status(500).json({ error: 'Database not configured.' });

  try {
    // Public website access uses the signed login session. Chat collection is
    // the only server-to-server path and requires the same BOT_SECRET gate as
    // the existing chat endpoints.
    if (req.method === 'GET') {
      const user = sessionUser(req);
      if (!user) return res.status(401).json({ error: 'Not logged in.' });
      const { prestige } = await prestigeFor(user);
      if (prestige < POND_UNLOCK_PRESTIGE) return res.status(200).json({ unlocked: false, prestige });
      if ((await db.get(`pond:unlocked:${user}`)) !== 'true') await unlockPond(user, prestige);
      return res.status(200).json(await statusWithTreasuryMode(user, prestige));
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    const body = req.body || {};
    const action = String(body.action || '').trim();

    if (action === 'chatCollect') {
      if (!checkBotSecret(req)) return res.status(200).send('Unauthorized: missing or wrong caller secret.');
      const user = cleanUser(body.user ?? body.sender ?? req.query?.user ?? req.query?.sender);
      if (!user) return res.status(200).send('Pond could not be collected: no username was provided.');
      const { prestige } = await prestigeFor(user);
      if (prestige < POND_CHAT_UNLOCK_PRESTIGE) return res.status(200).send('Pond collection unlocks at Prestige 2.');
      if (await db.get(`pond:chat_unlocked:${user}`) !== 'true') return res.status(200).send('Enable Pond chat collection in the Personal Pond panel first.');
      const treasuryResult = await treasuryCollect(user, prestige);
      if (treasuryResult) return res.status(200).send(treasuryResult.count ? `Treasury Pond collected, caught ${treasuryResult.count} Treasury item(s).` : 'Your Treasury Pond is empty right now.');
      const result = await collectPond(user, { toInventory: true });
      if (!result.success) return res.status(200).send(result.error);
      return res.status(200).send(result.count ? `Pond collected, caught ${result.count} fish.` : 'Your pond is empty right now.');
    }

    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in.' });
    const { prestige } = await prestigeFor(user);
    if (prestige < POND_UNLOCK_PRESTIGE) return res.status(400).json({ error: 'The Personal Pond unlocks at Prestige 1.' });
    if ((await db.get(`pond:unlocked:${user}`)) !== 'true') await unlockPond(user, prestige);

    if (action === 'collect') {
      const treasuryResult = await treasuryCollect(user, prestige);
      if (treasuryResult) return res.status(200).json(treasuryResult);
      return res.status(200).json(await collectPond(user));
    }
    if (action === 'stash') return res.status(200).json(await stashAction(user, String(body.mode || ''), body.items));
    if (action === 'convert') return res.status(200).json(await convertInventoryFish(user, body.item, body.count));
    if (action === 'unlockFish') return res.status(200).json(await unlockPondFish(user, prestige, body.fish));
    if (action === 'selectFish') return res.status(200).json(await setPondFish(user, prestige, body.fish));
    if (action === 'upgrade') return res.status(200).json(await upgradePond(user, prestige));
    if (action === 'upgradeFish') return res.status(200).json(await upgradePondFish(user, prestige, body.fish));
    if (action === 'upgradeFeature') return res.status(200).json(await upgradePondFeature(user, prestige, body.feature));
    if (action === 'upgradeTreasuryPerk') {
      if (String(body.perk || '') === POND_TREASURY_MODE_ID) {
        const pondLevel = Math.max(1, Math.min(5, Number(await db.get(pondKeys(user).level)) || 1));
        if (pondLevel < POND_TREASURY_MODE_LEVEL) return res.status(200).json({ success: false, error: `Treasury Waters unlocks at Pond Level ${POND_TREASURY_MODE_LEVEL}. Your Pond is Level ${pondLevel}.` });
      }
      return res.status(200).json(await upgradePondTreasuryPerk(user, prestige, body.perk));
    }
    if (action === 'setBaitSlots') return res.status(200).json(await setPondBaitSlots(user, prestige, body.baitSlots));
    if (action === 'enableChat') return res.status(200).json(await enablePondChat(user, prestige));
    if (action === 'unlock') return res.status(200).json(await unlockPond(user, prestige));
    return res.status(400).json({ error: 'Unknown pond action.' });
  } catch (error) {
    console.error('[Pond API]', error);
    if (req.method === 'POST' && req.body?.action === 'chatCollect') return res.status(200).send('Pond could not be collected right now. Try again.');
    return res.status(500).json({ error: error?.message || 'Pond request failed.' });
  }
}
