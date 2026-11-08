import { db } from '../db.js';
import { getSessionUser } from '../session.js';
import { listBroadcasterAdmins } from '../broadcaster-admin.js';
import { withKeyLock } from '../inventory.js';

const STREAMER_CHANGE_COOLDOWN_SECONDS = 5 * 60;
const SELECTED_PREFIX = 'streamer:selected:';
const CHANGE_COOLDOWN_PREFIX = 'streamer:change_cooldown:';

function cleanUser(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function cleanChannel(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function validChannel(value) {
  return /^[a-z0-9_]{1,25}$/.test(value);
}

function selectedKey(user) { return `${SELECTED_PREFIX}${user}`; }
function changeCooldownKey(user) { return `${CHANGE_COOLDOWN_PREFIX}${user}`; }
function fishCooldownKey(channel, user) { return `cooldown:${channel}:${user}`; }

function sessionUser(req) {
  const session = getSessionUser(req);
  return session?.login ? cleanUser(session.login) : null;
}

async function getAvailableBroadcasters() {
  const accounts = await listBroadcasterAdmins();
  return accounts.filter((account) => account.enabled !== false && validChannel(account.channel));
}

async function buildStatus(user) {
  const broadcasters = await getAvailableBroadcasters();
  const [selectedRaw, changeRaw, globalCooldownRaw] = await db.mget([selectedKey(user), changeCooldownKey(user), 'settings:cooldown']).catch(() => [null, null, null]);
  const globalParsed = globalCooldownRaw === null || globalCooldownRaw === undefined || String(globalCooldownRaw).trim() === '' ? NaN : Number(globalCooldownRaw);
  const systemDefaultCooldown = Number.isFinite(globalParsed) && globalParsed >= 0 ? globalParsed : 60;
  const selected = cleanChannel(selectedRaw);
  const now = Date.now();
  const changeUntil = Number(changeRaw) || 0;
  const changeCooldownRemainingSeconds = Math.max(0, Math.ceil((changeUntil - now) / 1000));
  const rows = await Promise.all(broadcasters.map(async (account) => {
    const channel = cleanChannel(account.channel);
    const [settingRaw, userCooldownRaw] = await Promise.all([
      db.get(`settings:cooldown:${channel}`).catch(() => null),
      db.get(fishCooldownKey(channel, user)).catch(() => null)
    ]);
    const configured = settingRaw === null || settingRaw === undefined || String(settingRaw).trim() === '' ? NaN : Number(settingRaw);
    const usesSystemDefault = !(Number.isFinite(configured) && configured > 0);
    const cooldownSeconds = usesSystemDefault ? systemDefaultCooldown : configured;
    const userCooldownUntil = Number(userCooldownRaw) || 0;
    return {
      channel,
      twitchLogin: cleanChannel(account.twitchLogin || channel),
      cooldownSeconds,
      usesSystemDefault,
      cooldownRemainingSeconds: Math.max(0, Math.ceil((userCooldownUntil - now) / 1000))
    };
  }));
  return { selected: selected || null, changeCooldownRemainingSeconds, broadcasters: rows };
}

export async function streamerHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!db) return res.status(500).json({ error: 'Database not configured.' });
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });

  if (req.method === 'GET') return res.status(200).json({ success: true, ...(await buildStatus(user)) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const requested = cleanChannel(req.body?.streamer ?? req.body?.channel);
  if (!validChannel(requested)) return res.status(400).json({ error: 'Choose a valid streamer.' });

  const broadcasters = await getAvailableBroadcasters();
  if (!broadcasters.some((account) => cleanChannel(account.channel) === requested)) {
    return res.status(400).json({ error: 'That streamer is not currently enabled.' });
  }

  const result = await withKeyLock(db, `streamer-selection:${user}`, async () => {
    const current = cleanChannel(await db.get(selectedKey(user)));
    if (current === requested) {
      const until = Number(await db.get(changeCooldownKey(user))) || 0;
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      return { success: true, selected: requested, changed: false, initialSelection: false, changeCooldownRemainingSeconds: remaining };
    }

    const now = Date.now();
    const until = Number(await db.get(changeCooldownKey(user))) || 0;
    if (current && until > now) {
      return {
        success: false,
        selected: current,
        error: `You can change streamers again in ${Math.ceil((until - now) / 1000)}s.`,
        changeCooldownRemainingSeconds: Math.ceil((until - now) / 1000)
      };
    }

    if (!current) {
      await db.set(selectedKey(user), requested);
      await db.del(changeCooldownKey(user));
      return { success: true, selected: requested, changed: true, initialSelection: true, changeCooldownRemainingSeconds: 0 };
    }

    const newUntil = now + STREAMER_CHANGE_COOLDOWN_SECONDS * 1000;
    await db.set(selectedKey(user), requested);
    // Store an absolute timestamp and a matching five-minute TTL so the
    // server-side lock remains authoritative even after page reloads.
    await db.set(changeCooldownKey(user), String(newUntil), { ex: STREAMER_CHANGE_COOLDOWN_SECONDS });
    return {
      success: true,
      selected: requested,
      changed: true,
      initialSelection: false,
      changeCooldownRemainingSeconds: STREAMER_CHANGE_COOLDOWN_SECONDS
    };
  });

  if (!result.success) return res.status(429).json(result);
  return res.status(200).json({ ...result, ...(await buildStatus(user)) });
}

export async function selectedStreamerFor(user) {
  const value = cleanChannel(await db.get(selectedKey(cleanUser(user))).catch(() => null));
  return validChannel(value) ? value : '';
}
