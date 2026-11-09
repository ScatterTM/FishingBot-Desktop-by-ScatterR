// Global chat and cast-message options set in the Control Centre (Game settings).
// These apply to everyone. Per-viewer message templates stay in lib/fish-format.js.
import { db } from './db.js';
import { TIERS } from './tiers.js';

export const CHAT_OPTIONS = {
  chatDetail: ['full', 'short', 'off'],
  cooldownReply: ['reply', 'silent'],
  rareAnnounceTier: ['off', 'rare', 'epic', 'legendary'],
  chatCommandReply: ['public', 'whisper']
};

export const CHAT_DEFAULTS = { chatDetail: 'full', cooldownReply: 'reply', rareAnnounceTier: 'off', chatCommandReply: 'public' };

const KEYS = {
  chatDetail: 'settings:chatDetail',
  cooldownReply: 'settings:cooldownReply',
  rareAnnounceTier: 'settings:rareAnnounceTier',
  chatCommandReply: 'settings:chatCommandReply'
};

// Minimum rankScore (from lib/tiers.js) that counts as "at least" each announcement level.
const ANNOUNCE_MIN_SCORE = { rare: 3, epic: 5, legendary: 6 };

// Checks a payload from the Control Centre. `undefined` means the field was not sent, so nothing changes.
export function validateChatSettings(input) {
  if (input === undefined) return { ok: true, value: null };
  if (!input || typeof input !== 'object') return { ok: false, status: 400, error: 'Chat message settings are missing.' };
  const value = {};
  for (const [key, allowed] of Object.entries(CHAT_OPTIONS)) {
    const candidate = key === 'chatCommandReply' && input[key] === undefined ? CHAT_DEFAULTS[key] : input[key];
    if (!allowed.includes(candidate)) {
      return { ok: false, status: 400, error: `${key} must be one of: ${allowed.join(', ')}.` };
    }
    value[key] = candidate;
  }
  return { ok: true, value };
}

export async function readChatSettings() {
  const out = { ...CHAT_DEFAULTS };
  if (!db) return out;
  const names = Object.keys(KEYS);
  const raw = await db.mget(names.map((name) => KEYS[name])).catch(() => []);
  names.forEach((name, i) => {
    if (CHAT_OPTIONS[name].includes(raw?.[i])) out[name] = raw[i];
  });
  return out;
}

export async function saveChatSettings(value) {
  await Promise.all(Object.keys(KEYS).map((name) => db.set(KEYS[name], value[name])));
}

// "short" keeps the catch name and drops the extras (chance, luck, area, new, event, boost, double).
export function applyChatDetail(messageSettings, chatDetail) {
  if (chatDetail !== 'short') return messageSettings;
  return {
    ...messageSettings,
    showChance: false, showLuck: false, showArea: false, showNew: false,
    showEvent: false, showBoost: false, showDoubleChance: false
  };
}

export function announceQualifies(tierId, setting) {
  if (!ANNOUNCE_MIN_SCORE[setting]) return false;
  const tier = TIERS.find((t) => t.id === tierId);
  if (!tier || tier.id === 'treasury') return false;
  return (Number(tier.rankScore) || 0) >= ANNOUNCE_MIN_SCORE[setting];
}

// Announcements are produced by the fish engine (api/fish.js) and sent to chat by the
// bot (local/twitch-bot.js). Both run in the same process in the local edition.
const announcements = [];
export function queueAnnouncement(text) {
  if (!text) return;
  announcements.push(String(text));
  if (announcements.length > 20) announcements.shift();
}
export function takeAnnouncements() {
  return announcements.splice(0, announcements.length);
}
