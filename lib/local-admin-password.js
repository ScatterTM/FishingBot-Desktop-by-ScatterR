import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function authPath() {
  return process.env.LOCAL_ADMIN_AUTH_FILE || path.resolve(process.cwd(), 'data', 'local-admin.json');
}

export function hasLocalAdminPassword() {
  try {
    const record = JSON.parse(fs.readFileSync(authPath(), 'utf8'));
    return !!(record && typeof record.salt === 'string' && typeof record.hash === 'string');
  } catch (_) {
    return false;
  }
}

export function verifyLocalAdminPassword(password) {
  if (process.env.LOCAL_EDITION !== '1' || typeof password !== 'string') return false;
  try {
    const record = JSON.parse(fs.readFileSync(authPath(), 'utf8'));
    if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
    const actual = crypto.scryptSync(password, record.salt, 64);
    const expected = Buffer.from(record.hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}
