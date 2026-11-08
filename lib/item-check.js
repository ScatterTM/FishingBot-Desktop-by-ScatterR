// Matches inventory strings such as "Koi [RARE]" against the loot catalogue.
// Used by the viewer import preview and the Control Centre, so both report the
// same rarity for the same item. Pure functions only: no database or I/O.
import { TIERS } from './tiers.js';

// Only a trailing "[LABEL]" or "(LABEL)" counts as a rarity suffix, and only
// when LABEL is a real rarity name or id. "Vipfish (gives VIP role)" therefore
// keeps its parentheses.
function rarityLabels(tiers) {
  const labels = new Map();
  for (const tier of tiers) {
    labels.set(String(tier.name).trim().toLowerCase(), tier);
    labels.set(String(tier.id).trim().toLowerCase(), tier);
  }
  return labels;
}

export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u0060\u00b4]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

// Parts of a name that are not the fish itself, e.g. "(protect from timeout)".
export function coreName(value) {
  return normalizeName(String(value ?? '').replace(/\s*\([^)]*\)\s*$/, ''));
}

export function parseInventoryItem(raw, tiers = TIERS) {
  const text = String(raw ?? '').trim();
  const match = text.match(/^(.*?)\s*[\[(]([^\[\]()]+)[\])]\s*$/);
  if (match) {
    const tier = rarityLabels(tiers).get(match[2].trim().toLowerCase());
    if (tier) return { name: match[1].trim(), suffixTier: tier, raw: text };
  }
  return { name: text, suffixTier: null, raw: text };
}

function levenshtein(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

// Suggests catalogue names close to an unknown name. Names in the rarity the
// inventory string claims come first, then any other rarity.
export function suggestSimilar(name, tiers = TIERS, preferredTier = null, max = 3) {
  const wanted = normalizeName(name);
  const wantedCore = coreName(name);
  if (!wanted) return [];
  const scored = [];
  for (const tier of tiers) {
    for (const item of tier.items || []) {
      const candidate = normalizeName(item);
      const candidateCore = coreName(item);
      const limit = Math.max(2, Math.floor(Math.max(wantedCore.length, candidateCore.length) * 0.25));
      let distance = Math.min(levenshtein(wantedCore, candidateCore, limit), levenshtein(wanted, candidate, limit));
      const substring = wantedCore.length >= 4 && candidateCore.length >= 4 && (candidateCore.includes(wantedCore) || wantedCore.includes(candidateCore));
      if (substring) distance = Math.min(distance, 1);
      if (distance > limit) continue;
      const rarityBonus = preferredTier && tier.id === preferredTier.id ? -0.5 : 0;
      scored.push({ name: String(item), tierId: tier.id, tierName: tier.name, score: distance + rarityBonus });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, max).map(({ name: itemName, tierId, tierName }) => ({ name: itemName, tierId, tierName }));
}

// Checks inventory strings against the catalogue. Returns counts plus the items
// that need a human look: unknown names (with suggestions) and rarity labels
// that disagree with the catalogue.
export function checkInventoryItems(rawItems, tiers = TIERS, limit = 50) {
  const report = {
    total: 0,
    matched: 0,
    unknownCount: 0,
    mismatchCount: 0,
    byRarity: {},
    unknown: [],
    mismatched: []
  };
  const catalogue = new Map();
  for (const tier of tiers) {
    for (const item of tier.items || []) {
      const key = normalizeName(item);
      if (!catalogue.has(key)) catalogue.set(key, tier);
    }
  }
  for (const raw of rawItems || []) {
    const parsed = parseInventoryItem(raw, tiers);
    if (!parsed.name) continue;
    report.total += 1;
    const catalogueTier = catalogue.get(normalizeName(parsed.name)) || null;
    if (!catalogueTier) {
      report.unknownCount += 1;
      if (report.unknown.length < limit) {
        report.unknown.push({
          item: parsed.raw,
          name: parsed.name,
          claimedRarity: parsed.suffixTier ? parsed.suffixTier.name : null,
          suggestions: suggestSimilar(parsed.name, tiers, parsed.suffixTier)
        });
      }
      const label = parsed.suffixTier ? parsed.suffixTier.id : 'unmatched';
      report.byRarity[label] = (report.byRarity[label] || 0) + 1;
      continue;
    }
    report.matched += 1;
    report.byRarity[catalogueTier.id] = (report.byRarity[catalogueTier.id] || 0) + 1;
    if (parsed.suffixTier && parsed.suffixTier.id !== catalogueTier.id) {
      report.mismatchCount += 1;
      if (report.mismatched.length < limit) {
        report.mismatched.push({ item: parsed.raw, name: parsed.name, claimedRarity: parsed.suffixTier.name, catalogueRarity: catalogueTier.name });
      }
    }
  }
  return report;
}

// Finds names in a loot draft that look like duplicates of each other (same
// name once case, accents, apostrophes and spacing are ignored).
export function findNormalizedDuplicates(names) {
  const groups = new Map();
  for (const name of names || []) {
    const key = normalizeName(name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(String(name));
  }
  return [...groups.values()].filter((group) => group.length > 1);
}
