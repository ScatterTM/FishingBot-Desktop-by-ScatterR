// Safe, atomic importer for full Fishingbot key/value database exports.
// This worker NEVER executes imported SQL. SQL is parsed into allow-listed INSERT rows only.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ROWS = 500_000;
const BATCH_SIZE = 500;

function statusWrite(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...value, updatedAt: Date.now() }));
  fs.renameSync(temp, file);
}

function readCancelled(file) {
  return !!file && fs.existsSync(file);
}

function rowError(row, message) {
  return { line: Number(row?._line) || Number(row?._row) || 1, message: String(message) };
}

function jsonParseWithLocation(text) {
  try { return JSON.parse(text); } catch (error) {
    const match = String(error?.message || '').match(/position\s+(\d+)/i);
    const position = match ? Number(match[1]) : 0;
    const prefix = text.slice(0, position);
    return { error: { line: prefix.split('\n').length, column: position - prefix.lastIndexOf('\n'), message: String(error?.message || 'Invalid JSON') } };
  }
}

function csvRecords(text) {
  const output = [];
  let row = [], field = '', quoted = false, line = 1, rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else { field += c; if (c === '\n') line++; }
      continue;
    }
    if (c === '"' && field.length === 0) { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r' && text[i + 1] === '\n') continue;
    if (c === '\n' || c === '\r') {
      row.push(field); field = '';
      if (row.some((v) => String(v).trim() !== '')) output.push({ fields: row, _line: rowLine });
      row = []; line++; rowLine = line; continue;
    }
    field += c;
  }
  if (quoted) throw new Error(`CSV line ${rowLine}: unclosed quoted field.`);
  if (field.length || row.length) {
    row.push(field);
    if (row.some((v) => String(v).trim() !== '')) output.push({ fields: row, _line: rowLine });
  }
  if (!output.length) return [];
  const headers = output.shift().fields.map((v) => String(v).trim().toLowerCase().replace(/^\uFEFF/, ''));
  if (!headers.some((h) => ['k', 'key', 'name'].includes(h)) || !headers.some((h) => ['v', 'value', 'data'].includes(h))) {
    throw new Error('CSV header must include key/k and value/v columns. List rows may also use i/index and kind/table/type.');
  }
  return output.map((entry, index) => {
    const record = { _line: entry._line, _row: index + 2 };
    headers.forEach((header, i) => { record[header] = entry.fields[i] ?? ''; });
    const type = String(record.kind || record.type || record.table || '').toLowerCase();
    if (type.includes('list') || record.i !== undefined || record.index !== undefined) record._recordKind = 'list';
    return record;
  });
}

function splitSql(text) {
  const statements = [];
  let statement = '', line = 1, startLine = 1, quote = null, lineComment = false, blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (lineComment) {
      if (c === '\n') { lineComment = false; statement += '\n'; line++; }
      continue;
    }
    if (blockComment) {
      if (c === '*' && next === '/') { blockComment = false; i++; statement += '  '; }
      else { if (c === '\n') line++; statement += c === '\n' ? '\n' : ' '; }
      continue;
    }
    if (quote) {
      statement += c;
      if (quote === "'" && c === "'" && next === "'") { statement += next; i++; continue; }
      if (c === quote) quote = null;
      if (c === '\n') line++;
      continue;
    }
    if (c === '-' && next === '-') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"') { quote = c; statement += c; continue; }
    if (c === ';') {
      if (statement.trim()) statements.push({ sql: statement.trim(), line: startLine });
      statement = ''; startLine = line; continue;
    }
    statement += c;
    if (c === '\n') line++;
  }
  if (quote) throw new Error(`SQL line ${startLine}: unclosed quoted string.`);
  if (blockComment) throw new Error(`SQL line ${startLine}: unclosed block comment.`);
  if (statement.trim()) statements.push({ sql: statement.trim(), line: startLine });
  return statements;
}

function sqlLiteralParser(text, line) {
  let at = 0;
  const ws = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  const literal = () => {
    ws();
    if (text[at] === "'") {
      at++;
      let out = '';
      while (at < text.length) {
        const c = text[at++];
        if (c === "'" && text[at] === "'") { out += "'"; at++; continue; }
        if (c === "'") return out;
        // Standard SQL (PostgreSQL and SQLite): a backslash is an ordinary character, so JSON
        // text such as ["Gold \"Fin\""] keeps its backslashes.
        out += c;
      }
      throw new Error(`SQL line ${line}: unclosed string literal.`);
    }
    const start = at;
    while (at < text.length && text[at] !== ',' && text[at] !== ')' && !/\s/.test(text[at])) at++;
    if (at === start) throw new Error(`SQL line ${line}: expected a literal value.`);
    const token = text.slice(start, at);
    if (/^null$/i.test(token)) return null;
    if (/^(true|false)$/i.test(token)) return /^true$/i.test(token) ? 'true' : 'false';
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) return token;
    if (/^x'[0-9a-f]*'$/i.test(token)) return token;
    throw new Error(`SQL line ${line}: unsupported SQL value ${token.slice(0, 30)}.`);
  };
  const values = [];
  while (at < text.length) {
    ws();
    if (at >= text.length) break;
    if (text[at] !== '(') throw new Error(`SQL line ${line}: expected '(' in VALUES list.`);
    at++; const row = [];
    while (true) {
      row.push(literal()); ws();
      if (text[at] === ',') { at++; continue; }
      if (text[at] === ')') { at++; break; }
      throw new Error(`SQL line ${line}: expected ',' or ')' in VALUES list.`);
    }
    values.push(row); ws();
    if (text[at] === ',') { at++; continue; }
    if (at >= text.length) break;
    throw new Error(`SQL line ${line}: unexpected text after VALUES row.`);
  }
  return values;
}

function sqlRecords(text) {
  const rows = [];
  const ignored = /^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|ROLLBACK|START\s+TRANSACTION|LOCK\s+TABLES?\b[\s\S]*|UNLOCK\s+TABLES|SET\b[\s\S]*|PRAGMA\b[\s\S]*|CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX)\b[\s\S]*|DROP\s+TABLE\b[\s\S]*|ALTER\s+TABLE\b[\s\S]*|COMMENT\s+ON\b[\s\S]*|GRANT\b[\s\S]*|REVOKE\b[\s\S]*|SELECT\s+PG_CATALOG\.SETVAL\b[\s\S]*)$/i;
  for (const statement of splitSql(text)) {
    const sql = statement.sql.replace(/\s+/g, ' ').trim();
    if (!sql) continue;
    const match = sql.match(/^INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+([\w."`\[\]]+(?:\s*\.\s*[\w."`\[\]]+)?)\s*(?:\(([^)]*)\)\s*)?VALUES\s*([\s\S]+)$/i);
    if (!match) {
      if (ignored.test(sql)) continue; // DDL/transaction metadata is deliberately not executed.
      throw new Error(`SQL line ${statement.line}: only INSERT statements for kv, kv_list, or kv_store are imported; unsupported statement was rejected.`);
    }
    const table = match[1].split('.').pop().replace(/^[`"\[]|[`"\]]$/g, '').toLowerCase();
    if (!['kv', 'kv_list', 'kv_store'].includes(table)) {
      throw new Error(`SQL line ${statement.line}: unsupported target table "${table}" (allowed: kv, kv_list, kv_store).`);
    }
    const tuples = sqlLiteralParser(match[3], statement.line);
    for (const tuple of tuples) {
      let columns;
      if (match[2]) {
        columns = match[2].split(',').map((c) => c.trim().replace(/^[`"\[]|[`"\]]$/g, '').toLowerCase());
      } else if (table === 'kv') {
        columns = tuple.length === 2 ? ['k', 'v'] : ['k', 'v', 'exp'];
      } else if (table === 'kv_list') {
        columns = ['k', 'i', 'v'];
      } else {
        columns = tuple.length === 2 ? ['key', 'value'] : ['key', 'value', 'expires_at'];
      }
      if (tuple.length !== columns.length) throw new Error(`SQL line ${statement.line}: INSERT column/value counts do not match.`);
      const row = { _line: statement.line, _row: rows.length + 1, _table: table };
      columns.forEach((column, i) => { row[column] = tuple[i]; });
      row._recordKind = table === 'kv_list' ? 'list' : 'value';
      rows.push(row);
    }
  }
  return rows;
}

function rawRowsFromJson(payload) {
  if (Array.isArray(payload)) return payload.map((row, index) => ({ ...row, _row: index + 1 }));
  if (!payload || typeof payload !== 'object') throw new Error('JSON file must contain {kv, kv_list}, {rows}, or an array of key/value rows.');
  const result = [];
  if (Array.isArray(payload.kv)) result.push(...payload.kv.map((row, index) => ({ ...row, _recordKind: 'value', _row: index + 1 })));
  if (Array.isArray(payload.kv_list)) result.push(...payload.kv_list.map((row, index) => ({ ...row, _recordKind: 'list', _row: index + 1 })));
  if (!result.length && Array.isArray(payload.rows)) result.push(...payload.rows.map((row, index) => ({ ...row, _row: index + 1 })));
  if (!result.length && Array.isArray(payload.data)) result.push(...payload.data.map((row, index) => ({ ...row, _row: index + 1 })));
  if (!result.length) throw new Error('JSON file contains no kv, kv_list, rows, or data records.');
  return result;
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function expiration(value) {
  if (value === undefined || value === null || value === '' || /^null$/i.test(String(value))) return null;
  let out = Number(value);
  if (!Number.isFinite(out)) out = Date.parse(String(value));
  if (!Number.isFinite(out) || out < 0) throw new Error('Expiration must be null, a valid date, or an epoch timestamp.');
  if (out > 0 && out < 100_000_000_000) out *= 1000;
  return Math.round(out);
}

// A list value is a JSON array, or a JSON string that holds one (some export tools encode it twice).
function listFromValue(value) {
  let text = String(value || '').trim();
  for (let depth = 0; depth < 2; depth++) {
    if (!text.startsWith('[') && !text.startsWith('"')) return null;
    let parsed;
    try { parsed = JSON.parse(text); } catch { return null; }
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed !== 'string') return null;
    text = parsed.trim();
  }
  return null;
}

function normalizeRecords(records) {
  if (records.length > MAX_ROWS) throw new Error(`The selected export contains ${records.length.toLocaleString()} rows; the limit is ${MAX_ROWS.toLocaleString()}.`);
  const errors = [];
  const kv = new Map();
  const lists = new Map();
  let rowCount = records.length;
  // List items are never merged. A row whose index is missing or already used gets the next free
  // slot after the highest index for that list, so every row is kept, in file order.
  const maxSlot = new Map();
  const addListItem = (key, preferred, entry) => {
    if (!lists.has(key)) lists.set(key, new Map());
    const bucket = lists.get(key);
    const slot = Number.isInteger(preferred) && !bucket.has(preferred) ? preferred : (maxSlot.get(key) ?? -1) + 1;
    bucket.set(slot, [entry]);
    maxSlot.set(key, Math.max(maxSlot.get(key) ?? -1, slot));
  };
  for (let index = 0; index < records.length; index++) {
    const row = records[index] || {};
    const label = Number(row._line) || Number(row._row) || index + 1;
    const table = String(row._table || row.kind || row.type || row.table || '').toLowerCase();
    const isList = row._recordKind === 'list' || table === 'kv_list' || table === 'list' || row.i !== undefined || row.index !== undefined;
    const key = String(row.k ?? row.key ?? row.name ?? '').trim();
    if (!key || key.length > 512) { errors.push(rowError({ ...row, _line: label }, 'Key is blank or longer than 512 characters.')); continue; }
    const rawValue = row.v !== undefined ? row.v : row.value !== undefined ? row.value : row.data;
    if (rawValue === undefined) { errors.push(rowError({ ...row, _line: label }, 'Value column is missing.')); continue; }
    let value = valueText(rawValue);
    const listishKey = /^fish:(?:rares|treasury):[a-z0-9_]{1,25}$/i.test(key);
    // Older KV exports serialize list namespaces as JSON arrays inside value.
    if (!isList && listishKey) {
      const parsed = listFromValue(value);
      if (parsed) {
        // An empty array still replaces the list, as before.
        if (!parsed.length && !lists.has(key)) lists.set(key, new Map());
        parsed.forEach((item, i) => addListItem(key, i, { value: valueText(item), line: label }));
        rowCount += Math.max(0, parsed.length - 1);
        continue;
      }
      // Looks like a JSON array but is not one: refuse it rather than store the text as one fish.
      if (value.trimStart().startsWith('[')) {
        errors.push(rowError({ ...row, _line: label }, `Inventory value for ${key} is not a valid JSON array. Check the export (quotes inside item names must stay escaped).`));
        continue;
      }
      // A flat export lists each element of a list as its own row with the same key and no index.
      // Those rows are the elements of the list, in file order, not duplicate values for one key.
      addListItem(key, null, { value, line: label });
      continue;
    }
    if (isList) {
      const listIndexRaw = row.i ?? row.index ?? row.list_index ?? 0;
      const listIndex = Number(listIndexRaw);
      if (!Number.isInteger(listIndex) || listIndex < 0 || listIndex > 1_000_000) { errors.push(rowError({ ...row, _line: label }, 'List index must be an integer from 0 to 1,000,000.')); continue; }
      addListItem(key, listIndex, { value, line: label });
      continue;
    }
    let exp;
    try { exp = expiration(row.exp ?? row.expires_at ?? row.expires ?? null); }
    catch (error) { errors.push(rowError({ ...row, _line: label }, error.message)); continue; }
    if (value.length > 16 * 1024 * 1024) { errors.push(rowError({ ...row, _line: label }, 'Value is larger than 16 MiB.')); continue; }
    const entry = { key, value, exp, line: label };
    if (!kv.has(key)) kv.set(key, []);
    kv.get(key).push(entry);
  }
  if (errors.length) return { errors: errors.slice(0, 100), kv: [], lists: [], rowCount };
  const kvRows = [...kv.entries()].map(([key, rows]) => ({ key, rows, sourceCount: rows.length, firstLine: rows[0].line }));
  if (rowCount > MAX_ROWS) throw new Error(`The selected export expands to ${rowCount.toLocaleString()} rows; the limit is ${MAX_ROWS.toLocaleString()}.`);
  const listKeySet = new Set(lists.keys());
  for (const record of kvRows) {
    if (listKeySet.has(record.key)) errors.push({ line: record.firstLine, message: `Key "${record.key}" appears in both kv and kv_list. A key can be only one record type.` });
  }
  if (errors.length) return { errors: errors.slice(0, 100), kv: [], lists: [], rowCount };
  const listRows = [...lists.entries()].map(([key, indexed]) => {
    const rows = [...indexed.entries()].sort((a, b) => a[0] - b[0]).map(([index, entries]) => ({ index, entries, sourceCount: entries.length, line: entries[0]?.line || 1 }));
    return { key, rows, sourceCount: rows.reduce((sum, row) => sum + row.sourceCount, 0), firstLine: rows[0]?.line || 1 };
  });
  const duplicateKeys = new Set();
  for (const record of kvRows) if (record.rows.length > 1) duplicateKeys.add(record.key);
  for (const record of listRows) if (record.rows.some((row) => row.entries.length > 1)) duplicateKeys.add(record.key);
  return { errors: [], kv: kvRows, lists: listRows, rowCount, sourceDuplicateKeys: [...duplicateKeys], sourceDuplicateCount: duplicateKeys.size, sourceDuplicateSamples: [...duplicateKeys].slice(0, 10) };
}

function parseFile(file) {
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Choose a regular file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MiB import limit.`);
  const text = fs.readFileSync(file, 'utf8');
  if (ext === '.json') {
    const parsed = jsonParseWithLocation(text);
    if (parsed?.error) throw new Error(`JSON line ${parsed.error.line}, column ${parsed.error.column}: ${parsed.error.message}`);
    return normalizeRecords(rawRowsFromJson(parsed));
  }
  if (ext === '.csv') return normalizeRecords(csvRecords(text));
  if (ext === '.sql') return normalizeRecords(sqlRecords(text));
  throw new Error('Supported file types are JSON, CSV, and SQL.');
}

function importNow(req) {
  const started = Date.now();
  // 'replace' wipes the current database inside the import transaction. Keys are then written
  // with overwrite semantics, and no duplicate prompt is needed because nothing survives the wipe.
  const replaceAll = req.policy === 'replace';
  const policy = replaceAll ? 'overwrite' : req.policy;
  const status = {
    jobId: req.jobId, phase: 'validating', fileName: path.basename(req.sourcePath),
    rowsTotal: 0, rowsProcessed: 0, rowsSucceeded: 0, rowsFailed: 0, rowsSkipped: 0,
    percent: 0, etaMs: null, errors: [], rolledBack: false
  };
  const persist = (patch = {}) => statusWrite(req.statusPath, { ...status, ...patch });
  const checkCancel = () => {
    if (readCancelled(req.cancelPath)) { const error = new Error('Import cancelled by the user.'); error.cancelled = true; throw error; }
  };
  persist();
  let database = null;
  let inTransaction = false;
  let currentLine = 1;
  try {
    checkCancel();
    const parsed = parseFile(req.sourcePath);
    status.rowsTotal = parsed.rowCount;
    if (parsed.errors.length) {
      status.errors = parsed.errors;
      persist({ phase: 'validation-failed', percent: 0, etaMs: null, rowsFailed: parsed.errors.length, message: 'Validation failed. No database rows were changed.' });
      return { exitCode: 2 };
    }
    if (!status.rowsTotal) {
      persist({ phase: 'validation-failed', message: 'The selected file has no importable rows.', errors: [{ line: 1, message: 'No importable rows were found.' }] });
      return { exitCode: 2 };
    }
    if (!['skip', 'overwrite', 'prompt', 'replace'].includes(req.policy)) throw new Error('Unknown duplicate policy. Choose skip, overwrite, prompt, or replace.');
    const { DatabaseSync } = requireSqlite();
    const dbPath = path.resolve(req.dbPath);
    const hadDatabaseBeforeImport = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    database = new DatabaseSync(dbPath);
    database.exec('PRAGMA busy_timeout = 10000; CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER); CREATE TABLE IF NOT EXISTS kv_list (k TEXT NOT NULL, i INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, i));');

    const incomingKeys = [...new Set([...parsed.kv.map((r) => r.key), ...parsed.lists.map((r) => r.key)])];
    const existingKeys = new Set();
    const getKv = database.prepare('SELECT 1 AS found FROM kv WHERE k = ?');
    const getList = database.prepare('SELECT 1 AS found FROM kv_list WHERE k = ? LIMIT 1');
    for (const key of incomingKeys) if (getKv.get(key) || getList.get(key)) existingKeys.add(key);
    const duplicateKeys = new Set([...existingKeys, ...(parsed.sourceDuplicateKeys || [])]);
    const duplicateCount = duplicateKeys.size;
    if (policy === 'prompt' && duplicateCount) {
      persist({ phase: 'needs-confirmation', percent: 0, duplicateCount, duplicateSamples: [...duplicateKeys].slice(0, 10), message: `${duplicateCount} duplicate key(s) were found in the imported file or current database. Choose overwrite or skip to continue.` });
      return { exitCode: 0 };
    }

    const backupDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `pre-import-${stamp}.sqlite`);
    if (hadDatabaseBeforeImport) {
      database.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      status.backupPath = backupPath;
    }

    checkCancel();
    database.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    if (replaceAll) database.exec('DELETE FROM kv; DELETE FROM kv_list;');
    status.phase = 'importing';
    status.percent = 0;
    persist({ message: 'Validated. Import is running in a transaction.' });
    const upsert = database.prepare('INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp');
    const insertList = database.prepare('INSERT INTO kv_list (k, i, v) VALUES (?, ?, ?)');
    const deleteKv = database.prepare('DELETE FROM kv WHERE k = ?');
    const deleteList = database.prepare('DELETE FROM kv_list WHERE k = ?');
    const operations = [
      ...parsed.kv.map((record) => ({ type: 'kv', record })),
      ...parsed.lists.map((record) => ({ type: 'list', record }))
    ];
    let processed = 0, succeeded = 0, skipped = 0, nextPersistAt = BATCH_SIZE;
    const recordProgress = (rowCount, successCount, skipCount, force = false) => {
      processed += rowCount;
      succeeded += successCount;
      skipped += skipCount;
      status.rowsProcessed = Math.min(status.rowsTotal, processed);
      status.rowsSucceeded = succeeded;
      status.rowsSkipped = skipped;
      status.percent = Math.min(99, Math.round((status.rowsProcessed / Math.max(1, status.rowsTotal)) * 100));
      const elapsed = Date.now() - started;
      status.etaMs = status.rowsProcessed > 0 ? Math.max(0, Math.round((elapsed / status.rowsProcessed) * Math.max(0, status.rowsTotal - status.rowsProcessed))) : null;
      if (force || processed >= nextPersistAt || processed >= status.rowsTotal) {
        status.currentLine = currentLine;
        persist({ currentLine, message: 'Importing validated rows…' });
        while (nextPersistAt <= processed) nextPersistAt += BATCH_SIZE;
        checkCancel();
      }
    };
    for (const op of operations) {
      checkCancel();
      const record = op.record;
      currentLine = record.firstLine || record.rows[0]?.line || 1;
      const rawCount = op.type === 'kv' ? record.rows.length : record.sourceCount;
      if (policy === 'skip' && existingKeys.has(record.key)) {
        recordProgress(rawCount, 0, rawCount, true);
        continue;
      }
      if (op.type === 'kv') {
        // Duplicate source rows for a key: skip keeps the first, overwrite keeps the last.
        const chosen = policy === 'overwrite' ? record.rows[record.rows.length - 1] : record.rows[0];
        deleteList.run(record.key);
        upsert.run(record.key, chosen.value, chosen.exp);
        recordProgress(record.rows.length, 1, Math.max(0, record.rows.length - 1), record.rows.length > 1);
      } else {
        // A list is replaced as a unit so stale trailing elements from the old database do not survive.
        deleteList.run(record.key);
        deleteKv.run(record.key);
        let keySuccess = 0, keySkipped = 0, keyProcessed = 0;
        for (const item of record.rows) {
          checkCancel();
          currentLine = item.line || currentLine;
          const chosen = policy === 'overwrite' ? item.entries[item.entries.length - 1] : item.entries[0];
          insertList.run(record.key, item.index, chosen.value);
          keySuccess += 1;
          keySkipped += Math.max(0, item.entries.length - 1);
          keyProcessed += item.entries.length;
          // Persist within large lists too, instead of waiting for an entire key to finish.
          if (keyProcessed >= BATCH_SIZE) {
            recordProgress(keyProcessed, keySuccess, keySkipped, true);
            keyProcessed = 0; keySuccess = 0; keySkipped = 0;
          }
        }
        if (keyProcessed) recordProgress(keyProcessed, keySuccess, keySkipped, true);
      }
    }
    checkCancel();
    database.exec('COMMIT');
    inTransaction = false;
    status.rowsProcessed = status.rowsTotal;
    status.rowsSucceeded = succeeded;
    status.rowsSkipped = skipped;
    status.rowsFailed = 0;
    persist({ phase: 'completed', percent: 100, etaMs: 0, message: `Import completed. ${succeeded} source rows accepted; ${skipped} skipped.`, finishedAt: Date.now() });
    return { exitCode: 0 };
  } catch (error) {
    if (inTransaction && database) {
      try { database.exec('ROLLBACK'); } catch { /* already rolled back */ }
      inTransaction = false;
    }
    if (error.cancelled) {
      persist({ phase: 'cancelled', percent: 0, rowsSucceeded: 0, rowsFailed: 0, rolledBack: true, etaMs: null, message: 'Import cancelled. All changes were rolled back.', finishedAt: Date.now() });
      return { exitCode: 0 };
    }
    status.rowsFailed = 1;
    persist({ phase: 'failed', percent: 0, rowsSucceeded: 0, rolledBack: true, etaMs: null, errors: [{ line: currentLine || status.currentLine || 1, message: error.message || String(error) }], message: 'Import failed. All changes were rolled back.', finishedAt: Date.now() });
    return { exitCode: 2 };
  } finally {
    try { database?.close(); } catch { /* ignored */ }
    try { fs.rmSync(req.cancelPath, { force: true }); } catch { /* ignored */ }
  }
}

function requireSqlite() {
  // static import is not used so missing Node 22.5 gets reported via job status.
  if (!globalThis.__fishingbotSqlite) throw new Error('Node.js 22.5 or newer with node:sqlite is required for database imports.');
  return globalThis.__fishingbotSqlite;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const req = JSON.parse(raw || '{}');
  const { DatabaseSync } = await import('node:sqlite');
  globalThis.__fishingbotSqlite = { DatabaseSync };
  const result = importNow(req);
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  try {
    const req = JSON.parse(process.env.FISHINGBOT_IMPORT_REQUEST || '{}');
    if (req.statusPath) statusWrite(req.statusPath, { jobId: req.jobId, phase: 'failed', rowsTotal: 0, rowsProcessed: 0, rowsSucceeded: 0, rowsFailed: 1, rowsSkipped: 0, percent: 0, errors: [{ line: 1, message: error.message || String(error) }], rolledBack: true, message: 'Import could not start.' });
  } catch { /* no status path available */ }
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 2;
});
