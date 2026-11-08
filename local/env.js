// Loads the local settings file (.env) before anything else reads
// process.env. Keep this file the FIRST import of local/launcher.js, because
// lib/session.js and lib/db.js read their settings when they are loaded.
//
// If a secret is missing (SESSION_SECRET, BOT_SECRET), a random one is
// generated and written back into .env, so a fresh install works without
// manual steps.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_CONFIG } from './release-config.js';

// Selects the SQLite database in lib/db.js. Must run before those modules load.
process.env.LOCAL_EDITION = '1';

export const ROOT = resolveRoot();
export const ENV_FILE = path.join(ROOT, '.env');
export const LOOT_TABLE_FILE = path.join(ROOT, 'data', 'loot-table.json');

function resolveRoot() {
  if (process.env.FISHING_ROOT) return path.resolve(process.env.FISHING_ROOT);
  // The packaged .exe keeps its html/, styles/ and data/ folders next to it.
  if (process.pkg) return path.dirname(process.execPath);
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch (_e) {
    return process.cwd();
  }
}

const TEMPLATE = `# FishingsysDEV - local edition settings
# Optional legacy website OAuth app. Normal bot sign-in uses the separate
# public Device Code Client ID embedded in the official Fishingbot build.
TWITCH_CLIENT_ID=${RELEASE_CONFIG.websiteTwitchClientId}
TWITCH_CLIENT_SECRET=
FISHINGBOT_EXTENSION_RELAY_URL=${RELEASE_CONFIG.extensionRelayUrl}

PORT=3000
# Forced to the local loopback origin by this edition.
PUBLIC_BASE_URL=http://localhost:3000
LOCAL_DB_PATH=data/fishing.sqlite

# Generated automatically on first start when left empty.
SESSION_SECRET=
BOT_SECRET=

# Legacy Master Admin environment variables are ignored in local mode; the Control Centre password is used.
ADMIN_USERNAME=
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=

# Optional public GitHub owner/repository for desktop application updates.
FISHINGBOT_UPDATE_REPOSITORY=
`;

function parseEnv(text) {
  const out = {};
  // Notepad can save a UTF-8 byte order mark; without this the first key is not found.
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function setLine(text, key, value) {
  const lines = text.split(/\r?\n/);
  const next = [];
  let inserted = false;
  for (const line of lines) {
    if (line.trim().startsWith(`${key}=`)) {
      if (!inserted) {
        next.push(`${key}=${value}`);
        inserted = true;
      }
      // Drop duplicate definitions so a later stale value cannot override this one.
      continue;
    }
    next.push(line);
  }
  if (!inserted) next.push(`${key}=${value}`);
  return next.join('\n').replace(/\n*$/, '\n');
}

// Copies non-empty values from .env into process.env. Values set in the real
// environment win on the first load; a re-check (reloadSettings) lets the file win.
function applyFile(text, { override }) {
  const fromFile = parseEnv(text);
  for (const [key, value] of Object.entries(fromFile)) {
    if (value === '') continue;
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
  return fromFile;
}


function replaceFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    try { fs.unlinkSync(destination); } catch (_) { }
    fs.renameSync(source, destination);
  }
}

export function saveTwitchSettings({ clientId, clientSecret } = {}) {
  const nextId = String(clientId ?? '').trim();
  const nextSecret = String(clientSecret ?? '');
  if (!/^[a-zA-Z0-9]{10,128}$/.test(nextId)) {
    return { ok: false, status: 400, error: 'Enter a valid Twitch Client ID (10–128 letters or numbers).' };
  }
  if (nextSecret && (nextSecret.length < 20 || nextSecret.length > 256 || /[\r\n]/.test(nextSecret))) {
    return { ok: false, status: 400, error: 'The Twitch Client Secret must be 20–256 characters on one line.' };
  }
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : TEMPLATE;
  text = setLine(text, 'TWITCH_CLIENT_ID', nextId);
  // An empty field means “keep the current secret”; it is never echoed back.
  if (nextSecret) text = setLine(text, 'TWITCH_CLIENT_SECRET', nextSecret);
  const temp = `${ENV_FILE}.tmp`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  replaceFile(temp, ENV_FILE);
  reloadSettings();
  return { ok: true, ...settingsReport() };
}

// Re-reads .env without restarting. Used by the setup page's "check again" button.
export function reloadSettings() {
  if (!fs.existsSync(ENV_FILE)) return { found: false, file: ENV_FILE };
  clearLegacyPublicHostingSettings();
  clearLegacyExtensionCredentials();
  let text = fs.readFileSync(ENV_FILE, 'utf8');
  applyFile(text, { override: true });
  if (!process.env.TWITCH_CLIENT_ID) process.env.TWITCH_CLIENT_ID = RELEASE_CONFIG.websiteTwitchClientId;
  if (!process.env.BOT_TWITCH_CLIENT_ID && RELEASE_CONFIG.botTwitchClientId) process.env.BOT_TWITCH_CLIENT_ID = RELEASE_CONFIG.botTwitchClientId;
  if (!process.env.FISHINGBOT_EXTENSION_RELAY_URL) process.env.FISHINGBOT_EXTENSION_RELAY_URL = RELEASE_CONFIG.extensionRelayUrl;
  text = setLine(text, 'FISHINGBOT_EXTENSION_RELAY_URL', process.env.FISHINGBOT_EXTENSION_RELAY_URL || '');
  if (!process.env.PORT) process.env.PORT = '3000';
  // Even after a settings reload, keep OAuth and generated links on loopback.
  process.env.PUBLIC_BASE_URL = `http://localhost:${process.env.PORT}`;
  text = setLine(text, 'PUBLIC_BASE_URL', process.env.PUBLIC_BASE_URL);
  // .env stores this path relative to the Fishingbot folder. Re-resolve it
  // after every settings reload so later DB access cannot switch to cwd/data.
  const dbPath = process.env.LOCAL_DB_PATH || 'data/fishing.sqlite';
  process.env.LOCAL_DB_PATH = path.resolve(ROOT, dbPath);
  process.env.LOCAL_LOOT_TABLE_PATH = LOOT_TABLE_FILE;
  process.env.LOCAL_ADMIN_AUTH_FILE = path.join(ROOT, 'data', 'local-admin.json');
  fs.writeFileSync(ENV_FILE, text, { encoding: 'utf8', mode: 0o600 });
  return { found: true, file: ENV_FILE };
}


const ENV_VALUE_VALIDATORS = {
  FISHINGBOT_UPDATE_REPOSITORY: (value) => !value || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
};

// Writes only explicitly supported, validated values. Secrets are never
// returned to the UI. Empty secret fields preserve the already saved value.
export function saveEnvValues(values = {}) {
  const updates = {};
  for (const [key, raw] of Object.entries(values || {})) {
    if (!Object.prototype.hasOwnProperty.call(ENV_VALUE_VALIDATORS, key)) {
      throw new Error(`Unsupported setting: ${key}`);
    }
    const value = String(raw ?? '').trim();
    if (!ENV_VALUE_VALIDATORS[key](value)) {
      throw new Error(`Invalid value for ${key.replaceAll('_', ' ')}.`);
    }
    updates[key] = value;
  }
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : TEMPLATE;
  for (const [key, value] of Object.entries(updates)) text = setLine(text, key, value);
  const temp = `${ENV_FILE}.tmp`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  replaceFile(temp, ENV_FILE);
  reloadSettings();
  return { ok: true };
}

// The Extension ID and shared secret now live only on the hosted relay.
// Remove legacy copies from older local .env files so they are not retained.
function clearLegacyExtensionCredentials() {
  for (const key of ['TWITCH_EXTENSION_ID', 'TWITCH_EXTENSION_SECRET', 'TWITCH_EXTENSION_OWNER_ID']) {
    delete process.env[key];
  }
  if (!fs.existsSync(ENV_FILE)) return;
  const original = fs.readFileSync(ENV_FILE, 'utf8');
  const filtered = original.split(/\r?\n/).filter((line) =>
    !/^\s*TWITCH_EXTENSION_(?:ID|SECRET|OWNER_ID)\s*=/.test(line)
  ).join('\n');
  if (filtered !== original) {
    fs.writeFileSync(ENV_FILE, filtered.replace(/\n*$/, '\n'), { encoding: 'utf8', mode: 0o600 });
    console.log('[setup] Removed retired local Twitch Extension credentials from .env.');
  }
}

function clearLegacyPublicHostingSettings() {
  // v2.1.3 no longer supports DuckDNS/Caddy. Remove old credentials from both
  // the current process and .env so retired tokens are not retained.
  for (const key of ['DUCKDNS_DOMAIN', 'DUCKDNS_TOKEN', 'TLS_EMAIL']) delete process.env[key];
  if (!fs.existsSync(ENV_FILE)) return;
  const original = fs.readFileSync(ENV_FILE, 'utf8');
  const filtered = original.split(/\r?\n/).filter((line) =>
    !/^\s*(?:DUCKDNS_DOMAIN|DUCKDNS_TOKEN|TLS_EMAIL)\s*=/.test(line)
  ).join('\n');
  if (filtered !== original) {
    fs.writeFileSync(ENV_FILE, filtered.replace(/\n*$/, '\n'), { encoding: 'utf8', mode: 0o600 });
    console.log('[setup] Removed retired DuckDNS/Caddy settings from .env.');
  }
}

function loadEnv() {
  clearLegacyPublicHostingSettings();
  clearLegacyExtensionCredentials();
  if (!fs.existsSync(ENV_FILE)) fs.writeFileSync(ENV_FILE, TEMPLATE, 'utf8');
  let text = fs.readFileSync(ENV_FILE, 'utf8');
  applyFile(text, { override: false });
  if (!process.env.TWITCH_CLIENT_ID) process.env.TWITCH_CLIENT_ID = RELEASE_CONFIG.websiteTwitchClientId;
  if (!process.env.BOT_TWITCH_CLIENT_ID && RELEASE_CONFIG.botTwitchClientId) process.env.BOT_TWITCH_CLIENT_ID = RELEASE_CONFIG.botTwitchClientId;
  if (!process.env.FISHINGBOT_EXTENSION_RELAY_URL) process.env.FISHINGBOT_EXTENSION_RELAY_URL = RELEASE_CONFIG.extensionRelayUrl;
  text = setLine(text, 'FISHINGBOT_EXTENSION_RELAY_URL', process.env.FISHINGBOT_EXTENSION_RELAY_URL || '');

  // Generated secrets: written back to the file once, then reused.
  for (const key of ['SESSION_SECRET', 'BOT_SECRET']) {
    if (!process.env[key]) {
      process.env[key] = crypto.randomBytes(32).toString('hex');
      text = setLine(text, key, process.env[key]);
      console.log(`[setup] Generated ${key} and saved it to .env`);
    }
  }
  if (!process.env.PORT) process.env.PORT = '3000';
  // External base URLs from old tunnel / DuckDNS setups must not survive the rollback.
  // OAuth and generated links always use the local-only origin in this release.
  process.env.PUBLIC_BASE_URL = `http://localhost:${process.env.PORT}`;
  text = setLine(text, 'PUBLIC_BASE_URL', process.env.PUBLIC_BASE_URL);
  fs.writeFileSync(ENV_FILE, text, 'utf8');
  const dbPath = process.env.LOCAL_DB_PATH || 'data/fishing.sqlite';
  process.env.LOCAL_DB_PATH = path.resolve(ROOT, dbPath);
  process.env.LOCAL_LOOT_TABLE_PATH = LOOT_TABLE_FILE;
  process.env.LOCAL_ADMIN_AUTH_FILE = path.join(ROOT, 'data', 'local-admin.json');
}

loadEnv();

// Tells the console (and the setup page) which settings were actually found.
export function settingsReport() {
  const found = (k) => (process.env[k] ? 'found' : 'missing');
  return { file: ENV_FILE, clientId: found('TWITCH_CLIENT_ID'), clientIdValue: process.env.TWITCH_CLIENT_ID || '', clientSecret: found('TWITCH_CLIENT_SECRET') };
}
