import crypto from 'crypto';

const SECRET = process.env.SESSION_SECRET;

const SESSION_COOKIE = 'fh_session';
const STATE_COOKIE = 'fh_oauth_state';

function base64url(input) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

// Appends a Set-Cookie header without clobbering any that were already set
// on this response (Node collapses repeated setHeader calls otherwise).
export function appendCookie(res, cookieStr) {
  const existing = res.getHeader('Set-Cookie');
  let next;
  if (!existing) next = [cookieStr];
  else if (Array.isArray(existing)) next = [...existing, cookieStr];
  else next = [existing, cookieStr];
  res.setHeader('Set-Cookie', next);
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

// --- Session token (signed, not encrypted - don't put secrets in the payload) ---

export function signSession(payloadObj, maxAgeSeconds = 60 * 60 * 24 * 30) {
  if (!SECRET) throw new Error('SESSION_SECRET is not set');
  const payload = { ...payloadObj, exp: Date.now() + maxAgeSeconds * 1000 };
  const payloadStr = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${sig}`;
}

export function verifySession(token) {
  if (!SECRET || !token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadStr, sig] = token.split('.');
  if (!payloadStr || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64urlDecode(payloadStr));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

export function getSessionUser(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[SESSION_COOKIE]);
}

export function setSessionCookie(res, token, maxAgeSeconds) {
  appendCookie(res, `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

export function clearSessionCookie(res) {
  appendCookie(res, `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// --- OAuth CSRF state cookie (short-lived, cleared as soon as it's used) ---

export function setStateCookie(res, state) {
  appendCookie(res, `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
}

export function clearStateCookie(res) {
  appendCookie(res, `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function getStateCookie(req) {
  return parseCookies(req)[STATE_COOKIE];
}

// --- Shared secrets --------------------------------------------------------
// Length-constant string comparison for secrets. The early length check
// leaks the expected length, which is fine: these secrets are bearer
// values, not encryption keys, and the alternative (`===`) leaks the
// shared prefix byte-by-byte instead.
export function timingSafeStringEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Chatbot-caller gate for the StreamElements endpoints (!fish, !setcooldown,
// !setluck). StreamElements calls these server-to-server, so the username it
// reports (and the admin-override list in api/fish.js) cannot be trusted on
// its own: anyone with the URL could otherwise spoof an admin name, force
// rare catches, or rewrite global settings.
//
// When BOT_SECRET is set in local environment settings, the caller must pass it as
// `?secret=` (query or body) - configure the StreamElements commands to
// append `&secret=...`. When it is NOT set, the endpoints stay open exactly
// as before (so nothing breaks on deploy), but a warning is logged once so
// the missing lockdown is visible in the local server logs.
let botSecretWarned = false;

export function checkBotSecret(req) {
  const expected = process.env.BOT_SECRET;
  if (!expected) {
    if (!botSecretWarned) {
      botSecretWarned = true;
      console.warn('[security] BOT_SECRET is not set: chatbot endpoints (!fish, !setcooldown, !setluck) accept unauthenticated calls. Set BOT_SECRET in local environment settings and append &secret=... to the StreamElements command URLs to lock them down.');
    }
    return true;
  }
  const provided = req.query?.secret ?? req.body?.secret;
  return !!provided && timingSafeStringEqual(provided, expected);
}
