// Glass dropdowns for the desktop's Settings. The native list of a <select> is drawn by Windows and
// cannot be see-through, so each select keeps its value (and its name, for the forms) and is shown
// through a glass button and list. The list is attached to the page body so no window clips it.
(() => {
  'use strict';

  let open = null; // { select, list, button }

  // What the button and list show. When this changes, the glass parts are rebuilt.
  function signature(select) {
    return `${select.disabled}\u0001${select.selectedIndex}\u0001` +
      Array.from(select.options).map((o) => `${o.value}\u0002${o.textContent}`).join('\u0003');
  }

  function refresh(select) {
    const dd = select._dd;
    if (!dd) return;
    dd._sig = signature(select);
    const current = select.options[select.selectedIndex];
    dd.button.textContent = current ? current.textContent : '';
    dd.button.disabled = select.disabled;
    dd.list.replaceChildren(...Array.from(select.options).map((option) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dd-item';
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;
      item.setAttribute('aria-selected', String(option.selected));
      item.textContent = option.textContent;
      item.addEventListener('click', () => choose(select, option.value));
      item.addEventListener('keydown', (event) => onItemKey(event, select));
      return item;
    }));
  }

  function choose(select, value) {
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
    list.style.maxHeight = `${Math.min(280, Math.max(120, (below > 200 ? below : r.top) - 12))}px`;
    if (below > 200) {
      list.style.top = `${r.bottom + 4}px`;
      list.style.bottom = '';
    } else {
      list.style.top = '';
      list.style.bottom = `${window.innerHeight - r.top + 4}px`;
    }
  }

  function openFor(select) {
    close();
    refresh(select);
    const dd = select._dd;
    place(dd.list, dd.button);
    dd.list.hidden = false;
    dd.button.setAttribute('aria-expanded', 'true');
    open = { select };
    const selected = dd.list.querySelector('[aria-selected="true"]') || dd.list.firstElementChild;
    if (selected) selected.focus();
  }

  function close() {
    if (!open) return;
    const dd = open.select._dd;
    dd.list.hidden = true;
    dd.button.setAttribute('aria-expanded', 'false');
    open = null;
  }

  function onItemKey(event, select) {
    const items = Array.from(select._dd.list.querySelectorAll('.dd-item'));
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      close();
      select._dd.button.focus();
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
    document.body.append(list);
    select.before(button);
    select.hidden = true;
    select._dd = { button, list };
    button.addEventListener('click', () => (open && open.select === select ? close() : openFor(select)));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openFor(select);
      }
    });
    refresh(select);
  }

  // Enhances every select under root, and refreshes the enhanced ones whose options or value changed in
  // code (a page that fills a list later, such as the Viewers fish list, set the options without a change event).
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
    if (open && event.key === 'Escape') {
      const select = open.select;
      close();
      select._dd.button.focus();
    }
  });
  window.addEventListener('resize', close);
  // A value changed by the page (not by a click here) shows in the button at once.
  document.addEventListener('change', (event) => {
    if (event.target && event.target._dd) refresh(event.target);
  }, true);
  // Pages that build their selects later (the Control Centre) get them enhanced as they appear.
  // The refresh only rebuilds the glass parts when the signature changed, so the observer's own changes stop here.
  new MutationObserver(() => { enhanceAll(document); refreshAll(document); })
    .observe(document.documentElement, { childList: true, subtree: true });

  window.FishingbotDropdowns = Object.freeze({ enhanceAll, refreshAll });
})();
