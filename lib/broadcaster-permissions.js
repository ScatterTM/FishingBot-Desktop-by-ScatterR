// Permissions MasterAdmin can deny per broadcaster channel. A denied permission
// is enforced on the server (api/broadcaster-tools.js) and shown as disabled in
// the broadcaster's panel. Denying one never changes the channel's odds or data.

export const BROADCASTER_PERMISSIONS = {
  luckEvent: 'Start channel luck events',
  simpleChat: 'Change simple chat',
  cooldown: 'Change the fishing cooldown',
  inventoryDelete: 'Multi-delete viewer inventory',
  shopPurchases: 'Buy channel upgrades',
  overlay: 'Change the OBS overlay'
};

const denyKey = (channel) => `broadcaster:denied:${channel}`;

export async function readDeniedPermissions(db, channel) {
  if (!db || !channel) return [];
  const raw = await db.get(denyKey(channel)).catch(() => null);
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch { list = []; }
  return Array.isArray(list) ? list.filter((id) => Object.prototype.hasOwnProperty.call(BROADCASTER_PERMISSIONS, id)) : [];
}

// Adds or removes one denied permission. Returns the new list.
export async function setPermissionDenied(db, channel, permission, denied) {
  if (!Object.prototype.hasOwnProperty.call(BROADCASTER_PERMISSIONS, permission)) {
    throw new Error('Unknown broadcaster permission.');
  }
  const current = await readDeniedPermissions(db, channel);
  const next = denied
    ? [...new Set([...current, permission])]
    : current.filter((id) => id !== permission);
  if (next.length) await db.set(denyKey(channel), JSON.stringify(next));
  else await db.del(denyKey(channel));
  return next;
}

export function isDenied(denied, permission) {
  return Array.isArray(denied) && denied.includes(permission);
}
