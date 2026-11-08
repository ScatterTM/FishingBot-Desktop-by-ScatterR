import crypto from 'crypto';
import { VIEWER_CHAT_SCOPE, saveViewerChatAuth, deleteViewerChatAuth } from '../../lib/viewer-chat.js';
import { deleteUserData } from '../../lib/delete-user.js';
import { getBroadcasterAdmin, normalizeBroadcasterLogin } from '../../lib/broadcaster-admin.js';
import { validateSession } from '../admin-tools.js';
import {
  BROADCASTER_SCOPES,
  getBroadcasterAdminSession,
  getBroadcasterTwitchRecord,
  saveBroadcasterTwitchRecord,
  deleteBroadcasterTwitchRecord,
  recordIsComplete,
  revokeBroadcasterTwitch,
  diagnoseTwitchRole
} from '../../lib/broadcaster-twitch.js';
import {
  setStateCookie,
  getStateCookie,
  clearStateCookie,
  setSessionCookie,
  clearSessionCookie,
  signSession,
  getSessionUser
} from '../../lib/session.js';

// Twitch's error text (for example "invalid client") shows why an exchange failed.
// Only the status and message are used. Tokens are never logged or returned.
function twitchReason(tokenRes, data) {
  const message = typeof data?.message === 'string' && data.message ? data.message.slice(0, 160) : '';
  return { status: tokenRes.status, message };
}

function redirectUriFor(req) {
  if (process.env.LOCAL_EDITION === '1') {
    const forwardedHost = req.headers['x-forwarded-host'];
    const forwardedProto = req.headers['x-forwarded-proto'];
    if (req.headers['x-fishingbot-public'] === '1' && forwardedHost && forwardedProto) {
      return `${String(forwardedProto).split(',')[0].trim()}://${String(forwardedHost).split(',')[0].trim()}/api/auth/callback`;
    }
    const host = req.headers.host || 'localhost:3000';
    return `${/^localhost(?::|$)|^127\.0\.0\.1(?::|$)/i.test(host) ? 'http' : 'https'}://${host}/api/auth/callback`;
  }
  const base = process.env.PUBLIC_BASE_URL;
  if (base) return `${String(base).replace(/\/+$/, '')}/api/auth/callback`;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}/api/auth/callback`;
}

export default async function handler(req, res) {
  switch (req.query.action) {
    case 'login': return login(req, res);
    case 'callback': return callback(req, res);
    case 'logout': return logout(req, res);
    case 'me': return me(req, res);
    case 'delete-data': return deleteData(req, res);
    case 'broadcaster-connect': return broadcasterConnect(req, res);
    case 'broadcaster-status': return broadcasterStatus(req, res);
    case 'broadcaster-disconnect': return broadcasterDisconnect(req, res);
    case 'broadcaster-debug': return broadcasterDebug(req, res);
    case 'chat-connect': return chatConnect(req, res);
    case 'chat-disconnect': return chatDisconnect(req, res);
    default: return res.status(404).send('Unknown auth action.');
  }
}

function login(req, res) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch login is not configured yet (missing TWITCH_CLIENT_ID).');
  const state = crypto.randomBytes(16).toString('hex');
  setStateCookie(res, state);
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUriFor(req), response_type: 'code', scope: '', state });
  res.writeHead(302, { Location: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` });
  res.end();
}

async function callback(req, res) {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send('Twitch login failed.');
  const savedState = getStateCookie(req);
  clearStateCookie(res);
  if (!state || !savedState || state !== savedState) return res.status(400).send('Login could not be verified (state mismatch). Please try logging in again.');
  // Broadcaster connections use a state that ends in ".b" (see broadcasterConnect).
  if (String(savedState).endsWith('.b')) return broadcasterCallback(req, res, code);
  if (String(savedState).endsWith('.c')) return chatCallback(req, res, code);

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).send('Twitch login is not configured yet (missing client credentials).');

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: code || '', grant_type: 'authorization_code', redirect_uri: redirectUriFor(req) })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      const reason = twitchReason(tokenRes, tokenData);
      console.error(`Twitch login token exchange failed (HTTP ${reason.status})${reason.message ? ': ' + reason.message : ''}`);
      return res.status(502).send(`Could not complete Twitch login (token exchange failed). Twitch said: ${reason.message || 'no reason given'} (HTTP ${reason.status}).`);
    }

    const userRes = await fetch('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Client-Id': clientId } });
    const userData = await userRes.json();
    const twitchUser = userData && userData.data && userData.data[0];
    if (!twitchUser) return res.status(502).send('Could not fetch your Twitch profile.');

    const maxAge = 60 * 60 * 24 * 30;
    const token = signSession({ login: twitchUser.login, displayName: twitchUser.display_name, avatar: twitchUser.profile_image_url }, maxAge);
    setSessionCookie(res, token, maxAge);
    res.writeHead(302, { Location: '/?view=fishdex' });
    res.end();
  } catch (err) {
    console.error('Twitch OAuth callback error:', err);
    res.status(500).send('Something went wrong logging you in. Please try again.');
  }
}

function logout(req, res) {
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/?view=fishdex' });
  res.end();
}

function me(req, res) {
  const user = getSessionUser(req);
  if (!user) return res.status(200).json({ loggedIn: false });
  return res.status(200).json({ loggedIn: true, login: user.login, displayName: user.displayName, avatar: user.avatar });
}

async function deleteData(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const user = getSessionUser(req);
  if (!user?.login) return res.status(401).json({ error: 'You must be logged in with Twitch.' });
  try {
    await deleteUserData(user.login);
    clearSessionCookie(res);
    // The deletion endpoint also needs to remove the browser-side tutorial
    // state. Server-side deletion cannot directly edit localStorage, so use
    // the standard Clear-Site-Data response directive for this origin. This
    // runs only after the account deletion succeeds and prevents an old
    // "I'll explore myself" choice from surviving the data wipe.
    res.setHeader('Clear-Site-Data', '"storage"');
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Self-service user data deletion failed:', error);
    return res.status(500).json({ error: 'Could not delete your data. Please try again or contact Fishing Hub support.' });
  }
}

// ---------------------------------------------------------------------------
// Broadcaster Twitch verification
// ---------------------------------------------------------------------------

// Only the channel's own Broadcaster Admin, signed in with the Twitch account
// for that channel, may connect, check, or disconnect Twitch verification.
async function requireBroadcasterAdmin(req) {
  const adminSession = getBroadcasterAdminSession(req);
  if (!adminSession) return { status: 401, error: 'Unlock Broadcaster Admin first.' };
  const viewer = getSessionUser(req);
  const viewerLogin = normalizeBroadcasterLogin(viewer?.login);
  if (!viewerLogin) return { status: 401, error: 'Sign in with Twitch first.' };
  const account = await getBroadcasterAdmin(adminSession.channel);
  if (!account || !account.enabled) return { status: 403, error: 'This Broadcaster Admin account is not enabled.' };
  if (viewerLogin !== account.twitchLogin || viewerLogin !== normalizeBroadcasterLogin(adminSession.twitchLogin)) {
    return { status: 403, error: 'Sign in with the Twitch account for this channel to continue.' };
  }
  return { channel: account.channel, twitchLogin: account.twitchLogin };
}

async function broadcasterConnect(req, res) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch is not configured yet (missing TWITCH_CLIENT_ID).');
  const access = await requireBroadcasterAdmin(req);
  if (access.error) return res.status(access.status).send(access.error);

  const state = `${crypto.randomBytes(16).toString('hex')}.b`;
  setStateCookie(res, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriFor(req),
    response_type: 'code',
    scope: BROADCASTER_SCOPES.join(' '),
    state,
    force_verify: 'true'
  });
  res.writeHead(302, { Location: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` });
  res.end();
}

async function broadcasterCallback(req, res, code) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).send('Twitch is not configured yet (missing client credentials).');
  const access = await requireBroadcasterAdmin(req);
  if (access.error) return res.status(access.status).send(access.error);

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: code || '', grant_type: 'authorization_code', redirect_uri: redirectUriFor(req) })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token || !tokenData.refresh_token) {
      const reason = twitchReason(tokenRes, tokenData);
      console.error(`Twitch connect token exchange failed (HTTP ${reason.status})${reason.message ? ': ' + reason.message : ''}`);
      return res.status(502).send(`Could not connect Twitch (token exchange failed). Twitch said: ${reason.message || 'no reason given'} (HTTP ${reason.status}). Please try again.`);
    }

    const granted = Array.isArray(tokenData.scope) ? tokenData.scope : String(tokenData.scope || '').split(' ');
    const missing = BROADCASTER_SCOPES.filter((s) => !granted.includes(s));
    if (missing.length) {
      return res.status(400).send(`Twitch did not grant every permission (missing: ${missing.join(', ')}). Please connect again and accept all of them.`);
    }

    const userRes = await fetch('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Client-Id': clientId } });
    const twitchUser = (await userRes.json())?.data?.[0];
    if (!twitchUser) return res.status(502).send('Could not read your Twitch profile. Please try again.');
    if (normalizeBroadcasterLogin(twitchUser.login) !== access.twitchLogin) {
      return res.status(403).send('The Twitch account you connected must be the owner of this channel.');
    }

    await saveBroadcasterTwitchRecord(access.channel, {
      broadcasterId: String(twitchUser.id),
      login: normalizeBroadcasterLogin(twitchUser.login),
      refreshToken: tokenData.refresh_token,
      scopes: granted,
      connectedAt: new Date().toISOString()
    });
    res.writeHead(302, { Location: '/?view=fishdex&twitch=connected' });
    res.end();
  } catch (err) {
    console.error('Broadcaster Twitch callback error:', err);
    res.status(500).send('Something went wrong connecting Twitch. Please try again.');
  }
}

// Readable by the channel's own Twitch login so the profile can show it. Only
// the connect and disconnect actions need the Broadcaster Admin unlock.
async function broadcasterStatus(req, res) {
  const viewerLogin = normalizeBroadcasterLogin(getSessionUser(req)?.login);
  if (!viewerLogin) return res.status(200).json({ eligible: false });
  const account = await getBroadcasterAdmin(viewerLogin);
  if (!account || !account.enabled || account.twitchLogin !== viewerLogin) {
    return res.status(200).json({ eligible: false });
  }
  const adminSession = getBroadcasterAdminSession(req);
  const canManage = !!adminSession
    && normalizeBroadcasterLogin(adminSession.channel) === account.channel
    && normalizeBroadcasterLogin(adminSession.twitchLogin) === viewerLogin;
  const record = await getBroadcasterTwitchRecord(account.channel);
  return res.status(200).json({
    eligible: true,
    canManage,
    connected: recordIsComplete(record),
    login: record?.login || null,
    connectedAt: record?.connectedAt || null
  });
}

async function broadcasterDebug(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // MasterAdmin uses its signed operator token because this diagnostic now
  // lives in the MasterAdmin Stream section. Broadcaster Admin remains a
  // valid path for backwards compatibility. Neither path can expose tokens.
  const authHeader = String(req.headers?.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const master = validateSession(bearer);
  let channel = normalizeBroadcasterLogin(req.method === 'POST' ? req.body?.channel : req.query?.channel);

  if (master) {
    if (!channel) return res.status(400).json({ error: 'Enter a streamer/channel to diagnose.' });
  } else {
    const access = await requireBroadcasterAdmin(req);
    if (access.error) return res.status(access.status).json({ error: access.error });
    channel = access.channel;
  }

  const viewer = normalizeBroadcasterLogin(
    req.method === 'POST' ? req.body?.viewer : req.query?.viewer
  ) || normalizeBroadcasterLogin(getSessionUser(req)?.login);
  const result = await diagnoseTwitchRole(channel, viewer);
  return res.status(200).json({ success: true, ...result });
}

async function broadcasterDisconnect(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const access = await requireBroadcasterAdmin(req);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const record = await getBroadcasterTwitchRecord(access.channel);
  if (record?.refreshToken) await revokeBroadcasterTwitch(access.channel);
  await deleteBroadcasterTwitchRecord(access.channel);
  return res.status(200).json({ success: true });
}

// ---- Viewer chat (send messages from the site as the logged-in viewer) ----
function chatConnect(req, res) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch is not configured yet (missing TWITCH_CLIENT_ID).');
  const user = getSessionUser(req);
  if (!user) return res.status(401).send('Log in with Twitch first.');
  const state = crypto.randomBytes(16).toString('hex') + '.c';
  setStateCookie(res, state);
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUriFor(req), response_type: 'code', scope: VIEWER_CHAT_SCOPE, state });
  res.writeHead(302, { Location: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` });
  res.end();
}

async function chatCallback(req, res, code) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const user = getSessionUser(req);
  if (!clientId || !clientSecret) return res.status(500).send('Twitch is not configured yet (missing client credentials).');
  if (!user) return res.status(401).send('Log in with Twitch first, then enable chat.');
  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: code || '', grant_type: 'authorization_code', redirect_uri: redirectUriFor(req) })
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token || !tokenData.refresh_token) {
      const reason = twitchReason(tokenRes, tokenData);
      console.error(`Viewer chat token exchange failed (HTTP ${reason.status})${reason.message ? ': ' + reason.message : ''}`);
      return res.status(502).send(`Could not enable chat (token exchange failed). Twitch said: ${reason.message || 'no reason given'} (HTTP ${reason.status}). Please try again.`);
    }
    const granted = Array.isArray(tokenData.scope) ? tokenData.scope : String(tokenData.scope || '').split(' ');
    if (!granted.includes(VIEWER_CHAT_SCOPE)) {
      return res.status(400).send('Twitch did not grant chat permission. Please enable chat again and accept it.');
    }
    const userRes = await fetch('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Client-Id': clientId } });
    const twitchUser = (await userRes.json())?.data?.[0];
    if (!twitchUser) return res.status(502).send('Could not read your Twitch profile. Please try again.');
    // The chat token must belong to the same Twitch account that is logged in.
    if (String(twitchUser.login).toLowerCase() !== String(user.login).toLowerCase()) {
      return res.status(403).send('Enable chat with the same Twitch account you are logged in with.');
    }
    await saveViewerChatAuth(user.login, {
      userId: String(twitchUser.id),
      refreshToken: tokenData.refresh_token,
      scopes: granted,
      connectedAt: new Date().toISOString()
    });
    res.writeHead(302, { Location: '/game?chat=linked' });
    res.end();
  } catch (err) {
    console.error('Viewer chat callback error:', err?.message || err);
    res.status(500).send('Something went wrong enabling chat. Please try again.');
  }
}

async function chatDisconnect(req, res) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in first.' });
  await deleteViewerChatAuth(user.login);
  return res.status(200).json({ ok: true });
}

