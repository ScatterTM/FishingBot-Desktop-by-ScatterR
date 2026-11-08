import { db } from '../lib/db.js';
import { appendCookie, getSessionUser, parseCookies } from '../lib/session.js';
import { validateSession } from './admin-tools.js';
import {
  getBroadcasterAdmin,
  migrateLegacyTestAccount,
  signBroadcasterAdminSession,
  verifyBroadcasterAdminSession,
  verifyBroadcasterCredentials
} from '../lib/broadcaster-admin.js';

const COOKIE = 'fh_broadcaster_admin';
const SESSION_AGE = 4 * 60 * 60;

function clearCookie(res) {
  appendCookie(res, `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function setCookie(res, token) {
  appendCookie(res, `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_AGE}`);
}

function getAdminSession(req) {
  const token = parseCookies(req)[COOKIE];
  return verifyBroadcasterAdminSession(token);
}

function getClientIp(req) {
  const realIp = req.headers?.['x-real-ip'];
  if (realIp && String(realIp).trim()) return String(realIp).trim();
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

async function loginLocked(req) {
  if (!db) return false;
  return !!(await db.get(`ratelock:broadcaster-admin:${getClientIp(req)}`).catch(() => null));
}

async function recordLoginFailure(req) {
  if (!db) return;
  const ip = getClientIp(req);
  const counter = `ratelimit:broadcaster-admin:${ip}`;
  const n = Number(await db.incr(counter).catch(() => 0));
  const ttl = Number(await db.ttl(counter).catch(() => -1));
  if (!(ttl > 0)) await db.set(counter, n, { ex: 600 }).catch(() => {});
  if (n >= 5) await db.set(`ratelock:broadcaster-admin:${ip}`, '1', { ex: 900 }).catch(() => {});
}

async function clearLoginFailures(req) {
  if (!db) return;
  const ip = getClientIp(req);
  await db.del(`ratelimit:broadcaster-admin:${ip}`, `ratelock:broadcaster-admin:${ip}`).catch(() => {});
}

async function readCooldown(channel) {
  if (!db) return 60;
  const raw = await db.get(`settings:cooldown:${channel}`).catch(() => null);
  const parsed = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const globalRaw = await db.get('settings:cooldown').catch(() => null);
  const global = globalRaw === null || globalRaw === undefined || String(globalRaw).trim() === '' ? NaN : Number(globalRaw);
  return Number.isFinite(global) && global >= 0 ? global : 60;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!db) return res.status(500).json({ error: 'Database connection failed.' });

  // The old single-account env var is migrated into the database the first
  // time this endpoint is used. It is only a compatibility bridge; all new
  // accounts are stored in the database and use hashed passwords.
  await migrateLegacyTestAccount();

  const twitchUser = getSessionUser(req);
  const twitchLogin = String(twitchUser?.login || '').toLowerCase();
  const account = twitchLogin ? await getBroadcasterAdmin(twitchLogin) : null;
  const adminSession = getAdminSession(req);
  const sessionAccount = adminSession ? await getBroadcasterAdmin(adminSession.channel) : null;
  const authenticated = !!(
    adminSession &&
    sessionAccount &&
    sessionAccount.enabled &&
    adminSession.twitchLogin === twitchLogin &&
    sessionAccount.twitchLogin === twitchLogin
  );

  if (req.method === 'GET') {
    if (!twitchUser) {
      return res.status(200).json({ eligible: false, authenticated: false });
    }
    return res.status(200).json({
      eligible: !!account?.enabled && account.twitchLogin === twitchLogin,
      authenticated,
      broadcaster: account?.channel || twitchLogin,
      role: authenticated ? 'Admin' : null,
      preview: account ? {
        name: 'Broadcaster Admin',
        description: 'Preview only. Stream controls will be added here later.',
        streamCooldownSeconds: await readCooldown(account.channel),
        accessScope: 'Channel only'
      } : null
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const action = String(req.body?.action || '');

  if (action === 'login') {
    if (!account || !account.enabled || account.twitchLogin !== twitchLogin) {
      return res.status(403).json({ error: 'This Twitch account is not enabled for Broadcaster Admin.' });
    }
    if (await loginLocked(req)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const verified = await verifyBroadcasterCredentials(account.channel, password);
    if (!verified) {
      await recordLoginFailure(req);
      return res.status(401).json({ error: 'Invalid broadcaster Admin password.' });
    }

    await clearLoginFailures(req);
    const token = signBroadcasterAdminSession({ channel: verified.channel, twitchLogin: verified.twitchLogin }, SESSION_AGE);
    setCookie(res, token);
    return res.status(200).json({ success: true, role: 'Admin', broadcaster: verified.channel });
  }

  if (action === 'logout') {
    clearCookie(res);
    return res.status(200).json({ success: true });
  }

  if (action === 'status') {
    return res.status(200).json({ authenticated });
  }

  return res.status(400).json({ error: 'Unknown broadcaster Admin action.' });
}
