// Viewer chat: lets a logged-in viewer send a message to a channel's chat
// through the site. The Twitch token never leaves the server. It is stored
// under a per-viewer key and used only for the Helix chat call below.
import { db } from './db.js';

export const VIEWER_CHAT_SCOPE = 'user:write:chat';
const KEY = (login) => `chat:auth:${login}`;

export async function saveViewerChatAuth(login, record) {
  await db.set(KEY(login), JSON.stringify(record));
}

export async function readViewerChatAuth(login) {
  const raw = await db.get(KEY(login));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

export async function deleteViewerChatAuth(login) {
  await db.del(KEY(login));
}

// Refresh the user token. Twitch rotates refresh tokens, so the new one must be stored.
export async function getViewerAccessToken(login) {
  const auth = await readViewerChatAuth(login);
  if (!auth || !auth.refreshToken) return null;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID || '',
      client_secret: process.env.TWITCH_CLIENT_SECRET || '',
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    await deleteViewerChatAuth(login); // revoked or expired: the viewer must enable chat again
    return null;
  }
  await saveViewerChatAuth(login, { ...auth, refreshToken: data.refresh_token || auth.refreshToken });
  return { accessToken: data.access_token, userId: auth.userId };
}
