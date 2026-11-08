// Key/value client for the LOCAL edition, backed by a SQLite file.
//
// Implements the local-first SQLite database API used by the v2.6.0 runtime. Uses Node's
// built-in node:sqlite (Node 22.5+): no native npm dependencies. The file is
// opened lazily on the first call, so importing this module has no side
// effects (the retired hosted edition did not open it).
//
// Optional RPC helpers (fishPlayers, recordFishingCatch, autofishProgress)
// return null. Every caller has a pre-migration fallback path for that case.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkInventoryItems } from './item-check.js';

// node:sqlite is loaded with require(), not import(). Inside the packed .exe
// (CommonJS bundle) a dynamic import() fails with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
// In plain ESM there is no require, so createRequire is used.
const nodeRequire = typeof require === 'function'
  ? require
  : createRequire(path.join(process.cwd(), 'package.json'));

let sql = null;
let stmt = null;
let opening = null;
let dbPath = null;

function resolvePath() {
  return process.env.LOCAL_DB_PATH || path.resolve(process.cwd(), 'data', 'fishing.sqlite');
}

function ensureOpen() {
  if (!opening) {
    opening = (async () => {
      const { DatabaseSync } = nodeRequire('node:sqlite');
      dbPath = resolvePath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      sql = new DatabaseSync(dbPath);
      sql.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS kv (
          k   TEXT PRIMARY KEY,
          v   TEXT NOT NULL,
          exp INTEGER
        );
        CREATE TABLE IF NOT EXISTS kv_list (
          k TEXT NOT NULL,
          i INTEGER NOT NULL,
          v TEXT NOT NULL,
          PRIMARY KEY (k, i)
        );
      `);
      stmt = {
        getRow: sql.prepare('SELECT v, exp FROM kv WHERE k = ?'),
        upsert: sql.prepare(
          'INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ' +
          'ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp'
        ),
        delKv: sql.prepare('DELETE FROM kv WHERE k = ?'),
        delList: sql.prepare('DELETE FROM kv_list WHERE k = ?'),
        listAll: sql.prepare('SELECT v FROM kv_list WHERE k = ? ORDER BY i ASC'),
        listMax: sql.prepare('SELECT COALESCE(MAX(i), -1) AS m FROM kv_list WHERE k = ?'),
        listCount: sql.prepare('SELECT COUNT(*) AS c FROM kv_list WHERE k = ?'),
        listInsert: sql.prepare('INSERT INTO kv_list (k, i, v) VALUES (?, ?, ?)'),
        scanKv: sql.prepare('SELECT k FROM kv WHERE k GLOB ? AND (exp IS NULL OR exp > ?)'),
        scanList: sql.prepare('SELECT DISTINCT k FROM kv_list WHERE k GLOB ?'),
        unlock: sql.prepare('DELETE FROM kv WHERE k = ? AND v = ?')
      };
      return sql;
    })();
  }
  return opening;
}

const now = () => Date.now();

// Live row for a key, or null. Expired rows are removed on read.
function readLive(key) {
  const row = stmt.getRow.get(key);
  if (!row) return null;
  if (row.exp !== null && row.exp <= now()) {
    stmt.delKv.run(key);
    return null;
  }
  return row;
}

// One SQLite transaction. node:sqlite is synchronous, so nothing else can
// run inside fn.
function transaction(fn) {
  sql.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    sql.exec('COMMIT');
    return out;
  } catch (error) {
    try { sql.exec('ROLLBACK'); } catch (_e) { /* already rolled back */ }
    throw error;
  }
}

function flat(values) {
  return values.flat().filter((v) => v !== undefined && v !== null);
}

function setSync(key, value, { ex = null, nx = false } = {}) {
  if (nx && readLive(key)) return null;
  const exp = ex ? now() + Number(ex) * 1000 : null;
  stmt.upsert.run(key, String(value), exp);
  return 'OK';
}

function delSync(keys) {
  const list = flat(keys).filter(Boolean);
  for (const key of list) {
    stmt.delKv.run(key);
    stmt.delList.run(key);
  }
  return list.length;
}

function incrBySync(key, amount) {
  const row = readLive(key);
  const current = row ? Number(row.v) || 0 : 0;
  const next = current + Number(amount);
  stmt.upsert.run(key, String(next), row ? row.exp : null);
  return next;
}

function rpushSync(key, values) {
  let index = Number(stmt.listMax.get(key).m) + 1;
  for (const value of values) {
    stmt.listInsert.run(key, index, String(value));
    index += 1;
  }
  return Number(stmt.listCount.get(key).c);
}

function cleanImportLogin(value) {
  const login = String(value || '').trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new Error('Enter a valid Twitch login (1–25 letters, numbers or underscores).');
  return login;
}

function belongsToUser(key, login) {
  const segments = String(key || '').toLowerCase().split(/[:._/|\-]+/).filter(Boolean);
  if (!segments.includes(login)) return false;
  const root = segments[0] || '';
  return !new Set(['local', 'admin', 'master', 'broadcaster', 'channel', 'global', 'config', 'extension', 'session', 'auth', 'audit']).has(root);
}

// A list row is one entry of a Redis-style list: it carries an index (i or index).
function isListRow(row) {
  return !!row && typeof row === 'object' && (row.i !== undefined || row.index !== undefined);
}

// Accepts three shapes: a Fishingbot viewer export ({ kv, kv_list }), a plain table export
// (a top-level array with one row per key, as Supabase and spreadsheet tools produce), or
// { rows } from older exports. Only keys that belong to the selected viewer are kept.
function normalizeUserExport(payload, login) {
  const cleanLogin = cleanImportLogin(login);
  let kvInput;
  let listInput;
  if (Array.isArray(payload)) {
    kvInput = payload.filter((row) => !isListRow(row));
    listInput = payload.filter((row) => isListRow(row));
  } else if (payload && typeof payload === 'object') {
    kvInput = Array.isArray(payload.kv) ? payload.kv : Array.isArray(payload.rows) ? payload.rows : [];
    listInput = Array.isArray(payload.kv_list) ? payload.kv_list : [];
  } else {
    throw new Error('Choose a viewer export or a table export with key and value columns (JSON, CSV or SQL).');
  }
  if (kvInput.length + listInput.length > 20000) throw new Error('The export contains too many database rows (maximum 20,000).');

  const skipped = { notThisViewer: 0, invalid: 0, expired: 0 };
  const kv = [];
  const lists = new Map();
  const listKeys = new Set([`fish:rares:${cleanLogin}`, `fish:treasury:${cleanLogin}`]);
  for (const row of kvInput) {
    const key = String(row?.k ?? row?.key ?? '').trim();
    if (!key || key.length > 512 || (row?.v === undefined && row?.value === undefined)) { skipped.invalid += 1; continue; }
    if (!belongsToUser(key, cleanLogin)) { skipped.notThisViewer += 1; continue; }
    const rawValue = row.v ?? row.value;
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
    const expRaw = row.exp ?? row.expires_at ?? null;
    let exp = null;
    if (expRaw !== null && expRaw !== '' && expRaw !== 'null') {
      exp = Number(expRaw);
      if (!Number.isFinite(exp)) {
        const parsedDate = Date.parse(String(expRaw));
        if (Number.isFinite(parsedDate)) exp = parsedDate;
      } else if (exp > 0 && exp < 100000000000) {
        // Supabase exports commonly serialize timestamptz as epoch seconds;
        // SQLite's local expiry column is epoch milliseconds.
        exp *= 1000;
      }
      if (!Number.isFinite(exp) || exp < 0) { skipped.invalid += 1; continue; }
      if (exp <= now()) { skipped.expired += 1; continue; }
    }

    // The Supabase KV RPC stores Redis-style lists in the `kv_store.value`
    // field as JSON arrays. SQLite has a normalized kv_list table, so accept
    // these raw rows and translate the two player inventory list namespaces.
    if (listKeys.has(key)) {
      let parsed = null;
      try { parsed = Array.isArray(rawValue) ? rawValue : JSON.parse(value); } catch (_) { parsed = null; }
      if (Array.isArray(parsed)) {
        lists.set(key, parsed.map((item, index) => [index, typeof item === 'string' ? item : String(item ?? '')]));
        continue;
      }
    }
    kv.push({ key, value, exp });
  }
  for (const row of listInput) {
    const key = String(row?.k ?? row?.key ?? '').trim();
    if (!key || key.length > 512 || (row?.v === undefined && row?.value === undefined)) { skipped.invalid += 1; continue; }
    if (!belongsToUser(key, cleanLogin)) { skipped.notThisViewer += 1; continue; }
    const index = Number(row.i ?? row.index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 100000) throw new Error(`Invalid list index for key ${key}.`);
    const value = typeof row.v === 'string' ? row.v : String(row.v ?? row.value ?? '');
    if (!lists.has(key)) lists.set(key, []);
    lists.get(key).push([index, value]);
  }
  const normalizedLists = [...lists.entries()].map(([key, rows]) => ({
    key,
    values: rows.sort((a, b) => a[0] - b[0]).map((row) => row[1])
  }));
  if (kv.length + normalizedLists.reduce((sum, item) => sum + item.values.length, 0) > 20000) {
    throw new Error('The selected user contains too many importable records (maximum 20,000).');
  }
  return { login: cleanLogin, kv, lists: normalizedLists, skipped };
}

// Checks the viewer's fish inventory names against the loot catalogue, so an
// import that would mislabel rarities is reported before anything is written.
function importItemCheck(normalized) {
  const inventoryKey = `fish:rares:${normalized.login}`;
  const list = normalized.lists.find((entry) => entry.key === inventoryKey);
  if (!list) return null;
  return checkInventoryItems(list.values);
}

function importSummary(normalized) {
  return {
    login: normalized.login,
    importedKv: normalized.kv.length,
    importedListRows: normalized.lists.reduce((sum, list) => sum + list.values.length, 0),
    importedLists: normalized.lists.length,
    skipped: normalized.skipped,
    itemCheck: importItemCheck(normalized)
  };
}

// Dry run: reports what an import would write, without writing anything.
async function previewUserData(payload, login) {
  await ensureOpen();
  return { ...importSummary(normalizeUserExport(payload, login)), preview: true };
}

async function exportUserData(login) {
  await ensureOpen();
  const cleanLogin = cleanImportLogin(login);
  const kvRows = sql.prepare('SELECT k, v, exp FROM kv').all()
    .filter((row) => belongsToUser(row.k, cleanLogin) && (row.exp === null || row.exp > now()))
    .map((row) => ({ k: row.k, v: row.v, exp: row.exp }));
  const listRows = sql.prepare('SELECT k, i, v FROM kv_list').all()
    .filter((row) => belongsToUser(row.k, cleanLogin))
    .map((row) => ({ k: row.k, i: row.i, v: row.v }));
  return {
    format: 'fishingbot-supabase-user-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    user: cleanLogin,
    kv: kvRows,
    kv_list: listRows
  };
}

async function importUserData(payload, login) {
  await ensureOpen();
  const normalized = normalizeUserExport(payload, login);
  transaction(() => {
    for (const row of normalized.kv) stmt.upsert.run(row.key, row.value, row.exp);
    for (const list of normalized.lists) {
      stmt.delList.run(list.key);
      list.values.forEach((value, index) => stmt.listInsert.run(list.key, index, value));
    }
  });
  return { ...importSummary(normalized), preview: false };
}

export const db = {
  async get(k) {
    await ensureOpen();
    const row = readLive(k);
    return row ? row.v : null;
  },

  async set(k, value, opts = {}) {
    await ensureOpen();
    return setSync(k, value, { ex: opts.ex ?? null, nx: !!opts.nx });
  },

  // Releases a lock only while it still holds this token (one statement).
  async unlock(k, token) {
    await ensureOpen();
    return Number(stmt.unlock.run(k, String(token)).changes) > 0;
  },

  async del(...keys) {
    await ensureOpen();
    return delSync(keys);
  },

  async incr(k) {
    await ensureOpen();
    return incrBySync(k, 1);
  },

  async incrby(k, amount) {
    await ensureOpen();
    return incrBySync(k, amount);
  },

  async decr(k) {
    await ensureOpen();
    return incrBySync(k, -1);
  },

  async ttl(k) {
    await ensureOpen();
    const row = readLive(k);
    if (!row) return -2;
    if (row.exp === null) return -1;
    return Math.max(0, Math.ceil((row.exp - now()) / 1000));
  },

  async mget(...keys) {
    await ensureOpen();
    const list = keys.flat();
    if (list.length === 0) return [];
    return list.map((k) => {
      const row = readLive(k);
      return row ? row.v : null;
    });
  },

  // One page: all matches at once, so the callers' scan loops stop after one call.
  async scan(_cursor, opts = {}) {
    await ensureOpen();
    const pattern = (opts && opts.match) || '*';
    const keys = new Set();
    for (const row of stmt.scanKv.all(pattern, now())) keys.add(row.k);
    for (const row of stmt.scanList.all(pattern)) keys.add(row.k);
    return ['0', [...keys]];
  },

  async rpush(k, ...values) {
    await ensureOpen();
    return rpushSync(k, flat(values).map(String));
  },

  async lreplace(k, values) {
    await ensureOpen();
    const items = flat(values || []).map(String);
    return transaction(() => {
      stmt.delList.run(k);
      items.forEach((v, i) => stmt.listInsert.run(k, i, v));
      return items.length;
    });
  },

  async lrange(k) {
    await ensureOpen();
    return stmt.listAll.all(k).map((row) => row.v);
  },

  async exportUserData(login) {
    return exportUserData(login);
  },

  async importUserData(payload, login) {
    return importUserData(payload, login);
  },

  async previewUserData(payload, login) {
    return previewUserData(payload, login);
  },

  // Optional RPCs: null sends the callers to their pre-migration fallback.
  async fishPlayers() { return null; },
  async recordFishingCatch() { return null; },
  async autofishProgress() { return null; },

  async batch(ops = []) {
    await ensureOpen();
    const clean = Array.isArray(ops) ? ops.filter(Boolean) : [];
    if (!clean.length) return [];
    return transaction(() => clean.map((op) => {
      if (op.op === 'set') return setSync(op.key, op.value, { ex: op.ex ?? null });
      if (op.op === 'del') return delSync([op.key]);
      if (op.op === 'incrby') return incrBySync(op.key, op.amount);
      if (op.op === 'rpush') return rpushSync(op.key, flat(op.values || []).map(String));
      throw new Error(`Unsupported batch operation: ${op.op}`);
    }));
  }
};

export function databasePath() {
  return dbPath || resolvePath();
}

// Writes a consistent copy of the open database to targetPath (SQLite VACUUM INTO). Safe while the
// server runs. targetPath must not exist yet.
export async function backupDatabase(targetPath) {
  await ensureOpen();
  sql.exec(`VACUUM INTO '${String(targetPath).replace(/'/g, "''")}'`);
}

export function closeDatabase() {
  try { if (sql) sql.close(); } catch (_e) { /* already closed */ }
  sql = null;
  stmt = null;
  opening = null;
}
