// Pure security policy helpers for the local-only Twitch Extension Master Admin broker.
// Kept dependency-free so the trust checks can be exercised with Node's test runner.
import crypto from 'node:crypto';

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

export function trustedMasterAdminOwner(viewer, authenticatedChannelId) {
  const userId = String(viewer?.userId || '');
  const channelId = String(authenticatedChannelId || '');
  const login = String(viewer?.login || '').trim().replace(/^@+/, '').toLowerCase();
  if (viewer?.channelOwner !== true || !/^\d{5,20}$/.test(userId) || userId !== channelId) {
    fail(403, 'master_admin_owner_only', 'Master Admin is available only to the broadcaster authenticated by the connected Fishingbot desktop.');
  }
  if (!/^[a-z0-9_]{1,25}$/.test(login)) {
    fail(400, 'invalid_owner_identity', 'The authenticated Twitch owner identity is invalid.');
  }
  return { userId, login };
}

export function validMasterAdminPairingCode(codeInput) {
  return /^[A-Za-z0-9_-]{40,60}$/.test(String(codeInput || '').trim());
}

export function hashMasterAdminPairingCode(codeInput) {
  const code = String(codeInput || '').trim();
  if (!validMasterAdminPairingCode(code)) {
    fail(400, 'invalid_pairing_code', 'Enter the one-time pairing code from the local Control Centre.');
  }
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function validateMasterAdminPayload(input, allowedActions, maxBytes = 18_000) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'invalid_admin_payload', 'Admin action parameters must be a JSON object.');
  }
  let raw;
  try { raw = JSON.stringify(input); }
  catch (_) { fail(400, 'invalid_admin_payload', 'Admin action parameters are not valid JSON.'); }
  if (Buffer.byteLength(raw || '', 'utf8') > maxBytes) {
    fail(413, 'admin_payload_too_large', 'Admin action parameters are too large.');
  }
  let parsed;
  try { parsed = JSON.parse(raw || '{}'); }
  catch (_) { fail(400, 'invalid_admin_payload', 'Admin action parameters are not valid JSON.'); }

  let visited = 0;
  const inspect = (value, depth = 0) => {
    if (depth > 12 || ++visited > 2_000) {
      fail(400, 'unsafe_admin_payload', 'Admin action parameters are too deeply nested or complex.');
    }
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        fail(400, 'unsafe_admin_payload', 'Admin action parameters contain a prohibited key.');
      }
      inspect(value[key], depth + 1);
    }
  };
  inspect(parsed);

  const action = String(parsed.action || '').trim();
  if (!allowedActions?.has(action)) {
    fail(400, 'admin_action_not_allowed', 'That Master Admin action is not enabled in the Twitch Extension.');
  }
  parsed.action = action;
  return parsed;
}
