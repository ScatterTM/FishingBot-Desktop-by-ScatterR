import crypto from 'crypto';
import { db } from '../lib/db.js';
import { recordAdminAudit } from '../lib/audit.js';
import { checkBotSecret, timingSafeStringEqual } from '../lib/session.js';
import { hasLocalAdminPassword, verifyLocalAdminPassword } from '../lib/local-admin-password.js';

// Best-effort revocation list. Serverless functions are stateless and get
// scaled across several instances, so this Map CANNOT be the source of truth
// for "is this session valid" - a token created on one instance is invisible
// to the next request if it lands on another. Sessions are therefore signed
// tokens (see validateSession) that any instance can verify on its own; this
// Map is only used so logout can invalidate a token early, best-effort.
export const activeSessions = new Map(); // token -> { username, createdAt, expiresAt, ip }

// Signing key for admin session tokens. Reuses SESSION_SECRET (already
// required by the Twitch OAuth flow in lib/session.js) and falls back to a
// dedicated ADMIN_SESSION_SECRET. A token is only verifiable if every
// instance agrees on this value, so it must be an env var - never generated
// per cold start, which would invalidate tokens at random.
const SESSION_SIGNING_KEY =
  process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET || '';

function base64url(input) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

// Signed, self-contained token: <base64url(payload)>.<base64url(hmac)>.
// The expiry lives inside the signed payload, so no server-side lookup is
// needed to reject an expired session.
function signAdminToken(payloadObj, maxAgeMs) {
  const payload = { ...payloadObj, exp: Date.now() + maxAgeMs };
  const payloadStr = base64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', SESSION_SIGNING_KEY)
    .update(payloadStr)
    .digest('base64url');
  return `${payloadStr}.${sig}`;
}

// Admin credentials. They come ONLY from env vars (ADMIN_USERNAME /
// ADMIN_PASSWORD in the local environment) and are never written in source. If either is
// missing, admin login is refused outright rather than falling back to a
// built-in credential that anyone reading the repo could use.
const GLOBAL_ADMIN_USER = process.env.ADMIN_USERNAME || '';
const GLOBAL_ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
const ADMIN_LOGIN_CONFIGURED = !!(GLOBAL_ADMIN_USER && GLOBAL_ADMIN_PASS);
if (process.env.LOCAL_EDITION !== '1' && !ADMIN_LOGIN_CONFIGURED) {
  console.error('[security] ADMIN_USERNAME and/or ADMIN_PASSWORD is not set: admin login is disabled.');
}

// Security: Track failed login attempts per IP for rate limiting
const failedAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000; // 10 minute window

function getNightbotFields(req) {
  const raw = req.headers?.['nightbot-user'] ?? req.headers?.['Nightbot-User'];
  if (!raw || typeof raw !== 'string') return {};
  const fields = {};
  // Nightbot normally uses '&' between fields; accept ';' too for compatibility.
  for (const part of raw.split(/[&;]/)) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

function getChatActor(req) {
  const fields = getNightbotFields(req);
  return fields.name || fields.username || fields.user || fields.displayName || 'Nightbot';
}

function getClientIp(req) {
  // x-real-ip may be set by a trusted reverse proxy and cannot be spoofed by the client.
  // For x-forwarded-for the opposite holds: a trusted proxy appends the real client
  // IP, so the FIRST entry can be attacker-supplied while the LAST is the
  // platform's own observation. Trust last, never first.
  const realIp = req.headers['x-real-ip'];
  if (realIp && String(realIp).trim()) return String(realIp).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isLockedOut(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return false;
  if (record.lockedUntil && Date.now() < record.lockedUntil) return true;
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    failedAttempts.delete(ip); // Lockout expired, clean up
    return false;
  }
  return false;
}

function memoryLockStatus(ip) {
  const record = failedAttempts.get(ip);
  if (!record) return { locked: false, retryAfterMin: 0 };
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    return { locked: true, retryAfterMin: Math.max(1, Math.ceil((record.lockedUntil - Date.now()) / 60000)) };
  }
  if (record.lockedUntil) failedAttempts.delete(ip);
  return { locked: false, retryAfterMin: 0 };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = failedAttempts.get(ip) || { attempts: [], lockedUntil: null };

  // Remove attempts outside the window
  record.attempts = record.attempts.filter(t => now - t < ATTEMPT_WINDOW_MS);
  record.attempts.push(now);

  if (record.attempts.length >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
  }

  failedAttempts.set(ip, record);
}

function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

// The counters above live in one serverless instance's memory, so an
// attacker rotating across instances would get 5 tries PER instance.
// The authoritative counters are stored in the database instead (one incr per failed
// login); the Map stays as a fallback when the database is unreachable.
async function isLoginLockedOut(ip) {
  if (db) {
    try {
      if (await db.get(`ratelock:login:${ip}`)) {
        const ttl = Number(await db.ttl(`ratelock:login:${ip}`));
        return { locked: true, retryAfterMin: Math.max(1, Math.ceil((ttl > 0 ? ttl : 0) / 60)) };
      }
    } catch (_e) { console.error('[api/admin-tools.js:146] ignored error:', _e?.message || _e); }
  }
  return memoryLockStatus(ip);
}

async function recordLoginFailure(ip) {
  if (db) {
    try {
      const counterKey = `ratelimit:login:${ip}`;
      const n = Number(await db.incr(counterKey));
      const ttl = Number(await db.ttl(counterKey));
      if (!(ttl > 0)) {
        await db.set(counterKey, n, { ex: Math.ceil(ATTEMPT_WINDOW_MS / 1000) });
      }
      if (n >= MAX_FAILED_ATTEMPTS) {
        await db.set(`ratelock:login:${ip}`, '1', { ex: Math.ceil(LOCKOUT_DURATION_MS / 1000) });
        return 0;
      }
      return Math.max(0, MAX_FAILED_ATTEMPTS - n);
    } catch (_e) { console.error('[api/admin-tools.js:165] ignored error:', _e?.message || _e); }
  }
  recordFailedAttempt(ip);
  const record = failedAttempts.get(ip);
  return Math.max(0, MAX_FAILED_ATTEMPTS - (record ? record.attempts.length : 0));
}

async function clearLoginFailures(ip) {
  if (db) {
    try { await db.del(`ratelimit:login:${ip}`, `ratelock:login:${ip}`); } catch (_e) { console.error('[api/admin-tools.js:174] ignored error:', _e?.message || _e); }
  }
  clearFailedAttempts(ip);
}

const SESSION_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

// Local-only bridge: a pairing code can only be issued by the authenticated
// Control Centre after the operator re-enters the existing local password.
// The raw password never passes through the Twitch iframe or Render relay.
export async function issueLocalExtensionAdminSession() {
  if (process.env.LOCAL_EDITION !== '1' || !hasLocalAdminPassword()) {
    throw new Error('Extension Master Admin sessions are available only in the local Fishingbot edition.');
  }
  if (!SESSION_SIGNING_KEY) throw new Error('SESSION_SECRET is missing; restart Fishingbot before pairing Master Admin.');
  const now = Date.now();
  const expiresAt = now + SESSION_EXPIRY_MS;
  const token = signAdminToken({ username: 'admin', iat: now, source: 'twitch-extension' }, SESSION_EXPIRY_MS);
  activeSessions.set(token, { username: 'admin', createdAt: now, expiresAt, ip: 'local-extension-pairing' });
  await writeAdminAudit({
    actor: 'admin',
    action: 'adminLogin',
    target: 'twitch-extension',
    details: 'A local Control Centre-approved Twitch Extension Master Admin session was issued.'
  });
  return { token, expiresAt };
}

// Audit wrapper. Deliberately swallows its own errors: a failed audit write
// must never turn a successful login/cooldown change into a 500 for the user.
async function writeAdminAudit(event) {
  try { await recordAdminAudit(db, event); }
  catch (error) { console.error('Admin audit write failed:', error); }
}

// Four small single-purpose admin/chatbot endpoints, combined into one
// function to stay well under the former hosted Serverless Function
// limit. Public URLs are unchanged - the legacy hosting rewrite table routed:
//   /api/setcooldown -> ?tool=cooldown   (StreamElements !setcooldown)
//   /api/setluck     -> ?tool=luck       (StreamElements !setluck)
//   /api/admin/login -> ?tool=login      (admin panel login form)
// ?tool=diagnostics is called directly (no rewrite) by the admin panel's
// "Refresh Diagnostics" button and on load, to show live infra numbers.
export default async function handler(req, res) {
  // No Access-Control-Allow-Origin wildcard: the dashboard calls this
  // same-origin, and StreamElements calls it server-to-server.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { tool, ...rest } = req.query || {};

  if (tool === 'login') return handleLogin(req, res);
  if (tool === 'logout') return handleLogout(req, res);
  if (tool === 'validate') return handleValidateSession(req, res);
  if (tool === 'cooldown' || tool === 'luck') {
    // These endpoints have two legitimate callers:
    //   1) StreamElements/Nightbot -> authenticated with BOT_SECRET
    //   2) the logged-in admin panel -> authenticated with its admin Bearer token
    //
    // The panel must not need BOT_SECRET in browser code.
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const adminSession = bearer ? validateSession(bearer) : null;
    const botAuthenticated = checkBotSecret(req);

    if (!adminSession && !botAuthenticated) {
      return res.status(200).send('Unauthorized: missing or wrong caller secret.');
    }

    if (tool === 'cooldown') return handleSetCooldown(rest, res, req);
    return handleSetLuck(rest, res, req);
  }
  if (tool === 'diagnostics') {
    // Compatibility endpoint retained for older clients; local host metrics
    // are supplied by the authenticated Control Centre metrics route.
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!validateSession(token)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    return handleDiagnostics(res);
  }

  return res.status(404).json({ error: 'Unknown admin tool.' });
}

async function handleLogin(req, res) {
  // Fail closed. Without this guard two empty strings would compare equal
  // and an empty username/password could pass.
  const localMode = process.env.LOCAL_EDITION === '1';
  const adminConfigured = localMode ? hasLocalAdminPassword() : ADMIN_LOGIN_CONFIGURED;
  if (!adminConfigured) {
    return res.status(503).json({
      error: localMode ? 'Set the admin password in the Fishingbot Control Centre first.' : 'Admin login is not configured on this server. Configure the local admin password in the Control Centre.'
    });
  }

  const { username, password } = req.body || {};
  const clientIp = getClientIp(req);

  // Security: Check if IP is locked out (authoritative counters in the local database)
  const lockStatus = await isLoginLockedOut(clientIp);
  if (lockStatus.locked) {
    const remainingMin = lockStatus.retryAfterMin;
    await writeAdminAudit({
      actor: typeof username === 'string' ? username : 'unknown',
      action: 'adminLoginFailed',
      target: 'admin-panel',
      details: `Login blocked - locked out for ${remainingMin} minutes due to repeated failures.`,
      status: 'error'
    });
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${remainingMin} minutes.`,
      locked: true,
      retryAfter: remainingMin
    });
  }
  
  // Input validation
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid input format.' });
  }
  
  if (username.length > 50 || password.length > 100) {
    return res.status(400).json({ error: 'Input too long.' });
  }
  
  // Trim and sanitize
  const cleanUsername = username.trim();
  const cleanPassword = password.trim();

  // Length-constant comparison: `===` bails on the first differing byte,
  // which leaks the shared prefix to timing measurements.
  const userOk = timingSafeStringEqual(cleanUsername, localMode ? 'admin' : GLOBAL_ADMIN_USER);
  const passOk = localMode ? verifyLocalAdminPassword(cleanPassword) : timingSafeStringEqual(cleanPassword, GLOBAL_ADMIN_PASS);

  if (userOk && passOk) {
    // Success - issue a signed, self-contained session token. Verification
    // happens on any instance via the HMAC signature, so the admin stays
    // logged in regardless of which lambda serves the next request.
    if (!SESSION_SIGNING_KEY) {
      console.error('[Admin Login] No session signing key configured. Ensure SESSION_SECRET is set in the local .env file or deployment settings.');
      return res.status(500).json({
        error: 'Server is missing SESSION_SECRET. Restart Fishingbot or configure the deployment environment.'
      });
    }

    const expiresAt = Date.now() + SESSION_EXPIRY_MS;
    const token = signAdminToken({ username: cleanUsername, iat: Date.now() }, SESSION_EXPIRY_MS);

    // Recorded for best-effort early revocation on logout only.
    activeSessions.set(token, {
      username: cleanUsername,
      createdAt: Date.now(),
      expiresAt,
      ip: clientIp
    });

    // Clear failed attempts on successful login
    await clearLoginFailures(clientIp);

    await writeAdminAudit({ 
      actor: cleanUsername, 
      action: 'adminLogin', 
      target: 'admin-panel', 
      details: 'Admin session opened.' 
    });
    
    return res.status(200).json({ 
      token, 
      expiresAt,
      expiresIn: SESSION_EXPIRY_MS
    });
  }
  
  // Failed attempt
  const attemptsLeft = await recordLoginFailure(clientIp);
  
  await writeAdminAudit({ 
    actor: cleanUsername || 'unknown', 
    action: 'adminLoginFailed', 
    target: 'admin-panel', 
    details: `Invalid admin credentials. Attempts remaining: ${attemptsLeft}`,
    status: 'error' 
  });
  
  return res.status(401).json({ 
    error: 'Invalid admin credentials.',
    attemptsLeft
  });
}

// Session validation - verifies the token's HMAC signature and expiry.
// Deliberately does NOT require the token to be present in `activeSessions`,
// because that Map only lives inside one serverless instance; requiring it
// would log admins out at random whenever requests hit different instances.
export function validateSession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  if (!SESSION_SIGNING_KEY) return null;

  const [payloadStr, sig] = token.split('.');
  if (!payloadStr || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', SESSION_SIGNING_KEY)
    .update(payloadStr)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64urlDecode(payloadStr));
    if (!payload.exp || Date.now() > payload.exp) return null;

    // Best-effort: if this instance happens to know the token (i.e. logout ran
    // here), honour the revocation.
    if (activeSessions.has(token) === false && REVOKED.has(token)) return null;

    return payload;
  } catch (e) {
    return null;
  }
}

// Tokens explicitly invalidated by logout on this instance.
const REVOKED = new Set();

// Session cleanup - remove expired sessions
export function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of activeSessions.entries()) {
    if (now > session.expiresAt) {
      activeSessions.delete(token);
      REVOKED.add(token);
    }
  }
  // The revocation set only ever grows (logout adds, nothing removes), so
  // cap it - oldest out first. A warm instance holding thousands of
  // long-dead tokens is a slow memory leak, not a security feature.
  while (REVOKED.size > 5000) {
    REVOKED.delete(REVOKED.values().next().value);
  }
}

// Handle logout
async function handleLogout(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  
  if (token) {
    // Resolve the admin name from the signature so the audit entry is written
    // even if the token is no longer in this instance's Map.
    const session = validateSession(token);
    await writeAdminAudit({ 
      actor: session?.username || 'admin', 
      action: 'adminLogout', 
      target: 'admin-panel', 
      details: 'Admin session ended.' 
    });
    activeSessions.delete(token);
    REVOKED.add(token);
  }
  
  return res.status(200).json({ success: true, message: 'Logged out successfully.' });
}

// Handle session validation (for frontend to check if still logged in)
async function handleValidateSession(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  
  cleanupExpiredSessions();
  const session = validateSession(token);
  
  if (session) {
    // The signed payload carries the expiry as `exp` (a number).
    return res.status(200).json({ 
      valid: true, 
      username: session.username,
      expiresAt: session.exp,
      expiresIn: session.exp - Date.now()
    });
  }
  
  return res.status(401).json({ valid: false, error: 'Session expired or invalid.' });
}

async function handleSetCooldown(query, res, req) {
  if (!db) {
    return res.status(200).send('⚠️ Error: Database is not connected.');
  }

  // Check multiple possible query keys that StreamElements might send
  const input = query.seconds || query.q || query.text || query.args || query.query || Object.values(query)[0];
  if (!input) {
    return res.status(200).send('⚠️ Usage: !setcooldown <seconds> (e.g., !setcooldown 10 or !setcooldown 10s)');
  }

  try {
    // Extract only numbers from the input string (e.g., "10s" -> "10", "30sec" -> "30")
    const secNum = parseInt(String(input).replace(/[^0-9]/g, ''), 10);
    if (isNaN(secNum) || secNum < 0 || secNum > 86400) {
      return res.status(200).send('⚠️ Invalid format. Use 0-86400 seconds (e.g., !setcooldown 10 or !setcooldown 30s).');
    }

    await db.set('settings:cooldown', secNum);
    await writeAdminAudit({ actor: getChatActor(req), action: 'setCooldown', target: 'global', details: `Fishing cooldown set to ${secNum} seconds.` });
    return res.status(200).send(`⏱️ Fishing cooldown successfully updated to ${secNum} seconds!`);
  } catch (err) {
    console.error('Set Cooldown Error:', err);
    return res.status(200).send('⚠️ Database error. Please try again.');
  }
}

async function handleSetLuck(query, res, req) {
  if (!db) {
    return res.status(200).send('⚠️ Error: Local database is not available. Check the SQLite database and restart Fishingbot.');
  }

  // Nightbot-friendly form: ?args=$(querystring) or ?text=$(querystring).
  // The decoded text is split into the same two arguments as the old
  // StreamElements endpoint: !setluck <@user> <multiplier|reset>.
  let targetInput = query.target;
  let luckInput = query.luck;
  if (!targetInput || !luckInput) {
    const rawArgs = query.args || query.query || query.text;
    if (rawArgs) {
      const parts = String(rawArgs).trim().split(/\s+/).filter(Boolean);
      targetInput = targetInput || parts[0];
      luckInput = luckInput || parts[1];
    }
  }
  if (!targetInput || !luckInput) {
    return res.status(200).send('⚠️ Usage: !setluck <@user> <multiplier|reset>');
  }

  const targetUser = targetInput.toLowerCase().replace('@', '').trim();
  if (!targetUser || targetUser.length > 32) {
    return res.status(200).send('⚠️ Invalid username.');
  }
  const dbKey = `luck:${targetUser}`;

  try {
    if (['reset', '0', 'default'].includes(luckInput.toLowerCase())) {
      await db.del(dbKey);
      await writeAdminAudit({ actor: getChatActor(req), action: 'resetUserLuck', target: targetUser, details: 'Reset the user luck multiplier to default.' });
      return res.status(200).send(`🔄 Reset fishing luck for @${targetUser} back to default.`);
    }

    const multiplier = parseFloat(luckInput);
    if (isNaN(multiplier) || multiplier <= 0 || multiplier > 100) {
      return res.status(200).send('⚠️ Invalid luck value. Specify a number above 0 up to 100 (e.g., 3.0).');
    }

    await db.set(dbKey, multiplier);
    await writeAdminAudit({ actor: getChatActor(req), action: 'setUserLuck', target: targetUser, details: `Luck multiplier set to ${multiplier}x.` });
    return res.status(200).send(`🎯 Set fishing luck multiplier for @${targetUser} to ${multiplier}x!`);
  } catch (err) {
    console.error('Set Luck Error:', err);
    return res.status(200).send('⚠️ Database error. Please try again.');
  }
}

// Local edition diagnostics are served by local/system-metrics.js. This
// compatibility endpoint intentionally reports no hosted database metrics.
async function handleDiagnostics(res) {
  return res.status(200).json({ dbConnected: !!db, metricsAvailable: false, edition: 'local' });
}
