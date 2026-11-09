'use strict';

// Electron main process: single desktop window, server lifecycle, settings,
// updates, admin actions and IPC. Apps (Control Centre tabs, settings, log) run
// inside the desktop page, so there is one native window.

const { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, screen, session, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { ServerManager } = require('./server-manager');
const { AdminClient } = require('./admin');
const { TABS, TAB_IDS } = require('./tabs');
const settings = require('./settings');
const updates = require('./update');
const queue = require('./queue');
const gameSettings = require('./game-settings');
const twitchConfig = require('./twitch-config');
const appearance = require('./appearance');
const DESKTOP_STRINGS = require('./i18n/desktop.json');

// The Fishingbot folder: holds local/, .env and data/. Installed: the exe's folder.
// Name and logo shown by Windows (taskbar, Alt+Tab, window icon). Packaged builds use the same name.
const APP_NAME = 'Fishingbot Desktop';

// Windows reads the window icon itself, and it cannot read files inside app.asar. Packaged builds
// therefore ship a copy next to the app (package.json extraResources) and use that one.
const APP_ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'app.ico')
  : path.join(__dirname, 'renderer', 'assets', 'app.ico');
app.setName(APP_NAME);

function windowIcon() {
  return fs.existsSync(APP_ICON) ? APP_ICON : undefined;
}

// Startup diagnostics. The log sits next to the crash log in the app's user data folder, so a
// "window never appeared" report can say which step was reached. Logging never stops startup.
let startupLogFile = null;
function startupLog(line) {
  if (!startupLogFile) return;
  try {
    fs.appendFileSync(startupLogFile, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

const ROOT = path.resolve(
  process.env.FISHINGBOT_ROOT ||
    (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..')),
);

const OBS_ASSET_SOURCES = Object.freeze({
  'obs-lua': path.join(ROOT, 'obs-scripts', 'fishingbot-autostart.lua'),
  'obs-setup-zip': path.join(ROOT, 'downloads', 'Fishingbot-OBS-Startup-Setup.zip'),
});
function readObsAssetCatalog() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'downloads', 'obs-scripts.json'), 'utf8'));
  if (!manifest || manifest.schema !== 1 || !manifest.assets) throw new Error('The OBS download manifest is invalid.');
  const assets = Object.entries(OBS_ASSET_SOURCES).map(([id, source]) => {
    const meta = manifest.assets[id];
    if (!meta || !/^[a-f0-9]{64}$/i.test(String(meta.sha256 || ''))) throw new Error(`OBS metadata is invalid for ${id}.`);
    const stat = fs.statSync(source);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    if (digest.toLowerCase() !== meta.sha256.toLowerCase() || stat.size !== Number(meta.size)) throw new Error(`${meta.name || id} failed its SHA-256 integrity check.`);
    return { id, ...meta, sha256: digest, size: stat.size };
  });
  return { release: String(manifest.release || ''), assets };
}

// The Startup setting also supports the legacy background watcher: if enabled, the desktop
// registers to start at sign-in (minimised) and starts the server on an OBS process transition.
// The dedicated OBS Lua script remains available when the user wants OBS itself to launch the app.
const OBS_PROCESSES = ['obs64.exe', 'obs32.exe'];
function processRunning(names) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return Promise.all(names.map((name) => new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      resolve(!error && String(stdout || '').toLowerCase().includes(name.toLowerCase()));
    });
  }))).then((results) => results.some(Boolean));
}

// Merge the desktop dictionary with the shared browser/Control Centre catalogs. This keeps a
// single language choice useful in desktop menus, dialogs, server pages, and dynamic notifications.
function loadUiStrings(root, desktopStrings) {
  const result = Object.fromEntries(Object.entries(desktopStrings).map(([code, phrases]) => [code, { ...phrases }]));
  const candidates = [path.join(root, 'i18n'), path.resolve(__dirname, '..', 'i18n')];
  const i18nDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'en.json')));
  if (!i18nDir) return result;
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(path.join(i18nDir, file), 'utf8')); } catch { return {}; }
  };
  const english = readJson('en.json');
  for (const code of ['de', 'es', 'fr', 'zh']) {
    const localized = readJson(`${code}.json`);
    const target = result[code] || (result[code] = {});
    for (const [key, source] of Object.entries(english)) {
      const translated = localized[key];
      if (typeof source === 'string' && typeof translated === 'string' && translated !== source && !(source in target)) {
        target[source] = translated;
      }
    }
    const phrases = readJson(`phrases-${code}.json`);
    for (const [source, translated] of Object.entries(phrases)) {
      if (typeof source === 'string' && typeof translated === 'string' && !(source in target)) target[source] = translated;
    }
  }
  return result;
}
const STRINGS = loadUiStrings(ROOT, DESKTOP_STRINGS);

let stopObsWatcher = null;
const SECTION_KEYS = {
  interface: ['language', 'autoScrollLog', 'confirmStopServer'],
  security: ['sessionTimeoutMinutes', 'autoLockMinutes', 'lockOnWindowsLock', 'backupIntervalHours', 'backupKeep'],
  performance: ['cpuAlertPercent', 'ramLimitMb', 'networkAlertMbps'],
  startup: ['startOnPc', 'startWhenObsStarts'],
  updates: ['autoCheck'],
  appearance: settings.LOOK_KEYS,
  folder: ['mode', 'showShared', 'showExpired', 'backupKeep', 'viewers'],
};

let mainWin = null;
let updating = false;
let screenLocked = false;

// "1.0.3-beta" -> "1.0.3" (the numbers only, so the label after them does not matter).
function numericVersion(text) {
  const match = /^v?\.?(\d+)\.(\d+)\.(\d+)/i.exec(String(text || '').trim());
  return match ? match.slice(1).join('.') : '';
}

function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

function readPort(root) {
  if (/^\d+$/.test(process.env.PORT || '')) return Number(process.env.PORT);
  const value = Number(settings.envValue(root, 'PORT'));
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 3000;
}

// Wraps an IPC handler so the renderer always gets { ok, ...data } or { ok: false, error }.
// Electron passes the event first; it is not part of the handler's arguments.
function safe(fn) {
  return async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, ...(data || {}) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };
}


// ---- sign-in: one admin sign-in unlocks every app ----
// The Control Centre pages run in <webview> tags that share this session partition, so the
// session cookie that the local server sets is valid for all of them.
const CC_PARTITION = 'persist:controlcentre';

function ccSession() {
  return session.fromPartition(CC_PARTITION);
}

function parseSetCookie(line) {
  const [pair, ...attrs] = line.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  const cookie = {
    name: pair.slice(0, eq),
    value: decodeURIComponent(pair.slice(eq + 1)),
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'unspecified',
  };
  let maxAge = null;
  for (const attr of attrs) {
    const idx = attr.indexOf('=');
    const key = (idx >= 0 ? attr.slice(0, idx) : attr).toLowerCase();
    const value = idx >= 0 ? attr.slice(idx + 1) : '';
    if (key === 'path') cookie.path = value || '/';
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') cookie.sameSite = { lax: 'lax', strict: 'strict', none: 'no_restriction' }[value.toLowerCase()] || 'unspecified';
    else if (key === 'max-age') maxAge = Number(value);
  }
  return { cookie, maxAge };
}

async function storeSetCookies(setCookies, base) {
  const ses = ccSession();
  for (const line of setCookies || []) {
    const { cookie, maxAge } = parseSetCookie(line);
    const url = base + cookie.path;
    if (maxAge !== null && maxAge <= 0) {
      await ses.cookies.remove(url, cookie.name).catch(() => {});
      continue;
    }
    const details = { url, name: cookie.name, value: cookie.value, path: cookie.path, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite };
    if (maxAge) details.expirationDate = Date.now() / 1000 + maxAge;
    try {
      await ses.cookies.set(details);
    } catch {
      await ses.cookies.set({ ...details, secure: false });
    }
  }
}

async function sessionCookieHeader(base) {
  const ses = ccSession();
  let cookies = await ses.cookies.get({ url: base + '/local' });
  // Older desktop releases stored the local admin cookie against localhost.
  // If DNS fallback selected an explicit loopback address, copy only the
  // signed local admin session to that same-machine origin before webviews load.
  if (!cookies.some((cookie) => cookie.name === 'fb_local_admin')) {
    let candidates = [];
    try {
      const target = new URL(base);
      const port = target.port ? `:${target.port}` : '';
      candidates = [
        `http://localhost${port}`,
        `http://127.0.0.1${port}`,
        `http://[::1]${port}`,
      ].filter((candidate) => candidate !== base);
    } catch { /* server.base is always a trusted loopback URL */ }
    for (const legacyBase of candidates) {
      const previous = await ses.cookies.get({ url: legacyBase + '/local' }).catch(() => []);
      const sessionCookie = previous.find((cookie) => cookie.name === 'fb_local_admin');
      if (!sessionCookie) continue;
      const migrated = {
        url: base + (sessionCookie.path || '/local'),
        name: sessionCookie.name,
        value: sessionCookie.value,
        path: sessionCookie.path || '/local',
        httpOnly: !!sessionCookie.httpOnly,
        secure: !!sessionCookie.secure,
        sameSite: sessionCookie.sameSite || 'strict',
      };
      if (Number.isFinite(sessionCookie.expirationDate)) migrated.expirationDate = sessionCookie.expirationDate;
      await ses.cookies.set(migrated).catch(() => {});
      cookies = await ses.cookies.get({ url: base + '/local' });
      if (cookies.some((cookie) => cookie.name === 'fb_local_admin')) break;
    }
  }
  return cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');
}

async function clearSession(base) {
  const ses = ccSession();
  let candidates = [base];
  try {
    const target = new URL(base);
    const port = target.port ? `:${target.port}` : '';
    candidates = [...new Set([base, `http://localhost${port}`, `http://127.0.0.1${port}`, `http://[::1]${port}`])];
  } catch { /* server.base is always a trusted loopback URL */ }
  for (const candidate of candidates) {
    const cookies = await ses.cookies.get({ url: candidate + '/local' }).catch(() => []);
    for (const cookie of cookies) await ses.cookies.remove(candidate + '/local', cookie.name).catch(() => {});
  }
}

async function authState(server) {
  if (!server.state.online) return { online: false };
  try {
    const cookie = await sessionCookieHeader(server.base);
    const res = await fetch(`${server.base}/local/admin/state`, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return { online: true, setupRequired: !!data.setupRequired, authenticated: !!data.authenticated };
  } catch {
    return { online: false };
  }
}

// Desktop pages and webviews get no device or notification permissions. Clipboard writes stay allowed.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

// Only the app's own pages (files under the renderer folder) may call the IPC handlers. Web pages in a
// webview get no preload, and a request from anywhere else is refused.
const RENDERER_PREFIX = require('node:url').pathToFileURL(path.join(__dirname, 'renderer') + path.sep).href;
function trustedSender(event) {
  const url = event && event.senderFrame ? event.senderFrame.url : '';
  return typeof url === 'string' && url.startsWith(RENDERER_PREFIX);
}
function handleTrusted(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Blocked: the request did not come from the app.');
    return fn(event, ...args);
  });
}
function denyPermissions(ses) {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

// Only web pages (http or https) may open in a webview, and never with the app's preload or Node access.
const isWebUrl = (url) => /^https?:\/\//i.test(url);
function hardenWebview(event, webPreferences, params) {
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  if (params.src && !isWebUrl(params.src)) event.preventDefault();
}
function blockNonWebNavigation(event, url) {
  if (!isWebUrl(url) && url !== 'about:blank') event.preventDefault();
}
function registerAuthIpc(server, admin) {
  handleTrusted('auth:state', safe(() => authState(server)));
  handleTrusted(
    'auth:login',
    safe(async ({ password }) => {
      const reply = await admin.login(String(password || ''));
      await storeSetCookies(reply.setCookies, server.base);
    }),
  );
  handleTrusted(
    'auth:setup',
    safe(async ({ password }) => {
      const setCookies = await admin.setup(String(password || ''));
      await storeSetCookies(setCookies, server.base);
    }),
  );
  handleTrusted(
    'auth:lock',
    safe(async () => {
      const cookie = await sessionCookieHeader(server.base);
      if (cookie && server.state.online) await admin.request('/local/admin/logout', {}, cookie).catch(() => {});
      await clearSession(server.base);
    }),
  );
}

function applySettings(section, server) {
  const view = settings.view(ROOT);
  if (section === 'startup') {
    app.setLoginItemSettings({
      // Either explicit Startup option may register a sign-in launch: the Windows option starts
      // normally, while the OBS watcher starts minimised and waits for OBS before starting the server.
      openAtLogin: view.startup.startOnPc || view.startup.startWhenObsStarts,
      path: process.execPath,
    });
    syncObsWatcher(server, view.startup.startWhenObsStarts);
  }
  if (section === 'performance') server.ramLimitMb = view.performance.ramLimitMb;
  if (section === 'appearance') applyUiScale(mainWin);
  return view;
}

function saveSection(section, values, server) {
  const keys = SECTION_KEYS[section];
  if (!keys) throw new Error('Unknown settings section.');
  const current = settings.view(ROOT);
  const clean = {};
  for (const key of keys) {
    clean[key] = values && values[key] !== undefined ? values[key] : current[section][key];
  }
  if (section === 'interface' && !settings.LANGUAGES.includes(clean.language)) {
    throw new Error('Unknown language.');
  }
  // Appearance saves are automatic, so each change keeps the look it replaces. Undo restores it.
  let toWrite = clean;
  if (section === 'appearance') {
    const before = settings.lookOf(current.appearance);
    const after = settings.lookOf(settings.normalize({ appearance: clean }).appearance);
    if (JSON.stringify(before) !== JSON.stringify(after)) toWrite = { ...clean, previous: before };
  }
  settings.write(ROOT, { [section]: toWrite });
  if (section === 'appearance') refreshOfflineLooks();
  const normalised = settings.view(ROOT);
  for (const key of keys) {
    if (JSON.stringify(normalised[section][key]) !== JSON.stringify(clean[key])) {
      server.addLog('APP', `Adjusted ${key} to ${normalised[section][key]}.`, 'warn');
    }
  }
  return applySettings(section, server);
}

// Reports an update step to the desktop (a toast, and the Settings line) without blocking the check.
function reportUpdate(state, extra = {}) {
  send('update:status', { state, ...extra });
}

async function checkForUpdates({ boot }, server) {
  if (updating) return { status: 'busy' };
  updating = true;
  try {
    return await runUpdateCheck({ boot }, server);
  } catch (err) {
    const message = err.message || String(err);
    server.addLog('UPDATE', `Update failed: ${message}`, 'warn');
    // The boot check stays quiet unless it fails while the window is open; a check the user started always answers.
    if (!boot) reportUpdate('error', { message });
    return { status: 'error', error: message };
  } finally {
    updating = false;
  }
}

async function runUpdateCheck({ boot }, server) {
  const view = settings.view(ROOT);
  if (!boot) reportUpdate('checking');
  const info = await updates.findRelease(view.updates.repository, app.getVersion());
  if (info.upToDate) {
    server.addLog('UPDATE', `Fishingbot Desktop ${app.getVersion()} is up to date.`, 'info');
    if (!boot) reportUpdate('upToDate', { current: info.current });
    return { status: 'upToDate', latest: info.latest };
  }
  if (boot) {
    if (view.updates.ignoredVersion === info.latest) return { status: 'ignored', latest: info.latest };
    if (view.updates.remindAfter && new Date(view.updates.remindAfter) > new Date()) {
      return { status: 'deferred', latest: info.latest };
    }
  }
  server.addLog('UPDATE', `Update ${info.latest} is available.`, 'ok');

  if (screenLocked) {
    // Do not put a modal installer prompt over the Windows lock screen. The unlock handler
    // performs a fresh check and presents the update prompt when the user can respond.
    server.addLog('UPDATE', `Update ${info.latest} is available; deferring the prompt until Windows is unlocked.`, 'ok');
    reportUpdate('available', { latest: info.latest, current: info.current, deferredUntilUnlock: true });
    return { status: 'available', latest: info.latest, deferredUntilUnlock: true };
  }
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Fishingbot Desktop Updates',
    message: tr('Fishingbot Desktop {latest} is available. You have {current}.', { latest: info.latest, current: info.current }),
    detail: `${(info.notes || '').slice(0, 600)}\n\nThe installer is checked against its published SHA-256 checksum before it starts.`,
    buttons: [tr('Update now'), tr('Remind me tomorrow'), tr('Ignore this version')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 2) {
    settings.write(ROOT, { updates: { ignoredVersion: info.latest, remindAfter: null } });
    server.addLog('UPDATE', `Update ${info.latest} ignored. A newer release will still be offered.`, 'info');
    return { status: 'ignored', latest: info.latest };
  }
  if (response === 1) {
    settings.write(ROOT, { updates: { remindAfter: new Date(Date.now() + 86400000).toISOString() } });
    return { status: 'deferred', latest: info.latest };
  }

  // Download with progress. Reports at most every 300 ms, or when the whole percentage changes.
  reportUpdate('downloading', { latest: info.latest, percent: 0, received: 0, total: 0 });
  server.addLog('UPDATE', `Downloading ${info.installer.name}.`, 'info');
  let lastPercent = -1;
  let lastSent = 0;
  const file = await updates.downloadVerified(info, (received, total) => {
    const percent = total ? Math.floor((received / total) * 100) : null;
    const now = Date.now();
    if (percent === lastPercent && now - lastSent < 300) return;
    lastPercent = percent;
    lastSent = now;
    reportUpdate('downloading', { latest: info.latest, percent, received, total });
  });
  reportUpdate('verifying', { latest: info.latest });
  server.addLog('UPDATE', `Installer verified (${info.installer.name}).`, 'ok');
  // Remember the version being installed, so the next start can confirm the update worked.
  settings.write(ROOT, { updates: { pendingVersion: info.latest } });
  // shell.openPath starts the file the way Explorer does (admin prompts included). If it fails, nothing is closed.
  const opened = await shell.openPath(file);
  if (opened) {
    settings.write(ROOT, { updates: { pendingVersion: null } });
    throw new Error(`Windows could not open the installer: ${opened}`);
  }
  server.addLog('UPDATE', `Installer ${info.installer.name} opened. Fishingbot closes so it can install.`, 'ok');
  reportUpdate('installing', { latest: info.latest });
  // Close after a moment, so the installer window is already up. Closing this app is still a normal quit.
  setTimeout(() => app.quit(), 1500);
  return { status: 'installing', latest: info.latest };
}

// Translates a message for the language chosen in Settings. Falls back to English.
function tr(key, vars) {
  const language = settings.view(ROOT).interface.language;
  let text = (language !== 'en' && STRINGS[language] && STRINGS[language][key]) || key;
  if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

const { systemUsage } = require('./system-usage');
const { createDbManager } = require('./db-manager');
const { createDbImportManager } = require('./db-import-manager');

function registerIpc(server, admin) {
  handleTrusted('app:strings', () => ({ dictionary: STRINGS }));
  handleTrusted('app:info', () => ({
    version: app.getVersion(),
    port: server.port,
    base: server.base,
    tabs: TABS,
    tabIds: TAB_IDS,
  }));
  handleTrusted('app:quit', () => app.quit());
  handleTrusted('server:state', () => server.state);
  handleTrusted('system:usage', safe(() => systemUsage(server)));
  handleTrusted('log:history', () => server.log.slice(-500));
  handleTrusted('server:start', safe(() => server.start()));
  handleTrusted('server:stop', safe(() => server.stop()));
  handleTrusted('server:restart', safe(() => server.restart()));
  // Re-checks the server now (instead of waiting for the next 3 second poll) and returns its state.
  handleTrusted('server:refresh', async () => {
    await server.poll();
    return server.state;
  });
  handleTrusted(
    'twitch:reconnect',
    safe(async () => {
      if (!server.state.online) throw new Error('The server is not running.');
      const reply = await server.post('/local/bot/reconnect');
      if (reply.ok) return { connected: true };
      if (reply.status === 409) {
        const cookie = await sessionCookieHeader(server.base);
        const response = await fetch(`${server.base}/local/admin/bot-login-link`, {
          headers: cookie ? { Cookie: cookie } : {},
          signal: AbortSignal.timeout(5000),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.url) throw new Error(data.error || `Twitch sign-in could not start (HTTP ${response.status}).`);
        return { authUrl: data.url, connected: false };
      }
      throw new Error(reply.body?.error || `HTTP ${reply.status}`);
    }),
  );

  handleTrusted('settings:get', () => settings.view(ROOT));
  handleTrusted('obs:catalog', safe(async () => readObsAssetCatalog()));
  handleTrusted('download:asset', safe(async (kind) => {
    const catalog = readObsAssetCatalog();
    const meta = catalog.assets.find((entry) => entry.id === String(kind || ''));
    if (!meta) throw new Error('Unknown download.');
    const source = OBS_ASSET_SOURCES[meta.id];
    const buffer = await fs.promises.readFile(source);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (digest !== meta.sha256 || buffer.length !== meta.size) throw new Error(`${meta.name} failed its SHA-256 integrity check. Reinstall or update Fishingbot.`);
    const choice = await dialog.showSaveDialog(mainWin, {
      title: meta.id === 'obs-lua' ? tr('Save OBS startup script') : tr('Save OBS setup ZIP'),
      defaultPath: path.join(app.getPath('downloads'), meta.name),
      filters: [{ name: meta.id === 'obs-lua' ? tr('Lua script') : tr('ZIP archive'), extensions: [meta.id === 'obs-lua' ? 'lua' : 'zip'] }],
    });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    await fs.promises.writeFile(choice.filePath, buffer, { flag: 'w' });
    return { savedPath: choice.filePath, version: meta.version, sha256: meta.sha256, size: meta.size };
  }));
  // Backups: the list in data/backups, and "Back up now" (the server makes the copy on its next check).
  handleTrusted('backup:list', safe(async () => {
    const dir = path.join(ROOT, 'data', 'backups');
    if (!fs.existsSync(dir)) return { items: [], folder: dir, serverOnline: server.state.online };
    const items = fs.readdirSync(dir)
      .filter((name) => /^fishing-\d{8}-\d{6}\.sqlite$/.test(name))
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, size: stat.size, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    return { items, folder: dir, serverOnline: server.state.online };
  }));
  handleTrusted('backup:now', safe(async () => {
    if (!server.state.online) throw new Error('Start the server first. Backups are made while it runs.');
    settings.write(ROOT, { security: { backupRequestedAt: Date.now() } });
    return { queued: true };
  }));
  // Database manager: read and edit entries of the local database (see db-manager.js).
  const dbManager = createDbManager({ root: ROOT, server });
  handleTrusted('db:list', safe(() => dbManager.list()));
  handleTrusted('db:read', safe((payload) => dbManager.read(payload)));
  handleTrusted('db:save', safe((payload) => dbManager.save(payload)));
  handleTrusted('db:search', safe((payload) => dbManager.search(payload)));
  const dbImportManager = createDbImportManager({ root: ROOT, server, getWindow: () => mainWin });
  handleTrusted('db-import:choose', safe(() => dbImportManager.chooseFile()));
  handleTrusted('db-import:start', safe((payload) => dbImportManager.start(payload?.path, payload?.policy || 'prompt')));
  handleTrusted('db-import:status', safe((payload) => ({ status: dbImportManager.getStatus(payload?.jobId) })));
  handleTrusted('db-import:cancel', safe((payload) => dbImportManager.cancel(payload?.jobId)));
  // Dropdown script and CSS, injected into Control Centre pages (their selects get glass lists too).
  handleTrusted('web:assets', () => ({
    dropdownJs: fs.readFileSync(path.join(__dirname, 'renderer', 'dropdown.js'), 'utf8'),
    dropdownCss: fs.readFileSync(path.join(__dirname, 'renderer', 'dropdown.css'), 'utf8'),
    lootCss: fs.readFileSync(path.join(__dirname, 'renderer', 'loot', 'desktop-look.css'), 'utf8'),
  }));
  handleTrusted(
    'settings:save',
    safe((section, values) => ({ settings: saveSection(String(section), values, server) })),
  );
  handleTrusted(
    'admin:repository',
    safe(async ({ repository, password }) => {
      await admin.call('update-settings', { repository: String(repository || '').trim() }, password);
    }),
  );
  handleTrusted(
    'admin:password',
    safe(async ({ currentPassword, newPassword }) => {
      if (String(newPassword || '').length < 12) throw new Error('The new password must be at least 12 characters.');
      await admin.call('password', { currentPassword, newPassword }, currentPassword);
    }),
  );
  handleTrusted(
    'admin:pairCode',
    safe(async ({ password }) => {
      const data = await admin.call('extension-admin-pair-code', { currentPassword: password }, password);
      return { code: data.code, expiresInSeconds: data.expiresInSeconds };
    }),
  );
  handleTrusted(
    'admin:unlink',
    safe(async ({ password }) => {
      await admin.call('extension-admin-unlink', { currentPassword: password }, password);
    }),
  );
  registerAuthIpc(server, admin);
  registerAppearanceIpc(server);
  handleTrusted('queue:list', safe(() => ({ items: queue.list(ROOT) })));
  handleTrusted('queue:clear', safe(() => ({ remaining: queue.clearFinished(ROOT) })));
  handleTrusted(
    'game:snapshot',
    safe(() => ({
      snapshot: gameSettings.readSnapshot(ROOT),
      groups: gameSettings.AUTO_GROUPS,
      chatOptions: gameSettings.CHAT_OPTIONS,
    })),
  );
  handleTrusted('offline:open', safe((kind) => openOfflineWindow(String(kind))));
  handleTrusted('twitch:config', safe(() => twitchConfig.readTwitchConfig(ROOT)));
  handleTrusted(
    'twitch:save',
    safe((values) => {
      if (server.state.online || server.child) {
        throw new Error('Stop the server first. The bot reads these values when it starts.');
      }
      twitchConfig.saveTwitchConfig(ROOT, values || {});
    }),
  );
  handleTrusted(
    'loot:assets',
    safe(() => ({
      strings: gameSettings.readStrings(ROOT),
      snapshot: gameSettings.readSnapshot(ROOT)?.loot || null,
    })),
  );
  handleTrusted(
    'loot:queue',
    safe((payload) => {
      const error = gameSettings.validateLoot(payload);
      if (error) throw new Error(error);
      return { pending: queue.enqueue(ROOT, 'lootTable', payload) };
    }),
  );
  handleTrusted(
    'game:queue',
    safe((values) => {
      const error = gameSettings.validate(values);
      if (error) throw new Error(error);
      return { pending: queue.enqueue(ROOT, 'gameplaySettings', gameSettings.toPayload(values)) };
    }),
  );
  handleTrusted('updates:check', safe(() => checkForUpdates({ boot: false }, server)));
  // Once after an update: if this start runs the version that was being installed, say so (one time per version).
  handleTrusted(
    'update:takeNotice',
    safe(() => {
      const u = settings.view(ROOT).updates;
      if (!u.pendingVersion) return { notice: null };
      settings.write(ROOT, { updates: { pendingVersion: null } });
      const running = numericVersion(app.getVersion());
      if (u.pendingVersion !== running || u.lastNotifiedVersion === running) return { notice: null };
      settings.write(ROOT, { updates: { lastNotifiedVersion: running } });
      return { notice: { version: running } };
    }),
  );
}

// Wallpaper and style. The image is read here and sent as a data URL; the renderer never opens files.
function registerAppearanceIpc(server) {
  handleTrusted(
    'appearance:wallpaper',
    safe(() => ({ wallpaper: appearance.readWallpaper(ROOT) })),
  );
  handleTrusted(
    'appearance:upload',
    safe(async () => {
      const options = {
        title: 'Choose a wallpaper image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      };
      const picked = mainWin && !mainWin.isDestroyed()
        ? await dialog.showOpenDialog(mainWin, options)
        : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths.length) return { cancelled: true };
      appearance.storeWallpaper(ROOT, picked.filePaths[0]);
      server.addLog('APP', 'Desktop wallpaper changed.', 'info');
      return { wallpaper: appearance.readWallpaper(ROOT), settings: settings.view(ROOT) };
    }),
  );
  // Profile picture: shown on the lock screen and, if chosen, on the taskbar.
  handleTrusted(
    'appearance:avatar',
    safe(() => ({ avatar: appearance.readAvatar(ROOT) })),
  );
  handleTrusted(
    'appearance:uploadAvatar',
    safe(async () => {
      const options = {
        title: 'Choose a profile picture (512 x 512 px)',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      };
      const picked = mainWin && !mainWin.isDestroyed()
        ? await dialog.showOpenDialog(mainWin, options)
        : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths.length) return { cancelled: true };
      appearance.storeAvatar(ROOT, picked.filePaths[0]);
      return { avatar: appearance.readAvatar(ROOT), settings: settings.view(ROOT) };
    }),
  );
  handleTrusted(
    'appearance:resetAvatar',
    safe(() => {
      appearance.removeAvatar(ROOT);
      return { avatar: null, settings: settings.view(ROOT) };
    }),
  );
  handleTrusted(
    'appearance:undo',
    safe(() => {
      const previous = settings.previousAppearance(ROOT);
      if (!previous) throw new Error('Nothing to undo yet. Changes you make here are kept for one undo.');
      const current = settings.lookOf(settings.view(ROOT).appearance);
      settings.write(ROOT, { appearance: { ...previous, previous: current } });
      server.addLog('APP', 'Desktop appearance: previous look restored.', 'info');
      return { settings: settings.view(ROOT) };
    }),
  );
  handleTrusted(
    'appearance:reset',
    safe(() => {
      appearance.removeWallpaper(ROOT);
      server.addLog('APP', 'Desktop wallpaper reset to the built-in one.', 'info');
      return { wallpaper: null, settings: settings.view(ROOT) };
    }),
  );
}

// Starts the server when OBS transitions from stopped to running. The watcher runs only while
// this option is enabled, avoids overlapping tasklist calls, and is stopped immediately if disabled.
function watchObs(server) {
  let previous = false;
  let checking = false;
  let active = true;
  const timer = setInterval(async () => {
    if (!active || checking) return;
    checking = true;
    try {
      const running = await processRunning(OBS_PROCESSES);
      if (!active) return;
      if (running && !previous && !server.state.online && !server.child) {
        server.addLog('APP', 'OBS started. Starting the Fishingbot server.', 'ok');
        server.start().catch((error) => server.addLog('APP', `Could not start the server after OBS opened: ${error.message}`, 'warn'));
      }
      previous = running;
    } catch (error) {
      if (active) server.addLog('APP', `Could not check whether OBS is running: ${error.message}`, 'warn');
    } finally {
      checking = false;
    }
  }, 15000);
  return () => {
    active = false;
    clearInterval(timer);
  };
}

function syncObsWatcher(server, enabled) {
  if (enabled && !stopObsWatcher) {
    stopObsWatcher = watchObs(server);
  } else if (!enabled && stopObsWatcher) {
    stopObsWatcher();
    stopObsWatcher = null;
  }
}

// Offline editors: each one is its own window that uses the Control Centre look.
const OFFLINE_WINDOWS = Object.freeze({
  loot: { file: path.join('loot', 'loot.html'), title: 'Loot table (offline)' },
  game: { file: path.join('game', 'game.html'), title: 'Game settings (offline)' },
});
const offlineWins = new Map();
// The CSS key of the look inserted into each offline window, so a new look replaces it.
const offlineLookKeys = new Map();

// Font stacks of the desktop (renderer/appearance.js). Kept in step with that list.
const OFFLINE_FONTS = Object.freeze({
  system: '"Segoe UI Semibold", "Segoe UI", system-ui, sans-serif',
  segoe: '"Segoe UI", system-ui, sans-serif',
  aptos: 'Aptos, "Segoe UI", system-ui, sans-serif',
  calibri: 'Calibri, Carlito, "Segoe UI", sans-serif',
  arial: 'Arial, Helvetica, sans-serif',
  verdana: 'Verdana, Geneva, sans-serif',
  tahoma: 'Tahoma, Verdana, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  cambria: 'Cambria, Georgia, serif',
  mono: 'Consolas, ui-monospace, monospace',
  cascadia: '"Cascadia Mono", Consolas, monospace',
});

// The look of the offline Loot and Game windows: the same font, text size, panels, corners and App grids
// opacity as the Control Centre pages. Applied when the window loads; a change in Settings shows when it reopens.
function offlineLookCss() {
  const look = settings.view(ROOT).appearance;
  const clampNum = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const radius = clampNum(look.cornerRadius, 0, 24, 12);
  const small = Math.round(radius * 0.58);
  const grid = clampNum(look.gridOpacity, 0, 100, 72) / 100;
  const text = clampNum(look.textScale, 85, 125, 100) / 100;
  const font = OFFLINE_FONTS[look.uiFont] || OFFLINE_FONTS.system;
  const readable = grid < 0.5 ? 'body{text-shadow:0 1px 6px rgba(0,0,0,.75)}' : '';
  const panel = `rgba(25,28,32,${grid})`;
  return `:root{--radius:${radius}px;--radius-sm:${small}px;--panel:${panel}}` +
    `html{zoom:${text}}body{font-family:${font}!important}` +
    `.card,details.card,details.tier,.tier,.loot-head,.loot-stats>div,.loot-status,.loot-seg-btn,.modal-card,.notice{background-color:${panel}!important;border-radius:${radius}px!important}` +
    `.btn,.loot-seg-btn,.loot-status{border-radius:${small}px!important}` +
    readable;
}

// Replaces the look of one offline window (the old look is removed first).
async function applyOfflineLook(kind, win) {
  if (!win || win.isDestroyed()) return;
  const previous = offlineLookKeys.get(kind);
  if (previous) await win.webContents.removeInsertedCSS(previous).catch(() => {});
  const key = await win.webContents.insertCSS(offlineLookCss()).catch(() => null);
  if (key) offlineLookKeys.set(kind, key);
}

// Called when the appearance changes: every open offline window takes the new look at once.
function refreshOfflineLooks() {
  for (const [kind, win] of offlineWins) applyOfflineLook(kind, win);
}

function openOfflineWindow(kind) {
  const spec = OFFLINE_WINDOWS[kind];
  if (!spec) throw new Error('Unknown offline window.');
  const existing = offlineWins.get(kind);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: spec.title,
    icon: windowIcon(),
    backgroundColor: '#101214',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    offlineWins.delete(kind);
    offlineLookKeys.delete(kind);
  });
  offlineWins.set(kind, win);
  win.webContents.on('did-finish-load', () => applyOfflineLook(kind, win));
  win.loadFile(path.join(__dirname, 'renderer', spec.file));
}

// Brings the window to the front. Used when it is first shown and when a second launch asks for it.
function bringToFront(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

// Desktop scale. The window is laid out at its default size (1440 x 900) at 100 percent. Automatic scale
// shrinks the whole desktop when the screen is too small for that size, so windows, icons and the taskbar
// keep their proportions and fit. A chosen percentage always wins over Automatic.
const DEFAULT_WINDOW = { width: 1440, height: 900 };
const MIN_WINDOW = { width: 1100, height: 680 };
const SCALE_FLOOR = 0.6;

function autoUiScale() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  // 40 px of the work area is kept free for the window's own title bar and the taskbar margin.
  const fit = Math.min(1, area.width / DEFAULT_WINDOW.width, (area.height - 40) / DEFAULT_WINDOW.height);
  return Math.max(SCALE_FLOOR, Math.floor(fit * 20) / 20);
}

function uiScaleFactor() {
  const chosen = settings.view(ROOT).appearance.uiScale;
  if (chosen === 'auto' || chosen === undefined) return autoUiScale();
  return Number(chosen) / 100;
}

// Applies the scale to a window. Zoom changes the CSS size the page lays out in, so the minimum window size
// shrinks with it. Otherwise a small screen would be left with a window bigger than the screen.
function applyUiScale(win) {
  if (!win || win.isDestroyed()) return;
  const factor = uiScaleFactor();
  win.webContents.setZoomFactor(factor);
  win.setMinimumSize(Math.round(MIN_WINDOW.width * factor), Math.round(MIN_WINDOW.height * factor));
}

// Set when the OBS launcher starts the app. The desktop shell stays hidden; the Control Centre
// Overview opens in its own window instead (see openStandaloneControlCentre).
const STARTED_BY_OBS = process.argv.includes('--from-obs');
let standaloneWin = null;

// OBS start: a normal Control Centre window on the shared sign-in partition, so the admin
// sign-in carries over. It loads once the server is up and reloads if the server restarts.
function openStandaloneControlCentre(server) {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1280, Math.floor(area.width)),
    height: Math.min(840, Math.floor(area.height)),
    minWidth: 900,
    minHeight: 600,
    title: 'Fishingbot Control Centre',
    icon: windowIcon(),
    backgroundColor: '#101214',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { partition: CC_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  standaloneWin = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  denyPermissions(win.webContents.session);
  win.webContents.on('will-navigate', (event, url) => {
    if (!server.base || !url.startsWith(server.base)) event.preventDefault();
  });

  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    bringToFront(win);
    startupLog('Control Centre window shown (started by the OBS launcher).');
  };
  const loadPage = async () => {
    if (win.isDestroyed() || !server.online || !server.base) return;
    const base = server.base;
    await sessionCookieHeader(base).catch(() => '');
    if (win.isDestroyed()) return;
    win.loadURL(`${base}/local?tab=overview`).catch(() => {});
  };
  win.webContents.on('did-finish-load', show);
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    show();
    // The page failed (for example, the server was restarting): try again shortly.
    setTimeout(loadPage, 3000);
  });
  // Shows the window even if the page never reports, so it is never invisible.
  setTimeout(show, 8000);

  const onOnline = () => loadPage();
  server.on('online', onOnline);
  win.on('closed', () => {
    server.off('online', onOnline);
    standaloneWin = null;
    // Closing the Control Centre window quits the app, as closing the shell does.
    app.quit();
  });
  loadPage();
  return win;
}

function createMainWindow(preload, renderer) {
  // The default window size is capped to the screen, so a 1366 x 768 laptop starts with a window it can show.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const factor = uiScaleFactor();
  const win = new BrowserWindow({
    width: Math.min(DEFAULT_WINDOW.width, Math.floor(area.width)),
    height: Math.min(DEFAULT_WINDOW.height, Math.floor(area.height)),
    minWidth: Math.round(MIN_WINDOW.width * factor),
    minHeight: Math.round(MIN_WINDOW.height * factor),
    title: 'Fishingbot Desktop',
    icon: windowIcon(),
    backgroundColor: '#101214',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#101214', symbolColor: '#f1f2f4', height: 36 },
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The zoom is set once the page has loaded, so the first layout already uses it.
  win.webContents.on('did-finish-load', () => applyUiScale(win));
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  win.webContents.on('will-attach-webview', hardenWebview);
  // The desktop page itself never navigates away.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });

  // The window must never stay hidden while the process runs. It is shown when the page is ready,
  // and also after a fallback delay or when the page fails to load, so a slow or failed page
  // still gives the user a window (and a line in startup.log saying why).
  let revealed = false;
  const reveal = (reason) => {
    if (revealed) return;
    revealed = true;
    clearTimeout(fallback);
    if (STARTED_BY_OBS) {
      startupLog(`Desktop shell kept hidden: started by the OBS launcher (${reason}).`);
      return;
    }
    // Started by Windows at sign-in (Start with Windows, or the OBS-watcher option): the window opens
    // minimised so it does not interrupt the user. A normal launch is shown as before.
    if (app.getLoginItemSettings().wasOpenedAtLogin) {
      win.showInactive();
      win.minimize();
      startupLog(`Window started minimised at sign-in (${reason}).`);
      return;
    }
    bringToFront(win);
    startupLog(`Window shown (${reason}).`);
  };
  const fallback = setTimeout(() => reveal('fallback after 4 seconds'), 4000);
  win.once('ready-to-show', () => reveal('page ready'));
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 is an aborted navigation, not a failure
    startupLog(`Desktop page failed to load: ${code} ${description} (${url}).`);
    reveal('page failed to load');
  });
  let reloads = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    startupLog(`Desktop page process ended: ${details.reason}.`);
    if (details.reason === 'clean-exit' || reloads >= 3 || win.isDestroyed()) return;
    reloads += 1;
    win.webContents.reloadIgnoringCache();
  });

  win.on('closed', () => {
    clearTimeout(fallback);
    mainWin = null;
    app.quit();
  });
  win.loadFile(path.join(renderer, 'desktop.html'));
  return win;
}

async function main() {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  startupLogFile = path.join(userData, 'startup.log');
  startupLog(`Starting Fishingbot Desktop ${app.getVersion()} (pid ${process.pid}, packaged ${app.isPackaged}).`);
  // If Electron has not reported ready after 20 seconds, the log says so. The window may still come.
  const slowStart = setTimeout(() => startupLog('Still starting after 20 seconds: Electron has not reported ready.'), 20000);
  await app.whenReady();
  clearTimeout(slowStart);
  startupLog('Electron is ready.');
  // Synchronize OS login registration from both explicit startup options on every launch.
  // This also clears any stale registration if both options are off.
  try {
    const startup = settings.view(ROOT).startup;
    const openAtLogin = Boolean(startup.startOnPc || startup.startWhenObsStarts);
    app.setLoginItemSettings({ openAtLogin, path: process.execPath });
    startupLog(`Windows sign-in startup ${openAtLogin ? 'enabled' : 'disabled'} from saved settings (Start with Windows: ${Boolean(startup.startOnPc)}; OBS watcher: ${Boolean(startup.startWhenObsStarts)}).`);
  } catch (error) {
    startupLog(`Could not synchronize Windows sign-in startup setting: ${error.message}`);
  }
  app.setAppUserModelId('com.fishingbot.desktop');
  Menu.setApplicationMenu(null);
  // Windows locking (Win+L) or sleep: the desktop locks too, if the Security setting is on.
  powerMonitor.on('lock-screen', () => { screenLocked = true; send('windows:locked'); });
  powerMonitor.on('suspend', () => { screenLocked = true; send('windows:locked'); });
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
    send('windows:unlocked');
    const view = settings.view(ROOT);
    if (view.updates.autoCheck && view.updates.repository) {
      setTimeout(() => checkForUpdates({ boot: true }, server).catch((err) =>
        server.addLog('UPDATE', `Update check after unlock failed: ${err.message}`, 'warn')), 1500);
    }
  });

  const crashLog = path.join(userData, 'crash.log');
  process.on('uncaughtException', (err) => {
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.appendFileSync(crashLog, `[${new Date().toISOString()}] ${err.stack || err}\n`);
    } catch {
      /* nothing else to do */
    }
    dialog.showErrorBox('Fishingbot Desktop', `Something went wrong. Details: ${crashLog}`);
  });

  // A page opened inside a webview (for example a link that asks for a new window) is shown
  // as an app inside the desktop, not in an outside browser.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    denyPermissions(contents.session);
    contents.on('will-navigate', (event, url) => {
      // Twitch device approval stays inside the Fishingbot webview. The activation URL
      // carries the device code, so no cross-origin form injection or system browser is needed.
      blockNonWebNavigation(event, url);
    });
    contents.on('will-redirect', (event, url) => blockNonWebNavigation(event, url));
    contents.setWindowOpenHandler(({ url }) => {
      // Only HTTP(S) pages may be opened in another in-app webview. This keeps
      // Twitch activation inside Fishingbot without accepting file:/javascript: popups.
      if (isWebUrl(url)) send('web:open', url);
      return { action: 'deny' };
    });
  });

  const server = new ServerManager({
    root: ROOT,
    port: readPort(ROOT),
    nodeBin: process.env.FISHINGBOT_NODE || 'node',
  });
  server.ramLimitMb = settings.view(ROOT).performance.ramLimitMb;
  const admin = new AdminClient(server);

  // Resolve/migrate the signed local admin cookie before the renderer starts a
  // webview on a newly selected loopback origin. Without this, the page could
  // race the cookie copy and briefly show a false sign-in screen.
  let preparedControlCentreBase = '';
  server.on('state', (state) => {
    if (!state.online || !state.base || state.base === preparedControlCentreBase) {
      if (!state.online) preparedControlCentreBase = '';
      send('server:state', state);
      return;
    }
    const targetBase = state.base;
    sessionCookieHeader(targetBase).catch(() => '').finally(() => {
      preparedControlCentreBase = targetBase;
      send('server:state', state);
    });
  });
  server.on('log', (entry) => send('log:line', entry));
  server.on('online', () => send('server:online', {}));
  registerIpc(server, admin);

  mainWin = createMainWindow(path.join(__dirname, 'preload.js'), path.join(__dirname, 'renderer'));
  startupLog('Main window created.');
  if (STARTED_BY_OBS) openStandaloneControlCentre(server);
  server.begin();
  syncObsWatcher(server, settings.view(ROOT).startup.startWhenObsStarts);

  const runAutomaticUpdateCheck = (reason) => {
    const view = settings.view(ROOT);
    if (!view.updates.autoCheck || !view.updates.repository) {
      server.addLog('UPDATE', `Automatic update check skipped (${reason}): enable Auto-check and configure a GitHub repository in Settings.`, 'info');
      return;
    }
    checkForUpdates({ boot: true }, server).then((result) => {
      server.addLog('UPDATE', `Automatic update check (${reason}) completed: ${result.status || 'unknown'}.`, 'info');
    }).catch((err) => server.addLog('UPDATE', `Automatic update check (${reason}) failed: ${err.message}`, 'warn'));
  };
  setTimeout(() => runAutomaticUpdateCheck('startup'), 20000);
  // Recheck periodically so a missed startup/network failure does not disable update discovery.
  const updateCheckTimer = setInterval(() => {
    if (!updating) runAutomaticUpdateCheck('periodic');
  }, 6 * 60 * 60 * 1000);
  updateCheckTimer.unref?.();

  // Stop a server this app started, then exit.
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    if (stopObsWatcher) { stopObsWatcher(); stopObsWatcher = null; }
    clearInterval(updateCheckTimer);
    server.dispose();
    server
      .stop()
      .catch(() => {})
      .finally(() => app.exit(0));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Registered before startup finishes: a second launch during a slow start must not be ignored.
  // If the window already exists it is brought forward; otherwise startup shows it.
  app.on('second-instance', () => {
    startupLog('Second launch received.');
    // A second launch brings forward the window the user is looking for: the Control Centre
    // when the shell is hidden, otherwise the shell.
    bringToFront(standaloneWin || mainWin);
  });
  main().catch((err) => {
    startupLog(`Startup failed: ${err.stack || err}`);
    dialog.showErrorBox('Fishingbot Desktop', `The desktop app could not start: ${err.message}`);
    app.quit();
  });
}
