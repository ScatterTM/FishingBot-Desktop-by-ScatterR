'use strict';

// Twitch legacy OAuth settings (client ID and optional client secret) for the desktop while the
// server is stopped. Same rules and file handling as saveTwitchSettings in local/env.js.
// The secret is written to .env and never sent back to the page.

const fs = require('node:fs');
const path = require('node:path');
const { envValue } = require('./settings');

const envFile = (root) => path.join(root, '.env');

function setLine(text, key, value) {
  const lines = text ? text.split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const entry = `${key}=${value}`;
  const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index >= 0) lines[index] = entry;
  else lines.push(entry);
  return lines.join('\r\n') + '\r\n';
}

function readTwitchConfig(root) {
  return {
    clientId: envValue(root, 'TWITCH_CLIENT_ID'),
    hasSecret: envValue(root, 'TWITCH_CLIENT_SECRET') !== '',
  };
}

// Throws an Error with the message to show. An empty secret keeps the saved one.
function saveTwitchConfig(root, { clientId, clientSecret } = {}) {
  const nextId = String(clientId ?? '').trim();
  const nextSecret = String(clientSecret ?? '');
  if (!/^[a-zA-Z0-9]{10,128}$/.test(nextId)) {
    throw new Error('Enter a valid Twitch Client ID (10–128 letters or numbers).');
  }
  if (nextSecret && (nextSecret.length < 20 || nextSecret.length > 256 || /[\r\n]/.test(nextSecret))) {
    throw new Error('The Twitch Client Secret must be 20–256 characters on one line.');
  }
  let current = '';
  try {
    current = fs.readFileSync(envFile(root), 'utf8');
  } catch {
    /* no .env yet */
  }
  let text = setLine(current, 'TWITCH_CLIENT_ID', nextId);
  if (nextSecret) text = setLine(text, 'TWITCH_CLIENT_SECRET', nextSecret);
  // Write a temp file first, so a crash never leaves a half-written .env.
  const temp = `${envFile(root)}.tmp`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, envFile(root));
}

module.exports = { readTwitchConfig, saveTwitchConfig };
