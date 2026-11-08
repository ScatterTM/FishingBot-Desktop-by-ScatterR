// Side effects of catching an item. Single source of truth: both the natural
// !fish roll (api/fish.js) and the admin grant (api/admin/action.js) import
// this, so a perk-granting item behaves identically however it arrives.
//
// This used to exist twice. api/fish.js carried an inline copy covering only
// three items, with a case-sensitive match against the catalog's own
// capitalisation - so an admin forcing `!fish vipfish` applied the effect and
// most other items silently did not. One definition, one set of rules.

import { applyTimeoutWithShield } from './shields.js';
import { applyFishAbility } from './fish-abilities.js';

// Matched on a lowercased substring rather than the full catalog string.
// The catalog capitalises inconsistently ("Vipfish (gives VIP role)" but
// "Seamine (10min timeout)"), so an exact match silently stops working the
// first time someone tidies a name. Verified against every tier in
// lib/tiers.js: exactly five items grant an effect.
const PERK_RULES = [
  { needle: 'vipfish', key: 'game_vip', toggle: 'vip', label: 'granted VIP luck' },
  { needle: '1.5x luck', key: 'perm_luck', toggle: 'perm', label: 'activated 1.5x Permanent Luck' },
  { needle: '2x luck', key: 'temp_luck', toggle: 'temp', ttl: 600, label: 'activated 2x Luck for 10 minutes' }
];

// `skipTimeout` is for the caller that has already run the shield check
// itself - api/fish.js does that BEFORE the catch is added to the inventory,
// because a Shieldfish granted by this very cast must not shield itself.
export async function applyItemEffects(db, userKey, fishName, amount = 1, opts = {}) {
  const lower = String(fishName || '').toLowerCase();
  const effects = [];

  // Shieldfish needs no counter update: "shields available" is always derived
  // live from however many are sitting in fish:rares (see lib/shields.js),
  // which the caller has just added this catch to.
  if (lower.includes('shieldfish')) {
    effects.push(amount > 1 ? `added ${amount} shields` : 'added a shield');
  }

  for (const rule of PERK_RULES) {
    if (!lower.includes(rule.needle)) continue;

    const key = `${rule.key}:${userKey}`;
    const existing = await db.get(key);
    if (!existing) {
      if (rule.ttl) await db.set(key, 'true', { ex: rule.ttl });
      else await db.set(key, 'true');
      effects.push(rule.label);
    } else if (rule.ttl) {
      // A TTL perk that is still running stays as it is; granting refreshes it.
      const ttl = Number(await db.ttl(key));
      if (ttl <= 0) await db.set(key, 'true', { ex: rule.ttl });
    }

    // Set the toggle explicitly. Deleting the key (the old behaviour) left
    // the read side guessing, and a mod whose real_vip had not been mirrored
    // yet by the chat bot read as inactive.
    if (rule.toggle) await db.set(`toggle:${rule.toggle}:${userKey}`, 'on');
  }

  // Local custom abilities are stored with the loot table and applied from
  // this shared effect path, so both natural catches and admin grants agree.
  try {
    const custom = await applyFishAbility(db, userKey, fishName, {
      skipTimeout: !!opts.skipTimeout,
      timeoutKey: opts.timeoutKey || `timeout:${userKey}`
    });
    if (custom.ability && custom.ability.effectType !== 'timeout') {
      effects.push(`activated ${custom.ability.perkName} for ${custom.ability.durationMinutes} minutes`);
    }
  } catch (error) {
    console.error('[effects] Custom fish ability failed:', error?.message || error);
  }

  // Timeout items go through the exact same shield-check-then-timeout logic as
  // a real catch. Callers that already did that pass skipTimeout.
  if (!opts.skipTimeout && (lower.includes('soggyboot') || lower.includes('seamine'))) {
    const result = await applyTimeoutWithShield(db, userKey, fishName);
    if (result.timedOut) effects.push('applied the timeout');
    else if (result.applied) effects.push('used up a shield to block the timeout');
  }

  return effects;
}
