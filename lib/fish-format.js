import { db } from './db.js';

const DEFAULTS = {
  normalTemplate: '{user} cast their line and caught a {catch}{event}{boost}{double}{effect}',
  doubleTemplate: '{user} double catch! {catches}{double}{event}{boost}{effect}',
  showChance: true,
  showLuck: true,
  showArea: true,
  showNew: true,
  showEvent: true,
  showBoost: true,
  showDoubleChance: true
};

const BOOL_KEYS = ['showChance','showLuck','showArea','showNew','showEvent','showBoost','showDoubleChance'];
const MAX_TEMPLATE = 100;
const TEMPLATE_TOKEN_REGEX = /\{(user|catch|catches|tier|chance|luck|luckIcon|area|new|event|boost|double|effect)\}/gi;

function cleanTemplate(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, MAX_TEMPLATE);
  return cleaned || fallback;
}

// A message that starts with "/" is treated by chat as a bot / Twitch command.
// Only "/me" is allowed; anything else (e.g. /announce) is rejected.
export function blockedSlashCommand(text) {
  const match = /^\/(\S*)/.exec(String(text || '').trim());
  if (!match) return null;
  return match[1].toLowerCase() === 'me' ? null : `/${match[1]}`;
}

// "@" is not allowed anywhere in a custom template: it would let a player make
// the bot ping other chatters. (Fish-effect text and usernames are inserted by
// the bot itself and are not affected by this rule.)
export function containsAtSign(text) {
  return /[@＠﹫]/.test(String(text || ''));
}

export function validateFishTemplate(value, fallback) {
  const cleaned = cleanTemplate(value, fallback);
  const seen = new Set();
  const duplicate = [];
  for (const match of cleaned.matchAll(TEMPLATE_TOKEN_REGEX)) {
    const token = match[1].toLowerCase();
    if (seen.has(token)) duplicate.push(`{${token}}`);
    seen.add(token);
  }
  return { cleaned, duplicateTokens: [...new Set(duplicate)], blockedCommand: blockedSlashCommand(cleaned), hasAtSign: containsAtSign(cleaned) };
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  return fallback;
}

async function readSettings(userKey) {
  const raw = await db.mget([
    `fish_format:normal:${userKey}`,
    `fish_format:double:${userKey}`,
    ...BOOL_KEYS.map((key) => `fish_format:${key}:${userKey}`)
  ]);
  const [normalTemplate, doubleTemplate, ...flags] = raw || [];
  // A template that was saved before slash commands / "@" were blocked falls back to the default.
  const safeTemplate = (value, fallback) => {
    const check = validateFishTemplate(value, fallback);
    return (check.blockedCommand || check.hasAtSign) ? fallback : check.cleaned;
  };
  const safeNormal = safeTemplate(normalTemplate, DEFAULTS.normalTemplate);
  const safeDouble = safeTemplate(doubleTemplate, DEFAULTS.doubleTemplate);
  // Keep single- and double-catch messages semantically correct even if an
  // older/custom saved template was written before the two modes were
  // separated. Treasury-only messages bypass these templates entirely.
  const normalHasCatch = /\{catch\}/i.test(safeNormal);
  const doubleHasCatches = /\{catches\}/i.test(safeDouble);
  const settings = {
    normalTemplate: normalHasCatch ? safeNormal : DEFAULTS.normalTemplate,
    doubleTemplate: doubleHasCatches ? safeDouble : DEFAULTS.doubleTemplate
  };
  BOOL_KEYS.forEach((key, i) => { settings[key] = bool(flags[i], DEFAULTS[key]); });
  return settings;
}

// Admin: remove every player's saved custom message templates so everyone is
// back on the system default. Only the two text templates are touched - the
// "Show ..." checkboxes are left as the players set them.
async function resetAllCustomTemplates() {
  const found = new Set();
  for (const kind of ['normal', 'double']) {
    const [, keys] = await db.scan('0', { match: `fish_format:${kind}:*` });
    for (const key of keys || []) {
      if (typeof key === 'string' && key.startsWith(`fish_format:${kind}:`)) found.add(key);
    }
  }
  const all = [...found];
  // Delete in chunks so a very large player base can't build one oversized request.
  for (let i = 0; i < all.length; i += 200) await db.del(all.slice(i, i + 200));
  return all.length;
}

export { DEFAULTS as FISH_MESSAGE_DEFAULTS, readSettings as readFishMessageSettings, resetAllCustomTemplates };
