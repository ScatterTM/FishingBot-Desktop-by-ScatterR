// Granting a specific fish to a player, shared by the two chat entry points:
//   /api/fish      - "!fish <name>", when the sender is an operator
//   /api/givefish  - "!givefish <name>"
//
// Both previously could have owned this, and did diverge: the admin panel
// (api/admin/action.js) had its own grant path that applied a different set of
// item effects, so the same fish behaved differently depending on how it
// arrived. One implementation, one set of rules.
//
// Security note. The operator allowlist alone is NOT sufficient: the username
// is supplied by the caller, so anyone who could reach the endpoint could claim
// to be an operator and grant themselves a permanent perk. A grant therefore
// needs the sender to be on the allowlist AND the caller to be proven, in one
// of two ways:
//   - callerAuthenticated: the request already passed checkBotSecret with
//     BOT_SECRET configured, i.e. it came from the chatbot command whose URL
//     holds that secret. This is what lets a single "!fish" command handle
//     "!fish" and "!fish <name>" without a second key in the URL.
//   - a valid key= matching ADMIN_SECRET, for setups without BOT_SECRET.
// If BOT_SECRET is not set the first route is closed and key= is required.

import { db } from './db.js';
import { timingSafeStringEqual } from './session.js';
import { applyItemEffects } from './effects.js';
import { addInventoryItems, recordCatch } from './inventory.js';
import { recordAdminAudit } from './audit.js';
import { lookupFish, lookupTier, suggestFish } from './fishcatalog.js';
import { isNoArg, cleanText, normalizeUserKey } from './chatargs.js';
import { toUnicodeBold, truncateToBytes } from './chattext.js';

const FISH_OVERRIDE_USERS = [
  'tm_scatterr',
  'sys_fishinghub',
  ...(process.env.FISH_OVERRIDE_USERS || '')
    .split(',')
    .map((name) => name.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
];

export function isOperator(userKey) {
  return FISH_OVERRIDE_USERS.includes(userKey);
}

// "!givefish 1.5x luck @viewer" -> { name: "1.5x luck", target: "viewer" }
// A mention anywhere in the text is the target; the rest is the fish.
function splitTarget(text) {
  const mention = text.match(/@([A-Za-z0-9_]{2,32})/);
  if (!mention) return { name: text, target: null };
  return {
    name: (text.slice(0, mention.index) + text.slice(mention.index + mention[0].length)).trim(),
    target: mention[1]
  };
}

// Resolve a typed name to a catalog entry, or a random item from a named tier
// ("tier:legendary"). Returns { entry, randomFromTier } or null.
function resolveEntry(fishQuery) {
  const asTier = lookupTier(fishQuery);
  if (asTier && asTier.items.length) {
    return {
      randomFromTier: true,
      entry: {
        tier: asTier,
        item: asTier.items[Math.floor(Math.random() * asTier.items.length)]
      }
    };
  }
  const hit = lookupFish(fishQuery);
  return hit ? { entry: hit, randomFromTier: false } : null;
}

/**
 * Attempt to grant the fish named in `requested` to `senderKey` (or to a
 * mentioned user). Returns { granted: true, text } on success, or
 * { granted: false, text } with the reason the request was refused.
 *
 * `commandName` is only used to phrase the usage hint.
 */
export async function grantFish({ senderKey, requested, providedKey, callerAuthenticated = false, commandName = '!fish' }) {
  if (!db) {
    return { granted: false, text: '⚠️ The fishing database is not connected, so nothing can be given.' };
  }

  // --- gate 1: prove the caller ---------------------------------------------
  const adminSecret = process.env.ADMIN_SECRET;
  const keySupplied = !!providedKey && !isNoArg(providedKey);
  const keyValid = keySupplied && !!adminSecret && timingSafeStringEqual(providedKey, adminSecret);

  // A key that is present but wrong is refused even for an authenticated
  // caller: it means somebody is guessing, or the command holds a stale key.
  if (keySupplied && !keyValid) {
    console.warn('[grantFish] Refused: wrong admin key.');
    return { granted: false, text: '⚠️ Refused: wrong admin key.' };
  }
  if (!keyValid && !callerAuthenticated) {
    if (!adminSecret) {
      console.error('[grantFish] Neither BOT_SECRET nor ADMIN_SECRET is set: refusing every grant.');
      return {
        granted: false,
        text: `⚠️ ${commandName} <name> is disabled: set BOT_SECRET (and &secret=... on the command) ` +
              'or ADMIN_SECRET (and &key=...) in the local .env file.'
      };
    }
    console.warn('[grantFish] Refused: no key and the caller is not authenticated.');
    return {
      granted: false,
      text: `⚠️ ${commandName} <name> needs the admin key: add &key=... to the command, ` +
            'or set BOT_SECRET and &secret=... so the command itself is trusted.'
    };
  }

  // --- gate 2: the allowlist ----------------------------------------------
  if (!isOperator(senderKey)) {
    console.warn(`[grantFish] Refused: "${senderKey}" is not an operator.`);
    return { granted: false, text: 'Only channel operators can give a specific fish.' };
  }

  // --- what fish -----------------------------------------------------------
  if (isNoArg(requested)) {
    return {
      granted: false,
      text: `Usage: ${commandName} <name> - e.g. ${commandName} 1.5x luck, ` +
            `${commandName} vipfish, or ${commandName} tier:legendary for a random one ` +
            'from a rarity. Add @user to give it to somebody else.'
    };
  }

  const { name: fishQuery, target: mentioned } = splitTarget(requested);
  const creditKey = mentioned ? normalizeUserKey(mentioned) : senderKey;
  if (mentioned && !creditKey) {
    return { granted: false, text: '⚠️ That does not look like a Twitch username. Try @name with no spaces.' };
  }

  const resolved = resolveEntry(fishQuery);
  if (!resolved) {
    const suggestions = suggestFish(fishQuery, 3);
    const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
    console.warn(`[grantFish] No catalog match for "${fishQuery}" (from ${senderKey}).`);
    return {
      granted: false,
      text: `⚠️ No fish matching "${cleanText(fishQuery).slice(0, 60)}" is in the loot table.${hint}`
    };
  }

  const { entry, randomFromTier } = resolved;
  const { tier, item } = entry;
  const inventoryItem = `${item} [${tier.name}]`;

  // --- grant ---------------------------------------------------------------
  // The same shared effects a natural catch applies, so an operator testing
  // "does 1.5x Luck actually work?" gets the real behaviour, not a stub.
  let effects = [];
  try {
    await addInventoryItems(db, creditKey, inventoryItem);
    await recordCatch(db, creditKey, inventoryItem, 'forced');
    effects = await applyItemEffects(db, creditKey, item, 1);
  } catch (e) {
    console.error('[grantFish] Grant failed:', e);
    return { granted: false, text: '⚠️ The fish could not be saved. Check the local server logs.' };
  }

  // Awaited: on a serverless host a write left running after the reply is sent
  // can be dropped when the function is frozen.
  await recordAdminAudit(db, {
    actor: senderKey,
    action: 'givefish',
    target: creditKey,
    details: `${item} [${tier.name}]${randomFromTier ? ' (random from tier)' : ''}`
  }).catch((e) => console.error('[grantFish] Audit write failed:', e));

  // Report what was actually granted, not just that something happened. An
  // operator forcing a perk fish needs to see the perk switch flip.
  const forOther = creditKey !== senderKey;
  const who = forOther ? ` for @${creditKey}` : '';
  const badge = tier.badge.replace(tier.name, toUnicodeBold(tier.name));
  const effectText = effects.length ? ` ✨ ${effects.join(', ')}.` : '';

  console.log(`[grantFish] ${senderKey} -> ${creditKey}: ${item} [${tier.name}]`, effects);

  return {
    granted: true,
    text: truncateToBytes(`🎯 Gave ${toUnicodeBold(item)} [${badge}]${who}.${effectText}`)
  };
}

