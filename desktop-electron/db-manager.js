'use strict';

// Database manager, main-process side. The renderer asks through db:list, db:read and db:save.
// Each request runs lib/db-manager-worker.mjs in a short-lived process, with the Node binary the
// local server uses, so the desktop app needs no native module.

const { spawn } = require('node:child_process');
const path = require('node:path');
const settings = require('./settings');

const KEY_MAX = 200;
const TIMEOUT_MS = 15000;
const TEXT_MAX = 16 * 1024 * 1024;

function dbPathFor(root) {
  return process.env.LOCAL_DB_PATH || path.resolve(root, 'data', 'fishing.sqlite');
}

// The most useful line of an error output: the last one that names an error, else the last line.
function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  const named = lines.filter((line) => /error|cannot|not found|unknown|invalid/i.test(line));
  return (named.length ? named[named.length - 1] : lines[lines.length - 1]) || '';
}

function runWorker(nodeBin, root, request) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      nodeBin,
      ['--disable-warning=ExperimentalWarning', path.join(root, 'lib', 'db-manager-worker.mjs')],
      { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The database did not answer in time.'));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdin.on('error', () => { /* the worker may exit early; the reply check below reports it */ });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Node.js (${nodeBin}): ${e.message}. Set FISHINGBOT_NODE to the node binary.`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      let reply = null;
      try {
        reply = JSON.parse(lastLine(out));
      } catch {
        reply = null;
      }
      if (!reply) {
        reject(new Error(lastLine(err) || 'The database helper did not answer. Node.js 22.5 or newer is needed.'));
        return;
      }
      resolve(reply);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function checkEntry(payload) {
  if (!payload || typeof payload.key !== 'string' || !payload.key || payload.key.length > KEY_MAX) {
    throw new Error('The entry name is not valid.');
  }
  if (payload.kind !== 'value' && payload.kind !== 'list') throw new Error('Unknown entry type.');
  return { key: payload.key, kind: payload.kind };
}

function checkSave(payload) {
  const entry = checkEntry(payload);
  if (typeof payload.expectedHash !== 'string' || !payload.expectedHash) {
    throw new Error('The save request has no version to check against. Reload the entry and try again.');
  }
  if (entry.kind === 'list') {
    if (!Array.isArray(payload.items) || payload.items.some((item) => typeof item !== 'string')) {
      throw new Error('The list is not valid.');
    }
    const size = payload.items.reduce((sum, item) => sum + item.length, 0);
    if (size > TEXT_MAX) throw new Error('The list is too large to save.');
    return { ...entry, expectedHash: payload.expectedHash, items: payload.items };
  }
  if (typeof payload.raw !== 'string') throw new Error('The value is not valid.');
  if (payload.raw.length > TEXT_MAX) throw new Error('The value is too large to save.');
  return { ...entry, expectedHash: payload.expectedHash, raw: payload.raw };
}

function createDbManager({ root, server }) {
  const dbPath = dbPathFor(root);
  const backupDir = path.join(root, 'data', 'db-manager-backups');
  const call = (request) => runWorker(server.nodeBin, root, {
    ...request,
    dbPath,
    backupDir,
    keep: settings.view(root).folder.backupKeep,
  });

  return {
    // The path is sent with the list, so the Folder can say which file it reads when it is empty.
    list: async () => ({ ...(await call({ op: 'list' })), dbPath }),
    read: (payload) => call({ op: 'read', ...checkEntry(payload) }),
    save: (payload) => call({ op: 'save', ...checkSave(payload) }),
    // Searches every key and every stored text for the query (at least 2 characters, at most 100).
    search: (payload) => call({ op: 'search', query: String(payload?.query ?? '').slice(0, 100) }),
  };
}

module.exports = { createDbManager };
