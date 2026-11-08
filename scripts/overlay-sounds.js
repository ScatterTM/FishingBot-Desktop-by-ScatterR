// Alert sounds for the OBS overlay and the Broadcaster Admin preview.
// Synthesized in the browser, so no audio files are needed.
(function () {
  var ctx = null;
  var out = null; // the volume stage for the sound being played

  function audio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // One tone with a soft attack, a smooth release and a low-pass filter.
  function note(c, start, freq, dur, type, peak, glideTo) {
    var osc = c.createOscillator();
    var gain = c.createGain();
    var filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.06, dur * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out || c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  var SOUNDS = {
    chime: { label: 'Chime', play: function (c, t) {
      note(c, t, 523.25, 1.2, 'sine', 0.045);
      note(c, t + 0.22, 659.25, 1.2, 'sine', 0.045);
    } },
    bell: { label: 'Bell', play: function (c, t) {
      note(c, t, 880, 2.0, 'sine', 0.05);
      note(c, t, 1760, 1.2, 'sine', 0.012);
    } },
    pop: { label: 'Pop', play: function (c, t) {
      note(c, t, 420, 0.22, 'sine', 0.07, 160);
    } },
    coin: { label: 'Coin', play: function (c, t) {
      note(c, t, 988, 0.35, 'triangle', 0.045);
      note(c, t + 0.08, 1319, 0.5, 'triangle', 0.04);
    } },
    harp: { label: 'Harp', play: function (c, t) {
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        note(c, t + i * 0.09, f, 0.9, 'triangle', 0.04);
      });
    } }
  };

  window.OverlaySounds = {
    ids: Object.keys(SOUNDS),
    labels: function () { return Object.keys(SOUNDS).map(function (id) { return { id: id, label: SOUNDS[id].label }; }); },
    // volume is 0 to 100. Missing means 80, the default.
    play: function (id, volume) {
      try {
        var c = audio();
        var sound = SOUNDS[id] || SOUNDS.chime;
        var level = Math.min(1, Math.max(0, (volume == null || isNaN(volume) ? 80 : Number(volume)) / 100));
        out = c.createGain();
        out.gain.value = level;
        out.connect(c.destination);
        sound.play(c, c.currentTime + 0.02);
      } catch (e) { /* audio is optional */ }
    }
  };
})();
