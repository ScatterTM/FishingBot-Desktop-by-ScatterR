// Parsing and validation shared by the two chat-facing fishing endpoints:
//   /api/fish      - the public "!fish" random roll
//   /api/givefish  - the operator-only "!givefish <name>" forced grant
//
// These used to live inside api/fish.js, which served both jobs from one URL.
// That coupling is what made every StreamElements mistake a channel-wide
// outage: "&msg=..." was mandatory for players who never needed it, and a
// level variable that StreamElements did not substitute was carried by
// everybody's cast. Keeping the shared rules here means both endpoints agree
// on what counts as a real username and a real fish name.
//
// StreamElements variables are written $(sender), $(sender.level), $(1:) and
// $(queryescape ...). A bare {user} or {msg} is NOT a StreamElements variable,
// so it is sent to us as literal text.

// A "name" built from an unsubstituted template placeholder: $(sender),
// $(queryescape $(1:)), ${...}, {1}, $1, or its percent-encoded form. Nothing
// matching this can be a Twitch login, so it is never a sender. The greedy
// .* inside $(...) / ${...} is deliberate: StreamElements variables nest.
const TEMPLATE_PLACEHOLDER_REGEX =
  /^\s*(?:\$\{.*\}|\$\(.*\)|\$\d+|%24%7b[^%]*%7d|%7b[^%]*%7d|\{[^}]*\}|\$\d+|\$[A-Za-z_]\w*)\s*$/;

// Literal strings a chat bot leaves behind when it fails to substitute.
const NO_ARG_SENTINELS = new Set([
  '', '-', '--', 'none', 'undefined', 'null', 'n/a', 'na', 'nil', 'void',
  'args', 'arg', 'query', 'queryescape', 'input', 'message', 'msg', 'text',
  '{}', '{0}', '{1}', '{2}', '{3}', '{query}', '{args}', '{arg}', '{input}',
  '$0', '$1', '$2', '$3', '${0}', '${1}', '${2}', '${3}',
  '${query}', '${queryescape}', '${args}', '${arg}', '${input}',
  '${user}', '${user.name}', '${username}', '${level}', '${user.level}',
  '$(query)', '$(queryescape)', '$(args)', '%7b1%7d', '%24%7b1%7d'
]);

// Zero-width and bidi characters, used to spoof names in logs and chat.
const INVISIBLE_CHARS_REGEX =
  /[\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u2800\u3164\uFFA0]/g;

// StreamElements substitutes $(sender) / $(1:) before it sends anything, so
// a placeholder arriving intact means the request did not come from a working
// command - it was opened in a browser, sent by hand, or pasted somewhere that
// does not substitute.
export function isPlaceholderSender(userKey) {
  if (!userKey) return false;
  return NO_ARG_SENTINELS.has(userKey) || TEMPLATE_PLACEHOLDER_REGEX.test(userKey);
}

// Nothing usable was supplied. An empty sender counts: crediting a catch to a
// blank key created a junk account, which is the same invented identity that
// was removed from the forced-catch rescue path.
export function isNoArg(value) {
  if (value === null || value === undefined) return true;
  if (!String(value).trim()) return true;
  const lower = String(value).toLowerCase();
  if (NO_ARG_SENTINELS.has(lower)) return true;
  if (TEMPLATE_PLACEHOLDER_REGEX.test(lower)) return true;
  return false;
}

// Canonical storage key for a Twitch login.
export function normalizeUserKey(value) {
  return String(value ?? '').toLowerCase().replace('@', '').trim();
}

// Strip the percent-encoding, invisible characters and plus signs that chat
// clients and command builders each add in their own way.
export function cleanText(raw) {
  let text = String(raw ?? '').replace(INVISIBLE_CHARS_REGEX, '');
  try {
    text = decodeURIComponent(text);
  } catch (e) {
    // Not valid percent-encoding - keep what we were given.
  }
  return text.replace(/\+/g, ' ').replace(/%20/gi, ' ').trim();
}

// The text a player typed after the command word: "!givefish Snapper" ->
// "Snapper". Only a leading "!command" is removed. The old rule dropped the first
// word of ANY message, so a command that sends just the arguments ($(1:)) had
// "vipfish" eaten and came back as "Usage: ...", while "1.5x luck" (which does
// not start with a letter) survived - the same command working for some fish and
// not others.
export function stripCommandWord(rawMessage) {
  return cleanText(rawMessage).replace(/^!\S+\s*/, '').trim();
}

// Pull the fish name out of a request, whatever the chat bot sent.
//
// The arguments a player typed are available in StreamElements as $(1), $(2),
// $(3)... or all at once as $(1:). Both shapes are read: the whole argument text
// as msg=, or the words individually as 1=, 2=, 3=.
//
// Order matters: an explicit single fish= wins, then the whole message, then
// the numbered arguments. A value that is only an unsubstituted placeholder is
// skipped rather than being treated as a name, so an unset {3} does not turn
// into the literal text "$(3)".
const FISH_PARAM_KEYS = ['fish', 'q', 'name'];

export function extractRequestedFish(req) {
  const sources = [req.query, req.body].filter(Boolean);

  // An explicit parameter holds the NAME, not a chat line, so it must not have
  // a command word stripped from it: "fish=vipfish" would otherwise come back
  // as "" because "vipfish" looks like a command word.
  for (const source of sources) {
    for (const key of FISH_PARAM_KEYS) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      if (isNoArg(value)) continue;
      return cleanText(value).trim();
    }
  }

  for (const source of sources) {
    for (const key of ['msg', 'message', 'text', 'command', 'cmd']) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      if (isNoArg(value)) continue;
      return stripCommandWord(value);
    }
  }

  // Numbered arguments: "!givefish the ancient leviathan" arrives as
  // 1=the 2=ancient 3=leviathan.
  const words = [];
  for (const source of sources) {
    for (let i = 1; i <= 8; i++) {
      const value = source[i] ?? source[String(i)];
      if (value === undefined || value === null) continue;
      if (isNoArg(value)) continue;
      const word = cleanText(value).trim();
      if (word) words.push(word);
    }
    if (words.length) break;
  }

  return words.join(' ').trim();
}

// Describe exactly what arrived, so a misconfigured command can be diagnosed
// from one round trip. A mistyped `{ user }` and an `&` pasted as `&amp;` both
// surface as the literal text "{user}" - only the received values tell them
// apart. Credentials are never echoed into a public chat message.
export function describeIncomingRequest(req) {
  const parts = [];
  const seen = new Set();
  for (const source of [req.query, req.body]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of Object.keys(source)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = source[key];
      const value = Array.isArray(raw) ? raw.join('+') : String(raw ?? '');
      const shown = /secret|key|token|password/i.test(key)
        ? '(hidden)'
        : value.slice(0, 60);
      parts.push(key + '="' + shown + '"');
    }
  }
  return parts.length ? parts.join(' ') : (req.originalUrl || req.url || '').split('?')[0];
}

export { INVISIBLE_CHARS_REGEX, TEMPLATE_PLACEHOLDER_REGEX, NO_ARG_SENTINELS };
