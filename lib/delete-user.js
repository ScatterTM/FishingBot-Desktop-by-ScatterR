import { db } from './db.js';
import { deleteUserCatchData, withKeyLock } from './inventory.js';
import { getBroadcasterTwitchRecord, deleteBroadcasterTwitchRecord, revokeBroadcasterTwitch } from './broadcaster-twitch.js';
import { AREA_IDS, areaLevelKey, selectedAreaKey, userAreasOffKey, userDoubleOffKey } from './areas.js';
import { allShopKeys } from './shop.js';
import { autoFishKeys } from './autofish.js';
import { pondKeys } from './pond.js';
import { progressionKeys, customTitlesKey } from './progression.js';

const FIRST_FISH_TUTORIAL_KEY_PREFIX = 'fish:first_tutorial:';
const FIRST_FISH_TUTORIAL_RESET_PREFIX = 'fish:first_tutorial_reset:';

function cleanUser(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

export async function deleteUserData(user) {
  const userKey = cleanUser(user);
  if (!userKey) throw new Error('A valid Twitch username is required.');

  // Twitch verification: a streamer's stored grant is revoked and removed. The
  // cached Twitch user ID is removed too; per-channel level results expire on
  // their own within minutes.
  const twitchRecord = await getBroadcasterTwitchRecord(userKey);
  if (twitchRecord?.refreshToken) await revokeBroadcasterTwitch(userKey);
  await deleteBroadcasterTwitchRecord(userKey);
  await db.del(`twitch_uid:${userKey}`);
  const autoFishUserKeys = Object.values(autoFishKeys(userKey));
  const pondUserKeys = Object.values(pondKeys(userKey));

  await withKeyLock(db, `autofish-settle:${userKey}`, () => Promise.all([
    db.del(
      `fish:count:${userKey}`, `pond:catches:${userKey}`, `fish:besttier:${userKey}`, `fish:bestitem:${userKey}`, `fish:rares:${userKey}`, `fish:treasury:${userKey}`, `fish:treasury-synced:${userKey}`,
      `shield_inventory_v2:${userKey}`, `luck:${userKey}`, `perm_luck:${userKey}`, `temp_luck:${userKey}`,
      `timeout:${userKey}`, `cooldown:${userKey}`, `shields:${userKey}`, `shields_used:${userKey}`, `game_vip:${userKey}`,
      selectedAreaKey(userKey), userAreasOffKey(userKey), userDoubleOffKey(userKey),
      ...AREA_IDS.map((areaId) => areaLevelKey(userKey, areaId)),
      ...allShopKeys(userKey),
      progressionKeys(userKey).casts, progressionKeys(userKey).treasury, progressionKeys(userKey).unique,
      progressionKeys(userKey).rare, progressionKeys(userKey).legendary, progressionKeys(userKey).godly,
      progressionKeys(userKey).areas, progressionKeys(userKey).rod, progressionKeys(userKey).selectedBait,
      progressionKeys(userKey).title, progressionKeys(userKey).unlockedTitles, progressionKeys(userKey).cosmetics,
      customTitlesKey(userKey),
      ...['worm', 'minnow', 'rare', 'legend'].map((id) => `${progressionKeys(userKey).baitPrefix}:${id}`),
      `fish_format:normal:${userKey}`, `fish_format:double:${userKey}`,
      ...['showChance','showLuck','showArea','showNew','showEvent','showBoost','showDoubleChance'].map((id) => `fish_format:${id}:${userKey}`),
      ...autoFishUserKeys, ...pondUserKeys,
      `user:mail:${userKey}`, `user-mail-read:${userKey}`,
      `${FIRST_FISH_TUTORIAL_KEY_PREFIX}${userKey}`, `${FIRST_FISH_TUTORIAL_RESET_PREFIX}${userKey}`
    ),
    deleteUserCatchData(db, userKey)
  ]));
  return userKey;
}
