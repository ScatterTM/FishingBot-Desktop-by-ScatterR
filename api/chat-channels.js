// Public list of broadcaster channels that are open for chat: the accounts
// MasterAdmin has enabled. Only channel names are returned.
import { listBroadcasterAdmins } from '../lib/broadcaster-admin.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  const accounts = await listBroadcasterAdmins().catch(() => []);
  const channels = accounts.filter((a) => a.enabled && a.channel).map((a) => a.channel);
  return res.status(200).json({ channels });
}
