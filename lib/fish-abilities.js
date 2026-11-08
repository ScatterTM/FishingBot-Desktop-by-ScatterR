// Local configurable fish abilities. The hosted edition deliberately ignores
// desktop-only custom abilities; its catalogue/effects remain code-owned.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FILE = process.env.LOCAL_LOOT_TABLE_PATH || path.resolve(process.cwd(), 'data', 'loot-table.json');
const MAX_DURATION_MINUTES = 20;

export function readFishAbilities() {
  if (process.env.LOCAL_EDITION !== '1') return {};
  try {
    const saved = JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8'));
    return saved && saved.abilities && typeof saved.abilities === 'object' && !Array.isArray(saved.abilities)
      ? saved.abilities
      : {};
  } catch (_) { return {}; }
}

export function getFishAbility(fishName) {
  const wanted = String(fishName || '').trim().toLocaleLowerCase('en-US');
  if (!wanted) return null;
  const abilities = readFishAbilities();
  const match = Object.entries(abilities).find(([name]) => String(name).trim().toLocaleLowerCase('en-US') === wanted);
  if (!match) return null;
  const raw = match[1] || {};
  const effectTypes = new Set(['luck', 'weight', 'treasuryLuck', 'cooldownReduction', 'timeout']);
  const effectType = effectTypes.has(raw.effectType) ? raw.effectType : '';
  const effectValue = Number(raw.effectValue);
  const durationMinutes = Math.max(1, Math.min(MAX_DURATION_MINUTES, Number(raw.durationMinutes) || 10));
  const timeoutMinutes = Math.max(1, Math.min(MAX_DURATION_MINUTES, Number(raw.timeoutMinutes) || durationMinutes));
  const cooldownReductionPct = Math.max(0, Math.min(80, Number(raw.cooldownReductionPct) || 0));
  if (!effectType) return null;
  return {
    fishName: match[0],
    perkName: String(raw.perkName || `${match[0]} Perk`).slice(0, 48),
    description: String(raw.description || '').slice(0, 240),
    effectType,
    effectValue: Number.isFinite(effectValue) ? Math.max(0, Math.min(10, effectValue)) : 1.25,
    durationMinutes,
    timeoutMinutes,
    cooldownReductionPct
  };
}

export function activeCustomEffectTotals(raw, now = Date.now()) {
  let entries = [];
  try { entries = Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]')); } catch (_) { entries = []; }
  if (!Array.isArray(entries)) entries = [];
  const active = entries.filter((entry) => Number(entry?.expiresAt) > now && Number(entry.expiresAt) <= now + MAX_DURATION_MINUTES * 60_000 + 60_000);
  let luckMultiplier = 1, weightMultiplier = 1, treasuryLuckMultiplier = 1, cooldownReductionPct = 0;
  for (const entry of active) {
    const value = Math.max(0, Math.min(10, Number(entry.value) || 1));
    if (entry.type === 'luck') luckMultiplier *= value;
    else if (entry.type === 'weight') weightMultiplier *= value;
    else if (entry.type === 'treasuryLuck') treasuryLuckMultiplier *= value;
    else if (entry.type === 'cooldownReduction') cooldownReductionPct = Math.max(cooldownReductionPct, Math.max(0, Math.min(80, Number(entry.cooldownReductionPct ?? entry.value) || 0)));
  }
  return {
    active,
    luckMultiplier: Math.min(10, luckMultiplier),
    weightMultiplier: Math.min(10, weightMultiplier),
    treasuryLuckMultiplier: Math.min(10, treasuryLuckMultiplier),
    cooldownReductionPct
  };
}

export async function applyFishAbility(db, userKey, fishName, opts = {}) {
  const ability = getFishAbility(fishName);
  if (!ability) return { ability: null, timeoutResult: null };
  if (ability.effectType === 'timeout') {
    if (opts.skipTimeout) return { ability, timeoutResult: null };
    const { applyTimeoutWithShieldDuration } = await import('./shields.js');
    const timeoutResult = await applyTimeoutWithShieldDuration(
      db,
      userKey,
      ability.timeoutMinutes * 60,
      { timeoutKey: opts.timeoutKey || `timeout:${userKey}` }
    );
    return { ability, timeoutResult };
  }

  const key = `fish:custom_effects:${String(userKey).toLowerCase()}`;
  const currentRaw = await db.get(key).catch(() => null);
  const totals = activeCustomEffectTotals(currentRaw);
  const durationMs = Math.max(60_000, Math.min(MAX_DURATION_MINUTES * 60_000, ability.durationMinutes * 60_000));
  const now = Date.now();
  const effect = {
    fishName: ability.fishName,
    perkName: ability.perkName,
    description: ability.description,
    type: ability.effectType,
    value: ability.effectType === 'cooldownReduction' ? ability.cooldownReductionPct : ability.effectValue,
    cooldownReductionPct: ability.cooldownReductionPct,
    expiresAt: now + durationMs
  };
  const keep = totals.active.filter((entry) => !(String(entry.fishName).toLowerCase() === String(ability.fishName).toLowerCase() && entry.type === ability.effectType));
  keep.push(effect);
  await db.set(key, JSON.stringify(keep), { ex: MAX_DURATION_MINUTES * 60 });
  return { ability, timeoutResult: null };
}
