// GET  -> { loggedIn, linked, channels }   (never returns tokens)
// POST -> sends { channel, message } as the logged-in viewer.
import { getSessionUser } from '../session.js';
import { getViewerAccessToken, readViewerChatAuth } from '../viewer-chat.js';
import { db } from '../db.js';
import { getBroadcasterAdmin, listBroadcasterAdmins, normalizeBroadcasterLogin } from '../broadcaster-admin.js';

const CLIENT_ID = () => process.env.TWITCH_CLIENT_ID || '';

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GET/POST from our own pages may omit it
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export async function chatSendHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const user = getSessionUser(req);
  if (req.method === 'GET') {
    // Channel names open for chat: the broadcaster accounts MasterAdmin has enabled.
    const accounts = await listBroadcasterAdmins().catch(() => []);
    const channels = accounts.filter((a) => a.enabled && a.channel).map((a) => a.channel);
    if (!user) return res.status(200).json({ loggedIn: false, linked: false, channels });
    const auth = await readViewerChatAuth(user.login).catch(() => null);
    return res.status(200).json({ loggedIn: true, linked: !!auth, channels });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Request blocked.' });
  if (!user) return res.status(401).json({ error: 'Log in with Twitch first.' });

  const channel = String(req.body?.channel || '').trim().replace(/^#/, '').toLowerCase();
  const message = String(req.body?.message || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
  if (!/^[a-z0-9_]{3,25}$/.test(channel)) return res.status(400).json({ error: 'Choose a valid channel first.' });
  // Only broadcasters that MasterAdmin has enabled can receive messages from the site.
  const approved = await getBroadcasterAdmin(normalizeBroadcasterLogin(channel)).catch(() => null);
  if (!approved || approved.enabled === false) return res.status(403).json({ error: 'Chat is only open for approved broadcasters.' });
  if (!message) return res.status(400).json({ error: 'Type a message first.' });
  if (message.length > 500) return res.status(400).json({ error: 'Messages can be up to 500 characters.' });

  // One message per second per viewer, to stay well inside Twitch's limits.
  const rate = await db.set(`chat:rate:${user.login}`, '1', { nx: true, ex: 1 }).catch(() => true);
  if (!rate) return res.status(429).json({ error: 'Slow down: one message per second.' });

  const token = await getViewerAccessToken(user.login).catch(() => null);
  if (!token) return res.status(401).json({ error: 'Chat is not enabled for your account. Enable it again.', needsLink: true });

  try {
    const bRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Client-Id': CLIENT_ID() }
    });
    const broadcaster = (await bRes.json().catch(() => ({})))?.data?.[0];
    if (!broadcaster) return res.status(404).json({ error: 'That channel was not found on Twitch.' });

    const sRes = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Client-Id': CLIENT_ID(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcaster_id: String(broadcaster.id), sender_id: String(token.userId), message })
    });
    const result = (await sRes.json().catch(() => ({})))?.data?.[0];
    if (!sRes.ok || !result) return res.status(502).json({ error: 'Twitch did not accept the message.' });
    if (!result.is_sent) return res.status(422).json({ error: result.drop_reason?.message || 'Message was not sent.' });
    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('chat-send error:', err?.message || err);
    return res.status(502).json({ error: 'Could not reach Twitch. Try again.' });
  }
}
