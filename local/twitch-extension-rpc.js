// Trusted bridge from the Render EBS to the local game's existing API handlers.
// Requests can only arrive over the authenticated outbound WebSocket managed by
// twitch-extension-bridge.js. Twitch viewer identity is resolved by the relay
// and converted here into the same short-lived signed session used by the site.
import { db } from '../lib/db.js';
import { signSession } from '../lib/session.js';
import { readInventoryItems } from '../lib/inventory.js';
import { fishyTokenValue } from '../lib/pond.js';
import { TIERS } from '../lib/tiers.js';
import { gameRouteHandler } from '../lib/game-routes.js';
import pondHandler from '../api/pond.js';
import { executeExtensionMasterAdminRequest } from './twitch-extension-admin.js';

const PRIVATE_ROUTES = new Set([
  'whoami', 'inventory', 'fishdex', 'perks', 'trades', 'areas',
  'fish-settings', 'autofish', 'progression', 'pond'
]);

const POST_ACTIONS = {
  areas: new Set(['toggleAreas', 'toggleDouble', 'select', 'buy', 'upgrade']),
  autofish: new Set(['buyLicense', 'start', 'stop', 'event', 'prestige', 'trophyMode', 'stopAfter', 'target']),
  progression: new Set(['claim-tutorial-reward', 'select-bait', 'buy-bait', 'upgrade-rod', 'equip-cosmetic', 'equip-title']),
  pond: new Set(['collect', 'stash', 'convert', 'unlockFish', 'selectFish', 'upgrade', 'upgradeFish', 'upgradeFeature', 'upgradeTreasuryPerk', 'setBaitSlots', 'enableChat', 'unlock']),
  trades: new Set(['create', 'giftperk', 'respond', 'respondgift', 'markread'])
};

function responseHarness() {
  const state = { status: 200, body: null, headers: {}, ended: false };
  const res = {
    status(code) { state.status = Number(code) || 200; return this; },
    json(value) { state.body = value; state.ended = true; return this; },
    send(value) { state.body = value; state.ended = true; return this; },
    end(value) { if (value !== undefined) state.body = value; state.ended = true; return this; },
    setHeader(name, value) { state.headers[String(name).toLowerCase()] = value; return this; },
    getHeader(name) { return state.headers[String(name).toLowerCase()]; }
  };
  return { state, res };
}

function normalizeViewer(viewer) {
  const login = String(viewer?.login || '').trim().replace(/^@+/, '').toLowerCase();
  const userId = String(viewer?.userId || '');
  if (!/^[a-z0-9_]{1,25}$/.test(login) || !/^\d{5,20}$/.test(userId)) {
    throw new Error('Twitch returned an invalid viewer identity.');
  }
  return {
    userId,
    login,
    displayName: String(viewer.displayName || login).slice(0, 40),
    avatar: /^https:\/\//i.test(String(viewer.avatar || '')) ? String(viewer.avatar) : '',
    channelOwner: viewer?.channelOwner === true
  };
}

function makeRequest(method, query = {}, body = {}, viewer = null) {
  const headers = {};
  if (viewer) {
    // This token exists only in process memory for the duration of this call.
    // It is never sent over the network or returned to the Extension iframe.
    const session = signSession({
      login: viewer.login,
      displayName: viewer.displayName,
      avatar: viewer.avatar
    }, 120);
    headers.cookie = `fh_session=${encodeURIComponent(session)}`;
  }
  return {
    method,
    query: { ...(query || {}) },
    body: body && typeof body === 'object' ? body : {},
    headers,
    url: '/internal/twitch-extension'
  };
}

async function runHandler(handler, req) {
  const { state, res } = responseHarness();
  await handler(req, res);
  if (!state.ended) return { status: state.status || 204, body: state.body };
  return { status: state.status, body: state.body };
}

async function inventoryFor(viewer) {
  if (!db) throw new Error('Local Fishingbot database is not available.');
  const rows = await readInventoryItems(db, viewer.login);
  const counts = new Map();
  for (const raw of rows) {
    const item = String(raw || '').trim();
    if (!item) continue;
    const current = counts.get(item) || { item, count: 0, tokenValue: fishyTokenValue(item) };
    current.count += 1;
    counts.set(item, current);
  }
  const items = [...counts.values()].sort((a, b) => a.item.localeCompare(b.item));
  return {
    total: rows.length,
    items: items.map((entry) => ({ ...entry, convertible: entry.tokenValue > 0 }))
  };
}

function validatePrivateRequest(request) {
  const route = String(request?.route || '').toLowerCase();
  const method = String(request?.method || 'GET').toUpperCase();
  if (!PRIVATE_ROUTES.has(route) || !['GET', 'POST'].includes(method)) {
    throw new Error('That account feature is not available through the Twitch Extension.');
  }
  const query = request.query && typeof request.query === 'object' && !Array.isArray(request.query) ? request.query : {};
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};
  if (JSON.stringify(query).length > 2_000 || JSON.stringify(body).length > 12_000) throw new Error('Account request is too large.');
  if (method === 'POST') {
    if (route === 'areas' || route === 'autofish' || route === 'progression' || route === 'pond' || route === 'trades') {
      const action = String(body.action || '');
      if (!POST_ACTIONS[route]?.has(action)) throw new Error('That action is not available through the Extension.');
    } else if (route === 'perks') {
      const isBuy = typeof body.buy === 'string' && body.buy.length <= 60;
      const isToggle = typeof body.perk === 'string' && typeof body.enabled === 'boolean';
      if (!isBuy && !isToggle) throw new Error('That perk action is not available through the Extension.');
    } else if (route === 'fish-settings') {
      // The existing handler validates templates, flags and blocked commands.
      if (JSON.stringify(body).length > 4_000) throw new Error('Fishing message settings are too large.');
    } else {
      throw new Error('This account view is read-only.');
    }
  }
  if (['whoami', 'inventory', 'fishdex'].includes(route) && method !== 'GET') throw new Error('This account view is read-only.');
  return { route, method, query, body };
}

export async function executeExtensionViewerRequest(viewerInput, requestInput) {
  const viewer = normalizeViewer(viewerInput);
  const request = validatePrivateRequest(requestInput);
  if (request.route === 'whoami') return { status: 200, body: viewer };
  if (request.route === 'inventory') return { status: 200, body: await inventoryFor(viewer) };

  const req = makeRequest(request.method, request.query, request.body, viewer);
  if (request.route === 'pond') return runHandler(pondHandler, req);
  req.query.route = request.route;
  return runHandler(gameRouteHandler, req);
}

export async function executeExtensionPublicRequest(action) {
  const wanted = String(action || '').toLowerCase();
  if (wanted === 'loot') {
    return {
      status: 200,
      body: TIERS.filter((tier) => tier && tier.id !== 'unique' && String(tier.name).toUpperCase() !== 'SECRET')
    };
  }
  if (wanted === 'leaderboard') {
    const req = makeRequest('GET', { route: 'leaderboard', fresh: String(Date.now()) });
    return runHandler(gameRouteHandler, req);
  }
  return { status: 400, body: { error: 'Unknown public Extension request.' } };
}


export async function executeExtensionAdminRequest(viewerInput, requestInput, authenticatedChannelId) {
  const viewer = normalizeViewer(viewerInput);
  if (viewer.channelOwner !== true) {
    return { status: 403, body: { error: 'Master Admin is restricted to the authenticated channel owner.' } };
  }
  if (String(viewer.userId) !== String(authenticatedChannelId || '')) {
    return { status: 403, body: { error: 'The broadcaster identity does not match this authenticated desktop connection.' } };
  }
  try {
    const result = await executeExtensionMasterAdminRequest(viewer, authenticatedChannelId, requestInput || {});
    return result;
  } catch (error) {
    return {
      status: Number(error?.status) >= 400 && Number(error.status) <= 599 ? Number(error.status) : 500,
      body: { error: String(error?.message || 'Master Admin request failed.').slice(0, 220), code: String(error?.code || '') }
    };
  }
}
