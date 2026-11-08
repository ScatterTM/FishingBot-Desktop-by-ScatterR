import { withKeyLock } from './inventory.js';

const MAIL_RETENTION = 150;

function cleanUser(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function makeId() {
  return `mail-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function recordUserMail(db, user, event = {}) {
  const userKey = cleanUser(user);
  if (!db || !userKey) return null;

  const entry = {
    id: makeId(),
    type: String(event.type || 'account').toLowerCase(),
    subtype: String(event.subtype || 'account_change').toLowerCase(),
    title: String(event.title || 'Account update'),
    message: String(event.message || ''),
    actor: String(event.actor || 'admin'),
    createdAt: Date.now(),
    meta: event.meta && typeof event.meta === 'object' ? event.meta : {}
  };

  await withKeyLock(db, `user-mail:${userKey}`, async () => {
    let entries = [];
    const raw = await db.get(`user:mail:${userKey}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) entries = parsed;
      } catch (_) { console.error('[lib/user-mail.js:35] ignored error:', _?.message || _); }
    }
    entries.push(entry);
    await db.set(`user:mail:${userKey}`, JSON.stringify(entries.slice(-MAIL_RETENTION)));
  });

  return entry;
}

export async function getUserMail(db, user, limit = MAIL_RETENTION) {

  const userKey = cleanUser(user);
  if (!db || !userKey) return [];
  const raw = await db.get(`user:mail:${userKey}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const readRaw = await db.get(`user-mail-read:${userKey}`);
    let readIds = [];
    try {
      const parsedRead = readRaw ? JSON.parse(readRaw) : [];
      if (Array.isArray(parsedRead)) readIds = parsedRead.filter((id) => typeof id === 'string');
    } catch (_) { console.error('[lib/user-mail.js:58] ignored error:', _?.message || _); }
    const readSet = new Set(readIds);
    return parsed
      .filter((entry) => entry && typeof entry === 'object')
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .slice(0, Math.max(1, Math.min(MAIL_RETENTION, Number(limit) || MAIL_RETENTION)))
      .map((entry) => ({ ...entry, read: !!entry.readAt || readSet.has(String(entry.id)) }));
  } catch (_) {
    return [];
  }
}


export async function markUserMailRead(db, user, ids = []) {
  const userKey = cleanUser(user);
  if (!db || !userKey) return;
  const cleanIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id || '').trim()).filter(Boolean))].slice(-500);
  if (!cleanIds.length) return;
  await withKeyLock(db, `user-mail-read:${userKey}`, async () => {
    const raw = await db.get(`user-mail-read:${userKey}`);
    let existing = [];
    try { const parsed = raw ? JSON.parse(raw) : []; if (Array.isArray(parsed)) existing = parsed.filter((id) => typeof id === 'string'); } catch (_) { console.error('[lib/user-mail.js:79] ignored error:', _?.message || _); }
    const merged = [...new Set([...existing, ...cleanIds])].slice(-500);
    await db.set(`user-mail-read:${userKey}`, JSON.stringify(merged));
  });
}
