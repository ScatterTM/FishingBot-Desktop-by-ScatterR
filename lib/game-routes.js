// Consolidated player-facing game routes used by the local HTTP router.
// Keeping these handlers together preserves the stable public API paths.
import { fishdexHandler } from './game-routes/fishdex.js';
import { leaderboardHandler } from './game-routes/leaderboard.js';
import { perksHandler } from './game-routes/perks.js';
import { tradesHandler } from './game-routes/trades.js';
import { areasHandler } from './game-routes/areas.js';
import { fishSettingsHandler } from './game-routes/fish-settings.js';
import { updatesHandler } from './game-routes/updates.js';
import { autoFishHandler } from './game-routes/autofish.js';
import { progressionHandler } from './game-routes/progression.js';
import { streamerHandler } from './game-routes/streamer.js';
import { chatSendHandler } from './game-routes/chat-send.js';
import { reportHandler } from './game-routes/report.js';

export async function gameRouteHandler(req, res) {
  const route = String(req.query?.route || '').toLowerCase();
  if (route === 'fishdex') return fishdexHandler(req, res);
  if (route === 'leaderboard') return leaderboardHandler(req, res);
  if (route === 'perks') return perksHandler(req, res);
  if (route === 'trades') return tradesHandler(req, res);
  if (route === 'areas') return areasHandler(req, res);
  if (route === 'fish-settings') return fishSettingsHandler(req, res);
  if (route === 'updates') return updatesHandler(req, res);
  if (route === 'autofish') return autoFishHandler(req, res);
  if (route === 'progression') return progressionHandler(req, res);
  if (route === 'streamer') return streamerHandler(req, res);
  if (route === 'chat-send') return chatSendHandler(req, res);
  if (route === 'report') return reportHandler(req, res);
  return res.status(404).json({ error: 'Unknown game route.' });
}
