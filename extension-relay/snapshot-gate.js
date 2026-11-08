// Per-channel snapshot publish gate.
// - Coalesces concurrent desktop publishers for the same Twitch channel.
// - Starts the cooldown only after Twitch accepts the snapshot.
// - A failed Twitch publish never consumes the cooldown.
export function createSnapshotPublishGate(minIntervalMs = 8_000) {
  const interval = Math.max(1_000, Number(minIntervalMs) || 8_000);
  const lastSuccessAt = new Map();
  const inFlight = new Map();

  function prune(now) {
    if (lastSuccessAt.size <= 5_000) return;
    for (const [channelId, publishedAt] of lastSuccessAt) {
      if (now - publishedAt > 10 * 60_000) lastSuccessAt.delete(channelId);
    }
    while (lastSuccessAt.size > 5_000) {
      const oldest = lastSuccessAt.keys().next().value;
      if (oldest === undefined) break;
      lastSuccessAt.delete(oldest);
    }
  }

  return {
    async publish(channelId, publish) {
      const key = String(channelId || '');
      if (!/^\d{5,20}$/.test(key)) throw new Error('A valid broadcaster ID is required for snapshot publishing.');
      if (typeof publish !== 'function') throw new TypeError('Snapshot publish callback is required.');

      const active = inFlight.get(key);
      if (active) {
        const publishedAt = await active.promise;
        return { accepted: true, coalesced: true, publishedAt };
      }

      const now = Date.now();
      prune(now);
      const previous = lastSuccessAt.get(key) || 0;
      const waitMs = interval - (now - previous);
      if (waitMs > 0) {
        return {
          accepted: false,
          retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000))
        };
      }

      const entry = { promise: null };
      entry.promise = Promise.resolve().then(publish).then(() => {
        const publishedAt = Date.now();
        lastSuccessAt.set(key, publishedAt);
        return publishedAt;
      });
      inFlight.set(key, entry);
      try {
        const publishedAt = await entry.promise;
        return { accepted: true, coalesced: false, publishedAt };
      } finally {
        if (inFlight.get(key) === entry) inFlight.delete(key);
      }
    },
    // Exposed for deterministic tests and diagnostics only.
    getLastSuccessAt(channelId) {
      return lastSuccessAt.get(String(channelId || '')) || 0;
    },
    isInFlight(channelId) {
      return inFlight.has(String(channelId || ''));
    }
  };
}
