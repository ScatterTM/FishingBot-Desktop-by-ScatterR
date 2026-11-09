// Database manager worker (lib/db-manager-worker.mjs). The desktop app's database manager (desktop-electron/db-manager.js) starts this
// file for each request, with the same Node 22.5+ binary the local server uses. It reads one JSON request
// from stdin and writes one JSON reply to stdout. It uses node:sqlite, so it needs no native module.
//
// Operations:
//   list  -> every entry in the kv and kv_list tables
//   read  -> one entry, with a hash of its stored text
//   save  -> replace one entry, only if its stored text still has the hash the editor read (otherwise conflict)
// Before every save the previous value is written to data/db-manager-backups/ (the newest ones are kept; the
// Folder settings choose how many).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';


const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// Current stored state of one entry. The hash covers exactly what the editor is shown.
function stateOf(db, key, kind) {
  if (kind === 'list') {
    const items = db.prepare('SELECT v FROM kv_list WHERE k = ? ORDER BY i ASC').all(key).map((r) => r.v);
    return { exists: items.length > 0, items, hash: sha(JSON.stringify(items)) };
  }
  const row = db.prepare('SELECT v, exp FROM kv WHERE k = ?').get(key);
  return {
    exists: !!row,
    raw: row ? row.v : null,
    expires: row ? row.exp : null,
    hash: row ? sha(row.v) : 'missing',
  };
}

function opList(db) {
  const now = Date.now();
  const values = db.prepare('SELECT k, length(v) AS size, exp FROM kv ORDER BY k').all().map((r) => ({
    key: r.k,
    kind: 'value',
    size: r.size,
    expires: r.exp,
    expired: r.exp != null && r.exp <= now,
  }));
  const lists = db.prepare('SELECT k, COUNT(*) AS n, SUM(length(v)) AS size FROM kv_list GROUP BY k ORDER BY k')
    .all()
    .map((r) => ({ key: r.k, kind: 'list', count: r.n, size: r.size || 0, expired: false }));
  // Both SQL streams are already key-ordered. Merge them in linear time instead of
  // concatenating and sorting every registered key again in JavaScript.
  const items = [];
  let valueIndex = 0;
  let listIndex = 0;
  while (valueIndex < values.length || listIndex < lists.length) {
    if (listIndex >= lists.length || (valueIndex < values.length
      && values[valueIndex].key <= lists[listIndex].key)) {
      items.push(values[valueIndex++]);
    } else {
      items.push(lists[listIndex++]);
    }
  }
  return { items };
}

function opRead(db, req) {
  const state = stateOf(db, req.key, req.kind);
  if (req.kind === 'list') return { kind: 'list', key: req.key, items: state.items, hash: state.hash };
  if (!state.exists) return { kind: 'value', key: req.key, missing: true, hash: state.hash };
  return { kind: 'value', key: req.key, raw: state.raw, expires: state.expires, hash: state.hash };
}

function writeBackup(dir, key, kind, before, keep) {
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const name = `${now.replace(/[:.]/g, '-')}-${kind}-${sha(key).slice(0, 10)}.json`;
  const body = {
    key,
    kind,
    savedAt: now,
    expires: before.expires ?? null,
    before: kind === 'list' ? before.items : (before.raw ?? null),
  };
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
}

function opSave(db, req) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = stateOf(db, req.key, req.kind);
    if (before.hash !== req.expectedHash) {
      db.exec('ROLLBACK');
      return { conflict: true };
    }
    writeBackup(req.backupDir, req.key, req.kind, before, req.keep || 50);
    if (req.kind === 'list') {
      db.prepare('DELETE FROM kv_list WHERE k = ?').run(req.key);
      const insert = db.prepare('INSERT INTO kv_list (k, i, v) VALUES (?, ?, ?)');
      req.items.forEach((v, i) => insert.run(req.key, i, v));
    } else if (before.exists) {
      // Keeps the expiry the server set.
      db.prepare('UPDATE kv SET v = ? WHERE k = ?').run(req.raw, req.key);
    } else {
      db.prepare('INSERT INTO kv (k, v, exp) VALUES (?, ?, NULL)').run(req.key, req.raw);
    }
    db.exec('COMMIT');
    return { hash: stateOf(db, req.key, req.kind).hash };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing open */ }
    throw err;
  }
}

// Search: every entry whose key or stored text contains the query (case-insensitive for ASCII).
// Returns one row per entry with the matching snippet and how many places matched. Capped for the window.
const SEARCH_MAX = 300;
const SEARCH_MIN = 2;
const SEARCH_QUERY_MAX = 100;

function likePattern(text) {
  return '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

function countOf(text, query) {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function snippetOf(text, query, radius = 36) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 120);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function opSearch(db, req) {
  const query = String(req.query || '').trim().slice(0, SEARCH_QUERY_MAX);
  if (query.length < SEARCH_MIN) return { matches: [] };
  const pattern = likePattern(query);
  const now = Date.now();
  const found = new Map();

  for (const r of db.prepare("SELECT k, v, exp FROM kv WHERE k LIKE ? ESCAPE '\\' OR v LIKE ? ESCAPE '\\' ORDER BY k LIMIT ?")
    .all(pattern, pattern, SEARCH_MAX)) {
    const onKey = r.k.toLowerCase().includes(query.toLowerCase());
    const valueHits = countOf(r.v, query);
    found.set(r.k, {
      key: r.k,
      kind: 'value',
      size: r.v.length,
      expires: r.exp,
      expired: r.exp != null && r.exp <= now,
      keyMatch: onKey,
      count: valueHits + (onKey ? 1 : 0),
      snippet: valueHits ? snippetOf(r.v, query) : r.k,
    });
  }

  for (const r of db.prepare("SELECT k, i, v FROM kv_list WHERE v LIKE ? ESCAPE '\\' ORDER BY k, i LIMIT ?")
    .all(pattern, SEARCH_MAX * 4)) {
    let row = found.get(r.k);
    if (!row) {
      row = {
        key: r.k, kind: 'list', size: 0, expires: null, expired: false, keyMatch: false, count: 0, snippet: snippetOf(r.v, query),
      };
      found.set(r.k, row);
    }
    row.count += countOf(r.v, query);
  }

  const matches = [...found.values()].slice(0, SEARCH_MAX);
  return { matches };
}

function done(reply) {
  process.stdout.write(JSON.stringify(reply), () => process.exit(0));
}

async function main() {
  const req = JSON.parse((await readStdin()) || '{}');
  // Loaded here, not at the top: if node:sqlite is missing the reply says so instead of crashing the process.
  const { DatabaseSync } = await import('node:sqlite');
  if (!fs.existsSync(req.dbPath)) {
    // A fresh install has no database yet: there is nothing to list.
    if (req.op === 'list') return { items: [] };
    if (req.op === 'search') return { matches: [] };
    throw new Error(`Database file not found: ${req.dbPath}`);
  }
  const db = new DatabaseSync(req.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    if (req.op === 'list') return opList(db);
    if (req.op === 'read') return opRead(db, req);
    if (req.op === 'save') return opSave(db, req);
    if (req.op === 'search') return opSearch(db, req);
    throw new Error('Unknown database operation.');
  } finally {
    db.close();
  }
}

main().then(
  (result) => done({ ok: true, ...result }),
  (err) => done({ ok: false, error: err.message || String(err) }),
);
