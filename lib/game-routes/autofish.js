import { db } from '../db.js';
import { getSessionUser } from '../session.js';
import { FISHING_AREAS, AREA_IDS, areaLevelKey, areaEnabledKey, AREAS_ENABLED_KEY, isEnabledValue, readUserAreaLevels } from '../areas.js';
import { performFishingCast } from '../../api/fish.js';
import { FISH_MESSAGE_DEFAULTS } from '../fish-format.js';
import {
  getAutoFishConfig, readAutoFishState, buyAutoFishLicense, startAutoFish,
  stopAutoFish, completeActiveEvent, prestigeAutoFish, prestigeRequirements,
  setAutoFishConfig, sanitizeAdminConfig, autoFishKeys, sessionDurationSeconds,
  autoIntervalSeconds, AUTO_FISH_PRESTIGES, prestigePerks, adminSpawnTreasurySlot, autoFishStatus
} from '../autofish.js';
import { withKeyLock } from '../inventory.js';
import { recordAdminAudit } from '../audit.js';
import { recordUserMail } from '../user-mail.js';
import { pondStatus, POND_UNLOCK_PRESTIGE } from '../pond.js';

function cleanUser(value) {
  const user = String(value || '').trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9_]{1,32}$/.test(user) ? user : null;
}

function sessionUserKey(req) {
  const user = getSessionUser(req);
  return user ? cleanUser(user.login) : null;
}

async function requireSession(req, res) {
  const userKey = sessionUserKey(req);
  if (!userKey) {
    res.status(401).json({ error: 'Not logged in.' });
    return null;
  }
  if (!db) {
    res.status(500).json({ error: 'Database not configured.' });
    return null;
  }
  return userKey;
}

// Long catch-up work is bounded by time as
// well as by cast count. Anything left over is picked up by the next request.
const SETTLE_TIME_BUDGET_MS = 6000;
// If a finished session cannot be settled (repeated cast failures) it is closed
// anyway after this long, so a broken session can never stay open forever.
const SETTLE_GRACE_AFTER_END_MS = 10 * 60 * 1000;

// Auto-Fish has no background worker: casts are credited whenever the server is
// asked to settle (status poll, start, stop). Settling therefore has to be
// "catch-up" by design:
//   * every cast that was scheduled at or before min(now, session end) is made,
//     even if the session has already expired by the time we get here, and
//   * the schedule advances from the cast's own scheduled time, not from the
//     wall clock, so a player who was away gets all the casts they earned
//     instead of a single one per request.
// Once the session is over and nothing more is owed, it is closed exactly once
// (stopped, summary mailed, per-session counters cleared).
async function settleAutoFish(userKey, config, { maxCasts = 10, maxMs = SETTLE_TIME_BUDGET_MS } = {}) {
  const idle = { processed: false, casts: 0, settled: false, pending: false, finalized: false, mail: null };
  if (!config.enabled) return idle;
  return withKeyLock(db, `autofish-settle:${userKey}`, async () => {
    const startedAt = Date.now();
    const state = await readAutoFishState(userKey, config);
    // sessionOpen stays true after expiresAt until the session is closed, which
    // is what lets us still credit the casts that were due before the end.
    if (!state.sessionOpen) return { ...idle, state };

    const k = autoFishKeys(userKey);
    const sessionEnd = state.expiresAt;
    const overdue = sessionEnd <= startedAt;
    const stopReached = (s) => s.stopAfter > 0 && s.autoCasts >= s.stopAfter;
    // A running session keeps a small per-request limit; a finished one may owe
    // a long backlog, which is bounded by the time budget instead.
    const hardLimit = overdue ? 500 : Math.max(1, Math.min(300, Number(maxCasts) || 10));

    let casts = 0;
    let nextCastAt = Math.max(0, state.nextCastAt || startedAt);
    let closeReason = stopReached(state) ? 'stopped' : null;
    let limited = false;
    let failed = false;
    let closedElsewhere = false;

    while (!closeReason) {
      const cutoff = Math.min(Date.now(), sessionEnd);
      if (nextCastAt > cutoff) break; // nothing (more) is due
      if (casts >= hardLimit || Date.now() - startedAt > maxMs) { limited = true; break; }

      const live = await readAutoFishState(userKey, config);
      if (!live.sessionOpen) { closedElsewhere = true; break; }
      if (stopReached(live)) { closeReason = 'stopped'; break; }

      const scheduledAt = nextCastAt;
      // null = no fixed target: the cast uses the player's currently selected area.
      const areaOverride = live.targetArea || null;

      const result = await performFishingCast(userKey, {
        displayUser: userKey,
        source: 'auto',
        isVipSubMod: false,
        areaOverride,
        forceTreasuryOnly: live.trophyMode === true,
        messageSettingsOverride: FISH_MESSAGE_DEFAULTS
      });

      const castNow = Date.now();
      if (result.kind === 'cooldown') {
        nextCastAt = castNow + Math.max(1000, Number(result.remainingMs) || config.baseIntervalSeconds * 1000);
        await db.set(k.nextCast, String(nextCastAt));
        break;
      }
      if (result.kind === 'timeout') {
        // Auto-Fish breaks are isolated from the normal !fish timeout key.
        // Pause the auto loop until the repair timer expires.
        nextCastAt = Number(result.timeoutUntil) || (castNow + config.baseIntervalSeconds * 1000);
        await db.set(k.nextCast, String(nextCastAt));
        break;
      }
      if (result.ok) {
        casts += 1;
        await Promise.all([
          Array.isArray(result.items) && result.items.length ? recordAutoFishSessionLoot(userKey, result.items) : null,
          db.incrby(k.sessionCasts, 1)
        ]);
        // A Seamine/Soggyboot caught by Auto-Fish breaks only the automation.
        // Leave the session alive, but park its next cast until repair.
        if (Number(result.autoBrokenUntil) > castNow) {
          nextCastAt = Number(result.autoBrokenUntil);
          await db.set(k.nextCast, String(nextCastAt));
          continue; // the loop top decides whether anything is still due before the end
        }
        // performFishingCast already atomically increments Auto-Fish casts and
        // XP when the Phase 1 RPC is installed. Reusing that result avoids a
        // second full mget of Auto-Fish state after every cast.
        const liveLevel = Number(result.autoProgress?.level || live.level || 1);
        const livePrestige = Number(live.prestige || state.prestige || 0);
        // Advance from the scheduled time (not from "now") so missed casts are
        // made up instead of silently skipped.
        nextCastAt = scheduledAt + autoIntervalSeconds(liveLevel, livePrestige, config) * 1000;
        await db.set(k.nextCast, String(nextCastAt));
      } else {
        failed = true;
        nextCastAt = castNow + config.baseIntervalSeconds * 1000;
        await db.set(k.nextCast, String(nextCastAt));
        break;
      }
    }

    const now = Date.now();
    const ended = sessionEnd <= now;
    const stillDue = nextCastAt <= Math.min(now, sessionEnd);
    if (!closeReason && !closedElsewhere && ended) {
      if (!stillDue && !failed) closeReason = 'expired';
      else if (now - sessionEnd > SETTLE_GRACE_AFTER_END_MS) closeReason = 'expired';
    }

    const closed = closeReason ? await finalizeAutoFishSession(userKey, closeReason) : null;
    const finalState = await readAutoFishState(userKey, config);
    return {
      processed: true,
      casts,
      settled: casts > 0,
      finalized: !!closed,
      mail: closed?.mail || null,
      closeReason,
      sessionCasts: closed?.casts ?? null,
      // Owed casts remain (time/count budget hit, or a failed cast on an ended
      // session): the caller should settle again shortly.
      pending: !closed && !closedElsewhere && (limited || (ended && (stillDue || failed))),
      catchUpLimited: limited,
      state: finalState
    };
  });
}

async function readAutoFishSessionLoot(userKey) {
  const raw = await db.get(autoFishKeys(userKey).sessionLoot);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

async function recordAutoFishSessionLoot(userKey, items = []) {
  if (!Array.isArray(items) || !items.length) return;
  const k = autoFishKeys(userKey);
  const current = await readAutoFishSessionLoot(userKey);
  for (const item of items) {
    const name = String(item || '').trim();
    if (name) current[name] = Math.max(0, Number(current[name]) || 0) + 1;
  }
  await db.set(k.sessionLoot, JSON.stringify(current));
}

async function clearAutoFishSessionLoot(userKey) {
  const k = autoFishKeys(userKey);
  await Promise.all([db.del(k.sessionLoot), db.del(k.sessionCasts)]);
}

async function readAutoFishSessionCasts(userKey) {
  return Math.max(0, parseInt(await db.get(autoFishKeys(userKey).sessionCasts), 10) || 0);
}

// Closes a session exactly once: mails the summary, stops the session and
// clears the per-session counters. Callers hold the autofish-settle lock. A
// failing mail must not keep a finished session open, so it is only logged.
async function finalizeAutoFishSession(userKey, reason) {
  const [loot, casts] = await Promise.all([readAutoFishSessionLoot(userKey), readAutoFishSessionCasts(userKey)]);
  let mail = null;
  try {
    mail = await sendAutoFishSessionMail(userKey, loot, casts, reason);
  } catch (error) {
    console.error('[Auto-Fish] Could not send the session summary:', error);
  }
  const stopped = await stopAutoFish(userKey);
  await clearAutoFishSessionLoot(userKey);
  return { stopped, mail, casts, loot };
}

async function sendAutoFishSessionMail(userKey, loot, casts, reason = 'stopped') {
  const entries = Object.entries(loot || {}).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((sum, [, n]) => sum + Number(n || 0), 0);
  const title = reason === 'expired' ? 'Fishy finished an Auto-Fish session' : 'Fishy brought home your Auto-Fish catch';
  const lines = entries.length
    ? entries.slice(0, 30).map(([item, count]) => `• ${item} ×${count}`)
    : ['• No fish were caught this session.'];
  if (entries.length > 30) lines.push(`• +${entries.length - 30} more item types`);
  const message = `Fishy has finished your Auto-Fish session. ${casts} auto cast${casts === 1 ? '' : 's'} completed and ${total} item${total === 1 ? '' : 's'} were added to your inventory.\n\n${lines.join('\n')}\n\nYour catches are already in your inventory.`;
  return recordUserMail(db, userKey, {
    type: 'autofish', subtype: 'session_summary', title, message, actor: 'fishy',
    meta: { casts, totalItems: total, items: loot, reason }
  });
}

export async function autoFishHandler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!db) return res.status(500).json({ error: 'Database not configured.' });

  const userKey = await requireSession(req, res);
  if (!userKey) return;

  try {
    const config = await getAutoFishConfig();

    if (req.method === 'GET' && String(req.query?.check || '') === 'licensed') {
      // One read, no settlement and no pond load: used by the Your guide checklist.
      const raw = await db.get(`autofish:license:${userKey}`);
      return res.status(200).json({ licensed: raw === 'true' });
    }
    if (req.method === 'GET') {
      const settlement = await settleAutoFish(userKey, config, { maxCasts: 10 });
      const status = await autoFishStatus(userKey, config);
      const pond = Number(status.prestige || 0) >= POND_UNLOCK_PRESTIGE
        ? await pondStatus(userKey, Number(status.prestige || 0), { includeInventory: true })
        : { unlocked: false, prestige: Number(status.prestige || 0) };
      return res.status(200).json({ ...status, pond, settlement: { casts: settlement.casts || 0, settled: !!settlement.settled, catchUpLimited: !!settlement.catchUpLimited, pending: !!settlement.pending, finalized: !!settlement.finalized } });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
    const body = req.body || {};
    const action = String(body.action || '');

    if (action === 'buyLicense') {
      const result = await buyAutoFishLicense(userKey, config);
      return res.status(result.success ? 200 : 400).json(result);
    }

    if (action === 'start') {
      // A session that ended while nobody was polling still owes its casts, and
      // starting a new one wipes the per-session loot. Settle and close it first.
      const prior = await settleAutoFish(userKey, config, { maxCasts: 300 });
      if (prior.pending) {
        return res.status(409).json({ error: 'Fishy is still bringing home the catch from your last Auto-Fish session. Try again in a few seconds.', pending: true });
      }
      const validTarget = body.targetArea && FISHING_AREAS[String(body.targetArea)] ? String(body.targetArea) : null;
      const result = await startAutoFish(userKey, config, validTarget);
      if (result.success) {
        const settlement = await settleAutoFish(userKey, config, { maxCasts: 1 });
        return res.status(200).json({ ...result, settlement: { casts: settlement.casts || 0 } });
      }
      return res.status(400).json(result);
    }

    if (action === 'stop') {
      // Credit every cast that is already owed before closing the session.
      const settlement = await settleAutoFish(userKey, config, { maxCasts: 300 });
      const summary = { casts: settlement.casts || 0, catchUpLimited: !!settlement.catchUpLimited, pending: !!settlement.pending };
      if (settlement.finalized) {
        // The session had already ended (or hit its stop condition): it was
        // closed and mailed by the settle above, so do not mail it twice.
        return res.status(200).json({ success: true, settlement: summary, mail: settlement.mail });
      }
      if (settlement.pending) {
        // Still catching up on owed casts: closing now would drop them.
        return res.status(200).json({ success: true, stopped: false, pending: true, settlement: summary });
      }
      if (!settlement.processed) {
        // No open session (already closed): nothing to stop or mail.
        return res.status(200).json({ success: true, settlement: summary, mail: null });
      }
      const closed = await withKeyLock(db, `autofish-settle:${userKey}`, () => finalizeAutoFishSession(userKey, 'stopped'));
      return res.status(200).json({ ...closed.stopped, settlement: summary, mail: closed.mail });
    }

    if (action === 'event') {
      const eventId = String(body.eventId || '');
      if (!eventId) return res.status(400).json({ error: 'Missing event id.' });
      const result = await completeActiveEvent(userKey, eventId, config);
      return res.status(result.success ? 200 : 400).json(result);
    }

    if (action === 'prestige') {
      const result = await prestigeAutoFish(userKey, config);
      return res.status(result.success ? 200 : 400).json(result);
    }

    if (action === 'trophyMode') {
      const state = await autoFishStatus(userKey, config);
      if (!state.licensed) return res.status(400).json({ error: 'Purchase the Auto-Fishing License first.' });
      const enabled = body.enabled === true;
      if (enabled && !state.trophyFishingUnlocked) {
        return res.status(400).json({ error: 'Trophy Fishing unlocks at Auto-Fish Level 5. Once unlocked, it remains available after Prestige 1.' });
      }
      await db.set(autoFishKeys(userKey).trophyMode, enabled ? 'on' : 'off');
      return res.status(200).json({ success: true, trophyMode: enabled, state: await autoFishStatus(userKey, config) });
    }

    if (action === 'stopAfter') {
      const state = await autoFishStatus(userKey, config);
      if (!state.featureUnlocks.stopConditions) return res.status(400).json({ error: 'Stop conditions unlock at Auto-Fish Level 7.' });
      const value = Math.max(0, Math.min(1000000, parseInt(body.value, 10) || 0));
      await db.set(autoFishKeys(userKey).stopAfter, String(value));
      return res.status(200).json({ success: true, stopAfter: value });
    }

    if (action === 'target') {
      const targetArea = body.targetArea ? String(body.targetArea) : '';
      const state = await autoFishStatus(userKey, config);
      if (targetArea && !FISHING_AREAS[targetArea]) return res.status(400).json({ error: 'Unknown fishing area.' });
      if (targetArea && (state.areas[targetArea]?.level || 0) < 1) return res.status(400).json({ error: 'Unlock that fishing area before targeting it.' });
      const k = autoFishKeys(userKey);
      if (targetArea) await db.set(k.targetArea, targetArea);
      else await db.del(k.targetArea);
      return res.status(200).json({ success: true, targetArea: targetArea || null });
    }

    return res.status(400).json({ error: 'Unknown Auto-Fish action.' });
  } catch (error) {
    console.error('[Auto-Fish API]', error);
    return res.status(500).json({ error: 'Could not update Auto-Fish.' });
  }
}

// Admin helpers are intentionally exported for the consolidated admin action
// endpoint; they do not create another serverless function.
export async function adminGetAutoFish(targetUser) {
  const config = await getAutoFishConfig();
  const state = await autoFishStatus(targetUser, config);
  return {
    config,
    state,
    prestigeTable: AUTO_FISH_PRESTIGES.slice(0, config.prestigeMax).map((p, i) => ({ ...p, perks: prestigePerks(i + 1, config).perks }))
  };
}

export async function adminSetAutoFish(body, actor) {
  if (body.mode === 'config') {
    const config = await setAutoFishConfig(sanitizeAdminConfig(body));
    await recordAdminAudit(db, { actor, action: 'setAutoFishConfig', target: 'global', details: `Updated Auto-Fish configuration (${config.enabled ? 'enabled' : 'disabled'}).` }).catch(() => {});
    return { success: true, config, message: 'Auto-Fish configuration saved.' };
  }

  const target = cleanUser(body.targetUser);
  if (!target) throw new Error('Enter a valid target username.');
  const k = autoFishKeys(target);

  if (body.mode === 'playerSave') {
    const config = await getAutoFishConfig();
    // Admin edits can move a player backwards in progression. Always settle/stop
    // the old session first so stale expiry/next-cast/event state cannot keep
    // running against the newly edited level/prestige values.
    await stopAutoFish(target);
    const clampInt = (value, min, max, fallback) => Math.max(min, Math.min(max, parseInt(value, 10) || fallback));
    // A field the request does not send keeps its stored value. Before this, a missing
    // field was read as 0 (or as "off"), so a partial save such as the level reset wiped
    // prestige, lifetime counters, the saved target, trophy mode and the Auto-Fish license.
    const sent = (name) => body[name] !== undefined && body[name] !== null;
    const storedInt = async (key, min, max, fallback = 0) => clampInt(await db.get(key), min, max, fallback);
    const manualKey = `fish:count:${target}`;

    const level = sent('level') ? clampInt(body.level, 1, config.maxLevel, 1) : await storedInt(k.level, 1, config.maxLevel, 1);
    const xp = sent('xp') ? clampInt(body.xp, 0, 1000000000, 0) : await storedInt(k.xp, 0, 1000000000);
    const prestige = sent('prestige') ? clampInt(body.prestige, 0, config.prestigeMax, 0) : await storedInt(k.prestige, 0, config.prestigeMax);
    const autoCasts = sent('autoCasts') ? clampInt(body.autoCasts, 0, 1000000000, 0) : await storedInt(k.autoCasts, 0, 1000000000);
    const manualCasts = sent('manualCasts') ? clampInt(body.manualCasts, 0, 1000000000, 0) : await storedInt(manualKey, 0, 1000000000);
    const eventsCompleted = sent('eventsCompleted') ? clampInt(body.eventsCompleted, 0, 1000000000, 0) : await storedInt(k.eventsCompleted, 0, 1000000000);
    const treasuryEarned = sent('treasuryEarned') ? clampInt(body.treasuryEarned, 0, 1000000000, 0) : await storedInt(k.treasuryEarned, 0, 1000000000);
    const stopAfter = sent('stopAfter') ? clampInt(body.stopAfter, 0, 1000000, 0) : await storedInt(k.stopAfter, 0, 1000000);

    const existingTrophyUnlocked = (await db.get(k.trophyUnlocked)) === 'true';
    const trophyUnlocked = existingTrophyUnlocked || level >= 5 || prestige >= 1;
    const trophyModeOn = sent('trophyMode') ? body.trophyMode === true : (await db.get(k.trophyMode)) === 'on';
    await Promise.all([
      db.set(k.level, String(level)),
      db.set(k.xp, String(xp)),
      db.set(k.prestige, String(prestige)),
      db.set(k.autoCasts, String(autoCasts)),
      db.set(manualKey, String(manualCasts)),
      db.set(k.eventsCompleted, String(eventsCompleted)),
      db.set(k.treasuryEarned, String(treasuryEarned)),
      db.set(k.stopAfter, String(stopAfter)),
      db.set(k.trophyUnlocked, trophyUnlocked ? 'true' : 'false'),
      db.set(k.trophyMode, trophyModeOn && trophyUnlocked ? 'on' : 'off')
    ]);

    if (sent('targetArea')) {
      if (body.targetArea && FISHING_AREAS[body.targetArea]) {
        if (level < 3) throw new Error('Area targeting requires Auto-Fish Level 3.');
        const areaLevel = Math.max(0, parseInt(await db.get(areaLevelKey(target, body.targetArea)), 10) || 0);
        if (areaLevel < 1) throw new Error('That area is not unlocked for this player.');
        await db.set(k.targetArea, String(body.targetArea));
      } else {
        await db.del(k.targetArea);
      }
    }

    if (sent('licensed')) {
      if (body.licensed) await db.set(k.license, 'true');
      else await db.del(k.license, k.active, k.sessionExpires, k.nextCast, k.event);
    }

    if (body.active) {
      const result = await startAutoFish(target, config, null);
      if (!result.success) throw new Error(result.error || 'Could not start Auto-Fish.');
    } else {
      await stopAutoFish(target);
    }

    await recordAdminAudit(db, { actor, action: 'setAutoFishPlayer', target, details: 'Saved consolidated Auto-Fish player controls.' }).catch(() => {});
    return { success: true, message: `Saved Auto-Fish settings for @${target}.`, state: await autoFishStatus(target, config) };
  }
  if (body.field === 'prestige') {
    const value = Math.max(0, Math.min(5, parseInt(body.value, 10) || 0));
    // Setting Prestige from the admin panel is an explicit edit. It must not
    // silently wipe the level/XP the admin just chose. Normal Prestige itself
    // resets level/XP inside prestigeAutoFish().
    await stopAutoFish(target);
    await db.set(k.prestige, String(value));
  } else if (body.field === 'level') {
    const config = await getAutoFishConfig();
    const value = Math.max(1, Math.min(config.maxLevel, parseInt(body.value, 10) || 1));
    await db.set(k.level, String(value));
  } else if (body.field === 'xp') {
    const value = Math.max(0, Math.min(1000000000, parseInt(body.value, 10) || 0));
    await db.set(k.xp, String(value));
  } else if (body.field === 'license') {
    if (body.value) await db.set(k.license, 'true');
    else await db.del(k.license, k.active, k.sessionExpires, k.nextCast, k.event);
  } else if (body.field === 'autoCasts' || body.field === 'manualCasts' || body.field === 'eventsCompleted' || body.field === 'treasuryEarned') {
    const value = Math.max(0, Math.min(1000000000, parseInt(body.value, 10) || 0));
    if (body.field === 'manualCasts') await db.set(`fish:count:${target}`, String(value));
    else await db.set(k[body.field], String(value));
  } else if (body.field === 'stopAfter') {
    const value = Math.max(0, Math.min(1000000, parseInt(body.value, 10) || 0));
    await db.set(k.stopAfter, String(value));
  } else if (body.field === 'targetArea') {
    const targetArea = String(body.value || '').trim();
    if (!targetArea) await db.del(k.targetArea);
    else if (FISHING_AREAS[targetArea]) {
      const level = Math.max(1, parseInt(await db.get(k.level), 10) || 1);
      const areaLevel = Math.max(0, parseInt(await db.get(areaLevelKey(target, targetArea)), 10) || 0);
      if (level < 3) throw new Error('Area targeting requires Auto-Fish Level 3.');
      if (areaLevel < 1) throw new Error('That area is not unlocked for this player.');
      await db.set(k.targetArea, targetArea);
    } else throw new Error('Unknown target area.');
  } else if (body.field === 'trophyMode') {
    const config = await getAutoFishConfig();
    const level = Math.max(1, Math.min(config.maxLevel, parseInt(await db.get(k.level), 10) || 1));
    const prestige = Math.max(0, parseInt(await db.get(k.prestige), 10) || 0);
    const unlocked = (await db.get(k.trophyUnlocked)) === 'true' || level >= 5 || prestige >= 1;
    if (unlocked) await db.set(k.trophyUnlocked, 'true');
    if (body.value && !unlocked) {
      throw new Error('Trophy Fishing unlocks at Auto-Fish Level 5. Once unlocked, it remains available after Prestige 1.');
    }
    await db.set(k.trophyMode, body.value ? 'on' : 'off');
  } else if (body.field === 'active') {
    if (body.value) {
      const result = await startAutoFish(target, await getAutoFishConfig(), null);
      if (!result.success) throw new Error(result.error || 'Could not start Auto-Fish.');
    } else {
      await stopAutoFish(target);
    }
  } else {
    throw new Error('Unknown Auto-Fish admin field.');
  }

  await recordAdminAudit(db, { actor, action: 'setAutoFish', target, details: `Set Auto-Fish ${body.field} to ${body.value}.` }).catch(() => {});
  return { success: true, message: `Auto-Fish ${body.field} updated for @${target}.`, ...(await adminGetAutoFish(target)) };
}
