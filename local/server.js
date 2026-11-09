// Local HTTP server: serves the website's static files, routes /api/* to the
// the application API handlers and provides the /local setup page
// for connecting the streamer's Twitch account as the chat bot.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { ROOT, reloadSettings, settingsReport, saveTwitchSettings, saveEnvValues } from './env.js';
import { managerPage, hasManagerPassword, isManagerAuthenticated, sameOriginRequest, setupManagerPassword, loginManager, changeManagerPassword, verifyManagerReauthentication, clearManagerCookie, getManagerSettings, saveCooldown, saveGameplaySettings, validateAndSaveLootTable, saveAppSettings, savePriceSettings, exportViewerData, importViewerData, previewViewerData, createBotLoginLaunchUrl, consumeBotLoginLaunch } from './manager.js';
import { API_REWRITES, PAGE_REWRITES, resolveApi } from './routes.js';
import { prepareApiRequest, sendHtml, sendPlain } from './http.js';
import {
  botStatus, botIdentity, finishLogin, beginDeviceLogin, pollDeviceLogin, disconnectBot, startBot, stopBot
} from './twitch-bot.js';
import { startExtensionPublisher, stopExtensionPublisher } from './twitch-extension-pubsub.js';
import { startTwitchExtensionBridge, stopTwitchExtensionBridge, twitchExtensionBridgeStatus } from './twitch-extension-bridge.js';
import { createExtensionMasterAdminPairingCode, revokeExtensionMasterAdminBinding, revokeExtensionMasterAdminSessions } from './twitch-extension-admin.js';
import { closeDatabase, databasePath } from '../lib/db.js';
import { applyViewerTool, viewerToolsSummary, viewerDebugKeys } from './viewer-tools.js';
import { applyPendingChanges } from './pending-changes.js';
import { writeGameSettingsSnapshot } from './game-snapshot.js';
import { runLocalBroadcasterAction } from './broadcaster-local.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// Only these folders are served as files. api/, lib/, sql/, docs/, data/ and
// the .env file stay private.
const STATIC_DIRS = new Set(['html', 'styles', 'scripts', 'icons', 'world-map', 'pond-fish', 'i18n']);
const STATIC_FILES = new Set(['game-sw.js', 'game.webmanifest']);

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch (_e) { return false; }
  const first = rel.split('/')[0];
  if (!STATIC_DIRS.has(first) && !STATIC_FILES.has(rel)) return false;

  const base = path.resolve(ROOT);
  // The resolved file must stay inside the folder the URL names (no "scripts/../.env").
  const full = path.resolve(base, rel);
  const inside = STATIC_FILES.has(rel)
    ? full === path.join(base, rel)
    : full.startsWith(path.join(base, first) + path.sep);
  if (!inside) return false;

  let stat;
  try { stat = fs.statSync(full); } catch (_e) { return false; }
  if (!stat.isFile()) return false;

  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(full).pipe(res);
  return true;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font-family:Arial,Segoe UI,sans-serif;background:#0f1513;color:#ede8dc;margin:0;padding:28px 22px;line-height:1.55}
  main{max-width:820px;margin:0 auto}
  h1{font-size:1.7rem;letter-spacing:-.03em;margin:0 0 6px;color:#ede8dc}
  h2{font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;margin:0 0 12px;color:#c9a227;font-weight:700}
  .card{background:#131a18;border:1px solid #2a2e2b;padding:18px 20px;margin:16px 0}
  .muted{color:#96938b;font-size:.88rem}
  .ok{color:#46a07b}.warn{color:#c9902b}.bad{color:#dd705f}
  a{color:#f2703f}
  a.btn,button.btn{display:inline-block;background:#f2703f;color:#0f1513;border:1px solid #f2703f;padding:10px 16px;font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;cursor:pointer}
  a.btn:hover,button.btn:hover{background:#f2703f;border-color:#f2703f}
  button.btn.danger{background:#351f1b;color:#dd705f;border-color:#713b31}
  .btn[aria-disabled="true"]{opacity:.4;pointer-events:none;cursor:not-allowed}
  code{display:inline-block;background:#0a0e0d;border:1px solid #212c29;padding:2px 6px;color:#c9a227;word-break:break-all}
  ul{padding-left:20px;margin:8px 0}
  li{margin:5px 0}
</style></head><body><main>${body}</main></body></html>`;
}

function resultPage(result, req = null) {
  const backUrl = '/local';
  const body = `
    <h1>${result.ok ? 'Bot account connected' : 'Could not connect the bot account'}</h1>
    <section class="card">
      <p class="${result.ok ? 'ok' : 'bad'}">${escapeHtml(result.message)}</p>
      <p><a class="btn" href="${escapeHtml(backUrl)}">Back to Fishingbot</a></p>
    </section>`;
  return page('Fishingbot - bot login', body);
}

function deviceLoginPage() {
  const body = `
    <h1>Connect Fishingbot to Twitch</h1>
    <section class="card">
      <p id="device-status" class="muted">Preparing a secure Twitch sign-in code…</p>
      <p><strong id="device-code" style="font-size:2rem;letter-spacing:.18em"></strong></p>
      <p><a id="device-activate" class="btn" href="https://www.twitch.tv/activate" target="_blank" rel="noopener">Open Twitch activation</a></p>
      <p class="muted">Enter the code above on Twitch and approve Fishingbot’s chat permissions. Keep this window open while it checks your sign-in.</p>
      <p id="device-error" class="bad"></p>
      <p><a href="/local">Cancel and return to Fishingbot</a></p>
    </section>
    <script>
      let pollTimer = null;
      async function start(){
        const status = document.getElementById('device-status');
        try {
          const response = await fetch('/local/bot/device/start', {method:'POST'});
          const data = await response.json();
          if(!response.ok) throw new Error(data.error || 'Could not start Twitch sign-in.');
          document.getElementById('device-code').textContent = data.userCode;
          document.getElementById('device-activate').href = data.verificationUriComplete || data.verificationUri;
          status.textContent = 'Waiting for you to approve Fishingbot on Twitch…';
          pollTimer = setInterval(poll, Math.max(5, data.intervalSeconds || 5) * 1000);
        } catch(error) {
          status.textContent = 'Twitch sign-in could not start.';
          document.getElementById('device-error').textContent = error.message;
        }
      }
      async function poll(){
        try {
          const response = await fetch('/local/bot/device/poll', {method:'POST'});
          const data = await response.json();
          if(data.state === 'connected') {
            clearInterval(pollTimer);
            document.getElementById('device-status').textContent = data.message || 'Twitch connected.';
            document.getElementById('device-code').textContent = '';
            setTimeout(()=>location.href='/local', 900);
            return;
          }
          if(data.state !== 'pending') {
            clearInterval(pollTimer);
            document.getElementById('device-status').textContent = 'Twitch sign-in stopped.';
            document.getElementById('device-error').textContent = data.message || data.error || 'Start again from the Control Centre.';
          }
        } catch(error) {
          clearInterval(pollTimer);
          document.getElementById('device-status').textContent = 'Connection problem.';
          document.getElementById('device-error').textContent = error.message;
        }
      }
      start();
    </script>`;
  return page('Fishingbot - Twitch sign-in', body);
}

function sendManagerError(res, result) {
  return res.status(result.status || 400).json({ ok: false, error: result.error || 'Request failed.' });
}

async function localRoute(req, res, url) {
  const p = url.pathname;
  if (p === '/local' || p.startsWith('/local/admin/')) res.setHeader('Cache-Control', 'no-store');
  await prepareApiRequest(req, res, url);

  // The streamer bot OAuth flow is intentionally local-only and uses a
  // one-time launch token created by the password-protected Control Centre.
  const botLoginLaunch = p === '/local/bot/login' && req.method === 'GET' &&
    consumeBotLoginLaunch(url.searchParams.get('launch'));
  if (p === '/local/bot/login' && !botLoginLaunch) {
    return sendPlain(res, 404, 'Not found.');
  }

  if (req.method === 'GET' && (p === '/local' || p === '/local/')) {
    return sendHtml(res, 200, managerPage());
  }

  if (p.startsWith('/local/admin/')) {
    const action = p.slice('/local/admin/'.length);
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
    if (req.method === 'POST' && !sameOriginRequest(req)) return res.status(403).json({ ok: false, error: 'Request origin could not be verified.' });

    if (req.method === 'GET' && action === 'state') {
      return res.status(200).json({ setupRequired: !hasManagerPassword(), authenticated: isManagerAuthenticated(req) });
    }

    if (req.method === 'POST' && action === 'setup') {
      const result = setupManagerPassword(req.body?.password);
      if (!result.ok) return sendManagerError(res, result);
      const login = loginManager(req, req.body?.password, res);
      if (!login.ok) return sendManagerError(res, login);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'login') {
      const result = loginManager(req, req.body?.password, res);
      if (!result.ok) return sendManagerError(res, result);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'logout') {
      // Logging out the local operator also locks Extension Master Admin, but
      // an unauthenticated same-origin request cannot revoke another session.
      if (isManagerAuthenticated(req)) await revokeExtensionMasterAdminSessions();
      clearManagerCookie(res);
      return res.status(200).json({ ok: true });
    }

    if (!isManagerAuthenticated(req)) return res.status(401).json({ ok: false, error: 'Please sign in to the local control centre.' });

    if (req.method === 'POST' && action === 'extension-admin-pair-code') {
      const reauth = verifyManagerReauthentication(req, req.body?.currentPassword);
      if (!reauth.ok) return sendManagerError(res, reauth);
      res.setHeader('Cache-Control', 'no-store');
      const identity = botIdentity();
      const bridge = twitchExtensionBridgeStatus();
      if (!identity?.userId || !identity?.login) return res.status(409).json({ ok: false, error: 'Connect the streamer Twitch account in Fishingbot before generating a pairing code.' });
      if (!bridge.connected || String(bridge.channelId) !== String(identity.userId)) {
        return res.status(409).json({ ok: false, error: 'The authenticated desktop-to-Render connection is not ready for this Twitch account. Check the Twitch Extension tab and retry.' });
      }
      try {
        const pairing = createExtensionMasterAdminPairingCode(identity);
        return res.status(200).json({ ok: true, ...pairing });
      } catch (error) {
        return res.status(Number(error?.status) || 500).json({ ok: false, code: error?.code || '', error: error?.message || 'Could not generate a pairing code.' });
      }
    }

    if (req.method === 'POST' && action === 'extension-admin-unlink') {
      const reauth = verifyManagerReauthentication(req, req.body?.currentPassword);
      if (!reauth.ok) return sendManagerError(res, reauth);
      try {
        await revokeExtensionMasterAdminBinding();
        return res.status(200).json({ ok: true, unlinked: true });
      } catch (error) {
        return res.status(500).json({ ok: false, error: error?.message || 'Could not revoke the Extension Master Admin binding.' });
      }
    }

    if (req.method === 'GET' && action === 'settings') {
      const data = await getManagerSettings(botStatus);
      writeGameSettingsSnapshot(data);
      return res.status(200).json(data);
    }
    if (req.method === 'POST' && action === 'app-settings') {
      const result = saveAppSettings(req.body || {});
      return result.ok ? res.status(200).json(result) : sendManagerError(res, result);
    }
    if (req.method === 'POST' && action === 'price-settings') {
      const result = await savePriceSettings(req.body || {});
      return result.ok ? res.status(200).json(result) : sendManagerError(res, result);
    }
    if (req.method === 'GET' && action === 'viewer-data') {
      try {
        const login = String(url.searchParams.get('login') || '').trim().replace(/^@/, '').toLowerCase();
        const data = await exportViewerData(login);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `attachment; filename="fishingbot-${login}-user-data.json"`);
        return res.status(200).json(data);
      } catch (error) {
        return res.status(400).json({ ok: false, error: error?.message || 'Could not export this viewer.' });
      }
    }
    if (req.method === 'GET' && action === 'viewer-data-summary') {
      try {
        const login = String(url.searchParams.get('login') || '').trim().replace(/^@/, '').toLowerCase();
        const data = await exportViewerData(login);
        const lists = new Map();
        for (const row of data.kv_list) lists.set(row.k, (lists.get(row.k) || 0) + 1);
        return res.status(200).json({ user: data.user, keyValueRows: data.kv.length, listKeys: lists.size, listRows: data.kv_list.length });
      } catch (error) {
        return res.status(400).json({ ok: false, error: error?.message || 'Could not inspect this viewer.' });
      }
    }
    if (req.method === 'POST' && action === 'viewer-data-import') {
      try {
        const login = String(req.body?.login || '').trim().replace(/^@/, '').toLowerCase();
        // dryRun reports what would be written so the Control Centre can show it before anything changes.
        const dryRun = req.body?.dryRun === true;
        const result = dryRun
          ? await previewViewerData(req.body?.data, login)
          : await importViewerData(req.body?.data, login);
        return res.status(200).json({ ok: true, ...result });
      } catch (error) {
        return res.status(400).json({ ok: false, error: error?.message || 'Could not import this viewer export.' });
      }
    }
    if ((req.method === 'GET' || req.method === 'POST') && action === 'broadcaster') {
      try {
        const identity = botIdentity();
        const result = await runLocalBroadcasterAction({
          method: req.method,
          body: req.method === 'POST' ? (req.body || {}) : {},
          channel: identity?.login || ''
        });
        return res.status(result.status).json(result.body);
      } catch (error) {
        return res.status(500).json({ ok: false, error: error?.message || 'Broadcaster tools failed.' });
      }
    }
    if (req.method === 'GET' && action === 'viewer-debug') {
      try {
        return res.status(200).json({ ok: true, ...(await viewerDebugKeys(url.searchParams.get('login'))) });
      } catch (error) {
        return res.status(Number(error?.status) || 400).json({ ok: false, error: error?.message || 'Could not inspect this viewer.' });
      }
    }
    if (req.method === 'GET' && action === 'viewer-tools') {
      try {
        return res.status(200).json({ ok: true, ...(await viewerToolsSummary(url.searchParams.get('login'))) });
      } catch (error) {
        return res.status(Number(error?.status) || 400).json({ ok: false, error: error?.message || 'Could not inspect this viewer.' });
      }
    }
    if (req.method === 'POST' && action === 'viewer-tools') {
      try {
        const result = await applyViewerTool(req.body || {});
        console.info(`[viewer-tools] ${String(req.body?.action || '')} for @${String(req.body?.login || '')}`);
        return res.status(200).json({ ok: true, ...result, ...(await viewerToolsSummary(req.body?.login)) });
      } catch (error) {
        return res.status(Number(error?.status) || 400).json({ ok: false, error: error?.message || 'Viewer tool failed.' });
      }
    }
    if (req.method === 'GET' && action === 'bot-login-link') {
      const port = Number(process.env.PORT) || 3000;
      const base = `http://localhost:${port}`;
      return res.status(200).json({ ok: true, url: createBotLoginLaunchUrl(base, port) });
    }
    if (req.method === 'POST' && action === 'twitch-settings') {
      const saved = saveTwitchSettings({ clientId: req.body?.clientId, clientSecret: req.body?.clientSecret });
      if (!saved.ok) return sendManagerError(res, saved);
      stopBot();
      const started = await startBot().catch((error) => {
        console.error('[bot] Could not reload Twitch settings:', error?.message || error);
        return false;
      });
      return res.status(200).json({ ok: true, twitchConfig: settingsReport(), bot: botStatus(), started });
    }
    if (req.method === 'POST' && action === 'game-settings') {
      const result = await saveGameplaySettings(req.body || {});
      return result.ok ? res.status(200).json(result) : sendManagerError(res, result);
    }
    if (req.method === 'POST' && action === 'cooldown') {
      const result = await saveCooldown(req.body?.seconds);
      return result.ok ? res.status(200).json(result) : sendManagerError(res, result);
    }
    if (req.method === 'POST' && action === 'loot-table') {
      const result = validateAndSaveLootTable(req.body);
      if (!result.ok) return sendManagerError(res, result);
      res.status(200).json(result);
      // TIERS and derived catalog indexes are intentionally loaded once at
      // boot; restarting gives every handler a single consistent snapshot.
      setTimeout(() => process.stdin?.emit('data', Buffer.from('restart\n')), 900).unref?.();
      return undefined;
    }
    if (req.method === 'POST' && action === 'password') {
      const result = changeManagerPassword(req.body?.currentPassword, req.body?.newPassword, res);
      if (result.ok) await revokeExtensionMasterAdminSessions();
      return result.ok ? res.status(200).json(result) : sendManagerError(res, result);
    }
    if (req.method === 'POST' && action === 'update-settings') {
      try {
        const repository = String(req.body?.repository || '').trim();
        if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return sendManagerError(res, { status: 400, error: 'Enter the GitHub repository as owner/repository.' });
        saveEnvValues({ FISHINGBOT_UPDATE_REPOSITORY: repository });
        return res.status(200).json({ ok: true });
      } catch (error) { return sendManagerError(res, { status: 400, error: error?.message || 'Could not save the update source.' }); }
    }
    return sendPlain(res, 404, 'Not found.');
  }

  if (req.method === 'GET' && p === '/local/status') {
    return res.status(200).json(botStatus());
  }
  if (req.method === 'GET' && p === '/local/bot/login') {
    return sendHtml(res, 200, deviceLoginPage());
  }
  if (req.method === 'POST' && (p === '/local/bot/device/start' || p === '/local/bot/device/poll')) {
    if (!sameOriginRequest(req)) return res.status(403).json({ ok: false, error: 'Request origin could not be verified.' });
    try {
      if (p.endsWith('/start')) {
        const result = await beginDeviceLogin();
        return res.status(200).json({ ok: true, ...result });
      }
      const result = await pollDeviceLogin();
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      return res.status(502).json({ ok: false, state: 'error', error: error?.message || 'Twitch device sign-in failed.' });
    }
  }
  if (req.method === 'GET' && p === '/local/bot/callback') {
    const result = await finishLogin({
      code: url.searchParams.get('code'),
      stateToken: url.searchParams.get('state'),
      error: url.searchParams.get('error')
    });
    return sendHtml(res, result.ok ? 200 : 400, resultPage(result, req));
  }
  if (req.method === 'POST' && p === '/local/reload') {
    if (!sameOriginRequest(req)) return res.status(403).json({ ok: false, error: 'Request origin could not be verified.' });
    reloadSettings();
    return res.status(200).json({ ok: true, ...settingsReport(), configured: botStatus().configured });
  }
  if (req.method === 'POST' && p === '/local/bot/reconnect') {
    if (!sameOriginRequest(req)) return res.status(403).json({ ok: false, error: 'Request origin could not be verified.' });
    try {
      // Give the previous EventSub socket a moment to finish closing before opening its replacement.
      // Immediate stop/start races could leave the new session marked as stopping.
      stopBot();
      await new Promise(resolve => setTimeout(resolve, 250));
      const started = await startBot();
      const status = botStatus();
      if (!started) return res.status(409).json({ ok: false, ...status, error: status.lastError || status.error || 'Twitch is not configured or the saved account could not reconnect.' });
      return res.status(200).json({ ok: true, ...status });
    } catch (error) {
      console.error('[bot] Manual reconnect failed:', error?.message || error);
      return res.status(500).json({ ok: false, error: error?.message || 'Reconnect failed.' });
    }
  }
  if (req.method === 'POST' && p === '/local/bot/disconnect') {
    if (!sameOriginRequest(req)) return res.status(403).json({ ok: false, error: 'Request origin could not be verified.' });
    await disconnectBot();
    return res.status(200).json({ ok: true });
  }
  return sendPlain(res, 404, 'Not found.');
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  // v2.1.3 is deliberately loopback-only: no public reverse proxy is started.
  if (pathname === '/local' || pathname.startsWith('/local/')) return localRoute(req, res, url);

  let target = pathname;
  let extraQuery = {};
  const rewrite = API_REWRITES[pathname];
  if (rewrite) {
    target = rewrite.to;
    extraQuery = rewrite.query;
  } else if (PAGE_REWRITES[pathname]) {
    target = PAGE_REWRITES[pathname];
  }

  if (target.startsWith('/api/')) {
    const found = resolveApi(target);
    if (!found) return sendPlain(res, 404, 'Not found.');
    await prepareApiRequest(req, res, url, { ...found.query, ...extraQuery });
    return found.handler(req, res);
  }

  if (serveStatic(req, res, target)) return undefined;
  return sendPlain(res, 404, 'Not found.');
}

function openBrowser(url) {
  if (process.env.OPEN_BROWSER === '0') return;
  const command = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, () => { /* best effort */ });
}

export function startServer() {
  const port = Number(process.env.PORT) || 3000;
  // Keep the app loopback-only until a different, tested sharing method is selected.
  const host = '127.0.0.1';
  if (process.env.HOST && process.env.HOST !== host) {
    console.warn('[security] Ignoring HOST override; the local edition must listen only on 127.0.0.1.');
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    handle(req, res).catch((error) => {
      const status = error?.status === 413 ? 413 : 500;
      if (status === 500) console.error('[server] Request failed:', error);
      if (!res.headersSent) sendPlain(res, status, status === 413 ? 'Request too large.' : 'Something went wrong on the local server.');
      else res.end();
    });
  });

  server.listen(port, host, async () => {
    // Changes queued while the server was stopped are applied first, with the normal checks.
    applyPendingChanges().catch((error) => console.warn('[queue] ' + (error?.message || error)));
    console.log(`FishingsysDEV local edition is running at http://localhost:${port}`);
    console.log(`Database: ${databasePath()}`);
    console.log(`Streamer Control Centre: http://localhost:${port}/local`);
    console.log('[network] Local-only mode: viewer pages are available on this PC at localhost.');
    const report = settingsReport();
    console.log(`[setup] Settings file: ${report.file}`);
    console.log(`[setup] Legacy website OAuth Client ID: ${report.clientId}, optional Client Secret: ${report.clientSecret}`);
    if (!botStatus().deviceCodeConfigured) {
      console.warn('[setup] Public Twitch Device Code app ID is not configured in this build; Twitch account connection is disabled.');
    }
    try {
      const started = await startBot();
      if (started) console.log('[bot] Starting chat bot...');
    } catch (error) {
      console.error('[bot] Could not start the chat bot:', error?.message || error);
    }
    startExtensionPublisher(botIdentity);
    startTwitchExtensionBridge();
    console.log('[twitch-extension] Managed relay publisher and secure viewer bridge started (private account requests require Twitch identity sharing).');
    openBrowser(`http://localhost:${port}/local`);
  });

  let closing = false;
  const shutdown = (exitCode = 0) => {
    if (closing) return;
    closing = true;
    console.log(exitCode === 75 ? '[app] Applying saved configuration; restarting server...' : '[app] Shutting down Fishingbot...');
    try { stopBot(); } catch (_) { }
    try { stopExtensionPublisher(); } catch (_) { }
    try { stopTwitchExtensionBridge(); } catch (_) { }
    const hardExit = setTimeout(() => process.exit(exitCode), 4500);
    hardExit.unref?.();
    server.close(() => {
      try { closeDatabase(); } catch (_) { }
      process.exit(exitCode);
    });
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  if (process.stdin && typeof process.stdin.on === 'function') {
    let input = '';
    process.stdin.setEncoding?.('utf8');
    process.stdin.on('data', (chunk) => {
      input += String(chunk || '');
      if (input.length > 1024) input = input.slice(-1024);
      const lines = input.split(/\r?\n/);
      input = lines.pop() || '';
      for (const line of lines) {
        if (line.trim().toLowerCase() === 'shutdown') shutdown(0);
        else if (line.trim().toLowerCase() === 'restart') shutdown(75);
      }
    });
  }
  return server;
}
