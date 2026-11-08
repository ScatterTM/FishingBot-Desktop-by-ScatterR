import { gameRouteHandler } from '../lib/game-routes.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  return gameRouteHandler(req, res);
}
