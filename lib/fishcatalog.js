// Resolving a typed fish name against the loot table in lib/tiers.js.
//
// 180 items across 8 tiers, and an operator typing "!givefish the ancient
// leviathan" at speed should not have to reproduce the catalog's exact
// capitalisation, punctuation or articles. This is the single definition of
// "does this name mean a fish", used by /api/givefish and by the admin panel.

import { TIERS } from './tiers.js';

// Two keys per item: the full catalog string, and the bare name with any
// trailing "(...)" qualifier removed, so both "1.5x Luck (permanent)" and
// "1.5x Luck" resolve to the same entry.
const CATALOG = new Map();

// Full names first, bare names second. In a single pass a later item's bare
// name could overwrite an earlier item's full name, so the same words resolved
// to a different fish depending on catalog order. A bare name is only a
// convenience alias and never shadows a real one.
for (const tier of TIERS) {
  for (const item of tier.items) {
    CATALOG.set(item.toLowerCase(), { tier, item });
  }
}
for (const tier of TIERS) {
  for (const item of tier.items) {
    const baseName = item.toLowerCase().split('(')[0].trim();
    if (baseName && !CATALOG.has(baseName)) CATALOG.set(baseName, { tier, item });
  }
}

// Tiers are also addressable by name, so an operator can roll a random item
// from a rarity instead of naming one: "!givefish tier:legendary".
const TIER_ALIASES = new Map();
for (const tier of TIERS) {
  TIER_ALIASES.set(tier.name.toLowerCase(), tier);
  TIER_ALIASES.set(tier.id.toLowerCase(), tier);
}

// Chat drops articles people type casually. Try the query as typed, with a
// leading article stripped, and with each leading article prepended - the
// article can be missing OR spurious.
function articleVariants(term) {
  const bases = [term];
  const withoutArticle = term.replace(/^(the|an|a)\s+/, '').trim();
  if (withoutArticle && withoutArticle !== term) bases.push(withoutArticle);
  for (const article of ['the ', 'a ', 'an ']) {
    const withArticle = (article + term).trim();
    if (!bases.includes(withArticle)) bases.push(withArticle);
  }
  for (const base of [...bases]) {
    const trimmed = base.replace(/\s+(the|an|a)$/, '').trim();
    if (trimmed && !bases.includes(trimmed)) bases.push(trimmed);
  }
  return bases;
}

export function lookupFish(searchTerm) {
  const term = String(searchTerm || '').toLowerCase().trim();
  if (!term) return null;

  const direct = CATALOG.get(term);
  if (direct) return direct;

  // Strip a trailing "[TIER]" - that is how inventory items are stored.
  const withoutTier = term.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  if (withoutTier !== term) {
    const hit = CATALOG.get(withoutTier);
    if (hit) return hit;
  }

  const bases = articleVariants(withoutTier);

  // Progressively shorter prefixes of each word, so a trailing comment
  // ("the ancient leviathan pls") still resolves.
  for (const base of bases) {
    const words = base.split(/\s+/).filter(Boolean);
    for (let take = words.length; take > 0; take--) {
      const hit = CATALOG.get(words.slice(0, take).join(' '));
      if (hit) return hit;
    }
  }

  return null;
}

// "!givefish tier:legendary" or "!givefish legendary" -> that tier, or null.
export function lookupTier(term) {
  const raw = String(term || '').toLowerCase().trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^tier[:=]\s*/, '');
  return TIER_ALIASES.get(cleaned) || null;
}

// Levenshtein distance, bounded: a name is only ever compared against a short
// query, so the full matrix is cheap. Capped so a long word cannot be "close"
// to a short one just because the numbers happen to line up.
function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      last = temp;
    }
  }
  return prev[b.length];
}

// Two words count as the same word if one is a prefix of the other (a
// truncated or over-typed word) or they are within two edits (a transposition
// such as "leviathen" for "leviathan").
function sameWord(queryWord, keyWord) {
  if (queryWord === keyWord) return true;
  if (keyWord.startsWith(queryWord) || queryWord.startsWith(keyWord)) return true;
  if (Math.min(queryWord.length, keyWord.length) < 4) return false;
  return editDistance(queryWord, keyWord) <= 2;
}

// Close matches for a name that did not resolve. With 180 items, a typo should
// suggest the intended fish rather than just reporting failure.
//
// Two signals, in order. Rejoining the words first is what catches a name typed
// in the wrong place - "vip fis" squashes to "vipfis", a prefix of "vipfish",
// which no amount of word-by-word comparison can see. Without that, every
// *fish in the table matched "fis" and the intended item sank below Oarfish.
// Failing that, coverage counts how much of the query the name explains.
export function suggestFish(searchTerm, limit = 3) {
  const term = String(searchTerm || '').toLowerCase().trim();
  if (!term) return [];

  const squashed = term.replace(/[^a-z0-9.]/g, '');
  // Three characters minimum. At two, "lucks" matched "duck" and the real
  // answer was pushed out of the list entirely.
  const queryWords = term.split(/[^a-z0-9.]+/).filter((w) => w.length >= 3);
  if (!queryWords.length) return [];

  const scored = [];
  for (const [key, entry] of CATALOG) {
    const keyWords = key.split(/[^a-z0-9.]+/).filter(Boolean);

    // Strongest signal: the whole query, spaces removed, lines up with the name.
    const keySquashed = key.replace(/[^a-z0-9.]/g, '');
    let score = 0;
    if (squashed.length >= 3 &&
        (keySquashed.startsWith(squashed) || squashed.startsWith(keySquashed))) {
      score = 1000;
    } else {
      let matched = 0;
      for (const qw of queryWords) {
        if (keyWords.some((kw) => sameWord(qw, kw))) matched++;
      }
      if (matched) score = matched / queryWords.length;
    }
    if (score) scored.push({ item: entry.item, score, len: entry.item.length });
  }

  // Highest score first, then shortest name, so the suggestion is the most
  // specific match available.
  scored.sort((a, b) => b.score - a.score || a.len - b.len);

  // Only names that explain the WHOLE query are worth offering. A name
  // matching half of it is usually a coincidence - "!givefish 1.5x lucks"
  // pulled in "Lucky Duck" on the strength of "luck" alone, and the length
  // tie-break then pushed the real answer off the list. Partial matches are
  // used only when nothing covers the query completely.
  const best = scored.length ? scored[0].score : 0;
  const full = best >= 1 ? scored.filter((s) => s.score >= 1) : scored;

  const seen = new Set();
  const out = [];
  for (const s of full) {
    if (seen.has(s.item)) continue;
    seen.add(s.item);
    out.push(s.item);
    if (out.length >= limit) break;
  }
  return out;
}
