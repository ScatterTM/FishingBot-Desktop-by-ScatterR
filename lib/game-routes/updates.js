import { db } from '../db.js';
import { withKeyLock } from '../inventory.js';
import { recordAdminAudit } from '../audit.js';
import { validateSession } from '../../api/admin-tools.js';

// Site updates ("patch notes"). Everyone can read them; only a validated admin
// session can add, edit or remove them. Stored as one JSON array, newest first.
const UPDATES_KEY = 'site:updates';
const MAX_UPDATES = 50;
const MAX_TITLE = 80;
const MAX_BODY = 2000;

async function readUpdates() {
  try {
    const raw = await db.get(UPDATES_KEY);
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function clean(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

async function audit(actor, action, details) {
  try { await recordAdminAudit(db, { actor, action, target: 'site', details }); }
  catch (error) { console.error('Admin audit write failed:', error); }
}

export async function updatesHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!db) return res.status(500).json({ error: 'Database not configured.' });
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ updates: await readUpdates() });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const session = validateSession(token);
    if (!session) return res.status(401).json({ error: 'Unauthorized: admin session expired or invalid.' });
    const actor = session.username;

    const { action, id } = req.body || {};
    const title = clean(req.body?.title, MAX_TITLE);
    const body = clean(req.body?.body, MAX_BODY);

    if (action === 'add' || action === 'update') {
      if (!title) return res.status(400).json({ error: 'An update needs a title.' });
      if (!body) return res.status(400).json({ error: 'An update needs some text.' });
    }
    if (!['add', 'update', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'Unknown update action.' });
    }

    return await withKeyLock(db, 'site-updates', async () => {
      const list = await readUpdates();

      if (action === 'add') {
        const entry = {
          id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          title, body, date: new Date().toISOString(), author: actor
        };
        const next = [entry, ...list].slice(0, MAX_UPDATES);
        await db.set(UPDATES_KEY, JSON.stringify(next));
        await audit(actor, 'addUpdate', `Posted update: ${title}`);
        return res.status(200).json({ success: true, updates: next, message: 'Update posted.' });
      }

      const index = list.findIndex((u) => u.id === id);
      if (index < 0) return res.status(404).json({ error: 'That update no longer exists.' });

      if (action === 'update') {
        list[index] = { ...list[index], title, body, edited: new Date().toISOString() };
        await db.set(UPDATES_KEY, JSON.stringify(list));
        await audit(actor, 'editUpdate', `Edited update: ${title}`);
        return res.status(200).json({ success: true, updates: list, message: 'Update saved.' });
      }

      const [removed] = list.splice(index, 1);
      await db.set(UPDATES_KEY, JSON.stringify(list));
      await audit(actor, 'removeUpdate', `Removed update: ${removed.title}`);
      return res.status(200).json({ success: true, updates: list, message: 'Update removed.' });
    });
  } catch (error) {
    console.error('[Updates API]', error);
    return res.status(500).json({ error: 'Could not update the site updates.' });
  }
}
