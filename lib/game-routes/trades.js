import crypto from 'crypto';
import { db } from '../db.js';
import { getSessionUser } from '../session.js';
import { TIERS } from '../tiers.js';
import { getUserMail, markUserMailRead } from '../user-mail.js';
import { applyItemEffects } from '../effects.js';
import { SHOP_ITEMS, getShopItemsWithPrices } from '../shop.js';
import { POND_TREASURY_PERKS, pondKeys } from '../pond.js';
import { getPrices, pondPerkPrice } from '../pricing.js';
import { addInventoryItems, isTreasuryItem, readInventoryItems, replaceInventoryItems } from '../inventory.js';
import {
  catchCountKey,
  ensureCatchHistoryCount,
  seedCatchCountsForItems,
  withKeyLock
} from '../inventory.js';

const OFFER_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_INBOX = 50;
const MAX_ITEMS_PER_SIDE = 100;

function cleanUser(value) {
  const user = String(value || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(user)) return null;
  return user;
}

function normalizeItem(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseItem(item) {
  const raw = String(item || '').trim();
  const match = raw.match(/^(.*?)\s*[\[(]([a-z]+)[\])]\s*$/i);
  return {
    raw,
    name: match ? match[1].trim() : raw,
    tier: match ? (match[2].toUpperCase() === 'UNIQUE' ? 'SECRET' : match[2].toUpperCase()) : 'COMMON'
  };
}

function summarizeInventory(rawList) {
  const counts = new Map();
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const parsed = parseItem(raw);
    const key = normalizeItem(parsed.raw);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { raw: parsed.raw, name: parsed.name, tier: parsed.tier.toLowerCase(), count: 1 });
  }
  const rank = { secret: 8, godly: 7, legendary: 6, treasury: 4, epic: 5, rare: 3, uncommon: 2, common: 1 };
  return [...counts.values()].sort((a, b) => (rank[b.tier] || 0) - (rank[a.tier] || 0) || a.name.localeCompare(b.name));
}

async function readInboxIds(userKey, kind) {
  const raw = await db.get(`trade:${kind}:${userKey}`);
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string').slice(-MAX_INBOX) : [];
  } catch (_) {
    return [];
  }
}

async function appendInboxId(userKey, kind, offerId) {
  return withKeyLock(db, `trade-inbox:${kind}:${userKey}`, async () => {
    const ids = await readInboxIds(userKey, kind);
    ids.push(offerId);
    const unique = [...new Set(ids)].slice(-MAX_INBOX);
    await db.set(`trade:${kind}:${userKey}`, JSON.stringify(unique));
  });
}

async function writeOffer(offer) {
  await db.set(`trade:offer:${offer.id}`, JSON.stringify(offer), { ex: OFFER_TTL_SECONDS });
}

async function readOffer(id) {
  const raw = await db.get(`trade:offer:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Validates one side of a trade. Returns { entries } on success or { error }
// with the actual reason, so the player is told what to fix instead of getting
// one generic "invalid" message for every failure. Entries that name the same
// item (ignoring case/spacing) are merged rather than rejected.
function sanitizeEntries(entries, sideLabel = 'offer') {
  if (!Array.isArray(entries)) return { error: `The list of ${sideLabel} is malformed. Clear the trade builder and select the items again.` };
  const merged = new Map();
  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.item !== 'string' || !entry.item.trim()) {
      return { error: `One item in the ${sideLabel} has no name. Clear the trade builder and select the items again.` };
    }
    const item = entry.item.trim();
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: `The quantity for "${item}" in the ${sideLabel} is not a whole number of at least 1.` };
    }
    total += quantity;
    if (total > MAX_ITEMS_PER_SIDE) {
      return { error: `A trade can include at most ${MAX_ITEMS_PER_SIDE} items per side, but the ${sideLabel} add up to more than that. Lower some quantities.` };
    }
    const key = normalizeItem(item);
    const existing = merged.get(key);
    if (existing) existing.quantity += quantity;
    else merged.set(key, { item, quantity });
  }
  return { entries: [...merged.values()] };
}

function countInventory(items) {
  const counts = new Map();
  for (const item of items || []) {
    const key = normalizeItem(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function hasRequestedItems(items, entries) {
  const counts = countInventory(items);
  return entries.every((entry) => (counts.get(normalizeItem(entry.item)) || 0) >= entry.quantity);
}

function removeEntries(items, entries) {
  const wanted = new Map(entries.map((entry) => [normalizeItem(entry.item), entry.quantity]));
  const removed = [];
  const remaining = [];
  for (const item of items || []) {
    const key = normalizeItem(item);
    const left = wanted.get(key) || 0;
    if (left > 0) {
      wanted.set(key, left - 1);
      removed.push(item);
    } else {
      remaining.push(item);
    }
  }
  const valid = [...wanted.values()].every((n) => n === 0);
  return valid ? { removed, remaining } : null;
}

function tierForItem(item) {
  const parsed = parseItem(item);
  return TIERS.find((tier) => tier.name === parsed.tier) || TIERS.find((tier) => tier.name === 'COMMON');
}

async function recalculateBestCatch(userKey, items) {
  if (!items.length) {
    await db.del(`fish:besttier:${userKey}`, `fish:bestitem:${userKey}`);
    return;
  }
  let bestTier = null;
  let bestItem = '';
  for (const item of items) {
    const tier = tierForItem(item);
    if (!tier || (bestTier && tier.rankScore <= bestTier.rankScore)) continue;
    bestTier = tier;
    const parsed = parseItem(item);
    bestItem = `${parsed.name} (${tier.name})`;
  }
  if (bestTier) {
    await Promise.all([
      db.set(`fish:besttier:${userKey}`, bestTier.rankScore),
      db.set(`fish:bestitem:${userKey}`, bestItem)
    ]);
  } else {
    await db.del(`fish:besttier:${userKey}`, `fish:bestitem:${userKey}`);
  }
}

async function markDiscoveryForReceived(userKey, items) {
  const counts = countInventory(items);
  await Promise.all([...counts].map(async ([item, count]) => {
    // A trade can add a fish to the Fishdex, but it never takes away an
    // existing lifetime discovery. Only seed a missing history key.
    await ensureCatchHistoryCount(db, userKey, item, 1);
  }));
}

async function applyReceivedEffects(userKey, items) {
  // Trading moves an item; it should not replay catch-only side effects such as
  // Soggyboot/Seamine timeouts. Perk-granting fish are the exception because
  // their normal catch effect is the player's persistent/timed luck ownership.
  for (const [item, count] of countInventory(items)) {
    const lower = item.toLowerCase();
    if (lower.includes('vipfish')) {
      await db.set(`game_vip:${userKey}`, 'true');
      await db.set(`toggle:vip:${userKey}`, 'on');
    }
    if (lower.includes('1.5x luck')) {
      await db.set(`perm_luck:${userKey}`, 'true');
      await db.set(`toggle:perm:${userKey}`, 'on');
    }
    if (lower.includes('2x luck')) {
      const key = `temp_luck:${userKey}`;
      const existing = await db.get(key);
      if (!existing) await db.set(key, 'true', { ex: 600 });
      await db.set(`toggle:temp:${userKey}`, 'on');
    }
  }
}


async function readGiftIds(userKey, kind) {
  const raw = await db.get(`perk-gift:${kind}:${userKey}`);
  if (!raw) return [];
  try { const ids = JSON.parse(raw); return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string').slice(-MAX_INBOX) : []; } catch (_) { return []; }
}

async function appendGiftId(userKey, kind, giftId) {
  return withKeyLock(db, `perk-gift-inbox:${kind}:${userKey}`, async () => {
    const ids = await readGiftIds(userKey, kind);
    ids.push(giftId);
    await db.set(`perk-gift:${kind}:${userKey}`, JSON.stringify([...new Set(ids)].slice(-MAX_INBOX)));
  });
}

async function readGift(id) {
  const raw = await db.get(`perk-gift:offer:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function giftPublic(gift) {
  return {
    id: gift.id, from: gift.from, to: gift.to, perk: gift.perk, kind: gift.kind || 'shop', targetLevel: gift.targetLevel || null,
    perkName: gift.perkName, rarity: gift.rarity || null, cost: gift.cost,
    status: gift.status, createdAt: gift.createdAt, expiresAt: gift.expiresAt,
    respondedAt: gift.respondedAt || null, failureReason: gift.failureReason || null
  };
}

async function refundGift(gift) {
  // Refunds are intentionally idempotent. A browser can retry a decline/cancel
  // request, and expiry can race with a user action. Only the first refund is
  // allowed to put the reserved Treasury back into the sender's inventory.
  if (gift.refundedAt) return false;
  const treasury = Array.isArray(gift.reservedTreasuryItems) ? gift.reservedTreasuryItems : [];
  if (!treasury.length) {
    gift.refundedAt = Date.now();
    gift.reservedTreasuryItems = [];
    return true;
  }
  // Durable at-most-once marker. Written atomically (NX) BEFORE the Treasury
  // goes back, so a retried decline/cancel, an expiry racing a user action, or
  // a crash after the refund but before the gift record was saved can never
  // return the same reserved Treasury twice.
  const marker = `perk-gift:refunded:${gift.id}`;
  const won = await db.set(marker, String(Date.now()), { nx: true, ex: OFFER_TTL_SECONDS + 3600 });
  if (!won) {
    gift.refundedAt = gift.refundedAt || Date.now();
    gift.reservedTreasuryItems = [];
    return false;
  }
  try {
    await addInventoryItems(db, gift.from, treasury);
  } catch (error) {
    // Nothing was returned, so release the marker and let a retry refund.
    try { await db.del(marker); } catch (_) { console.error('[lib/game-routes/trades.js:263] ignored error:', _?.message || _); }
    throw error;
  }
  gift.refundedAt = Date.now();
  gift.reservedTreasuryItems = [];
  return true;
}

async function saveGift(gift) {
  // Small retry so a transient database hiccup cannot leave a finished gift
  // stuck as "pending" (which could later be refunded on top of a grant).
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await db.set(`perk-gift:offer:${gift.id}`, JSON.stringify(gift), { ex: OFFER_TTL_SECONDS }); return; }
    catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); }
  }
  throw lastError;
}

// Expires a pending gift under the same per-gift lock as accept/decline/cancel,
// so listing the mailbox can never race a response and refund twice.
async function expireGiftIfDue(giftId) {
  return withKeyLock(db, `perk-gift-offer:${giftId}`, async () => {
    const gift = await readGift(giftId);
    if (!gift) return null;
    if (gift.status === 'pending' && Date.now() >= gift.expiresAt) {
      gift.status = 'expired'; gift.respondedAt = Date.now();
      await refundGift(gift);
      await saveGift(gift);
    }
    return gift;
  });
}

function parseJsonObject(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) { return {}; }
}

async function getPondGiftInfo(to, perk) {
  const cfg = POND_TREASURY_PERKS[perk];
  if (!cfg) return null;
  const keys = pondKeys(to);
  if (await db.get(keys.unlocked) !== 'true') {
    return { valid: false, owned: false, error: `@${to} has not unlocked the Personal Pond yet.` };
  }
  const currentState = parseJsonObject(await db.get(keys.treasuryPerks));
  const current = Math.max(0, Math.min(cfg.max, Number(currentState[perk]) || 0));
  if (current >= cfg.max) return { valid: false, owned: true, error: `@${to} already has ${cfg.label} at max level.` };
  return {
    valid: true, owned: false, kind: 'pond',
    level: current + 1, cost: pondPerkPrice(await getPrices(db), perk, current, cfg.costs[current]),
    name: cfg.label, cfg
  };
}

async function checkGiftRecipientOwnership(to, perk) {
  const pondInfo = await getPondGiftInfo(to, perk);
  if (pondInfo) return pondInfo;

  const pricedShop = await getShopItemsWithPrices(db);
  const item = Object.prototype.hasOwnProperty.call(pricedShop, perk) ? pricedShop[perk] : null;
  if (!item) return { valid: false, error: 'Choose a valid shop perk to gift.' };

  const key = `${item.key}:${to}`;
  const existing = await db.get(key);
  if (item.ttl) {
    const ttl = Number(await db.ttl(key));
    const paused = perk === 'rarityBoost' ? await db.get(`paused_shop_rarity_boost:${to}`) : null;
    if ((existing && ttl > 0) || paused) {
      return { valid: false, owned: true, error: `${item.name} is already active or paused for @${to}.` };
    }
  } else if (existing) {
    return { valid: false, owned: true, error: `@${to} already owns ${item.name}.` };
  }

  return { valid: true, owned: false, kind: 'shop', name: item.name, cost: Number(item.cost) || 0 };
}

async function grantGiftPerk(gift) {
  const pondCfg = POND_TREASURY_PERKS[gift.perk];
  if (pondCfg) {
    return withKeyLock(db, `shop-purchase:${gift.to}`, async () => {
      const keys = pondKeys(gift.to);
      if (await db.get(keys.unlocked) !== 'true') throw new Error('The recipient has not unlocked the Personal Pond.');
      const state = parseJsonObject(await db.get(keys.treasuryPerks));
      const current = Math.max(0, Math.min(pondCfg.max, Number(state[gift.perk]) || 0));
      if (current >= pondCfg.max) throw new Error(`The recipient already has ${pondCfg.label} at max level.`);
      state[gift.perk] = current + 1;
      await db.set(keys.treasuryPerks, JSON.stringify(state));
    });
  }

  const item = SHOP_ITEMS[gift.perk];
  if (!item) throw new Error('Unknown gifted perk.');
  const key = `${item.key}:${gift.to}`;
  const existing = await db.get(key);
  const paused = gift.perk === 'rarityBoost' ? await db.get(`paused_shop_rarity_boost:${gift.to}`) : null;
  if (item.ttl && ((existing && Number(await db.ttl(key)) > 0) || paused)) throw new Error(`${gift.perkName} is already active or paused for the recipient.`);
  if (!item.ttl && existing) throw new Error(`The recipient already owns ${gift.perkName}.`);
  if (item.ttl) {
    const ttl = Math.max(1, Math.ceil((gift.expiresAt - Date.now()) / 1000));
    if (gift.perk === 'rarityBoost') {
      await db.set(key, gift.rarity || 'rare', { ex: Math.min(item.ttl, ttl) });
      await db.set(`toggle:rarityBoost:${gift.to}`, 'on');
    } else {
      await db.set(key, 'true', { ex: Math.min(item.ttl, ttl) });
    }
  } else {
    await db.set(key, 'true', { nx: true });
  }
}

async function respondToGift(userKey, giftId, decision) {
  return withKeyLock(db, `perk-gift-offer:${giftId}`, async () => {
    const gift = await readGift(giftId);
    if (!gift) return { status: 404, body: { error: 'That perk gift no longer exists.' } };
    const now = Date.now();
    if (gift.status !== 'pending') return { status: 409, body: { error: `That perk gift is already ${gift.status}.`, gift: giftPublic(gift) } };
    if (now >= gift.expiresAt) {
      gift.status = 'expired'; gift.respondedAt = now; await refundGift(gift); await db.set(`perk-gift:offer:${gift.id}`, JSON.stringify(gift), { ex: OFFER_TTL_SECONDS });
      return { status: 410, body: { error: 'That perk gift has expired.', gift: giftPublic(gift) } };
    }
    if (decision === 'decline') {
      if (userKey !== gift.to) return { status: 403, body: { error: 'Only the recipient can decline this gift.' } };
      gift.status = 'declined'; gift.respondedAt = now; await refundGift(gift);
      await db.set(`perk-gift:offer:${gift.id}`, JSON.stringify(gift), { ex: OFFER_TTL_SECONDS });
      return { status: 200, body: { success: true, gift: giftPublic(gift) } };
    }
    if (decision === 'cancel') {
      if (userKey !== gift.from) return { status: 403, body: { error: 'Only the sender can cancel this gift.' } };
      gift.status = 'cancelled'; gift.respondedAt = now; await refundGift(gift);
      await db.set(`perk-gift:offer:${gift.id}`, JSON.stringify(gift), { ex: OFFER_TTL_SECONDS });
      return { status: 200, body: { success: true, gift: giftPublic(gift) } };
    }
    if (decision !== 'accept') return { status: 400, body: { error: 'Unknown perk gift response.' } };
    if (userKey !== gift.to) return { status: 403, body: { error: 'Only the recipient can accept this gift.' } };
    try {
      await grantGiftPerk(gift);
    } catch (error) {
      gift.status = 'failed'; gift.failureReason = error?.message || 'Could not grant the perk.'; gift.respondedAt = Date.now();
      await refundGift(gift);
      await saveGift(gift);
      return { status: 409, body: { error: gift.failureReason, gift: giftPublic(gift) } };
    }
    // The perk is granted. From here on the Treasury must stay spent, so a
    // failure while saving the status is never allowed to trigger a refund.
    gift.status = 'accepted'; gift.respondedAt = Date.now();
    try { await saveGift(gift); } catch (error) { console.error('Could not save accepted perk gift:', error); }
    return { status: 200, body: { success: true, gift: giftPublic(gift), message: `${gift.perkName} was added to your perks for free.` } };
  });
}

// Mail text depends on the current status, so the other player is told what
// actually happened (for example that the sender withdrew a gift) instead of
// the original "is gifting you..." wording staying forever.
function giftMailTexts(gift, userKey) {
  const incoming = gift.to === userKey;
  const from = `@${gift.from}`; const to = `@${gift.to}`;
  const perk = gift.perkName; const cost = gift.cost;
  switch (gift.status) {
    case 'cancelled':
      return incoming
        ? { title: `Gift withdrawn by ${from}`, message: `${from} withdrew the gift of ${perk}. You did not receive it and there is nothing to accept anymore.` }
        : { title: `Perk gift to ${to}`, message: `You withdrew the gift of ${perk} to ${to}. Your ${cost} Treasury was returned.` };
    case 'declined':
      return incoming
        ? { title: `Perk gift from ${from}`, message: `You declined the gift of ${perk} from ${from}.` }
        : { title: `Perk gift to ${to}`, message: `${to} declined the gift of ${perk}. Your ${cost} Treasury was returned.` };
    case 'expired':
      return incoming
        ? { title: `Perk gift from ${from}`, message: `The gift of ${perk} from ${from} expired before you answered.` }
        : { title: `Perk gift to ${to}`, message: `Your gift of ${perk} to ${to} expired. Your ${cost} Treasury was returned.` };
    case 'accepted':
      return incoming
        ? { title: `Perk gift from ${from}`, message: `${perk} from ${from} was added to your perks for free.` }
        : { title: `Perk gift to ${to}`, message: `${to} accepted your gift of ${perk}.` };
    case 'failed':
      return incoming
        ? { title: `Perk gift from ${from}`, message: `${perk} from ${from} could not be added to your perks.` }
        : { title: `Perk gift to ${to}`, message: `Your gift of ${perk} to ${to} could not be delivered. Your ${cost} Treasury was returned.` };
    default:
      return incoming
        ? { title: `Perk gift from ${from}`, message: `${from} is gifting you ${perk} for free.` }
        : { title: `Perk gift to ${to}`, message: `You sent ${perk} to ${to}.` };
  }
}

function offerMailTexts(offer, userKey) {
  const incoming = offer.to === userKey;
  const from = `@${offer.from}`; const to = `@${offer.to}`;
  if (offer.status === 'cancelled') {
    return incoming
      ? { title: `Trade request withdrawn by ${from}`, message: `${from} withdrew the trade request. Nothing was traded.` }
      : { title: `Trade request to ${to}`, message: `You withdrew your trade request to ${to}.` };
  }
  return {
    title: incoming ? `Trade request from ${from}` : `Trade request to ${to}`,
    message: incoming ? `${from} wants to trade with you.` : `Trade request sent to ${to}.`
  };
}

function offerPublic(offer) {
  return {
    id: offer.id,
    from: offer.from,
    to: offer.to,
    give: offer.give,
    receive: offer.receive,
    status: offer.status,
    createdAt: offer.createdAt,
    expiresAt: offer.expiresAt,
    respondedAt: offer.respondedAt || null,
    failureReason: offer.failureReason || null
  };
}

async function getTradeInventories(userKey, partner) {
  const [ownRaw, partnerRaw] = await Promise.all([
    db.lrange(`fish:rares:${userKey}`, 0, -1),
    db.lrange(`fish:rares:${partner}`, 0, -1)
  ]);
  return {
    self: { username: userKey, items: summarizeInventory(ownRaw) },
    partner: { username: partner, items: summarizeInventory(partnerRaw) }
  };
}

async function respondToOffer(userKey, offerId, decision) {
  const offerKey = `trade:offer:${offerId}`;
  return withKeyLock(db, `trade-offer:${offerId}`, async () => {
    const offer = await readOffer(offerId);
    if (!offer) return { status: 404, body: { error: 'That trade request no longer exists.' } };

    const now = Date.now();
    if (offer.status !== 'pending') {
      return { status: 409, body: { error: `That trade is already ${offer.status}.`, offer: offerPublic(offer) } };
    }
    if (now >= offer.expiresAt) {
      offer.status = 'expired';
      offer.respondedAt = now;
      await writeOffer(offer);
      return { status: 410, body: { error: 'That trade request has expired.', offer: offerPublic(offer) } };
    }

    if (decision === 'decline') {
      if (userKey !== offer.to) return { status: 403, body: { error: 'Only the recipient can decline this trade.' } };
      offer.status = 'declined';
      offer.respondedAt = now;
      await writeOffer(offer);
      return { status: 200, body: { success: true, offer: offerPublic(offer) } };
    }

    if (decision === 'cancel') {
      if (userKey !== offer.from) return { status: 403, body: { error: 'Only the sender can cancel this trade.' } };
      offer.status = 'cancelled';
      offer.respondedAt = now;
      await writeOffer(offer);
      return { status: 200, body: { success: true, offer: offerPublic(offer) } };
    }

    if (decision !== 'accept') return { status: 400, body: { error: 'Unknown trade response.' } };
    if (userKey !== offer.to) return { status: 403, body: { error: 'Only the recipient can accept this trade.' } };

    const first = offer.from < offer.to ? offer.from : offer.to;
    const second = first === offer.from ? offer.to : offer.from;

    return withKeyLock(db, `inventory:${first}`, async () => withKeyLock(db, `inventory:${second}`, async () => {
      const [fromItems, toItems] = await Promise.all([
        db.lrange(`fish:rares:${offer.from}`, 0, -1),
        db.lrange(`fish:rares:${offer.to}`, 0, -1)
      ]);

      if (!hasRequestedItems(fromItems, offer.give)) {
        offer.status = 'failed';
        offer.failureReason = `@${offer.from} no longer has all of the items they offered.`;
        offer.respondedAt = Date.now();
        await writeOffer(offer);
        return { status: 409, body: { error: offer.failureReason, offer: offerPublic(offer) } };
      }
      if (!hasRequestedItems(toItems, offer.receive)) {
        offer.status = 'failed';
        offer.failureReason = `@${offer.to} no longer has all of the items requested in this trade.`;
        offer.respondedAt = Date.now();
        await writeOffer(offer);
        return { status: 409, body: { error: offer.failureReason, offer: offerPublic(offer) } };
      }

      const fromChange = removeEntries(fromItems, offer.give);
      const toChange = removeEntries(toItems, offer.receive);
      if (!fromChange || !toChange) {
        offer.status = 'failed';
        offer.failureReason = 'Inventory changed while the trade was being accepted. Please send a new offer.';
        offer.respondedAt = Date.now();
        await writeOffer(offer);
        return { status: 409, body: { error: offer.failureReason, offer: offerPublic(offer) } };
      }

      // Preserve lifetime Fishdex discoveries BEFORE anything leaves an
      // inventory. The receiver gets a discovery entry for any fish they have
      // never logged before; an existing count is never reduced.
      await Promise.all([
        seedCatchCountsForItems(db, offer.from, fromItems),
        seedCatchCountsForItems(db, offer.to, toItems),
        markDiscoveryForReceived(offer.to, offer.give),
        markDiscoveryForReceived(offer.from, offer.receive)
      ]);

      // Promote both pre-trade inventories to lifetime Fishdex history before
      // any inventory entries leave. Trading away the only copy must never
      // erase a discovery.
      await Promise.all([
        seedCatchCountsForItems(db, offer.from, fromItems),
        seedCatchCountsForItems(db, offer.to, toItems)
      ]);

      const nextFrom = [...fromChange.remaining, ...offer.receive.flatMap((entry) => Array(entry.quantity).fill(entry.item))];
      const nextTo = [...toChange.remaining, ...offer.give.flatMap((entry) => Array(entry.quantity).fill(entry.item))];
      try {
        await Promise.all([
          replaceInventoryItems(db, offer.from, nextFrom),
          replaceInventoryItems(db, offer.to, nextTo)
        ]);
      } catch (transferError) {
        // The KV layer has no cross-key transaction primitive. Both inventory
        // locks are held here, so a failed second write can be rolled back to
        // the exact snapshots we just verified instead of leaving a one-sided
        // trade behind.
        try {
          await Promise.all([
            replaceInventoryItems(db, offer.from, fromItems),
            replaceInventoryItems(db, offer.to, toItems)
          ]);
        } catch (rollbackError) {
          console.error('Trade rollback failed:', rollbackError);
        }
        throw transferError;
      }

      const [finalFrom, finalTo] = await Promise.all([
        db.lrange(`fish:rares:${offer.from}`, 0, -1),
        db.lrange(`fish:rares:${offer.to}`, 0, -1)
      ]);

      await Promise.all([
        recalculateBestCatch(offer.from, finalFrom),
        recalculateBestCatch(offer.to, finalTo),
        applyReceivedEffects(offer.from, offer.receive.flatMap((entry) => Array(entry.quantity).fill(entry.item))),
        applyReceivedEffects(offer.to, offer.give.flatMap((entry) => Array(entry.quantity).fill(entry.item)))
      ]);

      offer.status = 'accepted';
      offer.respondedAt = Date.now();
      await writeOffer(offer);
      return {
        status: 200,
        body: {
          success: true,
          offer: offerPublic(offer),
          message: 'Trade accepted. The inventories and Fishdex records have been updated.'
        }
      };
    }));
  });
}

async function forceTradeInventory(db, userKey) {
  // Trading always uses the authoritative live inventory. Do not trust
  // cached player/item snapshots because Treasury can change via Auto-Fish,
  // purchases, admin actions, or another completed trade.
  return (await readInventoryItems(db, userKey)).map(String);
}

export async function tradesHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!db) return res.status(500).json({ error: 'Database connection failed.' });

  const session = getSessionUser(req);
  if (!session) return res.status(401).json({ error: 'Not logged in.' });
  const userKey = cleanUser(session.login);
  if (!userKey) return res.status(401).json({ error: 'Invalid logged-in user.' });

  try {
    if (req.method === 'GET') {
      const action = String(req.query?.action || 'inbox').toLowerCase();

      if (action === 'inventories') {
        const partner = cleanUser(req.query?.partner);
        if (!partner || partner === userKey) return res.status(400).json({ error: 'Choose another Twitch username.' });
        return res.status(200).json({ success: true, ...(await getTradeInventories(userKey, partner)) });
      }

      if (action === 'inbox' || action === 'mail') {
        const [receivedIds, sentIds, giftReceivedIds, giftSentIds, feedback] = await Promise.all([
          readInboxIds(userKey, 'inbox'),
          readInboxIds(userKey, 'sent'),
          readGiftIds(userKey, 'inbox'),
          readGiftIds(userKey, 'sent'),
          getUserMail(db, userKey, 150)
        ]);
        const ids = [...new Set([...receivedIds, ...sentIds])];
        const giftIds = [...new Set([...giftReceivedIds, ...giftSentIds])];
        const [rawOffers, rawGifts, readRaw] = await Promise.all([
          ids.length ? db.mget(ids.map((id) => `trade:offer:${id}`)) : [],
          giftIds.length ? db.mget(giftIds.map((id) => `perk-gift:offer:${id}`)) : [],
          db.get(`user-mail-read:${userKey}`)
        ]);
        let readIds = [];
        try { const parsed = readRaw ? JSON.parse(readRaw) : []; if (Array.isArray(parsed)) readIds = parsed.filter((id) => typeof id === 'string'); } catch (_) { console.error('[lib/game-routes/trades.js:674] ignored error:', _?.message || _); }
        const readSet = new Set(readIds);
        const offers = [];
        for (let i = 0; i < ids.length; i++) {
          const raw = rawOffers?.[i];
          if (!raw) continue;
          try {
            const offer = JSON.parse(raw);
            if (offer && (offer.from === userKey || offer.to === userKey)) {
              if (offer.status === 'pending' && Date.now() >= offer.expiresAt) {
                offer.status = 'expired';
                offer.respondedAt = Date.now();
                await writeOffer(offer);
              }
              offers.push(offerPublic(offer));
            }
          } catch (_) { console.error('[lib/game-routes/trades.js:690] ignored error:', _?.message || _); }
        }
        offers.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
        const gifts = [];
        for (let i = 0; i < giftIds.length; i++) {
          const raw = rawGifts?.[i]; if (!raw) continue;
          try {
            const gift = JSON.parse(raw); if (!gift || (gift.from !== userKey && gift.to !== userKey)) continue;
            if (gift.status === 'pending' && Date.now() >= gift.expiresAt) {
              const settled = await expireGiftIfDue(gift.id);
              if (settled) Object.assign(gift, settled);
            }
            gifts.push(giftPublic(gift));
          } catch (_) { console.error('[lib/game-routes/trades.js:703] ignored error:', _?.message || _); }
        }
        const messages = [
          ...offers.map((offer) => ({
            id: `trade-${offer.id}`, read: readSet.has(`trade-${offer.id}`),
            type: 'trade', subtype: 'trade_request',
            ...offerMailTexts(offer, userKey),
            createdAt: offer.createdAt, status: offer.status, tradeOffer: offer
          })),
          ...gifts.map((gift) => ({
            id: `gift-${gift.id}`, read: readSet.has(`gift-${gift.id}`),
            type: 'perk', subtype: 'perk_gift',
            ...giftMailTexts(gift, userKey),
            createdAt: gift.createdAt, status: gift.status, perkGift: gift
          })),
          ...feedback.map((entry) => ({ ...entry, tradeOffer: null, read: !!entry.read }))
        ].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 200);
        return res.status(200).json({ success: true, offers: offers.slice(0, MAX_INBOX), messages });
      }

      return res.status(400).json({ error: 'Unknown trade action.' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    const body = req.body || {};
    const action = String(body.action || '').toLowerCase();

    if (action === 'create') {
      const to = cleanUser(body.to);
      if (!to || to === userKey) return res.status(400).json({ error: 'Choose another Twitch username.' });
      const giveCheck = sanitizeEntries(body.give || [], 'items you give');
      if (giveCheck.error) return res.status(400).json({ error: giveCheck.error });
      const receiveCheck = sanitizeEntries(body.receive || [], 'items you request');
      if (receiveCheck.error) return res.status(400).json({ error: receiveCheck.error });
      const give = giveCheck.entries;
      const receive = receiveCheck.entries;
      if (!give.length && !receive.length) {
        return res.status(400).json({ error: 'Your trade is empty. Add at least one fish or perk to what you give, or to what you request, then send it again.' });
      }

      const offerId = crypto.randomUUID();
      const createdAt = Date.now();
      const offer = {
        id: offerId,
        from: userKey,
        to,
        give,
        receive,
        status: 'pending',
        createdAt,
        expiresAt: createdAt + OFFER_TTL_SECONDS * 1000
      };

      // The sender's inventory is checked when the request is created, so a
      // bad/stale browser cannot create an offer for items they never owned.
      // NOTE: normal trades do not have a `perk`; that field belongs only to
      // the separate perk-gift flow below.
      const created = await withKeyLock(db, `inventory:${userKey}`, async () => {
        const items = await forceTradeInventory(db, userKey);
        if (!hasRequestedItems(items, give)) {
          return { ok: false, error: 'You no longer own all of the items in your offer.' };
        }
        await writeOffer(offer);
        return { ok: true };
      });
      if (!created.ok) return res.status(409).json({ error: created.error });

      await Promise.all([
        appendInboxId(to, 'inbox', offerId),
        appendInboxId(userKey, 'sent', offerId)
      ]);

      return res.status(201).json({ success: true, offer: offerPublic(offer) });
    }


    if (action === 'checkgiftperk') {
      const to = cleanUser(body.to);
      const perk = typeof body.perk === 'string' ? body.perk : '';
      if (!to || to === userKey) return res.status(400).json({ error: 'Choose another Twitch username.' });
      const check = await checkGiftRecipientOwnership(to, perk);
      if (!check.valid) return res.status(409).json({ owned: !!check.owned, error: check.error });
      return res.status(200).json({ success: true, owned: false, message: `@${to} can receive this perk.`, ...(check.kind === 'pond' ? { targetLevel: check.level, cost: check.cost } : {}) });
    }

    if (action === 'giftperk') {
      const to = cleanUser(body.to);
      const perk = typeof body.perk === 'string' ? body.perk : '';
      if (!to || to === userKey) return res.status(400).json({ error: 'Choose another Twitch username.' });
      const pricedShop = await getShopItemsWithPrices(db);
      const pondGift = await getPondGiftInfo(to, perk);
      const item = pondGift ? { key: null, name: pondGift.name, cost: pondGift.cost, ttl: 0 } : (Object.prototype.hasOwnProperty.call(pricedShop, perk) ? pricedShop[perk] : null);
      const rarity = perk === 'rarityBoost' ? String(body.rarity || '').toLowerCase() : null;
      if (!item) return res.status(400).json({ error: 'Choose a valid shop perk to gift.' });
      if (pondGift && !pondGift.valid) return res.status(409).json({ owned: !!pondGift.owned, error: pondGift.error });
      if (perk === 'rarityBoost' && !['godly','legendary','epic','rare','uncommon'].includes(rarity)) return res.status(400).json({ error: 'Pick a valid rarity for the gifted boost.' });
      // One retry-safe request per sender at a time: a double click, a retry
      // after a timeout, or two tabs all queue behind this lock, and the
      // second one then finds the first one's pending gift and returns it
      // instead of charging Treasury again.
      const created = await withKeyLock(db, `inventory:${userKey}`, async () => {
        const existingIds = await readGiftIds(userKey, 'sent');
        if (existingIds.length) {
          const existingRaw = await db.mget(existingIds.map((id) => `perk-gift:offer:${id}`));
          for (const raw of existingRaw || []) {
            if (!raw) continue;
            try {
              const existing = JSON.parse(raw);
              if (existing && existing.status === 'pending' && existing.from === userKey && existing.to === to && existing.perk === perk && (existing.rarity || null) === (rarity || null) && Date.now() < Number(existing.expiresAt || 0)) {
                const currentItems = await forceTradeInventory(db, userKey);
                return { ok: true, duplicate: true, gift: existing, balance: currentItems.filter(isTreasuryItem).length };
              }
            } catch (_) { console.error('[lib/game-routes/trades.js:815] ignored error:', _?.message || _); }
          }
        }

        // Authoritative recipient check, right before Treasury is taken.
        const recipientCheck = await checkGiftRecipientOwnership(to, perk);
        if (!recipientCheck.valid) return { ok: false, error: recipientCheck.error, owned: !!recipientCheck.owned };

        const giftId = crypto.randomUUID();
        const createdAt = Date.now();
        if (perk === 'fishermansFortune') return res.status(400).json({ error: "Fisherman's Fortune cannot be gifted." });
        const gift = { id: giftId, from: userKey, to, perk, kind: pondGift ? 'pond' : 'shop', targetLevel: pondGift?.level || null, perkName: item.name, rarity, cost: item.cost, status: 'pending', createdAt, expiresAt: createdAt + OFFER_TTL_SECONDS * 1000 };
        const items = await forceTradeInventory(db, userKey);
        const treasuryItems = items.filter(isTreasuryItem);
        if (treasuryItems.length < item.cost) return { ok: false, error: `Not enough treasury items (need ${item.cost}, you have ${treasuryItems.length}).` };
        const reserved = treasuryItems.slice(0, item.cost);
        // Group identical Treasury names into one entry with a real quantity.
        // removeEntries() keys entries by item name, so passing 80 separate
        // {quantity: 1} entries for the same name would only remove ONE copy
        // while all 80 were reserved (and later refunded): free Treasury.
        const grouped = new Map();
        for (const entry of reserved) {
          const key = normalizeItem(entry);
          const existing = grouped.get(key);
          if (existing) existing.quantity += 1;
          else grouped.set(key, { item: entry, quantity: 1 });
        }
        const change = removeEntries(items, [...grouped.values()]);
        if (!change || change.removed.length !== reserved.length || change.remaining.length !== items.length - reserved.length) {
          return { ok: false, error: 'Treasury inventory changed. Please try again.' };
        }

        // Reserve the exact Treasury catches with the request so decline /
        // cancel / expiry can return them; an accepted gift keeps them spent.
        gift.reservedTreasuryItems = reserved;

        // Order matters for safety: the gift record (which holds the reserved
        // items) is written FIRST, then the inventory is reduced. If the
        // inventory write fails, the gift is deleted again, so a failure at
        // any point can never leave Treasury both spent and un-refundable.
        await db.set(`perk-gift:offer:${giftId}`, JSON.stringify(gift), { ex: OFFER_TTL_SECONDS });
        try {
          // Treasury catches are still Fishdex discoveries; spending them
          // must not erase the sender's lifetime discovery record.
          await seedCatchCountsForItems(db, userKey, items);
          await replaceInventoryItems(db, userKey, change.remaining);
        } catch (error) {
          try { await db.del(`perk-gift:offer:${giftId}`); } catch (_) { console.error('[lib/game-routes/trades.js:862] ignored error:', _?.message || _); }
          throw error;
        }
        try {
          // Inside the lock, so the dedupe list above always sees this gift.
          await Promise.all([appendGiftId(to, 'inbox', giftId), appendGiftId(userKey, 'sent', giftId)]);
        } catch (error) {
          // Could not deliver the request: give the Treasury back once.
          gift.status = 'failed'; gift.failureReason = 'Could not deliver the gift request.'; gift.respondedAt = Date.now();
          try { await refundGift(gift); await saveGift(gift); } catch (refundError) { console.error('Gift rollback failed:', refundError); }
          throw error;
        }
        return { ok: true, gift, balance: treasuryItems.length - item.cost };
      });
      if (!created.ok) return res.status(created.owned ? 409 : 400).json({ owned: !!created.owned, error: created.error });
      if (created.duplicate) {
        return res.status(200).json({ success: true, duplicate: true, gift: giftPublic(created.gift), balance: created.balance, message: `A gift request to @${to} is already pending.` });
      }
      const gift = created.gift;
      return res.status(201).json({ success: true, gift: giftPublic(gift), balance: created.balance, message: `Gift request sent to @${to}. ${item.cost} Treasury paid and held until they accept or decline.` });
    }

    if (action === 'respond') {
      const offerId = typeof body.offerId === 'string' ? body.offerId.trim() : '';
      if (!/^[0-9a-f-]{20,80}$/i.test(offerId)) return res.status(400).json({ error: 'Invalid trade request id.' });
      const decision = String(body.decision || '').toLowerCase();
      const result = await respondToOffer(userKey, offerId, decision);
      return res.status(result.status).json(result.body);
    }

    if (action === 'respondgift') {
      const giftId = typeof body.giftId === 'string' ? body.giftId.trim() : '';
      if (!/^[0-9a-f-]{20,80}$/i.test(giftId)) return res.status(400).json({ error: 'Invalid perk gift id.' });
      const decision = String(body.decision || '').toLowerCase();
      const result = await respondToGift(userKey, giftId, decision);
      return res.status(result.status).json(result.body);
    }

    if (action === 'markread') {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      await markUserMailRead(db, userKey, ids);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown trade action.' });
  } catch (error) {
    console.error('Trades API Error:', error);
    return res.status(500).json({ error: 'Trade request failed. Please try again.' });
  }
}
