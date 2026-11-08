(function installGameModeLauncher() {
  if (window.__gameModeInstalled) return;
  window.__gameModeInstalled = true;

  var INSTALLED_KEY = 'gm-app-installed';

  function wasInstalled() {
    try { return localStorage.getItem(INSTALLED_KEY) === '1'; } catch (e) { return false; }
  }

  // Let the browser install the game as an app from this site's pages.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/game-sw.js', { scope: '/' }).catch(function () {});
  }

  var SEEN_KEY = 'gm-install-seen';
  var btn = document.createElement('button');
  btn.className = 'gm-toggle';
  btn.type = 'button';
  btn.innerHTML = 'Install app <span class="gm-new">New</span>';
  btn.setAttribute('aria-label', 'Install the Fishy Fishing web app');
  try { if (localStorage.getItem(SEEN_KEY) === '1') btn.dataset.seen = '1'; } catch (e) {}

  btn.addEventListener('click', function () {
    btn.dataset.seen = '1';
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
    // The install window is opened by this page, so it can close itself after installing.
    // Once installed, the app is opened from the Start menu or taskbar; this button then
    // opens the game page in a normal window as a fallback.
    var url = wasInstalled() ? '/game' : '/game?install=1';
    var w = 440, h = 560;
    var left = Math.max(0, (window.screen.availWidth - w) - 24);
    var win = window.open(url, 'fishy-game-mode',
      'popup=yes,width=' + w + ',height=' + h + ',left=' + left + ',top=80,resizable=yes');
    if (win) win.focus();
    else window.location.href = url;
  });

  // Place the button in the site's top bar, on the right, next to the operator
  // login, so it lines up with the Updates button. Falls back to a corner button.
  var topBar = document.querySelector('.top-bar');
  var adminBtn = document.getElementById('adminAuthBtn');
  if (topBar && adminBtn) {
    var right = document.createElement('div');
    right.className = 'gm-right';
    topBar.appendChild(right);
    right.appendChild(btn);
    right.appendChild(adminBtn);
    btn.className = 'gm-install-btn';
  } else {
    document.body.appendChild(btn);
  }
})();
