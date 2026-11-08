// Folder app. Browse the local database by viewer, search everything in it (keys, stored values and list items),
// and edit one entry at a time. Everything is grouped by viewer. Reads and writes happen in the main process
// through the bridge from preload.js (dbList, dbRead, dbSave, dbSearch, getSettings, saveSettings, getState).
(() => {
  'use strict';

  const TEXT_BOX_FROM = 80;   // strings this long (or with line breaks) get a multi-line box
  const LIST_LIMIT = 200;     // changes shown in the confirmation before "and N more"
  const SEARCH_MIN = 2;       // shortest query that searches the database
  const SEARCH_DELAY_MS = 220;
  const ALL = '\u0000all';
  const SHARED = '\u0000shared';
  const VIEWER_SORTS = [['name-asc', 'Name (A–Z)'], ['name-desc', 'Name (Z–A)'], ['count-desc', 'Most entries'], ['size-desc', 'Largest']];
  const ENTRY_SORTS = [['key-asc', 'Key (A–Z)'], ['key-desc', 'Key (Z–A)'], ['size-desc', 'Largest'], ['expiry-asc', 'Expiring first']];
  const TYPES = [['all', 'All'], ['value', 'Values'], ['list', 'Lists'], ['expired', 'Expired']];
  const encoder = new TextEncoder();
  const SIDE_KEY = 'fishingbot.folder.side';  // viewers panel width in px, remembered per browser
  const SIDE_DEFAULT = 230;
  const SIDE_MIN = 170;
  const SIDE_MAX = 420;
  const SIDE_RESERVE = 380;                    // the listings and the editor keep at least this much
  function readSide() {
    try {
      const v = Number(localStorage.getItem(SIDE_KEY));
      return v >= SIDE_MIN && v <= SIDE_MAX ? v : SIDE_DEFAULT;
    } catch {
      return SIDE_DEFAULT;
    }
  }
  const SPLIT_KEY = 'fishingbot.folder.split';  // editor width as a share of the work area, remembered per browser
  const SPLIT_DEFAULT = 0.46;
  const SPLIT_MIN = 0.22;
  const SPLIT_MAX = 0.78;
  function readSplit() {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      return v >= SPLIT_MIN && v <= SPLIT_MAX ? v : SPLIT_DEFAULT;
    } catch {
      return SPLIT_DEFAULT;
    }
  }
  const t = (text, vars) => (window.I18n ? window.I18n.t(text, vars) : fill(text, vars));

  function fill(text, vars) {
    let out = text;
    if (vars) for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(String(value));
    return out;
  }

  // Small DOM helper. Text is always set as text, never as HTML.
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'value') node.value = v == null ? '' : String(v);
      else if (k === 'checked') node.checked = !!v;
      else if (v === undefined || v === null || v === false) continue;
      else if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === undefined || kid === null || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // UTF-8 bytes of a stored text, and a short readable size for the badges and the save summary.
  const bytesOf = (text) => (text == null ? 0 : encoder.encode(String(text)).length);
  function formatBytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Canonical text of a value with object keys sorted, so equal content compares equal.
  const canon = (value) => JSON.stringify(value, (key, v) => (isObj(v)
    ? Object.keys(v).sort().reduce((out, k) => { out[k] = v[k]; return out; }, {})
    : v));
  const same = (a, b) => canon(a) === canon(b);

  // Field-by-field changes from `before` to `after`. A path is the list of keys and indexes that getAt() follows.
  function diff(before, after, path = [], out = []) {
    if (isObj(before) && isObj(after)) {
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!(k in after)) out.push({ path: [...path, k], type: 'removed', before: before[k], after: undefined });
        else if (!(k in before)) out.push({ path: [...path, k], type: 'added', before: undefined, after: after[k] });
        else diff(before[k], after[k], [...path, k], out);
      }
      return out;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      const n = Math.max(before.length, after.length);
      for (let i = 0; i < n; i++) {
        if (i >= after.length) out.push({ path: [...path, i], type: 'removed', before: before[i], after: undefined });
        else if (i >= before.length) out.push({ path: [...path, i], type: 'added', before: undefined, after: after[i] });
        else diff(before[i], after[i], [...path, i], out);
      }
      return out;
    }
    if (!same(before, after)) out.push({ path, type: 'changed', before, after });
    return out;
  }

  function summarize(changes) {
    const counts = { total: changes.length, changed: 0, added: 0, removed: 0 };
    for (const ch of changes) counts[ch.type] = (counts[ch.type] || 0) + 1;
    return counts;
  }

  // The stored text as a value. Text that is not JSON comes back with ok: false and the text itself.
  function parseRaw(raw) {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false, value: raw };
    }
  }

  // "items[3].name" style label for a path, and a short one-line form of a value.
  function pathLabel(path) {
    if (!path.length) return t('(whole value)');
    return path.reduce((label, seg) => (typeof seg === 'number' ? `${label}[${seg}]` : (label ? `${label}.${seg}` : String(seg))), '');
  }

  function shortValue(value) {
    if (value === undefined) return '—';
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }

  // Viewers are found from the keys: a key whose first part is a viewer-data root ends in the viewer's login.
  // Anything else (globals, settings, the loot table) is listed as shared. Logins can also be added by hand.
  const SEGMENT_SPLIT = /[:._/|\\-]+/;
  const VIEWER_ROOTS = new Set(['fish', 'toggle', 'user', 'user-mail-read', 'perm_luck', 'real_vip', 'game_vip',
    'treasury_spent', 'pond', 'trade', 'perk-gift', 'inventory', 'fish_format', 'perks', 'autofish', 'progress']);
  const NOT_VIEWER = new Set(['normal', 'cooldown', 'global', 'event_name', 'event_luck', 'event_expires', 'rarity',
    'treasury', 'all', 'default', 'simplechat', 'local', 'admin', 'master', 'broadcaster', 'channel', 'config',
    'session', 'auth', 'audit', 'ratelock', 'settings', 'count', 'bestitem', 'besttier', 'mail', 'read', 'vip',
    'temp', 'perm', 'rarityboost', 'treasuryonly', 'pondperk', 'bot', 'account', 'rate', 'unlocked', 'ledger',
    'gift', 'offer', 'catalog']);
  const ENTRY_CMP = {
    'key-asc': (a, b) => a.key.localeCompare(b.key),
    'key-desc': (a, b) => b.key.localeCompare(a.key),
    'size-desc': (a, b) => (b.size || 0) - (a.size || 0) || a.key.localeCompare(b.key),
    'expiry-asc': (a, b) => {
      const x = a.expires ?? Infinity;
      const y = b.expires ?? Infinity;
      return x === y ? a.key.localeCompare(b.key) : x - y;
    },
  };

  // The query's matches in a text, as text with <mark> around each one.
  function highlight(text, query) {
    const frag = document.createDocumentFragment();
    const lower = String(text);
    const needle = query.toLowerCase();
    if (!needle) { frag.append(lower); return frag; }
    const haystack = lower.toLowerCase();
    let i = 0;
    for (;;) {
      const at = haystack.indexOf(needle, i);
      if (at < 0) break;
      if (at > i) frag.append(lower.slice(i, at));
      frag.append(h('mark', { text: lower.slice(at, at + needle.length) }));
      i = at + needle.length;
    }
    if (i < lower.length) frag.append(lower.slice(i));
    return frag;
  }

  const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L20 20"/></svg>';

  window.FishingbotApps.folder = function mountFolder(body, api) {
    const state = {
      entries: [],
      loaded: false,
      dbPath: '',
      query: '',
      matches: null,        // null: browsing; an array: the search results for `query`
      searching: false,
      searchSeq: 0,
      viewer: ALL,          // ALL, SHARED, or a viewer login
      viewSort: 'name-asc',
      entrySort: 'key-asc',
      type: 'all',
      selected: null,       // { key, kind } of the open entry
      opening: false,
      mode: 'json',         // editor: 'json' | 'text'
      original: null,
      draft: null,
      rawOriginal: null,
      rawItems: null,
      expectedHash: null,
      invalid: new Set(),
      cfg: { showShared: true, showExpired: true, viewers: [] },
      extraViewers: [],
      split: readSplit(),   // editor share of the work area
      side: readSide(),     // viewers panel width in px
    };
    let searchTimer = null;

    // ----- layout -----
    const banner = h('div', { class: 'fd-banner', hidden: true },
      t('The server is running. It can write these entries at any time. Your save is refused if the entry changed since you opened it.'));
    const searchIcon = h('span', { class: 'fd-search-icon' });
    searchIcon.innerHTML = SEARCH_ICON;
    const searchInput = h('input', {
      type: 'search', class: 'fd-search-input', autocomplete: 'off', spellcheck: 'false',
      placeholder: t('Search keys, values and viewers, e.g. snapper'), 'aria-label': t('Search the database'),
      oninput: (e) => onQuery(e.target.value),
      onkeydown: (e) => { if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); searchInput.value = ''; onQuery(''); } },
    });
    const clearBtn = h('button', {
      class: 'fd-clear', type: 'button', 'aria-label': t('Clear search'), hidden: true,
      onclick: () => { searchInput.value = ''; onQuery(''); searchInput.focus(); },
    }, '×');
    const hintEl = h('span', { class: 'fd-hint' });
    const statusEl = h('span', { class: 'fd-status', role: 'status' });
    const viewerSort = h('select', {
      class: 'fd-select', 'aria-label': t('Sort viewers'),
      onchange: (e) => { state.viewSort = e.target.value; render(); },
    }, VIEWER_SORTS.map(([v, label]) => h('option', { value: v, text: t(label) })));
    const entrySort = h('select', {
      class: 'fd-select', 'aria-label': t('Sort entries'),
      onchange: (e) => { state.entrySort = e.target.value; render(); },
    }, ENTRY_SORTS.map(([v, label]) => h('option', { value: v, text: t(label) })));
    const typeBar = h('div', { class: 'fd-seg', role: 'group', 'aria-label': t('Show') });
    const viewerList = h('div', { class: 'fd-viewer-list', role: 'list', 'aria-label': t('Viewers') });
    const addInput = h('input', {
      type: 'text', maxlength: '25', placeholder: t('Add a viewer login'), 'aria-label': t('Viewer login'),
      onkeydown: (e) => { if (e.key === 'Enter') addViewer(); },
    });
    const addBtn = h('button', { class: 'btn', type: 'button', onclick: () => addViewer() }, t('Add'));

    const listTitle = h('h2', { class: 'fd-title' });
    const listSub = h('p', { class: 'fd-sub' });
    const mainList = h('div', { class: 'fd-list', role: 'list' });
    const listHead = h('div', { class: 'fd-main-head' },
      h('div', { class: 'fd-main-title' }, listTitle, listSub));

    const backBtn = h('button', { class: 'btn', type: 'button', onclick: () => closeEntry() }, '← ' + t('Back'));
    const editorTitle = h('h2', { class: 'fd-title fd-key-title' });
    const editorMeta = h('p', { class: 'fd-sub' });
    const editorHead = h('div', { class: 'fd-main-head fd-editor-head' },
      backBtn, h('div', { class: 'fd-main-title' }, editorTitle, editorMeta));
    const editorBody = h('div', { class: 'fd-editor-body' });
    const summary = h('span', { class: 'fd-summary' });
    const discardBtn = h('button', { class: 'btn', type: 'button', onclick: () => discardEdits(), disabled: true }, t('Discard'));
    const saveBtn = h('button', { class: 'btn solid', type: 'button', onclick: () => requestSave(), disabled: true }, t('Save changes'));
    const footer = h('div', { class: 'fd-footer' }, summary, discardBtn, saveBtn);

    const overlay = h('div', { class: 'fd-overlay', hidden: true });

    // Listings column: search and filters sit at the top, then the grouped list.
    const listCol = h('section', { class: 'fd-listcol' },
      h('header', { class: 'fd-toolbar' },
        h('label', { class: 'fd-search' }, searchIcon, searchInput, clearBtn),
        h('div', { class: 'fd-toolbar-meta' }, hintEl, statusEl)),
      h('div', { class: 'fd-filters' },
        h('div', { class: 'fd-ctl', role: 'group', 'aria-label': t('Show') }, h('span', { class: 'fd-ctl-label', text: t('Show') }), typeBar),
        h('label', { class: 'fd-ctl' }, h('span', { class: 'fd-ctl-label', text: t('Sort viewers') }), viewerSort),
        h('label', { class: 'fd-ctl' }, h('span', { class: 'fd-ctl-label', text: t('Sort entries') }), entrySort)),
      listHead,
      mainList);

    // Divider between the listings and the editor. Drag it, or use the arrow keys; double-click resets it.
    const handle = h('div', {
      class: 'fd-handle', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', hidden: true,
      'aria-label': t('Resize the editor'), title: t('Drag to resize. Double-click to reset.'),
      onpointerdown: (e) => startDrag(e),
      ondblclick: () => setSplit(SPLIT_DEFAULT, true),
      onkeydown: (e) => onHandleKey(e),
    });
    const editorCol = h('section', { class: 'fd-editorcol', hidden: true }, editorHead, editorBody, footer);
    const work = h('div', { class: 'fd-work', 'data-view': 'list' }, listCol, handle, editorCol);
    const sideHandle = h('div', {
      class: 'fd-handle fd-handle-side', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
      'aria-label': t('Resize the viewers panel'), title: t('Drag to resize. Double-click to reset.'),
      onpointerdown: (e) => startSideDrag(e),
      ondblclick: () => setSide(SIDE_DEFAULT, true),
      onkeydown: (e) => onSideKey(e),
    });

    const root = h('div', { class: 'fd', tabindex: '-1', onkeydown: (e) => onKey(e) },
      banner,
      h('div', { class: 'fd-body' },
        h('aside', { class: 'fd-side' },
          h('div', { class: 'fd-side-head' }, h('h2', { class: 'fd-side-title', text: t('Viewers') })),
          viewerList,
          h('div', { class: 'fd-add' }, addInput, addBtn)),
        sideHandle,
        work),
      overlay);
    root.style.setProperty('--fd-side', `${state.side}px`);
    body.append(root);

    // ----- data -----
    function loginsNow() {
      const found = new Set(state.extraViewers);
      for (const e of state.entries) {
        const segs = e.key.toLowerCase().split(SEGMENT_SPLIT).filter(Boolean);
        if (segs.length < 2 || !VIEWER_ROOTS.has(segs[0])) continue;
        const last = segs[segs.length - 1];
        if (/^[a-z0-9_]{2,25}$/.test(last) && !NOT_VIEWER.has(last)) found.add(last);
      }
      return [...found].sort();
    }

    const ownersOf = (key, logins) => {
      const segs = new Set(key.toLowerCase().split(SEGMENT_SPLIT));
      return logins.filter((login) => segs.has(login));
    };

    // The entries the screen works from: the search results while searching, otherwise every entry.
    const sourceList = () => (state.matches || state.entries).filter((e) => state.cfg.showExpired || !e.expired);
    const typeOk = (e) => (state.type === 'value' ? e.kind === 'value'
      : state.type === 'list' ? e.kind === 'list'
        : state.type === 'expired' ? !!e.expired : true);
    const sizeOf = (items) => items.reduce((n, e) => n + (e.size || 0), 0);

    // Groups of entries by viewer. `typed` applies the type filter (the list does, the viewer counts do not).
    function buildGroups(typed) {
      const logins = loginsNow();
      const groups = new Map();
      const add = (id, label, e) => {
        if (!groups.has(id)) groups.set(id, { id, label, items: [] });
        groups.get(id).items.push(e);
      };
      for (const e of sourceList()) {
        if (typed && !typeOk(e)) continue;
        const owners = ownersOf(e.key, logins);
        if (!owners.length) {
          if (state.cfg.showShared) add(SHARED, t('Shared and system keys'), e);
        } else {
          for (const login of owners) add(login, login, e);
        }
      }
      // In browsing, every known viewer is listed, even one with no entries yet.
      if (!state.matches) for (const login of logins) if (!groups.has(login)) groups.set(login, { id: login, label: login, items: [] });
      return sortGroups([...groups.values()]);
    }

    function sortGroups(list) {
      const byName = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
      let cmp = byName;
      if (state.viewSort === 'name-desc') cmp = (a, b) => byName(b, a);
      else if (state.viewSort === 'count-desc') cmp = (a, b) => b.items.length - a.items.length || byName(a, b);
      else if (state.viewSort === 'size-desc') cmp = (a, b) => sizeOf(b.items) - sizeOf(a.items) || byName(a, b);
      const viewers = list.filter((g) => g.id !== SHARED).sort(cmp);
      return [...viewers, ...list.filter((g) => g.id === SHARED)];
    }

    // ----- layout pieces -----
    function skeletonRows(count, kind) {
      return Array.from({ length: count }, (_, i) => h('div', { class: `fd-skel-row ${kind}`, 'aria-hidden': 'true' },
        h('span', { class: 'fd-skel fd-skel-a', style: `width:${46 + ((i * 23) % 40)}%` }),
        h('span', { class: 'fd-skel fd-skel-b' })));
    }

    function viewerRow(row) {
      const on = state.viewer === row.id;
      const avatar = row.id === ALL ? '•' : row.id === SHARED ? '◦' : row.label.charAt(0).toUpperCase();
      return h('button', {
        class: `fd-viewer${on ? ' on' : ''}${row.id === SHARED ? ' shared' : ''}`, type: 'button', role: 'listitem',
        'aria-pressed': String(on),
        onclick: () => { state.viewer = row.id; render(); },
      },
      h('span', { class: 'fd-avatar', 'aria-hidden': 'true', text: avatar }),
      h('span', { class: 'fd-viewer-name', text: row.label }),
      h('span', { class: 'fd-count', text: String(row.count) }));
    }

    function renderViewers() {
      if (!state.loaded || state.searching) {
        viewerList.replaceChildren(...skeletonRows(6, 'viewer'));
        viewerList.setAttribute('aria-busy', 'true');
        return;
      }
      viewerList.removeAttribute('aria-busy');
      const all = sourceList();
      const rows = [{ id: ALL, label: state.matches ? t('All matches') : t('All entries'), count: all.length }];
      for (const g of buildGroups(false)) rows.push({ id: g.id, label: g.label, count: g.items.length });
      if (!rows.some((r) => r.id === state.viewer)) state.viewer = ALL;
      viewerList.replaceChildren(...rows.map(viewerRow));
    }

    function renderControls() {
      typeBar.replaceChildren(...TYPES.map(([id, label]) => h('button', {
        class: 'fd-seg-btn', type: 'button', 'aria-pressed': String(state.type === id),
        onclick: () => { state.type = id; render(); },
      }, t(label))));
      viewerSort.value = state.viewSort;
      entrySort.value = state.entrySort;
    }

    function entryRow(e) {
      const active = !!state.selected && state.selected.key === e.key && state.selected.kind === e.kind;
      const q = state.query.trim();
      const hit = !!state.matches;
      const badges = [h('span', { class: `fd-badge ${e.kind === 'list' ? 'list' : 'value'}`, text: e.kind === 'list' ? t('List') : t('Value') })];
      if (hit) badges.push(h('span', { class: 'fd-badge hit', text: t('{count} matches', { count: e.count }) }));
      else if (e.kind === 'list') badges.push(h('span', { class: 'fd-badge', text: t('{count} items', { count: e.count }) }));
      badges.push(h('span', { class: 'fd-mono fd-size', text: formatBytes(e.size || 0) }));
      if (e.expired) badges.push(h('span', { class: 'fd-badge bad', text: t('Expired') }));
      const snippet = hit && e.snippet && e.snippet !== e.key ? h('span', { class: 'fd-snippet' }, highlight(e.snippet, q)) : null;
      return h('button', {
        class: `fd-row${active ? ' on' : ''}${e.expired ? ' expired' : ''}`, type: 'button', role: 'listitem',
        title: e.key, 'aria-current': active ? 'true' : null,
        onclick: () => openEntry({ key: e.key, kind: e.kind }, false),
      },
      h('span', { class: 'fd-row-main' },
        h('span', { class: 'fd-key' }, hit && e.keyMatch ? highlight(e.key, q) : e.key),
        snippet),
      h('span', { class: 'fd-row-badges' }, badges));
    }

    function emptyState() {
      if (state.matches) {
        return h('div', { class: 'fd-empty' },
          h('strong', { text: t('No matches for "{query}"', { query: state.query.trim() }) }),
          h('p', { class: 'fd-muted', text: t('The search looks in every key and in every stored value. Try a different word.') }));
      }
      if (!state.entries.length) {
        return h('div', { class: 'fd-empty' },
          h('strong', { text: t('The database is empty or missing.') }),
          h('p', { class: 'fd-muted fd-path', text: state.dbPath }));
      }
      return h('div', { class: 'fd-empty' },
        h('strong', { text: t('Nothing matches these filters.') }),
        h('p', { class: 'fd-muted', text: t('Change the type filter, or show expired entries in Settings > Folder.') }));
    }

    function renderList() {
      const searching = !!state.matches;
      listTitle.textContent = state.viewer === ALL
        ? (searching ? t('Search results') : t('All entries'))
        : (state.viewer === SHARED ? t('Shared and system keys') : state.viewer);
      if (!state.loaded || state.searching) {
        listSub.textContent = state.searching ? t('Searching the database…') : t('Loading entries…');
        mainList.setAttribute('aria-busy', 'true');
        mainList.replaceChildren(...skeletonRows(8, 'row'));
        return;
      }
      mainList.removeAttribute('aria-busy');
      const groups = buildGroups(true).filter((g) => g.items.length && (state.viewer === ALL || g.id === state.viewer));
      const shown = groups.reduce((n, g) => n + g.items.length, 0);
      listSub.textContent = searching
        ? t('{count} entries match, grouped by viewer', { count: shown })
        : t('{count} entries, grouped by viewer', { count: shown });
      if (!groups.length || !shown) { mainList.replaceChildren(emptyState()); return; }
      const cmp = ENTRY_CMP[state.entrySort] || ENTRY_CMP['key-asc'];
      const nodes = [];
      for (const g of groups) {
        nodes.push(h('div', { class: `fd-group-head${g.id === SHARED ? ' shared' : ''}`, role: 'presentation' },
          h('span', { class: 'fd-group-name', text: g.label }),
          h('span', { class: 'fd-count', text: String(g.items.length) })));
        for (const e of [...g.items].sort(cmp)) nodes.push(entryRow(e));
      }
      mainList.replaceChildren(...nodes);
    }

    function updateHint() {
      if (state.matches) {
        hintEl.textContent = t('{count} entries match', { count: state.matches.length });
      } else if (state.query.trim().length && state.query.trim().length < SEARCH_MIN) {
        hintEl.textContent = t('Type at least {min} characters to search', { min: SEARCH_MIN });
      } else {
        hintEl.textContent = state.loaded ? t('{count} entries', { count: state.entries.length }) : '';
      }
    }

    // Dragging. The pointer position is applied once per frame, and the panes stop receiving pointer events
    // while a divider moves (see .fd-dragging in folder.css), so the list does not repaint on every move.
    function dragPointer(grip, event, onFrame, onEnd) {
      if (event.button !== 0) return;
      event.preventDefault();
      let latest = null;
      let frame = 0;
      const move = (ev) => {
        latest = ev.clientX;
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; onFrame(latest); });
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        if (frame) cancelAnimationFrame(frame);
        if (latest !== null) onFrame(latest);
        root.classList.remove('fd-dragging');
        win?.classList.remove('live-change');
        onEnd();
      };
      root.classList.add('fd-dragging');
      // The window's blur is repainted every frame it moves; turn it off while the divider moves.
      const win = root.closest('.window');
      win?.classList.add('live-change');
      grip.setPointerCapture(event.pointerId);
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    }

    // The editor: its width is a share of the work area.
    function applySplit() {
      editorCol.style.flexBasis = `${(state.split * 100).toFixed(2)}%`;
    }
    function setSplit(value, persist) {
      state.split = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
      applySplit();
      if (persist) {
        try { localStorage.setItem(SPLIT_KEY, String(state.split)); } catch { /* storage may be blocked */ }
      }
    }
    function startDrag(event) {
      const rect = work.getBoundingClientRect();
      dragPointer(handle, event, (x) => setSplit((rect.right - x) / rect.width, false), () => setSplit(state.split, true));
    }
    function onHandleKey(event) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); setSplit(state.split + 0.02, true); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); setSplit(state.split - 0.02, true); }
    }

    // The viewers panel: its width in px.
    function setSide(px, persist, available) {
      const room = available || sideHandle.parentElement.clientWidth;
      const max = Math.max(SIDE_MIN, Math.min(SIDE_MAX, room - SIDE_RESERVE));
      state.side = Math.min(max, Math.max(SIDE_MIN, Math.round(px)));
      root.style.setProperty('--fd-side', `${state.side}px`);
      if (persist) {
        try { localStorage.setItem(SIDE_KEY, String(state.side)); } catch { /* storage may be blocked */ }
      }
    }
    function startSideDrag(event) {
      const row = sideHandle.parentElement.getBoundingClientRect();
      dragPointer(sideHandle, event, (x) => setSide(x - row.left, false, row.width), () => setSide(state.side, true, row.width));
    }
    function onSideKey(event) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); setSide(state.side - 10, true); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); setSide(state.side + 10, true); }
    }

    function renderMain() {
      const editing = !!state.selected || state.opening;
      editorCol.hidden = !editing;
      handle.hidden = !editing;
      work.dataset.view = editing ? 'split' : 'list';
      if (editing) applySplit();
      renderList();
    }

    function render() {
      renderControls();
      renderViewers();
      renderMain();
      updateHint();
    }

    function setStatus(text, tone) {
      statusEl.textContent = text || '';
      statusEl.className = `fd-status${tone ? ` ${tone}` : ''}`;
    }

    function onKey(event) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (event.key === '/' && !typing && !state.selected) {
        event.preventDefault();
        searchInput.focus();
      } else if (event.key === 'Escape' && state.selected && !typing) {
        closeEntry();
      }
    }

    // ----- search -----
    function onQuery(value) {
      clearBtn.hidden = !value;
      if (state.selected && currentChanges().length) {
        setStatus(t('Save or discard your changes first.'), 'bad');
        return;
      }
      if (state.selected) closeEditorState();
      state.query = value;
      clearTimeout(searchTimer);
      const q = value.trim();
      if (q.length < SEARCH_MIN) {
        state.searchSeq++;
        state.searching = false;
        state.matches = null;
        setStatus('');
        render();
        return;
      }
      state.searching = true;
      render();
      searchTimer = setTimeout(() => runSearch(q), SEARCH_DELAY_MS);
    }

    async function runSearch(q) {
      const seq = ++state.searchSeq;
      state.searching = true;
      const reply = await api.dbSearch({ query: q });
      if (seq !== state.searchSeq) return;
      state.searching = false;
      if (!reply.ok) {
        state.matches = [];
        setStatus(reply.error, 'bad');
      } else {
        const now = Date.now();
        state.matches = (reply.matches || []).map((m) => ({ ...m, expired: m.expires != null && m.expires <= now }));
        setStatus('');
      }
      render();
    }

    // ----- loading -----
    async function loadList(initial) {
      if (initial || !state.loaded) {
        state.loaded = false;
        render();
      }
      const view = await api.getSettings().catch(() => null);
      const cfg = (view && view.folder) || state.cfg;
      state.cfg = cfg;
      state.extraViewers = cfg.viewers || [];
      const reply = await api.dbList();
      state.loaded = true;
      if (!reply.ok) {
        state.entries = [];
        setStatus(reply.error, 'bad');
      } else {
        state.entries = reply.items || [];
        state.dbPath = reply.dbPath || '';
        setStatus('');
      }
      render();
      const server = await api.getState().catch(() => null);
      banner.hidden = !(server && server.online);
    }

    // ----- adding a viewer (kept in Settings > Folder, so it is the same in every window) -----
    async function addViewer() {
      const login = addInput.value.trim().replace(/^@+/, '').toLowerCase();
      if (!/^[a-z0-9_]{2,25}$/.test(login)) {
        setStatus(t('Enter a valid Twitch login (1–25 letters, numbers or underscores).'), 'bad');
        return;
      }
      const list = state.extraViewers.includes(login) ? state.extraViewers : [...state.extraViewers, login];
      const reply = await api.saveSettings('folder', { viewers: list });
      if (!reply.ok) { setStatus(reply.error, 'bad'); return; }
      state.extraViewers = reply.settings.folder.viewers;
      state.cfg = reply.settings.folder;
      addInput.value = '';
      state.viewer = login;
      setStatus(t('Viewer {login} added.', { login }), 'ok');
      render();
    }

    // ----- opening, closing and editing one entry -----
    function setEditorHeader(key, meta) {
      editorTitle.textContent = key;
      editorMeta.textContent = meta || '';
    }

    async function openEntry(entry, force) {
      if (!force && !(await confirmDiscard())) return;
      state.opening = true;
      state.selected = null;
      setEditorHeader(entry.key, '');
      editorBody.replaceChildren(...skeletonRows(5, 'field'));
      editorBody.setAttribute('aria-busy', 'true');
      summary.textContent = '';
      discardBtn.disabled = true;
      saveBtn.disabled = true;
      render();

      const reply = await api.dbRead(entry.key, entry.kind);
      state.opening = false;
      editorBody.removeAttribute('aria-busy');
      if (!reply.ok) {
        setStatus(reply.error, 'bad');
        render();
        return;
      }
      if (reply.missing) {
        setStatus(t('This entry no longer exists. The list was refreshed.'), 'bad');
        await loadList(false);
        return;
      }
      state.selected = { key: entry.key, kind: entry.kind };
      state.expectedHash = reply.hash;
      if (entry.kind === 'list') {
        state.rawItems = reply.items;
        state.mode = 'json';
        state.original = reply.items.map((raw) => parseRaw(raw).value);
      } else {
        const parsed = parseRaw(reply.raw);
        state.rawOriginal = reply.raw;
        state.mode = parsed.ok ? 'json' : 'text';
        state.original = parsed.value;
      }
      state.draft = structuredClone(state.original);
      state.invalid.clear();

      const size = entry.kind === 'list'
        ? reply.items.reduce((sum, raw) => sum + raw.length, 0)
        : reply.raw.length;
      const meta = [entry.kind === 'list' ? t('List · {count} items', { count: reply.items.length }) : t('Value'), formatBytes(size)];
      if (reply.expires) {
        meta.push(reply.expires <= Date.now()
          ? t('Expired')
          : t('Expires {date}', { date: new Date(reply.expires).toLocaleString() }));
      }
      setEditorHeader(entry.key, meta.join(' · '));
      setStatus('');
      renderEditor();
      updateSummary();
      render();
      backBtn.focus({ preventScroll: true });
    }

    async function closeEntry() {
      if (state.selected && !(await confirmDiscard())) return;
      closeEditorState();
      render();
    }

    function closeEditorState() {
      state.selected = null;
      state.original = null;
      state.draft = null;
      state.invalid.clear();
      editorBody.replaceChildren();
      setEditorHeader('', '');
    }

    const getAt = (path) => path.reduce((node, seg) => node[seg], state.draft);

    function setAt(path, value) {
      if (!path.length) state.draft = value;
      else getAt(path.slice(0, -1))[path[path.length - 1]] = value;
      afterChange();
    }

    function addItem(path) {
      const arr = getAt(path);
      const template = arr.length ? arr[arr.length - 1] : '';
      arr.push(structuredClone(template));
      renderEditor();
      afterChange();
    }

    function removeItem(path) {
      const parent = getAt(path.slice(0, -1));
      parent.splice(path[path.length - 1], 1);
      renderEditor();
      afterChange();
    }

    function leafControl(value, path) {
      const key = JSON.stringify(path);
      if (typeof value === 'boolean') {
        return h('input', { type: 'checkbox', checked: value, 'aria-label': pathLabel(path), onchange: (e) => setAt(path, e.target.checked) });
      }
      if (typeof value === 'number') {
        return h('input', {
          type: 'number', step: 'any', value: String(value), 'aria-label': pathLabel(path),
          oninput: (e) => {
            const text = e.target.value.trim();
            const n = text === '' ? NaN : Number(text);
            if (Number.isFinite(n)) {
              state.invalid.delete(key);
              e.target.classList.remove('invalid');
              setAt(path, n);
            } else {
              state.invalid.add(key);
              e.target.classList.add('invalid');
              updateSummary();
            }
          },
        });
      }
      // Strings and null. null stays null while the box is empty; typing turns it into a string.
      const isNull = value === null;
      const onInput = (e) => {
        const text = e.target.value;
        setAt(path, isNull && text === '' ? null : text);
      };
      const text = isNull ? '' : value;
      const placeholder = isNull ? t('null (leave empty to keep null)') : undefined;
      const multi = !isNull && (value.length > TEXT_BOX_FROM || value.includes('\n'));
      return multi
        ? h('textarea', { rows: 3, value: text, placeholder, 'aria-label': pathLabel(path), oninput: onInput })
        : h('input', { type: 'text', value: text, placeholder, 'aria-label': pathLabel(path), oninput: onInput });
    }

    // The form for the draft. Each leaf is one field; objects and arrays are groups.
    function valueNode(value, path, label, removable) {
      let node;
      if (Array.isArray(value)) {
        node = h('fieldset', { class: 'fd-group', 'data-path': JSON.stringify(path) },
          h('legend', { text: `${label} (${value.length})` }),
          value.map((item, i) => valueNode(item, [...path, i], `[${i}]`, true)),
          h('button', { class: 'btn fd-add-item', type: 'button', onclick: () => addItem(path) }, t('Add item')));
      } else if (isObj(value)) {
        node = h('fieldset', { class: 'fd-group' },
          h('legend', { text: label }),
          Object.keys(value).map((k) => valueNode(value[k], [...path, k], k, false)));
      } else {
        node = h('div', { class: 'fd-field', 'data-path': JSON.stringify(path) },
          h('span', { class: 'fd-field-key', text: label }),
          leafControl(value, path));
      }
      if (removable) {
        node.append(h('button', {
          class: 'btn danger fd-remove', type: 'button', 'aria-label': `${t('Remove')} ${label}`,
          onclick: () => removeItem(path),
        }, t('Remove')));
      }
      return node;
    }

    function renderEditor() {
      if (!state.selected) return;
      const top = editorBody.scrollTop;
      state.invalid.clear();
      if (state.mode === 'text') {
        const area = h('textarea', {
          class: 'fd-text', rows: 14, value: state.draft, 'aria-label': t('Value'),
          oninput: (e) => { state.draft = e.target.value; afterChange(); },
        });
        editorBody.replaceChildren(h('p', { class: 'fd-muted', text: t('This value is not JSON. It is edited as plain text.') }), area);
      } else if (state.selected.kind === 'list') {
        editorBody.replaceChildren(valueNode(state.draft, [], t('items'), false));
      } else {
        editorBody.replaceChildren(valueNode(state.draft, [], t('(whole value)'), false));
      }
      editorBody.scrollTop = top;
      markDirty();
    }

    function currentChanges() {
      if (!state.selected) return [];
      if (state.mode === 'text') {
        return state.draft === state.original
          ? []
          : [{ path: [], type: 'changed', before: state.original, after: state.draft }];
      }
      return diff(state.original, state.draft);
    }

    // What gets written. Unchanged entries keep their stored text exactly, so a save never reformats them.
    function buildPayload() {
      if (state.mode === 'text') return { raw: state.draft };
      if (state.selected.kind === 'list') {
        return {
          items: state.draft.map((item, i) => (
            i < state.original.length && same(item, state.original[i]) ? state.rawItems[i] : JSON.stringify(item)
          )),
        };
      }
      return { raw: same(state.draft, state.original) ? state.rawOriginal : JSON.stringify(state.draft) };
    }

    function basePayload() {
      if (state.selected.kind === 'list') return { items: state.rawItems };
      return { raw: state.rawOriginal };
    }

    const payloadBytes = (p) => (p.items
      ? p.items.reduce((sum, item) => sum + bytesOf(item), 0)
      : bytesOf(p.raw));

    function afterChange() {
      updateSummary();
      markDirty();
    }

    function markDirty() {
      const keys = new Set(currentChanges().map((c) => JSON.stringify(c.path)));
      editorBody.querySelectorAll('.fd-field[data-path]').forEach((row) => {
        row.classList.toggle('dirty', keys.has(row.dataset.path));
      });
    }

    function updateSummary() {
      const n = currentChanges().length;
      const bad = state.invalid.size > 0;
      summary.textContent = bad
        ? t('Fix the highlighted numbers first.')
        : (n ? t('{count} fields changed', { count: n }) : t('No changes'));
      saveBtn.disabled = !state.selected || !n || bad;
      discardBtn.disabled = !state.selected || !n;
    }

    function discardEdits() {
      if (!state.selected) return;
      state.draft = structuredClone(state.original);
      state.invalid.clear();
      setStatus('');
      renderEditor();
      updateSummary();
    }

    // ----- dialogs -----
    function openDialog({ title, body: content, actions }) {
      return new Promise((resolve) => {
        const close = (value) => {
          overlay.hidden = true;
          overlay.replaceChildren();
          resolve(value);
        };
        const buttons = actions.map((a) => h('button', {
          class: `btn${a.primary ? ' solid' : ''}${a.danger ? ' danger' : ''}`,
          type: 'button',
          onclick: () => close(a.value),
        }, a.label));
        const box = h('div', {
          class: 'fd-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
          onkeydown: (e) => { if (e.key === 'Escape') close(null); },
        }, h('h3', { text: title }), content, h('div', { class: 'fd-actions' }, buttons));
        overlay.replaceChildren(box);
        overlay.hidden = false;
        const focus = actions.findIndex((a) => a.primary);
        (buttons[focus >= 0 ? focus : 0]).focus();
      });
    }

    async function confirmDiscard() {
      if (!state.selected || !currentChanges().length) return true;
      const count = currentChanges().length;
      const answer = await openDialog({
        title: t('Discard unsaved changes?'),
        body: h('p', { text: t('{count} fields changed', { count }) }),
        actions: [
          { label: t('Keep editing'), value: false, primary: true },
          { label: t('Discard'), value: true, danger: true },
        ],
      });
      return answer === true;
    }

    async function requestSave() {
      if (!state.selected || state.invalid.size) return;
      const changes = currentChanges();
      if (!changes.length) {
        setStatus(t('Nothing to save.'), '');
        return;
      }
      const c = summarize(changes);
      const before = payloadBytes(basePayload());
      const after = payloadBytes(buildPayload());
      const delta = after - before;
      const shown = changes.slice(0, LIST_LIMIT).map((ch) => h('div', { class: ch.type },
        `${ch.type === 'added' ? '+' : ch.type === 'removed' ? '−' : '~'} ${pathLabel(ch.path)}: ${shortValue(ch.before)} → ${shortValue(ch.after)}`));
      if (changes.length > LIST_LIMIT) {
        shown.push(h('div', { class: 'fd-muted', text: t('and {count} more', { count: changes.length - LIST_LIMIT }) }));
      }
      const answer = await openDialog({
        title: t('Are you sure?'),
        body: h('div', { class: 'fd-confirm' },
          h('p', { text: t('Are you sure you want to save these changes?') }),
          h('p', {
            text: t('{count} fields changed: {changed} changed, {added} added, {removed} removed.', {
              count: c.total, changed: c.changed, added: c.added, removed: c.removed,
            }),
          }),
          h('p', { class: 'fd-muted', text: `${t('Size: {before} → {after}', { before: formatBytes(before), after: formatBytes(after) })} (${delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(delta))})` }),
          h('div', { class: 'fd-diff' }, shown)),
        actions: [
          { label: t('Cancel'), value: false },
          { label: t('Save changes'), value: true, primary: true },
        ],
      });
      if (answer === true) await performSave(changes);
    }

    async function performSave() {
      const sel = state.selected;
      const payload = buildPayload();
      const reply = await api.dbSave({ key: sel.key, kind: sel.kind, expectedHash: state.expectedHash, ...payload });
      if (reply.conflict) {
        const reload = await openDialog({
          title: t('Database'),
          body: h('p', { text: t('This entry changed after you opened it, so nothing was saved.') }),
          actions: [
            { label: t('Keep editing'), value: false, primary: true },
            { label: t('Reload and discard my edits'), value: true, danger: true },
          ],
        });
        if (reload === true) await openEntry({ key: sel.key, kind: sel.kind }, true);
        return;
      }
      if (!reply.ok) {
        setStatus(reply.error, 'bad');
        return;
      }
      if (sel.kind === 'list') state.rawItems = payload.items;
      else state.rawOriginal = payload.raw;
      state.expectedHash = reply.hash;
      state.original = structuredClone(state.draft);
      afterChange();
      setStatus(t('Saved.'), 'ok');
      await loadList(false);
      const q = state.query.trim();
      if (q.length >= SEARCH_MIN) runSearch(q);
    }

    // Escape closes an open entry. Focus can fall back to the page when the list redraws, so this also
    // listens on the document, but only while nothing else has focus. It stops once the window is gone.
    const onDocumentKey = (event) => {
      if (!root.isConnected) { document.removeEventListener('keydown', onDocumentKey); return; }
      if (event.key !== 'Escape' || !state.selected) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      closeEntry();
    };
    document.addEventListener('keydown', onDocumentKey);

    // ----- start -----
    entrySort.value = state.entrySort;
    render();
    loadList(true);
  };
})();
