// !fish - the public random roll.
//
// StreamElements command:
//   $(customapi https://<host>/api/fish?user=$(queryescape $(sender))&msg=$(queryescape $(1:))&level=$(sender.level))
//
// Fossabot (use $(customapi)): VIP/Sub/Mod status comes from the broadcaster's
// connected Twitch account, so the URL does not need a level parameter.
//   $(customapi https://<host>/api/fish?secret=YOUR_SECRET&user=$(user)&channel=$(channel)&msg=$(querystring))
//
// Other URLs served from here:
//   /api/fish?action=tiers  public loot table (the website fetches it)
//   /api/fish?action=ping   warms the function and the database connection, see below
//
// Operators typing "!fish <name>" force a specific catch (lib/grantfish.js).
// Everybody else always gets a real roll.
//
// Speed matters here. StreamElements only waits a few seconds for a reply and
// shows nothing at all when it gives up, so the first !fish after a quiet
// spell (cold start + fresh remote database connection) used to vanish, and
// only the second one answered. The work below is therefore kept to as few
// sequential database round trips as possible:
//   1. one read for all state          (1 round trip)
//   2. shield check / perk lookup      (only for the few items that need it)
//   3. every write, in parallel        (2 round trips at most)

import { db, LOCAL_EDITION } from '../lib/db.js';
import { checkBotSecret } from '../lib/session.js';
import { applyTimeoutWithShield, applyTimeoutWithShieldDuration } from '../lib/shields.js';
import { applyItemEffects } from '../lib/effects.js';
import { getFishAbility, activeCustomEffectTotals } from '../lib/fish-abilities.js';
import { recordFishingCatch, withKeyLock } from '../lib/inventory.js';
import { baitFor, rodFor, progressionKeys, recordProgress } from '../lib/progression.js';
import { recordFishCatchAudit } from '../lib/audit.js';
import { toUnicodeBold, fitSegments, truncateToBytes } from '../lib/chattext.js';
import { FISH_MESSAGE_DEFAULTS, readFishMessageSettings } from '../lib/fish-format.js';
import { readChatSettings, applyChatDetail, announceQualifies, queueAnnouncement } from '../lib/chat-settings.js';
import { grantFish, isOperator } from '../lib/grantfish.js';
import { TIERS } from '../lib/tiers.js';
import { fishWeight, weightedFishPick } from '../lib/fish-weights.js';
import { FISHING_AREAS, selectedAreaKey, areaLevelKey, doubleCatchProgress, areaCatchChance, pickWeighted, areaEnabledKey, AREAS_ENABLED_KEY, DOUBLE_CATCH_ENABLED_KEY, isEnabledValue, userAreasOffKey, userDoubleOffKey } from '../lib/areas.js';
import { getAutoFishConfig, recordManualAutoProgress, recordAutoCatchProgress, recordTreasuryEarned, maybeCreateActiveEvent, readAutoFishState, autoFishKeys } from '../lib/autofish.js';
import { collectPond, pondKeys, POND_TREASURY_PERKS, getFishdexFishCount, speciesHunterBonus } from '../lib/pond.js';
import {
  isPlaceholderSender, isNoArg, extractRequestedFish,
  normalizeUserKey, describeIncomingRequest
} from '../lib/chatargs.js';
import { unlockTreasuryOnlyNow } from '../lib/shop.js';
import { recordChannelCast, channelEffects, upgradeLevelKey, channelPerkKey, RARE_BONUS_TIERS } from '../lib/channel-progress.js';
import { fortuneStatus, fortuneUncaughtBoost, uncaughtWeightFor } from '../lib/fortune.js';
import { selectedStreamerFor } from '../lib/game-routes/streamer.js';
import { getBroadcasterTwitchRecord, recordIsComplete, resolveTwitchLevel } from '../lib/broadcaster-twitch.js';
import { recordOverlayCatch, hideFishChatOn } from '../lib/overlay.js';

const RANDOM_TIERS = TIERS.filter((t) => t.cutoff > 0);
const TREASURY_TIER = TIERS.find((t) => t.id === 'treasury');

const DEFAULT_COOLDOWN_SECONDS = 60;
// First normal !fish from a viewer is an onboarding-only response. The marker is
// global per Twitch user, so a viewer does not get the tutorial again in another
// channel using the same fishing system.
// Normal homepage. Viewers open Your guide from the Profile themselves.
const FIRST_FISH_TUTORIAL_KEY_PREFIX = 'fish:first_tutorial:';
const FIRST_FISH_TUTORIAL_RESET_PREFIX = 'fish:first_tutorial_reset:';

function fishTutorialKey(userKey) {
  return `${FIRST_FISH_TUTORIAL_KEY_PREFIX}${userKey}`;
}

function fishTutorialResetKey(userKey) {
  return `${FIRST_FISH_TUTORIAL_RESET_PREFIX}${userKey}`;
}

// StreamElements $(sender.level): 100 viewer, 250 sub, 400 VIP, 500 mod, 1500 broadcaster.
const VIP_SUB_MOD_LEVEL = 250;
// VIP/Sub/Mod luck bonus. It only applies in channels where the broadcaster has
// connected Twitch in Broadcaster Admin, because Twitch is then the source of
// truth. Set to false to turn the bonus off everywhere.
const VIP_SUB_MOD_LUCK_ENABLED = true;

// Items whose catch also switches on a perk. A perk the player already has
// must not announce itself as a new discovery (an admin grant writes the perk
// key without any catch history).
const PERK_KEY_BY_NEEDLE = [
  ['1.5x luck', 'perm_luck'],
  ['2x luck', 'temp_luck'],
  ['vipfish', 'game_vip']
];

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

let warnedAboutLevel = false;

// Nightbot sends caller/channel metadata in headers such as:
// name=someviewer;userLevel=moderator;... . Node lower-cases header names.
// Keep this parser shared by Nightbot-User and Nightbot-Channel so channel
// scoping cannot silently fall back to the global/no-channel cooldown.
function parseHeaderFields(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const fields = {};
  for (const part of raw.split(/[;&]/)) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch (err) { console.error('[api/fish.js:104] ignored error:', err?.message || err); }
    if (key) fields[key] = value;
  }
  return Object.keys(fields).length ? fields : null;
}

function parseNightbotUserHeader(req) {
  const raw = req.headers?.['nightbot-user'] ?? req.headers?.['Nightbot-User'];
  return parseHeaderFields(raw);
}

function getNightbotUser(req) {
  const fields = parseNightbotUserHeader(req);
  if (!fields) return null;
  return fields.name || fields.username || fields.user || null;
}

function getNightbotChannel(req) {
  const raw = req.headers?.['nightbot-channel'] ?? req.headers?.['Nightbot-Channel'];
  if (!raw || typeof raw !== 'string') return null;
  const fields = parseHeaderFields(raw);
  if (fields) return fields.name || fields.channel || fields.channelName || null;
  // Be defensive if a proxy ever forwards only the channel name instead of
  // Nightbot's normal key=value header format.
  const plain = raw.trim().replace(/^@/, '');
  return /^[a-zA-Z0-9_]{1,25}$/.test(plain) ? plain : null;
}

function getNightbotLevel(req) {
  const fields = parseNightbotUserHeader(req);
  if (!fields) return null;

  const level = fields.userLevel || fields.level;
  if (!level) return null;
  const map = {
    viewer: 100,
    subscriber: 250,
    vip: 400,
    twitch_vip: 400,
    moderator: 500,
    broadcaster: 1500,
    owner: 1500
  };
  return map[String(level).toLowerCase()] ?? 100;
}

// Role names (Twitch/Nightbot/StreamElements wording) and the level each one
// maps to. Every source below uses this one table, so "moderator" means the
// same thing no matter which chat bot sent the command.
const ROLE_LEVELS = {
  viewer: 100,
  everyone: 100,
  // Nightbot Regular is not a Twitch VIP/Sub/Mod, so it must not receive the
  // VIP/Sub/Mod Luck bonus.
  regular: 100,
  subscriber: 250,
  sub: 250,
  vip: 400,
  'twitch vip': 400,
  moderator: 500,
  mod: 500,
  'super moderator': 1000,
  supermoderator: 1000,
  broadcaster: 1500,
  owner: 1500
};

// Legacy sources, used only when neither Nightbot nor a connected Twitch channel
// identified the sender: the level / userlevel parameter (URL or body), then x-user-level.
// Unresolved template text such as "$(userlevel)" is skipped, so a missing
// variable never hides a valid value that came after it.
function legacyUserLevel(req) {
  const candidates = [
    req.query?.userlevel, req.query?.userLevel, req.query?.level,
    req.body?.userlevel, req.body?.userLevel, req.body?.level,
    req.headers?.['x-user-level']
  ];
  let sawUnresolved = false;
  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    const text = String(Array.isArray(value) ? value[0] : value).trim();
    if (!text) continue;
    if (/[{}$()]/.test(text)) {
      sawUnresolved = true;
      continue;
    }
    const roleKey = text.toLowerCase().replace(/[_-]+/g, ' ');
    if (Object.prototype.hasOwnProperty.call(ROLE_LEVELS, roleKey)) return ROLE_LEVELS[roleKey];
    const parsed = parseInt(text, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (sawUnresolved && !warnedAboutLevel) {
    warnedAboutLevel = true;
    console.warn(
      '[Fish API] The level parameter arrived as an unresolved template. ' +
      'VIP/Sub/Mod detection is inactive for this request. ' +
      'Nightbot should send its Nightbot-User header. Channels without a connected Twitch account rely on this value.'
    );
  }
  return 100;
}

// Twitch's answer for this viewer in this channel, or null when the channel has
// not connected Twitch (or the check failed, which is logged).
async function twitchLevelFor(channelKey, userKey) {
  if (!channelKey) return null;
  try {
    return await resolveTwitchLevel(channelKey, userKey);
  } catch (error) {
    console.warn(`[Fish API] Twitch role check failed for ${channelKey}/${userKey}: ${error?.message || error}`);
    return null;
  }
}

// Who counts as VIP/Sub/Mod or better. Once a broadcaster has completed
// Twitch verification, Twitch is the source of truth for the role. Do not let
// a stale/incorrect bot header (for example userLevel=viewer) override it.
// Only fall back to Nightbot/legacy metadata when the channel is not verified
// with Twitch, or when Twitch itself is temporarily unavailable.
async function resolveUserLevel(req, userKey, channelKey) {
  let twitchVerified = false;
  if (channelKey) {
    try {
      twitchVerified = recordIsComplete(await getBroadcasterTwitchRecord(channelKey));
    } catch (error) {
      console.warn(`[Fish API] Could not read Twitch verification for ${channelKey}: ${error?.message || error}`);
    }
  }

  if (twitchVerified) {
    const twitchLevel = await twitchLevelFor(channelKey, userKey);
    if (twitchLevel !== null) return twitchLevel;
  }

  const nightbotLevel = getNightbotLevel(req);
  if (nightbotLevel !== null) return nightbotLevel;

  // This also covers a channel that is not verified with Twitch yet.
  if (!twitchVerified) {
    const twitchLevel = await twitchLevelFor(channelKey, userKey);
    if (twitchLevel !== null) return twitchLevel;
  }

  return legacyUserLevel(req);
}

async function recordFishAudit(userKey, details) {
  try {
    await recordFishCatchAudit(db, {
      actor: 'Twitch !fish',
      action: 'fishCatch',
      target: userKey,
      details
    });
  } catch (error) {
    console.error('Fish audit write failed:', error);
  }
}

// Atomically claims the one-time onboarding response. NX makes this safe when
// two !fish requests from the same viewer arrive at nearly the same time.
// If the database write itself fails, fail open so onboarding can never break
// the existing fishing command.
async function claimFirstFishTutorial(userKey) {
  const key = fishTutorialKey(userKey);
  const resetKey = fishTutorialResetKey(userKey);
  try {
    // The reset check and the NX claim are independent, so they share one
    // round trip. Every normal !fish used to pay for both, one after another.
    const [wasReset, claimed] = await Promise.all([
      db.get(resetKey),
      db.set(key, '1', { nx: true })
    ]);
    if (wasReset) {
      await db.del(resetKey);
      await db.set(key, '1');
      return true;
    }
    return !!claimed;
  } catch (error) {
    console.error('[Fish API] First-fish tutorial check failed:', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

// Every key the roll needs, fetched with ONE mget.
function stateKeysFor(u, streamKey = '') {
  // Local single-channel production deliberately has one shared cooldown
  // policy across all routed broadcaster contexts. Hosted multi-channel stays scoped.
  const cooldownStreamKey = LOCAL_EDITION ? '' : streamKey;
  const scopedCooldown = cooldownStreamKey ? `cooldown:${cooldownStreamKey}:${u}` : `cooldown:${u}`;
  const scopedSetting = cooldownStreamKey ? `settings:cooldown:${cooldownStreamKey}` : 'settings:cooldown';
  return {
    timeout: `timeout:${u}`,
    simpleChat: streamKey ? `settings:simplechat:${streamKey}` : 'settings:simplechat:__none__',
    autoTimeout: `autofish:timeout:${u}`,
    cooldownSetting: scopedSetting,
    globalCooldownSetting: 'settings:cooldown',
    shopCooldown: `shop_cooldown:${u}`,
    toggleCooldown: `toggle:cooldown:${u}`,
    cooldownEnd: scopedCooldown,
    gameVip: `game_vip:${u}`,
    toggleVip: `toggle:vip:${u}`,
    togglePerm: `toggle:perm:${u}`,
    toggleTemp: `toggle:temp:${u}`,
    toggleEvent: `toggle:event:${u}`,
    customLuck: `luck:${u}`,
    tempLuck: `temp_luck:${u}`,
    permLuck: `perm_luck:${u}`,
    shopLuck: `shop_luck:${u}`,
    toggleLuck125: `toggle:luck125:${u}`,
    shopTreasuryLuck: `shop_treasury_luck:${u}`,
    toggleTreasuryLuck: `toggle:treasuryLuck:${u}`,
    shopRarityBoost: `shop_rarity_boost:${u}`,
    toggleRarityBoost: `toggle:rarityBoost:${u}`,
    shopTreasuryOnly: `shop_treasury_only:${u}`,
    toggleTreasuryOnly: `toggle:treasuryOnly:${u}`,
    eventLuck: 'global:event_luck',
    eventExpires: 'global:event_expires',
    eventName: 'global:event_name',
    channelEventLuck: streamKey ? `channel:event_luck:${streamKey}` : 'channel:event_luck:__none__',
    channelEventExpires: streamKey ? `channel:event_expires:${streamKey}` : 'channel:event_expires:__none__',
    channelEventName: streamKey ? `channel:event_name:${streamKey}` : 'channel:event_name:__none__',
    bestTier: `fish:besttier:${u}`,
    progressionRod: progressionKeys(u).rod,
    progressionSelectedBait: progressionKeys(u).selectedBait,
    autoLicense: `autofish:license:${u}`,
    autoPrestige: `autofish:prestige:${u}`,
    pondTreasuryPerks: pondKeys(u).treasuryPerks,
    pondSpeciesHunterToggle: `toggle:pondPerk:speciesHunter:${u}`,
    realVip: `real_vip:${u}`,
    selectedArea: selectedAreaKey(u),
    areaForest: areaLevelKey(u, 'forest'),
    areaShieldlake: areaLevelKey(u, 'shieldlake'),
    areaReef: areaLevelKey(u, 'reef'),
    areaFrozen: areaLevelKey(u, 'frozen'),
    areaEmberpool: areaLevelKey(u, 'emberpool'),
    areaWhalebone: areaLevelKey(u, 'whalebone'),
    userAreasOff: userAreasOffKey(u),
    userDoubleOff: userDoubleOffKey(u),
    areasEnabled: AREAS_ENABLED_KEY,
    doubleCatchEnabled: DOUBLE_CATCH_ENABLED_KEY,
    areaForestEnabled: areaEnabledKey('forest'),
    areaShieldlakeEnabled: areaEnabledKey('shieldlake'),
    areaReefEnabled: areaEnabledKey('reef'),
    areaFrozenEnabled: areaEnabledKey('frozen'),
    areaEmberpoolEnabled: areaEnabledKey('emberpool'),
    areaWhaleboneEnabled: areaEnabledKey('whalebone'),
    channelLuckLevel: upgradeLevelKey(streamKey || '__none__', 'luck'),
    channelRarityLevel: upgradeLevelKey(streamKey || '__none__', 'rarity'),
    channelLuckyLevel: upgradeLevelKey(streamKey || '__none__', 'lucky-chat'),
    channelPerkToggle: channelPerkKey(u, streamKey || '__none__'),
    customFishEffects: `fish:custom_effects:${u}`
  };
}

async function readState(userKey, streamKey = '') {
  const keys = stateKeysFor(userKey, streamKey);
  const names = Object.keys(keys);
  const keyList = Object.values(keys);

  const [mgetResult, rarityBoostTtl] = await Promise.all([
    db.mget(keyList).catch(() => null),
    db.ttl(keys.shopRarityBoost).catch(() => -2)
  ]);
  let values = mgetResult;
  if (!Array.isArray(values)) {
    values = await Promise.all(keyList.map((key) => db.get(key).catch(() => null)));
  }
  const state = Object.fromEntries(names.map((name, i) => [name, values[i] ?? null]));
  state.shopRarityBoostTtl = Number(rarityBoostTtl);
  return state;
}

function cooldownMsFor(state) {
  let seconds = DEFAULT_COOLDOWN_SECONDS;
  const configured = state.cooldownSetting !== null ? state.cooldownSetting : state.globalCooldownSetting;
  if (configured !== null) {
    // A non-numeric setting used to become NaN, which was then stored as the
    // cooldown end time and switched the cooldown off for that player.
    const parsed = parseFloat(configured);
    if (Number.isFinite(parsed) && parsed >= 0) seconds = parsed;
  }
  if (state.shopCooldown && state.toggleCooldown !== 'off') seconds *= 0.85;
  const custom = activeCustomEffectTotals(state.customFishEffects);
  if (custom.cooldownReductionPct > 0) seconds *= 1 - custom.cooldownReductionPct / 100;
  return Math.max(0, Math.round(seconds * 1000));
}

// Everything that changes the odds of this cast.
async function computeLuck(state, isVipSubMod, forceTreasuryOnly = false, source = 'manual', streamKey = '') {
  const vipToggle = state.toggleVip;
  const customFishEffects = activeCustomEffectTotals(state.customFishEffects);
  // A live Nightbot role and the stored role mirror are the same VIP/Sub/Mod
  // signal for Luck. Keep both paths so a fresh !fish does not have to wait
  // for the mirror write before the current cast gets the bonus.
  const vipSubModRoleActive = VIP_SUB_MOD_LUCK_ENABLED && (!!isVipSubMod || state.realVip === 'true');
  const hasVipLuck = vipToggle !== 'off' && (vipSubModRoleActive || !!state.gameVip);
  const vipLuckSource = vipSubModRoleActive ? 'twitch-role' : (state.gameVip ? 'vipfish' : 'none');

  let base = 1.0;
  const custom = state.customLuck !== null && state.customLuck !== 'null'
    ? parseFloat(state.customLuck)
    : NaN;
  const customLuckActive = Number.isFinite(custom);
  if (customLuckActive) base = custom;
  else if (hasVipLuck && !vipSubModRoleActive) base = 1.5;

  // VIP/Sub/Mod is a true Luck multiplier. A custom Luck value sets the
  // starting Luck but must never suppress the role bonus.
  const vipLuckApplied = vipSubModRoleActive && vipToggle !== 'off';
  const vipLuckMultiplier = vipLuckApplied ? 1.5 : 1;
  const vipBaseApplied = vipLuckApplied;
  const vipLuckBlockedByCustom = false;
  const vipLuckBlockedByToggle = vipToggle === 'off' && vipSubModRoleActive;

  const permOn = !!state.permLuck && state.togglePerm !== 'off';
  const tempOn = !!state.tempLuck && state.toggleTemp !== 'off';
  const shopLuckOn = !!state.shopLuck && state.toggleLuck125 !== 'off';
  let speciesHunterLevel = 0;
  if (state.pondTreasuryPerks && state.pondSpeciesHunterToggle !== 'off') {
    try {
      const pondPerks = JSON.parse(state.pondTreasuryPerks);
      speciesHunterLevel = Math.max(0, Math.min(POND_TREASURY_PERKS.speciesHunter.max, Number(pondPerks?.speciesHunter) || 0));
    } catch (_) { console.error('[api/fish.js:425] ignored error:', _?.message || _); }
  }
  const treasuryLuckOn = !!state.shopTreasuryLuck && state.toggleTreasuryLuck !== 'off';
  const treasuryOnlyOn = forceTreasuryOnly || (source === 'manual' && !!state.shopTreasuryOnly && state.toggleTreasuryOnly === 'on');
  const rarityBoostActive = !!state.shopRarityBoost &&
    Number(state.shopRarityBoostTtl) > 0 &&
    state.toggleRarityBoost !== 'off';
  const rarityBoostTier = rarityBoostActive ? state.shopRarityBoost : null;

  // Global event always wins while active. Otherwise a channel event applies
  // only to casts carrying that broadcaster's stream key.
  let eventLuck = 1.0;
  let eventActive = false;
  let eventName = '';
  let eventExpired = false;
  let eventScope = null;
  const nowForEvent = Date.now();
  const readEvent = (luckRaw, expiresRaw, nameRaw, fallbackName, maxMultiplier = Infinity) => {
    const parsed = parseFloat(luckRaw);
    const expiresAt = expiresRaw !== null && expiresRaw !== undefined ? parseInt(expiresRaw, 10) : null;
    const expired = !!(expiresAt && !Number.isNaN(expiresAt) && nowForEvent >= expiresAt);
    if (!Number.isFinite(parsed) || parsed <= 1) {
      return { active: false, expired, multiplier: 1, name: '', expiresAt };
    }
    if (expired) {
      return { active: false, expired: true, multiplier: 1, name: '', expiresAt };
    }
    const multiplier = Math.min(parsed, maxMultiplier);
    return { active: true, expired: false, multiplier, name: nameRaw || fallbackName, expiresAt };
  };

  // Read both scopes independently. A global event has priority when active,
  // but it must never mask or mutate a channel event. In particular, ending
  // a global event must immediately reveal an already-running channel event.
  const globalEvent = readEvent(state.eventLuck, state.eventExpires, state.eventName, 'Global Luck Event');
  const channelEvent = streamKey
    ? readEvent(state.channelEventLuck, state.channelEventExpires, state.channelEventName, 'Channel Luck Event', 5)
    : { active: false, expired: false, multiplier: 1, name: '', expiresAt: null };

  const selectedEvent = globalEvent.active ? globalEvent : (channelEvent.active ? channelEvent : null);
  if (selectedEvent) {
    eventLuck = selectedEvent.multiplier;
    eventActive = true;
    eventName = selectedEvent.name;
    eventScope = globalEvent.active ? 'global' : 'channel';
  } else if (globalEvent.expired) {
    // Only the expired scope is eligible for cleanup. Never delete global
    // state merely because a channel event expired (or vice versa).
    eventExpired = true;
    eventScope = 'global';
  } else if (channelEvent.expired) {
    eventExpired = true;
    eventScope = 'channel';
  }
  const eventToggleOff = state.toggleEvent === 'off';

  let multiplier = base;
  if (vipLuckApplied) multiplier *= vipLuckMultiplier;
  if (permOn) multiplier *= 1.5;
  if (tempOn) multiplier *= 2.0;
  if (shopLuckOn) multiplier *= 1.25;
  // Channel upgrades bought by the broadcaster. Only casts in that channel have them (see readState).
  // The viewer can switch a channel's upgrades off for their own casts there.
  const channelBonus = channelEffects(state.channelPerkToggle === 'off' ? {} : {
    luck: state.channelLuckLevel,
    rarity: state.channelRarityLevel,
    'lucky-chat': state.channelLuckyLevel
  });
  multiplier *= 1 + channelBonus.luckPct;
  if (!eventToggleOff) multiplier *= eventLuck;
  // Fisherman's Fortune: additive luck that grows with total catches.
  multiplier += Number(state.fortuneLuckAdd) || 0;

  // Species Hunter also applies to normal !fish luck. It is additive, matching
  // the Pond's existing implementation, and is applied after the normal luck
  // multipliers so the established !fish order remains unchanged.
  if (speciesHunterLevel > 0) {
    const fishdexCount = await getFishdexFishCount(state.userKey || '');
    multiplier += speciesHunterBonus(speciesHunterLevel, fishdexCount);
  }
  multiplier *= customFishEffects.luckMultiplier;

  const prestige = Math.max(0, Math.min(5, parseInt(state.autoPrestige, 10) || 0));
  // Prestige Treasury bonus is additive: 18x at Prestige 0 becomes
  // 18.5x at Prestige 1, 19x at Prestige 2, etc.
  const totalTreasuryMult = ((treasuryLuckOn ? 1.5 : 1) * channelBonus.luckyMult * (treasuryOnlyOn ? 12 : 1) + (prestige * 0.5)) * customFishEffects.treasuryLuckMultiplier;

  return {
    multiplier,
    baseLuck: base,
    customLuckActive,
    vipBaseApplied,
    vipLuckApplied,
    vipLuckMultiplier,
    vipSubModMirror: state.realVip === 'true',
    vipSubModRoleActive,
    vipLuckSource,
    vipLuckBlockedByCustom,
    vipLuckBlockedByToggle,
    gameVipActive: !!state.gameVip,
    totalTreasuryMult,
    customFishWeightMultiplier: customFishEffects.weightMultiplier,
    customFishEffects,
    channelRareBonus: channelBonus.rarityPct,
    treasuryOnlyOn,
    rarityBoostTier,
    eventExpired,
    // Only advertised when the player has not switched event luck off.
    eventShown: eventActive && !eventToggleOff,
    eventName,
    eventLuck,
    eventScope
  };
}

// ---------------------------------------------------------------------------
// The roll
// ---------------------------------------------------------------------------

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function tierBaseProbability(tier) {
  const index = RANDOM_TIERS.findIndex((t) => t.id === tier.id);
  if (index < 0) return 0;
  const previousCutoff = index === 0 ? 0 : RANDOM_TIERS[index - 1].cutoff;
  return Math.max(0, Number(tier.cutoff) - previousCutoff);
}

function weightedTierTable(effectiveMultiplier, rarityBoostTier, rareBonusPct = 0) {
  const multiplier = Math.max(0, Number(effectiveMultiplier) || 1);
  const table = [];
  let nonCommonTotal = 0;
  let commonBase = 0;
  for (const tier of RANDOM_TIERS) {
    const base = tierBaseProbability(tier);
    if (tier.id === 'common') commonBase = base;
    else {
      let weight = base * multiplier;
      if (RARE_BONUS_TIERS.includes(tier.id)) weight *= 1 + rareBonusPct;
      if (tier.id === rarityBoostTier) weight += base * multiplier;
      table.push({ tier, weight });
      nonCommonTotal += weight;
    }
  }
  // Luck/rod/bait move probability mass out of Common rather than creating
  // probability from nowhere. At extreme multipliers Common reaches zero.
  const commonWeight = Math.max(0, 1 - nonCommonTotal);
  table.push({ tier: RANDOM_TIERS.find((t) => t.id === 'common'), weight: commonWeight });
  const total = table.reduce((sum, row) => sum + row.weight, 0) || 1;
  return table.map((row) => ({ ...row, probability: row.weight / total }));
}

// Weight modifier for a tier's roll: uncaught fish are multiplied by the Fortune boost.
// Caught state is keyed as `Name [TIER]`, so the tier is part of the lookup.
function uncaughtModifier(luck, tier) {
  const hasUncaught = !!luck?.uncaughtBoost;
  const customWeight = Math.max(0.01, Number(luck?.customFishWeightMultiplier) || 1);
  if (!hasUncaught && customWeight === 1) return null;
  return (item) => (hasUncaught ? uncaughtWeightFor(luck.uncaughtBoost, `${item} [${tier.name}]`) : 1) * customWeight;
}

function rollCatch(luck, area, rodBonus = 0, baitMultiplier = 1) {
  const { multiplier, totalTreasuryMult, treasuryOnlyOn, rarityBoostTier } = luck;
  const rareBonusPct = Number(luck.channelRareBonus) || 0;
  const effectiveMultiplier = multiplier * (1 + Math.max(0, Number(rodBonus) || 0)) * Math.max(1, Number(baitMultiplier) || 1);
  // The equipped rod's weight (1 + rod bonus) applies to Treasury odds too.
  // Bait stays a non-Treasury modifier.
  const rodWeight = 1 + Math.max(0, Number(rodBonus) || 0);
  const treasuryChance = Math.min(1, TREASURY_TIER.basePct * totalTreasuryMult * rodWeight / 100);

  if (Math.random() < treasuryChance) {
    return { tier: TREASURY_TIER, item: weightedFishPick(TREASURY_TIER, uncaughtModifier(luck, TREASURY_TIER)), treasuryChance, area: null, tierChance: treasuryChance };
  }
  // Treasury Only mode: anything that is not treasury is mud.
  if (treasuryOnlyOn) return { mud: true, treasuryChance, area: null, tierChance: 1 - treasuryChance };

  // A selected fishing area adds a specialized loot roll on top of the normal
  // table. Luck/rod/bait also affect the area's rarity weighting so gear never
  // becomes cosmetic-only while an area is selected.
  if (area?.level > 0 && Math.random() < areaCatchChance(area.level)) {
    const boostedLoot = area.config.loot.map((entry) => {
      const bonus = Number(area.config.boost?.[entry[0]] || 0);
      const tier = TIERS.find((t) => t.name === entry[1]) || TIERS.find((t) => t.id === 'common');
      const rarityWeight = (tier?.id === 'common' ? 1 : effectiveMultiplier) * (RARE_BONUS_TIERS.includes(tier?.id) ? 1 + rareBonusPct : 1);
      const targetBoost = tier?.id === rarityBoostTier ? 2 : 1;
      const uncaught = uncaughtWeightFor(luck.uncaughtBoost, `${entry[0]} [${entry[1]}]`);
      return [entry[0], entry[1], Number(entry[2] || 0) * (1 + bonus / 10) * rarityWeight * targetBoost * (fishWeight(tier.id, entry[0]) / 100) * uncaught * (Number(luck.customFishWeightMultiplier) || 1)];
    });

    const commonChance = weightedTierTable(effectiveMultiplier, rarityBoostTier, rareBonusPct)
      .find((row) => row.tier?.id === 'common')?.probability ?? 0;

    if (commonChance <= 0) {
      for (const entry of boostedLoot) {
        const entryTier = TIERS.find((t) => t.name === entry[1]);
        if (entryTier?.id === 'common') entry[2] = 0;
      }
    }

    const entry = pickWeighted(boostedLoot);

    if (entry) {
      const tier = TIERS.find((t) => t.name === entry[1]) || TIERS.find((t) => t.id === 'common');
      const totalWeight = boostedLoot.reduce((sum, row) => sum + Math.max(0, Number(row[2]) || 0), 0) || 1;
      const selectedWeight = Math.max(0, Number(entry[2]) || 0);
      return { tier, item: entry[0], treasuryChance, area: area.config, tierChance: areaCatchChance(area.level) * selectedWeight / totalWeight };
    }
  }

  const table = weightedTierTable(effectiveMultiplier, rarityBoostTier, rareBonusPct);
  const rand = Math.random();
  let cursor = 0;
  const row = table.find((candidate) => {
    cursor += candidate.probability;
    return rand < cursor;
  }) || table[table.length - 1];
  return { tier: row.tier, item: weightedFishPick(row.tier, uncaughtModifier(luck, row.tier)), treasuryChance, area: null, tierChance: row.probability };
}

// Treasury multiplier as shown in chat: Treasury luck x equipped rod weight.
function shownTreasuryMult(luck) {
  return Number((luck.totalTreasuryMult * (Number(luck.rodWeight) || 1)).toFixed(2));
}

// Luck and rod weight of a catch, as the chat shows them. Used by the overlay alert header.
export function catchLuckStats(tier, luck) {
  if (!luck) return { luck: '', weight: '' };
  const icon = tier?.luckImmune || luck.treasuryOnlyOn ? '💰' : '☘️';
  const value = tier?.luckImmune ? shownTreasuryMult(luck) : Number(Number(luck.multiplier).toFixed(2));
  return { luck: `${icon}${value}x`, weight: `${Number(luck.rodWeight) || 1}x` };
}

// The chance shown in chat for the tier that was caught.
function displayPercent(tier, luck, entryChance = null) {
  const { totalTreasuryMult } = luck;

  // The chat percentage is the tier's base chance after applying the
  // player's displayed luck multiplier. It is NOT the normalized probability
  // of the tier after the weighted roll table is rebuilt.
  //
  // Example: 25% base chance × 4.22x luck = 105.5%.
  if (tier.luckImmune) {
    return (tier.basePct * totalTreasuryMult * (Number(luck.rodWeight) || 1)).toFixed(1) + '%';
  }

  const basePct = Number(tier.basePct || 0);
  const multiplier = Math.max(0, Number(luck.multiplier) || 1);
  return (basePct * multiplier).toFixed(1) + '%';
}

function fillFishTemplate(template, values) {
  // Tokens are matched case-insensitively, so look values up the same way.
  // (Keys like "luckIcon" are camelCase; a plain values[key.toLowerCase()]
  // never found them and {luckIcon} always rendered empty.)
  const lookup = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return String(template || '')
    .replace(/\{(user|catch|catches|tier|chance|luck|luckIcon|area|new|event|boost|double|effect)\}/gi, (_, key) => String(lookup[key.toLowerCase()] ?? ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildCatchMessage(entry, luck, selectedArea, isNewDiscovery, settings) {
  const boldTier = toUnicodeBold(entry.tier.name);
  const formattedBadge = entry.tier.badge.replace(entry.tier.name, boldTier);
  const chance = settings.showChance ? ` | ${displayPercent(entry.tier, luck, entry.tierChance)}` : '';
  const tierPart = `[${formattedBadge}${chance}]`;
  const luckIcon = entry.tier.luckImmune || luck.treasuryOnlyOn ? '💰' : '☘️';
  const shownLuck = entry.tier.luckImmune ? `${shownTreasuryMult(luck)}x` : `${Number(luck.multiplier.toFixed(2))}x`;
  const area = settings.showArea && selectedArea ? ` 📍${selectedArea.config.name}` : '';
  const newTag = settings.showNew && isNewDiscovery ? ' ✨ [NEW FISH DISCOVERED]' : '';
  const luckPart = settings.showLuck ? ` ${luckIcon}${shownLuck}` : '';
  return {
    item: toUnicodeBold(entry.item),
    tier: tierPart,
    chance: settings.showChance ? displayPercent(entry.tier, luck) : '',
    luck: settings.showLuck ? shownLuck : '',
    luckIcon: settings.showLuck ? luckIcon : '',
    area,
    new: newTag,
    catch: `${toUnicodeBold(entry.item)} ${tierPart}${luckPart}${area}${newTag}`
  };
}

export async function performFishingCast(userKey, {
  displayUser = userKey,
  isVipSubMod = false,
  source = 'manual',
  bypassCooldown = false,
  messageSettingsOverride = null,
  areaOverride = null,
  forceTreasuryOnly = false,
  streamKey = ''
} = {}) {
  if (!db) return { ok: false, kind: 'database', text: 'Fishing database is not connected.' };

  const pending = [];
  const finish = async (result) => { await Promise.all(pending); return result; };
  const track = (promise, label) => {
    const guarded = Promise.resolve(promise).catch((e) => {
      console.error(`[Fish Engine] ${label} failed:`, e);
      return null;
    });
    pending.push(guarded);
    return guarded;
  };

  const [state, messageSettingsRaw, chatOpts] = await Promise.all([
    readState(userKey, streamKey),
    messageSettingsOverride ? Promise.resolve(messageSettingsOverride) : readFishMessageSettings(userKey),
    readChatSettings()
  ]);
  const messageSettings = applyChatDetail(messageSettingsRaw, chatOpts.chatDetail);
  state.userKey = userKey;
  const areaLevels = {
    forest: Math.max(0, Math.min(5, parseInt(state.areaForest, 10) || 0)),
    shieldlake: Math.max(0, Math.min(5, parseInt(state.areaShieldlake, 10) || 0)),
    reef: Math.max(0, Math.min(5, parseInt(state.areaReef, 10) || 0)),
    frozen: Math.max(0, Math.min(5, parseInt(state.areaFrozen, 10) || 0)),
    emberpool: Math.max(0, Math.min(5, parseInt(state.areaEmberpool, 10) || 0)),
    whalebone: Math.max(0, Math.min(5, parseInt(state.areaWhalebone, 10) || 0))
  };
  const areasMasterEnabled = isEnabledValue(state.areasEnabled);
  const areaEnabled = {
    forest: areasMasterEnabled && isEnabledValue(state.areaForestEnabled),
    shieldlake: areasMasterEnabled && isEnabledValue(state.areaShieldlakeEnabled),
    reef: areasMasterEnabled && isEnabledValue(state.areaReefEnabled),
    frozen: areasMasterEnabled && isEnabledValue(state.areaFrozenEnabled),
    emberpool: areasMasterEnabled && isEnabledValue(state.areaEmberpoolEnabled),
    whalebone: areasMasterEnabled && isEnabledValue(state.areaWhaleboneEnabled)
  };
  const userAreasOn = state.userAreasOff !== 'on';
  const requestedAreaId = areaOverride || state.selectedArea;
  const selectedAreaId = userAreasOn && FISHING_AREAS[requestedAreaId] && areaEnabled[requestedAreaId] && areaLevels[requestedAreaId] > 0 ? requestedAreaId : null;
  const selectedArea = selectedAreaId ? { id: selectedAreaId, level: areaLevels[selectedAreaId], config: FISHING_AREAS[selectedAreaId] } : null;
  const doubleCatchEnabled = isEnabledValue(state.doubleCatchEnabled) && state.userDoubleOff !== 'on';
  const doubleCatch = doubleCatchEnabled ? doubleCatchProgress(areaLevels) : { ...doubleCatchProgress(areaLevels), chance: 0, disabled: true };
  if (source === 'manual' && state.realVip !== (isVipSubMod ? 'true' : 'false')) {
    track(db.set(`real_vip:${userKey}`, isVipSubMod ? 'true' : 'false'), 'VIP mirror');
  }

  // Manual !fish and Auto-Fish have separate break timers. A Treasury
  // timeout caught by Auto-Fish pauses only Auto-Fish and never locks !fish.
  const breakKey = source === 'auto' ? state.autoTimeout : state.timeout;
  if (breakKey) {
    const expiresAt = parseInt(breakKey, 10);
    if (Date.now() < expiresAt) {
      const remainingSec = Math.ceil((expiresAt - Date.now()) / 1000);
      const timeStr = remainingSec > 60
        ? `${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`
        : `${remainingSec}s`;
      return finish({
        ok: false,
        kind: 'timeout',
        autoBroken: source === 'auto',
        timeoutUntil: expiresAt,
        text: source === 'auto'
          ? `Auto-Fish broke! It will repair in ${timeStr}.`
          : `your rod broke wait for it to repair! ${timeStr}`
      });
    }
    track(db.del(source === 'auto' ? `autofish:timeout:${userKey}` : `timeout:${userKey}`), 'timeout cleanup');
  }

  // Cooldown (operators are exempt).
  const cooldownMs = cooldownMsFor(state);
  // Auto-Fish has its own server-side next-cast timer. It must never consume
  // or be blocked by the player's normal !fish cooldown. Operators bypass the
  // normal cooldown as well.
  const usesManualCooldown = source !== 'auto' && !bypassCooldown;
  if (usesManualCooldown) {
    // Reserve the cooldown atomically per (channel, user). This prevents two
    // near-simultaneous !fish requests from both passing the check, while also
    // keeping one viewer's cooldown completely separate between channels.
    const cooldownKey = stateKeysFor(userKey, streamKey).cooldownEnd;
    const cooldownScope = LOCAL_EDITION ? '__global__' : (streamKey || '__global__');
    const cooldownLock = `fishing-cooldown:${cooldownScope}:${userKey}`;
    try {
      const reservation = await withKeyLock(db, cooldownLock, async () => {
        const liveEndRaw = await db.get(cooldownKey).catch(() => null);
        const liveEnd = parseInt(liveEndRaw, 10);
        const checkNow = Date.now();
        if (Number.isFinite(liveEnd) && liveEnd > checkNow) {
          return { blocked: true, endsAt: liveEnd };
        }
        const endsAt = checkNow + cooldownMs;
        await db.set(cooldownKey, endsAt);
        return { blocked: false, endsAt };
      });

      if (reservation?.blocked) {
        const remaining = ((reservation.endsAt - Date.now()) / 1000).toFixed(1);
        return finish({
          ok: false,
          kind: 'cooldown',
          remainingMs: reservation.endsAt - Date.now(),
          text: chatOpts.cooldownReply === 'silent' ? '' : `⏳ ${displayUser}, your fishing line is tangled! Wait ${remaining}s.`
        });
      }
    } catch (error) {
      console.error('[Fish Engine] Cooldown reservation failed:', error);
      return finish({ ok: false, kind: 'error', text: `🎣 ${displayUser}, the fishing cooldown could not be checked. Try !fish again.` });
    }
  }

  let autoProgressPromise = null;
  if (source === 'manual') {
    autoProgressPromise = track(recordManualAutoProgress(userKey, null, state.autoLicense === 'true'), 'manual Auto-Fish progress');
  } else {
    autoProgressPromise = track(recordAutoCatchProgress(userKey), 'auto-fish progress');
  }

  // Luck and the roll.
  const fortune = await fortuneStatus(userKey);
  state.fortuneLuckAdd = fortune.luckAdd;
  const luck = await computeLuck(state, isVipSubMod, forceTreasuryOnly, source, streamKey);
  // Fisherman's Fortune: uncaught fish get a heavier weight in the roll.
  luck.uncaughtBoost = await fortuneUncaughtBoost(userKey, fortune);
  if (luck.eventExpired) {
    if (luck.eventScope === 'channel' && streamKey) {
      track(db.del(`channel:event_luck:${streamKey}`, `channel:event_name:${streamKey}`, `channel:event_expires:${streamKey}`), 'expired channel event cleanup');
    } else {
      track(db.del('global:event_luck', 'global:event_name', 'global:event_expires'), 'expired event cleanup');
    }
  }

  const fishLuckBadge = `${Number(luck.multiplier.toFixed(2))}x`;

  // Rod weight applies to both tables; bait affects only the non-Treasury rarity table. Bait is consumed
  // under a per-player lock so two simultaneous casts cannot spend the same bait.
  const equippedRod = rodFor(state.progressionRod);
  luck.rodWeight = 1 + Math.max(0, Number(equippedRod.bonus) || 0);
  const treasuryLuckBadge = `${shownTreasuryMult(luck)}x`;
  const selectedBait = baitFor(state.progressionSelectedBait);
  let baitMultiplier = 1;
  if (source === 'manual' && selectedBait.id !== 'worm') {
    try {
      const consumed = await withKeyLock(db, `bait:${userKey}`, async () => {
        const liveCount = Number(await db.get(`${progressionKeys(userKey).baitPrefix}:${selectedBait.id}`)) || 0;
        if (liveCount < 1) return false;
        await db.incrby(`${progressionKeys(userKey).baitPrefix}:${selectedBait.id}`, -1);
        return true;
      });
      if (consumed) baitMultiplier = selectedBait.multiplier;
      else track(db.set(progressionKeys(userKey).selectedBait, 'worm'), 'empty bait selection reset');
    } catch (error) {
      console.error('[Fish Engine] Bait consume failed:', error);
    }
  }
  const roll = rollCatch(luck, selectedArea, equippedRod.bonus, baitMultiplier);

  if (roll.mud) {
    track(recordProgress(userKey, { cast: true }), 'progression cast');
    const treasuryPct = Math.round(roll.treasuryChance * 100);
    track(recordFishAudit(userKey, 'Caught Mud [TREASURY ONLY]'), 'mud audit');
    if (source !== 'auto') track(db.incr(`fish:count:${userKey}`), 'manual leaderboard count');
    if (source === 'manual') track(recordChannelCast(db, streamKey, [], { user: userKey, items: [] }), 'channel progress');
    if (state.simpleChat === 'on') {
      return finish({ ok: true, text: truncateToBytes(`${displayUser} Caught "Mud" 💰${treasuryLuckBadge}`) });
    }
    return finish({ ok: true, text:
      `${displayUser} cast their line and caught a ${toUnicodeBold('Mud')} [🟫 Mud | ${100 - treasuryPct}%] 💰${treasuryLuckBadge}`
    });
  }

  // The area progression unlocks a passive Double Catch chance. On a proc,
  // the second catch is rolled independently, so area luck can apply to both.
  const catches = [roll];
  // Double Catch is a passive area-progression reward. Its chance is already 0
  // until the player owns at least one area, and 0 when the global or the
  // per-player Double Catch switch is off, so chance > 0 is the only gate it
  // needs. It must NOT depend on a fishing area being selected/enabled: the
  // perk card shows the chance in normal waters too, and the area switches
  // have their own separate toggles.
  const doubleCatchUnlocked = doubleCatch.chance > 0;
  if (!roll.mud && doubleCatchUnlocked && Math.random() < doubleCatch.chance / 100) {
    catches.push(rollCatch(luck, selectedArea, equippedRod.bonus, baitMultiplier));
  }

  const validCatches = catches.filter((entry) => !entry.mud && entry.tier && entry.item);

  // Fishy's Treasury slot is an active-play reward: a successful manual !fish
  // cast has the configured (50% by default) chance to spawn a slot. Auto-Fish
  // casts never create these slots.
  if (source === 'manual' && state.autoLicense === 'true') {
    const autoConfig = await getAutoFishConfig();
    track(maybeCreateActiveEvent(userKey, autoConfig, await readAutoFishState(userKey, autoConfig), 'manual'), 'manual Fishy Treasury slot');
  }

  if (!validCatches.length) {
    if (source === 'manual') track(recordChannelCast(db, streamKey, [], { user: userKey, items: [] }), 'channel progress');
    if (state.simpleChat === 'on') {
      return finish({ ok: true, text: truncateToBytes(`${displayUser} Caught "Mud" 💰${treasuryLuckBadge}`) });
    }
    return finish({ ok: true, text: `${displayUser} cast their line and caught ${toUnicodeBold('Mud')} [🟫 Mud] 💰${treasuryLuckBadge}` });
  }

  if (source === 'manual') track(recordChannelCast(db, streamKey, validCatches.map((entry) => entry.tier.id), { user: userKey, items: validCatches.map((entry) => entry.item) }), 'channel progress');
  const perkChecks = await Promise.all(validCatches.map(async (entry) => {
    const lowerItem = entry.item.toLowerCase();
    const perkRule = PERK_KEY_BY_NEEDLE.find(([needle]) => lowerItem.includes(needle));
    const existing = perkRule ? await db.get(`${perkRule[1]}:${userKey}`).catch(() => null) : null;
    const timeoutKey = source === 'auto' ? `autofish:timeout:${userKey}` : `timeout:${userKey}`;
    const customAbility = getFishAbility(entry.item);
    const timeoutResult = await (customAbility?.effectType === 'timeout'
      ? applyTimeoutWithShieldDuration(db, userKey, customAbility.timeoutMinutes * 60, { timeoutKey })
      : applyTimeoutWithShield(db, userKey, entry.item, { timeoutKey })).catch((e) => {
      console.error('Shield check failed:', e);
      return { message: '' };
    });
    return { perkExisting: existing, timeoutResult };
  }));

  const inventoryItems = validCatches.map((entry) => `${entry.item} [${entry.tier.name}]`);
  let bestSoFar = parseInt(state.bestTier, 10);
  let bestTierValue = null;
  let bestItemValue = null;
  // Auto-Fish catches belong to inventory/catch history, but they do not
  // participate in the public leaderboard's best-catch ranking.
  if (source !== 'auto') {
    for (const entry of validCatches) {
      if (!state.bestTier || entry.tier.rankScore > bestSoFar) {
        bestSoFar = entry.tier.rankScore;
        bestTierValue = String(entry.tier.rankScore);
        bestItemValue = `${entry.item} (${entry.tier.name})`;
      }
    }
  }

  // Phase 1 hot-path consolidation: inventory append, catch totals, catch-log
  // ring, manual leaderboard counter and best-catch writes happen in one
  // PostgreSQL transaction when 003_performance_phase1.sql is installed.
  const catchTotals = track(recordFishingCatch(
    db,
    userKey,
    inventoryItems,
    source === 'auto' ? 'auto-fish' : 'fish',
    {
      leaderboardKey: source === 'auto' ? null : `fish:count:${userKey}`,
      bestTierKey: bestTierValue !== null ? `fish:besttier:${userKey}` : null,
      bestTierValue,
      bestItemKey: bestItemValue !== null ? `fish:bestitem:${userKey}` : null,
      bestItemValue
    }
  ), 'consolidated catch write').catch((e) => {
    console.error('[Fish Engine] consolidated catch write failed:', e);
    return null;
  });
  validCatches.forEach((entry) => track(applyItemEffects(db, userKey, entry.item, 1, { skipTimeout: true }), 'item effects'));

  validCatches.forEach((entry) => {
    track(recordFishAudit(userKey, `${source === 'auto' ? 'Auto-caught' : 'Caught'} ${entry.item} [${entry.tier.name}]${entry.area ? ` at ${entry.area.name}` : ''}${luck.eventShown ? ` during ${luck.eventName}` : ''}`), 'catch audit');
  });

  const treasuryCount = validCatches.filter((entry) => entry.tier?.luckImmune).length;
  if (treasuryCount) track(recordTreasuryEarned(userKey, treasuryCount), 'Treasury earned progress');
  const totals = await catchTotals;
  let unlockingTreasuryOnly = null;
  if (source === 'manual' && totals) {
    const manualCatchCount = Math.max(0, parseInt(await db.get(`fish:count:${userKey}`), 10) || 0);
    unlockingTreasuryOnly = track(unlockTreasuryOnlyNow(db, userKey, manualCatchCount), 'Treasury Only manual-catch unlock');
  }
  if (!totals) {
    if (usesManualCooldown) track(db.del(stateKeysFor(userKey, streamKey).cooldownEnd), 'cooldown refund');
    return finish({ ok: false, kind: 'error', text: `🎣 ${displayUser}, the catch slipped off the hook (server hiccup). No cooldown used - try !fish again.` });
  }
  const newDiscoveries = validCatches.reduce((sum, entry, index) => {
    const inventoryItem = `${entry.item} [${entry.tier.name}]`;
    return sum + (totals.get(inventoryItem) === 1 && !perkChecks[index].perkExisting ? 1 : 0);
  }, 0);
  track(recordProgress(userKey, { cast: true, catches: validCatches, newDiscoveries }), 'progression update');
  const catchParts = validCatches.map((entry, index) => {
    const inventoryItem = `${entry.item} [${entry.tier.name}]`;
    const isNewDiscovery = !!totals && totals.get(inventoryItem) === 1 && !perkChecks[index].perkExisting;
    return buildCatchMessage(entry, luck, selectedArea, isNewDiscovery, messageSettings);
  });

  // Rare-catch announcements: manual !fish only, so auto-fish does not flood the chat.
  if (source === 'manual') {
    for (const entry of validCatches) {
      if (announceQualifies(entry.tier.id, chatOpts.rareAnnounceTier)) {
        queueAnnouncement(`🎣 ${displayUser} landed a ${entry.tier.name} catch: ${toUnicodeBold(entry.item)}!`);
      }
    }
  }

  const eventMessage = messageSettings.showEvent && luck.eventShown
    ? ` ⚡ ${luck.eventName} (${Number(luck.eventLuck.toFixed(2))}x)`
    : '';
  const boostMessage = messageSettings.showBoost && luck.rarityBoostTier
    ? ` 🎯 2x ${luck.rarityBoostTier.toUpperCase()} boost`
    : '';
  const actualDoubleMessage = messageSettings.showDoubleChance && validCatches.length > 1
    ? ` 🎣 DOUBLE CATCH Lv.${doubleCatch.level} (${doubleCatch.chance}% chance)`
    : '';
  const effectMessage = perkChecks[0]?.timeoutResult?.message || '';
  const autoBrokenUntil = source === 'auto'
    ? Math.max(0, ...perkChecks.map(({ timeoutResult }) => timeoutResult?.timedOut ? (Number(timeoutResult.expiresAt) || Date.now()) : 0))
    : 0;
  const values = {
    user: displayUser,
    catch: catchParts[0]?.catch || '',
    catches: catchParts.map((part) => part.catch).join(' + '),
    tier: catchParts[0]?.tier || '',
    chance: catchParts[0]?.chance || '',
    luck: catchParts[0]?.luck || '',
    luckIcon: catchParts[0]?.luckIcon || '',
    area: catchParts[0]?.area || '',
    new: catchParts[0]?.new || '',
    event: eventMessage,
    boost: boostMessage,
    // Only shown when the double catch actually procs on this cast.
    double: validCatches.length > 1 ? actualDoubleMessage : '',
    effect: effectMessage
  };
  const template = validCatches.length > 1 ? messageSettings.doubleTemplate : messageSettings.normalTemplate;
  // Simple chat (set by the broadcaster): "<user> Caught "<item>" ☘️1.88x"
  // (💰 for treasury), joined with " + " for double catches. Mud uses the same
  // form above. Event, boost, double-catch and new-fish text are left out.
  const simpleChat = state.simpleChat === 'on';
  const simpleText = validCatches.map((entry) => {
    const part = buildCatchMessage(entry, luck, null, false, { showChance: false, showLuck: true, showArea: false, showNew: false });
    return `Caught "${entry.item}" ${part.luckIcon}${part.luck}`;
  }).join(' + ');
  let output = truncateToBytes(simpleChat ? `${displayUser} ${simpleText}` : fillFishTemplate(template, values));
  // The cast that unlocks Treasury Only gets one short message, shown whether
  // or not simple chat is on: who fished, what they caught, and the unlock notice.
  let unlockNotice = false;
  if (source === 'manual' && (await unlockingTreasuryOnly) === true) {
    unlockNotice = true;
    const caught = validCatches.map((entry) => `${toUnicodeBold(entry.item)} [${toUnicodeBold(entry.tier.name)}]`).join(' + ');
    output = truncateToBytes(`${displayUser} caught ${caught} | Treasury only mode unlocked, go to the website to enable`);
  }
  const autoProgress = source === 'auto' ? await autoProgressPromise : null;
  // First catch of a cast is the one the overlay alerts on. True when that fish is new to the viewer.
  const firstCatch = validCatches[0];
  const isNewDiscovery = !!(firstCatch && totals && totals.get(`${firstCatch.item} [${firstCatch.tier.name}]`) === 1 && !perkChecks[0]?.perkExisting);
  return finish({
    ok: true,
    text: output,
    isNewDiscovery,
    unlockNotice,
    catches: validCatches.length,
    items: inventoryItems,
    entry: validCatches[0],
    selectedArea,
    luck,
    doubleCatch,
    treasuryCount,
    autoProgress,
    autoBrokenUntil
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export { readState, computeLuck, rollCatch, weightedTierTable };

export default async function handler(req, res) {
  // No CORS wildcard: the loot table is fetched same-origin by the site and
  // the chatbot calls this server-to-server.
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query.action === 'tiers') {
    // Static loot table: cacheable at the edge.
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(TIERS);
  }

  // Keep-warm endpoint: loads the function and opens the database connection,
  // so a real !fish that follows does not pay for a cold start. Point a free
  // uptime monitor (UptimeRobot, cron-job.org) at it every 5 minutes.
  if (req.query.action === 'ping') {
    if (db) await db.get('settings:cooldown').catch(() => null);
    return res.status(200).send('ok');
  }

  // Everything below trusts the reported username (operator grants, cooldown
  // bypass), so the caller must prove it is the chatbot (lib/session.js).
  if (!checkBotSecret(req)) {
    return res.status(200).send('Unauthorized: missing or wrong caller secret.');
  }

  // StreamElements only shows the body of a 200 reply and replaces anything
  // else with "Unable to make request", so an unexpected failure becomes a
  // readable chat line (the details go to the logs).
  try {
    return await handleFish(req, res);
  } catch (error) {
    console.error('[Fish API] Unhandled error in !fish:', error);
    if (!res.headersSent) {
      return res.status(200).send('🎣 The line snapped - something broke on the server. Try again in a moment.');
    }
  }
}

async function handleFish(req, res) {
  // Serverless functions can be frozen the moment the reply is sent, so a
  // write left running "in the background" may never finish (catches missing
  // from the inventory, cooldowns never stored). Every write is registered
  // here and awaited by reply() before the message goes out. Each one has its
  // own catch, so one failing write never cuts the others short.
  const pending = [];
  const track = (promise, label) => {
    const guarded = Promise.resolve(promise).catch((e) => {
      console.error(`[Fish API] ${label} failed:`, e);
      return null;
    });
    pending.push(guarded);
    return guarded;
  };
  const reply = async (text) => {
    await Promise.all(pending);
    return res.status(200).send(text);
  };

  // Who typed the command. Nightbot authenticates the caller with the
  // Nightbot-User header, so prefer that over URL-supplied identity. This is
  // important because the username controls cooldowns, inventory and admin
  // permissions. StreamElements aliases remain supported for compatibility.
  const nightbotUser = getNightbotUser(req);
  // Nightbot's UrlFetch supplies the trusted Nightbot-Channel header with the
  // channel where the command was actually executed. Prefer it over a URL
  // parameter so per-channel events/cooldowns work even when the command was
  // configured before the channel parameter was added. StreamElements and
  // other callers can continue to provide channel/broadcaster explicitly.
  const nightbotChannel = getNightbotChannel(req);
  const rawChannel = String(
    nightbotChannel ??
    req.query?.channel ?? req.query?.broadcaster ?? req.query?.channelName ??
    req.body?.channel ?? req.body?.broadcaster ?? req.body?.channelName ?? ''
  ).trim();
  const streamKey = rawChannel ? normalizeUserKey(rawChannel) : '';
  const user = String(
    nightbotUser ??
    req.query?.user ?? req.query?.sender ?? req.query?.from ??
    req.body?.user ?? req.body?.sender ?? req.body?.from ?? ''
  );
  const userKey = normalizeUserKey(user);

  // The viewer's VIP/Sub/Mod level is looked up while the streamer check runs.
  // On a cache miss that lookup is several Twitch/database round trips, and it
  // used to run one after the other with the streamer read below it.
  const levelPromise = VIP_SUB_MOD_LUCK_ENABLED
    ? resolveUserLevel(req, userKey, streamKey)
    : Promise.resolve(0);

  // A player may fish only in the broadcaster they selected on their Profile.
  // Nightbot's channel header is trusted when present; other chatbot callers
  // must provide the explicit channel value as before. A missing channel is
  // rejected once a streamer is selected so the lock cannot be bypassed.
  // The gate always applies when a streamer is selected. A selection that is the
  // viewer's own name is not a broadcaster, so the message asks them to choose one
  // instead of naming themselves.
  const selectedStreamer = await selectedStreamerFor(userKey);
  if (selectedStreamer) {
    if (!streamKey || streamKey !== selectedStreamer) {
      const shown = selectedStreamer === userKey ? 'a streamer from the site' : selectedStreamer;
      return res.status(200).send(`🎣 You are not allowed to fish here, please change your streamer to ${shown} or any other streamer.`);
    }
  }

  // A literal "{user} / "$(sender)" here means the request did NOT come from a
  // working StreamElements command (opened in a browser, sent by hand, or the
  // query string is missing). Echo what arrived so the cause is visible.
  if (!userKey || isPlaceholderSender(userKey)) {
    const received = describeIncomingRequest(req);
    console.error(
      '[Fish API] Refusing a cast with no usable sender. user=' + JSON.stringify(user) +
      '. Received: ' + received
    );
    return res.status(200).send(
      '⚠️ No cast credited: the request carried no usable username' +
      (userKey ? ' (it sent the literal text "' + user + '")' : '') +
      ', so nothing was recorded. The API is fine - the !fish command is not ' +
      'passing a username. Received: ' + received
    );
  }

  if (!db) {
    return res.status(200).send('⚠️ The fishing database is not connected, so nothing can be cast.');
  }

  const isVipSubMod = VIP_SUB_MOD_LUCK_ENABLED && (await levelPromise) >= VIP_SUB_MOD_LEVEL;
  const isAdmin = isOperator(userKey);

  // Mirror Twitch VIP/Sub/Mod status for the website's perk toggles. The
  // stored value is read with the rest of the state below and only rewritten
  // when it changed, which removes one database write from nearly every cast.
  const vipMirrorValue = isVipSubMod ? 'true' : 'false';

  // Prestige 2 unlocks an optional chat shortcut. It deliberately lives in
  // the existing !fish endpoint so StreamElements/Nightbot need no second
  // command transport: `!fish pond` collects the ready pond catches straight
  // into inventory once the player has enabled the feature.
  const requestedChatAction = extractRequestedFish(req);
  if (String(requestedChatAction || '').trim().toLowerCase() === 'pond') {
    const autoConfig = await getAutoFishConfig();
    const autoState = await readAutoFishState(userKey, autoConfig);
    if (Number(autoState.prestige) < 2) return reply(`🐟 ${user}, !fish pond unlocks at Prestige 2.`);
    if (await db.get(pondKeys(userKey).chatUnlocked) !== 'true') {
      return reply(`🐟 ${user}, unlock Pond chat collection in the Personal Pond panel first.`);
    }
    const collected = await collectPond(userKey, { toInventory: true });
    if (!collected.success) return reply(`🐟 ${user}, ${collected.error}`);
    return reply(collected.count ? `Pond collected, caught ${collected.count} fish.` : `🐟 ${user}, your pond is empty right now.`);
  }

  // "!fish <name>" from an operator is a forced catch. A viewer typing
  // "!fish snapper" is asking to fish, not to choose, so they skip this block.
  const requestedFish = extractRequestedFish(req);

  if (isAdmin) {
    if (!isNoArg(requestedFish)) {
      track(db.set(`real_vip:${userKey}`, vipMirrorValue), 'VIP mirror');
      const result = await grantFish({
        senderKey: userKey,
        requested: requestedFish,
        providedKey: req.query?.key ?? req.body?.key,
        // checkBotSecret already passed; with BOT_SECRET configured that means
        // the secret was matched, which is what proves the caller.
        callerAuthenticated: !!process.env.BOT_SECRET,
        commandName: '!fish'
      });
      return reply(result.text);
    }
  }

  // Only a normal no-argument !fish gets the onboarding gate. Pond collection
  // and operator forced catches above keep their existing behavior. Claiming
  // happens before the roll, so the first !fish never consumes cooldown, bait,
  // inventory, or any other normal fishing state.
  if (isNoArg(requestedFish) && await claimFirstFishTutorial(userKey)) {
    return reply(
      `🎣 Seems like you're new here! Keep fishing with !fish. Ask the streamer for the local game guide if you need help getting started.`
    );
  }

  // Read the broadcaster's "hide replies" setting while the cast runs, so it adds no extra wait.
  const hideChatPromise = hideFishChatOn(streamKey);
  const result = await performFishingCast(userKey, {
    displayUser: user,
    streamKey,
    isVipSubMod,
    source: 'manual',
    bypassCooldown: isAdmin
  });
  const hideChat = await hideChatPromise;
  if (result.ok && result.catches > 0 && result.entry && !result.unlockNotice) {
    // Overlay event for manual catches only. Registered with track(), so reply() waits for it.
    const stats = catchLuckStats(result.entry.tier, result.luck);
    track(recordOverlayCatch(streamKey, {
      user,
      item: result.entry.item,
      tierId: result.entry.tier?.id,
      tierName: result.entry.tier?.name,
      luck: stats.luck,
      weight: stats.weight,
      discovery: !!result.isNewDiscovery
    }), 'overlay event');
    // Hidden only for normal catch lines. Cooldown, errors and the Treasury Only notice still show.
    if (hideChat) return reply('');
  }
  return reply(result.text);
}
