(() => {
  'use strict';

  const api = window.fishingbot;
  const Apps = window.FishingbotApps;
  const $ = (id) => document.getElementById(id);
  const I18n = window.FishingbotI18n;
  const t = (text, vars) => (I18n ? I18n.t(text, vars) : text);
  // Clock text follows the chosen format. Falls back to 24-hour if appearance.js did not load.
  const clockText = (now) => (window.FishingbotAppearance
    ? window.FishingbotAppearance.clockText(now)
    : now.toTimeString().slice(0, 5));
  const dateText = (now) => (window.FishingbotAppearance
    ? window.FishingbotAppearance.dateText(now)
    : now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }));

  const LAYOUT_KEY = 'fishingbot-desktop:layout:v1';
  // Injected into every Control Centre page. The desktop has the one sign-in, so the page's own Lock button is hidden.
  const CC_CSS = '.rail{display:none!important}.shell{display:block!important}.main{width:100%!important;min-width:0!important}#fb-lock{display:none!important}.top-text,.top .status{display:none!important}';
  const PREVIEW_LINES = 14;
  const MAX_LINES = 1000;
  const TASKBAR_HEIGHT = 84;
  const TITLEBAR_HEIGHT = 36;
  // Icon for each app, from the project's icon set (window.FishingbotIcons).
  const APP_ICON = {
    overview: 'layout',
    loot: 'package',
    game: 'sliders',
    twitch: 'chat',
    extension: 'layers',
    viewer: 'user',
    broadcaster: 'video',
    log: 'download',
    settings: 'settings',
    folder: 'folder',
  };
  // Apps that live in their own taskbar button (next to the Start button). Opening them does not add a taskbar item.
  const PERMANENT_BUTTONS = { settings: 'tb-settings', folder: 'tb-folder' };
  const HIDDEN_KEY = 'fishingbot.hiddenApps';
  function hiddenApps() {
    try {
      const list = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function setHiddenApps(list) {
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: the choice lasts until the page reloads */
    }
  }
  const STATE_TEXT = {
    stopped: 'Stopped',
    starting: 'Starting…',
    running: 'Running',
    attached: 'Running (not started here)',
    error: 'Error',
    missing: 'Server file missing',
  };

  let info = null;
  let server = { state: 'stopped', online: false };
  const logLines = [];
  const logListeners = new Set();
  const windows = new Map(); // appId -> record
  const urlApps = new Map(); // appId -> url
  let focusedId = null;
  let zTop = 10;
  let urlCounter = 0;
  let saveTimer = null;
  let lockMode = null;
  let unlockResolve = null;

  // ---------- helpers ----------

  function iconSvg(name, size = 22) {
    const d = (window.FishingbotIcons || {})[name];
    if (!d) return '';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  }

  // Notifications: a stack of glass cards above the taskbar's tray (see .toast-card in desktop.css).
  // toast(text, kind, opts). kind: 'info' | 'ok' | 'warn' | 'bad'. opts: title; key (a toast with the same key
  // is updated in place, used for progress); progress (0-100, shows a bar); sticky (stays until closed); ms.
  const TOAST_MAX = 4;
  const TOAST_TIME = { info: 4200, ok: 4200, warn: 6000, bad: 7000 };
  const toastByKey = new Map();

  // The stack sits above the tray, its right edge at the tray's right edge. When the taskbar is hidden
  // (auto-hide), it is placed just above where the taskbar shows.
  function positionToasts() {
    const stack = $('toasts');
    const bar = document.querySelector('.taskbar');
    if (!stack || !bar) return;
    const r = bar.getBoundingClientRect();
    const tray = bar.querySelector('.tray');
    const tr = tray ? tray.getBoundingClientRect() : r;
    const hidden = r.top > window.innerHeight - 4;
    const taskbarH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--taskbar-h')) || 54;
    const bottom = hidden ? taskbarH + 28 : window.innerHeight - r.top + 12;
    stack.style.bottom = `${Math.round(bottom)}px`;
    stack.style.right = `${Math.max(8, Math.round(window.innerWidth - tr.right + 4))}px`;
  }

  function dismissToast(card) {
    if (!card || card.dataset.gone) return;
    card.dataset.gone = '1';
    clearTimeout(card._timer);
    if (card._key) toastByKey.delete(card._key);
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 200);
  }

  function scheduleToast(card, ms) {
    clearTimeout(card._timer);
    if (ms) card._timer = setTimeout(() => dismissToast(card), ms);
  }

  function toast(text, kind = 'info', opts = {}) {
    const stack = $('toasts');
    if (!stack) return null;
    const tone = ['ok', 'warn', 'bad'].includes(kind) ? kind : 'info';
    let card = opts.key ? toastByKey.get(opts.key) : null;
    if (!card || card.dataset.gone) {
      card = document.createElement('div');
      card.innerHTML = '<div class="toast-body"><div class="toast-title"></div><div class="toast-text"></div>'
        + '<div class="toast-bar" hidden><span></span></div></div>'
        + '<button class="toast-close" type="button"></button>';
      const close = card.querySelector('.toast-close');
      close.textContent = '×';
      close.setAttribute('aria-label', t('Close'));
      close.addEventListener('click', () => dismissToast(card));
      card.addEventListener('mouseenter', () => clearTimeout(card._timer));
      card.addEventListener('mouseleave', () => scheduleToast(card, card._ms));
      if (opts.key) {
        card._key = opts.key;
        toastByKey.set(opts.key, card);
      }
      stack.append(card);
      const live = [...stack.children].filter((c) => !c.dataset.gone);
      for (const old of live.slice(0, Math.max(0, live.length - TOAST_MAX))) dismissToast(old);
    }
    card.className = `toast-card tone-${tone}`;
    card.querySelector('.toast-title').textContent = opts.title || t('Fishingbot');
    card.querySelector('.toast-text').textContent = text;
    const bar = card.querySelector('.toast-bar');
    const hasProgress = typeof opts.progress === 'number';
    bar.hidden = !hasProgress;
    if (hasProgress) bar.firstElementChild.style.width = `${Math.max(0, Math.min(100, opts.progress))}%`;
    card._sticky = !!opts.sticky;
    card._ms = opts.sticky ? 0 : (opts.ms || TOAST_TIME[tone]);
    if (!card.matches(':hover')) scheduleToast(card, card._ms);
    positionToasts();
    return card;
  }

  async function run(promise) {
    try {
      const result = await promise;
      if (result && result.error) toast(result.error, 'bad');
      return result;
    } catch (err) {
      toast(err.message || String(err), 'bad');
      return null;
    }
  }

  function fmtDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
  }

  function humanize(value) {
    return value ? String(value).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '';
  }

  function setDot(node, tone) {
    node.className = 'dot ' + tone;
  }

  // Taskbar status pill: a coloured dot and a short name. The tooltip has the detail.
  const TRAY_LABEL = { srv: 'Server', tw: 'Twitch' };
  function setTray(key, tone, detail) {
    const pill = $(`tray-${key}-item`);
    if (!pill) return;
    pill.dataset.tone = tone;
    $(`tray-${key}`).className = 'dot ' + tone;
    setTip(pill, `${t(TRAY_LABEL[key])}: ${detail}`);
  }

  function serverBase() {
    return `http://localhost:${info.port}`;
  }

  // Space the taskbar takes at the bottom, measured so every taskbar size leaves the right room for windows.
  function taskbarSpace() {
    const bar = document.querySelector('.taskbar');
    return bar ? bar.offsetHeight + 30 : TASKBAR_HEIGHT;
  }

  function deskArea() {
    return { width: window.innerWidth, height: window.innerHeight - taskbarSpace() - TITLEBAR_HEIGHT };
  }

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // ---------- app catalogue ----------

  function catalogue() {
    const items = info.tabIds.map((tab, index) => ({
      id: `cc:${tab}`,
      label: info.tabs[tab],
      hint: `Ctrl+${index + 1}`,
      icon: APP_ICON[tab],
      kind: 'web',
      tab,
    }));
    items.push({ id: 'log', label: 'Live log', hint: 'Ctrl+L', icon: APP_ICON.log, kind: 'native' });
    items.push({ id: 'settings', label: 'Settings', hint: 'Ctrl+,', icon: APP_ICON.settings, kind: 'native' });
    items.push({ id: 'folder', label: 'Folder', hint: 'Ctrl+D', icon: APP_ICON.folder, kind: 'native' });
    return items;
  }

  function findApp(appId) {
    if (urlApps.has(appId)) {
      let label = 'Web page';
      try {
        label = new URL(urlApps.get(appId)).hostname || label;
      } catch {
        /* keep default */
      }
      return { id: appId, label, icon: 'external', kind: 'url', url: urlApps.get(appId) };
    }
    return catalogue().find((app) => app.id === appId) || null;
  }

  // ---------- grid: one odd, centred grid for the desktop icons and the widgets ----------
  // The grid is square cells, one size per icon size, each a multiple of 16 px (the unit). The number of cells
  // across and down is always odd, so one cell sits exactly in the middle of the desktop and the margins on
  // both sides are equal. An item covers whole cells (a widget covers 2 x 2 cells per unit) and is inset by
  // half the gap on each side, so every box is centred in its cells and neighbours keep an even gap.
  const GRID_UNIT = 16;
  const GRID_GAP = 8;
  const CELL_PX = { small: 5 * GRID_UNIT, medium: 6 * GRID_UNIT, large: 7 * GRID_UNIT };

  function cellPx() {
    const classes = document.body.classList;
    return CELL_PX[classes.contains('icons-small') ? 'small' : classes.contains('icons-large') ? 'large' : 'medium'];
  }

  // The largest odd count that fits: an odd count always has a cell in the exact middle.
  function oddCount(value) {
    let n = Math.max(1, Math.floor(value));
    if (n % 2 === 0) n -= 1;
    return Math.max(1, n);
  }

  // unit: cells per step of an item's position. Icons move by 1 cell; widgets by WIDGET_FACTOR cells.
  function gridMetrics(unit, cell) {
    const area = deskArea();
    const P = cell || cellPx();
    const N = oddCount(area.width / P);
    const M = oddCount(area.height / P);
    return {
      unit,
      P,
      G: GRID_GAP,
      N,
      M,
      ox: (area.width - N * P) / 2,
      oy: (area.height - M * P) / 2,
      area: deskArea,
    };
  }

  function iconGrid() {
    return gridMetrics(1);
  }

  // Widgets are on the same cells: one widget unit is WIDGET_FACTOR cells each way.
  // Widgets always use the medium cell. The icon size changes only the icon grid, so a widget keeps its size
  // and its place when the icons get bigger or smaller.
  function widgetGrid() {
    return gridMetrics(WIDGET_FACTOR, widgetCellPx());
  }

  // Drawn size of an item that spans cols x rows units.
  function boxOf(grid, cols, rows) {
    return { w: cols * grid.unit * grid.P - grid.G, h: rows * grid.unit * grid.P - grid.G };
  }

  // Where an item is drawn: its cells, inset by half the gap. A right or bottom anchor counts from that edge.
  function rectOf(grid, item) {
    const cSpan = item.cols * grid.unit;
    const rSpan = item.rows * grid.unit;
    const c0 = item.ax === 'r' ? grid.N - item.col * grid.unit - cSpan : item.col * grid.unit;
    const r0 = item.ay === 'b' ? grid.M - item.row * grid.unit - rSpan : item.row * grid.unit;
    const box = boxOf(grid, item.cols, item.rows);
    return { x: grid.ox + c0 * grid.P + grid.G / 2, y: grid.oy + r0 * grid.P + grid.G / 2, w: box.w, h: box.h };
  }

  // The largest count from an anchor that keeps an item of this size on the grid.
  function limitsOf(grid, cols, rows) {
    return {
      maxCol: Math.max(0, Math.floor((grid.N - cols * grid.unit) / grid.unit)),
      maxRow: Math.max(0, Math.floor((grid.M - rows * grid.unit) / grid.unit)),
    };
  }

  function clampItem(grid, item) {
    const limits = limitsOf(grid, item.cols, item.rows);
    return {
      ...item,
      col: clamp(Math.round(item.col), 0, limits.maxCol),
      row: clamp(Math.round(item.row), 0, limits.maxRow),
    };
  }

  function overlapsRect(a, b) {
    return a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
  }

  // The item a pixel position lands on: the nearest anchor and cell to where the item's top-left corner is.
  function fitItemFromPixels(grid, x, y, cols, rows) {
    const area = grid.area();
    const box = boxOf(grid, cols, rows);
    const ax = x + box.w / 2 > area.width / 2 ? 'r' : 'l';
    const ay = y + box.h / 2 > area.height / 2 ? 'b' : 't';
    const cSpan = cols * grid.unit;
    const rSpan = rows * grid.unit;
    const c0 = (x - grid.ox - grid.G / 2) / grid.P;
    const r0 = (y - grid.oy - grid.G / 2) / grid.P;
    const col = ax === 'r' ? (grid.N - cSpan - c0) / grid.unit : c0 / grid.unit;
    const row = ay === 'b' ? (grid.M - rSpan - r0) / grid.unit : r0 / grid.unit;
    return clampItem(grid, { ax, ay, col, row, cols, rows });
  }

  // The target if it is free of the others, otherwise the free place nearest to it (any anchor).
  function freeItem(grid, target, others) {
    const want = clampItem(grid, target);
    const taken = others.map((item) => rectOf(grid, item));
    const wantRect = rectOf(grid, want);
    if (!taken.some((r) => overlapsRect(r, wantRect))) return want;
    const limits = limitsOf(grid, want.cols, want.rows);
    let best = null;
    let bestDist = Infinity;
    for (const ax of ['l', 'r']) {
      for (const ay of ['t', 'b']) {
        for (let row = 0; row <= limits.maxRow; row += 1) {
          for (let col = 0; col <= limits.maxCol; col += 1) {
            const candidate = { ax, ay, col, row, cols: want.cols, rows: want.rows };
            const r = rectOf(grid, candidate);
            if (taken.some((o) => overlapsRect(o, r))) continue;
            const dist = (r.x - wantRect.x) ** 2 + (r.y - wantRect.y) ** 2;
            if (dist < bestDist) {
              best = candidate;
              bestDist = dist;
            }
          }
        }
      }
    }
    return best || want;
  }

  // A dragged edge snaps to one size or the other, whichever the pixel size is nearer.
  function snapSpan(px, one, two) {
    return px >= (one + two) / 2 ? 2 : 1;
  }

  // ---------- desktop icons: on the grid; 1x1, or 1x2 (tall) with quick actions ----------
  const ICON_STORE = 'fishingbot-desktop:icons:v3';
  let dropSlot = null;

  function iconNodes() {
    return Array.from($('icons').querySelectorAll('.icon'));
  }

  function loadIconPositions() {
    try {
      return JSON.parse(localStorage.getItem(ICON_STORE)) || {};
    } catch {
      return {};
    }
  }

  function saveIconPositions(map) {
    try {
      localStorage.setItem(ICON_STORE, JSON.stringify(map));
    } catch {
      /* not saved: the icons return to their default place next start */
    }
  }

  // A saved entry: {ax, ay, col, row, rows}. Older saves (cells from the top left, or pixels) are read too.
  function iconItem(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const rows = entry.rows === 2 ? 2 : 1;
    const ax = entry.ax === 'r' ? 'r' : 'l';
    const ay = entry.ay === 'b' ? 'b' : 't';
    if (Number.isFinite(entry.col) && Number.isFinite(entry.row)) return { ax, ay, col: entry.col, row: entry.row, cols: 1, rows };
    if (Number.isFinite(entry.x) && Number.isFinite(entry.y)) {
      const g = iconGrid();
      return { ax: 'l', ay: 't', col: (entry.x - g.ox - g.G / 2) / g.P, row: (entry.y - g.oy - g.G / 2) / g.P, cols: 1, rows: 1 };
    }
    return null;
  }

  function placeIcon(node, item) {
    node._item = item;
    const r = rectOf(iconGrid(), item);
    node.style.left = `${r.x}px`;
    node.style.top = `${r.y}px`;
    node.classList.toggle('icon-tall', item.rows > 1);
    node.style.height = item.rows > 1 ? `${r.h}px` : '';
  }

  // Gives every icon a place: its saved place when it is free, otherwise the nearest free place.
  function arrangeIcons(saved) {
    const grid = iconGrid();
    const placed = [];
    const waiting = [];
    for (const node of iconNodes()) {
      const want = saved ? iconItem(saved[node.dataset.app]) : node._intent || node._item;
      if (want) node._intent = want;
      const item = want ? clampItem(grid, want) : null;
      if (item && !placed.some((p) => overlapsRect(rectOf(grid, p), rectOf(grid, item)))) {
        placed.push(item);
        placeIcon(node, item);
      } else {
        waiting.push({ node, want: item });
      }
    }
    for (const { node, want } of waiting) {
      const target = want || { ax: 'l', ay: 't', col: 0, row: 0, cols: 1, rows: 1 };
      node._intent = target;
      const item = freeItem(grid, target, placed);
      placed.push(item);
      placeIcon(node, item);
    }
  }

  function saveIcons() {
    const map = {};
    for (const node of iconNodes()) {
      const i = node._intent || node._item;
      map[node.dataset.app] = { ax: i.ax, ay: i.ay, col: i.col, row: i.row, rows: i.rows };
    }
    saveIconPositions(map);
  }

  // The dashed place an icon will land in while it is dragged.
  function slotNode() {
    if (!dropSlot) {
      dropSlot = document.createElement('div');
      dropSlot.className = 'icon-slot';
      dropSlot.hidden = true;
    }
    return dropSlot;
  }

  function showSlot(item) {
    const slot = slotNode();
    const r = rectOf(iconGrid(), item);
    slot.style.left = `${r.x}px`;
    slot.style.top = `${r.y}px`;
    slot.style.width = `${r.w}px`;
    slot.style.height = `${r.h}px`;
    slot.hidden = false;
  }

  // After a drag: a single icon swaps with the one it lands on when both are 1x1 and the swap is clear.
  // Otherwise the icon moves to the nearest free place.
  function settleIcon(node, from) {
    const grid = iconGrid();
    const others = iconNodes().filter((n) => n !== node);
    const item = node._item;
    const landed = rectOf(grid, item);
    const clash = others.find((n) => overlapsRect(rectOf(grid, n._item), landed));
    if (clash && from && from.rows === 1 && item.rows === 1 && clash._item.rows === 1) {
      const rest = others.filter((n) => n !== clash).map((n) => n._item);
      const swapped = { ...from };
      const clear = (target) => !rest.some((o) => overlapsRect(rectOf(grid, o), rectOf(grid, target)));
      if (clear(swapped) && clear(item)) {
        placeIcon(clash, swapped);
        placeIcon(node, item);
        clash._intent = swapped;
        node._intent = item;
        saveIcons();
        return;
      }
    }
    placeIcon(node, freeItem(grid, item, others.map((n) => n._item)));
    node._intent = item;
    saveIcons();
  }

  // Drag to move an icon. It moves to the grid place under its top-left corner. A short press without
  // movement still opens the app. Quick-action buttons and the grip are not drag handles.
  function attachDrag(node) {
    let press = null;
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.icon-actions, .icon-grip')) return;
      press = { x: event.clientX, y: event.clientY, left: node.offsetLeft, top: node.offsetTop, id: event.pointerId, from: node._item };
      node._dragged = false;
      node.setPointerCapture(event.pointerId);
    });
    node.addEventListener('pointermove', (event) => {
      if (!press || event.pointerId !== press.id) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!node._dragged && Math.hypot(dx, dy) < 5) return;
      node._dragged = true;
      node.classList.add('dragging');
      const item = fitItemFromPixels(iconGrid(), press.left + dx, press.top + dy, 1, node._item.rows);
      placeIcon(node, item);
      showSlot(item);
      showGuides(node);
    });
    const finish = (event) => {
      if (!press || event.pointerId !== press.id) return;
      node.classList.remove('dragging');
      slotNode().hidden = true;
      clearGuides();
      if (node._dragged) settleIcon(node, press.from);
      press = null;
    };
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', finish);
  }

  // Edit layout: the grip at the bottom right makes an icon 1 cell or 2 cells tall.
  function attachResize(node) {
    const grip = node.querySelector('.icon-grip');
    grip.addEventListener('pointerdown', (event) => {
      if (!editLayout || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      const grid = iconGrid();
      const one = boxOf(grid, 1, 1).h;
      const two = boxOf(grid, 1, 2).h;
      const start = { y: event.clientY, h: node.offsetHeight, item: { ...node._item } };
      const move = (e) => {
        const r = rectOf(grid, start.item);
        const rows = snapSpan(start.h + (e.clientY - start.y), one, two);
        placeIcon(node, fitItemFromPixels(grid, r.x, r.y, 1, rows));
      };
      const done = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', done);
        grip.removeEventListener('pointercancel', done);
        settleIcon(node, null);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', done);
      grip.addEventListener('pointercancel', done);
    });
  }

  // The quick actions of a tall (1x2) icon. They use the controls that already exist, so they respect
  // their own enabled state, and they are not drag handles.
  function quickActions(app) {
    const open = { label: t('Open'), run: () => openApp(app.id) };
    if (app.id === 'cc:overview') {
      return [
        { label: t('Start'), run: () => $('srv-start').click() },
        { label: t('Stop'), run: () => $('srv-stop').click() },
      ];
    }
    if (app.id === 'cc:twitch') return [{ label: t('Reconnect'), run: () => $('tw-reconnect').click() }, open];
    if (app.id === 'log') return [open, { label: t('Pop out'), run: () => $('log-open').click() }];
    return [open, { label: t('Refresh'), run: () => refreshApp(app.id) }];
  }

  function refreshApp(id) {
    const rec = windows.get(id);
    if (!rec) {
      openApp(id);
      return;
    }
    if (rec.body._webview) {
      if (rec.body._paused) resumeWeb(rec.body);
      else reloadView(rec.body);
      return;
    }
    rec.body.innerHTML = '';
    if (id === 'settings') Apps.settings(rec.body, api);
    else if (id === 'log') Apps.log(rec.body, logStore());
    else if (id === 'folder') Apps.folder(rec.body, api);
  }

  function buildIcon(app) {
    const node = document.createElement('div');
    node.className = 'icon';
    node.dataset.app = app.id;
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.title = `${t(app.label)} (${app.hint})`;
    const glyph = document.createElement('span');
    glyph.className = 'icon-glyph';
    glyph.innerHTML = iconSvg(app.icon, 26);
    const label = document.createElement('span');
    label.className = 'icon-label';
    label.textContent = t(app.label);
    const actions = document.createElement('div');
    actions.className = 'icon-actions';
    for (const action of quickActions(app)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = action.label;
      b.addEventListener('click', (event) => {
        event.stopPropagation();
        action.run();
      });
      actions.append(b);
    }
    const grip = document.createElement('span');
    grip.className = 'icon-grip';
    grip.setAttribute('aria-hidden', 'true');
    node.append(glyph, label, actions, grip);
    attachDrag(node);
    attachResize(node);
    node.addEventListener('click', (event) => {
      if (node._dragged) {
        node._dragged = false;
        return;
      }
      if (event.target.closest('.icon-actions, .icon-grip')) return;
      node.classList.add('launch');
      setTimeout(() => node.classList.remove('launch'), 420);
      openApp(app.id);
    });
    node.addEventListener('keydown', (event) => {
      if (event.target === node && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        openApp(app.id);
      }
    });
    return node;
  }

  function renderIcons() {
    const saved = loadIconPositions();
    const hidden = hiddenApps();
    const apps = catalogue().filter((app) => !PERMANENT_BUTTONS[app.id] && !hidden.includes(app.id));
    const nodes = apps.map((app, i) => {
      const node = buildIcon(app);
      node.style.setProperty('--i', String(i));
      return node;
    });
    $('icons').replaceChildren(...nodes, slotNode());
    arrangeIcons(saved);
  }

  // Re-lays the icons when the size of the icons, the taskbar or the window changes.
  function layoutIcons() {
    arrangeIcons(null);
  }

  // ---------- start menu: search first, then apps, settings and commands ----------
  // Settings sections that search can open. tab and group pick the Settings tab and the Appearance group,
  // target is the card's selector inside that tab. keys are extra words that find the card.
  const SETTINGS_TABS = { general: 'General', appearance: 'Appearance', security: 'Security', updates: 'Updates', twitch: 'Twitch' };
  const SETTINGS_GROUPS = { desktop: 'Desktop', look: 'Look', taskbar: 'Taskbar', lock: 'Lock screen', widgets: 'Widgets' };
  const SETTINGS_INDEX = [
    { id: 'scale', tab: 'appearance', group: 'desktop', target: '#ap-scale', title: 'Scale', keys: 'size zoom smaller larger fit screen small screen resolution' },
    { id: 'wallpaper', tab: 'appearance', group: 'desktop', target: '#ap-wallpaper', title: 'Wallpaper', keys: 'background image picture fit dim blur animated gif' },
    { id: 'profile', tab: 'appearance', group: 'desktop', target: '#ap-profile', title: 'Profile picture', keys: 'avatar photo logo face' },
    { id: 'icons', tab: 'appearance', group: 'desktop', target: '#ap-icons', title: 'Icons', keys: 'app icon size labels names' },
    { id: 'colour', tab: 'appearance', group: 'look', target: '#ap-colour', title: 'Colour and glass', keys: 'accent colour glass transparency corner rounding radius text size' },
    { id: 'font', tab: 'appearance', group: 'look', target: '#ap-interface', title: 'Interface font', keys: 'font typeface reduce motion animation' },
    { id: 'taskbar', tab: 'appearance', group: 'taskbar', target: '#ap-taskbar', title: 'Taskbar', keys: 'bar size alignment opacity full width hide auto hide clock search bar' },
    { id: 'pills', tab: 'appearance', group: 'taskbar', target: '#ap-pills', title: 'Status pills', keys: 'server twitch status dot' },
    { id: 'lock', tab: 'appearance', group: 'lock', target: '#ap-lock', title: 'Lock screen', keys: 'greeting blur dim sign in password' },
    { id: 'widgets-show', tab: 'appearance', group: 'widgets', target: '#widgets-show', title: 'Widgets on the desktop', keys: 'show hide widget local server twitch bot live log system usage reset positions' },
    { id: 'clock', tab: 'appearance', group: 'widgets', target: '#widgets-clock', title: 'Clock and date', keys: 'time date clock 24 hour seconds format font' },
    { id: 'general-ui', tab: 'general', target: '#s-ui', title: 'Language and interface', keys: 'language english deutsch espanol francais chinese auto scroll log confirm stop' },
    { id: 'startup', tab: 'general', target: '#s-startup', title: 'Startup', keys: 'start windows obs boot login' },
    { id: 'performance', tab: 'general', target: '#s-perf', title: 'Performance', keys: 'cpu alert memory ram network limit' },
    { id: 'queue', tab: 'general', target: '#s-queue', title: 'Queued changes', keys: 'queue pending applied rejected' },
    { id: 'security', tab: 'security', target: '#s-security', title: 'Session timeout', keys: 'session timeout login sign out minutes' },
    { id: 'autolock', tab: 'security', target: '#s-autolock', title: 'Auto-lock', keys: 'lock idle inactive windows sleep' },
    { id: 'backup', tab: 'security', target: '#s-backup', title: 'Database backups', keys: 'backup database copy restore keep' },
    { id: 'password', tab: 'security', target: '#s-password', title: 'Admin password', keys: 'password change admin' },
    { id: 'updates', tab: 'updates', target: '#s-updates', title: 'Automatic updates', keys: 'update version check install github' },
    { id: 'twitch-oauth', tab: 'twitch', target: '#s-twitch', title: 'Twitch legacy OAuth', keys: 'client id secret twitch oauth' },
    { id: 'twitch-admin', tab: 'twitch', target: '#s-admin', title: 'Twitch Master Admin', keys: 'pairing code extension admin unlink' },
  ];
  const SETTINGS_QUICK = ['scale', 'wallpaper', 'widgets-show', 'taskbar'];
  const SEARCH_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.6 10.6 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  // Opens a Settings section: the Settings window, then its tab and card. Used by search and quick settings.
  function goSettings(entry) {
    const rec = openApp('settings');
    if (rec && rec.body && rec.body.__goTo) rec.body.__goTo(entry.tab, entry.group, entry.target);
  }

  // Everything search can reach. Each entry has a title, a breadcrumb, words to match and a run function.
  function searchEntries() {
    const apps = catalogue().map((app) => ({
      kind: 'app', title: t(app.label), crumb: t('Apps'), icon: app.icon, hint: app.hint,
      keys: `${app.tab || app.id} ${app.label}`, run: () => openApp(app.id),
    }));
    const settings = SETTINGS_INDEX.map((entry) => {
      const parts = [t('Settings'), t(SETTINGS_TABS[entry.tab])];
      if (entry.group) parts.push(t(SETTINGS_GROUPS[entry.group]));
      return {
        kind: 'setting', title: t(entry.title), crumb: parts.join(' › '), icon: 'settings', id: entry.id,
        keys: t(entry.keys), run: () => goSettings(entry),
      };
    });
    const commands = [
      { kind: 'cmd', title: t(editLayout ? 'Done editing' : 'Edit layout'), crumb: t('Commands'), icon: 'layout', keys: t('move resize widgets icons arrange layout'),
        run: () => setEditLayout(!editLayout) },
      { kind: 'cmd', title: t('Lock'), crumb: t('Commands'), icon: 'lock', keys: t('lock sign out password'), run: () => lockDesktop() },
      { kind: 'cmd', title: t('Quit'), crumb: t('Commands'), icon: 'lock', keys: t('quit close exit stop'), run: () => {
        if (window.confirm(t('Quit Fishingbot Desktop? A server that this app started will stop.'))) api.quitApp();
      } },
    ];
    return { apps, settings, commands };
  }

  // Matches every word typed against the title, breadcrumb and keywords. Titles that start with the
  // typed text rank first, then apps, then the rest.
  function searchResults(query) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const { apps, settings, commands } = searchEntries();
    const phrase = words.join(' ');
    const scored = [...apps, ...settings, ...commands].map((item) => {
      const hay = `${item.title} ${item.crumb} ${item.keys || ''}`.toLowerCase();
      if (!words.every((word) => hay.includes(word))) return null;
      const title = item.title.toLowerCase();
      const score = (title.startsWith(phrase) ? 4 : 0) + (title.includes(words[0]) ? 2 : 0) + (item.kind === 'app' ? 1 : 0);
      return { item, score };
    });
    return scored.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 14).map((x) => x.item);
  }

  // The menu's state: what the search box holds and which result the keyboard is on.
  const startState = { query: '', active: 0, rows: [], animateNext: false };

  // The menu is built once. The search box keeps its text when the list or the footer is redrawn.
  function buildStartShell(menu) {
    const search = document.createElement('div');
    search.className = 'sm-search';
    search.innerHTML = SEARCH_ICON;
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'sm-input';
    input.id = 'sm-input';
    input.placeholder = t('Search apps and settings');
    input.setAttribute('aria-label', t('Search apps and settings'));
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    const kbd = document.createElement('kbd');
    kbd.className = 'sm-kbd';
    kbd.textContent = 'Ctrl K';
    kbd.setAttribute('aria-hidden', 'true');
    search.append(input, kbd);
    input.addEventListener('input', () => setQuery(input.value));
    input.addEventListener('keydown', (event) => onStartKey(event));
    const results = document.createElement('div');
    results.className = 'sm-results';
    results.id = 'sm-results';
    results.setAttribute('role', 'listbox');
    const foot = document.createElement('div');
    foot.className = 'sm-foot';
    foot.id = 'sm-foot';
    menu.replaceChildren(search, results, foot);
  }

  // Sets what the search holds. The menu's box and the taskbar's box always show the same text.
  function setQuery(text) {
    startState.query = text;
    startState.active = 0;
    ['sm-input', 'tb-search-input'].forEach((id) => {
      const el = $(id);
      if (el && el.value !== text) el.value = text;
    });
    renderStartResults();
  }

  // Keyboard: arrows move through the results, Enter opens the one in front, Escape clears or closes.
  function onStartKey(event) {
    const rows = startState.rows;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!rows.length) return;
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      setActive((startState.active + step + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[startState.active];
      if (row) activate(row);
    } else if (event.key === 'Escape') {
      // Stopped here so the page-wide Escape does not also close the menu while the search is cleared.
      event.preventDefault();
      event.stopPropagation();
      if (startState.query) {
        setQuery('');
      } else {
        toggleStart(false);
        const tbInput = $('tb-search-input');
        if (tbInput) tbInput.blur();
      }
    }
  }

  function setActive(index) {
    startState.active = index;
    startState.rows.forEach((row, i) => {
      const on = i === index;
      row.el.classList.toggle('active', on);
      row.el.setAttribute('aria-selected', String(on));
      if (on) row.el.scrollIntoView({ block: 'nearest' });
    });
  }

  function activate(row) {
    toggleStart(false);
    row.run();
  }

  // Builds one selectable row or tile, and records it so the keyboard can reach it.
  function makeRow(item, variant) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = variant === 'tile' ? 'sm-tile sm-item' : 'sm-row sm-item';
    el.setAttribute('role', 'option');
    const ico = document.createElement('span');
    ico.className = 'sm-ico';
    ico.innerHTML = iconSvg(item.icon || 'settings', variant === 'tile' ? 20 : 16);
    if (variant === 'tile') {
      const name = document.createElement('span');
      name.className = 'sm-name';
      name.textContent = item.title;
      el.append(ico, name);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'sm-hint';
        hint.textContent = item.hint;
        el.append(hint);
      }
    } else {
      const text = document.createElement('span');
      text.className = 'sm-text';
      const title = document.createElement('span');
      title.className = 'sm-title';
      title.textContent = item.title;
      const crumb = document.createElement('span');
      crumb.className = 'sm-crumb';
      crumb.textContent = item.crumb;
      text.append(title, crumb);
      el.append(ico, text);
      if (item.hint) {
        const kbd = document.createElement('kbd');
        kbd.textContent = item.hint;
        el.append(kbd);
      }
    }
    el.addEventListener('click', () => activate(row));
    el.addEventListener('mousemove', () => {
      const index = startState.rows.findIndex((r) => r.el === el);
      if (index >= 0 && index !== startState.active) setActive(index);
    });
    const row = { el, run: item.run };
    return row;
  }

  // Draws the results: the app tiles and quick settings when the search box is empty, otherwise the matches.
  function renderStartResults() {
    const box = $('sm-results');
    if (!box) return;
    const rows = [];
    const nodes = [];
    if (!startState.query.trim()) {
      const { apps, settings } = searchEntries();
      const label = (text) => { const el = document.createElement('div'); el.className = 'sm-label'; el.textContent = text; return el; };
      nodes.push(label(t('Apps')));
      const grid = document.createElement('div');
      grid.className = 'sm-grid';
      apps.forEach((item) => {
        const row = makeRow(item, 'tile');
        rows.push(row);
        grid.append(row.el);
      });
      nodes.push(grid);
      nodes.push(label(t('Jump to')));
      SETTINGS_QUICK.forEach((id) => {
        const entry = settings.find((item) => item.id === id);
        if (!entry) return;
        const row = makeRow(entry, 'row');
        rows.push(row);
        nodes.push(row.el);
      });
    } else {
      const matches = searchResults(startState.query);
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'sm-empty';
        empty.textContent = t('Nothing matches "{query}". Try a shorter word, such as "scale" or "widget".', { query: startState.query.trim() });
        nodes.push(empty);
      }
      matches.forEach((item) => {
        const row = makeRow(item, 'row');
        rows.push(row);
        nodes.push(row.el);
      });
    }
    box.replaceChildren(...nodes);
    startState.rows = rows;
    if (startState.animateNext) {
      // Only when the menu opens: each row slides in one after the other. Typing does not replay it.
      startState.animateNext = false;
      rows.forEach((row, i) => row.el.style.setProperty('--i', String(Math.min(i, 14))));
      box.classList.remove('sm-enter');
      void box.offsetWidth;
      box.classList.add('sm-enter');
    }
    startState.active = Math.min(startState.active, Math.max(0, rows.length - 1));
    setActive(startState.active);
  }

  function renderStartMenu() {
    const menu = $('start-menu');
    if (!menu.querySelector('.sm-search')) buildStartShell(menu);
    const placeholder = t('Search apps and settings');
    $('sm-input').placeholder = placeholder;
    $('sm-input').setAttribute('aria-label', placeholder);
    const tbInput = $('tb-search-input');
    if (tbInput) {
      tbInput.placeholder = placeholder;
      tbInput.setAttribute('aria-label', placeholder);
    }
    renderStartResults();

    // The footer: layout, lock and quit. Settings has its own button on the taskbar.
    const foot = $('sm-foot');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.setAttribute('aria-pressed', String(editLayout));
    edit.innerHTML = `${iconSvg('layout', 14)}<span>${t(editLayout ? 'Done editing' : 'Edit layout')}</span>`;
    edit.addEventListener('click', () => {
      toggleStart(false);
      setEditLayout(!editLayout);
    });
    const lock = document.createElement('button');
    lock.type = 'button';
    lock.innerHTML = `${iconSvg('lock', 14)}<span>${t('Lock')}</span>`;
    lock.addEventListener('click', () => {
      toggleStart(false);
      lockDesktop();
    });
    const quit = document.createElement('button');
    quit.type = 'button';
    quit.className = 'danger';
    quit.innerHTML = `<span>${t('Quit')}</span>`;
    quit.addEventListener('click', () => {
      toggleStart(false);
      if (window.confirm(t('Quit Fishingbot Desktop? A server that this app started will stop.'))) api.quitApp();
    });
    foot.replaceChildren(edit, lock, quit);
  }

  // The menu lives in the page body, not in the taskbar: a blur inside the taskbar has nothing to blur,
  // so the menu takes the window glass and its blur from there. It sits just above the Menu button.
  function placeStartMenu(anchor) {
    const menu = $('start-menu');
    const r = (anchor || $('start-btn')).getBoundingClientRect();
    // Opened from the taskbar search: centred on the screen. The Menu button and the other anchors keep their place.
    const centred = !!anchor && anchor.id === 'tb-search';
    const left = centred ? (window.innerWidth - 380) / 2 : r.left;
    menu.style.left = `${clamp(left, 8, window.innerWidth - 380 - 8)}px`;
    menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 12)}px`;
  }

  // Ctrl+K: opens the search above the taskbar when the taskbar shows it, otherwise the Start menu with its own
  // search box. When the menu is already open, the cursor moves to the search box.
  function openSearch() {
    const useTaskbar = !document.body.classList.contains('no-taskbar-search');
    const menu = $('start-menu');
    if (menu.hidden) toggleStart(true, useTaskbar ? { anchor: $('tb-search'), focus: 'taskbar' } : { focus: 'menu' });
    const box = useTaskbar ? $('tb-search-input') : $('sm-input');
    if (box) box.focus();
  }

  // options: anchor (the element the menu opens above), focus ('taskbar' or the menu's own box),
  // keepQuery (keep the text already typed, used when the taskbar box opens the menu).
  function toggleStart(force, options = {}) {
    const menu = $('start-menu');
    const open = force === undefined ? menu.hidden : force;
    const wasHidden = menu.hidden;
    clearTimeout(menu._closeTimer);
    if (open) {
      placeStartMenu(options.anchor);
      menu.classList.remove('closing');
      menu.hidden = false;
    } else if (!menu.hidden) {
      menu.classList.add('closing');
      menu._closeTimer = setTimeout(() => {
        menu.hidden = true;
        menu.classList.remove('closing');
      }, 140);
    }
    document.body.classList.toggle('start-open', open);
    $('start-btn').setAttribute('aria-expanded', String(open));
    if (!open) return;
    startState.animateNext = wasHidden;
    if (!options.keepQuery) setQuery('');
    else renderStartResults();
    const target = options.focus === 'taskbar' ? $('tb-search-input') : $('sm-input');
    if (target) target.focus();
  }

  // ---------- window snapping ----------
  // Zones are fractions of the windows area: [x, y, width, height].
  const SNAP_ZONES = {
    full: [0, 0, 1, 1],
    left: [0, 0, 0.5, 1],
    right: [0.5, 0, 0.5, 1],
    tl: [0, 0, 0.5, 0.5],
    tr: [0.5, 0, 0.5, 0.5],
    bl: [0, 0.5, 0.5, 0.5],
    br: [0.5, 0.5, 0.5, 0.5],
  };
  // Each layout lists its slots in order. The focused window takes the first slot.
  const SNAP_LAYOUTS = [
    { id: 'full', label: 'Fullscreen', slots: ['full'] },
    { id: 'split', label: 'Split', slots: ['left', 'right'] },
    { id: 'tall', label: '1 tall, 2 small', slots: ['left', 'tr', 'br'] },
    { id: 'quad', label: 'Quad', slots: ['tl', 'tr', 'bl', 'br'] },
  ];
  const SNAP_PAD = 3;
  const SNAP_EDGE = 6;
  const SNAP_CORNER = 24;
  let snapRec = null;

  const zOf = (rec) => Number(rec.el.style.zIndex) || 0;

  function zoneRect(name) {
    const box = workArea();
    const [x, y, w, h] = SNAP_ZONES[name];
    return {
      x: x * box.width + SNAP_PAD,
      y: y * box.height + SNAP_PAD,
      w: w * box.width - SNAP_PAD * 2,
      h: h * box.height - SNAP_PAD * 2,
    };
  }

  // Which zone the pointer is in while a window is dragged. Null means no snap.
  function zoneAt(clientX, clientY) {
    const origin = $('windows').getBoundingClientRect();
    const { width: W, height: H } = workArea();
    const x = clamp(clientX - origin.left, 0, W);
    const y = clamp(clientY - origin.top, 0, H);
    if (x <= SNAP_CORNER && y <= SNAP_CORNER) return 'tl';
    if (x >= W - SNAP_CORNER && y <= SNAP_CORNER) return 'tr';
    if (x <= SNAP_CORNER && y >= H - SNAP_CORNER) return 'bl';
    if (x >= W - SNAP_CORNER && y >= H - SNAP_CORNER) return 'br';
    if (y <= SNAP_EDGE) return 'full';
    if (x <= SNAP_EDGE) return 'left';
    if (x >= W - SNAP_EDGE) return 'right';
    return null;
  }

  function showSnapPreview(name) {
    const el = $('snap-preview');
    if (!name) {
      el.classList.remove('on');
      return;
    }
    const r = zoneRect(name);
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    el.classList.add('on');
  }

  // rec.rest is the free-floating place of a window. It is kept while the window is snapped or maximised,
  // so dragging it out of a split (or down from the top) brings it back at its own size.
  function snapTo(rec, name) {
    if (name === 'full') {
      if (!rec.maximized) {
        if (!rec.snapped) rec.rest = windowRect(rec);
        rec.maximized = true;
        rec.el.classList.add('max');
      }
      rec.snapped = false;
      fitMax(rec);
      return;
    }
    if (rec.maximized) {
      rec.maximized = false;
      rec.el.classList.remove('max');
    }
    if (!rec.snapped) rec.rest = windowRect(rec);
    rec.snapped = true;
    const r = zoneRect(name);
    Object.assign(rec.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  // Dragging a snapped or maximised window takes it out of that layout: it returns to its free size and
  // stays under the pointer, the way it does in Windows.
  function releaseFromLayout(rec, event) {
    const origin = $('windows').getBoundingClientRect();
    const head = rec.el.querySelector('.win-head').getBoundingClientRect();
    const rest = rec.rest || { x: 300, y: 40, w: 900, h: 580 };
    const area = workArea();
    const w = Math.min(rest.w, area.width);
    const h = Math.min(rest.h, area.height);
    // The pointer keeps the same place across the title bar: the same fraction along it, the middle of it down.
    const grabX = clamp((event.clientX - head.left) / Math.max(1, head.width), 0, 1);
    const grabY = head.height / 2;
    rec.maximized = false;
    rec.snapped = false;
    rec.el.classList.remove('max');
    Object.assign(rec.el.style, {
      left: `${clamp(event.clientX - origin.left - w * grabX, -w + 120, area.width - 120)}px`,
      top: `${clamp(event.clientY - origin.top - grabY, 0, Math.max(0, area.height - h))}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    saveLayout();
  }

  // Lay out the focused window and the most recently used visible windows in a layout.
  function snapGroup(rec, layoutId) {
    const layout = SNAP_LAYOUTS.find((item) => item.id === layoutId);
    if (!layout) return;
    if (rec.minimized) setMinimized(rec, false);
    const others = [...windows.values()]
      .filter((other) => other !== rec && !other.minimized)
      .sort((a, b) => zOf(b) - zOf(a));
    const group = [rec, ...others].slice(0, layout.slots.length);
    group.forEach((item, i) => animate(item, () => snapTo(item, layout.slots[i])));
    focusWin(rec);
    saveLayout();
  }

  function snapMiniSvg(slots) {
    const rects = slots
      .map((name) => {
        const [x, y, w, h] = SNAP_ZONES[name];
        return `<rect x="${x * 48 + 1.5}" y="${y * 30 + 1.5}" width="${w * 48 - 3}" height="${h * 30 - 3}" rx="2"/>`;
      })
      .join('');
    return `<svg width="48" height="30" viewBox="0 0 48 30" aria-hidden="true">${rects}</svg>`;
  }

  function closeSnapPop() {
    $('snap-pop').hidden = true;
    snapRec = null;
  }

  function openSnapPop(rec, anchor) {
    const pop = $('snap-pop');
    if (!pop.hidden && snapRec === rec) {
      closeSnapPop();
      return;
    }
    snapRec = rec;
    pop.replaceChildren(
      ...SNAP_LAYOUTS.map((layout) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'snap-opt';
        button.setAttribute('role', 'menuitem');
        button.innerHTML = `${snapMiniSvg(layout.slots)}<span>${layout.label}</span>`;
        button.addEventListener('click', () => {
          closeSnapPop();
          snapGroup(rec, layout.id);
        });
        return button;
      }),
    );
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8)}px`;
    pop.style.top = `${Math.max(8, r.top - h - 8)}px`;
  }

  document.addEventListener('pointerdown', (event) => {
    if (!$('snap-pop').hidden && !event.target.closest('.snap-pop, [data-act="snap"]')) closeSnapPop();
  });

  // ---------- desktop right-click menu: the quick actions of the desktop background ----------
  // Shown where the desktop itself is clicked (not on an icon, a widget, a window or the taskbar).
  let ctxEl = null;
  let ctxHideOpen = false;

  function closeDesktopMenu() {
    if (ctxEl) ctxEl.hidden = true;
    ctxHideOpen = false;
  }

  function toggleHidden(appId) {
    const list = hiddenApps();
    setHiddenApps(list.includes(appId) ? list.filter((id) => id !== appId) : [...list, appId]);
    renderIcons();
    renderDesktopMenu();
  }

  function renderDesktopMenu() {
    const hidden = hiddenApps();
    const item = (label, run, disabled) => h('button', {
      class: 'ctx-item', type: 'button', role: 'menuitem', disabled: disabled || undefined,
      onclick: () => { closeDesktopMenu(); run(); },
    }, h('span', { text: label }));
    const hideables = catalogue().filter((app) => !PERMANENT_BUTTONS[app.id]);
    const hideRow = h('button', {
      class: 'ctx-item', type: 'button', role: 'menuitem', 'aria-expanded': String(ctxHideOpen),
      onclick: () => { ctxHideOpen = !ctxHideOpen; renderDesktopMenu(); },
    }, h('span', { text: t('Hide apps') }), h('span', { class: 'ctx-mark', text: ctxHideOpen ? '▾' : '▸' }));
    const sub = ctxHideOpen ? hideables.map((app) => h('button', {
      class: 'ctx-item ctx-sub', type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(hidden.includes(app.id)),
      onclick: () => toggleHidden(app.id),
    }, h('span', { text: t(app.label) }), h('span', { class: 'ctx-mark', text: hidden.includes(app.id) ? '✓' : '' }))) : [];
    ctxEl.replaceChildren(
      item(t('Open Folder'), () => toggleApp('folder')),
      item(t('Open Settings'), () => toggleApp('settings')),
      h('span', { class: 'ctx-sep', 'aria-hidden': 'true' }),
      item(t('Change wallpaper'), () => goSettings(SETTINGS_INDEX.find((e) => e.id === 'wallpaper'))),
      item(t('Icon size'), () => goSettings(SETTINGS_INDEX.find((e) => e.id === 'icons'))),
      item(t(editLayout ? 'Done editing' : 'Edit layout'), () => setEditLayout(!editLayout)),
      h('span', { class: 'ctx-sep', 'aria-hidden': 'true' }),
      hideRow,
      ...sub,
      item(t('Show all apps'), () => { setHiddenApps([]); renderIcons(); }, hidden.length === 0),
      h('span', { class: 'ctx-sep', 'aria-hidden': 'true' }),
      item(t('Lock screen'), () => lockNow()),
    );
  }

  function openDesktopMenu(x, y) {
    if (!ctxEl) {
      ctxEl = document.createElement('div');
      ctxEl.className = 'ctx-menu';
      ctxEl.setAttribute('role', 'menu');
      ctxEl.setAttribute('aria-label', t('Desktop'));
      ctxEl.hidden = true;
      document.body.append(ctxEl);
    }
    ctxHideOpen = false;
    renderDesktopMenu();
    ctxEl.hidden = false;
    const w = ctxEl.offsetWidth;
    const hgt = ctxEl.offsetHeight;
    ctxEl.style.left = `${clamp(x, 6, window.innerWidth - w - 6)}px`;
    ctxEl.style.top = `${clamp(y, 6, window.innerHeight - hgt - 6)}px`;
  }

  $('desktop').addEventListener('contextmenu', (event) => {
    if (event.target.closest('.icon, .widget, .window, .taskbar, .start-menu, .snap-pop, .ctx-menu, .lock, input, textarea, select')) return;
    event.preventDefault();
    openDesktopMenu(event.clientX, event.clientY);
  });
  document.addEventListener('pointerdown', (event) => {
    if (ctxEl && !ctxEl.hidden && !event.target.closest('.ctx-menu')) closeDesktopMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDesktopMenu();
  });
  window.addEventListener('resize', closeDesktopMenu);

  // ---------- taskbar name tooltips (shown at once on hover) ----------

  let tipEl = null;
  let tipTimer = null;

  function tipNode() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'tb-tip';
      tipEl.setAttribute('role', 'tooltip');
      tipEl.hidden = true;
      document.body.append(tipEl);
    }
    return tipEl;
  }

  function showTip(node, text) {
    const tip = tipNode();
    tip.textContent = text;
    tip._for = node;
    const r = node.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top - 10}px`;
    tip.hidden = false;
  }

  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) tipEl.hidden = true;
  }

  // The text is kept on the node so it can change later (the status pills show the current state).
  function setTip(node, text) {
    node._tipText = text;
    node.setAttribute('aria-label', text);
    if (tipEl && !tipEl.hidden && tipEl._for === node) tipEl.textContent = text;
  }

  // Shown at once when the pointer arrives; the text is read when shown, so it follows the node's state.
  function bindTip(node, text) {
    setTip(node, text);
    node.addEventListener('pointerenter', () => showTip(node, node._tipText));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('pointerdown', hideTip);
  }

  // ---------- widgets: on the grid, scaled up from the icons; sized 1x1, 1x2, 2x1 or 2x2 ----------
  // A widget spans 1 or 2 widget cells each way (columns x rows). Moves and resizes snap to the grid, and a
  // widget never lands on another one. It can reach any edge of the desktop.
  const WIDGET_LAYOUT_KEY = 'fishingbot-desktop:widgets:v6';
  const WIDGET_LAYOUT_OLD = 'fishingbot-desktop:widgets:v3';
  // Widgets are placed and sized in single cells: a step is half of the old two-cell step.
  const WIDGET_FACTOR = 1;
  const WIDGET_MIN = { cols: 4, rows: 2 };
  // The Widgets setting: the cell size of the widget grid. Compact is the default, a small widget that stays out of the way.
  const WIDGET_CELL = { compact: 4 * GRID_UNIT, normal: 5 * GRID_UNIT, large: 6 * GRID_UNIT };
  function widgetCellPx() {
    const classes = document.body.classList;
    return WIDGET_CELL[classes.contains('widget-size-large') ? 'large' : classes.contains('widget-size-normal') ? 'normal' : 'compact'];
  }

  // Size of a widget in cells: the last size it was drawn at, or its default.
  function sizeOf(node) {
    return node._size || { cols: Number(node.dataset.cols) || WIDGET_MIN.cols, rows: Number(node.dataset.rows) || WIDGET_MIN.rows };
  }

  // The smallest size of a widget: its box is at least 80% of the design, so its text stays readable at every
  // icon size. The default sizes already meet this, so they do not grow.
  function widgetMin() {
    return { cols: WIDGET_MIN.cols, rows: WIDGET_MIN.rows };
  }

  // A saved span if it is usable, otherwise the fallback, never below the minimum.
  function pickSpan(value, fallback, min) {
    const v = Number(value);
    if (Number.isFinite(v) && v >= min && v <= 60) return Math.round(v);
    return Math.max(min, Math.round(Number(fallback)) || min);
  }
  let editLayout = false;

  function widgetNodes() {
    return Array.from(document.querySelectorAll('.widgets > .widget[data-widget], .widgets > .widget-group'));
  }

  // The saved layout. An older save (v3, cells from the top left) is read when there is no v4 save yet.
  function loadWidgetLayout() {
    for (const key of [WIDGET_LAYOUT_KEY]) {
      try {
        const map = JSON.parse(localStorage.getItem(key));
        if (map && typeof map === 'object') return map;
      } catch {
        /* unreadable: the next key, or the defaults */
      }
    }
    return {};
  }

  function saveWidgetPositions() {
    const map = {};
    for (const node of widgetNodes()) {
      const i = node._intent || node._item;
      if (i) {
        map[node.dataset.widget] = { ax: i.ax, ay: i.ay, col: i.col, row: i.row, cols: i.cols, rows: i.rows };
        const b = node._base;
        if (b) map[node.dataset.widget].base = { ax: b.ax, ay: b.ay, col: b.col, row: b.row, cols: b.cols, rows: b.rows };
      }
    }
    try {
      localStorage.setItem(WIDGET_LAYOUT_KEY, JSON.stringify(map));
    } catch {
      /* not saved: the widgets return to the default place next start */
    }
  }

  function spanOk(value) {
    return value === 1 || value === 2;
  }

  // The item a saved entry describes, or the node's own default size.
  function widgetItem(entry, node) {
    const cols = pickSpan(entry && entry.cols, node.dataset.cols, widgetMin(node).cols);
    const rows = pickSpan(entry && entry.rows, node.dataset.rows, widgetMin(node).rows);
    return {
      ax: entry && entry.ax === 'r' ? 'r' : 'l',
      ay: entry && entry.ay === 'b' ? 'b' : 't',
      col: entry && Number.isFinite(entry.col) ? entry.col : 0,
      row: entry && Number.isFinite(entry.row) ? entry.row : 0,
      cols,
      rows,
    };
  }

  // Every widget except the clock is drawn at one scale, so text and controls keep the same size in each
  // widget. The scale follows the icon size: a smaller grid shrinks all widgets together.
  // Design width of a widget at scale 1: four medium cells (4 x 96 px minus the gap). The same design is used for
  // every icon size, so a widget's text keeps its size when the icons change and the cells get smaller.
  const WIDGET_BASE_W = 4 * 5 * GRID_UNIT - 8;   // the Normal size: 4 cells of 80 px
  // Content scale for a widget: its design width and height must both fit the box, so the content grows and
  // shrinks with the box in both directions. Clamped so the text stays readable.
  // The Text size setting (85% to 125%) is the most a widget may scale. A widget grows past its design only
  // when its box has the room, so the text never runs out of its box.
  function textScaleValue() {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-scale'));
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  function widgetScale(node, item) {
    const box = boxOf(widgetGrid(), item.cols, item.rows);
    const baseH = Number(node.dataset.baseH) || 300;
    const fit = Math.min(box.w / WIDGET_BASE_W, box.h / baseH);
    const text = textScaleValue();
    return clamp(Math.min(fit, text), 0.6, text);
  }

  function placeWidget(node, item) {
    node._item = item;
    const r = rectOf(widgetGrid(), item);
    // The box is placed and sized exactly on the grid. Its content is drawn at the widget scale from the
    // box's top-left corner, so the content scales and the box never moves off the grid.
    const s = node.dataset.widget === 'clock' ? 1 : widgetScale(node, item);
    node._size = { cols: item.cols, rows: item.rows };
    node.style.transformOrigin = '0 0';
    node.style.transform = s === 1 ? '' : `scale(${s})`;
    node.style.left = `${r.x}px`;
    node.style.top = `${r.y}px`;
    node.style.width = `${r.w / s}px`;
    node.style.height = `${r.h / s}px`;
  }

  // Each widget goes to its saved place, or to its default: the clock centred at the top, the others down the
  // right-hand edge. Any widget whose place is taken moves to the nearest free place.
  function placeWidgets() {
    const grid = widgetGrid();
    const saved = loadWidgetLayout();
    for (const node of widgetNodes()) node._item = null;
    let row = 0;
    for (const node of widgetNodes()) {
      const s = saved[node.dataset.widget];
      let want;
      if (s && Number.isFinite(s.col) && Number.isFinite(s.row)) {
        want = widgetItem(s, node);
      } else if (node.dataset.anchor === 'centre') {
        const base = widgetItem(null, node);
        const limits = limitsOf(grid, base.cols, base.rows);
        want = { ...base, ax: 'l', ay: 't', col: Math.floor(limits.maxCol / 2), row: 0 };
      } else {
        const base = widgetItem(null, node);
        want = { ...base, ax: 'r', ay: 't', col: 0, row };
        row += base.rows;
      }
      node._intent = want;
      node._base = s && s.base ? widgetItem(s.base, node) : null;
      const others = widgetNodes().filter((n) => n !== node && n._item).map((n) => n._item);
      placeWidget(node, freeItem(grid, want, others));
    }
    fitClock();
  }

  // True when a point is over text or a control. A press there is not a move: the text stays selectable.
  function pointOverText(node, x, y) {
    const inside = (r) => x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3;
    const range = document.createRange();
    for (const el of node.querySelectorAll('h2,p,dt,dd,span,strong,pre,label,button,a,input,select,textarea')) {
      if (el.classList.contains('w-grip') || el.classList.contains('dot')) continue;
      if (el.matches('button,a,input,select,textarea')) {
        if (inside(el.getBoundingClientRect())) return true;
        continue;
      }
      if (!el.textContent.trim()) continue;
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) if (inside(r)) return true;
    }
    return false;
  }

  function settleWidget(node) {
    const grid = widgetGrid();
    const want = clampItem(grid, node._item);
    const others = widgetNodes().filter((n) => n !== node && n._item);
    // The place the user chose is the widget's intent. What is drawn can differ while others are in the way.
    node._intent = want;
    node._base = null;
    const wantRect = rectOf(grid, want);
    const blocked = others.some((n) => overlapsRect(rectOf(grid, n._item), wantRect));
    if (blocked && fitBySharing(node, want, others)) {
      placeWidget(node, want);
    } else {
      placeWidget(node, freeItem(grid, want, others.map((n) => n._item)));
    }
    restoreShrunk();
    saveWidgetPositions();
  }

  // Height of a widget's content in its own unscaled pixels: the children, their gaps and the padding.
  function contentHeight(node) {
    const cs = getComputedStyle(node);
    const kids = Array.from(node.children).filter((c) => !c.hidden);
    const gaps = Math.max(0, kids.length - 1) * (parseFloat(cs.rowGap) || 0);
    const kidsH = kids.reduce((sum, c) => sum + c.offsetHeight, 0);
    return kidsH + gaps + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  }

  // Dropping a widget into a gap: when exactly one widget is in the way, and its content still fits with one
  // row less, that widget gives up a row and the dropped widget takes the space. Nothing else moves.
  function fitBySharing(node, want, others) {
    const grid = widgetGrid();
    const wantRect = rectOf(grid, want);
    const hit = others.filter((n) => overlapsRect(rectOf(grid, n._item), wantRect));
    if (hit.length !== 1) return false;
    const w = hit[0];
    const cur = w._item;
    if (w.dataset.widget === 'clock' || w.classList.contains('widget-group') || cur.rows - 1 < widgetMin(w).rows) return false;
    const removed = grid.P / widgetScale(w, cur); // unscaled height of one cell, a half step
    if (w.clientHeight - contentHeight(w) < removed) return false;
    const rest = others.filter((n) => n !== w).map((n) => n._item);
    const variants = [
      { ...cur, rows: cur.rows - 1 },
      { ...cur, rows: cur.rows - 1, row: cur.row + 1 },
    ];
    for (const v of variants) {
      const vr = rectOf(grid, v);
      if (overlapsRect(vr, wantRect) || rest.some((o) => overlapsRect(rectOf(grid, o), vr))) continue;
      if (!w._base) w._base = { ...cur };
      w._intent = v;
      placeWidget(w, v);
      return true;
    }
    return false;
  }

  // A shrunk widget returns to its full size once nothing is in its place any more.
  function restoreShrunk() {
    const grid = widgetGrid();
    const nodes = widgetNodes();
    for (const w of nodes) {
      if (!w._base) continue;
      const base = w._base;
      const br = rectOf(grid, base);
      const clear = nodes.every((n) => n === w || !n._item || !overlapsRect(rectOf(grid, n._item), br));
      if (clear) {
        w._intent = base;
        w._base = null;
        placeWidget(w, base);
      }
    }
  }

  function startWidgetDrag(node, event, mode) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const r0 = rectOf(widgetGrid(), node._item);
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: r0.x,
      top: r0.y,
      w: r0.w,
      h: r0.h,
      item: { ...node._item },
    };
    node.classList.add('moving');
    const grid = widgetGrid();
    const box11 = boxOf(grid, 1, 1);
    const move = (e) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (mode === 'move') {
        // The widget moves to the grid place nearest its own corner.
        placeWidget(node, fitItemFromPixels(grid, start.left + dx, start.top + dy, start.item.cols, start.item.rows));
        showGuides(node);
        return;
      }
      // Resize keeps the top-left corner. Each edge snaps to one widget cell or two.
      // Half steps: one cell at a time, never below the minimum.
      const cols = Math.max(widgetMin(node).cols, Math.round((start.w + dx + grid.G) / grid.P));
      const rows = Math.max(widgetMin(node).rows, Math.round((start.h + dy + grid.G) / grid.P));
      placeWidget(node, fitItemFromPixels(grid, start.left, start.top, cols, rows));
    };
    const done = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', done);
      handle.removeEventListener('pointercancel', done);
      node.classList.remove('moving');
      clearGuides();
      if (!(mode === 'move' && joinAt(node))) settleWidget(node);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done);
    handle.addEventListener('pointercancel', done);
  }

  // In edit mode a widget moves by pressing anywhere on it that has no text or control; the corner grip resizes.
  function wireWidget(node) {
    const grip = node.querySelector('.w-grip');
    node.addEventListener('pointerdown', (event) => {
      if (!editLayout || event.button !== 0 || event.target.closest('.w-grip')) return;
      // A member of a group moves with the group, never on its own.
      if (node.parentElement && node.parentElement.classList.contains('widget-group')) return;
      if (pointOverText(node, event.clientX, event.clientY)) return;
      startWidgetDrag(node, event, 'move');
    });
    grip.addEventListener('pointerdown', (event) => { if (editLayout && !node.classList.contains('widget-group')) startWidgetDrag(node, event, 'resize'); });
    if (node.dataset.widget === 'clock' && window.ResizeObserver) new ResizeObserver(() => fitClock()).observe(node);
  }

  function setEditLayout(on) {
    editLayout = on;
    document.body.classList.toggle('edit-layout', on);
    $('edit-done').hidden = !on;
    renderStartMenu();
  }

  // ---------- sign-in ----------

  function showLock(mode, text = '') {
    lockMode = mode;
    document.body.classList.add('is-locked');
    $('lock').hidden = false;
    $('windows').hidden = true;
    const setup = mode === 'setup';
    $('lock-title').textContent = setup ? t('Create the admin password') : mode === 'offline' ? t('Waiting for the server') : t('Sign in');
    $('lock-text').textContent = text || (setup
      ? t('Pick a password of at least 12 characters. It unlocks every app on this PC.')
      : t('Enter password'));
    $('lock-confirm-label').hidden = !setup;
    $('lock-confirm').required = setup;
    $('lock-form').hidden = mode === 'offline';
    toggleStart(false);
    $('lock-submit').textContent = setup ? t('Create and sign in') : t('Sign in');
    $('lock-error').textContent = '';
    if (mode !== 'offline') $('lock-password').focus();
  }

  function hideLock() {
    document.body.classList.remove('is-locked');
    $('lock').hidden = true;
    $('windows').hidden = false;
  }

  // Reads the sign-in state and shows the right screen, or unlocks.
  // Only a running server asks for sign-in. A stopped server leaves every app usable.
  async function checkLock() {
    const st = await api.authState();
    if (!st.ok || !st.online) {
      hideLock();
      setOffline(true);
      releaseBoot();
      return;
    }
    setOffline(false);
    if (st.authenticated) {
      unlocked();
      return;
    }
    showLock(st.setupRequired ? 'setup' : 'login');
  }

  function releaseBoot() {
    if (unlockResolve) {
      const resolve = unlockResolve;
      unlockResolve = null;
      resolve();
    }
  }

  function unlocked(reloadAll = false) {
    hideLock();
    placeWidgets();
    releaseBoot();
    if (reloadAll) reloadWeb();
    reloadStale();
  }

  // Shows the stopped-server notice; windows keep what they show and are reloaded once the server is back.
  function setOffline(flag) {
    if (flag) {
      for (const rec of windows.values()) {
        if (rec.body._placeholder) setPlaceholder(rec.body, false);
        if (rec.body._webview) rec.body._stale = true;
      }
    }
  }

  function reloadStale() {
    for (const rec of windows.values()) {
      if (rec.body._webview && rec.body._stale) {
        rec.body._stale = false;
        reloadView(rec.body);
      }
    }
  }

  function waitForSignIn() {
    return new Promise((resolve) => {
      unlockResolve = resolve;
      checkLock();
    });
  }

  async function lockDesktop() {
    await api.authLock();
    await checkLock();
  }

  // ---------- security: lock after idle, lock with Windows, Lock now ----------
  let security = { autoLockMinutes: 0, lockOnWindowsLock: true };
  let idleTimer = null;

  function lockNow() {
    if (document.body.classList.contains('is-locked') || !server.online) return;
    lockDesktop().catch(() => {});
  }

  function armIdleLock() {
    clearTimeout(idleTimer);
    if (!security.autoLockMinutes) return;
    idleTimer = setTimeout(lockNow, security.autoLockMinutes * 60000);
  }
  // Any mouse or keyboard use restarts the idle count.
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((name) => {
    document.addEventListener(name, armIdleLock, { passive: true, capture: true });
  });
  document.addEventListener('fishingbot:security', (event) => {
    security = { ...security, ...(event.detail || {}) };
    armIdleLock();
  });
  document.addEventListener('fishingbot:lock-now', lockNow);
  api.onWindowsLocked(() => {
    if (security.lockOnWindowsLock) lockNow();
  });

  // Update steps (see checkForUpdates in main.js). One card, updated in place as the update moves on.
  function updateToast(s) {
    switch (s.state) {
      case 'checking': return { text: t('Checking for updates…'), kind: 'info', sticky: true };
      case 'upToDate': return { text: t('Fishingbot Desktop {v} is up to date.', { v: s.current }), kind: 'ok' };
      case 'downloading': return {
        text: s.percent == null ? t('Downloading Fishingbot {v}…', { v: s.latest }) : t('Downloading Fishingbot {v}… {p}%', { v: s.latest, p: s.percent }),
        kind: 'info', progress: s.percent, sticky: true,
      };
      case 'verifying': return { text: t('Checking the installer…'), kind: 'info', progress: 100, sticky: true };
      case 'installing': return { text: t('Closing to install {v}. The installer opens next.', { v: s.latest }), kind: 'ok', sticky: true };
      case 'error': return { text: t('Update failed: {m}', { m: s.message }), kind: 'bad', ms: 9000 };
      default: return null;
    }
  }
  api.onUpdateStatus((status) => {
    const u = updateToast(status || {});
    if (u) toast(u.text, u.kind, { key: 'update', title: t('Update'), progress: u.progress, sticky: u.sticky, ms: u.ms });
  });
  // After an update has installed: confirm it once, on the first start of the new version.
  setTimeout(() => {
    api.takeUpdateNotice().then((r) => {
      if (r && r.ok && r.notice) toast(t('Fishingbot was updated to {v}.', { v: r.notice.version }), 'ok', { title: t('Update'), ms: 6000 });
    }).catch(() => {});
  }, 1200);

  function reloadWeb() {
    for (const rec of windows.values()) {
      if (rec.body._webview) reloadView(rec.body);
    }
  }

  // ---------- windows ----------

  // Smallest size a window can be. Control Centre pages need more room for their tables and cards.
  function minSizeOf(app) {
    return app && app.kind === 'web' ? { w: 520, h: 360 } : { w: 420, h: 300 };
  }

  function openApp(appId, layout) {
    const existing = windows.get(appId);
    if (existing) {
      if (existing.minimized) setMinimized(existing, false);
      focusWin(existing);
      return existing;
    }
    const app = findApp(appId);
    if (!app) return null;
    if (app.kind === 'web' && (app.tab === 'loot' || app.tab === 'game') && !server.online) {
      api.openOfflineWindow(app.tab);
      return null;
    }

    const el = document.createElement('section');
    el.className = 'window';
    const limit = minSizeOf(app);
    el.style.minWidth = `${limit.w}px`;
    el.style.minHeight = `${limit.h}px`;
    el.innerHTML =
      '<header class="win-head"><div class="win-left"><span class="win-title"></span>' +
      '<button class="win-btn win-refresh" type="button" data-act="refresh" aria-label="Refresh" title="Refresh">' +
      '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M12 7a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '<path d="M11.2 1.8v2.6H8.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>' +
      '<div class="win-btns">' +
      '<button class="win-btn snap" type="button" data-act="snap" aria-label="Snap layout" title="Snap layout">' +
      '<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><rect x="1" y="1" width="5.5" height="5.5" rx="1.2"/>' +
      '<rect x="7.5" y="1" width="5.5" height="5.5" rx="1.2"/><rect x="1" y="7.5" width="5.5" height="5.5" rx="1.2"/>' +
      '<rect x="7.5" y="7.5" width="5.5" height="5.5" rx="1.2"/></svg></button>' +
      '<button class="win-btn" type="button" data-act="min" aria-label="Minimize">&#8211;</button>' +
      '<button class="win-btn" type="button" data-act="max" aria-label="Maximize">&#9633;</button>' +
      '<button class="win-btn close" type="button" data-act="close" aria-label="Close">&#215;</button>' +
      '</div></header><div class="win-body"></div><div class="win-grip" aria-hidden="true"></div>';
    el.querySelector('.win-title').textContent = app.label;
    el.querySelector('.win-refresh').title = t('Refresh');
    el.querySelector('.win-refresh').setAttribute('aria-label', t('Refresh'));
    el.querySelector('.win-refresh').addEventListener('click', (event) => {
      event.stopPropagation();
      refreshApp(appId);
    });
    const body = el.querySelector('.win-body');

    if (app.kind === 'web') mountWeb(body, app.tab, `${serverBase()}/local`, 'persist:controlcentre');
    else if (app.kind === 'url') mountWeb(body, null, app.url, 'persist:web');
    else if (appId === 'settings') Apps.settings(body, api);
    else if (appId === 'log') Apps.log(body, logStore());
    else if (appId === 'folder') Apps.folder(body, api);

    // Settings and Folder use their permanent taskbar buttons; every other app adds one.
    const permanent = PERMANENT_BUTTONS[appId];
    let tb;
    if (permanent) {
      tb = $(permanent);
    } else {
      tb = document.createElement('button');
      tb.type = 'button';
      tb.className = 'tb-app';
      tb.innerHTML = iconSvg(app.icon, 20);
      bindTip(tb, app.label);
      $('tb-apps').append(tb);
    }

    $('windows').append(el);
    el.classList.add('opening');
    setTimeout(() => el.classList.remove('opening'), 420);
    if (I18n) I18n.apply(el, { fresh: true });
    const rec = { id: appId, app, el, tb, body, minimized: false, maximized: false, rest: null, permanent: !!permanent };
    windows.set(appId, rec);
    wireWindow(rec);
    if (!permanent) {
      tb.addEventListener('click', () => {
        if (rec.minimized) setMinimized(rec, false);
        else if (focusedId === rec.id) setMinimized(rec, true);
        else focusWin(rec);
      });
    }

    placeWindow(rec, layout);
    if (!rec.minimized) focusWin(rec);
    saveLayout();
    return rec;
  }

  // The space an app window may use: the desktop down to the top of the taskbar. The taskbar is the
  // limit, so no window is placed, moved, resized or maximised over it. (When the taskbar hides, the
  // whole desktop is free.)
  function workArea() {
    const box = $('windows').getBoundingClientRect();
    let height = box.height;
    const bar = document.querySelector('.taskbar');
    if (bar && bar.getClientRects().length) height = Math.min(height, bar.getBoundingClientRect().top - box.top);
    return { width: box.width, height: Math.max(240, height) };
  }

  // A maximised window fills the work area: the taskbar stays visible.
  function fitMax(rec) {
    const area = workArea();
    Object.assign(rec.el.style, { left: '0px', top: '0px', width: `${area.width}px`, height: `${area.height}px` });
  }

  // Keeps every window inside the work area when the window, the taskbar or the icon size changes.
  function keepInArea() {
    const area = workArea();
    for (const rec of windows.values()) {
      if (rec.minimized) continue;
      if (rec.maximized) {
        fitMax(rec);
        continue;
      }
      const w = Math.min(rec.el.offsetWidth, area.width);
      const h = Math.min(rec.el.offsetHeight, area.height);
      Object.assign(rec.el.style, {
        width: `${w}px`,
        height: `${h}px`,
        left: `${clamp(rec.el.offsetLeft, 0, Math.max(0, area.width - w))}px`,
        top: `${clamp(rec.el.offsetTop, 0, Math.max(0, area.height - h))}px`,
      });
    }
  }

  function placeWindow(rec, saved) {
    const area = workArea();
    const w = clamp(saved?.w ?? 900, 360, Math.max(360, area.width));
    const h = clamp(saved?.h ?? 580, 240, Math.max(240, area.height));
    const offset = ((windows.size - 1) * 32) % 240;
    const x = clamp(saved?.x ?? 300 + offset, 0, Math.max(0, area.width - 120));
    const y = clamp(saved?.y ?? 40 + offset, 0, Math.max(0, area.height - h));
    rec.el.style.left = `${x}px`;
    rec.el.style.top = `${y}px`;
    rec.el.style.width = `${w}px`;
    rec.el.style.height = `${h}px`;
    if (saved?.max) toggleMax(rec, true);
    if (saved?.min) setMinimized(rec, true);
  }

  // The Settings button next to the menu is lit while the Settings window is in front.
  function syncSettingsButton() {
    for (const [appId, id] of Object.entries(PERMANENT_BUTTONS)) {
      const button = $(id);
      if (button) button.classList.toggle('active', focusedId === appId && windows.has(appId));
    }
  }

  // The click of a taskbar button: open, restore, minimise or bring to the front.
  function toggleApp(appId) {
    const rec = windows.get(appId);
    if (!rec) {
      openApp(appId);
      return;
    }
    if (rec.minimized) setMinimized(rec, false);
    else if (focusedId === rec.id) setMinimized(rec, true);
    else focusWin(rec);
  }

  function focusWin(rec) {
    if (rec.minimized) return;
    // Each blurred window re-blurs the wallpaper behind it every frame; with several open that is the main load.
    // From four open windows, only the focused window keeps its blur.
    document.body.classList.toggle('lite-glass', windows.size >= 4);
    queueMicrotask(syncSettingsButton);
    zTop += 1;
    rec.el.style.zIndex = String(zTop);
    focusedId = rec.id;
    for (const other of windows.values()) {
      other.tb.classList.toggle('active', other === rec && !other.minimized);
      other.el.classList.toggle('unfocused', other !== rec);
      if (other.app.kind !== 'web' || !other.body._webview) continue;
      if (other === rec) {
        clearTimeout(other._pauseTimer);
        resumeWeb(other.body);
      } else if (!other.minimized) {
        scheduleWebPause(other, UNFOCUSED_PAUSE_MS);
      }
    }
  }

  // A minimised Control Centre page is paused after a while. It is replaced by a blank page, so its timers and
  // server polling stop, and it is loaded again when the window is restored. A page with unsaved edits
  // (an element marked is-dirty or savebar.is-dirty) stays loaded and is checked again later.
  const WEB_PAUSE_AFTER_MS = 20000;
  // A visible window that is not in front is paused after this long. It keeps its last picture (a snapshot),
  // which a click on it replaces with the live page again.
  const UNFOCUSED_PAUSE_MS = 60000;
  function scheduleWebPause(rec, delay = WEB_PAUSE_AFTER_MS) {
    clearTimeout(rec._pauseTimer);
    rec._pauseTimer = setTimeout(() => pauseWeb(rec), delay);
  }
  async function pauseWeb(rec) {
    const body = rec.body;
    if (body._paused || !body._webview || !body._tab || focusedId === rec.id) return;
    let dirty = true;
    try {
      dirty = await body._webview.executeJavaScript(
        "!!document.querySelector('.is-dirty, .savebar.is-dirty')", true);
    } catch {
      dirty = true;
    }
    if (dirty) {
      scheduleWebPause(rec);
      return;
    }
    // A visible window keeps its picture: the snapshot is taken first, so it looks the same while paused.
    let snapshot = null;
    if (!rec.minimized) {
      if (focusedId === rec.id) return;
      try {
        snapshot = (await body._webview.capturePage()).toDataURL();
      } catch {
        snapshot = null;
      }
      if (!snapshot || focusedId === rec.id) return;
    }
    if (!rec.minimized && focusedId === rec.id) return;
    body._paused = true;
    if (snapshot) showSnapshot(body, snapshot);
    body._webview.src = 'about:blank';
  }
  function showSnapshot(body, url) {
    const frame = body._webview.parentElement;
    body._snapshot?.remove();
    const img = document.createElement('img');
    img.className = 'web-snapshot';
    img.alt = '';
    img.src = url;
    const note = document.createElement('div');
    note.className = 'web-snapshot-note';
    note.textContent = t('Paused to save CPU. Click to resume.');
    const wrap = document.createElement('div');
    wrap.className = 'web-snapshot-wrap';
    wrap.append(img, note);
    wrap.addEventListener('click', () => {
      const rec = [...windows.values()].find((r) => r.body === body);
      if (rec) focusWin(rec);
    });
    frame.append(wrap);
    body._snapshot = wrap;
  }
  function resumeWeb(body) {
    if (!body._paused || !body._webview) return;
    body._paused = false;
    body._loaded = false;
    body._shellSeen = false;
    body._snapshot?.remove();
    body._snapshot = null;
    setLoading(body, true);
    body._webview.src = body._url;
  }

  function setMinimized(rec, flag) {
    queueMicrotask(syncSettingsButton);
    rec.minimized = flag;
    clearTimeout(rec._minTimer);
    if (rec.app.kind === 'web' && rec.body._webview) {
      if (flag) scheduleWebPause(rec);
      else clearTimeout(rec._pauseTimer);
    }
    if (flag) {
      // The window shrinks away first; it is hidden once the motion has played.
      rec.el.classList.remove('restoring');
      rec.el.classList.add('minimizing');
      rec._minTimer = setTimeout(() => {
        rec.el.classList.remove('minimizing');
        rec.el.classList.add('hidden');
      }, 170);
    } else {
      rec.el.classList.remove('hidden', 'minimizing');
      rec.el.classList.add('restoring');
      rec._minTimer = setTimeout(() => rec.el.classList.remove('restoring'), 260);
    }
    rec.tb.classList.toggle('minimized', flag);
    if (flag) {
      if (focusedId === rec.id) focusedId = null;
      rec.tb.classList.remove('active');
    } else {
      focusWin(rec);
    }
    saveLayout();
  }

  // Runs a change to a window's place or size with an ease, so a snap or a maximise glides.
  // The window changes at once, then is drawn back from its old rectangle with a transform that eases to
  // none. The browser animates a transform without laying the page out again on each frame; animating
  // left, top, width and height did that, which made maximise and snap lag.
  function animate(rec, change) {
    const el = rec.el;
    const from = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    change();
    const to = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    if (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return;
    el.style.transition = 'none';
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.w / to.w}, ${from.h / to.h})`;
    void el.offsetWidth;
    el.style.transition = '';
    el.classList.add('snapping');
    el.style.transform = '';
    clearTimeout(rec._snapTimer);
    rec._snapTimer = setTimeout(() => {
      el.classList.remove('snapping');
      el.style.transformOrigin = '';
    }, 200);
  }

  function toggleMax(rec, force) {
    const next = force === undefined ? !rec.maximized : force;
    if (next === rec.maximized) return;
    animate(rec, () => applyMax(rec, next));
    focusWin(rec);
    saveLayout();
  }

  function applyMax(rec, next) {
    rec.maximized = next;
    if (next) {
      if (!rec.snapped) rec.rest = windowRect(rec);
      rec.snapped = false;
      rec.el.classList.add('max');
      fitMax(rec);
    } else {
      rec.el.classList.remove('max');
      if (rec.rest) {
        Object.assign(rec.el.style, {
          left: `${rec.rest.x}px`,
          top: `${rec.rest.y}px`,
          width: `${rec.rest.w}px`,
          height: `${rec.rest.h}px`,
        });
      }
    }
  }

  function windowRect(rec) {
    if (rec.maximized && rec.rest) return rec.rest;
    const s = rec.el.style;
    return {
      x: parseFloat(s.left) || 0,
      y: parseFloat(s.top) || 0,
      w: parseFloat(s.width) || 900,
      h: parseFloat(s.height) || 580,
    };
  }

  function closeWin(rec) {
    queueMicrotask(syncSettingsButton);
    if (rec.body._cleanup) rec.body._cleanup();
    // The window fades out, then its parts are removed. It is forgotten at once, so it can be reopened.
    clearTimeout(rec._pauseTimer);
    windows.delete(rec.id);
    urlApps.delete(rec.id);
    document.body.classList.toggle('lite-glass', windows.size >= 4);
    if (focusedId === rec.id) focusedId = null;
    rec.el.classList.add('closing');
    if (rec.permanent) {
      rec.tb.classList.remove('active', 'minimized');
      setTimeout(() => rec.el.remove(), 170);
    } else {
      rec.tb.classList.add('leaving');
      setTimeout(() => {
        rec.el.remove();
        rec.tb.remove();
      }, 170);
    }
    saveLayout();
  }

  function wireWindow(rec) {
    const head = rec.el.querySelector('.win-head');
    const grip = rec.el.querySelector('.win-grip');

    rec.el.addEventListener('pointerdown', () => {
      if (!rec.minimized && focusedId !== rec.id) focusWin(rec);
    });

    head.addEventListener('pointerdown', (event) => {
      // Any button in the bar (the window buttons and the refresh button) is a click, not a drag.
      if (event.target.closest('button')) return;
      head.setPointerCapture(event.pointerId);
      if (rec.maximized || rec.snapped) releaseFromLayout(rec, event);
      const start = { x: event.clientX, y: event.clientY, left: rec.el.offsetLeft, top: rec.el.offsetTop };
      // The area and the limits are read once, not on every pointer move (each read forces a layout).
      const area = workArea();
      const bounds = {
        minX: -rec.el.offsetWidth + 120,
        maxX: area.width - 120,
        minY: 0,
        maxY: Math.max(0, area.height - rec.el.offsetHeight),
      };
      const pos = { left: start.left, top: start.top };
      let zone = null;
      let shownZone = null;
      rec.el.classList.add('dragging');
      const move = (e) => {
        pos.left = clamp(start.left + e.clientX - start.x, bounds.minX, bounds.maxX);
        pos.top = clamp(start.top + e.clientY - start.y, bounds.minY, bounds.maxY);
        // Only a transform while the window is dragged: the browser moves it without a layout pass.
        rec.el.style.transform = `translate(${pos.left - start.left}px, ${pos.top - start.top}px)`;
        zone = zoneAt(e.clientX, e.clientY);
        if (zone !== shownZone) {
          shownZone = zone;
          showSnapPreview(zone);
        }
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        // Without this the transform clears through its transition: the window slid back, then forward again.
        rec.el.style.transition = 'none';
        rec.el.classList.remove('dragging');
        rec.el.style.transform = '';
        rec.el.style.left = `${pos.left}px`;
        rec.el.style.top = `${pos.top}px`;
        void rec.el.offsetWidth;
        rec.el.style.transition = '';
        showSnapPreview(null);
        if (zone) {
          animate(rec, () => snapTo(rec, zone));
          focusWin(rec);
        }
        saveLayout();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    head.addEventListener('dblclick', (event) => {
      if (!event.target.closest('.win-btns')) toggleMax(rec);
    });

    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      const start = { x: event.clientX, y: event.clientY, w: rec.el.offsetWidth, h: rec.el.offsetHeight };
      // Limits are read once, as the header drag does: each read forces a layout.
      const area = workArea();
      const min = minSizeOf(rec.app);
      const maxW = Math.max(min.w, area.width - rec.el.offsetLeft);
      const maxH = Math.max(min.h, area.height - rec.el.offsetTop);
      let latest = null;
      let frame = 0;
      // One size change per frame, however fast the pointer moves.
      const apply = () => {
        frame = 0;
        if (!latest) return;
        rec.el.style.width = `${Math.min(Math.max(min.w, start.w + latest.x - start.x), maxW)}px`;
        rec.el.style.height = `${Math.min(Math.max(min.h, start.h + latest.y - start.y), maxH)}px`;
      };
      const move = (e) => {
        latest = { x: e.clientX, y: e.clientY };
        if (!frame) frame = requestAnimationFrame(apply);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        if (frame) cancelAnimationFrame(frame);
        apply();
        rec.el.classList.remove('live-change');
        saveLayout();
      };
      // The blur is off while the corner is dragged, as while a window moves (see .window.dragging).
      rec.el.classList.add('live-change');
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });

    rec.el.querySelectorAll('.win-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const act = button.dataset.act;
        if (act === 'snap') openSnapPop(rec, button);
        else if (act === 'min') setMinimized(rec, true);
        else if (act === 'max') toggleMax(rec);
        else if (act === 'close') closeWin(rec);
      });
    });
  }

  // Layout memory: the open apps and their rectangles are restored after sign-in.
  function saveLayout() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const open = [...windows.values()]
        .filter((rec) => rec.app.kind !== 'url')
        .map((rec) => {
          const r = windowRect(rec);
          return { id: rec.id, x: r.x, y: r.y, w: r.w, h: r.h, min: rec.minimized, max: rec.maximized };
        });
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({ open }));
      } catch {
        /* storage unavailable: layout is not kept */
      }
    }, 150);
  }

  function loadLayout() {
    try {
      const data = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
      return Array.isArray(data?.open) ? data.open : [];
    } catch {
      return [];
    }
  }

  // ---------- Control Centre pages (webview) ----------

  // Skeleton loader shaped like a Control Centre page: a header, a row of tiles, a wide card.
  // It covers the page until the right tab is showing, so the page's own "Loading control
  // centre" card and its sign-in card are never seen inside a window.
  function skeletonNode() {
    const node = document.createElement('div');
    node.className = 'web-skeleton';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-label', t('Loading'));
    node.innerHTML =
      '<div class="sk-head"><span class="sk sk-title"></span><span class="sk sk-pill"></span></div>' +
      '<div class="sk-grid">' +
      '<span class="sk sk-card sk-a"></span><span class="sk sk-card sk-b"></span><span class="sk sk-card sk-c"></span>' +
      '<span class="sk sk-card sk-d"></span><span class="sk sk-card sk-e"></span>' +
      '</div>';
    return node;
  }

  // Shows or hides the skeleton. It never shows over the "server stopped" notice.
  function setLoading(body, flag) {
    body._loading = flag;
    syncSkeleton(body);
  }

  function syncSkeleton(body) {
    if (body._skeleton) body._skeleton.hidden = !body._loading || !body._placeholder.hidden;
  }

  function setPlaceholder(body, hidden) {
    body._placeholder.hidden = hidden;
    syncSkeleton(body);
  }

  // Reloads a Control Centre page and covers it with the skeleton until it is ready again.
  function reloadView(body) {
    setLoading(body, true);
    body._webview.reload();
  }

  // The page's own sign-in is replaced by the desktop sign-in. If the session is gone the desktop
  // lock screen shows; if the session is fine (the page loaded a moment too early) the page reloads once.
  async function handleWebLogin(body) {
    if (body._loginBusy) return;
    body._loginBusy = true;
    try {
      const st = await api.authState();
      if (st.ok && st.online && st.authenticated) {
        if ((body._loginReloads || 0) < 2) {
          body._loginReloads = (body._loginReloads || 0) + 1;
          reloadView(body);
        } else {
          // Signed in, yet the page still asks: let the page show its own form rather than loading forever.
          body._loginGiveUp = true;
          setLoading(body, false);
        }
      } else if ($('lock').hidden) {
        await checkLock();
      }
    } finally {
      body._loginBusy = false;
    }
  }

  // Looks at the page now. 'ready': the tab shows its content. 'shell': the page is up, the tab is
  // still filling. 'login': the page asks for its own sign-in. 'pending': the page is still loading.
  function probeScript(tab) {
    return `(() => {
      if (!document.getElementById('fb-desktop-css')) {
        const style = document.createElement('style');
        style.id = 'fb-desktop-css';
        style.textContent = ${JSON.stringify(CC_CSS)};
        document.head.appendChild(style);
      }
      const lock = document.getElementById('fb-lock');
      if (lock) lock.remove();
      const button = document.querySelector(${JSON.stringify(`[data-tab="${tab}"]`)});
      if (!button) return document.getElementById('auth-form') ? 'login' : 'pending';
      if (!button.classList.contains('active')) button.click();
      const view = document.getElementById('view');
      const text = view ? (view.textContent || '').trim() : '';
      return view && view.children.length && !/^Loading/i.test(text) ? 'ready' : 'shell';
    })();`;
  }

  function applyTab(wv, body, tab, probeId, attempt = 0) {
    if (!wv.isConnected || probeId !== body._probeId || body._paused) return;
    const started = body._probeStart || (body._probeStart = Date.now());
    const waited = Date.now() - started;
    const again = (ms) => setTimeout(() => applyTab(wv, body, tab, probeId, attempt + 1), ms);
    wv.executeJavaScript(probeScript(tab), true).then((state) => {
      if (state === 'ready') {
        body._shellSeen = true;
        body._loginReloads = 0;
        body._loginGiveUp = false;
        setLoading(body, false);
        // Keep an eye out for the page asking to sign in again (the session timed out).
        again(4000);
        return;
      }
      if (state === 'login') {
        if (body._loginGiveUp) {
          setLoading(body, false);
          again(4000);
          return;
        }
        setLoading(body, true);
        handleWebLogin(body);
        again(1500);
        return;
      }
      // After a few seconds the skeleton gives way to whatever the page shows, so a page that
      // cannot load shows its own error and Retry button rather than loading forever.
      if (waited > 15000 && !body._shellSeen) setLoading(body, false);
      else if (state === 'shell' && waited > 6000) setLoading(body, false);
      again(attempt < 40 ? 150 : 1000);
    }).catch(() => {
      if (attempt < 600) again(attempt < 40 ? 150 : 1000);
    });
  }

  // Control Centre pages get the desktop's corners, glass and glass dropdowns. The page code itself is unchanged.
  let webAssets = null;
  function pageLookScript(assets) {
    const css = window.FishingbotAppearance ? window.FishingbotAppearance.pageCss() : '';
    return `(() => {
      let look = document.getElementById('fb-desktop-look');
      if (!look) {
        look = document.createElement('style');
        look.id = 'fb-desktop-look';
        document.head.appendChild(look);
      }
      look.textContent = ${JSON.stringify(css)};
      if (!document.getElementById('fb-dropdown-css')) {
        const dd = document.createElement('style');
        dd.id = 'fb-dropdown-css';
        dd.textContent = ${JSON.stringify(assets.dropdownCss)};
        document.head.appendChild(dd);
      }
      if (!window.FishingbotDropdowns) {
        ${assets.dropdownJs}
      }
      window.FishingbotDropdowns.enhanceAll(document);
    })();`;
  }
  async function injectLook(wv, body) {
    if (!body._tab) return;
    try {
      if (!webAssets) webAssets = await api.webAssets();
      await wv.executeJavaScript(pageLookScript(webAssets), true);
      // The Loot tab uses the desktop's own panel, type and button look (renderer/loot/desktop-look.css).
      if (body._tab === 'loot' && webAssets.lootCss) await wv.insertCSS(webAssets.lootCss);
    } catch {
      /* the page is still loading; the next load tries again */
    }
  }

  function mountWeb(body, tab, url, partition) {
    const frame = document.createElement('div');
    frame.className = 'web-frame';
    const wv = document.createElement('webview');
    wv.className = 'web-view';
    wv.setAttribute('partition', partition);
    // A transparent page lets the window glass show through the Control Centre.
    wv.setAttribute('allowtransparency', 'true');
    body._tab = tab;
    const placeholder = document.createElement('div');
    placeholder.className = 'web-placeholder';
    placeholder.hidden = true;
    placeholder.innerHTML =
      '<div class="web-notice"><h2>Server stopped</h2>' +
      '<p>This app shows the Control Centre while the server runs. It loads by itself once the server is up.</p>' +
      '<button class="btn solid" type="button">Start server</button></div>';
    placeholder.querySelector('button').addEventListener('click', () => run(api.startServer()));
    placeholder.hidden = !!server.online;
    const skeleton = skeletonNode();
    body._placeholder = placeholder;
    frame.append(wv, skeleton, placeholder);
    body.append(frame);
    body._webview = wv;
    body._url = url;
    body._placeholder = placeholder;
    body._skeleton = skeleton;
    body._loaded = false;
    // Control Centre pages (with a tab) show the skeleton until the tab is ready. Other web pages
    // show it until the page has loaded.
    setLoading(body, true);

    // A page that navigates again (reload, redirect) is covered again until it is ready.
    wv.addEventListener('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isInPlace) {
        body._probeStart = 0;
        body._shellSeen = false;
        setLoading(body, true);
      }
    });
    // Each page load starts one probe loop; a newer load ends the older loop (see probeId).
    if (tab) {
      wv.addEventListener('dom-ready', () => {
        body._probeId = (body._probeId || 0) + 1;
        injectLook(wv, body);
        applyTab(wv, body, tab, body._probeId);
      });
    }
    wv.addEventListener('did-finish-load', () => {
      body._loaded = true;
      setPlaceholder(body, true);
      if (!tab) setLoading(body, false);
    });
    wv.addEventListener('did-fail-load', (event) => {
      if (event.isMainFrame && event.errorCode !== -3 && !body._loaded) {
        body._loading = false;
        setPlaceholder(body, false);
      }
    });
    wv.src = url;
  }

  // ---------- shared log ----------

  function logStore() {
    return {
      lines: logLines,
      api,
      subscribe(fn) {
        logListeners.add(fn);
        return () => logListeners.delete(fn);
      },
    };
  }

  function lineNode(entry) {
    const node = document.createElement('div');
    node.className = 'line ' + entry.level;
    const time = new Date(entry.ts).toTimeString().slice(0, 8);
    node.textContent = `${time}  ${entry.source.padEnd(7)} ${entry.text}`;
    return node;
  }

  function renderPreview() {
    const box = $('hub-log');
    box.replaceChildren(...logLines.slice(-PREVIEW_LINES).map(lineNode));
    box.scrollTop = box.scrollHeight;
  }

  // Lines arrive in bursts. They are added at once, but the preview and the Live log windows redraw at most
  // four times a second (one redraw per burst, not one per line).
  let logFlush = null;
  function appendLog(entry) {
    logLines.push(entry);
    if (logLines.length > MAX_LINES) logLines.splice(0, logLines.length - MAX_LINES);
    if (!logFlush) {
      logFlush = setTimeout(() => {
        logFlush = null;
        renderPreview();
        logListeners.forEach((fn) => fn());
      }, 250);
    }
  }

  // ---------- widgets, tray and clock ----------

  function renderServer(s) {
    server = s;
    setOffline(!s.online);
    $('srv-state').textContent = t(STATE_TEXT[s.state] || s.state);
    const tone = s.online
      ? 'ok'
      : s.state === 'error' || s.state === 'missing'
        ? 'bad'
        : s.state === 'starting'
          ? 'warn'
          : 'idle';
    setDot($('srv-dot'), tone);
    $('srv-port').textContent = s.port ?? '—';
    $('srv-pid').textContent = s.pid ? `${s.pid}${s.owned ? ' · started here' : ''}` : '—';
    $('srv-error').textContent = s.error || '';
    $('srv-start').disabled = !['stopped', 'error', 'missing'].includes(s.state);
    $('srv-stop').disabled = !s.owned;
    $('srv-restart').disabled = !s.owned;
    setTray('srv', tone, s.error || t(STATE_TEXT[s.state] || s.state));
    renderUptime();
    renderTwitch(s);
  }

  function renderUptime() {
    $('srv-uptime').textContent = server.online && server.startedAt
      ? fmtDuration(Date.now() - server.startedAt)
      : '—';
  }

  function renderTwitch(s) {
    const link = s.twitch;
    $('tw-reconnect').disabled = !s.online;
    if (!s.online || !link) {
      $('tw-state').textContent = t('Waiting for the server');
      $('tw-error').textContent = '';
      setDot($('tw-dot'), 'idle');
      setTray('tw', 'idle', t('Waiting for the server'));
      return;
    }
    const name = link.displayName || link.login;
    $('tw-state').textContent = link.connected
      ? (name ? t('Connected as {name}', { name }) : t('Connected'))
      : humanize(link.status) || t('Not connected');
    $('tw-error').textContent = link.lastError || '';
    const tone = link.lastError ? 'bad' : link.connected ? 'ok' : 'warn';
    setDot($('tw-dot'), tone);
    setTray('tw', tone, link.lastError || $('tw-state').textContent);
  }

  // System usage widget: the bot's own process and this PC, read every 3 seconds. Numbers only.
  const pctText = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);
  const mbText = (b) => (b === null || b === undefined ? '—' : `${Math.round(b / 1048576)} MB`);
  function renderSystem(s) {
    if (!s) return;
    $('sys-bot-cpu').textContent = pctText(s.botCpuPercent);
    $('sys-bot-ram').textContent = mbText(s.botRssBytes);
    $('sys-cpu').textContent = pctText(s.cpuPercent);
    $('sys-ram').textContent = s.ramPercent == null ? '—' : `${pctText(s.ramPercent)} (${mbText(s.ramUsedBytes)})`;
    $('sys-cpu-bar').style.width = `${clamp(s.cpuPercent ?? 0, 0, 100)}%`;
    $('sys-ram-bar').style.width = `${clamp(s.ramPercent ?? 0, 0, 100)}%`;
  }
  async function pollSystem() {
    // Nothing to show: skip the read, so the PowerShell probe does not run for a hidden widget.
    if (document.hidden || document.body.classList.contains('no-widgets') || document.body.classList.contains('hide-w-sys')) return;
    try {
      renderSystem(await api.systemUsage());
    } catch {
      /* keep the last values until the next poll */
    }
  }

  // ---------- stacked groups ----------
  // A group is a rotating widget: its members take turns in one frame, with arrows and dots to cycle.
  // Dropping a widget with its centre over another widget (Edit layout) starts a group, and dropping one on
  // a group adds it. The group moves and resizes as one, and turns to its next widget every few seconds,
  // unless the pointer is over it.
  const GROUPS_KEY = 'fishingbot-desktop:groups:v1';
  const GROUP_TURN_MS = 10000;

  function canGroup(node) {
    return !!node && node.dataset.widget !== 'clock';
  }

  function groupMembers(wrap) {
    return Array.from(wrap.children).filter((n) => n.classList.contains('widget') && n.dataset.widget);
  }

  function addMember(wrap, node) {
    if (wrap._nav) wrap.insertBefore(node, wrap._nav);
    else wrap.append(node);
  }

  function navButton(cls, label, glyph, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.textContent = glyph;
    b.addEventListener('click', onClick);
    return b;
  }

  function makeGroup(id) {
    const wrap = document.createElement('section');
    wrap.className = 'widget-group';
    wrap.dataset.widget = `group-${id}`;
    wrap.dataset.groupId = id;
    wrap.dataset.active = '0';
    wrap.setAttribute('aria-label', t('Widget group'));
    const nav = document.createElement('div');
    nav.className = 'group-nav';
    const dots = document.createElement('span');
    dots.className = 'group-dots';
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'group-ungroup';
    undo.textContent = t('Ungroup');
    undo.addEventListener('click', () => ungroup(wrap));
    nav.append(
      navButton('group-prev', t('Previous widget'), '\u2039', () => cycleGroup(wrap, -1)),
      dots,
      navButton('group-next', t('Next widget'), '\u203A', () => cycleGroup(wrap, 1)),
      undo,
    );
    wrap.append(nav);
    wrap._nav = nav;
    return wrap;
  }

  // Clears a widget's own placement, so it can be placed again by its group or by the grid.
  function unplace(node) {
    node._item = null;
    node.hidden = false;
    node.style.left = '';
    node.style.top = '';
    node.style.width = '';
    node.style.height = '';
    node.style.transform = '';
    node.style.transformOrigin = '';
    node.style.flex = '';
  }

  // Shows the active member only, and draws one dot per member.
  function showActive(wrap) {
    const members = groupMembers(wrap);
    if (!members.length) return;
    const active = Math.min(Math.max(0, Number(wrap.dataset.active) || 0), members.length - 1);
    wrap.dataset.active = String(active);
    members.forEach((m, i) => {
      m.hidden = i !== active;
      m.style.flex = i === active ? '1 1 0' : '';
    });
    const dots = wrap._nav.querySelector('.group-dots');
    dots.replaceChildren(...members.map((_, i) => {
      const d = document.createElement('span');
      d.className = i === active ? 'group-dot on' : 'group-dot';
      return d;
    }));
    const single = members.length < 2;
    wrap._nav.querySelector('.group-prev').hidden = single;
    wrap._nav.querySelector('.group-next').hidden = single;
  }

  function cycleGroup(wrap, step) {
    const n = groupMembers(wrap).length;
    if (n < 2) return;
    wrap.dataset.active = String((((Number(wrap.dataset.active) || 0) + step) % n + n) % n);
    showActive(wrap);
  }

  // The group is as tall as its tallest member, so every turn fills the same frame.
  function refreshGroup(wrap) {
    const sizes = groupMembers(wrap).map(sizeOf);
    const cols = Math.max(widgetMin(wrap).cols, ...sizes.map((z) => z.cols));
    const rows = Math.max(widgetMin(wrap).rows, ...sizes.map((z) => z.rows));
    wrap.dataset.cols = String(cols);
    wrap.dataset.rows = String(rows);
    showActive(wrap);
    if (wrap._item) placeWidget(wrap, { ...wrap._item, cols, rows });
  }

  function joinGroup(target, node) {
    let wrap;
    if (target.classList.contains('widget-group')) {
      wrap = target;
    } else {
      wrap = makeGroup(`g${Date.now().toString(36)}`);
      wrap._item = { ...target._item };
      target.before(wrap);
      unplace(target);
      addMember(wrap, target);
      wireWidget(wrap);
    }
    unplace(node);
    addMember(wrap, node);
    refreshGroup(wrap);
    return wrap;
  }

  // True when the dropped widget joined a group. Its centre must be over another widget or group.
  function joinAt(node) {
    if (!canGroup(node) || node.classList.contains('widget-group')) return false;
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const target = Array.from(document.querySelectorAll('.widgets > .widget[data-widget], .widgets > .widget-group'))
      .filter((n) => n !== node && canGroup(n) && n._item)
      .find((n) => {
        const b = n.getBoundingClientRect();
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
      });
    if (!target) return false;
    const wrap = joinGroup(target, node);
    settleWidget(wrap);
    saveGroups();
    return true;
  }

  // Splits a group: each member takes the group's place, and the grid moves any that overlap.
  function ungroup(wrap) {
    const members = groupMembers(wrap);
    const base = wrap._item ? { ...wrap._item } : { ax: 'l', ay: 't', col: 0, row: 0 };
    const grid = widgetGrid();
    const others = widgetNodes().filter((n) => n !== wrap && n._item).map((n) => n._item);
    for (const m of members) {
      wrap.before(m);
      unplace(m);
      const sz = sizeOf(m);
      const want = { ax: base.ax, ay: base.ay, col: base.col, row: base.row, cols: sz.cols, rows: sz.rows };
      const item = freeItem(grid, want, others);
      others.push(item);
      placeWidget(m, item);
      m._intent = item;
    }
    wrap.remove();
    saveWidgetPositions();
    saveGroups();
  }

  function saveGroups() {
    const list = Array.from(document.querySelectorAll('.widgets > .widget-group')).map((wrap) => ({
      id: wrap.dataset.groupId,
      members: groupMembers(wrap).map((m) => m.dataset.widget),
    }));
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(list));
    } catch {
      /* not saved: the groups are split again next start */
    }
  }

  function restoreGroups() {
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(GROUPS_KEY)) || [];
    } catch {
      list = [];
    }
    const box = document.querySelector('.widgets');
    if (!box || !Array.isArray(list)) return;
    for (const g of list) {
      const members = (Array.isArray(g.members) ? g.members : [])
        .map((name) => box.querySelector(`:scope > .widget[data-widget="${name}"]`))
        .filter(Boolean);
      if (!members.length || !g.id) continue;
      const wrap = makeGroup(String(g.id));
      box.append(wrap);
      for (const m of members) addMember(wrap, m);
      refreshGroup(wrap);
    }
  }

  // Each group turns to its next widget. A group under the pointer stays on the widget it shows.
  function rotateGroups() {
    if (editLayout) return;
    for (const wrap of document.querySelectorAll('.widgets > .widget-group')) {
      if (!wrap.matches(':hover')) cycleGroup(wrap, 1);
    }
  }

  // Smart alignment: while an app or widget is moved, a guide line shows each edge or centre it lines up
  // with on another app or widget. The grid still decides the place; the guides show where things line up.
  const GUIDE_TOLERANCE = 1.5;
  function clearGuides() {
    document.querySelectorAll('.align-guide').forEach((g) => g.remove());
  }
  function showGuides(node) {
    clearGuides();
    const me = node.getBoundingClientRect();
    const mineX = [me.left, (me.left + me.right) / 2, me.right];
    const mineY = [me.top, (me.top + me.bottom) / 2, me.bottom];
    const others = [...$('icons').children, ...document.querySelectorAll('.widgets > .widget[data-widget], .widgets > .widget-group')]
      .filter((n) => n !== node && !n.hidden && n.getBoundingClientRect().width > 0)
      .map((n) => n.getBoundingClientRect());
    const vertical = new Map();
    const horizontal = new Map();
    for (const o of others) {
      const theirX = [o.left, (o.left + o.right) / 2, o.right];
      const theirY = [o.top, (o.top + o.bottom) / 2, o.bottom];
      for (const mx of mineX) for (const tx of theirX) {
        if (Math.abs(mx - tx) <= GUIDE_TOLERANCE) {
          const span = vertical.get(tx) || { top: Math.min(me.top, o.top), bottom: Math.max(me.bottom, o.bottom) };
          span.top = Math.min(span.top, me.top, o.top);
          span.bottom = Math.max(span.bottom, me.bottom, o.bottom);
          vertical.set(tx, span);
        }
      }
      for (const my of mineY) for (const ty of theirY) {
        if (Math.abs(my - ty) <= GUIDE_TOLERANCE) {
          const span = horizontal.get(ty) || { left: Math.min(me.left, o.left), right: Math.max(me.right, o.right) };
          span.left = Math.min(span.left, me.left, o.left);
          span.right = Math.max(span.right, me.right, o.right);
          horizontal.set(ty, span);
        }
      }
    }
    for (const [x, span] of vertical) {
      const g = document.createElement('div');
      g.className = 'align-guide v';
      g.style.left = `${x}px`;
      g.style.top = `${span.top}px`;
      g.style.height = `${span.bottom - span.top}px`;
      document.body.append(g);
    }
    for (const [y, span] of horizontal) {
      const g = document.createElement('div');
      g.className = 'align-guide h';
      g.style.top = `${y}px`;
      g.style.left = `${span.left}px`;
      g.style.width = `${span.right - span.left}px`;
      document.body.append(g);
    }
  }

  function tick() {
    const now = new Date();
    const hm = clockText(now);
    $('clock-time').textContent = hm;
    $('clock-date').textContent = dateText(now);
    $('lock-time').textContent = hm;
    $('lock-date').textContent = $('clock-date').textContent;
    $('tray-clock').textContent = hm;
    renderUptime();
  }

  // The clock and date fill their widget: the time is as large as the width and height allow, and the date
  // is scaled with it. Measured with a range, so the size follows the real text width.
  function fitClock() {
    const node = document.querySelector('.widget-clock');
    const time = $('clock-time');
    const date = $('clock-date');
    if (!node || !time || !date || node.clientWidth === 0 || node.clientHeight === 0) return;
    const showDate = !document.body.classList.contains('no-date');
    const availW = node.clientWidth - 16;
    const availH = node.clientHeight - 12;
    const measure = (el, size) => {
      el.style.fontSize = `${size}px`;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const timeW = measure(time, 100);
    let timeSize = timeW > 0 ? (availW / timeW) * 100 : 100;
    let dateSize = 0;
    if (showDate) {
      const dateW = measure(date, 100);
      dateSize = clamp(timeSize * 0.22, 9, 200);
      if (dateW > 0) dateSize = Math.min(dateSize, (availW / dateW) * 100);
    }
    // Height: the time line, then the gap and the date line. Everything shrinks together if it is too tall.
    const gap = showDate ? timeSize * 0.12 : 0;
    const needed = timeSize + (showDate ? gap + dateSize * 1.3 : 0);
    if (needed > availH) {
      const k = availH / needed;
      timeSize *= k;
      dateSize *= k;
    }
    timeSize = clamp(timeSize, 10, 400);
    time.style.fontSize = `${timeSize.toFixed(1)}px`;
    date.style.fontSize = `${Math.max(8, dateSize).toFixed(1)}px`;
    node.style.setProperty('--clock-gap', `${(timeSize * 0.12).toFixed(1)}px`);
  }

  // ---------- wiring ----------

  function wireControls() {
    $('srv-start').addEventListener('click', () => run(api.startServer()));
    $('srv-restart').addEventListener('click', () => run(api.restartServer()));
    $('srv-stop').addEventListener('click', async () => {
      const view = await api.getSettings();
      if (view.interface.confirmStopServer && !window.confirm(t('Stop the Fishingbot server? Viewers cannot play until it is started again.'))) return;
      run(api.stopServer());
    });
    $('tw-reconnect').addEventListener('click', async () => {
      const result = await api.reconnectTwitch();
      if (result.ok) toast(t('Twitch reconnect requested.'), 'info', { title: t('Twitch') });
      else if (result.status === 401 || result.status === 403) toast(t('Sign in to the Control Centre first, then try again.'), 'bad', { title: t('Twitch') });
      else toast(`${t('Reconnect failed')}: ${result.error || 'unknown error'}`, 'bad', { title: t('Twitch') });
    });
    $('log-open').addEventListener('click', () => openApp('log'));

    $('start-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleStart();
    });
    const tbSearch = $('tb-search');
    const tbInput = $('tb-search-input');
    const openFromTaskbar = () => {
      if ($('start-menu').hidden) toggleStart(true, { anchor: tbSearch, focus: 'taskbar', keepQuery: true });
    };
    tbInput.addEventListener('focus', openFromTaskbar);
    tbInput.addEventListener('click', openFromTaskbar);
    tbInput.addEventListener('input', () => {
      openFromTaskbar();
      setQuery(tbInput.value);
    });
    tbInput.addEventListener('keydown', (event) => onStartKey(event));
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.start-wrap, .start-menu, .tb-search')) toggleStart(false);
    });

    document.addEventListener('keydown', (event) => {
      if (!$('lock').hidden) return;
      if (event.key === 'Escape') toggleStart(false);
      if (!event.ctrlKey || !info) return;
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        openApp('log');
        return;
      }
      if (event.key === ',') {
        event.preventDefault();
        openApp('settings');
        return;
      }
      if (event.key.toLowerCase() === 'd') {
        event.preventDefault();
        toggleApp('folder');
        return;
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
        return;
      }
      const index = Number(event.key) - 1;
      if (index >= 0 && index < info.tabIds.length) {
        event.preventDefault();
        openApp(`cc:${info.tabIds[index]}`);
      }
    });

    // Sign-in screen form: one sign-in unlocks every app.
    $('lock-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = $('lock-password').value;
      if (lockMode === 'setup') {
        if (password.length < 12) {
          $('lock-error').textContent = 'Use at least 12 characters.';
          return;
        }
        if (password !== $('lock-confirm').value) {
          $('lock-error').textContent = 'The two passwords do not match.';
          return;
        }
      }
      $('lock-submit').disabled = true;
      const result = lockMode === 'setup'
        ? await api.authSetup({ password })
        : await api.authLogin({ password });
      $('lock-submit').disabled = false;
      if (!result.ok) {
        $('lock-error').textContent = result.error || 'Sign-in failed.';
        return;
      }
      $('lock-password').value = '';
      $('lock-confirm').value = '';
      unlocked(true);
    });

    // Links that ask for a new window open as an app inside the desktop.
    api.onWebOpen((url) => {
      urlCounter += 1;
      const appId = `url:${urlCounter}`;
      urlApps.set(appId, url);
      openApp(appId);
    });
    api.onOnline(() => checkLock());
    api.onState((s) => renderServer(s));
    api.onLog(appendLog);
  }

  function restoreLayout() {
    for (const item of loadLayout()) {
      const app = catalogue().find((entry) => entry.id === item.id);
      if (!app) continue;
      // Offline editors open only when asked: restoring at Windows start must not pop them up.
      if (app.kind === 'web' && (app.tab === 'loot' || app.tab === 'game') && !server.online) continue;
      openApp(item.id, item);
    }
  }

  // Settings changed the language: the static text follows, and the scripts' own text is redrawn.
  document.addEventListener('fishingbot:language', (event) => {
    if (I18n) I18n.setLanguage(event.detail);
    if (I18n) I18n.apply(document.body);
    renderIcons();
    renderStartMenu();
    renderServer(server);
    renderPreview();
    syncSettingsButton();
  });
  // The look changed (icon size, taskbar, glass, corners): the icon grid and the windows are laid out
  // again, and the Control Centre pages take the new corners and glass.
  document.addEventListener('fishingbot:look', () => {
    layoutIcons();
    keepInArea();
    placeWidgets();
    for (const rec of windows.values()) {
      if (rec.body._webview && rec.body._tab && rec.body._webview.isConnected) injectLook(rec.body._webview, rec.body);
    }
  });
  window.addEventListener('resize', () => {
    layoutIcons();
    keepInArea();
    placeWidgets();
    positionToasts();
  });
  document.addEventListener('fishingbot:reset-widgets', () => {
    try {
      localStorage.removeItem(WIDGET_LAYOUT_KEY);
    } catch {
      /* nothing stored */
    }
    placeWidgets();
  });
  document.addEventListener('keydown', (event) => {
    if (editLayout && event.key === 'Escape') setEditLayout(false);
  });
  document.addEventListener('fishingbot:reset-icons', () => {
    try {
      localStorage.removeItem(ICON_STORE);
    } catch {
      /* nothing stored */
    }
    renderIcons();
  });

  async function init() {
    // The entrance motion (icons, widgets, taskbar) plays once, while the boot class is on.
    document.body.classList.add('boot');
    setTimeout(() => document.body.classList.remove('boot'), 1500);
    info = await api.info();
    const saved = await api.getSettings();
    security = { ...security, ...(saved.security || {}) };
    armIdleLock();
    if (I18n) await I18n.load(api, saved.interface.language);
    // The saved look (wallpaper, accent, icon size, clock, widgets) is applied before the desktop shows.
    if (window.FishingbotAppearance) await window.FishingbotAppearance.load(api);
    const [state, history] = await Promise.all([api.getState(), api.getLogHistory()]);
    logLines.push(...history.slice(-MAX_LINES));
    renderIcons();
    renderStartMenu();
    renderServer(state);
    renderPreview();
    wireControls();
    tick();
    // The Menu button shows the profile picture when one is set, otherwise the logo (appearance.js).
    if (window.FishingbotAppearance) window.FishingbotAppearance.renderAvatar();
    else $('start-btn').innerHTML = '<img class="tb-logo" src="assets/logo.svg" alt="" width="26" height="26">';
    bindTip($('start-btn'), t('Menu'));
    // Status pills: the tooltip text is filled in by setTray as the state changes.
    bindTip($('tray-srv-item'), t('Server'));
    bindTip($('tray-tw-item'), t('Twitch'));
    renderServer(server);
    const settingsButton = $('tb-settings');
    settingsButton.innerHTML = iconSvg('settings', 20);
    settingsButton.addEventListener('click', () => toggleApp('settings'));
    bindTip(settingsButton, t('Settings'));
    const folderButton = $('tb-folder');
    folderButton.innerHTML = iconSvg('folder', 20);
    folderButton.addEventListener('click', () => toggleApp('folder'));
    bindTip(folderButton, t('Folder'));
    setInterval(tick, 1000);
    setInterval(rotateGroups, GROUP_TURN_MS);
    $('edit-done').addEventListener('click', () => setEditLayout(false));
    pollSystem();
    setInterval(pollSystem, 8000);

    await waitForSignIn();
    restoreLayout();
    document.body.append($('start-menu'));
    restoreGroups();
    widgetNodes().forEach(wireWidget);
    placeWidgets();
    document.body.classList.add('widgets-ready');
  }

  init().catch((err) => {
    console.error('Desktop start failed:', err);
    // The first stack lines show the file and line that failed, so the message can be reported as it is.
    const where = String(err && err.stack || '').split('\n').slice(1, 3).map((line) => line.trim()).join(' / ');
    toast(`Could not start the desktop: ${err.message}${where ? ` (${where})` : ''}`, 'bad');
  });
})();
