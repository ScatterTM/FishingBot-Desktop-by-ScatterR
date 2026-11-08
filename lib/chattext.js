// Chat text formatting shared by the fishing endpoints.

// Mathematical bold, so a fish name stands out in a busy Twitch chat.
// Punctuation and spaces are left alone - the Unicode block has no glyphs for
// them, and the fallback would render as an empty box.
export function toUnicodeBold(str) {
  return String(str ?? '').replace(/[a-zA-Z0-9]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
    return char;
  });
}

// StreamElements' $(customapi) cuts a reply off after 400 BYTES, not characters,
// and each mathematical-bold letter and each emoji is 4 bytes. A long fish name
// plus a tier badge and a couple of status notes can overrun that, which chops
// the message mid-character. Stay a little under the limit.
export const CHAT_BYTE_LIMIT = 390;

export function byteLength(str) {
  return Buffer.byteLength(String(str ?? ''), 'utf8');
}

// Append optional notes to `core` while they fit. `segments` is
// [{ text, priority }] in DISPLAY order; when space is short the lowest
// priority (highest number) notes are dropped first, and the ones that survive
// keep their display order.
export function fitSegments(core, segments = [], limit = CHAT_BYTE_LIMIT) {
  const keep = new Set();
  let used = byteLength(core);
  const byPriority = segments
    .map((seg, index) => ({ ...seg, index }))
    .filter((seg) => seg.text)
    .sort((a, b) => a.priority - b.priority || a.index - b.index);
  for (const seg of byPriority) {
    const size = byteLength(seg.text);
    if (used + size <= limit) {
      keep.add(seg.index);
      used += size;
    }
  }
  return core + segments.filter((seg, i) => keep.has(i)).map((seg) => seg.text).join('');
}

// Hard cut at a whole character, never in the middle of one.
export function truncateToBytes(str, limit = CHAT_BYTE_LIMIT) {
  const text = String(str ?? '');
  if (byteLength(text) <= limit) return text;
  const chars = Array.from(text);
  while (chars.length && byteLength(chars.join('') + '…') > limit) chars.pop();
  return chars.join('') + '…';
}
