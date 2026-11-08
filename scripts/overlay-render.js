// One renderer for the OBS overlay and the Broadcaster Admin preview.
// Styling comes from styles/overlay-alerts.css. Animations run from JavaScript
// (element.animate), so they do not depend on CSS classes or cached stylesheets.
(function () {
  var RARITIES = ['secret', 'godly', 'legendary', 'epic', 'rare', 'uncommon', 'common', 'treasury'];
  var DEFAULT_ALERT = '{user} caught {fish}';
  var DEFAULT_LUCK = '{name} · {multiplier}x luck · {time}';
  var LUCK_STYLES = ['bar', 'fade', 'pill', 'ticket', 'playful', 'glass', 'ribbon', 'terminal'];
  var ALIGNS = ['left', 'center', 'right'];
  // Fallback colour for each style when a custom colour or transparency is set.
  var BG_BASE = { ticket: '#EDE8DC', playful: '#1E2B27' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Any {word} that has a value is bold. Everything else is literal, escaped text.
  function template(tpl, values) {
    return String(tpl || '').split(/(\{\w+\})/).map(function (part) {
      var m = part.match(/^\{(\w+)\}$/);
      return m && Object.prototype.hasOwnProperty.call(values, m[1])
        ? '<b>' + esc(values[m[1]] == null ? '' : values[m[1]]) + '</b>'
        : esc(part);
    }).join('');
  }

  // Custom background colour and transparency. With neither set, the style's own background is kept.
  // Text switches to dark on light backgrounds, so it stays readable.
  function applyBackground(el, colour, transparency, styleName) {
    var t = Math.min(90, Math.max(0, Number(transparency) || 0));
    if (!colour && !t) {
      el.style.removeProperty('--ovx-bg-fill');
      el.style.removeProperty('--ovx-fg');
      return;
    }
    var hex = colour || BG_BASE[styleName] || '#050807';
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    var alpha = Math.max(0.1, (100 - t) / 100).toFixed(2);
    var light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
    el.style.setProperty('--ovx-bg-fill', 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')');
    el.style.setProperty('--ovx-fg', light ? '#0A0E0D' : '#EDE8DC');
  }

  // Swaps the alignment class (left, center or right) that starts with the given prefix.
  function alignClass(el, align, prefix) {
    Array.from(el.classList).forEach(function (c) { if (c.indexOf(prefix) === 0) el.classList.remove(c); });
    el.classList.add(prefix + (ALIGNS.indexOf(align) >= 0 ? align : 'center'));
  }

  // Rarity colour wins when it is on. Otherwise the accent colour is used.
  function paint(el, look, data) {
    // The game's tier id for Secret is "unique"; the colour class is "secret".
    var tierId = data.tierId === 'unique' ? 'secret' : data.tierId;
    Array.from(el.classList).forEach(function (c) {
      if (c.indexOf('ovx-rarity-') === 0) el.classList.remove(c);
    });
    if (look.rarityColors && RARITIES.indexOf(tierId) >= 0) {
      el.classList.add('ovx-rarity-' + tierId);
      el.style.removeProperty('--accent');
    } else {
      el.style.setProperty('--accent', look.accent);
    }
    el.className = el.className.replace(/ovx-style-\S+/, '').replace(/ovx-font-\S+/, '').trim();
    el.classList.add('ovx-alert', 'ovx-style-' + look.style, 'ovx-font-' + look.font);
    applyBackground(el, look.alertBg, look.alertBgTransparency, look.style);
    alignClass(el, look.alertAlign, 'ovx-align-');
    el.style.setProperty('--ovx-scale', String((look.alertTextScale || 100) / 100));
    el.style.setProperty('--ovx-size', String((look.alertSize || 100) / 100));
    el.classList.toggle('ovx-upper', !!look.alertUpper);
    var tier = look.showTier === false ? '' : '<span class="ovx-tier">' + esc(data.rarity || '') + '</span>';
    // Header row: the rarity label and the viewer's luck and rod weight, on one baseline.
    var stats = (look.alertStats || look.alertCommunity) && data.stats ? '<span class="ovx-stats">' + esc(data.stats) + '</span>' : '';
    var head = stats || tier ? '<span class="ovx-head">' + tier + stats + '</span>' : '';
    el.innerHTML = head + '<span class="ovx-line">' + template(look.alertTemplate || DEFAULT_ALERT, data) + '</span>';
    return el;
  }

  // Colour class for a game tier id ("unique" is Secret). Empty when the tier is unknown.
  function rarityClass(tierId) {
    var id = tierId === 'unique' ? 'secret' : tierId;
    return RARITIES.indexOf(id) >= 0 ? 'ovx-rarity-' + id : '';
  }

  function build(look, data) {
    return paint(document.createElement('div'), look, data);
  }

  // Points bar label, e.g. "320 / 500 points · Channel luck Lv.1", or the maxed text.
  function pointsLabel(p) {
    if (p.maxed) return (p.name || 'Selected goal') + ' · maxed';
    return p.available + ' / ' + p.cost + ' points · ' + p.name + ' Lv.' + p.level;
  }

  // Banner: the luck text (when a luck event runs) and the channel points bar (when on).
  // data.showText is false when there is no luck text to show. data.points is the goal from the server.
  function paintLuck(el, s, data) {
    var style = LUCK_STYLES.indexOf(s.luckStyle) >= 0 ? s.luckStyle : 'bar';
    el.className = 'ovx-luck ovx-luck-' + style;
    applyBackground(el, s.luckBg, s.luckBgTransparency, style);
    alignClass(el, s.luckAlign, 'ovx-luck-align-');
    el.style.setProperty('--accent', s.accent);
    el.style.setProperty('--ovx-luck-scale', String((s.luckScale || 100) / 100));
    el.style.display = 'block';
    var text = data.showText === false ? '' : template(s.luckTemplate || DEFAULT_LUCK, data);
    var bar = '';
    if (s.pointsBar && data.points) {
      var pct = Math.round(Math.max(0, Math.min(1, Number(data.points.pct) || 0)) * 100);
      bar = '<span class="ovx-pts"><span class="ovx-pts-label">' + esc(pointsLabel(data.points)) + '</span>' +
        '<span class="ovx-pts-track"><span class="ovx-pts-fill" style="width:' + pct + '%' + (s.pointsBarColor ? ';background:' + esc(s.pointsBarColor) : '') + '"></span></span></span>';
    }
    el.innerHTML = text + bar;
    return el;
  }

  // Remaining time as MM:DD:HH:MM:SS. A month is counted as 30 days.
  function countdown(ms) {
    if (ms == null || !isFinite(ms)) return '--:--:--:--:--';
    var total = Math.max(0, Math.floor(ms / 1000));
    var sec = total % 60;
    var min = Math.floor(total / 60) % 60;
    var hour = Math.floor(total / 3600) % 24;
    var days = Math.floor(total / 86400);
    var parts = [Math.floor(days / 30), days % 30, hour, min, sec];
    return parts.map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  }

  var ENTER = {
    slide: { keys: [{ opacity: 0, transform: 'translateY(-14px)' }, { opacity: 1, transform: 'none' }],
             opts: { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'both' } },
    fade:  { keys: [{ opacity: 0 }, { opacity: 1 }],
             opts: { duration: 600, easing: 'ease', fill: 'both' } },
    pop:   { keys: [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1)' }],
             opts: { duration: 500, easing: 'cubic-bezier(.2,1.3,.4,1)', fill: 'both' } }
  };

  function enter(el, animation, ms, horizontalPosition) {
    var a = ENTER[animation] || ENTER.slide;
    if (!el.animate) return null;
    var keys = a.keys;
    if (animation === 'slide') {
      // Side-positioned alerts slide inward from that edge instead of starting
      // with the old vertical-only movement. The small offset keeps the whole
      // alert in view at the configured safe inset.
      var side = ['left', 'center', 'right'].indexOf(horizontalPosition) >= 0 ? horizontalPosition : 'center';
      var startTransform = side === 'left' ? 'translateX(-12px)' : side === 'right' ? 'translateX(12px)' : 'translateY(-14px)';
      keys = [{ opacity: 0, transform: startTransform }, { opacity: 1, transform: 'none' }];
    }
    var opts = Object.assign({}, a.opts, { duration: ms || a.opts.duration });
    return el.animate(keys, opts);
  }

  // Resolves when the fade-out is finished.
  function leave(el) {
    if (!el.animate) { el.remove(); return Promise.resolve(); }
    var anim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease-in', fill: 'forwards' });
    return anim.finished.catch(function () {}).then(function () { el.remove(); });
  }

  window.OverlayRender = {
    build: build, paint: paint, paintLuck: paintLuck, countdown: countdown, rarityClass: rarityClass,
    enter: enter, leave: leave, template: template, esc: esc,
    RARITIES: RARITIES, DEFAULT_ALERT: DEFAULT_ALERT, DEFAULT_LUCK: DEFAULT_LUCK, pointsLabel: pointsLabel
  };
})();
