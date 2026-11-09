// Glass, searchable dropdowns for the desktop's Settings and injected Control Centre pages.
// The native select keeps the form value and events; the custom menu provides fast search.
(() => {
  'use strict';

  let open = null; // { select }

  function optionSignature(select) {
    return Array.from(select.options)
      .map((option) => `${option.value}\u0002${option.textContent}\u0002${option.disabled}`)
      .join('\u0003');
  }

  function signature(select) {
    return `${select.disabled}\u0001${select.selectedIndex}\u0001${optionSignature(select)}`;
  }

  function filterOptions(select, query) {
    const dd = select._dd;
    if (!dd) return;
    const normalized = String(query || '').trim().toLocaleLowerCase();
    let matches = 0;
    // Search cached text rather than reading option labels or rebuilding the menu per keystroke.
    for (const item of dd.options.querySelectorAll('.dd-item')) {
      const visible = !normalized || item.dataset.searchText.includes(normalized);
      item.hidden = !visible;
      if (visible) matches += 1;
    }
    dd.empty.hidden = matches > 0;
    dd.empty.textContent = normalized ? `No matches for “${String(query).trim()}”` : 'No options available';
  }

  function refresh(select) {
    const dd = select._dd;
    if (!dd) return;
    const nextOptionsSignature = optionSignature(select);
    const nextSignature = `${select.disabled}\u0001${select.selectedIndex}\u0001${nextOptionsSignature}`;
    dd._sig = nextSignature;

    const current = select.options[select.selectedIndex];
    dd.button.textContent = current ? current.textContent : '';
    dd.button.disabled = select.disabled;

    // Selection/value changes only update the selected state. Rebuild option nodes only when the
    // actual option list changes (important for large fish/inventory lists).
    if (dd._optionsSig !== nextOptionsSignature) {
      dd._optionsSig = nextOptionsSignature;
      dd.options.replaceChildren(...Array.from(select.options).map((option, optionIndex) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dd-item';
        item.setAttribute('role', 'option');
        item.dataset.value = option.value;
        item.dataset.optionIndex = String(optionIndex);
        item.dataset.searchText = `${option.textContent} ${option.value}`.toLocaleLowerCase();
        item.disabled = Boolean(option.disabled);
        item.setAttribute('aria-disabled', String(item.disabled));
        item.textContent = option.textContent;
        item.addEventListener('click', () => choose(select, option.value));
        item.addEventListener('keydown', (event) => onItemKey(event, select));
        return item;
      }));
    }

    for (const item of dd.options.querySelectorAll('.dd-item')) {
      item.setAttribute('aria-selected', String(Number(item.dataset.optionIndex) === select.selectedIndex));
    }
    filterOptions(select, dd.search.value);
  }

  function choose(select, value) {
    const match = Array.from(select.options).find((option) => option.value === value);
    if (!match || match.disabled || select.disabled) return;
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close();
    refresh(select);
    select._dd.button.focus();
  }

  function place(list, button) {
    const r = button.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    list.style.maxHeight = `${Math.min(320, Math.max(120, (below > 200 ? below : r.top) - 12))}px`;
    if (below > 200) {
      list.style.top = `${r.bottom + 4}px`;
      list.style.bottom = '';
    } else {
      list.style.top = '';
      list.style.bottom = `${window.innerHeight - r.top + 4}px`;
    }
  }

  function visibleItems(select) {
    return Array.from(select._dd.options.querySelectorAll('.dd-item:not([hidden]):not(:disabled)'));
  }

  function openFor(select) {
    close();
    const dd = select._dd;
    refresh(select);
    dd.search.value = '';
    filterOptions(select, '');
    place(dd.list, dd.button);
    dd.list.hidden = false;
    dd.button.setAttribute('aria-expanded', 'true');
    open = { select };
    dd.search.focus();
  }

  function close() {
    if (!open) return;
    const dd = open.select._dd;
    dd.list.hidden = true;
    dd.button.setAttribute('aria-expanded', 'false');
    open = null;
  }

  function onItemKey(event, select) {
    const items = visibleItems(select);
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) {
        select._dd.search.focus();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = index < 0 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
      items[nextIndex].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      select._dd.button.focus();
    }
  }

  function onSearchKey(event, select) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      select._dd.button.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const items = visibleItems(select);
      if (items.length) {
        event.preventDefault();
        items[event.key === 'ArrowDown' ? 0 : items.length - 1].focus();
      }
    } else if (event.key === 'Enter') {
      const first = visibleItems(select)[0];
      if (first) {
        event.preventDefault();
        choose(select, first.dataset.value);
      }
    } else if (event.key === 'Tab') {
      close(); // Let normal tab navigation continue.
    }
  }

  function enhance(select) {
    if (select._dd) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dd-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');

    const list = document.createElement('div');
    list.className = 'dd-list';
    list.hidden = true;

    const searchHeader = document.createElement('div');
    searchHeader.className = 'dd-search-header';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'dd-search';
    search.placeholder = 'Search fish, items, or options…';
    search.setAttribute('aria-label', 'Search fish, items, or options');
    search.autocomplete = 'off';
    search.spellcheck = false;
    searchHeader.append(search);

    const options = document.createElement('div');
    options.className = 'dd-options';
    options.setAttribute('role', 'listbox');
    const empty = document.createElement('div');
    empty.className = 'dd-empty';
    empty.hidden = true;
    empty.textContent = 'No options available';
    list.append(searchHeader, options, empty);
    document.body.append(list);

    select.before(button);
    select.hidden = true;
    select._dd = { button, list, search, options, empty, _sig: '', _optionsSig: null };

    button.addEventListener('click', () => (open && open.select === select ? close() : openFor(select)));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openFor(select);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openFor(select);
      }
    });
    search.addEventListener('input', () => filterOptions(select, search.value));
    search.addEventListener('keydown', (event) => onSearchKey(event, select));
    refresh(select);
  }

  function enhanceAll(root) {
    root.querySelectorAll('select').forEach(enhance);
  }

  function refreshAll(root) {
    root.querySelectorAll('select').forEach((select) => {
      if (select._dd && select._dd._sig !== signature(select)) refresh(select);
    });
  }

  document.addEventListener('pointerdown', (event) => {
    if (!open) return;
    if (event.target.closest('.dd-list') || open.select._dd.button.contains(event.target)) return;
    close();
  });
  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape' && event.target !== open.select._dd.search) {
      const select = open.select;
      close();
      select._dd.button.focus();
    }
  });
  window.addEventListener('resize', close);
  document.addEventListener('change', (event) => {
    if (event.target && event.target._dd) refresh(event.target);
  }, true);

  // Observe only new subtrees and selects whose own options/value changed; don't rescan the page.
  const pendingAdded = new Set();
  const pendingSelects = new Set();
  let flushQueued = false;
  function queueFlush() {
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(() => {
      flushQueued = false;
      for (const node of pendingAdded) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches('select')) enhance(node);
        node.querySelectorAll?.('select').forEach(enhance);
      }
      for (const select of pendingSelects) {
        if (select.isConnected && select._dd && select._dd._sig !== signature(select)) refresh(select);
      }
      pendingAdded.clear();
      pendingSelects.clear();
    });
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) pendingAdded.add(node);
        const parentSelect = record.target.closest?.('select');
        if (parentSelect) pendingSelects.add(parentSelect);
      } else if (record.type === 'attributes' || record.type === 'characterData') {
        const select = record.target.closest?.('select') || record.target.parentElement?.closest?.('select');
        if (select) pendingSelects.add(select);
      }
    }
    if (pendingAdded.size || pendingSelects.size) queueFlush();
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['disabled', 'selected', 'value'], characterData: true
  });

  window.FishingbotDropdowns = Object.freeze({ enhanceAll, refreshAll });
})();
