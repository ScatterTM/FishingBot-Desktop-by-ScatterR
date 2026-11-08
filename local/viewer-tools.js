// Streamer tools for one viewer, used from the local Control Centre (Viewers tab).
// Every change goes through the helpers that chat commands and purchases already use.
// Perk effects are not triggered by these tools: they only change stored state.
import { db } from '../lib/db.js';
import { lookupFish } from '../lib/fishcatalog.js';
import { addInventoryItems, removeInventoryItems, readInventoryItems, recordCatch } from '../lib/inventory.js';
import { deleteUserData } from '../lib/delete-user.js';
import { autoFishKeys } from '../lib/autofish.js';
import { pondKeys } from '../lib/pond.js';
import { AREA_IDS, FISHING_AREAS, areaLevelKey } from '../lib/areas.js';
import { SHOP_ITEMS, shopKey } from '../lib/shop.js';

const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;
const MAX_QUANTITY = 99;
// Permanent shop perks only. Timed perks (rarity boost) are not granted by hand.
const PERMANENT_PERKS = ['luck125', 'cooldown', 'treasuryLuck', 'treasuryOnly', 'fishermansFortune'];
// Keys that hold credentials or sessions. They are never shown by the inspector.
const SECRET_KEY = /token|secret|refresh|password|hash|session|cookie|key_/i;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function cleanViewerLogin(value) {
  const login = String(value || '').trim().replace(/^@+/, '').toLowerCase();
  if (!LOGIN_PATTERN.test(login)) throw httpError(400, 'Enter a valid Twitch login (letters, numbers and underscores).');
  return login;
}

// Inventory entries are stored as "Fish name [Tier]". The base name is the fish without the tier.
function baseName(item) {
  return String(item || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim().toLowerCase();
}

function wholeQuantity(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) throw httpError(400, `Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
  return n;
}

export async function viewerToolsSummary(login) {
  const user = cleanViewerLogin(login);
  const auto = autoFishKeys(user);
  const pond = pondKeys(user);
  const [inventory, license, pondUnlocked, areaLevels, perkStates] = await Promise.all([
    readInventoryItems(db, user),
    db.get(auto.license),
    db.get(pond.unlocked),
    Promise.all(AREA_IDS.map(async (id) => [id, Math.max(0, parseInt(await db.get(areaLevelKey(user, id)), 10) || 0)])),
    Promise.all(PERMANENT_PERKS.map(async (perk) => [perk, (await db.get(shopKey(perk, user))) === 'true']))
  ]);
  return {
    user,
    fishInInventory: inventory.length,
    autoFishLicense: license === 'true',
    pondUnlocked: pondUnlocked === 'true',
    areas: areaLevels.map(([id, level]) => ({ id, name: FISHING_AREAS[id]?.name || id, level })),
    perks: Object.fromEntries(perkStates)
  };
}

// Read-only: lists the stored keys that belong to one viewer, with short previews. Credentials and
// sessions are filtered out, so this can be shared in a bug report without leaking secrets.
export async function viewerDebugKeys(login) {
  const user = cleanViewerLogin(login);
  const [, keys] = await db.scan('0', { match: '*' + user + '*' }).catch(() => ['0', []]);
  const owned = new RegExp('(^|:)' + user + '(:|$)', 'i');
  const rows = [];
  for (const key of (keys || []).filter((k) => owned.test(String(k)) && !SECRET_KEY.test(String(k)))) {
    if (rows.length >= 200) break;
    const list = await db.lrange(key).catch(() => null);
    if (Array.isArray(list) && list.length) {
      rows.push({ key, kind: 'list', size: list.length, preview: String(list[list.length - 1] ?? '').slice(0, 80) });
      continue;
    }
    const value = await db.get(key).catch(() => null);
    if (value !== null && value !== undefined) {
      rows.push({ key, kind: 'value', size: String(value).length, preview: String(value).slice(0, 80) });
    }
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return { user, count: rows.length, truncated: rows.length >= 200, rows };
}

export async function applyViewerTool(body = {}) {
  const user = cleanViewerLogin(body.login);
  const action = String(body.action || '');

  if (action === 'give-fish') {
    const found = lookupFish(String(body.fish || ''));
    if (!found) throw httpError(404, 'No fish with that name is in the loot table.');
    const count = wholeQuantity(body.quantity);
    const item = `${found.item} [${found.tier.name}]`;
    await addInventoryItems(db, user, Array(count).fill(item));
    for (let i = 0; i < count; i++) await recordCatch(db, user, item, 'forced');
    return { message: `Gave ${count} × ${found.item} to @${user}.` };
  }

  if (action === 'remove-fish') {
    const found = lookupFish(String(body.fish || ''));
    const wanted = baseName(found ? found.item : body.fish);
    if (!wanted) throw httpError(400, 'Choose a fish to remove.');
    const requested = wholeQuantity(body.quantity);
    // Never remove more copies than the viewer owns: the limit is the amount available, or 99.
    const owned = (await readInventoryItems(db, user)).filter((item) => baseName(item) === wanted).length;
    if (owned === 0) throw httpError(400, `@${user} has no ${wanted} to remove.`);
    const count = Math.min(requested, owned);
    const result = await removeInventoryItems(db, user, (item) => baseName(item) === wanted, count);
    const note = count < requested ? ` (only ${owned} owned)` : '';
    return { message: `Removed ${result.removed.length} × ${wanted} from @${user}${note}.` };
  }

  if (action === 'autofish-license') {
    const key = autoFishKeys(user).license;
    if (body.enabled === true) await db.set(key, 'true');
    else await db.del(key);
    return { message: body.enabled === true ? `Auto-Fish license granted to @${user}.` : `Auto-Fish license removed from @${user}.` };
  }

  if (action === 'pond') {
    const key = pondKeys(user).unlocked;
    if (body.enabled === true) await db.set(key, 'true');
    else await db.del(key);
    return { message: body.enabled === true ? `Personal Pond unlocked for @${user}.` : `Personal Pond locked for @${user}.` };
  }

  if (action === 'area') {
    const areaId = String(body.areaId || '');
    if (!AREA_IDS.includes(areaId)) throw httpError(400, 'Choose a valid fishing area.');
    const level = Number(body.level);
    if (!Number.isInteger(level) || level < 0 || level > 5) throw httpError(400, 'Area level must be from 0 (locked) to 5.');
    const key = areaLevelKey(user, areaId);
    if (level === 0) await db.del(key);
    else await db.set(key, String(level));
    return { message: `${FISHING_AREAS[areaId]?.name || areaId} set to level ${level} for @${user}.` };
  }

  if (action === 'shop-perk') {
    const perk = String(body.perk || '');
    if (!PERMANENT_PERKS.includes(perk)) throw httpError(400, 'Choose a permanent shop perk.');
    const owned = shopKey(perk, user);
    const toggle = `toggle:${perk}:${user}`;
    if (body.enabled === true) {
      await db.set(owned, 'true');
      // Treasury Only is unlocked but starts switched off, as it does after the normal milestone.
      if (perk === 'treasuryOnly') await db.set(toggle, 'off');
    } else {
      await db.del(owned);
      await db.del(toggle);
    }
    const name = SHOP_ITEMS[perk].name;
    return { message: body.enabled === true ? `${name} granted to @${user}.` : `${name} removed from @${user}.` };
  }

  if (action === 'wipe') {
    if (String(body.confirm || '').trim().replace(/^@+/, '').toLowerCase() !== user) {
      throw httpError(400, 'Type the viewer login to confirm wiping their data.');
    }
    await deleteUserData(user);
    return { message: `All Fishingbot data for @${user} was deleted.` };
  }

  throw httpError(400, 'Unknown viewer tool.');
}
