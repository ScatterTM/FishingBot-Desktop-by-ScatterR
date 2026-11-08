import { withKeyLock } from './inventory.js';

const ADMIN_AUDIT_KEY = 'admin:audit:events';
const ADMIN_AUDIT_RETENTION = 250;
const FISH_AUDIT_SEQUENCE_KEY = 'admin:audit:fish:sequence';
const FISH_AUDIT_SLOT_PREFIX = 'admin:audit:fish:slot:';
// Per-catch audit is disabled by default: it is diagnostic data, not game state,
// and writing it for every !fish can create a large amount of database write/log
// traffic. Set FISH_AUDIT_ENABLED=true only when you actively need the feed.
const FISH_AUDIT_ENABLED = String(process.env.FISH_AUDIT_ENABLED || '').toLowerCase() === 'true';
const FISH_AUDIT_RETENTION = 50;

function createAuditEntry(event = {}, idPrefix = '') {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return {
    id: `${idPrefix}${uniqueId}`,
    occurredAt: new Date().toISOString(),
    actor: String(event.actor || 'admin'),
    action: String(event.action || 'unknown'),
    target: String(event.target || ''),
    details: String(event.details || ''),
    status: event.status === 'error' ? 'error' : 'success'
  };
}

export async function recordAdminAudit(db, event = {}) {
  if (!db) return null;

  const entry = createAuditEntry(event);
  await withKeyLock(db, 'admin-audit', async () => {
    let events = [];
    const raw = await db.get(ADMIN_AUDIT_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) events = parsed;
      } catch (_error) { console.error('[lib/audit.js:37] ignored error:', _error?.message || _error); }
    }
    events.push(entry);
    await db.set(ADMIN_AUDIT_KEY, JSON.stringify(events.slice(-ADMIN_AUDIT_RETENTION)));
  });

  return entry;
}

// Twitch catches use a bounded ring of slots: one atomic sequence increment
// and one slot write, without the read/modify/write lock used for admin actions.
export async function recordFishCatchAudit(db, event = {}) {
  if (!db || !FISH_AUDIT_ENABLED) return null;

  const sequence = Number(await db.incr(FISH_AUDIT_SEQUENCE_KEY));
  const slot = ((sequence - 1) % FISH_AUDIT_RETENTION) + 1;
  const entry = { ...createAuditEntry(event, 'fish-'), sequence };
  await db.set(`${FISH_AUDIT_SLOT_PREFIX}${slot}`, JSON.stringify(entry));
  return entry;
}

// Permanently removes one audit entry by id, from the admin ring and from
// the fish-catch slots. The dashboard's X button calls this through the
// deleteAuditEntry admin action - without it, a locally hidden entry would
// simply reappear on the next 3-second poll.
export async function deleteAdminAuditEntry(db, id) {
  if (!db || !id || typeof id !== 'string') return false;
  let removed = false;

  await withKeyLock(db, 'admin-audit', async () => {
    const raw = await db.get(ADMIN_AUDIT_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const kept = parsed.filter((entry) => !entry || entry.id !== id);
          if (kept.length !== parsed.length) {
            removed = true;
            await db.set(ADMIN_AUDIT_KEY, JSON.stringify(kept));
          }
        }
      } catch (_error) { console.error('[lib/audit.js:78] ignored error:', _error?.message || _error); }
    }
  });

  const sequence = Number(await db.get(FISH_AUDIT_SEQUENCE_KEY)) || 0;
  if (sequence > 0) {
    const firstSequence = Math.max(1, sequence - FISH_AUDIT_RETENTION + 1);
    const slotKeys = [];
    for (let s = firstSequence; s <= sequence; s++) {
      slotKeys.push(`${FISH_AUDIT_SLOT_PREFIX}${((s - 1) % FISH_AUDIT_RETENTION) + 1}`);
    }
    const rawFishEvents = await db.mget(slotKeys);
    for (let index = 0; index < slotKeys.length; index++) {
      try {
        const entry = JSON.parse(rawFishEvents?.[index] || 'null');
        if (entry && entry.id === id && entry.sequence === firstSequence + index) {
          await db.del(slotKeys[index]);
          removed = true;
        }
      } catch (_error) { console.error('[lib/audit.js:97] ignored error:', _error?.message || _error); }
    }
  }

  return removed;
}

export async function getRecentAdminAudit(db, limit = 100) {
  if (!db) return [];

  const [rawAdmin, rawFishSequence] = await Promise.all([
    db.get(ADMIN_AUDIT_KEY),
    db.get(FISH_AUDIT_SEQUENCE_KEY)
  ]);
  const events = [];
  if (rawAdmin) {
    try {
      const parsed = JSON.parse(rawAdmin);
      if (Array.isArray(parsed)) events.push(...parsed.slice(-ADMIN_AUDIT_RETENTION));
    } catch (_error) { console.error('[lib/audit.js:116] ignored error:', _error?.message || _error); }
  }

  const fishSequence = Number(rawFishSequence) || 0;
  // Fetch only the page actually requested. The old code always fetched all
  // 150 fish-audit slots, even when the admin UI only displayed a small page.
  if (FISH_AUDIT_ENABLED && fishSequence > 0) {
    const wanted = Math.max(1, Math.min(FISH_AUDIT_RETENTION, Number(limit) || 100));
    const firstSequence = Math.max(1, fishSequence - wanted + 1);
    const sequences = Array.from({ length: fishSequence - firstSequence + 1 }, (_, index) => firstSequence + index);
    const slotKeys = sequences.map((sequence) => `${FISH_AUDIT_SLOT_PREFIX}${((sequence - 1) % FISH_AUDIT_RETENTION) + 1}`);
    const rawFishEvents = await db.mget(slotKeys);
    for (let index = 0; index < sequences.length; index++) {
      try {
        const entry = JSON.parse(rawFishEvents?.[index] || 'null');
        if (entry && entry.sequence === sequences[index]) events.push(entry);
      } catch (_error) { console.error('[lib/audit.js:132] ignored error:', _error?.message || _error); }
    }
  }

  return events
    .sort((a, b) => {
      const byTime = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
      return byTime || (Number(b.sequence) || 0) - (Number(a.sequence) || 0);
    })
    .slice(0, Math.max(1, Math.min(250, Number(limit) || 100)));
}
