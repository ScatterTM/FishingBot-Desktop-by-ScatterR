(function () {
  'use strict';
  var connection = document.getElementById('connection');
  var connectionText = document.getElementById('connection-text');
  var totalCasts = document.getElementById('total-casts');
  var totalAnglers = document.getElementById('total-anglers');
  var list = document.getElementById('leaderboard');
  var empty = document.getElementById('empty');
  var updated = document.getElementById('updated-at');
  var lastSnapshotAt = 0;

  function setConnection(state, message) {
    connection.className = 'connection ' + state;
    connectionText.textContent = message;
  }

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)).toLocaleString() : '0';
  }

  function addText(parent, className, text) {
    var node = document.createElement('div');
    node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function showSnapshot(snapshot) {
    if (!snapshot || snapshot.type !== 'fishingbot.snapshot' || snapshot.schema !== 1) return;
    lastSnapshotAt = Number(snapshot.sentAt) || Date.now();
    totalCasts.textContent = number(snapshot.totalCasts);
    totalAnglers.textContent = number(snapshot.totalAnglers);
    updated.textContent = 'Updated ' + new Date(lastSnapshotAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    list.textContent = '';
    var rows = Array.isArray(snapshot.leaderboard) ? snapshot.leaderboard.slice(0, 10) : [];
    empty.style.display = rows.length ? 'none' : 'block';
    rows.forEach(function (row, index) {
      var item = document.createElement('li');
      addText(item, 'rank', '#' + String(index + 1));
      var info = document.createElement('div');
      info.className = 'angler';
      addText(info, 'username', String(row.username || 'Angler'));
      var best = row.bestCatch ? String(row.bestCatch) + (row.bestTier ? ' · ' + String(row.bestTier) : '') : 'No best catch recorded';
      addText(info, 'best', best);
      item.appendChild(info);
      var count = document.createElement('div');
      count.className = 'catches';
      count.textContent = number(row.casts);
      var label = document.createElement('span');
      label.textContent = 'casts';
      count.appendChild(label);
      item.appendChild(count);
      list.appendChild(item);
    });
    setConnection('live', 'Live from Twitch');
  }

  function parseMessage(message) {
    try { return typeof message === 'string' ? JSON.parse(message) : message; }
    catch (_error) { return null; }
  }

  if (!window.Twitch || !window.Twitch.ext) {
    setConnection('stale', 'Open in Twitch');
    empty.textContent = 'This panel must be opened inside Twitch.';
    return;
  }

  window.Twitch.ext.onAuthorized(function () {
    setConnection(lastSnapshotAt ? 'live' : 'waiting', lastSnapshotAt ? 'Live from Twitch' : 'Waiting for update');
  });
  window.Twitch.ext.listen('broadcast', function (_target, _contentType, message) {
    showSnapshot(parseMessage(message));
  });

  window.setInterval(function () {
    if (!lastSnapshotAt) return;
    var age = Date.now() - lastSnapshotAt;
    if (age > 35_000) setConnection('stale', 'Waiting for streamer');
    else setConnection('live', 'Live from Twitch');
  }, 5_000);
})();
