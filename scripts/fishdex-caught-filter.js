/* Fishdex toolbar: "Show caught only" and name search for the homepage Fishdex.
 * Presentation only: it never changes API data or the collection totals.
 * Both settings are remembered per browser.
 * The homepage re-renders #fishdexTiers on every load, so the filters are
 * classes on that container and the cells are marked again after each render. */
(function () {
  'use strict';

  var BTN_ID = 'dexCaughtOnlyBtn';
  var SEARCH_ID = 'dexSearch';
  var STYLE_ID = 'dex-filter-style';
  var CAUGHT_KEY = 'fishingHub.fishdex.caughtOnly';
  var caughtOnly = false;

  var css = [
    '#fishdexTiers.dex-caught-only .dex-item-cell.locked{display:none;}',
    '#fishdexTiers.dex-caught-only .tier-card:not(:has(.dex-item-cell.caught)){display:none;}',
    '#fishdexTiers.dex-searching .dex-item-cell:not(.dex-match){display:none;}',
    '#fishdexTiers.dex-searching .tier-card:not(:has(.dex-match)){display:none;}',
    '#fishdexTiers.dex-searching .tier-card .dex-item-grid{display:grid;}',
    '.dex-toolbar-status{font-family:var(--font-mono);font-size:0.62rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--bone-40);align-self:center;}',
    '.dex-search{width:min(200px,100%);padding:7px 0;border:0;border-bottom:1px solid var(--bone-24);background:transparent;color:var(--bone);font:500 0.7rem var(--font-mono);letter-spacing:0.08em;}',
    '.dex-search::placeholder{color:var(--bone-40);text-transform:uppercase;letter-spacing:0.12em;}',
    '.dex-search:focus{outline:none;border-bottom-color:var(--signal);}',
    '.dex-caught-empty{margin:0 0 14px;color:var(--bone-60);font-size:0.8rem;line-height:1.6;}',
    '.dex-caught-empty[hidden]{display:none;}'
  ].join('\n');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  function readCaughtOnly() {
    try { return localStorage.getItem(CAUGHT_KEY) === '1'; } catch (e) { return false; }
  }
  function saveCaughtOnly() {
    try { localStorage.setItem(CAUGHT_KEY, caughtOnly ? '1' : '0'); } catch (e) {}
  }

  function refresh(container, btn, search, status, empty) {
    var query = search.value.trim().toLowerCase();
    var cells = container.querySelectorAll('.dex-item-cell');
    var species = container.querySelectorAll('.dex-item-cell.caught').length;
    var matches = 0;

    cells.forEach(function (cell) {
      var name = (cell.querySelector('.item-name')?.textContent || '').toLowerCase();
      var hit = !query || name.indexOf(query) !== -1;
      cell.classList.toggle('dex-match', hit);
      if (hit) matches++;
    });

    container.classList.toggle('dex-caught-only', caughtOnly);
    container.classList.toggle('dex-searching', !!query);
    btn.setAttribute('aria-pressed', String(caughtOnly));
    btn.lastChild.textContent = caughtOnly ? ' Show all fish' : ' Show caught only';

    if (query) {
      status.textContent = matches.toLocaleString() + (matches === 1 ? ' match' : ' matches');
    } else if (caughtOnly) {
      status.textContent = species.toLocaleString() + ' caught species';
    } else {
      status.textContent = '';
    }

    if (query && matches === 0) {
      empty.textContent = 'No fish match "' + search.value.trim() + '". Check the spelling or clear the search.';
      empty.hidden = false;
    } else if (caughtOnly && species === 0 && !query) {
      empty.textContent = 'No caught fish to show yet. Catch fish in chat and your collection will appear here.';
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }
  }

  function init() {
    var container = document.getElementById('fishdexTiers');
    var toolbar = document.querySelector('.dex-toolbar-actions');
    if (!container || !toolbar || document.getElementById(BTN_ID)) return;
    ensureStyle();
    caughtOnly = readCaughtOnly();

    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'dex-toolbar-btn';
    btn.setAttribute('aria-pressed', String(caughtOnly));
    btn.innerHTML = '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-check-ring"></use></svg> Show caught only';

    var search = document.createElement('input');
    search.id = SEARCH_ID;
    search.type = 'search';
    search.className = 'dex-search';
    search.placeholder = 'Search fish';
    search.setAttribute('aria-label', 'Search your fish index by name');
    search.autocomplete = 'off';

    var status = document.createElement('span');
    status.className = 'dex-toolbar-status';
    status.setAttribute('aria-live', 'polite');

    var empty = document.createElement('p');
    empty.className = 'dex-caught-empty';
    empty.hidden = true;

    toolbar.appendChild(btn);
    toolbar.appendChild(search);
    toolbar.appendChild(status);
    container.parentNode.insertBefore(empty, container);

    btn.addEventListener('click', function () {
      caughtOnly = !caughtOnly;
      saveCaughtOnly();
      refresh(container, btn, search, status, empty);
    });
    search.addEventListener('input', function () {
      refresh(container, btn, search, status, empty);
    });

    new MutationObserver(function () {
      refresh(container, btn, search, status, empty);
    }).observe(container, { childList: true });

    refresh(container, btn, search, status, empty);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
