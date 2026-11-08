// Route table for the local server. It replaces the "rewrites" block of
// Local route table for the retained API handlers.
// Every handler below is loaded directly by the local HTTP server.

import adminTools from '../api/admin-tools.js';
import adminAction from '../api/admin/action.js';
import authAction from '../api/auth/[action].js';
import broadcasterAdmin from '../api/broadcaster-admin.js';
import broadcasterTools from '../api/broadcaster-tools.js';
import chatChannels from '../api/chat-channels.js';
import fish from '../api/fish.js';
import game from '../api/game.js';
import overlay from '../api/overlay.js';
import pond from '../api/pond.js';
import site from '../api/site.js';
import v4 from '../api/v4.js';

// Keys are the file paths under api/ (without .js).
export const API = {
  'admin-tools': adminTools,
  'admin/action': adminAction,
  'broadcaster-admin': broadcasterAdmin,
  'broadcaster-tools': broadcasterTools,
  'chat-channels': chatChannels,
  fish,
  game,
  overlay,
  pond,
  site,
  v4
};

// Dynamic route api/auth/[action].js: /api/auth/<action>.
export const API_AUTH = authAction;

// Public application paths mapped to their local API handlers.
// `query` is merged into req.query, using the same query-string route contract.
export const API_REWRITES = {
  '/api/chat-send': { to: '/api/game', query: { route: 'chat-send' } },
  '/api/fishdex': { to: '/api/game', query: { route: 'fishdex' } },
  '/api/leaderboard': { to: '/api/game', query: { route: 'leaderboard' } },
  '/api/perks': { to: '/api/game', query: { route: 'perks' } },
  '/api/trades': { to: '/api/game', query: { route: 'trades' } },
  '/api/areas': { to: '/api/game', query: { route: 'areas' } },
  '/api/updates': { to: '/api/game', query: { route: 'updates' } },
  '/api/fish-settings': { to: '/api/game', query: { route: 'fish-settings' } },
  '/api/autofish': { to: '/api/game', query: { route: 'autofish' } },
  '/api/progression': { to: '/api/game', query: { route: 'progression' } },
  '/api/streamer': { to: '/api/game', query: { route: 'streamer' } },
  '/api/report': { to: '/api/game', query: { route: 'report' } },
  '/api/givefish': { to: '/api/fish', query: {} },
  '/api/setcooldown': { to: '/api/admin-tools', query: { tool: 'cooldown' } },
  '/api/setluck': { to: '/api/admin-tools', query: { tool: 'luck' } },
  '/api/admin/login': { to: '/api/admin-tools', query: { tool: 'login' } },
  '/api/admin/logout': { to: '/api/admin-tools', query: { tool: 'logout' } },
  '/api/admin/validate': { to: '/api/admin-tools', query: { tool: 'validate' } },
  '/api/admin/pond-manager': { to: '/api/admin/action', query: {} },
  '/api/admin/tutorial-debug': { to: '/api/admin/action', query: {} },
  '/': { to: '/api/site', query: {} },
  '/index.html': { to: '/api/site', query: {} }
};

// Friendly page URLs that live in html/.
export const PAGE_REWRITES = {
  '/game': '/html/game.html',
  '/game.html': '/html/game.html',
  '/overlay.html': '/html/overlay.html',
  '/privacy.html': '/html/privacy.html',
  '/privacy-de.html': '/html/privacy-de.html',
  '/terms.html': '/html/terms.html',
  '/terms-de.html': '/html/terms-de.html',
  '/contact.html': '/html/contact.html',
  '/contact-de.html': '/html/contact-de.html'
};

// Resolves /api/<name> (and /api/auth/<action>) to a handler plus any query
// values the path implies. Returns null when no handler matches.
export function resolveApi(pathname) {
  const rel = pathname.slice('/api/'.length).replace(/\/+$/, '');
  if (Object.prototype.hasOwnProperty.call(API, rel)) {
    return { handler: API[rel], query: {} };
  }
  const auth = rel.match(/^auth\/([^/]+)$/);
  if (auth) return { handler: API_AUTH, query: { action: auth[1] } };
  return null;
}
