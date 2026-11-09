'use strict';

// Long-running atomic database import jobs. Source files are selected via Electron's native dialog;
// all SQL is parsed by lib/db-import-worker.mjs and is never executed as SQL.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { dialog } = require('electron');

const ALLOWED_EXTENSIONS = new Set(['.json', '.csv', '.sql']);
const MAX_FILE_BYTES = 256 * 1024 * 1024;

function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// Status files survive restarts and are written atomically so the UI never reads a partial JSON file.
function writeStatus(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
    try { fs.renameSync(temp, file); }
    catch (error) {
      // Windows may reject replacing an existing destination; retain the old valid file until the new one is ready.
      if (!fs.existsSync(file)) throw error;
      const swap = `${file}.swap`;
      try { fs.copyFileSync(temp, swap); fs.renameSync(swap, file); }
      finally { try { fs.rmSync(swap, { force: true }); } catch {} }
    }
  } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
}

function createDbImportManager({ root, server, getWindow }) {
  const jobsDir = path.join(root, 'data', 'import-jobs');
  const jobs = new Map();
  const dbPath = process.env.LOCAL_DB_PATH || path.resolve(root, 'data', 'fishing.sqlite');

  async function chooseFile() {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
      title: 'Import old Fishingbot database',
      properties: ['openFile'],
      filters: [{ name: 'Database exports', extensions: ['json', 'csv', 'sql'] }]
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const sourcePath = path.resolve(result.filePaths[0]);
    const extension = path.extname(sourcePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('Choose a JSON, CSV, or SQL export file.');
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error('Choose a regular file.');
    if (stat.size > MAX_FILE_BYTES) throw new Error('The selected file is larger than the 256 MiB limit.');
    return { canceled: false, path: sourcePath, name: path.basename(sourcePath), size: stat.size };
  }

  function start(sourcePath, policy = 'prompt') {
    const source = path.resolve(String(sourcePath || ''));
    const extension = path.extname(source).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('Choose a JSON, CSV, or SQL export file.');
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('The selected import file no longer exists.');
    if (fs.statSync(source).size > MAX_FILE_BYTES) throw new Error('The selected file is larger than the 256 MiB limit.');
    if (!['skip', 'overwrite', 'prompt', 'replace'].includes(policy)) throw new Error('Duplicate policy must be skip, overwrite, prompt, or replace.');
    fs.mkdirSync(jobsDir, { recursive: true });

    const jobId = crypto.randomUUID();
    const statusPath = path.join(jobsDir, `${jobId}.json`);
    const cancelPath = path.join(jobsDir, `${jobId}.cancel`);
    const initial = {
      jobId, phase: 'validating', fileName: path.basename(source), rowsTotal: 0, rowsProcessed: 0,
      rowsSucceeded: 0, rowsFailed: 0, rowsSkipped: 0, percent: 0, etaMs: null, errors: [], rolledBack: false,
      message: 'Validating file before import.', startedAt: Date.now()
    };
    writeStatus(statusPath, initial);
    const request = { jobId, sourcePath: source, dbPath, statusPath, cancelPath, policy };
    const nodeBin = server?.nodeBin || process.env.FISHINGBOT_NODE || 'node';
    const child = spawn(nodeBin, ['--disable-warning=ExperimentalWarning', path.join(root, 'lib', 'db-import-worker.mjs')], {
      cwd: root,
      env: { ...process.env, FISHINGBOT_IMPORT_REQUEST: JSON.stringify(request) },
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-5000); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
    jobs.set(jobId, { child, statusPath, cancelPath, sourcePath: source });
    child.on('error', (error) => {
      const old = readStatus(statusPath) || initial;
      writeStatus(statusPath, { ...old, phase: 'failed', rowsFailed: 1, rolledBack: true, errors: [{ line: 1, message: `Could not start the Node.js import worker: ${error.message}` }], message: 'Import worker failed to start.', finishedAt: Date.now() });
      jobs.delete(jobId);
    });
    child.on('close', (code) => {
      const status = readStatus(statusPath);
      if (status && ['validating', 'importing'].includes(status.phase)) {
        writeStatus(statusPath, {
          ...status, phase: code === 0 ? 'completed' : 'failed',
          percent: code === 0 ? 100 : status.percent,
          rowsFailed: code === 0 ? 0 : 1,
          rowsSucceeded: code === 0 ? status.rowsSucceeded : 0,
          rolledBack: code !== 0,
          errors: code === 0 ? [] : [{ line: status.currentLine || 1, message: stderr.trim() || `Import worker exited with code ${code}.` }],
          message: code === 0 ? 'Import completed and saved to the database.' : 'Import worker exited unexpectedly; the transaction was rolled back.', finishedAt: Date.now()
        });
      }
      jobs.delete(jobId);
    });
    return { jobId, status: initial };
  }

  function getStatus(jobId) {
    const id = String(jobId || '');
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Unknown import job.');
    const statusPath = path.join(jobsDir, `${id}.json`);
    const status = readStatus(statusPath);
    if (!status) throw new Error('Import status is no longer available.');
    return status;
  }

  function cancel(jobId) {
    const id = String(jobId || '');
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Unknown import job.');
    const job = jobs.get(id);
    const current = getStatus(id);
    if (!job || !['validating', 'importing'].includes(current.phase)) return { accepted: false, status: current };
    fs.writeFileSync(job.cancelPath, String(Date.now()));
    return { accepted: true, status: current };
  }

  return { chooseFile, start, getStatus, cancel };
}

module.exports = { createDbImportManager };
