import { db } from '../db.js';
import { getSessionUser } from '../session.js';
import { FISH_MESSAGE_DEFAULTS, readFishMessageSettings, validateFishTemplate } from '../fish-format.js';

const MAX_TEMPLATE = 100;

function userKeyFromSession(req) {
  const user = getSessionUser(req);
  return user ? user.login.toLowerCase().replace('@', '').trim() : null;
}

function cleanTemplate(value, fallback) {
  return validateFishTemplate(value, fallback).cleaned;
}

const BOOL_KEYS = ['showChance','showLuck','showArea','showNew','showEvent','showBoost','showDoubleChance'];
function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  return fallback;
}

export async function fishSettingsHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const userKey = userKeyFromSession(req);
  if (!userKey) return res.status(401).json({ error: 'Not logged in.' });
  if (!db) return res.status(500).json({ error: 'Database not configured.' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ settings: await readFishMessageSettings(userKey), maxTemplateLength: MAX_TEMPLATE });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

    const body = req.body || {};
    const normalCheck = validateFishTemplate(body.normalTemplate, FISH_MESSAGE_DEFAULTS.normalTemplate);
    const doubleCheck = validateFishTemplate(body.doubleTemplate, FISH_MESSAGE_DEFAULTS.doubleTemplate);
    const blocked = normalCheck.blockedCommand || doubleCheck.blockedCommand;
    if (blocked) {
      return res.status(400).json({
        error: `Messages can't start with a "/" command (${blocked}). Only /me is allowed.`
      });
    }
    if (normalCheck.hasAtSign || doubleCheck.hasAtSign) {
      return res.status(400).json({
        error: 'Messages can\'t contain the "@" symbol. Remove the @ from your template.'
      });
    }
    const duplicateTokens = [...new Set([...normalCheck.duplicateTokens, ...doubleCheck.duplicateTokens])];
    if (duplicateTokens.length) {
      return res.status(400).json({
        error: `Each message argument can only be used once. Remove the duplicate ${duplicateTokens.join(', ')} token${duplicateTokens.length === 1 ? '' : 's'}.`
      });
    }
    const settings = {
      // A normal cast must have {catch}; a double catch must have {catches}.
      // This prevents an old/custom template from making a two-fish result
      // read like a normal single-catch message.
      normalTemplate: /\{catch\}/i.test(normalCheck.cleaned)
        ? normalCheck.cleaned
        : FISH_MESSAGE_DEFAULTS.normalTemplate,
      doubleTemplate: /\{catches\}/i.test(doubleCheck.cleaned)
        ? doubleCheck.cleaned
        : FISH_MESSAGE_DEFAULTS.doubleTemplate
    };
    BOOL_KEYS.forEach((key) => { settings[key] = bool(body[key], FISH_MESSAGE_DEFAULTS[key]); });

    const pairs = [
      [`fish_format:normal:${userKey}`, settings.normalTemplate],
      [`fish_format:double:${userKey}`, settings.doubleTemplate],
      ...BOOL_KEYS.map((key) => [`fish_format:${key}:${userKey}`, settings[key] ? 'on' : 'off'])
    ];
    await Promise.all(pairs.map(([key, value]) => db.set(key, value)));
    return res.status(200).json({ success: true, settings, maxTemplateLength: MAX_TEMPLATE });
  } catch (error) {
    console.error('[Fish Settings API]', error);
    return res.status(500).json({ error: 'Could not save fishing message settings.' });
  }
}
