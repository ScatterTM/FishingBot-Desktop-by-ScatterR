/* World map for the Fishing Areas panel.
 * The map runs in its own frame (/world-map/map.html) so its artwork and styles stay separate.
 * This file mounts that frame, sends it the live area data from /api/areas, turns its requests into
 * the same purchase and select actions the area cards use, and points the map at the guide's area step. */
(function () {
  'use strict';

  var FRAME_SRC = '/world-map/map.html?v=20';
  var GAP = 22;            // popup distance from the pin centre (same as the area popups)
  var SHEET_BELOW = 560;   // below this width the building popup becomes a bottom sheet
  var TUTORIAL_KEY = 'first-area';
  var frame = null, wrap = null, host = null, frameReady = false, latest = null, expanded = false;
  var pendingBuilding = null;
  var tutorialAreaId = null;
  var guideFocusAreaId = null;
  var pendingFocusAreaId = null;
  var LOAD_TIMEOUT_MS = 12000;
  var loadTimer = null;

  var CSS = [
    '.wm-frame { position: relative; height: 680px; margin: 0 0 16px; border: 1px solid rgba(237,232,220,.12); background: #0d3b4a; overflow: hidden; }',
    '.wm-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; touch-action: none; }',
    '.wm-frame .wm-loading { position: absolute; inset: 0; z-index: 2; background: #0d3b4a; display: grid; place-items: center; text-align: center; font-family: var(--font-mono, monospace); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: rgba(237,232,220,.6); }',
    '.wm-frame .wm-loading a { color: #E4572E; }',
    '.wm-frame.wm-failed iframe { display: none; }',
    '.wm-frame.tutorial-target { outline: 2px solid #E4572E; outline-offset: 3px; }',
    '.wm-frame.is-expanded { position: fixed; inset: 0; z-index: 9000; height: auto; border: 0; margin: 0; background: #0F1513; }',
    'body.wm-expanded { overflow: hidden; }',
    '@media (max-width: 560px) { .wm-frame { height: 460px; } }',
    /* Building popup: drawn over the map, next to the building's pin. Same look as the area popups. */
    '.wb-popup { position: absolute; z-index: 10; display: none; flex-direction: column; width: 810px; max-width: calc(100% - 16px); max-height: calc(100% - 16px); background: var(--panel, #131A18); border: 1px solid rgba(237,232,220,.12); color: var(--bone, #EDE8DC); outline: none; box-sizing: border-box; }',
    '.wb-popup.open { display: flex; }',
    '.wb-popup.is-sheet { position: fixed; left: 0; right: 0; bottom: 0; top: auto; width: auto; max-width: none; max-height: 84vh; z-index: 50; border-left: 0; border-right: 0; border-bottom: 0; padding-bottom: env(safe-area-inset-bottom, 0px); }',
    '.wb-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid rgba(237,232,220,.12); flex: 0 0 auto; }',
    '.wb-kicker { font-family: var(--font-mono, monospace); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: rgba(237,232,220,.4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }',
    '.wb-actions { display: flex; gap: 14px; align-items: center; flex: 0 0 auto; }',
    '.wb-btn { background: none; border: 0; border-bottom: 1px solid rgba(237,232,220,.24); color: rgba(237,232,220,.4); font-family: var(--font-mono, monospace); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; padding: 6px 2px; cursor: pointer; }',
    '.wb-btn:hover, .wb-btn:focus-visible { color: #E4572E; border-bottom-color: #E4572E; outline: none; }',
    '.wb-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 18px 22px 24px; box-sizing: border-box; }',
    '.wb-body .hub-panel { width: 100%; max-width: none; min-width: 0; box-sizing: border-box; }',
    '.wb-body .shop-grid { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0; min-width: 0; }',
    '.wb-body .shop-item-card { min-width: 0; overflow-wrap: anywhere; }',
    '.wb-body .shop-item-name, .wb-body .shop-item-desc, .wb-body .channel-perk-copy { min-width: 0; overflow-wrap: anywhere; }',
    '.wb-body .shop-item-footer { flex-wrap: wrap; align-items: center; row-gap: 8px; }',
    '@media (max-width: 820px) and (min-width: 561px) { .wb-popup { width: calc(100% - 16px); } .wb-body { padding-left: 16px; padding-right: 16px; } }',
    '.wb-arrow { position: absolute; width: 0; height: 0; z-index: 11; display: none; pointer-events: none; border-style: solid; }',
    '.wb-arrow.open { display: block; }',
    '.wb-arrow.right { border-width: 7px 7px 7px 0; border-color: transparent rgba(237,232,220,.24) transparent transparent; }',
    '.wb-arrow.left { border-width: 7px 0 7px 7px; border-color: transparent transparent transparent rgba(237,232,220,.24); }',
    '.wb-arrow.up { border-width: 0 7px 7px 7px; border-color: transparent transparent rgba(237,232,220,.24) transparent; }',
    '.wb-arrow.down { border-width: 7px 7px 0 7px; border-color: rgba(237,232,220,.24) transparent transparent transparent; }'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById('wmFrameStyle')) return;
    var style = document.createElement('style');
    style.id = 'wmFrameStyle';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function failMessage() {
    return 'Map did not load.<br><a href="' + FRAME_SRC + '" target="_blank" rel="noopener">Open the map in a new tab</a>';
  }

  function mount() {
    if (frame) return true;
    host = document.getElementById('hubPanel-areas');
    var grid = document.getElementById('fishingAreasGrid');
    if (!host || !grid) return false;
    injectStyle();
    wrap = document.createElement('div');
    wrap.className = 'wm-frame';
    wrap.id = 'worldMapFrame';
    wrap.innerHTML = '<div class="wm-loading" aria-hidden="true">Loading map…</div>';
    frame = document.createElement('iframe');
    frame.src = FRAME_SRC;
    frame.title = 'Fishing area map';
    wrap.appendChild(frame);
    // The map replaces the old summary, switch and deselect rows, so it sits directly above the grid.
    host.insertBefore(wrap, grid);
    armLoadTimer();
    return true;
  }

  // The map counts as failed only while it is on screen. A frame mounted behind another hub waits,
  // and the timer starts again when the Areas tab is shown (onTabSwitch).
  function isShown() { return !!wrap && wrap.getClientRects().length > 0; }
  function armLoadTimer() {
    clearTimeout(loadTimer);
    if (frameReady) return;
    loadTimer = setTimeout(function () {
      if (frameReady) return;
      if (!isShown()) return;   // waits for the Areas tab
      showLoadFailure();
    }, LOAD_TIMEOUT_MS);
  }
  function showLoadFailure() {
    wrap.classList.add('wm-failed');
    var box = wrap.querySelector('.wm-loading');
    if (!box) { box = document.createElement('div'); box.className = 'wm-loading'; wrap.appendChild(box); }
    box.innerHTML = failMessage();
    // The map is not coming, so show the area cards as the fallback.
    if (typeof renderFishingAreas === 'function' && latest) renderFishingAreas(latest);
  }

  /* ---------- Building popups ----------------------------------------------
     A building opens its existing hub panel (the same element, with the same IDs and
     handlers) inside a popup over the map. The panel goes back to its place when the
     popup closes. The World Map panel stays visible behind the popup. */
  var wbPopup = null, wbArrow = null, wbOpen = null;   // wbOpen: { id, hub, panel, mark }

  function ensurePopup() {
    if (wbPopup || !wrap) return;
    wbPopup = document.createElement('div');
    wbPopup.className = 'wb-popup';
    wbPopup.id = 'worldBuildingPopup';
    wbPopup.setAttribute('role', 'dialog');
    wbPopup.setAttribute('aria-modal', 'false');
    wbPopup.setAttribute('aria-labelledby', 'worldBuildingKicker');
    wbPopup.tabIndex = -1;
    wbPopup.innerHTML =
      '<div class="wb-head">' +
        '<span class="wb-kicker" id="worldBuildingKicker"></span>' +
        '<span class="wb-actions">' +
          '<button class="wb-btn" type="button" data-wb="refresh">Refresh</button>' +
          '<button class="wb-btn" type="button" data-wb="close">Close</button>' +
        '</span>' +
      '</div>' +
      '<div class="wb-body" id="worldBuildingBody"></div>';
    wbPopup.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-wb]');
      if (!btn) return;
      if (btn.dataset.wb === 'close') closeBuilding();
      else if (btn.dataset.wb === 'refresh' && typeof window.refreshCurrentHub === 'function') window.refreshCurrentHub();
    });
    wbPopup.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeBuilding(); });
    wbArrow = document.createElement('span');
    wbArrow.className = 'wb-arrow';
    wbArrow.setAttribute('aria-hidden', 'true');
    wrap.appendChild(wbPopup);
    wrap.appendChild(wbArrow);
  }

  function setBackBar(show) {
    var bar = document.getElementById('worldBackBar');
    if (bar) bar.hidden = !show;
  }

  // Horizontal popup: as wide as the map allows (up to a cap), short, and placed just
  // below the pin, or above it when there is more room up there. Small screens get a bottom sheet.
  // (x, y) is the pin's centre in the map frame's own coordinates.
  var WB_MAX_W = 1040, WB_MAX_H = 600;
  function placePopup(x, y) {
    if (!wbPopup || !wrap || !frame) return;
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (w < SHEET_BELOW) {
      wbPopup.classList.add('is-sheet');
      wbPopup.style.left = ''; wbPopup.style.top = ''; wbPopup.style.width = ''; wbPopup.style.maxHeight = '';
      wbArrow.classList.remove('open');
      return;
    }
    wbPopup.classList.remove('is-sheet');
    // The frame fills the wrap's padding box, so this offset is normally zero. It is measured anyway.
    var fr = frame.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    var ax = x + (fr.left - (wr.left + wrap.clientLeft));
    var ay = y + (fr.top - (wr.top + wrap.clientTop));
    var pw = Math.min(WB_MAX_W, w - 16);
    wbPopup.style.width = pw + 'px';
    wbPopup.style.maxHeight = Math.min(WB_MAX_H, h - 16) + 'px';
    var ph = wbPopup.offsetHeight;
    var below = (h - ay) >= ay;
    var top = below ? ay + GAP : ay - GAP - ph;
    top = Math.max(8, Math.min(top, h - ph - 8));
    var left = Math.max(8, Math.min(ax - pw / 2, w - pw - 8));
    wbPopup.style.left = left + 'px';
    wbPopup.style.top = top + 'px';
    var arrowX = Math.max(left + 14, Math.min(ax, left + pw - 14));
    wbArrow.className = 'wb-arrow ' + (below ? 'up' : 'down') + ' open';
    wbArrow.style.left = (arrowX - 7) + 'px';
    wbArrow.style.top = (below ? top - 7 : top + ph) + 'px';
  }

  // Puts the panel back where it was in the page (the comment marks its place).
  function restoreBuilding() {
    if (!wbOpen) return;
    var p = wbOpen.panel, mark = wbOpen.mark;
    p.classList.remove('active');
    if (mark && mark.parentNode) {
      mark.parentNode.insertBefore(p, mark);
      mark.parentNode.removeChild(mark);
    }
    wbOpen = null;
  }

  function showBuilding(id, hub, label, x, y) {
    var panel = document.getElementById('hubPanel-' + hub);
    var areas = document.getElementById('hubPanel-areas');
    if (!panel || !areas || !wrap) return;
    ensurePopup();
    if (wbOpen && wbOpen.panel !== panel) restoreBuilding();
    if (!wbOpen) {
      var mark = document.createComment('building-home:' + hub);
      panel.parentNode.insertBefore(mark, panel);
      document.getElementById('worldBuildingBody').appendChild(panel);
      wbOpen = { id: id, hub: hub, panel: panel, mark: mark };
    }
    wbOpen.id = id;
    panel.classList.add('active');
    areas.classList.add('active');   // the map stays on screen behind the popup
    document.querySelectorAll('.hub-nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.hub === 'areas'); });
    setBackBar(false);
    document.getElementById('worldBuildingKicker').textContent = 'Tides Kingdom \u00b7 ' + (label || hub);
    wbPopup.classList.add('open');
    placePopup(x, y);
    wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    wbPopup.focus({ preventScroll: true });
  }

  function closeBuilding() {
    if (!wbOpen) return;
    var id = wbOpen.id;
    restoreBuilding();
    if (wbPopup) wbPopup.classList.remove('open', 'is-sheet');
    if (wbArrow) wbArrow.classList.remove('open');
    post({ type: 'wm-building-closed', id: id });
  }

  // Called by the page whenever a hub tab is shown. Any other tab closes the popup,
  // so a panel is never left inside it when its tab is not open.
  function onTabSwitch(tab) {
    // Showing the Areas tab again: if the map never loaded, retry it now.
    if (tab === 'areas' && frame && !frameReady && wrap) {
      if (wrap.classList.contains('wm-failed')) {
        wrap.classList.remove('wm-failed');
        var box = wrap.querySelector('.wm-loading');
        if (box) box.textContent = 'Loading map…';
        frame.src = FRAME_SRC;
      }
      armLoadTimer();
    }
    if (!wbOpen) return;
    if (tab !== wbOpen.hub) { closeBuilding(); return; }
    var areas = document.getElementById('hubPanel-areas');
    if (areas) areas.classList.add('active');
    setBackBar(false);
  }

  // Lock state of each building in the Tides Kingdom, from the main page (worldBuildingLocked in index-app.js).
  var BUILDING_IDS = ['trading', 'mail', 'index', 'achievements', 'perks', 'autofish', 'shop', 'pond'];
  function withBuildings(data) {
    var out = Object.assign({}, data || {});
    var locked = {};
    BUILDING_IDS.forEach(function (id) {
      locked[id] = typeof window.worldBuildingLocked === 'function' ? !!window.worldBuildingLocked(id) : false;
    });
    out.buildingLocked = locked;
    out.buildingStatus = typeof window.worldBuildingStatus === 'function' ? window.worldBuildingStatus() : {};
    return out;
  }

  function post(msg) {
    if (frameReady && frame && frame.contentWindow) frame.contentWindow.postMessage(msg, location.origin);
  }

  // The guide's area step: highlight the map pin and make the map itself the page target.
  // The six-step checklist can request a one-off focus even when the old tutorial is inactive.
  function applyTutorial() {
    if (!wrap) return;
    var activeAreaId = guideFocusAreaId || tutorialAreaId;
    var on = !!activeAreaId && frameReady;
    wrap.classList.toggle('tutorial-target', on);
    if (on) wrap.setAttribute('data-guide-target', TUTORIAL_KEY);
    else wrap.removeAttribute('data-guide-target');
    if (on && pendingFocusAreaId && pendingFocusAreaId === guideFocusAreaId) {
      // Force-centre first so the follow-up tutorial update does not centre twice.
      post({ type: 'wm-focus-area', areaId: pendingFocusAreaId });
      pendingFocusAreaId = null;
    }
    post({ type: 'wm-tutorial', areaId: activeAreaId });
    // The original step hint may also need to rebind to the live map frame.
    if (on && typeof window.tutorialAfterRender === 'function') window.tutorialAfterRender();
  }

  function runAction(m) {
    var result = null;
    if (m.action === 'buy' || m.action === 'upgrade') {
      if (typeof buyFishingArea === 'function') result = buyFishingArea(m.areaId, m.action);
    } else if (m.action === 'select') {
      if (typeof selectFishingArea === 'function') result = selectFishingArea(m.areaId || null);
    } else if (m.action === 'toggle-areas') {
      if (typeof toggleAreaFeature === 'function') result = toggleAreaFeature('toggleAreas', !!m.enabled);
    } else if (m.action === 'toggle-double') {
      if (typeof toggleAreaFeature === 'function') result = toggleAreaFeature('toggleDouble', !!m.enabled);
    } else if (m.action === 'loot') {
      // The fish list is a modal on the page, so leave the full-screen map first.
      if (expanded) setExpanded(false);
      if (typeof openAreaLootModal === 'function') openAreaLootModal(m.areaId);
      return;
    }
    // Tell the map when the request has finished, so its button and notice can clear.
    Promise.resolve(result).catch(function () {}).then(function () {
      post({ type: 'wm-done', action: m.action, areaId: m.areaId || null });
    });
  }

  // The fish list comes from the same loot data the on-page fish list uses; it is loaded on demand.
  function sendLoot(areaId) {
    var load = typeof ensureAreaLoot === 'function' ? ensureAreaLoot() : Promise.resolve(false);
    Promise.resolve(load).then(function (ok) {
      var areas = ok && typeof fishingAreasData !== 'undefined' && fishingAreasData ? fishingAreasData.areas || [] : [];
      var area = areas.find(function (a) { return a.id === areaId; });
      var loot = area && Array.isArray(area.loot)
        ? area.loot.map(function (item) { return { name: String(item.name || ''), tier: String(item.tier || '') }; })
        : null;
      post({ type: 'wm-loot', areaId: areaId, loot: loot });
    }).catch(function () {
      post({ type: 'wm-loot', areaId: areaId, loot: null });
    });
  }

  function setExpanded(on) {
    closeBuilding();
    expanded = !!on;
    if (wrap) wrap.classList.toggle('is-expanded', expanded);
    document.body.classList.toggle('wm-expanded', expanded);
    post({ type: 'wm-expanded', on: expanded });
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow) return;
    var m = e.data || {};
    if (m.type === 'wm-ready') {
      frameReady = true;
      clearTimeout(loadTimer);
      if (wrap) wrap.classList.remove('wm-failed');
      var loading = wrap && wrap.querySelector('.wm-loading');
      if (loading) loading.remove();
      if (latest) post({ type: 'wm-data', data: withBuildings(latest) });
      post({ type: 'wm-expanded', on: expanded });
      applyTutorial();
      if (pendingBuilding) { var pb = pendingBuilding; pendingBuilding = null; post({ type: 'wm-open-building', id: pb }); }
    } else if (m.type === 'wm-building') {
      // The page switches to the building's hub (it returns the hub name), then the popup shows it.
      var hub = typeof window.openWorldBuilding === 'function' ? window.openWorldBuilding(String(m.id || '')) : false;
      if (hub) showBuilding(String(m.id), String(hub), String(m.label || ''), Number(m.x) || 0, Number(m.y) || 0);
    } else if (m.type === 'wm-anchor') {
      if (wbOpen && m.id === wbOpen.id) placePopup(Number(m.x) || 0, Number(m.y) || 0);
    } else if (m.type === 'wm-dismiss') {
      closeBuilding();
    } else if (m.type === 'wm-action') {
      runAction(m);
    } else if (m.type === 'wm-expand') {
      setExpanded(m.on);
    } else if (m.type === 'wm-loot-request') {
      sendLoot(m.areaId);
    }
  });

  // Locks and badges depend on data that loads on its own (Auto-Fish, Pond, Mail), so re-send them when they change.
  var lastBuildingSig = '';
  setInterval(function () {
    if (!frameReady || !latest) return;
    var data = withBuildings(latest);
    var sig = JSON.stringify([data.buildingLocked, data.buildingStatus]);
    if (sig === lastBuildingSig) return;
    lastBuildingSig = sig;
    post({ type: 'wm-data', data: data });
  }, 2000);

  window.WorldMapBridge = {
    // True once the map frame has reported in; the guide and the area cards read this.
    isLive: function () { return frameReady; },
    // The map is on the page and has not failed, so the area cards are not drawn.
    showingMap: function () { return !!frame && !!wrap && !wrap.classList.contains('wm-failed'); },
    ensure: function () { mount(); },
    // Opens a building's popup on the map (used by the guide). Waits until the map has loaded.
    openBuilding: function (id) {
      mount();
      if (!frameReady) { pendingBuilding = id; return; }
      post({ type: 'wm-open-building', id: id });
    },
    // Bring the Forest (or another known area) into view for the six-step guide.
    focusArea: function (id) {
      mount();
      guideFocusAreaId = id ? String(id) : null;
      pendingFocusAreaId = guideFocusAreaId;
      applyTutorial();
    },
    clearAreaFocus: function () {
      guideFocusAreaId = null;
      pendingFocusAreaId = null;
      applyTutorial();
    },
    // Called by index-app.js after each hub tab is shown.
    onTabSwitch: onTabSwitch,
    // Called after every render of the Fishing Areas panel with the latest /api/areas data.
    // options.tutorialAreaId: the area the guide is on right now, or null.
    update: function (data, options) {
      latest = data;
      if (!mount()) return;
      post({ type: 'wm-data', data: withBuildings(data) });
      var next = options && options.tutorialAreaId ? options.tutorialAreaId : null;
      if (next !== tutorialAreaId) {
        tutorialAreaId = next;
        applyTutorial();
      }
    }
  };
})();
