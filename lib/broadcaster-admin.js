import crypto from 'crypto';
import { db } from './db.js';
import { hasLocalAdminPassword, verifyLocalAdminPassword } from './local-admin-password.js';

const ACCOUNT_PREFIX = 'broadcaster:admin:';
const SESSION_SECRET = process.env.BROADCASTER_ADMIN_SECRET || process.env.SESSION_SECRET || '';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

export function normalizeBroadcasterLogin(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}

export function isValidBroadcasterLogin(value) {
  return /^[a-z0-9_]{1,25}$/.test(String(value || ''));
}

function accountKey(channel) {
  return `${ACCOUNT_PREFIX}${normalizeBroadcasterLogin(channel)}`;
}

function encodeHash(salt, hash) {
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function parseHash(encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [_, n, r, p, salt, hash] = parts;
  const N = Number(n), R = Number(r), P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P) || !salt || !hash) return null;
  return { N, R, P, salt: Buffer.from(salt, 'base64url'), hash: Buffer.from(hash, 'base64url') };
}

export function hashBroadcasterPassword(password) {
  const clean = String(password ?? '');
  if (clean.length < 8 || clean.length > 200) throw new Error('Password must be between 8 and 200 characters.');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(clean, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 32 * 1024 * 1024 });
  return encodeHash(salt, hash);
}

export function verifyBroadcasterPassword(password, encoded) {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const derived = crypto.scryptSync(String(password ?? ''), parsed.salt, parsed.hash.length, { N: parsed.N, r: parsed.R, p: parsed.P, maxmem: 32 * 1024 * 1024 });
  return derived.length === parsed.hash.length && crypto.timingSafeEqual(derived, parsed.hash);
}

function sessionSign(payload, exp) {
  if (!SESSION_SECRET) throw new Error('BROADCASTER_ADMIN_SECRET or SESSION_SECRET is not configured.');
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function signBroadcasterAdminSession({ channel, twitchLogin }, maxAgeSeconds = 4 * 60 * 60) {
  return sessionSign({
    role: 'broadcaster_admin',
    channel: normalizeBroadcasterLogin(channel),
    twitchLogin: normalizeBroadcasterLogin(twitchLogin)
  }, Date.now() + maxAgeSeconds * 1000);
}

export function verifyBroadcasterAdminSession(token) {
  if (!SESSION_SECRET || !token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.role !== 'broadcaster_admin' || !payload.channel || !payload.twitchLogin || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getBroadcasterAdmin(channel) {
  if (!db) return null;
  const clean = normalizeBroadcasterLogin(channel);
  if (process.env.LOCAL_EDITION === '1' && hasLocalAdminPassword()) {
    const botRaw = await db.get('local:bot:account').catch(() => null);
    try {
      const bot = JSON.parse(botRaw || 'null');
      if (normalizeBroadcasterLogin(bot?.login) === clean) {
        return { channel: clean, twitchLogin: clean, enabled: true, passwordHash: '__local_control_centre_password__', createdAt: bot.connectedAt || null, updatedAt: bot.connectedAt || null };
      }
    } catch (_) { }
  }
  const raw = await db.get(accountKey(clean)).catch(() => null);
  if (!raw) return null;
  try {
    const account = JSON.parse(raw);
    return {
      channel: normalizeBroadcasterLogin(account.channel || channel),
      twitchLogin: normalizeBroadcasterLogin(account.twitchLogin || account.channel || channel),
      enabled: account.enabled !== false,
      passwordHash: account.passwordHash || '',
      createdAt: account.createdAt || null,
      updatedAt: account.updatedAt || null
    };
  } catch {
    return null;
  }
}

export async function listBroadcasterAdmins() {
  if (!db) return [];
  const [, keys] = await db.scan('0', { match: `${ACCOUNT_PREFIX}*` }).catch(() => ['0', []]);
  const values = await db.mget(keys || []).catch(() => []);
  return (keys || []).map((key, i) => {
    try {
      const account = JSON.parse(values[i] || '');
      const channel = normalizeBroadcasterLogin(account.channel || String(key).slice(ACCOUNT_PREFIX.length));
      return {
        channel,
        twitchLogin: normalizeBroadcasterLogin(account.twitchLogin || channel),
        enabled: account.enabled !== false,
        createdAt: account.createdAt || null,
        updatedAt: account.updatedAt || null,
        hasPassword: !!account.passwordHash
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => a.channel.localeCompare(b.channel));
}

export async function saveBroadcasterAdmin({ channel, twitchLogin, password, enabled = true, preservePassword = false }) {
  if (!db) throw new Error('Database connection failed.');
  const cleanChannel = normalizeBroadcasterLogin(channel);
  const cleanTwitch = normalizeBroadcasterLogin(twitchLogin || channel);
  if (!isValidBroadcasterLogin(cleanChannel) || !isValidBroadcasterLogin(cleanTwitch)) throw new Error('Enter valid Twitch usernames.');
  const existing = await getBroadcasterAdmin(cleanChannel);
  let passwordHash = existing?.passwordHash || '';
  if (typeof password === 'string' && password.length) passwordHash = hashBroadcasterPassword(password);
  if (!passwordHash && !preservePassword) throw new Error('An Admin password is required.');

  const now = new Date().toISOString();
  const record = {
    channel: cleanChannel,
    twitchLogin: cleanTwitch,
    enabled: enabled !== false,
    passwordHash,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await db.set(accountKey(cleanChannel), JSON.stringify(record));
  return {
    channel: record.channel,
    twitchLogin: record.twitchLogin,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hasPassword: true
  };
}

export async function deleteBroadcasterAdmin(channel) {
  if (!db) throw new Error('Database connection failed.');
  await db.del(accountKey(channel));
}

export async function verifyBroadcasterCredentials(channel, password) {
  const account = await getBroadcasterAdmin(channel);
  if (!account || !account.enabled || !account.passwordHash) return null;
  if (account.passwordHash === '__local_control_centre_password__' && process.env.LOCAL_EDITION === '1') {
    return verifyLocalAdminPassword(password) ? account : null;
  }
  if (!verifyBroadcasterPassword(password, account.passwordHash)) return null;
  return account;
}

export async function migrateLegacyTestAccount() {
  const legacyPassword = process.env.BROADCASTER_ADMIN_PASSWORD_TM_SCATTERR || '';
  if (!legacyPassword || !db) return null;
  const existing = await getBroadcasterAdmin('tm_scatterr');
  if (existing) return existing;
  try {
    return await saveBroadcasterAdmin({
      channel: 'tm_scatterr',
      twitchLogin: 'tm_scatterr',
      password: legacyPassword,
      enabled: true
    });
  } catch (error) {
    console.error('[Broadcaster Admin] Legacy account migration failed:', error);
    return null;
  }
}


export async function ensureLocalBotBroadcasterAdmin() {
  // The local bot account is automatically eligible through getBroadcasterAdmin;
  // there is no second password to create or store. This function exists so
  // the Control Centre can trigger validation immediately after setup.
  if (process.env.LOCAL_EDITION !== '1' || !hasLocalAdminPassword()) return false;
  const raw = await db.get('local:bot:account').catch(() => null);
  if (!raw) return false;
  try { const account = JSON.parse(raw); return !!normalizeBroadcasterLogin(account?.login); } catch (_) { return false; }
}

// Marks a request that the local Control Centre makes for the streamer who runs this PC.
// The symbol cannot be set from HTTP input, so remote requests can never take this path.
// On the request object it holds the channel login; on the response object it is true and
// lets the owner bypass MasterAdmin's per-channel deny list (see api/broadcaster-tools.js).
export const LOCAL_OWNER = Symbol('localBroadcasterOwner');
