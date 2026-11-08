// GET /api/overlay?channel=<name>&key=<link key>[&after=<seq>]
// Polled by html/overlay.html (OBS Browser Source). The key is the broadcaster's
// secret link key, so nobody else can read the channel's overlay feed.
import { normalizeBroadcasterLogin } from '../lib/broadcaster-admin.js';
import {
  readOverlaySettings, verifyOverlayKey, readOverlayEvents, readLuckEvent, readGlobalLuckEvent, liveCheck
} from '../lib/overlay.js';
import { db } from '../lib/db.js';
import { readChannelProgress, upgradeGoal } from '../lib/channel-progress.js';

// Bumped with each release. The overlay page reloads itself when this changes,
// so an OBS Browser Source does not keep running old code.
const BUILD = 'v3.97';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  res.setHeader('Cache-Control', 'no-store');

  const channel = normalizeBroadcasterLogin(String(req.query?.channel || ''));
  if (!channel) return res.status(400).json({ error: 'Missing channel.' });
  if (!(await verifyOverlayKey(channel, String(req.query?.key || '')))) {
    return res.status(403).json({ error: 'Invalid overlay link.' });
  }

  try {
    const settings = await readOverlaySettings(channel);
    if (!settings.enabled) return res.status(200).json({ enabled: false, seq: 0 });

    const after = req.query?.after !== undefined && req.query.after !== '' ? Number(req.query.after) : null;
    const live = await liveCheck(channel);
    const [{ seq, alerts }, luck, globalLuck, points] = await Promise.all([
      readOverlayEvents(channel, Number.isFinite(after) ? after : null, settings),
      settings.luckBanner ? readLuckEvent(channel) : Promise.resolve({ active: false }),
      settings.luckBanner ? readGlobalLuckEvent() : Promise.resolve({ active: false }),
      settings.pointsBar ? readChannelProgress(db, channel).then((progress) => upgradeGoal(progress, settings.pointsBarGoal)) : Promise.resolve(null)
    ]);

    return res.status(200).json({
      enabled: true,
      build: BUILD,
      seq,
      live,
      points,
      settings: {
        pointsBar: settings.pointsBar,
        pointsBarGoal: settings.pointsBarGoal,
        pointsBarColor: settings.pointsBarColor,
        alertSeconds: settings.alertSeconds,
        sound: settings.sound,
        position: settings.position,
        alertHorizontalPosition: settings.alertHorizontalPosition,
        accent: settings.accent,
        style: settings.style,
        font: settings.font,
        soundId: settings.soundId,
        animationMs: settings.animationMs,
        alertTextScale: settings.alertTextScale,
        alertSize: settings.alertSize,
        luckStyle: settings.luckStyle,
        alertAlign: settings.alertAlign,
        alertBg: settings.alertBg,
        alertBgTransparency: settings.alertBgTransparency,
        luckAlign: settings.luckAlign,
        luckHorizontalPosition: settings.luckHorizontalPosition,
        luckBg: settings.luckBg,
        luckBgTransparency: settings.luckBgTransparency,
        luckPosition: settings.luckPosition,
        soundVolume: settings.soundVolume,
        alertUpper: settings.alertUpper,
        showTier: settings.showTier,
        alertStats: settings.alertStats,
        alertCommunity: settings.alertCommunity,
        luckAccent: settings.luckAccent,
        luckTemplate: settings.luckTemplate,
        luckTimer: settings.luckTimer,
        luckScale: settings.luckScale,
        animation: settings.animation,
        rarityColors: settings.rarityColors,
        alertTemplate: settings.alertTemplate
      },
      alerts,
      luck,
      globalLuck
    });
  } catch (err) {
    console.error('[api/overlay] failed:', err?.message || err);
    return res.status(500).json({ error: 'Overlay is unavailable right now.' });
  }
}
