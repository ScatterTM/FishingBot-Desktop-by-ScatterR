import { db, LOCAL_EDITION } from '../lib/db.js';
import { getSessionUser } from '../lib/session.js';
import { getBroadcasterAdmin, verifyBroadcasterAdminSession, LOCAL_OWNER } from '../lib/broadcaster-admin.js';
import { parseCookies } from '../lib/session.js';
import { removeInventoryItems } from '../lib/inventory.js';
import { recordAdminAudit } from '../lib/audit.js';
import { recalculateBestCatch, checkAndCleanLuckStatus } from './admin/action.js';
import { readChannelProgress, buyChannelUpgrade, CHANNEL_UPGRADES, CHANNEL_UPGRADE_COSTS } from '../lib/channel-progress.js';
import { BROADCASTER_PERMISSIONS, readDeniedPermissions, isDenied } from '../lib/broadcaster-permissions.js';
import {
  readOverlaySettings, saveOverlaySettings, ensureOverlayKey, rotateOverlayKey,
  hideFishChatOn, setHideFishChat, recordOverlayCatch, testTierFor, sanitizeLook
} from '../lib/overlay.js';

// Refuses an action when MasterAdmin has denied this permission for the channel.
// Writes the 403 reply itself and returns true when the caller should stop.
async function refuseIfDenied(channel, permission, res) {
  // The streamer who runs this PC (local Control Centre) is the owner: MasterAdmin's deny list
  // applies to hosted broadcaster accounts, not to the local owner of the channel.
  if (res[LOCAL_OWNER]) return false;
  const denied = await readDeniedPermissions(db, channel);
  if (!isDenied(denied, permission)) return false;
  res.status(403).json({ error: `MasterAdmin has turned off: ${BROADCASTER_PERMISSIONS[permission]}.`, denied: permission });
  return true;
}

const COOKIE = 'fh_broadcaster_admin';

function getAdminSession(req) {
  return verifyBroadcasterAdminSession(parseCookies(req)[COOKIE]);
}
function cleanUser(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}
function validUser(value) {
  return /^[a-z0-9_]{1,25}$/.test(value);
}
async function audit(channel, action, target, details) {
  try {
    await recordAdminAudit(db, { actor: `@${channel} (Admin)`, action, target, details });
  } catch (e) {
    console.error('[Broadcaster Admin] audit failed:', e);
  }
}
async function requireBroadcaster(req) {
  // Local Control Centre: the local admin session already proves the operator. The channel is the
  // Twitch account connected during setup, so no separate broadcaster website sign-in is needed.
  if (req[LOCAL_OWNER]) {
    const login = req[LOCAL_OWNER];
    return { channel: login, twitchLogin: login, enabled: true };
  }
  const twitch = getSessionUser(req);
  const twitchLogin = cleanUser(twitch?.login);
  const session = getAdminSession(req);
  if (!twitchLogin || !session || session.twitchLogin !== twitchLogin) return null;
  const account = await getBroadcasterAdmin(session.channel);
  if (!account || !account.enabled || account.twitchLogin !== twitchLogin) return null;
  return { ...account, twitchLogin };
}
async function readGlobalEvent() {
  const [luck, name, expires] = await Promise.all([
    db.get('global:event_luck').catch(() => null),
    db.get('global:event_name').catch(() => null),
    db.get('global:event_expires').catch(() => null)
  ]);
  const mult = Number(luck);
  const exp = expires == null ? null : Number(expires);
  return { active: Number.isFinite(mult) && mult > 1 && (!exp || Date.now() < exp), multiplier: Number.isFinite(mult) ? mult : 1, name: name || '', expiresAt: exp && Number.isFinite(exp) ? exp : null };
}
async function readChannelEvent(channel) {
  const [luck, name, expires] = await Promise.all([
    db.get(`channel:event_luck:${channel}`).catch(() => null),
    db.get(`channel:event_name:${channel}`).catch(() => null),
    db.get(`channel:event_expires:${channel}`).catch(() => null)
  ]);
  const mult = Math.min(Number(luck), 5);
  const exp = expires == null ? null : Number(expires);
  const active = Number.isFinite(mult) && mult > 1 && (!exp || Date.now() < exp);
  if (exp && Date.now() >= exp) {
    await db.del(`channel:event_luck:${channel}`, `channel:event_name:${channel}`, `channel:event_expires:${channel}`).catch(() => {});
  }
  return { active, multiplier: Number.isFinite(mult) ? mult : 1, name: name || '', expiresAt: exp && Number.isFinite(exp) ? exp : null };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!db) return res.status(500).json({ error: 'Database connection failed.' });

  try {
    const account = await requireBroadcaster(req);
  if (!account) return res.status(401).json({ error: 'Broadcaster Admin authentication required.' });

  const channel = account.channel;
  if (req.method === 'GET') {
    const [cooldownRaw, simpleRaw, globalEvent, channelEvent, progress, denied] = await Promise.all([
      db.get(LOCAL_EDITION ? 'settings:cooldown' : `settings:cooldown:${channel}`).catch(() => null),
      db.get(`settings:simplechat:${channel}`).catch(() => null),
      readGlobalEvent(),
      readChannelEvent(channel),
      readChannelProgress(db, channel),
      readDeniedPermissions(db, channel)
    ]);
    const maxLevel = CHANNEL_UPGRADE_COSTS.length;
    const upgrades = CHANNEL_UPGRADES.map((upgrade) => {
      const level = progress.levels[upgrade.id] || 0;
      const nextCost = level < maxLevel ? CHANNEL_UPGRADE_COSTS[level] : null;
      return {
        ...upgrade,
        level,
        maxLevel,
        nextCost,
        affordable: nextCost !== null && progress.available >= nextCost
      };
    });
    return res.status(200).json({
      success: true,
      channel,
      overlay: await readOverlaySettings(channel),
      overlayKey: await ensureOverlayKey(channel),
      hideFishChat: await hideFishChatOn(channel),
      cooldown: Number.isFinite(Number(cooldownRaw)) ? Number(cooldownRaw) : 60,
      simpleChat: simpleRaw === 'on',
      globalEvent,
      channelEvent,
      denied,
      progress: {
        points: progress.points,
        spent: progress.spent,
        available: progress.available,
        catches: progress.catches,
        upgrades,
        costs: CHANNEL_UPGRADE_COSTS,
        shopAvailable: upgrades.some((u) => u.affordable)
      }
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  const action = String(req.body?.action || '');

  if (action === 'set-channel-cooldown') {
    if (await refuseIfDenied(channel, 'cooldown', res)) return;
    const seconds = Number(req.body?.seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return res.status(400).json({ error: 'Cooldown must be between 0 and 86400 seconds.' });
    await db.set(LOCAL_EDITION ? 'settings:cooldown' : `settings:cooldown:${channel}`, Math.round(seconds));
    await audit(channel, 'setChannelCooldown', LOCAL_EDITION ? 'global' : channel, `${Math.round(seconds)} seconds`);
    return res.status(200).json({ success: true, cooldown: Math.round(seconds) });
  }

  if (action === 'buy-channel-upgrade') {
    if (await refuseIfDenied(channel, 'shopPurchases', res)) return;
    const upgradeId = String(req.body?.upgrade || '');
    try {
      const result = await buyChannelUpgrade(db, channel, upgradeId);
      await audit(channel, 'buyChannelUpgrade', channel, `${upgradeId} level ${result.level} for ${result.cost} points`);
      return res.status(200).json({
        success: true,
        upgrade: result.upgrade,
        level: result.level,
        available: result.available,
        message: `Upgrade bought: ${CHANNEL_UPGRADES.find((u) => u.id === upgradeId)?.name || upgradeId} is now level ${result.level}.`
      });
    } catch (error) {
      return res.status(400).json({ error: error?.message || 'Could not buy this upgrade.' });
    }
  }

  if (action === 'set-overlay') {
    if (await refuseIfDenied(channel, 'overlay', res)) return;
    const overlay = await saveOverlaySettings(channel, req.body?.settings || {});
    await audit(channel, 'setOverlay', channel, JSON.stringify({ enabled: overlay.enabled, sound: overlay.sound }));
    return res.status(200).json({ success: true, overlay });
  }

  if (action === 'set-hide-fish-chat') {
    if (await refuseIfDenied(channel, 'overlay', res)) return;
    const requested = req.body?.enabled === true || req.body?.enabled === 'true';
    // Stored value: always off while the overlay is off.
    const enabled = await setHideFishChat(channel, requested);
    await audit(channel, 'setHideFishChat', channel, enabled ? 'on' : 'off');
    return res.status(200).json({ success: true, hideFishChat: enabled });
  }

  if (action === 'overlay-rotate-key') {
    if (await refuseIfDenied(channel, 'overlay', res)) return;
    const overlayKey = await rotateOverlayKey(channel);
    await audit(channel, 'rotateOverlayKey', channel, 'new link');
    return res.status(200).json({ success: true, channel, overlayKey });
  }

  if (action === 'overlay-test') {
    if (await refuseIfDenied(channel, 'overlay', res)) return;
    const settings = await readOverlaySettings(channel);
    if (!settings.enabled) return res.status(400).json({ error: 'Turn the overlay on and save before sending a test alert.' });
    // The test uses the preview on screen, not the saved settings.
    const look = sanitizeLook(req.body?.preview);
    const tier = testTierFor(String(req.body?.tierId || ''));
    // Sample luck and weight, so the header option can be checked with a test alert.
    await recordOverlayCatch(channel, { user: 'TestViewer', item: `Test ${tier.tierName.toLowerCase()} fish`, tierId: tier.tierId, tierName: tier.tierName.toUpperCase(), luck: '☘️2.5x', weight: '1.2x', test: true, look }, { force: true });
    return res.status(200).json({ success: true });
  }

  if (action === 'set-simple-chat') {
    if (await refuseIfDenied(channel, 'simpleChat', res)) return;
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    await db.set(`settings:simplechat:${channel}`, enabled ? 'on' : 'off');
    await audit(channel, 'setSimpleChat', channel, enabled ? 'on' : 'off');
    return res.status(200).json({ success: true, simpleChat: enabled });
  }

  if (action === 'start-channel-event') {
    if (await refuseIfDenied(channel, 'luckEvent', res)) return;
    const multiplier = Number(req.body?.multiplier);
    const eventName = String(req.body?.eventName || 'Channel Luck Event').trim().slice(0, 80);
    const durationSeconds = Math.min(Math.max(Number(req.body?.durationSeconds) || 0, 0), 30 * 24 * 3600);
    if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5) return res.status(400).json({ error: 'Multiplier must be between 1x and 5x.' });
    if (!eventName) return res.status(400).json({ error: 'Enter an event name.' });
    const expiresAt = durationSeconds > 0 ? Date.now() + durationSeconds * 1000 : null;
    await db.set(`channel:event_luck:${channel}`, multiplier);
    await db.set(`channel:event_name:${channel}`, eventName);
    if (expiresAt) await db.set(`channel:event_expires:${channel}`, expiresAt);
    else await db.del(`channel:event_expires:${channel}`);
    await audit(channel, 'startChannelEvent', channel, `${multiplier}x · ${eventName}${expiresAt ? ` · ${durationSeconds}s` : ' · until ended'}`);
    return res.status(200).json({ success: true, multiplier, eventName, expiresAt });
  }

  if (action === 'end-channel-event') {
    await db.del(`channel:event_luck:${channel}`, `channel:event_name:${channel}`, `channel:event_expires:${channel}`);
    await audit(channel, 'endChannelEvent', channel, 'Ended channel luck event.');
    return res.status(200).json({ success: true });
  }

  if (action === 'get-inventory') {
    const targetUser = cleanUser(req.body?.targetUser);
    if (!validUser(targetUser)) return res.status(400).json({ error: 'Enter a valid Twitch username.' });
    const items = (await db.lrange(`fish:rares:${targetUser}`, 0, -1).catch(() => [])) || [];
    return res.status(200).json({ success: true, targetUser, items: items.map(String) });
  }

  if (action === 'multi-delete-fish') {
    if (await refuseIfDenied(channel, 'inventoryDelete', res)) return;
    const targetUser = cleanUser(req.body?.targetUser);
    const items = req.body?.items;
    if (!validUser(targetUser)) return res.status(400).json({ error: 'Enter a valid Twitch username.' });
    if (!Array.isArray(items) || !items.length || items.length > 500) return res.status(400).json({ error: 'Select between 1 and 500 items.' });

    const members = (await db.lrange(`fish:rares:${targetUser}`, 0, -1).catch(() => [])) || [];
    if (!members.length) return res.status(404).json({ error: `@${targetUser} has no inventory items.` });

    const remainingTargets = [...items];
    const parseItem = (str) => {
      const lower = String(str || '').trim().toLowerCase();
      const match = lower.match(/^(.*?)\s*(?:\[|\()([a-z]+)(?:\]|\))$/);
      return match ? { base: match[1].trim(), tier: match[2], full: lower } : { base: lower, tier: '', full: lower };
    };
    const result = await removeInventoryItems(db, targetUser, (member) => {
      const mp = parseItem(member);
      for (let i = 0; i < remainingTargets.length; i++) {
        const tp = parseItem(remainingTargets[i]);
        if (mp.full === tp.full || (tp.base && mp.base === tp.base && (!tp.tier || mp.tier === tp.tier))) {
          remainingTargets.splice(i, 1);
          return true;
        }
      }
      return false;
    }, items.length);
    if (!result.removed.length) return res.status(400).json({ error: 'None of the selected items could be found.' });

    await recalculateBestCatch(targetUser, result.items);
    await checkAndCleanLuckStatus(targetUser, result.items, result.removed);
    await audit(channel, 'multiDeleteFish', targetUser, `Deleted ${result.removed.length} inventory items.`);
    return res.status(200).json({ success: true, removed: result.removed.length, message: `Deleted ${result.removed.length} item${result.removed.length === 1 ? '' : 's'} from @${targetUser}.` });
  }

    return res.status(400).json({ error: 'Unknown broadcaster Admin action.' });
  } catch (error) {
    console.error('[Broadcaster Admin] request failed:', error);
    return res.status(500).json({ error: 'Broadcaster Admin could not complete the request. Please try again.' });
  }
}
