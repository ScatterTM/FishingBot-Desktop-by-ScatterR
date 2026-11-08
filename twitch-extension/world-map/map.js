// ---------- Areas: where each one sits on the artwork (fractions of the map) ----------
const AREA_LAYOUT = {
  frozen:     { px: 0.3158, py: 0.1270, icon: 'snow' },
  forest:     { px: 0.6699, py: 0.1465, icon: 'tree' },
  shieldlake: { px: 0.2297, py: 0.2783, icon: 'shield' },
  reef:       { px: 0.7368, py: 0.3271, icon: 'coral' },
  emberpool:  { px: 0.4211, py: 0.4199, icon: 'flame' },
  whalebone:  { px: 0.8612, py: 0.4590, icon: 'fluke' },
};
// ---------- Tides Kingdom: the city island. Each building opens a hub panel in the main page. ----------
// x, y are artwork units (1408 x 1380). pond opens the Shop's Pond category.
const BUILDINGS = {
  trading:      { x: 735, y: 1050, hub: 'trading',      icon: 'coin',     label: 'Trading', lock: 'Log in to use Trading.' },
  mail:         { x: 803, y: 1267, hub: 'mail',         icon: 'envelope', label: 'Mail', lock: 'Log in to read your Mail.' },
  index:        { x: 831, y: 1002, hub: 'index',        icon: 'book',     label: 'Index' },
  achievements: { x: 1078, y: 930, hub: 'achievements', icon: 'trophy',   label: 'Achievements' },
  perks:        { x: 644, y: 930,  hub: 'perks',        icon: 'sparkle',  label: 'Perks' },
  autofish:     { x: 970, y: 1233, hub: 'autofish',     icon: 'gear',     label: 'Auto-Fish', lock: 'Reach Area Level 3 to unlock Auto-Fish.' },
  shop:         { x: 1064, y: 1159, hub: 'shop',        icon: 'bag',      label: 'Shop' },
  pond:         { x: 909, y: 1065, hub: 'pond',         icon: 'drop',     label: 'Pond', lock: 'The Personal Pond unlocks at Prestige 1.' },
};
// Harbor: the purple mark in the sea-route artwork. Boats dock here and depart again.
const HARBOR = { x: 959, y: 1270 };
// 9x9 pixel icons. '#' = filled pixel.
const ICON_BITMAPS = {
  tree:   ['..#####..', '.#######.', '#########', '#########', '.#######.', '..#####..', '....#....', '....#....', '...###...'],
  snow:   ['....#....', '#...#...#', '.#..#..#.', '..#.#.#..', '...###...', '#########', '...###...', '..#.#.#..', '.#..#..#.'],
  shield: ['#########', '#########', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....', '.........'],
  coral:  ['#.#...#.#', '#.#.#.#.#', '#.#####.#', '###.#.###', '..#.#.#..', '...###...', '...###...', '...###...', '.........'],
  flame:  ['....#....', '...#.#...', '..##.##..', '..###.#..', '.#######.', '.#######.', '.#######.', '..#####..', '...###...'],
  fluke:  ['##.....##', '###...###', '.###.###.', '..#####..', '....#....', '....#....', '...###...', '.........', '.........'],
  coin:     ['..#####..', '.#######.', '###.#.###', '###.#.###', '###.#.###', '###.#.###', '###.#.###', '.#######.', '..#####..'],
  envelope: ['#########', '##.....##', '#.#...#.#', '#..#.#..#', '#...#...#', '#.......#', '#########', '.........', '.........'],
  book:     ['#########', '#.#.#.#.#', '#.#.#.#.#', '#.#.#.#.#', '#.#.#.#.#', '#.#.#.#.#', '#.#.#.#.#', '#########', '.........'],
  trophy:   ['.#######.', '#########', '#########', '.#######.', '..#####..', '....#....', '...###...', '..#####..', '.........'],
  sparkle:  ['....#....', '...###...', '..#####..', '#########', '..#####..', '...###...', '....#....', '.........', '.........'],
  gear:     ['..#.#.#..', '.#######.', '#.#...#.#', '###...###', '#.#...#.#', '.#######.', '..#.#.#..', '.........', '.........'],
  bag:      ['..#####..', '.#.....#.', '#########', '#########', '#########', '#########', '#########', '#########', '.........'],
  drop:     ['....#....', '....#....', '...###...', '..#####..', '.#######.', '.#######.', '.#######.', '..#####..', '...###...'],
};
const BOAT_ICON = '<svg viewBox="0 0 9 7" shape-rendering="crispEdges" aria-hidden="true"><rect x="4" y="0" width="1" height="5"/><rect x="5" y="1" width="2" height="1"/><rect x="5" y="2" width="3" height="1"/><rect x="0" y="5" width="9" height="1"/><rect x="1" y="6" width="7" height="1"/></svg>';

const MAP_W = 1408, MAP_H = 1380;  // world size. The merged artwork (map-art.svg, viewBox 1045 x 1024) is drawn to fill it.
const MIN_ZOOM = 1.5, MAX_ZOOM = 3; // 150% to 300%
const DEFAULT_ZOOM = 1.5; // 150% when the map opens for the first time
const GAP = 22;                    // popup distance from the button centre

const $ = (id) => document.getElementById(id);
const root = $('world-map-root');
const win = $('mapWindow'), world = $('world'), pinsLayer = $('pins'), popup = $('areaPopup'), arrow = $('popupArrow');
const zoomLabel = $('zoomLabel'), expandBtn = $('expandBtn');

let zoom = DEFAULT_ZOOM;
let pos = { x: 0, y: 0 };
let drag = null, pinch = null, moved = false;
const pointers = new Map();
let openId = null;            // area whose popup is open
let buildingOpen = null;      // building whose popup is open in the main page (the page draws it)
let areaData = null;          // last state sent by the page that embeds this map
let expanded = false;
let tutorialId = null;        // area the guide is pointing at
let tutorialCentered = null;
let movingTimer = null, saveTimer = null;
let pending = null;            // action sent to the page and not yet finished: { action, areaId }
let pendingTimer = null, toastTimer = null;
const lootCache = {}, lootAsked = {};   // fish lists from the page: undefined = not asked, null = failed
const TIER_ORDER = ['SECRET', 'GODLY', 'LEGENDARY', 'EPIC', 'RARE', 'UNCOMMON', 'COMMON'];

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function parentPost(msg) { window.dispatchEvent(new CustomEvent('fishingbot:map-event', { detail: msg })); }
function markMoving() {
  win.classList.add('is-moving');
  clearTimeout(movingTimer);
  movingTimer = setTimeout(() => win.classList.remove('is-moving'), 250);
}
function spriteSVG(bitmap) {
  let rects = '';
  bitmap.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }));
  return `<svg viewBox="0 0 ${bitmap[0].length} ${bitmap.length}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}
function catchPct(level) { return level ? Math.round((0.08 + (level - 1) * 0.035) * 100) : 0; }
function areaFor(id) { return (areaData?.areas || []).find((a) => a.id === id) || null; }
function safeNumber(value, fallback = 0, min = 0, max = 1000000000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function safeText(value, fallback = '', maxLength = 100) {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  return String(value).slice(0, maxLength);
}
function normalizeMapData(input) {
  if (!input || typeof input !== 'object' || typeof input.readOnly !== 'boolean' || !Array.isArray(input.areas)) return null;
  const allowedIds = new Set(Object.keys(AREA_LAYOUT));
  const areas = input.areas.filter((a) => a && typeof a === 'object' && allowedIds.has(a.id)).map((a) => {
    const boost = {};
    if (a.boost && typeof a.boost === 'object' && !Array.isArray(a.boost)) {
      Object.entries(a.boost).slice(0, 24).forEach(([key, value]) => {
        if ((typeof value === 'string' || typeof value === 'number') && Number.isFinite(typeof value === 'number' ? value : 0)) {
          boost[safeText(key, '', 40)] = safeText(value, '', 48);
        }
      });
    }
    const loot = Array.isArray(a.loot) ? a.loot.slice(0, 250).map((f) => ({
      name: safeText(f?.name, '', 80), tier: safeText(f?.tier, 'COMMON', 32), weight: safeNumber(f?.weight, 0, 0, 1000000)
    })).filter((f) => f.name) : [];
    return {
      id: a.id,
      name: safeText(a.name, a.id, 60),
      description: safeText(a.description, '', 240),
      level: Math.floor(safeNumber(a.level, 0, 0, 5)),
      unlocked: a.unlocked === true,
      selected: a.selected === true,
      enabled: a.enabled !== false,
      catchChance: safeNumber(a.catchChance, 8, 0, 100),
      unlockCost: safeNumber(a.unlockCost, 0, 0, 1000000),
      levelCosts: Array.isArray(a.levelCosts) ? a.levelCosts.slice(0, 5).map((v) => safeNumber(v, 0, 0, 1000000)) : [],
      boost,
      loot,
      lootCount: Math.floor(safeNumber(a.lootCount, loot.length, 0, 10000))
    };
  });
  const validId = (value) => typeof value === 'string' && allowedIds.has(value) ? value : null;
  const dc = input.doubleCatch && typeof input.doubleCatch === 'object' ? input.doubleCatch : {};
  const buildingIds = Object.keys(BUILDINGS);
  const buildingLocked = {};
  const buildingStatus = {};
  buildingIds.forEach((id) => {
    buildingLocked[id] = !!(input.buildingLocked && input.buildingLocked[id] === true);
    const value = input.buildingStatus && input.buildingStatus[id];
    if (value === true || (typeof value === 'number' && Number.isFinite(value) && value > 0)) buildingStatus[id] = value;
  });
  const fish = Array.isArray(input.fish) ? input.fish.slice(0, 5000).filter((row) => Array.isArray(row) && row.length >= 2).map((row) => [
    safeText(row[0], '', 80), safeText(row[1], 'COMMON', 32), Array.isArray(row[2]) ? row[2].filter((id) => allowedIds.has(id)).slice(0, 8) : []
  ]).filter((row) => row[0]) : [];
  return {
    readOnly: input.readOnly === true, areas, buildingLocked, buildingStatus,
    selected: validId(input.selected), active: validId(input.active),
    userAreasEnabled: input.userAreasEnabled !== false,
    userDoubleEnabled: input.userDoubleEnabled !== false,
    areasEnabled: input.areasEnabled !== false,
    doubleCatchEnabled: input.doubleCatchEnabled !== false,
    doubleCatch: { level: Math.floor(safeNumber(dc.level, 0, 0, 5)), chance: safeNumber(dc.chance, 0, 0, 100), points: safeNumber(dc.points, 0, 0, 100000) },
    treasury: Math.floor(safeNumber(input.treasury, 0, 0, 1000000000)), fish
  };
}
function normalizeLoot(input) {
  if (!Array.isArray(input)) return null;
  return input.slice(0, 250).map((f) => ({
    name: safeText(f?.name, '', 80), tier: safeText(f?.tier, 'COMMON', 32), weight: safeNumber(f?.weight, 0, 0, 1000000)
  })).filter((f) => f.name);
}
function useAreas() { return areaData?.userAreasEnabled !== false; }
// Short notice on the map, so a click always gets a visible answer even when the page is not in view.
function showToast(text, busy) {
  const t = $('mapToast');
  t.textContent = text;
  t.classList.toggle('busy', !!busy);
  t.hidden = false;
  clearTimeout(toastTimer);
  if (!busy) toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
// A building opens its hub in the main page, unless it is locked (Trading and Mail until they are unlocked).
// The building's popup is drawn by the main page over this map. It is anchored to the pin's
// screen position (sent here), and it closes when the map is moved (see dismissBuilding).
function buildingPoint(id) {
  const pin = pinsLayer.querySelector(`.pin[data-building="${id}"]`);
  if (!pin) return null;
  const r = pin.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function openBuilding(id, pin) {
  const b = BUILDINGS[id];
  if (!b) return;
  if (areaData?.buildingLocked && areaData.buildingLocked[id]) { showToast(b.lock || `${b.label} is locked`); return; }
  closePopup();
  buildingOpen = id;
  render();
  const p = pin ? buildingPoint(id) : null;
  parentPost({ type: 'wm-building', id, label: b.label, x: p ? p.x : 0, y: p ? p.y : 0 });
}
// Closes the building popup in the main page. Called when the map is dragged, zoomed, or clicked.
function dismissBuilding() {
  if (!buildingOpen) return;
  buildingOpen = null;
  render();
  parentPost({ type: 'wm-dismiss' });
}
// Tells the main page where the open building's pin is now (after the map frame is resized).
function anchorBuilding() {
  if (!buildingOpen) return;
  const p = buildingPoint(buildingOpen);
  if (p) parentPost({ type: 'wm-anchor', id: buildingOpen, x: p.x, y: p.y });
}
// Sends an action to the page and shows it as in progress until the page reports back.
function sendAction(msg, label, busyLabel) {
  pending = { action: msg.action, areaId: msg.areaId || null };
  showToast(busyLabel, true);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    if (!pending) return;
    pending = null;
    showToast('No reply yet. Try again.', false);
    render();
  }, 65000);
  parentPost(msg);
  render();
}
function finishPending(message) {
  if (!pending) return;
  pending = null;
  clearTimeout(pendingTimer);
  showToast(typeof message === 'string' && message ? message : 'Done.', false);
  render();
}
function failPending(message) {
  if (!pending) return;
  pending = null;
  clearTimeout(pendingTimer);
  showToast(typeof message === 'string' && message ? message : 'The area action could not be completed.', false);
  render();
}
function busyLabelFor(action, areaId) {
  const name = areaFor(areaId)?.name || 'area';
  if (action === 'buy') return `Unlocking ${name}…`;
  if (action === 'upgrade') return `Upgrading ${name}…`;
  if (action === 'fish') return `Selecting ${name}…`;
  if (action === 'stop' || (action === 'select' && !areaId)) return 'Deselecting…';
  return 'Working…';
}

// ---------- View: the artwork is resized only when zoom changes; panning moves it with a transform ----------
function applyView() {
  const W = MAP_W * zoom, H = MAP_H * zoom;
  const w = win.clientWidth, h = win.clientHeight;
  pos.x = W <= w ? (w - W) / 2 : Math.min(0, Math.max(w - W, pos.x));
  pos.y = H <= h ? (h - H) / 2 : Math.min(0, Math.max(h - H, pos.y));
  if (world.dataset.w !== String(W)) {
    world.style.width = W + 'px';
    world.style.height = H + 'px';
    world.dataset.w = String(W);
  }
  world.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
  if (document.activeElement !== zoomLabel) zoomLabel.value = Math.round(zoom * 100) + '%';
  queueSaveView();
}
// Any change of view closes the popup, so it never drifts away from its button.
function changeView(fn) {
  closePopup();
  dismissBuilding();
  fn();
  applyView();
  markMoving();
}
function setZoom(z, sx, sy) {
  changeView(() => {
    const w = win.clientWidth, h = win.clientHeight;
    if (sx === undefined) { sx = w / 2; sy = h / 2; }
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const mx = (sx - pos.x) / zoom, my = (sy - pos.y) / zoom;   // map point under the cursor
    zoom = nz;
    pos.x = sx - mx * zoom;
    pos.y = sy - my * zoom;
  });
}
function centerOn(a) {
  changeView(() => {
    pos.x = win.clientWidth / 2 - a.px * MAP_W * zoom;
    pos.y = win.clientHeight / 2 - a.py * MAP_H * zoom;
  });
}
// The map keeps the same centre whenever its window changes size (expand, collapse, or the page resizing).
let lastW = 0, lastH = 0;
let centerOnFirstVisible = false;
new ResizeObserver(() => {
  const w = win.clientWidth, h = win.clientHeight;
  if (w === lastW && h === lastH) return;
  if (lastW) {
    const cx = (lastW / 2 - pos.x) / zoom, cy = (lastH / 2 - pos.y) / zoom;
    pos.x = w / 2 - cx * zoom;
    pos.y = h / 2 - cy * zoom;
    pauseSea(450);
  } else if (centerOnFirstVisible && w > 0 && h > 0) {
    // The map view starts hidden in the Twitch Component. Centre only after
    // it receives its first real layout size, not against a 0x0 viewport.
    pos.x = w / 2 - AREA_LAYOUT.forest.px * MAP_W * zoom;
    pos.y = h / 2 - AREA_LAYOUT.forest.py * MAP_H * zoom;
    centerOnFirstVisible = false;
  }
  lastW = w; lastH = h;
  applyView();
  if (openId) placePopup(openId);
  anchorBuilding();
}).observe(win);

// ---------- Input: wheel, drag, pinch, keys ----------
win.addEventListener('wheel', (e) => {
  if (e.target.closest('.area-popup, .map-menu, .map-treasury, .expand-btn')) return;
  e.preventDefault();
  const r = win.getBoundingClientRect();
  setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
function localPoint(e) { const r = win.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
win.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.area-popup, .map-menu, .map-treasury, .expand-btn')) return;
  if (pointers.size === 0) moved = false;
  pointers.set(e.pointerId, localPoint(e));
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom };
    drag = null;
    moved = true;
  } else if (pointers.size === 1 && e.button === 0) {
    drag = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y, id: e.pointerId };
  }
});
win.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, localPoint(e));
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!moved && Math.hypot(dx, dy) > 5) {
    moved = true;
    win.setPointerCapture(drag.id);
    win.classList.add('is-dragging');
    closePopup();
    dismissBuilding();
  }
  if (!moved) return;
  pos.x = drag.px + dx;
  pos.y = drag.py + dy;
  applyView();
  markMoving();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) { drag = null; win.classList.remove('is-dragging'); markMoving(); }
}
win.addEventListener('pointerup', endPointer);
win.addEventListener('pointercancel', endPointer);

win.addEventListener('click', (e) => {
  if (moved) return;
  if (!e.target.closest('.pin, .area-popup, .map-menu, .map-treasury, .expand-btn')) { closePopup(); dismissBuilding(); }
});
pinsLayer.addEventListener('click', (e) => {
  if (moved) return;
  const pin = e.target.closest('.pin');
  if (!pin) return;
  // The boat on the active area leaves it; anywhere else on a pin opens its popup.
  if (pin.dataset.building) { openBuilding(pin.dataset.building, pin); return; }
  if (e.target.closest('.boat') && pin.classList.contains('here')) { parentPost({ type: 'wm-action', action: 'select', areaId: null }); return; }
  openArea(pin.dataset.id);
});


// ---------- Toolbar and status controls ----------
$('zoomInBtn').addEventListener('click', () => setZoom(zoom * 1.25));
$('zoomOutBtn').addEventListener('click', () => setZoom(zoom / 1.25));
$('recenterBtn').addEventListener('click', () => centerOn(AREA_LAYOUT[openId] || AREA_LAYOUT[areaData?.active] || AREA_LAYOUT.forest));
$('menuToggle').addEventListener('click', () => {
  const open = $('menuToggle').getAttribute('aria-expanded') !== 'true';
  $('menuToggle').setAttribute('aria-expanded', String(open));
  $('menuBody').hidden = !open;
  $('menuChev').textContent = open ? '▾' : '▸';
});
$('switchFish').addEventListener('click', () => {
  const on = !useAreas();
  sendAction({ type: 'wm-action', action: 'toggle-areas', enabled: on }, '', on ? 'Turning fishing areas on…' : 'Turning fishing areas off…');
});
$('switchDouble').addEventListener('click', () => {
  const on = areaData?.userDoubleEnabled === false;
  sendAction({ type: 'wm-action', action: 'toggle-double', enabled: on }, '', on ? 'Turning Double Catch on…' : 'Turning Double Catch off…');
});
$('deselectBtn').addEventListener('click', () => {
  sendAction({ type: 'wm-action', action: 'select', areaId: null }, '', 'Deselecting…');
});
zoomLabel.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); zoomLabel.blur(); }
  if (e.key === 'Escape') { zoomLabel.value = Math.round(zoom * 100) + '%'; zoomLabel.blur(); }
});
zoomLabel.addEventListener('blur', () => {
  const n = parseFloat(zoomLabel.value.replace('%', '').trim());
  if (isFinite(n) && n > 0 && Math.abs(n / 100 - zoom) > 0.001) setZoom(n / 100);
  zoomLabel.value = Math.round(zoom * 100) + '%';
});

// ---------- Search: areas, fish and perks ----------
const searchInput = $('searchInput'), searchResults = $('searchResults');
// Perks and the city popup each one is in. The labels match the names players see.
const PERK_SEARCH = [
  { label: 'Permanent 1.5x Luck', building: 'perks' },
  { label: 'Temporary 2x Luck', building: 'perks' },
  { label: 'Vipfish', building: 'perks' },
  { label: 'Shieldfish', building: 'perks' },
  { label: 'Global Luck Event', building: 'perks' },
  { label: '1.25x Luck (Permanent)', building: 'shop' },
  { label: '15% Cooldown Reduction', building: 'shop' },
  { label: '1.5x Treasury Luck', building: 'shop' },
  { label: '2x Rarity Luck (15 min)', building: 'shop' },
  { label: 'Treasury Only Mode', building: 'shop' },
  { label: "Fisherman's Fortune", building: 'shop' },
  { label: 'Treasury Waters', building: 'pond' },
  { label: 'Species Hunter', building: 'pond' },
  { label: 'Bait Saver', building: 'pond' },
  { label: "Collector's Instinct", building: 'pond' },
  { label: 'Still Waters', building: 'pond' },
  { label: 'Deep Current', building: 'pond' },
  { label: 'Bigger Haul', building: 'pond' },
  { label: 'Fishy Fortune', building: 'pond' }
];
const BUILDING_NAMES = { perks: 'Perks', shop: 'Shop', pond: 'Pond' };
function hideSearch() { searchResults.hidden = true; searchInput.setAttribute('aria-expanded', 'false'); }
function areaNameFor(id) { return areaFor(id)?.name || id; }
function searchMatches(q) {
  const results = [];
  (areaData?.areas || []).forEach((a) => {
    if (AREA_LAYOUT[a.id] && a.name.toLowerCase().includes(q)) {
      results.push({ kind: 'area', id: a.id, label: a.name, meta: areaData?.readOnly === true ? 'Public area' : (a.unlocked ? 'Level ' + a.level : 'Locked') });
    }
  });
  // Fish: each name once. Fish from fishing areas go to the first area they are caught in.
  const seenFish = new Set();
  for (const [name, , areaIds] of (areaData?.fish || [])) {
    if (!name.toLowerCase().includes(q) || seenFish.has(name)) continue;
    seenFish.add(name);
    const onMap = (areaIds || []).filter((id) => AREA_LAYOUT[id]);
    results.push({
      kind: 'fish',
      id: onMap[0] || '',
      label: name,
      meta: onMap.length ? onMap.map(areaNameFor).join(', ') : 'Normal waters'
    });
  }
  PERK_SEARCH.forEach((p) => {
    if (p.label.toLowerCase().includes(q)) {
      results.push({ kind: 'perk', id: p.building, label: p.label, meta: BUILDING_NAMES[p.building] + ' popup' });
    }
  });
  return results;
}
function renderSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { hideSearch(); return; }
  const results = searchMatches(q).slice(0, 12);
  searchResults.innerHTML = results.length
    ? results.map((r) => `<li role="option" tabindex="-1" data-go="${r.kind}" data-id="${esc(r.id)}" data-label="${esc(r.label)}">${esc(r.label)}<span class="kind">${esc(r.meta)}</span></li>`).join('')
    : '<li class="none" role="option">No match</li>';
  searchResults.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
}
function chooseResult(li) {
  const kind = li.dataset.go, id = li.dataset.id, label = li.dataset.label;
  searchInput.value = '';
  hideSearch();
  if (kind === 'area' || (kind === 'fish' && id)) {
    centerOn(AREA_LAYOUT[id]);
    openArea(id);
  } else if (kind === 'fish') {
    showToast(`${label} is caught in the normal waters, not in a fishing area.`);
  } else if (kind === 'perk') {
    openBuilding(id);
  }
}
searchInput.addEventListener('input', renderSearch);
searchInput.addEventListener('keydown', (e) => {
  const items = [...searchResults.querySelectorAll('li[data-go]')];
  if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'Enter' && items.length) { e.preventDefault(); chooseResult(items[0]); }
  else if (e.key === 'Escape') { searchInput.value = ''; hideSearch(); }
});
searchResults.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-go]');
  if (li) chooseResult(li);
});
searchResults.addEventListener('keydown', (e) => {
  const items = [...searchResults.querySelectorAll('li[data-go]')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' && i < items.length - 1) { e.preventDefault(); items[i + 1].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) items[i - 1].focus(); else searchInput.focus(); }
  else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); chooseResult(items[i]); }
  else if (e.key === 'Escape') { searchInput.focus(); hideSearch(); }
});
searchInput.addEventListener('blur', () => setTimeout(() => { if (!searchResults.contains(document.activeElement)) hideSearch(); }, 150));

// ---------- Saved view (per browser; never required) ----------
const VIEW_KEY = 'fishing-map-view-v1';
function queueSaveView() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom, x: pos.x, y: pos.y })); } catch (e) { /* storage blocked: skip */ }
  }, 300);
}
function restoreView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    if (!v || !isFinite(v.zoom) || !isFinite(v.x) || !isFinite(v.y)) return false;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom));
    pos.x = v.x; pos.y = v.y;
    applyView();
    return true;
  } catch (e) { return false; }
}

// ---------- Pins, status and popup from the live data ----------
function buildPins() {
  const buildingPins = Object.entries(BUILDINGS).map(([id, b]) => `
    <button class="pin building" type="button" data-building="${id}" style="left:${(b.x / MAP_W * 100).toFixed(3)}%; top:${(b.y / MAP_H * 100).toFixed(3)}%" aria-label="${b.label}">
      <span class="icon">${spriteSVG(ICON_BITMAPS[b.icon])}</span>
      <span class="pin-badge">LOCKED</span>
      <span class="pin-name">${b.label}</span>
      <span class="status-badge" aria-hidden="true"></span>
    </button>`).join('');
  pinsLayer.innerHTML = buildingPins + Object.entries(AREA_LAYOUT).map(([id, a]) => `
    <button class="pin" type="button" data-id="${id}" style="left:${(a.px * 100).toFixed(3)}%; top:${(a.py * 100).toFixed(3)}%" aria-label="${id}">
      <span class="icon">${spriteSVG(ICON_BITMAPS[a.icon])}</span>
      <span class="pin-badge" data-level-text>LOCKED</span>
      <span class="pin-name" data-name>${id}</span>
      <span class="boat" role="button" tabindex="-1" aria-label="Leave this area">${BOAT_ICON}</span>
    </button>`).join('');
}
function render() {
  const d = areaData;
  const publicMode = d?.readOnly === true;
  root.classList.toggle('public-view', publicMode);
  $('emptyNote').hidden = !!d;
  if (d) {
    const dc = d.doubleCatch || { level: 0, chance: 0, points: 0 };
    const active = (d.areas || []).find((a) => a.id === d.active);
    $('treasuryValue').textContent = String(Number(d.treasury || 0));
    $('dcLevel').textContent = 'Lv.' + dc.level;
    $('dcChance').textContent = dc.chance + '% chance';
    $('dcFill').style.width = ((dc.level >= 5 ? 1 : (Number(dc.points || 0) % 3) / 3) * 100) + '%';
    $('dcSwitchCell').hidden = !(dc.level > 0);
    $('switchDouble').setAttribute('aria-checked', String(d.userDoubleEnabled !== false));
    $('switchFish').setAttribute('aria-checked', String(useAreas()));
    $('switchFish').disabled = d.areasEnabled === false;
    $('locationLabel').textContent = !useAreas() ? 'Areas off' : (active ? active.name : 'Normal waters');
    $('deselectBtn').disabled = !d.active;
  }
  pinsLayer.querySelectorAll('.pin[data-building]').forEach((b) => {
    const id = b.dataset.building;
    const locked = !publicMode && !!(d?.buildingLocked && d.buildingLocked[id]);
    b.classList.toggle('locked', locked);
    b.classList.toggle('selected', id === buildingOpen);
    const st = d?.buildingStatus?.[id];
    const show = !locked && !!st;
    b.classList.toggle('has-status', show);
    b.classList.toggle('status-dot', show && st === true);
    b.querySelector('.status-badge').textContent = show && st !== true ? String(st) : '';
    b.setAttribute('aria-label', `${BUILDINGS[id].label}${locked ? ', locked' : ''}${show ? (st === true ? ', needs attention' : `, ${st} unread`) : ''}`);
  });
  pinsLayer.querySelectorAll('.pin[data-id]').forEach((b) => {
    const id = b.dataset.id;
    const a = areaFor(id);
    const unlocked = publicMode || !!(a && a.unlocked);
    const level = publicMode ? 0 : Number(a?.level || 0);
    const disabled = !a || (!publicMode && (a.enabled === false || d?.areasEnabled === false));
    b.classList.toggle('locked', !unlocked);
    b.classList.toggle('disabled', disabled);
    b.classList.toggle('here', !!(a && a.id === d?.active && useAreas()));
    b.classList.toggle('selected', id === openId);
    b.classList.toggle('tutorial', id === tutorialId);
    b.querySelector('[data-level-text]').textContent = publicMode ? 'VIEW' : (unlocked ? `LV ${level}` : 'LOCKED');
    b.querySelector('[data-name]').textContent = a ? a.name : id;
    b.setAttribute('aria-label', `${a ? a.name : id}, ${publicMode ? 'public area guide' : (unlocked ? 'level ' + level : 'locked')}${id === tutorialId ? ', guide step' : ''}`);
  });
  if (openId) {
    if (areaFor(openId)) renderPopup(openId);
    else closePopup();
  }
}
function renderPopup(id) {
  const a = areaFor(id);
  const d = areaData;
  const publicMode = d?.readOnly === true;
  const unlocked = publicMode || !!a.unlocked;
  const level = Number(a.level || 0);
  const maxed = !publicMode && unlocked && level >= 5;
  const off = !publicMode && (d?.areasEnabled === false || a.enabled === false);
  const balance = Number(d?.treasury || 0);
  const cost = unlocked ? (maxed ? 0 : (a.levelCosts || [])[Math.max(0, level - 1)]) : a.unlockCost;
  const canPay = balance >= Number(cost || 0);
  const boosts = Object.entries(a.boost || {});
  const meter = [1, 2, 3, 4, 5].map((i) => `<span class="${i <= level ? 'on' : ''}"></span>`).join('');

  let action = '';
  let fish = '';
  let note = '';
  if (publicMode) {
    action = '<span class="public-area-label">Public area guide · read only</span>';
    note = 'Explore this area, view its boosts and browse the local catch list. Area purchases and personal fishing settings are available in the My Account tab.';
  } else {
    const busy = !!pending;
    const pend = pending && pending.areaId === id ? pending.action : null;
    if (off) action = '<button class="dex-toolbar-btn" type="button" disabled>Unavailable</button>';
    else if (!unlocked) action = `<button class="btn solid" type="button" data-action="buy" ${canPay && !busy ? '' : 'disabled'}>${pend === 'buy' ? 'Unlocking…' : 'Unlock · ' + cost}</button>`;
    else if (!maxed) action = `<button class="btn solid" type="button" data-action="upgrade" ${canPay && !busy ? '' : 'disabled'}>${pend === 'upgrade' ? 'Upgrading…' : 'Upgrade · ' + cost}</button>`;
    else action = '<button class="dex-toolbar-btn" type="button" disabled>Max level</button>';

    if (!off && unlocked) {
      fish = a.selected
        ? `<button class="dex-toolbar-btn" type="button" data-action="stop" ${busy ? 'disabled' : ''}>${pend === 'stop' ? 'Stopping…' : 'Stop fishing here'}</button>`
        : `<button class="btn solid" type="button" data-action="fish" style="font-size:.66rem;padding:8px 12px" ${useAreas() && !busy ? '' : 'disabled'}>${pend === 'fish' ? 'Selecting…' : 'Fish here'}</button>`;
    }
    if (off) note = 'This area is currently disabled.';
    else if (!useAreas()) note = 'Turn on "Use fishing areas" above the map to fish here.';
    else if (!canPay && !maxed) note = `Need ${cost} treasury items. You have ${balance}.`;
  }
  const preview = publicMode || maxed ? '' : `<div class="preview"><p class="popup-label">${unlocked ? 'Next level' : 'Unlock gives'}</p><div class="popup-stats"><span>Catch <b>${catchPct(unlocked ? level : 0)}% → ${catchPct(unlocked ? level + 1 : 1)}%</b></span><span>Boosts <b>${boosts.length}</b></span></div></div>`;
  const levelLabel = publicMode ? 'Public area' : (unlocked ? 'Level ' + level + ' / 5' : '· locked');
  const catchChance = safeNumber(a.catchChance, 8, 0, 100);
  const lootCount = Math.floor(safeNumber(a.lootCount, 0, 0, 10000));
  const catchLabel = publicMode ? (catchChance + '% base chance') : (unlocked ? catchChance + '%' : catchPct(1) + '%');

  const html = `
    <div class="popup-head">
      <h3 class="popup-title" id="popupTitle">${esc(a.name)}</h3>
      <button class="popup-close" type="button" aria-label="Close" data-action="close">×</button>
    </div>
    <p class="popup-desc">${esc(a.description || '')}</p>
    <p class="popup-label">${levelLabel}</p>
    ${publicMode ? '' : `<div class="level-meter" aria-hidden="true">${meter}</div>`}
    <div class="popup-stats"><span>${publicMode ? 'Base chance' : 'Catch'} <b>${catchLabel}</b></span><span>Catch pool <b>${lootCount}</b></span></div>
    ${boosts.length ? `<p class="popup-label">Area boosts</p><ul class="boost-list">${boosts.map(([n, v]) => `<li><span>${esc(n)}</span><span>+${esc(v)}</span></li>`).join('')}</ul>` : ''}
    ${fishGallery(id)}
    ${preview}
    <div class="popup-actions">${action}${fish}</div>
    ${note ? `<p class="popup-note">${esc(note)}</p>` : ''}`;
  if (popup._html === html) return;
  popup._html = html;
  popup.innerHTML = html;
}

// The fish list: a header row that opens and closes the list. Collapsed by default.
const fishOpen = {};          // areaId -> true while its fish list is expanded
function fishGallery(id) {
  const list = lootCache[id];
  const open = !!fishOpen[id];
  const head = (count) => `<button class="fish-toggle" type="button" data-action="fish-toggle" aria-expanded="${open}" aria-controls="fish-list"><span class="popup-label">Fish${count}</span><span class="fish-chevron" aria-hidden="true">${open ? '−' : '+'}</span></button>`;
  if (list === undefined) { requestLoot(id); return head('') + (open ? '<p class="popup-note">Loading fish…</p>' : ''); }
  if (list === null) return head('') + (open ? '<p class="popup-note">The fish list could not load. Open this area again to retry.</p>' : '');
  const rank = (t) => { const i = TIER_ORDER.indexOf(String(t).toUpperCase()); return i < 0 ? 99 : i; };
  const sorted = [...list].sort((x, y) => rank(x.tier) - rank(y.tier) || x.name.localeCompare(y.name));
  if (!open) return head(` · ${sorted.length}`);
  return head(` · ${sorted.length}`) + `<ul class="gallery" id="fish-list">${sorted.map((f) => `<li class="tile got"><span class="tile-name">${esc(f.name)}</span><span class="tile-tier">${esc(f.tier)}</span></li>`).join('')}</ul>`;
}
function requestLoot(id) {
  if (lootAsked[id]) return;
  lootAsked[id] = true;
  parentPost({ type: 'wm-loot-request', areaId: id });
}

function openArea(id) {
  if (!AREA_LAYOUT[id]) return;
  dismissBuilding();
  if (lootCache[id] === null) { delete lootCache[id]; delete lootAsked[id]; }   // retry a failed list
  openId = id;
  fishOpen[id] = false;         // the fish list always starts collapsed
  popup._html = null;
  render();
  popup.classList.add('open');
  placePopup(id);
  popup.focus({ preventScroll: true });
}
function closePopup() {
  if (!popup.classList.contains('open')) return;
  popup.classList.remove('open');
  arrow.classList.remove('open');
  openId = null;
  popup._html = null;
  pinsLayer.querySelectorAll('.pin.selected').forEach((b) => b.classList.remove('selected'));
}
// Next to its pin: right if there is room, otherwise left. Small screens get a bottom sheet.
function placePopup(id) {
  const a = AREA_LAYOUT[id];
  const w = win.clientWidth, h = win.clientHeight;
  const ax = pos.x + a.px * MAP_W * zoom, ay = pos.y + a.py * MAP_H * zoom;
  if (w < 560) {
    popup.classList.add('sheet');
    popup.style.left = '0px'; popup.style.right = '0px'; popup.style.width = '';
    popup.style.top = ''; popup.style.bottom = '0px';
    arrow.classList.remove('open');
    return;
  }
  popup.classList.remove('sheet');
  popup.style.right = ''; popup.style.bottom = '';
  const pw = Math.min(300, w - 16);
  popup.style.width = pw + 'px';
  const ph = popup.offsetHeight;
  const rightRoom = w - (ax + GAP + pw) >= 8;
  const side = rightRoom ? 'right' : 'left';
  let left = rightRoom ? ax + GAP : ax - GAP - pw;
  left = Math.max(8, Math.min(left, w - pw - 8));
  const top = Math.max(8, Math.min(ay - 40, h - ph - 8));
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  const ay2 = Math.max(top + 14, Math.min(ay, top + ph - 14));
  arrow.className = `popup-arrow ${side} open`;
  arrow.style.left = (side === 'right' ? left - 7 : left + pw) + 'px';
  arrow.style.top = (ay2 - 7) + 'px';
}
// Buttons in the popup ask the embedding page to run the real action.
popup.addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled || !openId) return;
  const action = btn.dataset.action;
  if (action === 'close') { closePopup(); return; }
  if (action === 'fish-toggle') { fishOpen[openId] = !fishOpen[openId]; popup._html = null; render(); return; }
  if (areaData?.readOnly === true) return;
  if (pending && action !== 'close' && action !== 'loot') return;
  if (action === 'buy' || action === 'upgrade') sendAction({ type: 'wm-action', action, areaId: openId }, '', busyLabelFor(action, openId));
  else if (action === 'fish') sendAction({ type: 'wm-action', action: 'select', areaId: openId }, '', busyLabelFor('fish', openId));
  else if (action === 'stop') sendAction({ type: 'wm-action', action: 'select', areaId: null }, '', 'Deselecting…');
  else if (action === 'loot') parentPost({ type: 'wm-action', action: 'loot', areaId: openId });
});

// The guide's area step: a pulsing pin, and the map moves to show it once.
function setTutorial(id) {
  const next = AREA_LAYOUT[id] ? id : null;
  if (next === tutorialId) return;
  tutorialId = next;
  if (!next) tutorialCentered = null;
  else if (next !== tutorialCentered) {
    tutorialCentered = next;
    if (!openId) centerOn(AREA_LAYOUT[next]);
  }
  render();
}
// A direct checklist action must re-center even if Forest was already highlighted,
// or another area's popup is open. This makes repeated clicks reliable.
function focusGuideArea(id) {
  const next = AREA_LAYOUT[id] ? id : null;
  if (!next) return;
  if (tutorialId !== next) {
    tutorialId = next;
    render();
  }
  tutorialCentered = next;
  centerOn(AREA_LAYOUT[next]);
}

// ---------- Sea lanes: artwork ships sail along the waterways, edge to edge ----------
// SEA-NETWORK-LOGIC-BEGIN
const MAX_BOATS = 6;      // boats on screen at once
const MAX_DECISIONS = 2;  // route choices a boat may make at junctions; after that it leaves by the shortest way
function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
// Builds the graph, and for each junction the edge that leads to the nearest exit (a border point).
function buildSeaNetwork() {
  const nodes = {};
  for (const id in SEA_NODES) nodes[id] = { id, ...SEA_NODES[id], edges: [] };
  const edges = SEA_EDGES.map((d, i) => {
    const e = { id: i, a: nodes[d.a], b: nodes[d.b], pts: d.pts, len: polyLength(d.pts), el: null };
    e.a.edges.push(e);
    e.b.edges.push(e);
    return e;
  });
  const dist = {}, nextEdge = {}, done = new Set();
  for (const id in nodes) dist[id] = nodes[id].border ? 0 : Infinity;
  for (;;) {
    let cur = null;
    for (const id in nodes) if (!done.has(id) && dist[id] < Infinity && (cur === null || dist[id] < dist[cur])) cur = id;
    if (cur === null) break;
    done.add(cur);
    for (const e of nodes[cur].edges) {
      const other = e.a === nodes[cur] ? e.b : e.a;
      if (other.harbor || done.has(other.id)) continue;
      const d = dist[cur] + e.len;
      if (d < dist[other.id]) { dist[other.id] = d; nextEdge[other.id] = e; }
    }
  }
  return { nodes, edges, nextEdge };
}
// At a junction the boat picks a random onward edge (not the one it came in on) while it has choices left.
// Then it takes the shortest way to an exit. In the harbor it turns round.
function chooseSeaExit(boat, node, net) {
  if (node.harbor) return boat.edge;
  const options = node.edges.filter((e) => e !== boat.edge);
  if (!options.length) return boat.edge;
  if (!boat.forced && boat.decisions < MAX_DECISIONS) {
    boat.decisions++;
    return options[Math.floor(Math.random() * options.length)];
  }
  boat.forced = true;
  return net.nextEdge[node.id];
}
// Moves a boat along its edge. Returns false once it has reached a border exit.
function advanceSeaBoat(b, dt, now, net) {
  if (b.restUntil > now) return true;
  if (b.restUntil) b.restUntil = 0;
  b.s += dt * b.speed * b.dir;
  if (b.dir === 1 ? b.s >= b.edge.len : b.s <= 0) {
    const node = b.dir === 1 ? b.edge.b : b.edge.a;
    b.s = b.dir === 1 ? b.edge.len : 0;
    if (node.border) return false;
    if (node.harbor) { b.restUntil = now + 6000 + Math.random() * 3000; b.forced = true; }
    const next = chooseSeaExit(b, node, net);
    b.edge = next;
    b.dir = next.a === node ? 1 : -1;
    b.s = b.dir === 1 ? 0 : next.len;
  }
  return true;
}

const SEA_NODES = {
  b1: { x: 24.3, y: 78.2, border: true },
  b2: { x: 801.7, y: 16.2, border: true },
  b3: { x: 1203.2, y: 21.6, border: true },
  b4: { x: 1385.1, y: 417.8, border: true },
  b5: { x: 24.3, y: 943.4, border: true },
  b6: { x: 24.3, y: 1115.9, border: true },
  b7: { x: 1273.3, y: 1361.1, border: true },
  X1: { x: 606.3, y: 377.3 },
  X2: { x: 788.2, y: 539.1 },
  X3: { x: 875.8, y: 749.3 },
  X4: { x: 927.0, y: 761.4 },
  JR: { x: 1219.4, y: 1273.5 },
  HB: { x: 959.3, y: 1269.5, harbor: true }
};
const SEA_EDGES = [
  { a: 'b1', b: 'X1', pts: [[24.3, 78.2], [107.8, 148.2], [202.1, 215.6], [336.8, 269.5], [471.6, 312.7], [606.3, 377.3]] },
  { a: 'X1', b: 'X2', pts: [[606.3, 377.3], [673.7, 451.5], [734.3, 498.6], [788.2, 539.1]] },
  { a: 'X2', b: 'X3', pts: [[788.2, 539.1], [821.9, 619.9], [855.6, 694.0], [875.8, 749.3]] },
  { a: 'b2', b: 'X1', pts: [[801.7, 16.2], [792.3, 94.3], [761.3, 202.1], [687.2, 289.7], [606.3, 377.3]] },
  { a: 'X1', b: 'b5', pts: [[606.3, 377.3], [485.1, 491.9], [377.3, 593.0], [269.5, 700.8], [175.2, 808.6], [94.3, 896.2], [24.3, 943.4]] },
  { a: 'b3', b: 'X2', pts: [[1203.2, 21.6], [1259.8, 80.9], [1256.2, 205.2], [1229.5, 244.9], [1202.9, 278.0], [1162.9, 303.1], [1096.3, 325.6], [1029.7, 344.2], [963.1, 358.7], [909.8, 377.2], [863.2, 403.7], [828.6, 443.4], [803.2, 476.5], [786.6, 507.6], [788.2, 539.1]] },
  { a: 'b4', b: 'X4', pts: [[1385.1, 417.8], [1370.7, 431.5], [1329.4, 458.0], [1282.8, 487.8], [1229.5, 522.9], [1162.9, 563.9], [1096.3, 602.3], [1043.0, 633.4], [989.7, 663.2], [936.5, 689.6], [927.0, 761.4]] },
  { a: 'b6', b: 'X3', pts: [[24.3, 1115.9], [94.3, 1084.9], [175.2, 1024.2], [235.8, 943.4], [323.4, 876.0], [458.1, 815.3], [606.3, 776.2], [754.5, 757.4], [875.8, 749.3]] },
  { a: 'X3', b: 'X4', pts: [[875.8, 749.3], [927.0, 761.4]] },
  { a: 'X4', b: 'JR', pts: [[927.0, 761.4], [1037.5, 778.9], [1145.3, 822.1], [1205.9, 889.5], [1236.9, 983.8], [1246.3, 1105.1], [1236.9, 1212.9], [1219.4, 1273.5]] },
  { a: 'JR', b: 'b7', pts: [[1219.4, 1273.5], [1253.1, 1314.0], [1273.3, 1361.1]] },
  { a: 'JR', b: 'HB', pts: [[1219.4, 1273.5], [1158.7, 1314.0], [1077.9, 1339.6], [1026.7, 1315.3], [980.9, 1293.8], [959.3, 1269.5]] }
];
// SEA-NETWORK-LOGIC-END
const SHIP_SRC = 'data:image/png;base64,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';
const SHIP_SPEED = 9;      // map units per second (each boat varies a little around this)
const SHIP_SCALE = 0.75;
const SVG_NS = 'http://www.w3.org/2000/svg';
function routeOpenD(pts) {
  const n = pts.length, segs = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n - 1)];
    segs.push(`C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ` +
              `${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0]},${p2[1]}`);
  }
  return `M${pts[0][0]},${pts[0][1]} ` + segs.join(' ');
}
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
const seaSvg = $('seaLanes');
const boatRuns = [];
let seaPausedUntil = 0, lastTick = null;
function pauseSea(ms) {
  seaPausedUntil = performance.now() + ms;
  seaSvg.classList.add('is-still');   // stops the wake animation while the map is being resized
}
let seaNet = null;
const seaBoats = [];
let spawnAt = 0;
function buildSeaLanes() {
  seaSvg.innerHTML = '';
  seaNet = buildSeaNetwork();
  seaNet.edges.forEach((e) => {
    e.el = svgEl('path', { id: 'sea-' + e.id, d: routeOpenD(e.pts), class: 'lane' });
    seaSvg.appendChild(e.el);
    e.len = e.el.getTotalLength();
  });
  const mark = svgEl('g', { class: 'harbor-mark', 'aria-hidden': 'true' });
  mark.appendChild(svgEl('circle', { cx: HARBOR.x, cy: HARBOR.y, r: 10, class: 'harbor-ring' }));
  mark.appendChild(svgEl('circle', { cx: HARBOR.x, cy: HARBOR.y, r: 2.5, class: 'harbor-dot' }));
  const harborLayer = $('harborLayer');
  harborLayer.innerHTML = '';
  harborLayer.appendChild(mark);
  seaBoats.length = 0;
  for (let i = 0; i < 3; i++) spawnSeaBoat();
  spawnAt = performance.now() + 2500;
  placeBoats(0, true);
  requestAnimationFrame(tick);
}
function spawnSeaBoat() {
  const exits = Object.values(seaNet.nodes).filter((n) => n.border);
  const node = exits[Math.floor(Math.random() * exits.length)];
  const edge = node.edges[0];
  const boat = svgEl('g', { class: 'sea-boat' });
  const wake = svgEl('g', { class: 'wake' });
  wake.appendChild(svgEl('path', { d: 'M-9,-2 L-25,-9', class: 'wake-line' }));
  wake.appendChild(svgEl('path', { d: 'M-9,2 L-25,9', class: 'wake-line w2' }));
  wake.appendChild(svgEl('path', { d: 'M-12,0 L-30,0', class: 'wake-line w3' }));
  const hull = svgEl('g', { class: 'hull' });
  hull.appendChild(svgEl('image', {
    href: SHIP_SRC,
    x: (-18.5 * SHIP_SCALE).toFixed(2), y: (-26.5 * SHIP_SCALE).toFixed(2),
    width: (48 * SHIP_SCALE).toFixed(2), height: (46 * SHIP_SCALE).toFixed(2),
  }));
  boat.appendChild(wake);
  boat.appendChild(hull);
  seaSvg.appendChild(boat);
  seaBoats.push({
    boat, wake, hull, angle: null,
    edge, dir: edge.a === node ? 1 : -1, s: edge.a === node ? 0 : edge.len,
    decisions: 0, forced: false, restUntil: 0,
    speed: SHIP_SPEED * (0.85 + Math.random() * 0.3),
  });
}
function placeBoats(dt, first) {
  if (!seaNet) return;
  const now = performance.now();
  if (seaBoats.length < MAX_BOATS && now >= spawnAt) {
    spawnSeaBoat();
    spawnAt = now + 2500 + Math.random() * 3000;
  }
  for (let i = seaBoats.length - 1; i >= 0; i--) {
    const b = seaBoats[i];
    if (!advanceSeaBoat(b, dt, now, seaNet)) {
      b.boat.remove();
      seaBoats.splice(i, 1);
      continue;
    }
    const resting = b.restUntil > now;
    const e = b.edge;
    const p = e.el.getPointAtLength(b.s);
    const ahead = e.el.getPointAtLength(Math.max(0, Math.min(e.len, b.s + 1.5 * b.dir)));
    const behind = e.el.getPointAtLength(Math.max(0, Math.min(e.len, b.s - 1.5 * b.dir)));
    const target = Math.atan2(ahead.y - behind.y, ahead.x - behind.x);
    if (b.angle === null) b.angle = target;
    let diff = target - b.angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    b.angle += diff * (first ? 1 : 0.12);
    const deg = b.angle * 180 / Math.PI;
    const flip = Math.cos(b.angle) > 0 ? -1 : 1;
    // fade in when leaving a border exit and out when reaching one; harbor boats stay visible
    let fade = 1;
    if ((b.dir === 1 ? e.a : e.b).border) fade = Math.min(fade, b.s / 30);
    if ((b.dir === 1 ? e.b : e.a).border) fade = Math.min(fade, (e.len - b.s) / 30);
    fade = Math.max(0, Math.min(1, fade));
    b.boat.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
    b.boat.setAttribute('opacity', fade.toFixed(3));
    b.wake.setAttribute('transform', `rotate(${deg.toFixed(2)})`);
    b.wake.setAttribute('opacity', resting ? '0' : '1');
    b.hull.setAttribute('transform', `scale(${flip} 1)`);
  }
}
function tick(now) {
  const dt = lastTick === null ? 0 : Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
  if (now >= seaPausedUntil) {
    seaSvg.classList.remove('is-still');
    placeBoats(dt, false);
  }
  requestAnimationFrame(tick);
}

// ---------- Expand: the embedding page makes this frame fill the screen ----------
function setExpandedLabel() {
  expandBtn.textContent = expanded ? 'Collapse' : 'Expand';
  expandBtn.setAttribute('aria-expanded', String(expanded));
}
expandBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  parentPost({ type: 'wm-expand', on: !expanded });
});

// ---------- Messages with the hosting Twitch Component ----------
window.addEventListener('fishingbot:map-data', (e) => {
  const m = e.detail || {};
  if (m.type === 'wm-data') {
    areaData = normalizeMapData(m.data);
    render();
    if (!areaData) showToast('The world map data was invalid. Refresh the map and try again.');
  }
  else if (m.type === 'wm-expanded') { expanded = !!m.on; setExpandedLabel(); }
  else if (m.type === 'wm-tutorial') { setTutorial(m.areaId || null); }
  else if (m.type === 'wm-focus-area') { focusGuideArea(m.areaId || null); }
  else if (m.type === 'wm-done') { finishPending(m.message); }
  else if (m.type === 'wm-action-error') { failPending(m.message); }
  else if (m.type === 'wm-open-building') {
    const pin = pinsLayer.querySelector(`.pin[data-building="${m.id}"]`);
    if (pin && BUILDINGS[m.id]) openBuilding(m.id, pin);
  }
  else if (m.type === 'wm-building-closed') { if (m.id === buildingOpen) { buildingOpen = null; render(); } }
  else if (m.type === 'wm-loot') {
    if (typeof m.areaId === 'string' && Object.prototype.hasOwnProperty.call(AREA_LAYOUT, m.areaId)) {
      lootCache[m.areaId] = normalizeLoot(m.loot);
    }
    if (openId === m.areaId) { popup._html = null; render(); }
  }
});

// ---------- Start ----------
buildPins();
buildSeaLanes();
centerOnFirstVisible = !restoreView();
if (centerOnFirstVisible) {
  zoom = DEFAULT_ZOOM;
  applyView();
}
setExpandedLabel();
// On narrow screens the fishing status starts folded, so the map keeps most of the height.
if (window.innerWidth < 560) {
  $('menuToggle').setAttribute('aria-expanded', 'false');
  $('menuBody').hidden = true;
  $('menuChev').textContent = '▸';
}
window.__fishingbotMapReady = true;
parentPost({ type: 'wm-ready' });
