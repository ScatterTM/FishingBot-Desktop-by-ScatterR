// Automatic database backups for the local edition. Runs inside the server process, so it can use the
// open database (VACUUM INTO makes a consistent copy while the server runs). Settings are read from
// data/app-settings.json, section "security":
//   backupIntervalHours  0 = off, otherwise hours between backups
//   backupKeep           how many backups to keep (the oldest are deleted)
//   backupRequestedAt    a timestamp written by "Back up now"; a newer one starts a backup
import fs from 'node:fs';
import path from 'node:path';
import { backupDatabase, databasePath } from '../lib/db-sqlite.js';

const CHECK_MS = 60 * 1000;
const NAME = /^fishing-\d{8}-\d{6}\.sqlite$/;
let lastRun = 0;
let busy = false;

function dataDir() {
  return path.resolve(process.cwd(), 'data');
}

export function backupFolder() {
  return path.join(dataDir(), 'backups');
}

function readSecurity() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir(), 'app-settings.json'), 'utf8'));
    return raw.security && typeof raw.security === 'object' ? raw.security : {};
  } catch {
    return {};
  }
}

// The stamp in the name is local time, so the newest backup sorts last.
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function listBackups() {
  try {
    return fs.readdirSync(backupFolder())
      .filter((name) => NAME.test(name))
      .map((name) => {
        const stat = fs.statSync(path.join(backupFolder(), name));
        return { name, size: stat.size, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

// Deletes all but the newest `keep` backups.
export function pruneBackups(keep) {
  for (const old of listBackups().slice(Math.max(1, keep))) {
    try {
      fs.rmSync(path.join(backupFolder(), old.name), { force: true });
    } catch {
      /* a file that cannot be removed is kept; the next run tries again */
    }
  }
}

export async function runBackup(keep = 7) {
  if (busy) return null;
  busy = true;
  try {
    fs.mkdirSync(backupFolder(), { recursive: true });
    const name = `fishing-${stamp()}.sqlite`;
    const target = path.join(backupFolder(), name);
    await backupDatabase(target);
    lastRun = Date.now();
    pruneBackups(keep);
    console.log(`[backup] Saved ${name}`);
    return name;
  } catch (error) {
    console.error('[backup] Backup failed:', error?.message || error);
    return null;
  } finally {
    busy = false;
  }
}

async function tick() {
  if (!fs.existsSync(databasePath())) return;
  const security = readSecurity();
  const hours = Number(security.backupIntervalHours) || 0;
  const keep = Math.min(30, Math.max(1, Math.round(Number(security.backupKeep) || 7)));
  const requested = Number(security.backupRequestedAt) || 0;
  if (lastRun === 0) {
    // After a restart, the newest backup on disk counts as the last run.
    lastRun = listBackups()[0]?.modified || 0;
  }
  const due = hours > 0 && Date.now() - lastRun >= hours * 3600_000;
  if (due || requested > lastRun) await runBackup(keep);
}

export function startAutoBackup() {
  const timer = setInterval(() => { tick().catch(() => {}); }, CHECK_MS);
  timer.unref?.();
  return timer;
}
