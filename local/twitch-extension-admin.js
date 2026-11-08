// Local-only Master Admin pairing and session broker for the Twitch Extension.
// The existing Master Admin password is checked by the authenticated local
// Control Centre. Only a single-use, high-entropy code crosses the relay.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';
import adminToolsHandler, { issueLocalExtensionAdminSession } from '../api/admin-tools.js';
import adminActionHandler from '../api/admin/action.js';
import { trustedMasterAdminOwner, hashMasterAdminPairingCode, validateMasterAdminPayload } from './twitch-extension-admin-policy.js';

const BINDING_FILE = path.join(ROOT, 'data', 'extension-master-admin.json');
const PAIRING_TTL_MS = 2 * 60 * 1000;
const PAIRING_WINDOW_MS = 15 * 60 * 1000;
const PAIRING_MAX_ISSUES = 5;
const SESSION_IDLE_TTL_MS = 15 * 60 * 1000;
const SESSION_MAX_TTL_MS = 60 * 60 * 1000;
const MAX_ACTION_BYTES = 18_000;

const pairingCodes = new Map(); // SHA-256(code) -> short-lived, one-use owner binding
const pairingIssues = new Map(); // userId -> timestamps
const adminSessions = new Map(); // opaque session ID -> real admin token (desktop memory only)

const ALLOWED_ADMIN_ACTIONS = new Set([
  'addPondTokens', 'adminDebugSnapshot', 'adminLuckBreakdown', 'adminRepairUserState',
  'adminTestFishRoll', 'adminTestPondRoll', 'assignCustomTitle', 'broadcaster-debug',
  'broadcaster-debug-clear-test', 'broadcaster-overview', 'broadcaster-permission-set',
  'clearGlobalEventLuck', 'clearUser', 'create-broadcaster-admin', 'createCustomAchievement',
  'createCustomTitle', 'delete', 'delete-broadcaster-admin', 'deleteAuditEntry',
  'deleteCustomAchievement', 'get-stream-cooldown', 'getAuditLog', 'getAutoFish',
  'getAutoFishGlobal', 'getCatchLog', 'getInventory', 'getPerks', 'getTradeInventory',
  'giveFish', 'giveFishBatch', 'givefish', 'grantPerk', 'list-broadcaster-admins',
  'listCustomAchievements', 'listCustomTitles', 'multiDeleteFish', 'recalcBestCatch',
  'removeFish', 'removefish', 'resetAllFishMessages', 'revokeCustomTitle',
  'set-stream-cooldown', 'setAreaFeature', 'setAutoFish', 'setGlobalEventLuck',
  'setPerk', 'setPondLevel', 'setPondPerk', 'setUserAreas', 'spawnTreasurySlot',
  'treasuryBackfillBatch', 'treasuryCheck', 'tutorialDebugClearReward',
  'tutorialDebugInspect', 'tutorialDebugResetFirstFish', 'tutorialDebugResetServer',
  'update-broadcaster-admin', 'updateBuiltinAchievement', 'updateCustomAchievement',
  'updateCustomTitle', 'wipeRarity', 'shop-price', 'shop-prices', 'pond-perk-price'
]);

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function normalizedIdentity(userIdInput, loginInput) {
  const userId = String(userIdInput || '');
  const login = String(loginInput || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^\d{5,20}$/.test(userId) || !/^[a-z0-9_]{1,25}$/.test(login)) {
    fail(400, 'invalid_owner_identity', 'The authenticated Twitch owner identity is invalid.');
  }
  return { userId, login };
}

function readBinding() {
  let raw;
  try { raw = fs.readFileSync(BINDING_FILE, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try { value = JSON.parse(raw); }
  catch (_) { fail(500, 'binding_corrupt', 'The local Master Admin Twitch binding file is unreadable. Do not delete it manually; use the Control Centre recovery process.'); }
  if (!value || value.version !== 1 || !/^\d{5,20}$/.test(String(value.userId || '')) || !/^[a-z0-9_]{1,25}$/.test(String(value.login || '')) || !value.linkedAt) {
    fail(500, 'binding_invalid', 'The local Master Admin Twitch binding is invalid. Access is disabled until it is reviewed locally.');
  }
  return { userId: String(value.userId), login: String(value.login), linkedAt: String(value.linkedAt) };
}

function writeBinding(identity) {
  fs.mkdirSync(path.dirname(BINDING_FILE), { recursive: true });
  const temp = `${BINDING_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const record = { version: 1, userId: identity.userId, login: identity.login, linkedAt: new Date().toISOString() };
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(temp, 0o600); } catch (_) { }
  try {
    fs.renameSync(temp, BINDING_FILE);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) { }
    throw error;
  }
  return { userId: record.userId, login: record.login, linkedAt: record.linkedAt };
}

export function getExtensionMasterAdminBinding() {
  try { return readBinding(); }
  catch (error) {
    // Keep the Control Centre reachable so an operator can re-authenticate and
    // unlink a corrupt/unreadable binding instead of being locked out of Security.
    return { invalid: true, issueCode: String(error?.code || 'binding_unreadable') };
  }
}

function prunePairings() {
  const now = Date.now();
  for (const [hash, entry] of pairingCodes) if (entry.expiresAt <= now) pairingCodes.delete(hash);
  for (const [userId, timestamps] of pairingIssues) {
    const recent = timestamps.filter((at) => now - at < PAIRING_WINDOW_MS);
    if (recent.length) pairingIssues.set(userId, recent);
    else pairingIssues.delete(userId);
  }
}

async function pruneAdminSessions() {
  const now = Date.now();
  const expired = [];
  for (const [sessionId, session] of adminSessions) {
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) expired.push(sessionId);
  }
  await Promise.all(expired.map((sessionId) => destroySession(sessionId)));
}

const adminSessionCleanupTimer = setInterval(() => {
  prunePairings();
  pruneAdminSessions().catch((error) => {
    console.warn('[twitch-extension] Could not prune expired Master Admin sessions:', String(error?.message || error).slice(0, 160));
  });
}, 60_000);
adminSessionCleanupTimer.unref?.();

export function createExtensionMasterAdminPairingCode(identityInput) {
  prunePairings();
  const identity = normalizedIdentity(identityInput?.userId, identityInput?.login);
  const existing = readBinding();
  if (existing && existing.userId !== identity.userId) {
    fail(403, 'master_admin_bound_elsewhere', `Master Admin is already bound to @${existing.login}. Unlink that identity in Security before switching Twitch accounts.`);
  }

  const history = pairingIssues.get(identity.userId) || [];
  if (history.length >= PAIRING_MAX_ISSUES) {
    fail(429, 'pairing_rate_limited', 'Too many pairing codes have been generated. Try again in 15 minutes.');
  }
  history.push(Date.now());
  pairingIssues.set(identity.userId, history);

  // Reissuing a code invalidates every earlier outstanding code for this ID.
  for (const [hash, entry] of pairingCodes) if (entry.userId === identity.userId) pairingCodes.delete(hash);
  const code = crypto.randomBytes(32).toString('base64url');
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  pairingCodes.set(codeHash, { ...identity, createdAt: Date.now(), expiresAt: Date.now() + PAIRING_TTL_MS });
  return { code, expiresInSeconds: PAIRING_TTL_MS / 1000, boundLogin: identity.login };
}

function responseHarness() {
  const state = { status: 200, body: null, ended: false };
  const res = {
    status(code) { state.status = Number(code) || 200; return this; },
    json(value) { state.body = value; state.ended = true; return this; },
    send(value) { state.body = value; state.ended = true; return this; },
    end(value) { if (value !== undefined) state.body = value; state.ended = true; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; }
  };
  return { state, res };
}

async function runHandler(handler, req) {
  const { state, res } = responseHarness();
  await handler(req, res);
  return { status: state.status, body: state.body };
}

async function revokeAdminToken(token) {
  if (!token) return;
  await runHandler(adminToolsHandler, {
    method: 'POST', query: { tool: 'logout' },
    headers: { authorization: `Bearer ${token}` }, body: {}
  }).catch(() => {});
}

async function destroySession(sessionId) {
  const record = adminSessions.get(sessionId);
  adminSessions.delete(sessionId);
  if (record?.token) await revokeAdminToken(record.token);
}

async function pairSession(codeInput, owner) {
  const code = String(codeInput || '').trim();
  const hash = hashMasterAdminPairingCode(code);
  const record = pairingCodes.get(hash);
  if (!record) fail(401, 'pairing_code_invalid', 'The pairing code is invalid, expired or already used. Generate a new code in the Control Centre.');
  // Consume before any later validation or session creation: codes are strictly one-use.
  pairingCodes.delete(hash);
  if (record.expiresAt <= Date.now()) fail(401, 'pairing_code_expired', 'The pairing code expired. Generate a new one in the Control Centre.');
  if (record.userId !== owner.userId) fail(403, 'pairing_identity_mismatch', 'This code was generated for a different Twitch account.');

  const binding = readBinding();
  if (binding && binding.userId !== owner.userId) {
    fail(403, 'master_admin_bound_elsewhere', `Master Admin is already bound to @${binding.login}.`);
  }

  // A fresh pairing replaces any previous Extension console session for
  // this owner. This prevents unreachable sessions lingering after an iframe
  // reload (the opaque session ID is intentionally memory-only in the iframe).
  for (const [sessionId, session] of adminSessions) {
    if (session.userId === owner.userId) await destroySession(sessionId);
  }

  const issued = await issueLocalExtensionAdminSession();
  let createdBinding = false;
  try {
    if (!binding) {
      writeBinding(owner);
      createdBinding = true;
    }
  } catch (error) {
    await revokeAdminToken(issued.token);
    throw error;
  }

  const now = Date.now();
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const absoluteExpiresAt = Math.min(Number(issued.expiresAt) || (now + SESSION_MAX_TTL_MS), now + SESSION_MAX_TTL_MS);
  adminSessions.set(sessionId, {
    token: issued.token,
    userId: owner.userId,
    login: owner.login,
    createdAt: now,
    lastUsedAt: now,
    absoluteExpiresAt,
    expiresAt: Math.min(now + SESSION_IDLE_TTL_MS, absoluteExpiresAt)
  });
  return {
    sessionId,
    expiresAt: Math.min(now + SESSION_IDLE_TTL_MS, absoluteExpiresAt),
    maxSessionMinutes: SESSION_MAX_TTL_MS / 60_000,
    idleMinutes: SESSION_IDLE_TTL_MS / 60_000,
    bindingCreated: createdBinding,
    boundLogin: owner.login
  };
}

function safeActionPayload(input) {
  return validateMasterAdminPayload(input, ALLOWED_ADMIN_ACTIONS, MAX_ACTION_BYTES);
}

async function executeAdminAction(sessionIdInput, owner, payloadInput) {
  const sessionId = String(sessionIdInput || '');
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(sessionId)) fail(401, 'admin_session_missing', 'Master Admin is locked. Pair it again from the local Control Centre.');
  const session = adminSessions.get(sessionId);
  if (!session || session.userId !== owner.userId) {
    fail(401, 'admin_session_invalid', 'Master Admin session is invalid. Pair it again from the local Control Centre.');
  }
  const now = Date.now();
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
    await destroySession(sessionId);
    fail(401, 'admin_session_expired', 'Master Admin session expired. Generate a new pairing code in the local Control Centre.');
  }
  const binding = readBinding();
  if (!binding || binding.userId !== owner.userId) {
    await destroySession(sessionId);
    fail(403, 'master_admin_binding_mismatch', 'This Twitch account is not the locally enrolled Master Admin identity.');
  }

  const payload = safeActionPayload(payloadInput);
  session.lastUsedAt = now;
  session.expiresAt = Math.min(now + SESSION_IDLE_TTL_MS, session.absoluteExpiresAt);
  const result = await runHandler(adminActionHandler, {
    method: 'POST', query: {},
    headers: { authorization: `Bearer ${session.token}` },
    body: payload
  });
  let resultBytes = 0;
  try { resultBytes = Buffer.byteLength(JSON.stringify(result.body ?? null), 'utf8'); }
  catch (_) { fail(500, 'admin_result_invalid', 'The Master Admin action returned an unreadable result.'); }
  if (resultBytes > 120_000) fail(413, 'admin_result_too_large', 'This result is too large for the Twitch Extension. Narrow the target or use the desktop Control Centre.');
  if (result.status >= 400) {
    const message = result.body?.error || result.body?.message || 'Master Admin action failed.';
    fail(result.status, 'admin_action_failed', String(message).slice(0, 220));
  }
  return { result: result.body, expiresAt: session.expiresAt };
}

export async function executeExtensionMasterAdminRequest(viewerInput, authenticatedChannelId, requestInput) {
  await pruneAdminSessions();
  prunePairings();
  const owner = trustedMasterAdminOwner(viewerInput, authenticatedChannelId);
  const action = String(requestInput?.action || '');
  if (action === 'pair') return { status: 200, body: await pairSession(requestInput?.code, owner) };
  if (action === 'execute') {
    const result = await executeAdminAction(requestInput?.sessionId, owner, requestInput?.payload);
    return { status: 200, body: result };
  }
  if (action === 'logout') {
    const sessionId = String(requestInput?.sessionId || '');
    const session = adminSessions.get(sessionId);
    if (session && session.userId === owner.userId) await destroySession(sessionId);
    return { status: 200, body: { loggedOut: true } };
  }
  fail(400, 'unknown_admin_operation', 'Unknown Master Admin operation.');
}

export async function revokeExtensionMasterAdminSessions() {
  const tokens = [...adminSessions.values()].map((entry) => entry.token);
  adminSessions.clear();
  pairingCodes.clear();
  await Promise.all(tokens.map(revokeAdminToken));
}

export async function revokeExtensionMasterAdminBinding() {
  await revokeExtensionMasterAdminSessions();
  try { fs.unlinkSync(BINDING_FILE); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  pairingIssues.clear();
  return { unlinked: true };
}
