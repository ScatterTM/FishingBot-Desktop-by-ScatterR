'use strict';

// Update check. A release is only installed when the installer's SHA-256 matches a
// checksum published with the release (GitHub's asset digest or a .sha256 file).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEADERS = { 'User-Agent': 'Fishingbot-Desktop', Accept: 'application/vnd.github+json' };

function parseVersion(text) {
  // Accepts v1.0.0, V1.0.0-beta and V.1.0.0_Beta (the tag format of the 1.0.0 Beta release).
  const match = /^v?\.?(\d+)\.(\d+)\.(\d+)/i.exec(String(text || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function extractHex(text) {
  const match = /\b([a-fA-F0-9]{64})\b/.exec(text || '');
  return match ? match[1].toLowerCase() : null;
}

// onProgress(received, total) is called as the bytes arrive; total is 0 when the server does not say.
async function fetchBytes(url, onProgress) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  if (!onProgress || !res.body) return Buffer.from(await res.arrayBuffer());
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    received += chunk.length;
    onProgress(received, total);
  }
  return Buffer.concat(chunks);
}

async function findRelease(repository, currentVersion) {
  if (!repository) throw new Error('Set a GitHub owner/repository in Settings first.');
  if (!REPO_RE.test(repository)) throw new Error('The update repository must be written as owner/repository.');

  const res = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`);
  const release = await res.json();

  const latest = parseVersion(release.tag_name);
  const current = parseVersion(currentVersion);
  if (!latest || !current) throw new Error('The latest GitHub release does not have a valid version tag.');
  const latestText = latest.join('.');
  if (!isNewer(latest, current)) return { upToDate: true, current: currentVersion, latest: latestText };

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((asset) => /^Fishingbot_Setup_v.*\.exe$/i.test(asset.name));
  if (!installer) throw new Error('The release is missing Fishingbot_Setup_vX.Y.Z.exe.');

  let expected = typeof installer.digest === 'string' && installer.digest.startsWith('sha256:')
    ? installer.digest.slice(7).toLowerCase()
    : null;
  if (!expected) {
    const sum = assets.find((asset) => asset.name === installer.name + '.sha256' || asset.name === installer.name + '.sha256sum');
    if (!sum) throw new Error('The release must provide a SHA-256 digest or a matching .sha256 file.');
    expected = extractHex((await fetchBytes(sum.browser_download_url)).toString('utf8'));
  }
  if (!expected || expected.length !== 64) throw new Error('The release SHA-256 checksum is invalid.');
  if (!String(installer.browser_download_url || '').startsWith('https://')) throw new Error('The release installer URL is invalid.');

  return {
    upToDate: false,
    current: currentVersion,
    latest: latestText,
    notes: release.body || '',
    releaseUrl: release.html_url || '',
    installer: { name: installer.name, url: installer.browser_download_url, sha256: expected },
  };
}

// Downloads the installer and returns its path only if the checksum matches.
async function downloadVerified(info, onProgress) {
  const bytes = await fetchBytes(info.installer.url, onProgress);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== info.installer.sha256) {
    throw new Error('The downloaded installer did not match the published SHA-256 checksum. It was not started.');
  }
  const file = path.join(os.tmpdir(), info.installer.name);
  fs.writeFileSync(file, bytes);
  return file;
}

// Starts the installer once this app has exited, so no file is locked during the install.
function launchInstallerAfterExit(installerPath) {
  const helper = path.join(os.tmpdir(), `FishingbotUpdate-${process.pid}.cmd`);
  const script = [
    '@echo off',
    ':waitapp',
    `tasklist /FI "PID eq ${process.pid}" | find "${process.pid}" >nul`,
    'if not errorlevel 1 (timeout /t 1 /nobreak >nul & goto waitapp)',
    `start "" "${installerPath}"`,
    'del "%~f0"',
  ].join('\r\n');
  fs.writeFileSync(helper, script);
  spawn('cmd.exe', ['/c', helper], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

module.exports = { findRelease, downloadVerified, launchInstallerAfterExit };
