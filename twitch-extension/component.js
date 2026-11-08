(function () {
  'use strict';

  var RELAY_BASE = 'https://fishingbot-extension-relay.onrender.com';
  var extensionJwt = '';
  var connection = document.getElementById('connection');
  var connectionText = document.getElementById('connection-text');
  var totalCasts = document.getElementById('total-casts');
  var totalAnglers = document.getElementById('total-anglers');
  var liveList = document.getElementById('live-leaderboard');
  var updated = document.getElementById('updated-at');
  var leaderHighlight = document.getElementById('leader-highlight');
  var channelName = document.getElementById('channel-name');
  var siteLeaderboard = document.getElementById('site-leaderboard');
  var leaderboardStatus = document.getElementById('leaderboard-status');
  var lootStatus = document.getElementById('loot-status');
  var lootGrid = document.getElementById('loot-grid');
  var lootFilters = document.getElementById('loot-filters');
  var lootSearch = document.getElementById('loot-search');
  var mapRoot = document.getElementById('world-map-root');
  var lastSnapshotAt = 0;
  var visibility = true;
  var leaderboardData = null;
  var leaderboardMode = 'catches';
  var lootData = null;
  var lootTier = 'ALL';
  var currentView = 'account';
  var profileAreaMapData = null;
  var mapReady = false;
  var leaderboardRequestId = 0;
  var lootRequestId = 0;
  var expandedMap = false;
  var relayStatus = document.getElementById('relay-status');
  var relayStatusText = document.getElementById('relay-status-text');
  var relayStatusRetry = document.getElementById('relay-status-retry');
  var relayHealthPromise = null;
  var relayHealthResult = null;
  var relayHealthCheckedAt = 0;
  var relayLastError = '';
  var relayCspBlocked = false;
  var browserProtectionWarning = document.getElementById('browser-protection-warning');
  var browserProtectionTitle = document.getElementById('browser-protection-title');
  var browserProtectionText = document.getElementById('browser-protection-text');
  var browserProtectionHelp = document.getElementById('browser-protection-help');
  var RELAY_HOST = 'fishingbot-extension-relay.onrender.com';
  var RELAY_HEALTH_TIMEOUT_MS = 75_000;
  var RELAY_HEALTH_CACHE_MS = 60_000;

  function setBrowserProtectionWarning(kind) {
    if (!browserProtectionWarning) return;
    if (!kind) {
      browserProtectionWarning.hidden = true;
      return;
    }
    if (kind === 'policy') {
      if (browserProtectionTitle) browserProtectionTitle.textContent = 'Twitch policy blocked the relay request';
      if (browserProtectionText) browserProtectionText.textContent = 'Check URL Fetching Domains on the currently activated Extension version and include https://' + RELAY_HOST + '. Save and activate that version, then reload the Twitch player.';
    } else {
      if (browserProtectionTitle) browserProtectionTitle.textContent = 'Browser protection may be blocking FishingHub';
      if (browserProtectionText) browserProtectionText.textContent = 'Brave Shields, an ad blocker, privacy extension or DNS filter may be blocking the relay. Allow ' + RELAY_HOST + ' or lower protection for Twitch, then reload and retry. This warning is a possibility, not a detection of a specific blocker.';
    }
    browserProtectionWarning.hidden = false;
  }

  // Twitch Extensions run under a strict Content Security Policy. Capture a
  // blocked connect-src request so the viewer sees a precise allowlist error
  // instead of the generic browser TypeError: Failed to fetch.
  window.addEventListener('securitypolicyviolation', function (event) {
    var directive = String(event && (event.effectiveDirective || event.violatedDirective) || '').toLowerCase();
    var blockedUri = String(event && event.blockedURI || '');
    if (directive.indexOf('connect-src') !== 0 || blockedUri.indexOf(RELAY_HOST) === -1) return;
    relayCspBlocked = true;
    relayLastError = 'Twitch blocked the Render request with connect-src CSP. Add https://' + RELAY_HOST + ' to URL Fetching Domains on the Extension version that is currently activated, then save and activate that version.';
    setBrowserProtectionWarning('policy');
    setRelayStatus('error', relayLastError, true);
  });

  function relayFetchFailureMessage(subject) {
    if (relayCspBlocked) {
      return 'Twitch blocked the ' + subject + ' with its connect-src policy. Add https://' + RELAY_HOST + ' to URL Fetching Domains on the currently activated Extension version, then save and activate it.';
    }
    return 'The Twitch viewer could not complete the HTTPS ' + subject + ' to Render. A browser privacy feature or ad blocker may be blocking the request (for example Brave Shields, uBlock Origin, AdBlock or AdGuard). Allow ' + RELAY_HOST + ' or lower protection for Twitch, then retry. If it still fails, check URL Fetching Domains on the currently activated Extension version and inspect the browser console for CSP, CORS or network errors.';
  }


  function setConnection(state, message) {
    connection.className = 'connection ' + state;
    connectionText.textContent = message;
  }

  function setRelayStatus(state, message, canRetry) {
    if (!relayStatus || !relayStatusText) return;
    relayStatus.hidden = !message;
    relayStatus.className = 'relay-status ' + (state || 'warming');
    relayStatusText.textContent = message || '';
    if (relayStatusRetry) relayStatusRetry.hidden = !canRetry;
  }

  function relayConfigurationMessage(health) {
    var config = health && health.configuration && typeof health.configuration === 'object' ? health.configuration : {};
    var names = {
      twitchClientId: 'FISHINGBOT_TWITCH_CLIENT_ID',
      legacyTwitchClientId: 'FISHINGBOT_LEGACY_TWITCH_CLIENT_ID',
      extensionId: 'TWITCH_EXTENSION_ID',
      extensionOwnerId: 'TWITCH_EXTENSION_OWNER_ID',
      extensionSecret: 'TWITCH_EXTENSION_SECRET'
    };
    var missing = Object.keys(names).filter(function (key) { return config[key] === false; }).map(function (key) { return names[key]; });
    return missing.length ? 'Relay is awake, but Render configuration is incomplete: ' + missing.join(', ') + '. The relay owner must fix these settings.' : '';
  }

  async function ensureRelayReady(force) {
    if (force) {
      relayCspBlocked = false;
      relayLastError = '';
    }
    if (!force && relayHealthResult && relayHealthResult.ok === true && Date.now() - relayHealthCheckedAt < RELAY_HEALTH_CACHE_MS) {
      setRelayStatus('online', 'Render relay online · ready for Fishingbot requests', false);
      return relayHealthResult;
    }
    if (relayHealthPromise) return relayHealthPromise;

    relayHealthPromise = (async function () {
      setRelayStatus('warming', 'Waking Render relay… the first request after idle can take about a minute', false);
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, RELAY_HEALTH_TIMEOUT_MS);
      try {
        var response = await fetch(RELAY_BASE + '/health', {
          method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal
        });
        var health = await response.json().catch(function () { return {}; });
        relayHealthCheckedAt = Date.now();
        relayHealthResult = health;
        if (!response.ok || health.ok !== true) {
          var configurationMessage = relayConfigurationMessage(health);
          var error = new Error(configurationMessage || ('Render relay responded with HTTP ' + response.status + ', but is not ready yet. Check Render deploy status and logs.'));
          error.code = configurationMessage ? 'relay_configuration' : 'relay_not_ready';
          error.health = health;
          throw error;
        }
        relayLastError = '';
        relayCspBlocked = false;
        var buildLabel = health.relayBuild ? ' · ' + String(health.relayBuild) : '';
        setRelayStatus('online', 'Render relay online' + buildLabel + ' · loading Fishingbot data…', false);
        return health;
      } catch (error) {
        relayHealthResult = null;
        var message;
        var failureCode = error && error.code || 'relay_not_ready';
        if (failureCode === 'relay_configuration') {
          message = error.message;
        } else if (error && error.name === 'AbortError') {
          failureCode = 'relay_health_timeout';
          message = 'Render did not wake within 75 seconds. Check the Render service, then retry.';
        } else if (error && error.message === 'Failed to fetch') {
          failureCode = relayCspBlocked ? 'relay_csp_blocked' : 'relay_browser_fetch_failed';
          message = relayFetchFailureMessage('relay health check');
          setBrowserProtectionWarning(relayCspBlocked ? 'policy' : 'possible');
        } else {
          message = String(error && error.message || 'The Render relay could not be reached.');
        }
        relayLastError = message;
        setRelayStatus('error', message, true);
        var relayError = new Error(message);
        relayError.code = failureCode;
        relayError.isRelayHealthError = true;
        throw relayError;
      } finally {
        clearTimeout(timeout);
      }
    })().finally(function () { relayHealthPromise = null; });
    return relayHealthPromise;
  }

  window.FishingbotRelayDiagnostics = {
    ensureReady: ensureRelayReady,
    reportRequestSuccess: function () {
      setBrowserProtectionWarning(null);
      setRelayStatus('online', 'Render relay online · Fishingbot request successful', false);
    },
    reportRequestError: function (error) {
      if (error && error.isRelayHealthError) return;
      var code = String(error && error.code || '');
      if (code === 'streamer_offline' || code === 'desktop_disconnected') {
        setRelayStatus('offline', 'Relay is awake, but the streamer’s Fishingbot desktop is not connected', true);
      } else if (code === 'desktop_timeout') {
        setRelayStatus('offline', 'Relay is awake, but the streamer’s desktop did not answer within 20 seconds', true);
      } else if (error && error.name === 'AbortError') {
        setRelayStatus('error', 'The private account request timed out. Check the streamer desktop bridge, then retry.', true);
      } else if (error && error.message === 'Failed to fetch') {
        relayLastError = relayFetchFailureMessage('private account request');
        setBrowserProtectionWarning(relayCspBlocked ? 'policy' : 'possible');
        setRelayStatus('error', relayLastError, true);
      }
    },
    explainNetworkFailure: async function () {
      if (relayCspBlocked) return relayFetchFailureMessage('private account request');
      if (relayLastError) return relayLastError;
      if (!relayHealthResult) return relayFetchFailureMessage('relay health check');
      return relayFetchFailureMessage('relay data request');
    }
  };

  function setButtonBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent || 'Refresh';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = busyLabel || 'Loading…';
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = button.dataset.originalLabel || button.textContent || 'Refresh';
      delete button.dataset.originalLabel;
    }
  }

  function updatedLabel(prefix) {
    return prefix + ' · updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)).toLocaleString() : '0';
  }

  function node(tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }

  function parseMessage(message) {
    try { return typeof message === 'string' ? JSON.parse(message) : message; }
    catch (_error) { return null; }
  }

  async function fetchJson(action) {
    if (!extensionJwt) throw new Error('Waiting for Extension authorization.');
    await ensureRelayReady(false);
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 28000);
    try {
      var response = await fetch(RELAY_BASE + '/v1/public', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Extension-JWT': extensionJwt
        },
        body: JSON.stringify({ action: action }),
        signal: controller.signal
      });
      var envelope = await response.json().catch(function () { return {}; });
      if (!response.ok || envelope.ok === false) {
        var error = new Error(envelope.error || ('HTTP ' + response.status));
        error.code = envelope.code || '';
        error.status = response.status;
        throw error;
      }
      relayCspBlocked = false;
      setBrowserProtectionWarning(null);
      setRelayStatus('online', 'Render relay online · data request successful', false);
      return envelope.data;
    } catch (error) {
      if (error && error.code === 'streamer_offline') {
        setRelayStatus('offline', 'Relay is awake, but the streamer’s Fishingbot desktop is not connected', true);
      } else if (error && error.code === 'desktop_disconnected') {
        setRelayStatus('offline', 'Relay is awake, but the desktop bridge disconnected during this request', true);
      } else if (error && error.code === 'desktop_timeout') {
        setRelayStatus('offline', 'Relay is awake, but the streamer’s desktop did not answer within 20 seconds', true);
      } else if (error && error.name === 'AbortError') {
        setRelayStatus('error', 'The relay data request timed out. Check the streamer desktop connection, then retry.', true);
      } else if (error && error.message === 'Failed to fetch') {
        relayLastError = relayFetchFailureMessage('public data request');
        setBrowserProtectionWarning(relayCspBlocked ? 'policy' : 'possible');
        setRelayStatus('error', relayLastError, true);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function publicErrorText(error, subject) {
    var code = String(error && error.code || '');
    if (code === 'streamer_offline' || code === 'desktop_disconnected') {
      return 'The streamer’s Fishingbot desktop is offline. Ask the streamer to start Fishingbot and reconnect the channel, then retry.';
    }
    if (code === 'desktop_timeout') return 'The streamer’s desktop did not respond in time. Retry in a moment.';
    if (code === 'relay_health_timeout' || code === 'relay_unreachable' || code === 'relay_configuration' || code === 'relay_not_ready') return String(error && error.message || relayLastError || 'The Render relay is not ready.');
    if (code === 'rate_limited') return 'Too many requests were made. Wait a moment, then retry.';
    if (code === 'helix_token_missing' || code === 'identity_verification_failed') {
      return 'Account authorization needs refreshing. Reload the Extension and try again.';
    }
    if (error && error.message === 'Failed to fetch') return relayLastError || 'Render may be awake, but Twitch could not complete the data request. Check the active Extension version’s URL Fetching allowlist.';
    return 'Could not load ' + subject + ': ' + String(error && error.message || 'Unknown error') + ' Check the relay status and streamer connection.';
  }

  // The Extension is map-first: broadcast snapshots only update the connection
  // indicator; live stats, leaderboard and catalogue are accessed through the map.
  function showSnapshot(snapshot) {
    if (!snapshot || snapshot.type !== 'fishingbot.snapshot' || snapshot.schema !== 1) return;
    var incomingAt = Number(snapshot.sentAt) || Date.now();
    if (incomingAt < lastSnapshotAt) return;
    lastSnapshotAt = incomingAt;
    if (channelName && snapshot.channel) channelName.textContent = String(snapshot.channel).toUpperCase();
    setConnection('live', 'PUBSUB LIVE');
  }

  function activateView(name) {
    var allowed = ['account', 'legal'];
    if (allowed.indexOf(String(name)) === -1) return false;
    currentView = String(name);
    document.querySelectorAll('.tab[data-view]').forEach(function (tab) {
      var active = tab.getAttribute('data-view') === currentView;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.view[id^="view-"]').forEach(function (view) {
      var active = view.id === 'view-' + currentView;
      view.classList.toggle('active', active);
      view.hidden = !active;
    });
    if (currentView === 'account' && window.FishingbotAccount) window.FishingbotAccount.open();
    return true;
  }

  document.querySelectorAll('.tab[data-view]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      activateView(tab.getAttribute('data-view'));
    });
  });

  if (browserProtectionHelp) {
    browserProtectionHelp.addEventListener('click', function () { activateView('legal'); });
  }

  async function loadLeaderboard(force) {
    var requestId = ++leaderboardRequestId;
    leaderboardStatus.textContent = 'Loading community leaderboard…';
    leaderboardStatus.classList.remove('error');
    if (force) leaderboardData = null;
    try {
      var data = await fetchJson('leaderboard');
      if (requestId !== leaderboardRequestId) return;
      if (!data || !Array.isArray(data.catches) || !Array.isArray(data.rares)) throw new Error('Unexpected leaderboard response');
      leaderboardData = data;
      leaderboardStatus.textContent = updatedLabel(data.catches.length ? 'Showing the top community anglers.' : 'No community catches have been recorded yet');
      renderLeaderboard();
    } catch (error) {
      if (requestId !== leaderboardRequestId) return;
      var message = await publicErrorText(error, 'the community leaderboard');
      if (requestId !== leaderboardRequestId) return;
      leaderboardStatus.textContent = message;
      leaderboardStatus.classList.add('error');
      siteLeaderboard.textContent = '';
    }
  }

  function renderLeaderboard() {
    if (!leaderboardData) return;
    var rows = (leaderboardData[leaderboardMode] || []).slice(0, 25);
    siteLeaderboard.textContent = '';
    rows.forEach(function (entry, index) {
      var item = node('li');
      item.appendChild(node('span', 'rank', '#' + (index + 1)));
      var info = node('div', 'angler');
      info.appendChild(node('div', 'username', entry.username || 'Angler'));
      var detail = leaderboardMode === 'catches'
        ? (entry.title ? String(entry.title) + ' · ' : '') + number(entry.dexPct) + '% Fishdex'
        : (entry.bestItem && entry.bestItem !== 'None' ? String(entry.bestItem) : 'No rare catch yet') + (entry.title ? ' · ' + String(entry.title) : '');
      info.appendChild(node('div', 'best', detail));
      item.appendChild(info);
      var score = leaderboardMode === 'catches' ? number(entry.count) : number(entry.tierScore);
      var metric = node('div', 'catches', score);
      metric.appendChild(node('span', '', leaderboardMode === 'catches' ? 'catches' : 'rare score'));
      item.appendChild(metric);
      siteLeaderboard.appendChild(item);
    });
    if (!rows.length) siteLeaderboard.appendChild(node('li', 'empty-row', 'No results yet.'));
  }

  document.querySelectorAll('[data-board]').forEach(function (button) {
    button.addEventListener('click', function () {
      leaderboardMode = button.getAttribute('data-board') === 'rares' ? 'rares' : 'catches';
      document.querySelectorAll('[data-board]').forEach(function (candidate) {
        var active = candidate === button;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-pressed', String(active));
      });
      renderLeaderboard();
    });
  });

  async function loadLoot(force) {
    var requestId = ++lootRequestId;
    lootStatus.textContent = 'Loading loot catalogue…';
    lootStatus.classList.remove('error');
    if (force) lootData = null;
    try {
      var data = await fetchJson('loot');
      if (requestId !== lootRequestId) return;
      if (!Array.isArray(data)) throw new Error('Unexpected loot response');
      lootData = data.filter(function (tier) {
        return tier && tier.id !== 'unique' && String(tier.name).toUpperCase() !== 'SECRET';
      });
      lootStatus.textContent = updatedLabel('Showing ' + lootData.length + ' public rarity groups');
      renderLootFilters();
      renderLoot();
    } catch (error) {
      if (requestId !== lootRequestId) return;
      lootStatus.textContent = await publicErrorText(error, 'the loot catalogue');
      if (requestId !== lootRequestId) return;
      lootStatus.classList.add('error');
      lootGrid.textContent = '';
    }
  }

  function renderLootFilters() {
    lootFilters.textContent = '';
    var allButton = node('button', 'filter-chip' + (lootTier === 'ALL' ? ' active' : ''), 'All');
    allButton.type = 'button';
    allButton.addEventListener('click', function () { lootTier = 'ALL'; renderLootFilters(); renderLoot(); });
    lootFilters.appendChild(allButton);
    (lootData || []).forEach(function (tier) {
      var button = node('button', 'filter-chip' + (lootTier === tier.id ? ' active' : ''), tier.badge || tier.name);
      button.type = 'button';
      button.addEventListener('click', function () { lootTier = tier.id; renderLootFilters(); renderLoot(); });
      lootFilters.appendChild(button);
    });
  }

  function renderLoot() {
    lootGrid.textContent = '';
    var query = String(lootSearch.value || '').trim().toLowerCase();
    var tiers = (lootData || []).filter(function (tier) { return lootTier === 'ALL' || tier.id === lootTier; });
    var shown = 0;
    tiers.forEach(function (tier) {
      var items = (Array.isArray(tier.items) ? tier.items : []).filter(function (item) { return !query || String(item).toLowerCase().includes(query); });
      if (query && !String(tier.name).toLowerCase().includes(query) && !items.length) return;
      shown++;
      var card = node('article', 'loot-card');
      var head = node('div', 'loot-card-head');
      head.appendChild(node('span', 'loot-tier', tier.badge || tier.name));
      head.appendChild(node('span', 'loot-chance', 'Base chance ' + numberDecimal(tier.basePct) + '%'));
      card.appendChild(head);
      card.appendChild(node('h3', '', tier.name || 'Loot tier'));
      var list = node('ul', 'loot-items');
      items.forEach(function (itemName) { list.appendChild(node('li', '', itemName)); });
      if (!items.length) list.appendChild(node('li', '', 'No matching items'));
      card.appendChild(list);
      lootGrid.appendChild(card);
    });
    if (!shown) lootGrid.appendChild(node('div', 'empty-row', 'No matching loot found.'));
  }

  function numberDecimal(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? String(parsed) : '0';
  }

  if (lootSearch) lootSearch.addEventListener('input', renderLoot);

  function postToMap(message) {
    if (!mapReady || !mapRoot) return false;
    window.dispatchEvent(new CustomEvent('fishingbot:map-data', { detail: message }));
    return true;
  }

  // Defer the two large map artwork layers until the private map is opened.
  // The renderer is mounted only inside My Account → World Map.
  function loadMapArtwork() {
    document.querySelectorAll('.map-art[data-map-src]').forEach(function (image) {
      if (!image.getAttribute('src')) image.setAttribute('src', image.getAttribute('data-map-src'));
    });
  }

  function setPrivateAreaMapData(data) {
    if (!data || !Array.isArray(data.areas)) throw new Error('The private area response did not contain an areas list.');
    profileAreaMapData = Object.assign({}, data, { readOnly: false });
    if (mapReady) postToMap({ type: 'wm-data', data: profileAreaMapData });
    return profileAreaMapData;
  }

  window.FishingbotProfileMap = {
    mount: function (host, data) {
      if (!host || !mapRoot) return false;
      if (mapRoot.parentNode !== host) host.appendChild(mapRoot);
      loadMapArtwork();
      setPrivateAreaMapData(data);
      return true;
    },
    update: function (data) {
      setPrivateAreaMapData(data);
      return true;
    },
    closeBuilding: function (id) { return postToMap({ type: 'wm-building-closed', id: String(id || '') }); },
    isReady: function () { return mapReady; }
  };

  function reportMapActionError(message) {
    postToMap({ type: 'wm-action-error', message: String(message || 'The area action could not be completed.') });
  }

  async function performProfileMapAction(message) {
    if (currentView !== 'account' || !window.FishingbotAccount || typeof window.FishingbotAccount.performAreaMapAction !== 'function') {
      reportMapActionError('Open My Account and connect your profile before changing fishing areas.');
      return;
    }
    try {
      var result = await window.FishingbotAccount.performAreaMapAction(message);
      setPrivateAreaMapData(result.data);
      postToMap({ type: 'wm-done', message: result.message || 'Fishing area updated.' });
    } catch (error) {
      reportMapActionError(error && error.message ? error.message : 'The area action could not be completed.');
    }
  }

  function handleMapMessage(message) {
    message = message || {};
    if (message.type === 'wm-ready') {
      mapReady = true;
      if (profileAreaMapData) postToMap({ type: 'wm-data', data: profileAreaMapData });
    } else if (message.type === 'wm-loot-request') {
      var area = profileAreaMapData && Array.isArray(profileAreaMapData.areas)
        ? profileAreaMapData.areas.find(function (entry) { return entry.id === message.areaId; })
        : null;
      postToMap({ type: 'wm-loot', areaId: message.areaId, loot: area && Array.isArray(area.loot) ? area.loot : null });
    } else if (message.type === 'wm-action') {
      performProfileMapAction(message);
    } else if (message.type === 'wm-building') {
      if (!window.FishingbotAccount || typeof window.FishingbotAccount.openMapBuilding !== 'function' || !window.FishingbotAccount.openMapBuilding(message)) {
        postToMap({ type: 'wm-action-error', message: 'Connect your profile and open My Account → World Map to use this feature.' });
      }
    } else if (message.type === 'wm-anchor') {
      if (window.FishingbotAccount && typeof window.FishingbotAccount.updateMapBuildingAnchor === 'function') {
        window.FishingbotAccount.updateMapBuildingAnchor(message);
      }
    } else if (message.type === 'wm-dismiss') {
      if (window.FishingbotAccount && typeof window.FishingbotAccount.closeMapBuilding === 'function') {
        window.FishingbotAccount.closeMapBuilding(false);
      }
    } else if (message.type === 'wm-expand') {
      expandedMap = !!message.on;
      var shell = document.getElementById('private-area-map-card');
      if (shell) shell.classList.toggle('expanded', expandedMap);
      document.querySelector('.widget').classList.toggle('map-expanded', expandedMap);
      postToMap({ type: 'wm-expanded', on: expandedMap });
    }
  }

  window.addEventListener('fishingbot:map-event', function (event) { handleMapMessage(event.detail); });
  // map.js loads immediately before this file. Handle its initial ready event
  // even when that event fired before this listener was registered.
  if (window.__fishingbotMapReady) handleMapMessage({ type: 'wm-ready' });
  if (relayStatusRetry) relayStatusRetry.addEventListener('click', async function () {
    setButtonBusy(relayStatusRetry, true, 'Waking…');
    try {
      await ensureRelayReady(true);
      if (currentView === 'leaderboard') await loadLeaderboard(true);
      else if (currentView === 'loot') await loadLoot(true);
      else if (currentView === 'account' && window.FishingbotAccount) window.FishingbotAccount.open();
    } catch (_error) { /* The relay status line contains the next step. */ }
    finally { setButtonBusy(relayStatusRetry, false); }
  });

  document.querySelectorAll('[data-refresh]').forEach(function (button) {
    button.addEventListener('click', async function () {
      var what = button.getAttribute('data-refresh');
      setButtonBusy(button, true, 'Refreshing…');
      try {
        if (what === 'leaderboard') await loadLeaderboard(true);
        else if (what === 'loot') await loadLoot(true);
      } finally {
        setButtonBusy(button, false);
      }
    });
  });

  var extensionRefreshButton = document.getElementById('extension-refresh');
  if (extensionRefreshButton) extensionRefreshButton.addEventListener('click', async function () {
    setButtonBusy(extensionRefreshButton, true, 'Refreshing…');
    try {
      activateView('account');
      await ensureRelayReady(true);
      if (window.FishingbotAccount && typeof window.FishingbotAccount.refresh === 'function') {
        await window.FishingbotAccount.refresh();
      }
    } catch (_error) { /* Relay and account status surfaces contain recovery guidance. */ }
    finally { setButtonBusy(extensionRefreshButton, false); }
  });

  if (!window.Twitch || !window.Twitch.ext) {
    setConnection('stale', 'Open in host player');
    setRelayStatus('warming', 'Open this Extension in the Twitch player to check the relay and wake it when needed', false);
    leaderHighlight.textContent = 'Open this Extension inside its host player to receive live channel stats.';
  } else {
    window.Twitch.ext.onAuthorized(function (auth) {
      extensionJwt = auth && typeof auth.token === 'string' ? auth.token : '';
      ensureRelayReady(false).catch(function () {});
      if (!lastSnapshotAt) setConnection('waiting', 'Waiting');
      if (window.FishingbotAccount) { window.FishingbotAccount.onAuthorized(auth); window.FishingbotAccount.open(); }
      if (currentView === 'leaderboard') loadLeaderboard(true);
      if (currentView === 'loot') loadLoot(true);
    });
    window.Twitch.ext.listen('broadcast', function (_target, _contentType, message) {
      if (!visibility) return;
      showSnapshot(parseMessage(message));
    });
    if (typeof window.Twitch.ext.onVisibilityChanged === 'function') {
      window.Twitch.ext.onVisibilityChanged(function (isVisible) { visibility = !!isVisible; });
    }
    if (typeof window.Twitch.ext.onError === 'function') {
      window.Twitch.ext.onError(function () { setConnection('stale', 'Connection issue'); });
    }
  }

  activateView('account');

  window.setInterval(function () {
    if (!visibility || !lastSnapshotAt) return;
    var age = Date.now() - lastSnapshotAt;
    if (age > 35_000) setConnection('stale', 'Waiting for streamer');
    else setConnection('live', 'PUBSUB LIVE');
  }, 5_000);
})();
