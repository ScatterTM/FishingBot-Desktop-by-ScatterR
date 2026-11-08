(function () {
  'use strict';

  // Public Render EBS shared by all Fishingbot desktop installations.
  var RELAY_BASE = 'https://fishingbot-extension-relay.onrender.com';
  var gate = document.getElementById('account-gate');
  var workspace = document.getElementById('account-workspace');
  var gateStatus = document.getElementById('account-status');
  var privateStatus = document.getElementById('private-status');
  var content = document.getElementById('private-content');
  var renderTarget = content;
  var activeMapBuilding = null;
  var mapBuildingRequestId = 0;
  var tradingBuilder = {
    partner: '', selfItems: [], partnerItems: [], give: new Map(), receive: new Map(),
    loaded: false, status: '', requestId: 0
  };
  var authState = { token: '', helixToken: '', role: '', viewerIsLinked: null };
  var linkedAccount = null;
  var selectedView = 'areas';
  var viewIsOpen = false;
  var lastRequest = 0;
  var identityCheckId = 0;
  var masterAdminSessionId = '';
  var masterAdminExpiresAt = 0;

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)).toLocaleString() : '0';
  }

  function element(tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }

  function text(parent, tag, className, value) {
    var item = element(tag || 'div', className || '', value);
    parent.appendChild(item);
    return item;
  }

  function actionButton(label, callback, secondary) {
    var item = element('button', 'private-action' + (secondary ? ' secondary' : ''), label);
    item.type = 'button';
    item.addEventListener('click', callback);
    return item;
  }

  function card(title, wide) {
    var item = element('section', 'private-card' + (wide ? ' wide' : ''));
    text(item, 'h3', '', title);
    renderTarget.appendChild(item);
    return item;
  }

  function statGrid(parent, rows) {
    var grid = element('div', 'private-stat-grid');
    rows.forEach(function (row) {
      var cell = element('div', 'private-stat');
      text(cell, 'span', '', row[0]);
      text(cell, 'strong', '', row[1]);
      grid.appendChild(cell);
    });
    parent.appendChild(grid);
    return grid;
  }

  function row(parent, title, detail, actions) {
    var item = element('div', 'private-row');
    var copy = element('div', 'private-row-copy');
    text(copy, 'strong', '', title);
    if (detail) text(copy, 'span', '', detail);
    item.appendChild(copy);
    if (actions && actions.length) {
      var actionWrap = element('div', 'private-row-actions');
      actions.forEach(function (action) { actionWrap.appendChild(action); });
      item.appendChild(actionWrap);
    }
    parent.appendChild(item);
    return item;
  }

  function empty(parent, message) {
    parent.appendChild(element('div', 'private-empty', message));
  }

  function setGateStatus(message, type) {
    gateStatus.textContent = message || '';
    gateStatus.className = 'status-line' + (type === 'error' ? ' error' : type === 'good' ? ' good' : '');
  }

  function setPrivateStatus(message, type) {
    privateStatus.textContent = message || '';
    privateStatus.className = 'status-line' + (type === 'error' ? ' error' : type === 'good' ? ' good' : '');
  }

  function currentTwitchViewer() {
    var extension = window.Twitch && window.Twitch.ext;
    return extension && extension.viewer && typeof extension.viewer === 'object'
      ? extension.viewer
      : {};
  }

  function readJwtClaims(token) {
    try {
      var part = String(token || '').split('.')[1];
      if (!part || typeof window.atob !== 'function') return {};
      var base64 = part.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      return JSON.parse(window.atob(base64));
    } catch (_error) {
      return {};
    }
  }

  function updateIdentityPrompt() {
    var button = document.getElementById('identity-share');
    var help = document.getElementById('identity-help');
    if (!button) return;
    if (authState.role === 'broadcaster') {
      button.textContent = 'Connect channel profile';
      if (help) help.textContent = 'You are viewing your own channel. Twitch does not show the identity-sharing prompt to the broadcaster. Fishingbot verifies this profile against the channel identity on your authenticated desktop connection.';
    } else if (authState.viewerIsLinked === true) {
      button.textContent = 'Check linked profile';
      if (help) help.textContent = 'Your Twitch identity is already shared with Fishingbot. Check the connection to load your private game profile.';
    } else {
      button.textContent = 'Share account identity';
      if (help) help.textContent = 'Share your Twitch identity with this Extension. Twitch will ask for permission before Fishingbot can match your username to your game data.';
    }
  }

  function updateMasterAdminTab() {
    var tab = document.querySelector('[data-private-view="master-admin"]');
    var allowed = !!(authState.role === 'broadcaster' && linkedAccount && linkedAccount.channelOwner === true);
    if (tab) tab.hidden = !allowed;
    if (!allowed && selectedView === 'master-admin') selectedView = 'areas';
  }

  async function masterAdminRequest(operation, payload) {
    if (!authState.token || authState.role !== 'broadcaster' || !linkedAccount || linkedAccount.channelOwner !== true) {
      throw new Error('Master Admin is available only to the broadcaster on the authenticated Fishingbot desktop.');
    }
    var relayDiagnostics = window.FishingbotRelayDiagnostics;
    if (relayDiagnostics && typeof relayDiagnostics.ensureReady === 'function') await relayDiagnostics.ensureReady(false);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 32000);
    try {
      var response = await fetch(RELAY_BASE + '/v1/admin/' + String(operation), {
        method: 'POST', mode: 'cors', credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Extension-JWT': authState.token },
        body: JSON.stringify(payload || {}), signal: controller.signal
      });
      var envelope = await response.json().catch(function () { return {}; });
      if (!response.ok || envelope.ok === false) {
        var error = new Error(envelope.error || ('Master Admin request failed (HTTP ' + response.status + ').'));
        error.code = envelope.code || '';
        error.status = response.status;
        throw error;
      }
      if (relayDiagnostics && typeof relayDiagnostics.reportRequestSuccess === 'function') relayDiagnostics.reportRequestSuccess();
      return envelope.data;
    } catch (error) {
      if (relayDiagnostics && typeof relayDiagnostics.reportRequestError === 'function') relayDiagnostics.reportRequestError(error);
      if (error && error.name === 'AbortError') throw new Error('The Master Admin request timed out. Check the desktop relay connection and retry.');
      if (error && error.message === 'Failed to fetch') {
        var explain = relayDiagnostics && relayDiagnostics.explainNetworkFailure;
        throw new Error(typeof explain === 'function' ? await explain('Master Admin') : 'Could not contact the Fishingbot relay. Check browser protection and the Extension URL Fetching allowlist.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function request(route, values, options) {
    var isChannelOwner = authState.role === 'broadcaster';
    if (!authState.token || (!authState.helixToken && !isChannelOwner)) {
      throw new Error('Waiting for Twitch account authorization. Refresh the Extension and try again.');
    }
    var opts = options || {};
    var controller = null;
    var timeout = null;
    try {
      var relayDiagnostics = window.FishingbotRelayDiagnostics;
      if (relayDiagnostics && typeof relayDiagnostics.ensureReady === 'function') {
        await relayDiagnostics.ensureReady(false);
      }
      controller = new AbortController();
      timeout = setTimeout(function () { controller.abort(); }, 28000);
      var response = await fetch(RELAY_BASE + '/v1/viewer', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Extension-JWT': authState.token,
          'X-Helix-JWT': authState.helixToken
        },
        body: JSON.stringify({
          route: route,
          method: opts.method || 'GET',
          query: values || {},
          body: opts.body || {}
        }),
        signal: controller.signal
      });
      var envelope = await response.json().catch(function () { return {}; });
      if (!response.ok || envelope.ok === false) {
        var error = new Error(envelope.error || ('Request failed (HTTP ' + response.status + ').'));
        error.code = envelope.code || '';
        error.status = response.status;
        throw error;
      }
      if (envelope.viewer) linkedAccount = envelope.viewer;
      if (relayDiagnostics && typeof relayDiagnostics.reportRequestSuccess === 'function') relayDiagnostics.reportRequestSuccess();
      return envelope.data;
    } catch (error) {
      if (error && error.isRelayHealthError) throw error;
      if (window.FishingbotRelayDiagnostics && typeof window.FishingbotRelayDiagnostics.reportRequestError === 'function') {
        window.FishingbotRelayDiagnostics.reportRequestError(error);
      }
      if (error && error.name === 'AbortError') throw new Error('The streamer’s Fishingbot desktop did not respond within 28 seconds. Retry in a moment.');
      if (error && error.message === 'Failed to fetch') {
        var explain = window.FishingbotRelayDiagnostics && window.FishingbotRelayDiagnostics.explainNetworkFailure;
        var detail = typeof explain === 'function'
          ? await explain('your private account')
          : 'Could not contact the Fishingbot relay. Check the Extension URL Fetching allowlist and streamer connection.';
        throw new Error(detail);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function gameGet(route, extras) {
    return request(route, extras || {});
  }

  function gamePost(route, body) {
    return request(route, {}, { method: 'POST', body: body || {} });
  }

  async function checkAccount() {
    var checkId = ++identityCheckId;
    var tokenAtStart = authState.token;
    var helixAtStart = authState.helixToken;
    var roleAtStart = authState.role;
    var canResolveIdentity = !!tokenAtStart && (!!helixAtStart || roleAtStart === 'broadcaster');
    if (!canResolveIdentity) {
      lastRequest += 1;
      linkedAccount = null;
      updateMasterAdminTab();
      workspace.hidden = true;
      gate.hidden = false;
      setGateStatus(tokenAtStart
        ? 'Waiting for Twitch to provide the account profile token…'
        : 'Waiting for Twitch account authorization…');
      return false;
    }
    setGateStatus(roleAtStart === 'broadcaster'
      ? 'Verifying your channel-owner profile with the authenticated Fishingbot desktop…'
      : 'Checking your shared Twitch identity and Fishingbot profile…');
    try {
      var data = await request('whoami');
      if (checkId !== identityCheckId || tokenAtStart !== authState.token || helixAtStart !== authState.helixToken || roleAtStart !== authState.role) return false;
      var nextAccount = data || linkedAccount;
      var previousLogin = String(linkedAccount && linkedAccount.login || '').toLowerCase();
      var nextLogin = String(nextAccount && nextAccount.login || '').toLowerCase();
      if (previousLogin && nextLogin && previousLogin !== nextLogin) {
        tradingBuilder.partner = ''; tradingBuilder.selfItems = []; tradingBuilder.partnerItems = [];
        tradingBuilder.give.clear(); tradingBuilder.receive.clear(); tradingBuilder.loaded = false;
        tradingBuilder.status = ''; tradingBuilder.requestId += 1;
      }
      linkedAccount = nextAccount;
      if (!linkedAccount) throw new Error('The account link could not be loaded.');
      updateMasterAdminTab();
      document.getElementById('account-name').textContent = linkedAccount.displayName || linkedAccount.login;
      document.getElementById('account-login').textContent = '@' + linkedAccount.login;
      var avatar = document.getElementById('account-avatar');
      if (linkedAccount.avatar) {
        avatar.src = linkedAccount.avatar;
        avatar.hidden = false;
      } else {
        avatar.hidden = true;
        avatar.removeAttribute('src');
      }
      gate.hidden = true;
      workspace.hidden = false;
      setGateStatus('');
      return true;
    } catch (error) {
      if (checkId !== identityCheckId || tokenAtStart !== authState.token || helixAtStart !== authState.helixToken || roleAtStart !== authState.role) return false;
      linkedAccount = null;
      updateMasterAdminTab();
      workspace.hidden = true;
      gate.hidden = false;
      if (error.code === 'identity_link_required') {
        setGateStatus('Share your Twitch identity to unlock your personal Fishingbot data. Select Share account identity and approve Twitch’s permission prompt. If no prompt appears, ask the Extension owner to enable Identity Linking.','error');
      } else if (error.code === 'streamer_offline') {
        setGateStatus(authState.role === 'broadcaster'
          ? 'Your channel profile is recognized, but Fishingbot Desktop is not connected to this channel. Start Fishingbot and connect your Twitch account, then retry.'
          : 'The streamer’s Fishingbot desktop is offline. Ask the streamer to start Fishingbot, connect the channel and try again.','error');
      } else if (error.code === 'broadcaster_identity_mismatch') {
        setGateStatus('The connected Fishingbot desktop belongs to a different Twitch channel. Reconnect the correct broadcaster account in Fishingbot and retry.','error');
      } else {
        setGateStatus(error.message || 'Could not connect your account.','error');
      }
      return false;
    }
  }

  function showMessage(message, isError) {
    content.textContent = '';
    var panel = element('div', 'private-message' + (isError ? ' error' : ' good'), message);
    content.appendChild(panel);
  }

  async function loadPrivateViewData(view) {
    var data;
    if (view === 'overview') {
      var both = await Promise.all([gameGet('progression'), gameGet('perks')]);
      data = { progression: both[0], perks: both[1] };
    } else if (view === 'inventory') {
      var inventoryAndProgress = await Promise.all([request('inventory'), gameGet('autofish')]);
      data = Object.assign({}, inventoryAndProgress[0], { prestige: Number(inventoryAndProgress[1]?.prestige) || 0 });
    } else if (view === 'fishdex') data = await gameGet('fishdex');
    else if (view === 'achievements') data = await gameGet('progression', { mode: 'achievements' });
    else if (view === 'gear') data = await gameGet('progression');
    else if (view === 'areas') {
      // Match the non-local website's Tides Kingdom lock rules. These are
      // private, per-account hints only; the desktop remains authoritative.
      var extras = await Promise.all([
        gameGet('areas', { include: 'loot' }),
        gameGet('autofish').catch(function () { return {}; }),
        gameGet('pond').catch(function () { return {}; })
      ]);
      data = extras[0] || {};
      var autoData = extras[1] || {};
      var pondData = extras[2] || {};
      data.buildingLocked = {
        trading: false, mail: false, index: false, achievements: false, perks: false, shop: false,
        autofish: !(autoData.licensed || autoData.areaLevel3Eligible),
        pond: !pondData.unlocked
      };
      data.buildingStatus = {};
      if (autoData.areaLevel3Eligible && !autoData.licensed) data.buildingStatus.autofish = true;
    } else if (view === 'shop') {
      var shopData = await Promise.all([gameGet('progression'), gameGet('perks'), gameGet('pond'), gameGet('autofish')]);
      data = { gear: shopData[0], perks: shopData[1], pond: Object.assign({}, shopData[2], { prestige: Number(shopData[3]?.prestige) || 0 }) };
    } else if (view === 'perks') data = await gameGet('perks');
    else if (view === 'autofish') data = await gameGet('autofish');
    else if (view === 'pond') {
      var pondAndAutoFish = await Promise.all([gameGet('pond'), gameGet('autofish')]);
      data = Object.assign({}, pondAndAutoFish[0], { prestige: Number(pondAndAutoFish[1]?.prestige) || 0 });
    } else if (view === 'mail') data = await gameGet('trades', { action: 'mail' });
    else if (view === 'trading') data = {};
    else if (view === 'settings') data = await gameGet('fish-settings');
    else data = {};
    return data;
  }

  async function refreshView() {
    // Each tab selection gets its own request generation. A slower earlier
    // response must never overwrite the tab the viewer selected most recently.
    closeMapBuilding();
    var requestId = ++lastRequest;
    setPrivateStatus('Loading ' + selectedView.replace('-', ' ') + '…');
    content.textContent = '';
    if (selectedView === 'master-admin') {
      if (!linkedAccount || linkedAccount.channelOwner !== true || authState.role !== 'broadcaster') {
        selectedView = 'areas';
        updateMasterAdminTab();
        return refreshView();
      }
      renderMasterAdmin();
      setPrivateStatus(masterAdminSessionId ? 'Master Admin session is active on this desktop.' : 'Enter a one-time code generated in the local Control Centre.');
      return;
    }
    try {
      var data = await loadPrivateViewData(selectedView);
      if (requestId !== lastRequest) return;
      renderView(data);
      setPrivateStatus('Your account data is private to you. Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.');
    } catch (error) {
      if (requestId !== lastRequest) return;
      if (error.code === 'identity_link_required') {
        await checkAccount();
      } else {
        showMessage(error.message || 'Could not load this account view.', true);
        setPrivateStatus(error.message || 'Could not load this account view.','error');
      }
    }
  }

  async function post(route, body, successMessage) {
    try {
      setPrivateStatus('Saving…');
      if (activeMapBuilding) setMapBuildingStatus('Saving your change…');
      var result = await gamePost(route, body);
      setPrivateStatus(result.message || successMessage || 'Saved successfully.','good');
      if (activeMapBuilding) {
        var buildingAtSave = activeMapBuilding;
        await refreshMapBuilding();
        if (activeMapBuilding === buildingAtSave && selectedView === 'areas' && ['shop', 'perks', 'autofish', 'pond', 'gear'].includes(buildingAtSave.view) && window.FishingbotProfileMap) {
          try {
            var freshAreaState = await loadPrivateViewData('areas');
            window.FishingbotProfileMap.update(freshAreaState);
          } catch (mapRefreshError) {
            setMapBuildingStatus('Saved successfully. Map balances could not refresh yet; use Refresh map.', true);
          }
        }
      } else await refreshView();
      return result;
    } catch (error) {
      setPrivateStatus(error.message || 'The action could not be completed.','error');
      if (activeMapBuilding) setMapBuildingStatus(error.message || 'The action could not be completed.', true);
      throw error;
    }
  }

  function renderViewInto(view, data, target) {
    var previousTarget = renderTarget;
    renderTarget = target || content;
    renderTarget.textContent = '';
    try {
      if (view === 'overview') return renderOverview(data.progression, data.perks);
      if (view === 'inventory') return renderInventory(data);
      if (view === 'fishdex') return renderFishdex(data);
      if (view === 'achievements') return renderAchievements(data);
      if (view === 'gear') return renderGear(data);
      if (view === 'areas') return renderAreas(data);
      if (view === 'perks') return renderPerks(data);
      if (view === 'autofish') return renderAutoFish(data);
      if (view === 'pond') return renderPond(data);
      if (view === 'trading') return renderTrading(data);
      if (view === 'mail') return renderMail(data);
      if (view === 'settings') return renderSettings(data);
      if (view === 'master-admin') return renderMasterAdmin();
    } finally {
      renderTarget = previousTarget;
    }
  }

  function renderView(data) {
    return renderViewInto(selectedView, data, content);
  }

  function setMapBuildingStatus(message, isError) {
    var status = document.getElementById('private-map-building-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = 'private-map-building-status' + (isError ? ' error' : '');
  }

  var MAP_BUILDINGS = {
    trading: { title: 'Trading', view: 'trading' },
    mail: { title: 'Mail', view: 'mail' },
    index: { title: 'Fishdex', view: 'fishdex' },
    achievements: { title: 'Achievements', view: 'achievements' },
    perks: { title: 'Perks', view: 'perks' },
    shop: { title: 'Shop', view: 'shop' },
    autofish: { title: 'Auto-Fish', view: 'autofish' },
    pond: { title: 'Personal Pond', view: 'pond' }
  };

  function positionMapBuilding() {
    if (!activeMapBuilding) return;
    var viewport = document.getElementById('private-area-map-viewport');
    var panel = document.getElementById('private-map-building-popup');
    var arrow = document.getElementById('private-map-building-arrow');
    if (!viewport || !panel || panel.hidden) return;
    var rect = viewport.getBoundingClientRect();
    var width = viewport.clientWidth;
    var height = viewport.clientHeight;
    var anchor = activeMapBuilding.anchor || {};
    var x = Number.isFinite(Number(anchor.x)) ? Number(anchor.x) - rect.left : width / 2;
    var y = Number.isFinite(Number(anchor.y)) ? Number(anchor.y) - rect.top : height / 2;
    panel.style.transform = 'none';
    if (width < 560) {
      panel.classList.add('is-sheet');
      panel.style.left = '8px';
      panel.style.right = '8px';
      panel.style.top = 'auto';
      panel.style.bottom = '8px';
      panel.style.width = 'auto';
      panel.style.maxHeight = '72%';
      if (arrow) arrow.hidden = true;
      return;
    }
    panel.classList.remove('is-sheet');
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    var popupWidth = Math.min(760, width - 16);
    panel.style.width = popupWidth + 'px';
    panel.style.maxHeight = Math.min(510, height - 16) + 'px';
    var popupHeight = Math.min(panel.offsetHeight || 360, height - 16);
    var below = (height - y) >= y;
    var top = below ? y + 18 : y - popupHeight - 18;
    top = Math.max(8, Math.min(top, height - popupHeight - 8));
    var left = Math.max(8, Math.min(x - popupWidth / 2, width - popupWidth - 8));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    if (arrow) {
      arrow.hidden = false;
      arrow.className = 'private-map-building-arrow ' + (below ? 'up' : 'down');
      arrow.style.left = Math.max(left + 14, Math.min(x - 7, left + popupWidth - 14)) + 'px';
      arrow.style.top = (below ? top - 8 : top + popupHeight) + 'px';
    }
  }

  async function refreshMapBuilding() {
    var current = activeMapBuilding;
    if (!current || !linkedAccount || workspace.hidden || selectedView !== 'areas') return false;
    var requestId = ++mapBuildingRequestId;
    current.requestId = requestId;
    setMapBuildingStatus('Loading ' + current.title + '…');
    var body = document.getElementById('private-map-building-body');
    var categories = document.getElementById('private-map-building-cats');
    if (categories) categories.hidden = current.view !== 'shop';
    if (body) body.textContent = '';
    try {
      var data = await loadPrivateViewData(current.view);
      if (activeMapBuilding !== current || current.requestId !== requestId) return false;
      if (current.view === 'shop') {
        var category = current.shopCategory || 'perks';
        if (category === 'pond' && !data.pond.unlocked) category = current.shopCategory = 'perks';
        var categoryView = category === 'pond' ? 'pond' : category === 'perks' ? 'perks' : 'gear';
        var categoryData = category === 'pond' ? data.pond : category === 'perks' ? data.perks : data.gear;
        renderViewInto(categoryView, categoryData, body);
        var pondTab = categories && categories.querySelector('[data-shop-category="pond"]');
        if (pondTab) pondTab.hidden = !data.pond.unlocked;
        if (categories) categories.querySelectorAll('[data-shop-category]').forEach(function (button) {
          var active = button.getAttribute('data-shop-category') === category;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', String(active));
        });
      } else {
        renderViewInto(current.view, data, body);
      }
      setMapBuildingStatus(current.title + ' · Your private account');
      positionMapBuilding();
      return true;
    } catch (error) {
      if (activeMapBuilding !== current || current.requestId !== requestId) return false;
      setMapBuildingStatus(error.message || 'Could not load this feature.', true);
      return false;
    }
  }

  function openMapBuilding(input) {
    var message = input && typeof input === 'object' ? input : { id: input };
    var id = String(message.id || '');
    var config = MAP_BUILDINGS[id];
    if (!config || !linkedAccount || workspace.hidden || selectedView !== 'areas') return false;
    var panel = document.getElementById('private-map-building-popup');
    var title = document.getElementById('private-map-building-title');
    if (!panel || !title) return false;
    activeMapBuilding = {
      id: id, title: config.title, view: config.view, shopCategory: 'perks', requestId: 0,
      anchor: { x: Number(message.x), y: Number(message.y) }
    };
    title.textContent = 'TIDES KINGDOM · ' + config.title.toUpperCase();
    panel.hidden = false;
    positionMapBuilding();
    refreshMapBuilding();
    return true;
  }

  function updateMapBuildingAnchor(message) {
    if (!activeMapBuilding || String(message && message.id || '') !== activeMapBuilding.id) return false;
    activeMapBuilding.anchor = { x: Number(message.x), y: Number(message.y) };
    positionMapBuilding();
    return true;
  }

  function closeMapBuilding(syncMap) {
    var previous = activeMapBuilding;
    activeMapBuilding = null;
    mapBuildingRequestId += 1;
    var panel = document.getElementById('private-map-building-popup');
    if (panel) { panel.hidden = true; panel.classList.remove('is-sheet'); panel.style.left = ''; panel.style.right = ''; panel.style.top = ''; panel.style.bottom = ''; panel.style.width = ''; panel.style.maxHeight = ''; panel.style.transform = ''; }
    var arrow = document.getElementById('private-map-building-arrow');
    if (arrow) arrow.hidden = true;
    var body = document.getElementById('private-map-building-body');
    if (body) body.textContent = '';
    if (previous && syncMap !== false && window.FishingbotProfileMap && typeof window.FishingbotProfileMap.closeBuilding === 'function') {
      window.FishingbotProfileMap.closeBuilding(previous.id);
    }
    return !!previous;
  }

  function renderOverview(data, perks) {
    // progressionHandler returns achievementSnapshot() directly, with the
    // player stats at data.progression (not data.progression.progression).
    var p = data || {};
    var stats = p.progression || {};
    var overview = card('Fishing progress', true);
    statGrid(overview, [
      ['Casts', number(stats.casts)], ['Fishdex', number(stats.unique)], ['Treasury', number(data.treasury)],
      ['Rare catches', number(stats.rare)], ['Legendary+', number(stats.legendary)], ['Areas', number(stats.areas)]
    ]);
    var gear = card('Equipped gear');
    text(gear, 'p', '', 'Rod: ' + (stats.rod?.name || 'Old Rod'));
    text(gear, 'p', '', 'Bait: ' + (stats.selectedBait?.name || 'Worm Bait'));
    text(gear, 'p', '', 'Title: ' + (p.equippedTitle || 'No title equipped'));
    var active = card('Active boosts');
    var names = [];
    ['permLuck','tempLuck','vip','event','shield'].forEach(function (key) {
      var item = perks[key];
      if (item && (item.active || item.owned || item.count > 0)) names.push(key.replace(/([A-Z])/g, ' $1').toUpperCase());
    });
    if (perks.shop) Object.keys(perks.shop).forEach(function (key) { if (perks.shop[key]?.toggleOn && perks.shop[key]?.owned) names.push(key); });
    text(active, 'p', '', names.length ? names.join(' · ') : 'No active boosts reported.');
    var quick = card('Quick access');
    [['Inventory','inventory'],['Fishdex','fishdex'],['Achievements','achievements'],['Areas','areas'],['Perks & Shop','perks'],['Auto-Fish','autofish'],['Personal Pond','pond']].forEach(function (item) {
      quick.appendChild(actionButton(item[0], function () { selectView(item[1]); }, true));
    });
  }

  function renderInventory(data) {
    var head = card('Your inventory', true);
    text(head, 'p', 'muted', number(data.total) + ' items in your current inventory.');
    var search = element('input', 'private-input private-search');
    search.type = 'search'; search.placeholder = 'Search your fish and items…';
    head.appendChild(search);
    var list = element('div', 'private-item-list');
    head.appendChild(list);
    function draw() {
      list.textContent = '';
      var q = search.value.trim().toLowerCase();
      var items = (data.items || []).filter(function (item) { return !q || String(item.item).toLowerCase().includes(q); });
      items.forEach(function (item) {
        var line = element('div', 'private-item');
        text(line, 'span', '', item.item);
        text(line, 'strong', '', '×' + number(item.count));
        list.appendChild(line);
      });
      if (!items.length) empty(list, 'No matching inventory items.');
    }
    search.addEventListener('input', draw); draw();
    var convertible = (data.items || []).filter(function (item) { return item.convertible && Number(item.count) > 0; });
    var converter = card('FishyToken converter', true);
    text(converter, 'p', 'muted', 'Convert eligible fish from your inventory into FishyTokens. Perk-granting and Treasury catches cannot be converted. This feature unlocks with Personal Pond at Auto-Fish Prestige 1.');
    if (Number(data.prestige) < 1) {
      empty(converter, 'Unlock Auto-Fish Prestige 1 to convert inventory fish into FishyTokens.');
    } else if (!convertible.length) {
      empty(converter, 'You have no convertible fish in your inventory.');
    } else {
      var fishSelect = element('select', 'private-select');
      convertible.forEach(function (item) {
        var option = element('option', '', item.item + ' · ' + number(item.count) + ' available · ' + number(item.tokenValue) + ' tokens each');
        option.value = item.item; fishSelect.appendChild(option);
      });
      var countInput = element('input', 'private-input'); countInput.type = 'number'; countInput.min = '1';
      countInput.max = String(convertible[0].count); countInput.value = '1';
      fishSelect.addEventListener('change', function () {
        var selected = convertible.find(function (entry) { return entry.item === fishSelect.value; });
        countInput.max = String(selected ? selected.count : 1);
        countInput.value = '1';
      });
      converter.appendChild(fishSelect); converter.appendChild(countInput);
      converter.appendChild(actionButton('Convert selected fish', function () {
        var selected = convertible.find(function (entry) { return entry.item === fishSelect.value; });
        var amount = Math.max(1, Math.min(Number(selected?.count) || 1, Math.floor(Number(countInput.value) || 1)));
        post('pond', { action: 'convert', item: fishSelect.value, count: amount });
      }));
    }
  }

  function renderAchievements(data) {
    var achievements = Array.isArray(data.achievements) ? data.achievements : [];
    var unlocked = achievements.filter(function (entry) { return entry.unlocked; }).length;
    var head = card('Your achievements', true);
    text(head, 'p', '', number(unlocked) + ' of ' + number(achievements.length) + ' achievements completed');
    var bar = element('div', 'private-progress');
    var fill = element('span'); fill.style.width = (achievements.length ? Math.min(100, unlocked / achievements.length * 100) : 0) + '%';
    bar.appendChild(fill); head.appendChild(bar);
    var search = element('input', 'private-input private-search');
    search.type = 'search'; search.placeholder = 'Search achievements…';
    head.appendChild(search);
    var filter = element('select', 'private-select');
    [['all','All achievements'],['progress','In progress'],['done','Completed']].forEach(function (entry) {
      var option = element('option', '', entry[1]); option.value = entry[0]; filter.appendChild(option);
    });
    head.appendChild(filter);
    var list = element('div', 'private-item-list'); head.appendChild(list);
    function draw() {
      list.textContent = '';
      var query = search.value.trim().toLowerCase();
      var rows = achievements.filter(function (entry) {
        var done = !!entry.unlocked;
        var matchesFilter = filter.value === 'all' || (filter.value === 'done' ? done : !done);
        return matchesFilter && (!query || [entry.name, entry.description, entry.reward].join(' ').toLowerCase().includes(query));
      });
      rows.forEach(function (entry) {
        var target = Math.max(1, Number(entry.target) || 1);
        var progress = Math.max(0, Math.min(target, Number(entry.progress) || 0));
        row(list, (entry.unlocked ? '✓ ' : '○ ') + (entry.name || 'Achievement'),
          number(progress) + '/' + number(target) + ' · ' + (entry.description || '') + (entry.reward ? ' · Reward: ' + entry.reward : ''));
      });
      if (!rows.length) empty(list, 'No matching achievements.');
    }
    search.addEventListener('input', draw); filter.addEventListener('change', draw); draw();
  }

  function renderFishdex(data) {
    var head = card('Your Fishdex', true);
    var total = Number(data.totalItems) || 0;
    var caught = Number(data.totalCaught) || 0;
    text(head, 'p', '', number(caught) + ' of ' + number(total) + ' species discovered');
    var bar = element('div', 'private-progress');
    var fill = element('span'); fill.style.width = (total ? Math.min(100, caught / total * 100) : 0) + '%'; bar.appendChild(fill); head.appendChild(bar);
    (data.tiers || []).forEach(function (tier) {
      var part = card((tier.badge || tier.name) + ' · ' + (tier.items || []).filter(function (item) { return item.caught; }).length + '/' + (tier.items || []).length);
      var items = element('div', 'private-item-list');
      (tier.items || []).forEach(function (fish) {
        var line = element('div', 'private-item');
        text(line, 'span', '', fish.name + (fish.area ? ' · ' + fish.area : ''));
        text(line, 'strong', '', fish.count ? '×' + number(fish.count) : '—');
        if (fish.caught) line.style.borderColor = '#477657';
        items.appendChild(line);
      });
      part.appendChild(items);
    });
  }

  function renderGear(data) {
    var progression = data.progression || {};
    var rodCard = card('Fishing rods', true);
    var rods = Array.isArray(data.rods) ? data.rods : [];
    var currentRod = progression.rod?.id || 'old';
    var currentIndex = rods.findIndex(function (rod) { return rod.id === currentRod; });
    rods.forEach(function (rod, index) {
      var state = index < currentIndex ? 'Owned' : index === currentIndex ? 'Equipped' : 'Next upgrade';
      var actions = [];
      if (index === currentIndex + 1) actions.push(actionButton('Upgrade · ' + number(rod.cost) + ' Treasury', function () { post('progression', { action: 'upgrade-rod', rod: rod.id }); }));
      row(rodCard, rod.name, (rod.desc || '') + ' · ' + state, actions);
    });
    var baitCard = card('Bait supply', true);
    var baits = Array.isArray(data.baits) ? data.baits : [];
    baits.forEach(function (bait) {
      var count = bait.id === 'worm' ? '∞' : number(progression.bait?.[bait.id] || 0);
      var selected = progression.selectedBait?.id === bait.id;
      var actions = [actionButton(selected ? 'Selected' : 'Use', function () { if (!selected) post('progression', { action: 'select-bait', bait: bait.id }); }, true)];
      if (bait.id !== 'worm') actions.push(actionButton('Buy pack · ' + number(bait.cost), function () { post('progression', { action: 'buy-bait', bait: bait.id, packs: 1 }); }));
      row(baitCard, bait.name, count + ' available · ' + (bait.desc || ''), actions);
    });
    var cosmetics = card('Profile cosmetics', true);
    (data.cosmetics || []).forEach(function (item) {
      var current = progression.cosmetics?.[item.category] === item.id;
      var unlocked = item.unlock === 'Default' || (data.titles || []).includes(item.unlock);
      row(cosmetics, item.name, item.desc + ' · ' + (unlocked ? (current ? 'Equipped' : 'Unlocked') : 'Unlock: ' + item.unlock), unlocked && !current ? [actionButton('Equip', function () { post('progression', { action: 'equip-cosmetic', cosmetic: item.id }); })] : []);
    });
    var titleCard = card('Titles', true);
    (data.titles || []).forEach(function (title) {
      row(titleCard, title, progression.title === title ? 'Equipped' : 'Unlocked title', progression.title !== title ? [actionButton('Equip', function () { post('progression', { action: 'equip-title', title: title }); })] : []);
    });
  }

  async function performAreaMapAction(message) {
    if (!linkedAccount || workspace.hidden || selectedView !== 'areas') {
      throw new Error('Connect your Fishingbot profile and open My Account → World Map before changing an area.');
    }
    var input = message && typeof message === 'object' ? message : {};
    var action = String(input.action || '').toLowerCase();
    var areaId = typeof input.areaId === 'string' ? input.areaId : null;
    var allowedAreas = ['forest', 'shieldlake', 'reef', 'frozen', 'emberpool', 'whalebone'];
    var body;

    if (action === 'toggle-areas') {
      body = { action: 'toggleAreas', enabled: input.enabled === true };
    } else if (action === 'toggle-double') {
      body = { action: 'toggleDouble', enabled: input.enabled === true };
    } else if (action === 'select') {
      if (areaId !== null && !allowedAreas.includes(areaId)) throw new Error('Unknown fishing area.');
      body = { action: 'select', areaId: areaId };
    } else if (action === 'buy' || action === 'upgrade') {
      if (!areaId || !allowedAreas.includes(areaId)) throw new Error('Unknown fishing area.');
      body = { action: action, areaId: areaId };
    } else {
      throw new Error('That map action is not available.');
    }

    setPrivateStatus(action === 'buy' ? 'Unlocking area…' : action === 'upgrade' ? 'Upgrading area…' : 'Updating fishing area…');
    try {
      // The desktop owns the balance, inventory and area level. The Extension
      // sends only an intent; the existing server-side areas handler validates
      // ownership, price and available Treasury before changing game state.
      var result = await gamePost('areas', body);
      var latest = await loadPrivateViewData('areas');
      var mapData = Object.assign({}, latest, { readOnly: false });
      setPrivateStatus(result && result.message ? result.message : 'Fishing area updated.', 'good');
      return { data: mapData, message: result && result.message ? result.message : 'Fishing area updated.' };
    } catch (error) {
      setPrivateStatus(error.message || 'The area action could not be completed.', 'error');
      throw error;
    }
  }

  function renderAreas(data) {
    var mapCard = card('Tides Kingdom · area map', true);
    mapCard.id = 'private-area-map-card';
    mapCard.classList.add('private-map-card');
    text(mapCard, 'p', 'muted', 'Select an area to inspect its fish, boosts and level. Unlock and upgrade directly from the map using your own Treasury.');

    var mapTools = element('div', 'private-map-tools');
    text(mapTools, 'span', 'private-map-hint', 'PRIVATE MAP · PURCHASES ENABLED');
    var mapStatus = element('span', 'private-map-status', 'Loading your area ownership…');
    mapStatus.id = 'private-area-map-status';
    mapTools.appendChild(mapStatus);
    var refreshMap = actionButton('Refresh map', async function () {
      if (refreshMap.disabled) return;
      refreshMap.disabled = true;
      refreshMap.textContent = 'Refreshing…';
      mapStatus.textContent = 'Refreshing your area data…';
      try {
        var latest = await loadPrivateViewData('areas');
        if (window.FishingbotProfileMap) window.FishingbotProfileMap.update(latest);
        mapStatus.textContent = 'Area ownership updated just now.';
        setPrivateStatus('Your area map has been refreshed.', 'good');
      } catch (error) {
        mapStatus.textContent = error.message || 'Could not refresh your area map.';
        setPrivateStatus(mapStatus.textContent, 'error');
      } finally {
        refreshMap.disabled = false;
        refreshMap.textContent = 'Refresh map';
      }
    }, true);
    mapTools.appendChild(refreshMap);
    mapCard.appendChild(mapTools);

    var mapViewport = element('div', 'private-map-viewport');
    mapViewport.id = 'private-area-map-viewport';
    mapCard.appendChild(mapViewport);
    if (window.FishingbotProfileMap && typeof window.FishingbotProfileMap.mount === 'function') {
      window.FishingbotProfileMap.mount(mapViewport, data);
      mapStatus.textContent = 'Your areas, Treasury and current fishing location are loaded.';
    } else {
      empty(mapViewport, 'The interactive area map could not start. Refresh the Extension and try again.');
      mapStatus.textContent = 'Map renderer unavailable.';
    }

    // The non-local website opens each Tides Kingdom hub as a popup over the
    // map. Here we render the same private account views inside that popup,
    // keeping their existing server-backed purchase and management handlers.
    var buildingPopup = element('section', 'private-map-building-popup');
    buildingPopup.id = 'private-map-building-popup';
    buildingPopup.hidden = true;
    buildingPopup.setAttribute('role', 'dialog');
    buildingPopup.setAttribute('aria-modal', 'false');
    var buildingHead = element('div', 'private-map-building-head');
    var buildingTitle = element('strong', 'private-map-building-title', 'TIDES KINGDOM');
    buildingTitle.id = 'private-map-building-title';
    var buildingActions = element('div', 'private-map-building-actions');
    var refreshBuilding = actionButton('Refresh', function () { refreshMapBuilding(); }, true);
    buildingActions.appendChild(refreshBuilding);
    var closeBuilding = actionButton('Close', function () { closeMapBuilding(); }, true);
    closeBuilding.classList.add('private-map-building-close');
    buildingActions.appendChild(closeBuilding);
    buildingHead.appendChild(buildingTitle);
    buildingHead.appendChild(buildingActions);
    buildingPopup.appendChild(buildingHead);
    var shopCategories = element('nav', 'private-map-building-cats');
    shopCategories.id = 'private-map-building-cats';
    shopCategories.hidden = true;
    [['perks','Normal perks'],['pond','Pond perks'],['gear','Fishing gear']].forEach(function (entry) {
      var button = actionButton(entry[1], function () {
        if (!activeMapBuilding || activeMapBuilding.view !== 'shop') return;
        activeMapBuilding.shopCategory = entry[0];
        refreshMapBuilding();
      }, true);
      button.setAttribute('data-shop-category', entry[0]);
      button.setAttribute('aria-pressed', 'false');
      shopCategories.appendChild(button);
    });
    buildingPopup.appendChild(shopCategories);
    var buildingStatus = element('div', 'private-map-building-status', '');
    buildingStatus.id = 'private-map-building-status';
    buildingPopup.appendChild(buildingStatus);
    var buildingBody = element('div', 'private-map-building-body');
    buildingBody.id = 'private-map-building-body';
    buildingPopup.appendChild(buildingBody);
    mapViewport.appendChild(buildingPopup);
    var buildingArrow = element('span', 'private-map-building-arrow');
    buildingArrow.id = 'private-map-building-arrow';
    buildingArrow.hidden = true;
    buildingArrow.setAttribute('aria-hidden', 'true');
    mapViewport.appendChild(buildingArrow);

    text(mapCard, 'p', 'muted', 'Select an area to unlock, upgrade or fish there. Tides Kingdom buildings open your Fishdex, Shop, Perks, Auto-Fish, Pond, Mail and Trading tools directly over the map. All purchases are validated by your Fishingbot desktop.');
  }

  function renderPerks(data) {
    var shops = data.shop || {};
    var shopCard = card('Treasury shop', true);
    var labels = { luck125: '1.25× Luck', cooldown: 'Cooldown Reduction', treasuryLuck: 'Treasury Luck', rarityBoost: 'Rarity Boost', fishermansFortune: "Fisherman's Fortune", treasuryOnly: 'Treasury Only' };
    Object.keys(shops).forEach(function (id) {
      var item = shops[id] || {};
      var detail = (item.owned ? 'Owned' : 'Not owned') + ' · ' + number(item.cost) + ' Treasury';
      if (item.remainingSeconds) detail += ' · ' + number(item.remainingSeconds) + 's remaining';
      var actions = [];
      if (!item.owned || id === 'rarityBoost') {
        if (id === 'rarityBoost') {
          var rarity = element('select', 'private-select');
          ['uncommon','rare','epic','legendary','godly'].forEach(function (name) { var opt = element('option', '', name); opt.value = name; rarity.appendChild(opt); });
          actions.push(rarity);
          actions.push(actionButton('Buy', function () { post('perks', { buy: id, rarity: rarity.value }); }));
        } else actions.push(actionButton(item.owned ? 'Owned' : (id === 'treasuryOnly' ? 'Unlock' : 'Buy'), function () { if (!item.owned) post('perks', { buy: id }); }, !item.owned));
      }
      if (item.owned && id !== 'treasuryOnly') actions.push(actionButton(item.toggleOn ? 'Turn off' : 'Turn on', function () { post('perks', { perk: id, enabled: !item.toggleOn }); }, true));
      row(shopCard, labels[id] || id, detail, actions);
    });
    var boosts = card('Fishing boosts', true);
    ['permLuck','tempLuck','vip','event','shield'].forEach(function (id) {
      var item = data[id]; if (!item) return;
      var owned = !!(item.owned || item.count > 0);
      var enabled = item.toggleOn !== false;
      var actions = owned ? [actionButton(enabled ? 'Turn off' : 'Turn on', function () { post('perks', { perk: id === 'permLuck' ? 'perm' : id === 'tempLuck' ? 'temp' : id, enabled: !enabled }); })] : [];
      row(boosts, id.replace(/([A-Z])/g, ' $1'), owned ? (item.remainingSeconds ? number(item.remainingSeconds) + 's remaining' : 'Owned') : 'Not owned', actions);
    });
    var fortune = data.fortune || {};
    var current = card('Personal luck');
    text(current, 'p', '', 'Fortune level: ' + number(fortune.level) + ' · Uncaught bonus: ' + number(fortune.uncaughtWeightMultiplier) + '×');
    text(current, 'p', 'muted', 'Treasury balance: ' + number(data.treasury?.balance));
  }

  function renderAutoFish(data) {
    var info = card('Auto-Fish status', true);
    statGrid(info, [['Level', number(data.level)], ['Prestige', number(data.prestige)], ['XP', number(data.xp)], ['Auto casts', number(data.autoCasts)], ['Lifetime casts', number(data.manualCasts)], ['Treasury earned', number(data.treasuryEarned)]]);
    if (!data.licensed) {
      text(info, 'p', 'muted', 'Auto-Fish License not owned.');
      info.appendChild(actionButton('Buy Auto-Fish License', function () { post('autofish', { action: 'buyLicense' }); }));
      return;
    }
    row(info, 'Session', data.sessionOpen ? 'Running' : 'Stopped', [actionButton(data.sessionOpen ? 'Stop' : 'Start', function () { post('autofish', { action: data.sessionOpen ? 'stop' : 'start', targetArea: data.targetArea || '' }); })]);
    row(info, 'Trophy mode', data.trophyMode ? 'Enabled' : 'Disabled', [actionButton(data.trophyMode ? 'Turn off' : 'Turn on', function () { post('autofish', { action: 'trophyMode', enabled: !data.trophyMode }); })]);
    row(info, 'Target area', data.targetArea || 'Use selected fishing area');
    var targetForm = element('div', 'private-form');
    var targetSelect = element('select', 'private-select');
    var any = element('option', '', 'Use selected area'); any.value = ''; targetSelect.appendChild(any);
    Object.keys(data.areas || {}).forEach(function (id) { var area = data.areas[id]; var opt = element('option', '', area.name + ' (Lv ' + area.level + ')'); opt.value = id; targetSelect.appendChild(opt); });
    targetSelect.value = data.targetArea || '';
    var setTarget = actionButton('Save target', function () { post('autofish', { action: 'target', targetArea: targetSelect.value }); });
    targetForm.appendChild(targetSelect); targetForm.appendChild(setTarget); info.appendChild(targetForm);
    var stopForm = element('div', 'private-form');
    var stopInput = element('input', 'private-input'); stopInput.type = 'number'; stopInput.min = '0'; stopInput.max = '1000000'; stopInput.value = String(data.stopAfter || 0); stopInput.placeholder = '0 = no stop limit';
    stopForm.appendChild(stopInput); stopForm.appendChild(actionButton('Save stop condition', function () { post('autofish', { action: 'stopAfter', value: stopInput.value }); }));
    var stopCard = card('Stop condition'); stopCard.appendChild(stopForm);
    var events = card('Available events', true);
    var eventList = Array.isArray(data.events) ? data.events : [];
    if (!eventList.length) empty(events, 'No active Auto-Fish events right now.');
    eventList.forEach(function (event) { row(events, event.name || 'Fishing event', event.description || 'Complete this event to earn rewards.', [actionButton('Complete', function () { post('autofish', { action: 'event', eventId: event.id }); })]); });
    if (data.prestigeReady) events.appendChild(actionButton('Prestige', function () { if (window.confirm('Prestige your Auto-Fish progression?')) post('autofish', { action: 'prestige' }); }));
  }

  function renderPond(data) {
    if (!data.unlocked) {
      var locked = card('Personal Pond', true);
      text(locked, 'p', '', 'The Personal Pond unlocks at Auto-Fish Prestige 1.');
      text(locked, 'p', 'muted', 'Current Prestige: ' + number(data.prestige));
      return;
    }
    var summary = card('Your Personal Pond', true);
    statGrid(summary, [['Pond level', number(data.level)], ['FishyTokens', number(data.tokens)], ['Pending fish', number((data.pending || []).length)], ['Stash', number((data.stash || []).length)], ['Capacity', number(data.capacity)]]);
    summary.appendChild(actionButton('Collect pond', function () { post('pond', { action: 'collect' }); }));
    if (data.nextUpgradeCost > 0) summary.appendChild(actionButton('Upgrade pond · ' + number(data.nextUpgradeCost) + ' tokens', function () { post('pond', { action: 'upgrade' }); }, true));
    var pending = card('Pending catches');
    (data.pending || []).forEach(function (fish) { text(pending, 'p', '', fish); });
    if (!(data.pending || []).length) text(pending, 'p', 'muted', 'No fish waiting to be collected.');
    var stash = card('Pond stash');
    (data.stash || []).forEach(function (fish) { text(stash, 'p', '', fish); });
    if (!(data.stash || []).length) text(stash, 'p', 'muted', 'Your stash is empty.');
    var fishCard = card('Pond fish', true);
    (data.unlockedFish || []).forEach(function (fish) {
      var active = (data.selected || []).includes(fish);
      row(fishCard, fish, 'Upgrade level ' + number(data.fishUpgrades?.[fish]) + (active ? ' · Selected' : ''), [actionButton(active ? 'Selected' : 'Select', function () { post('pond', { action: 'selectFish', fish: [fish] }); }, true), actionButton('Upgrade fish', function () { post('pond', { action: 'upgradeFish', fish: fish }); })]);
    });
    var catalog = card('Unlock pond fish', true);
    (data.catalog || []).slice(0, 30).forEach(function (fish) {
      if ((data.unlockedFish || []).includes(fish.name)) return;
      row(catalog, fish.name, (fish.tier || 'Fish') + ' · ' + number(fish.unlockCost) + ' FishyTokens', [actionButton('Unlock', function () { post('pond', { action: 'unlockFish', fish: fish.name }); })]);
    });
    var stashCard = card('Manage pond stash', true);
    if (!(data.stash || []).length) empty(stashCard, 'Your pond stash is empty.');
    else {
      stashCard.appendChild(actionButton('Move all to inventory', function () { post('pond', { action: 'stash', mode: 'inventory' }); }));
      stashCard.appendChild(actionButton('Convert all to FishyTokens', function () { if (window.confirm('Convert every fish in your Pond stash into FishyTokens?')) post('pond', { action: 'stash', mode: 'tokens' }); }, true));
    }
    var features = card('Pond features', true);
    Object.keys(data.featureInfo || {}).forEach(function (key) {
      var feature = data.featureInfo[key];
      row(features, feature.label || key, (feature.desc || '') + ' · Level ' + number(feature.level) + '/' + number(feature.max) + (feature.nextCost ? ' · Next: ' + number(feature.nextCost) : ''), feature.level < feature.max ? [actionButton('Upgrade', function () { post('pond', { action: 'upgradeFeature', feature: key }); })] : []);
    });
    var pondPerks = card('Pond Treasury perks', true);
    Object.keys(data.treasuryPerkInfo || {}).forEach(function (key) {
      var perk = data.treasuryPerkInfo[key] || {};
      var level = Number(data.treasuryPerks?.[key]) || 0;
      var max = Number(perk.max || perk.maxLevel) || 0;
      var actions = level < max ? [actionButton('Upgrade · ' + number(perk.nextCost) + ' Treasury', function () { post('pond', { action: 'upgradeTreasuryPerk', perk: key }); })] : [];
      row(pondPerks, perk.label || key, (perk.desc || '') + ' · Level ' + number(level) + '/' + number(max), actions);
    });
    var baitSlotCount = Math.max(0, Math.min(2, Number(data.featureUpgrades?.baitSlots) || 0));
    var baitCard = card('Pond bait slots', true);
    if (!baitSlotCount) {
      text(baitCard, 'p', 'muted', 'Upgrade the Bait Slots pond feature to configure pond-only bait.');
    } else {
      text(baitCard, 'p', 'muted', 'Choose which bait the Personal Pond can consume when it spawns fish.');
      var baitChoices = [
        ['worm', 'Worm Bait'], ['minnow', 'Minnow Bait'], ['rare', 'Rare Bait'], ['legend', 'Legend Bait']
      ];
      var baitSelects = [];
      var currentSlots = Array.isArray(data.baitSlots) ? data.baitSlots.slice() : [];
      for (var slotIndex = 0; slotIndex < baitSlotCount; slotIndex++) {
        var slotLabel = element('label', '', 'Bait slot ' + (slotIndex + 1));
        var slotSelect = element('select', 'private-select');
        baitChoices.forEach(function (choice) {
          var owned = choice[0] === 'worm' ? Infinity : Number(data.baitInventory?.[choice[0]]) || 0;
          var option = element('option', '', choice[1] + (choice[0] === 'worm' ? ' · unlimited' : ' · ' + number(owned) + ' owned'));
          option.value = choice[0]; option.disabled = choice[0] !== 'worm' && owned < 1;
          slotSelect.appendChild(option);
        });
        slotSelect.value = currentSlots[slotIndex] || 'worm';
        slotLabel.appendChild(slotSelect); baitCard.appendChild(slotLabel); baitSelects.push(slotSelect);
      }
      baitCard.appendChild(actionButton('Save bait slots', function () {
        post('pond', { action: 'setBaitSlots', baitSlots: baitSelects.map(function (select) { return select.value; }) });
      }));
    }
    if (Number(data.prestige) >= 2 && !data.chatUnlocked) {
      baitCard.appendChild(actionButton('Enable !fish pond collection', function () { post('pond', { action: 'enableChat' }); }, true));
    } else if (data.chatUnlocked) {
      text(baitCard, 'p', 'muted', 'Chat collection is enabled. Use the website chat feature to collect eligible pond catches.');
    }

    var finder = card('Pond fish finder', true);
    var found = Array.isArray(data.fishFinder) ? data.fishFinder : [];
    if (!found.length) empty(finder, 'No fish preview is available yet.');
    found.slice(0, 12).forEach(function (entry) { row(finder, entry.name || entry.fish || 'Fish', [entry.tier, entry.chance ? number(entry.chance) + '% weight' : ''].filter(Boolean).join(' · ')); });
  }

  function setTradingStatus(message, isError) {
    tradingBuilder.status = String(message || '');
    var status = document.getElementById('private-trading-status');
    if (status) {
      status.textContent = tradingBuilder.status;
      status.className = 'status-line private-trading-status' + (isError ? ' error' : tradingBuilder.status ? ' good' : '');
    }
  }

  function tradeItemFor(side, raw) {
    var items = side === 'receive' ? tradingBuilder.partnerItems : tradingBuilder.selfItems;
    return items.find(function (item) { return String(item.raw) === String(raw); }) || null;
  }

  function setTradeQuantity(side, raw, quantity) {
    var item = tradeItemFor(side, raw);
    if (!item) return;
    var selection = side === 'receive' ? tradingBuilder.receive : tradingBuilder.give;
    var otherTotal = 0;
    selection.forEach(function (value, key) { if (key !== raw) otherTotal += Number(value) || 0; });
    var next = Math.max(0, Math.min(Number(item.count) || 0, Math.min(100 - otherTotal, Number(quantity) || 0)));
    if (next > 0) selection.set(raw, next); else selection.delete(raw);
    renderTradingWorkspace();
  }

  function renderTradeInventory(grid, side, search) {
    var items = side === 'receive' ? tradingBuilder.partnerItems : tradingBuilder.selfItems;
    var selection = side === 'receive' ? tradingBuilder.receive : tradingBuilder.give;
    var query = String(search || '').trim().toLowerCase();
    var filtered = items.filter(function (item) {
      return !query || (String(item.name || '') + ' ' + String(item.raw || '')).toLowerCase().includes(query);
    });
    if (!filtered.length) {
      empty(grid, items.length ? 'No inventory items match this search.' : 'No items are available in this inventory.');
      return;
    }
    filtered.forEach(function (item) {
      var selected = Number(selection.get(item.raw) || 0);
      var button = element('button', 'private-trading-item' + (selected ? ' selected' : ''));
      button.type = 'button';
      button.appendChild(element('strong', 'private-trading-item-name', item.name || item.raw || 'Item'));
      button.appendChild(element('span', 'private-trading-item-meta', String(item.tier || 'common').toUpperCase() + ' · Owned x' + number(item.count) + (selected ? ' · Selected x' + selected : '')));
      button.addEventListener('click', function () {
        setTradeQuantity(side, item.raw, selected ? 0 : 1);
      });
      grid.appendChild(button);
    });
  }

  function renderTradeSelection(parent, side) {
    var selection = side === 'receive' ? tradingBuilder.receive : tradingBuilder.give;
    var items = side === 'receive' ? tradingBuilder.partnerItems : tradingBuilder.selfItems;
    if (!selection.size) {
      empty(parent, side === 'receive' ? 'Choose items from the other player’s inventory.' : 'Choose items from your inventory.');
      return;
    }
    selection.forEach(function (quantity, raw) {
      var item = items.find(function (entry) { return entry.raw === raw; });
      if (!item) return;
      var selectedRow = element('div', 'private-trading-selected-row');
      var copy = element('div', 'private-trading-selected-copy');
      text(copy, 'strong', '', item.name || raw);
      text(copy, 'span', '', String(item.tier || 'common').toUpperCase() + ' · ' + number(item.count) + ' owned');
      selectedRow.appendChild(copy);
      var controls = element('div', 'private-trading-quantity');
      controls.appendChild(actionButton('−', function () { setTradeQuantity(side, raw, quantity - 1); }, true));
      text(controls, 'strong', '', '×' + quantity);
      controls.appendChild(actionButton('+', function () { setTradeQuantity(side, raw, quantity + 1); }, true));
      controls.appendChild(actionButton('×', function () { setTradeQuantity(side, raw, 0); }, true));
      selectedRow.appendChild(controls);
      parent.appendChild(selectedRow);
    });
  }

  function renderTradingWorkspace() {
    var host = document.getElementById('private-trading-workspace');
    if (!host) return;
    host.textContent = '';
    if (!tradingBuilder.loaded) {
      empty(host, 'Enter another Twitch username and load both inventories to build a trade.');
      return;
    }
    var inventories = element('div', 'private-trading-inventories');
    [['give', 'Your inventory', tradingBuilder.selfItems], ['receive', '@' + tradingBuilder.partner + '’s inventory', tradingBuilder.partnerItems]].forEach(function (entry) {
      var panel = element('section', 'private-trading-panel');
      text(panel, 'h4', '', entry[1]);
      panel.appendChild(element('p', '', entry[2].length + ' item types · Select an item to add it to the offer'));
      var search = element('input', 'private-input');
      search.type = 'search'; search.placeholder = 'Search inventory…'; search.setAttribute('aria-label', 'Search ' + entry[1]);
      panel.appendChild(search);
      var grid = element('div', 'private-trading-grid');
      panel.appendChild(grid);
      renderTradeInventory(grid, entry[0], '');
      search.addEventListener('input', function () { grid.textContent = ''; renderTradeInventory(grid, entry[0], search.value); });
      inventories.appendChild(panel);
    });
    host.appendChild(inventories);

    var offer = element('div', 'private-trading-offer');
    var givePanel = element('section', 'private-trading-panel');
    text(givePanel, 'h4', '', 'Your offer · @' + tradingBuilder.partner);
    renderTradeSelection(givePanel, 'give');
    var receivePanel = element('section', 'private-trading-panel');
    text(receivePanel, 'h4', '', 'You request from @' + tradingBuilder.partner);
    renderTradeSelection(receivePanel, 'receive');
    offer.appendChild(givePanel); offer.appendChild(receivePanel);
    host.appendChild(offer);
    var total = 0;
    tradingBuilder.give.forEach(function (qty) { total += Number(qty) || 0; });
    tradingBuilder.receive.forEach(function (qty) { total += Number(qty) || 0; });
    var send = actionButton('Send trade request · ' + total + ' items', function () { sendTradingOffer(); });
    send.disabled = total < 1;
    host.appendChild(send);
  }

  async function loadTradingInventories(input, button) {
    var partner = String(input || '').trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(partner)) { setTradingStatus('Enter a valid Twitch username.', true); return; }
    var ownLogin = String(linkedAccount && linkedAccount.login || '').toLowerCase();
    if (!ownLogin || partner === ownLogin) { setTradingStatus('Choose another Twitch player, not your own account.', true); return; }
    var requestId = ++tradingBuilder.requestId;
    if (button) { button.disabled = true; button.textContent = 'Loading…'; }
    setTradingStatus('Reading both inventories…');
    try {
      var data = await gameGet('trades', { action: 'inventories', partner: partner });
      if (requestId !== tradingBuilder.requestId) return;
      if (!data || !data.self || !data.partner || !Array.isArray(data.self.items) || !Array.isArray(data.partner.items)) {
        throw new Error('The trade inventory response was incomplete.');
      }
      tradingBuilder.partner = String(data.partner.username || partner);
      tradingBuilder.selfItems = data.self.items;
      tradingBuilder.partnerItems = data.partner.items;
      tradingBuilder.give.clear(); tradingBuilder.receive.clear();
      tradingBuilder.loaded = true;
      setTradingStatus('Loaded both inventories. Select items to build your offer.');
      renderTradingWorkspace();
    } catch (error) {
      if (requestId !== tradingBuilder.requestId) return;
      setTradingStatus(error.message || 'Could not load both inventories.', true);
    } finally {
      if (button) { button.disabled = false; button.textContent = 'Load both inventories'; }
    }
  }

  async function sendTradingOffer() {
    if (!tradingBuilder.loaded || !tradingBuilder.partner || (!tradingBuilder.give.size && !tradingBuilder.receive.size)) return;
    var give = Array.from(tradingBuilder.give.entries()).map(function (entry) { return { item: entry[0], quantity: entry[1] }; });
    var receive = Array.from(tradingBuilder.receive.entries()).map(function (entry) { return { item: entry[0], quantity: entry[1] }; });
    setTradingStatus('Sending trade request…');
    var requestId = tradingBuilder.requestId;
    try {
      var result = await gamePost('trades', { action: 'create', to: tradingBuilder.partner, give: give, receive: receive });
      if (requestId !== tradingBuilder.requestId) return;
      tradingBuilder.give.clear(); tradingBuilder.receive.clear();
      setTradingStatus(result && result.message ? result.message : 'Trade request sent. Nothing moves until the other player accepts.');
      setPrivateStatus('Trade request sent to @' + tradingBuilder.partner + '. Their inventory will not change unless they accept.', 'good');
      if (activeMapBuilding) await refreshMapBuilding(); else await refreshView();
    } catch (error) {
      if (requestId !== tradingBuilder.requestId) return;
      setTradingStatus(error.message || 'Could not send the trade request.', true);
    }
  }

  function renderTrading() {
    var panel = card('Trading', true);
    text(panel, 'p', 'muted', 'Build a trade from both live inventories, just like the website. Items move only after the other player accepts the request in Mail.');
    var toolbar = element('div', 'private-trading-toolbar');
    var partnerLabel = element('label', '', 'Trade with Twitch username');
    var partnerInput = element('input', 'private-input');
    partnerInput.id = 'private-trading-partner'; partnerInput.maxLength = 25; partnerInput.placeholder = 'username';
    partnerInput.value = tradingBuilder.partner;
    partnerLabel.appendChild(partnerInput);
    var loadButton = actionButton('Load both inventories', function () { loadTradingInventories(partnerInput.value, loadButton); }, true);
    partnerInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); loadButton.click(); } });
    toolbar.appendChild(partnerLabel); toolbar.appendChild(loadButton); panel.appendChild(toolbar);
    var status = element('div', 'status-line private-trading-status', tradingBuilder.status);
    status.id = 'private-trading-status'; panel.appendChild(status);
    var workspace = element('div', 'private-trading-workspace');
    workspace.id = 'private-trading-workspace'; panel.appendChild(workspace);
    renderTradingWorkspace();
  }

  function renderMail(data) {
    text(renderTarget, 'p', 'muted', 'Your inbox contains trade requests, gift requests and account messages. Build new item trades from the Trading building on the Tides Kingdom map.');
    var giftCard = card('Send a perk gift', true);
    text(giftCard, 'p', 'muted', 'Send an eligible shop or Personal Pond perk to another Fishingbot player. The server checks ownership and reserves Treasury safely.');
    var giftForm = element('div', 'private-form');
    var giftToWrap = element('label', '', 'Recipient username');
    var giftTo = element('input', 'private-input'); giftTo.maxLength = 32; giftTo.placeholder = 'recipient'; giftToWrap.appendChild(giftTo); giftForm.appendChild(giftToWrap);
    var giftPerkWrap = element('label', '', 'Perk to gift');
    var giftPerk = element('select', 'private-select');
    var giftOptions = [
      ['luck125', '1.25× Luck'], ['cooldown', 'Cooldown Reduction'], ['treasuryLuck', 'Treasury Luck'],
      ['rarityBoost', 'Rarity Boost'], ['treasuryOnly', 'Treasury Only'],
      ['treasuryWaters', 'Treasury Waters'], ['speciesHunter', 'Species Hunter'], ['baitSaver', 'Bait Saver'],
      ['collectorInstinct', "Collector's Instinct"], ['stillWaters', 'Still Waters'], ['deepCurrent', 'Deep Current'],
      ['biggerHaul', 'Bigger Haul'], ['fishyFortune', 'Fishy Fortune']
    ];
    giftOptions.forEach(function (entry) { var opt = element('option', '', entry[1]); opt.value = entry[0]; giftPerk.appendChild(opt); });
    giftPerkWrap.appendChild(giftPerk); giftForm.appendChild(giftPerkWrap);
    var giftRarityWrap = element('label', '', 'Rarity for Rarity Boost');
    var giftRarity = element('select', 'private-select');
    ['godly','legendary','epic','rare','uncommon'].forEach(function (name) { var opt = element('option', '', name); opt.value = name; giftRarity.appendChild(opt); });
    giftRarityWrap.appendChild(giftRarity); giftForm.appendChild(giftRarityWrap);
    giftCard.appendChild(giftForm);
    giftCard.appendChild(actionButton('Send gift request', function () {
      var recipient = giftTo.value.trim();
      if (!recipient) { setPrivateStatus('Enter the recipient username.','error'); return; }
      post('trades', { action: 'giftperk', to: recipient, perk: giftPerk.value, rarity: giftRarity.value });
    }));

    var inbox = card('Mail and trade requests', true);
    var messages = Array.isArray(data.messages) ? data.messages : [];
    if (!messages.length) empty(inbox, 'Your inbox is empty.');
    messages.forEach(function (message) {
      var actions = [];
      if (message.tradeOffer && message.status === 'pending') {
        var trade = message.tradeOffer;
        var currentLogin = String(linkedAccount.login).toLowerCase();
        if (String(trade.to || '').toLowerCase() === currentLogin) {
          actions.push(actionButton('Accept', function () { post('trades', { action: 'respond', offerId: trade.id, decision: 'accept' }); }));
          actions.push(actionButton('Decline', function () { post('trades', { action: 'respond', offerId: trade.id, decision: 'decline' }); }, true));
        } else if (String(trade.from || '').toLowerCase() === currentLogin) {
          actions.push(actionButton('Cancel trade', function () { post('trades', { action: 'respond', offerId: trade.id, decision: 'cancel' }); }, true));
        }
      }
      if (message.perkGift && message.status === 'pending') {
        var gift = message.perkGift;
        var giftLogin = String(linkedAccount.login).toLowerCase();
        if (String(gift.to || '').toLowerCase() === giftLogin) {
          actions.push(actionButton('Accept gift', function () { post('trades', { action: 'respondgift', giftId: gift.id, decision: 'accept' }); }));
          actions.push(actionButton('Decline', function () { post('trades', { action: 'respondgift', giftId: gift.id, decision: 'decline' }); }, true));
        } else if (String(gift.from || '').toLowerCase() === giftLogin) {
          actions.push(actionButton('Cancel gift', function () { post('trades', { action: 'respondgift', giftId: gift.id, decision: 'cancel' }); }, true));
        }
      }
      var detail = [message.status, message.createdAt ? new Date(Number(message.createdAt)).toLocaleString() : '', message.message || message.message || message.body || message.text || ''].filter(Boolean).join(' · ');
      row(inbox, message.title || message.subject || message.subtype || message.type || 'Message', detail, actions);
    });
    var markRead = (messages || []).filter(function (m) { return m.id && !m.read; }).map(function (m) { return m.id; });
    if (markRead.length) inbox.appendChild(actionButton('Mark messages read', function () { post('trades', { action: 'markread', ids: markRead }); }, true));
  }

  function renderSettings(data) {
    var settings = data.settings || {};
    var settingsCard = card('Fishing message settings', true);
    text(settingsCard, 'p', 'muted', 'Choose how your own fishing results are formatted in chat. The server validates and saves your templates.');
    var normal = element('textarea', 'private-input'); normal.rows = 3; normal.value = settings.normalTemplate || ''; normal.maxLength = Number(data.maxTemplateLength) || 100;
    var double = element('textarea', 'private-input'); double.rows = 3; double.value = settings.doubleTemplate || ''; double.maxLength = Number(data.maxTemplateLength) || 100;
    var normalLabel = text(settingsCard, 'label', '', 'Normal catch message'); normalLabel.appendChild(normal);
    var doubleLabel = text(settingsCard, 'label', '', 'Double catch message'); doubleLabel.appendChild(double);
    var flags = ['showChance','showLuck','showArea','showNew','showEvent','showBoost','showDoubleChance'];
    var current = {};
    flags.forEach(function (key) {
      var label = element('label');
      var input = element('input'); input.type = 'checkbox'; input.checked = settings[key] !== false; current[key] = input;
      label.appendChild(input); label.appendChild(document.createTextNode(' ' + key.replace(/^show/, 'Show ').replace(/[A-Z]/g, function (c) { return ' ' + c.toLowerCase(); })));
      settingsCard.appendChild(label);
    });
    settingsCard.appendChild(actionButton('Save message settings', function () {
      var body = { normalTemplate: normal.value, doubleTemplate: double.value };
      flags.forEach(function (key) { body[key] = current[key].checked; });
      post('fish-settings', body);
    }));
  }

  var MASTER_ADMIN_GROUPS = [
    { label: 'Diagnostics & reports', actions: ['adminDebugSnapshot','adminLuckBreakdown','adminTestFishRoll','adminTestPondRoll','adminRepairUserState','treasuryCheck','treasuryBackfillBatch','getAuditLog','deleteAuditEntry','getCatchLog','broadcaster-debug','broadcaster-overview'] },
    { label: 'Player inventory & accounts', actions: ['getInventory','getTradeInventory','getPerks','getAutoFish','getAutoFishGlobal','giveFish','givefish','giveFishBatch','removeFish','removefish','multiDeleteFish','wipeRarity','clearUser','delete'] },
    { label: 'Game progression & rewards', actions: ['addPondTokens','grantPerk','setPerk','setPondLevel','setPondPerk','setUserAreas','setAreaFeature','setAutoFish','spawnTreasurySlot','recalcBestCatch'] },
    { label: 'Shop & global settings', actions: ['shop-prices','shop-price','pond-perk-price','setGlobalEventLuck','clearGlobalEventLuck','resetAllFishMessages'] },
    { label: 'Titles & achievements', actions: ['listCustomTitles','listCustomAchievements','createCustomAchievement','updateCustomAchievement','updateBuiltinAchievement','updateCustomTitle','deleteCustomAchievement','createCustomTitle','assignCustomTitle','revokeCustomTitle'] },
    { label: 'Broadcaster administration', actions: ['list-broadcaster-admins','create-broadcaster-admin','update-broadcaster-admin','delete-broadcaster-admin','get-stream-cooldown','set-stream-cooldown','broadcaster-permission-set','broadcaster-debug-clear-test'] },
    { label: 'Tutorial diagnostics', actions: ['tutorialDebugInspect','tutorialDebugResetFirstFish','tutorialDebugClearReward','tutorialDebugResetServer'] }
  ];
  // Only these operations are known to be read-only. Every other operation
  // asks for confirmation, so newly added write actions fail safe by default.
  var MASTER_ADMIN_READ_ONLY = new Set(['adminDebugSnapshot','adminLuckBreakdown','broadcaster-debug','broadcaster-overview','get-stream-cooldown','getAuditLog','getAutoFish','getAutoFishGlobal','getCatchLog','getInventory','getPerks','getTradeInventory','list-broadcaster-admins','listCustomAchievements','listCustomTitles','tutorialDebugInspect','treasuryCheck']);

  function renderMasterAdminPair() {
    var panel = card('Master Admin access', true);
    text(panel, 'p', 'muted', 'Use the existing Master Admin login you already created in Fishingbot Control Centre. For security, the password stays on your PC and is never sent through Twitch or Render.');
    text(panel, 'p', '', 'Open Fishingbot → Control Centre → Security. Re-enter your existing Master Admin password and generate a one-time pairing code.');
    var codeLabel = element('label', 'private-admin-label', 'One-time pairing code');
    var codeInput = element('input', 'private-input');
    codeInput.type = 'text'; codeInput.maxLength = 64; codeInput.autocomplete = 'one-time-code'; codeInput.spellcheck = false; codeInput.placeholder = 'Paste the code from the local Control Centre';
    codeLabel.appendChild(codeInput); panel.appendChild(codeLabel);
    var actions = element('div', 'private-admin-actions');
    var unlock = actionButton('Unlock Master Admin', async function () {
      var code = codeInput.value.trim();
      if (!code) { setPrivateStatus('Paste the one-time pairing code from the local Control Centre.','error'); return; }
      unlock.disabled = true;
      try {
        var result = await masterAdminRequest('pair', { code: code });
        masterAdminSessionId = String(result?.sessionId || '');
        masterAdminExpiresAt = Number(result?.expiresAt) || 0;
        codeInput.value = '';
        if (!masterAdminSessionId) throw new Error('The relay did not return a Master Admin session. Generate a new pairing code and retry.');
        setPrivateStatus(result.bindingCreated ? 'Master Admin identity enrolled successfully. You are now signed in.' : 'Master Admin unlocked for @' + (result.boundLogin || linkedAccount.login) + '.','good');
        renderMasterAdmin();
      } catch (error) {
        setPrivateStatus(error.message || 'Master Admin pairing failed.','error');
      } finally { unlock.disabled = false; }
    });
    actions.appendChild(unlock); panel.appendChild(actions);
    text(panel, 'p', 'muted', 'Pairing codes expire after two minutes, work once, and are bound to the Twitch broadcaster ID authenticated by the desktop. The enrolled numeric ID is stored locally; the Twitch username is display-only.');
  }

  function renderMasterAdmin() {
    content.textContent = '';
    if (!masterAdminSessionId) return renderMasterAdminPair();
    var owner = linkedAccount?.login || 'broadcaster';
    var session = card('Master Admin · @' + owner, true);
    var toolbar = element('div', 'private-admin-toolbar');
    text(toolbar, 'span', 'private-badge good', 'AUTHENTICATED · DESKTOP-HELD TOKEN');
    var logout = actionButton('Lock Master Admin', async function () {
      logout.disabled = true;
      try { await masterAdminRequest('logout', { sessionId: masterAdminSessionId }); } catch (_) { }
      masterAdminSessionId = ''; masterAdminExpiresAt = 0;
      renderMasterAdmin(); setPrivateStatus('Master Admin session locked.','good');
    }, true);
    toolbar.appendChild(logout); session.appendChild(toolbar);
    text(session, 'p', 'muted', 'This session expires after 15 minutes without activity or 60 minutes after pairing. The signed Master Admin token never leaves Fishingbot Desktop.');

    var actionCard = card('Master Admin action console', true);
    text(actionCard, 'p', 'muted', 'This console invokes the existing website Master Admin actions against the local Fishingbot database. Choose an operation, enter its required parameters as JSON, and review the result.');
    var actionLabel = element('label', 'private-admin-label', 'Operation');
    var select = element('select', 'private-select');
    MASTER_ADMIN_GROUPS.forEach(function (group) {
      var optgroup = document.createElement('optgroup'); optgroup.label = group.label;
      group.actions.forEach(function (name) { var option = element('option', '', name); option.value = name; optgroup.appendChild(option); });
      select.appendChild(optgroup);
    });
    actionLabel.appendChild(select); actionCard.appendChild(actionLabel);

    var targetLabel = element('label', 'private-admin-label', 'Target player (optional)');
    var target = element('input', 'private-input'); target.type = 'text'; target.maxLength = 32; target.placeholder = 'twitch_username'; target.autocomplete = 'off';
    targetLabel.appendChild(target); actionCard.appendChild(targetLabel);

    var paramsLabel = element('label', 'private-admin-label', 'Additional parameters (JSON object)');
    var params = element('textarea', ''); params.spellcheck = false; params.value = '{}'; params.setAttribute('aria-label','Additional Master Admin action parameters as JSON');
    paramsLabel.appendChild(params); actionCard.appendChild(paramsLabel);
    text(actionCard, 'p', 'muted', 'Examples: shop-price uses {"category":"rods","id":"starter","price":100}; giveFish uses {"fish":"Moonfish [RARE]"} plus a Target player. Operation-specific parameters are validated by the existing Master Admin API.');
    var runRow = element('div', 'private-admin-actions');
    var run = actionButton('Run operation', async function () {
      var operation = select.value;
      var payload;
      try { payload = JSON.parse(params.value || '{}'); }
      catch (_) { setPrivateStatus('Parameters must be valid JSON.','error'); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { setPrivateStatus('Parameters must be a JSON object.','error'); return; }
      if (target.value.trim()) payload.targetUser = target.value.trim().replace(/^@+/, '');
      payload.action = operation;
      if (!MASTER_ADMIN_READ_ONLY.has(operation) && !confirm('Run the Master Admin operation "' + operation + '"? This can change or delete live game data.')) return;
      run.disabled = true; setPrivateStatus('Running ' + operation + '…');
      try {
        var result = await masterAdminRequest('action', { sessionId: masterAdminSessionId, payload: payload });
        resultOutput.textContent = JSON.stringify(result?.result ?? result, null, 2);
        masterAdminExpiresAt = Number(result?.expiresAt) || masterAdminExpiresAt;
        setPrivateStatus('Operation completed. Review the result below.','good');
      } catch (error) {
        if (error.code === 'admin_session_expired' || error.code === 'admin_session_invalid' || error.status === 401) {
          masterAdminSessionId = ''; masterAdminExpiresAt = 0; renderMasterAdmin();
        }
        setPrivateStatus(error.message || 'Master Admin operation failed.','error');
      } finally { run.disabled = false; }
    });
    runRow.appendChild(run); actionCard.appendChild(runRow);
    var resultOutput = element('pre', 'private-admin-result', 'Results will appear here.');
    actionCard.appendChild(resultOutput);
    text(actionCard, 'p', 'private-admin-warning', 'Destructive or economy-changing operations require an additional confirmation. The server still validates every operation and records actions using the existing Master Admin audit trail.');
  }

  function selectView(name) {
    closeMapBuilding();
    if (name === 'master-admin' && (!linkedAccount || linkedAccount.channelOwner !== true || authState.role !== 'broadcaster')) return;
    selectedView = name;
    document.querySelectorAll('.private-tab').forEach(function (tab) {
      var active = tab.getAttribute('data-private-view') === name;
      tab.classList.toggle('active', active);
    });
    refreshView();
  }

  document.querySelectorAll('.private-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { selectView(tab.getAttribute('data-private-view')); });
  });

  document.getElementById('identity-share').addEventListener('click', async function () {
    if (authState.role === 'broadcaster') {
      setGateStatus('Checking the broadcaster profile against the authenticated Fishingbot desktop…');
      var ownerLinked = await checkAccount();
      if (ownerLinked) await refreshView();
      return;
    }
    if (authState.viewerIsLinked === true) {
      setGateStatus('Your Twitch identity is already shared. Checking your Fishingbot profile…');
      var alreadyLinked = await checkAccount();
      if (alreadyLinked) await refreshView();
      return;
    }
    var actions = window.Twitch && window.Twitch.ext && window.Twitch.ext.actions;
    if (!actions || typeof actions.requestIdShare !== 'function') {
      setGateStatus('Twitch identity sharing is unavailable. Confirm that Identity Linking is enabled for this Extension version, then reload Twitch.','error');
      return;
    }
    setGateStatus('Twitch will ask whether you want to share your identity with Fishingbot. Approve the prompt; your profile will connect automatically.');
    try {
      actions.requestIdShare();
    } catch (_error) {
      setGateStatus('The Twitch identity permission prompt could not be opened. Refresh the Extension and try again.','error');
    }
  });

  function setRefreshBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent || 'Refresh';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = busyLabel || 'Refreshing…';
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = button.dataset.originalLabel || button.textContent || 'Refresh';
      delete button.dataset.originalLabel;
    }
  }

  var accountRefreshButton = document.getElementById('account-refresh');
  var accountReloadButton = document.getElementById('account-reload');
  accountRefreshButton.addEventListener('click', async function () {
    setRefreshBusy(accountRefreshButton, true, 'Checking…');
    try {
      var linked = await checkAccount();
      if (linked) await refreshView();
    } finally {
      setRefreshBusy(accountRefreshButton, false);
    }
  });
  accountReloadButton.addEventListener('click', async function () {
    setRefreshBusy(accountReloadButton, true, 'Refreshing…');
    try { await refreshView(); }
    finally { setRefreshBusy(accountReloadButton, false); }
  });

  updateIdentityPrompt();

  window.FishingbotAccount = {
    performAreaMapAction: performAreaMapAction,
    openMapBuilding: openMapBuilding,
    closeMapBuilding: closeMapBuilding,
    updateMapBuildingAnchor: updateMapBuildingAnchor,
    navigateTo: function (name) {
      var allowed = ['overview', 'inventory', 'fishdex', 'achievements', 'gear', 'areas', 'perks', 'autofish', 'pond', 'trading', 'mail', 'settings', 'master-admin'];
      if (!allowed.includes(String(name)) || workspace.hidden || !linkedAccount) return false;
      selectView(String(name));
      return true;
    },
    open: function () {
      viewIsOpen = true;
      checkAccount().then(function (ok) { if (ok) refreshView(); });
    },
    refresh: async function () {
      viewIsOpen = true;
      var ok = await checkAccount();
      if (ok) await refreshView();
      return !!ok;
    },
    onAuthorized: function (auth) {
      if (auth && typeof auth.token === 'string') {
        var viewer = currentTwitchViewer();
        var claims = readJwtClaims(auth.token);
        var nextToken = auth.token;
        var nextHelixToken = String(auth.helixToken || viewer.helixToken || '');
        var helperRole = String(viewer.role || claims.role || '').toLowerCase();
        var nextRole = ['broadcaster', 'moderator', 'viewer'].includes(helperRole) ? helperRole : 'viewer';
        var nextIsLinked = typeof viewer.isLinked === 'boolean'
          ? viewer.isLinked
          : (typeof viewer.id === 'string' && /^\d{5,20}$/.test(viewer.id)
            ? true
            : (/^\d{5,20}$/.test(String(claims.user_id || ''))
              ? true
              : (claims.is_unlinked === true || String(claims.is_unlinked).toLowerCase() === 'true' ? false : null)));
        if (nextToken !== authState.token || nextHelixToken !== authState.helixToken || nextRole !== authState.role || nextIsLinked !== authState.viewerIsLinked) {
          identityCheckId += 1;
          lastRequest += 1;
          // Do not persist Master Admin session IDs across Twitch identity changes.
          masterAdminSessionId = '';
          masterAdminExpiresAt = 0;
        }
        authState.token = nextToken;
        authState.helixToken = nextHelixToken;
        authState.role = nextRole;
        authState.viewerIsLinked = nextIsLinked;
        updateIdentityPrompt();
        updateMasterAdminTab();
      }
      if (viewIsOpen && authState.token && (authState.helixToken || authState.role === 'broadcaster')) {
        checkAccount().then(function (ok) { if (ok) refreshView(); });
      }
    }
  };
})();
