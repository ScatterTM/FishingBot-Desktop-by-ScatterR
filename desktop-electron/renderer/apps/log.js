// Live log app. Reads the shared log store that desktop.js keeps up to date.
(() => {
  'use strict';

  const MAX_LINES = 500;

  function lineNode(entry) {
    const node = document.createElement('div');
    node.className = 'line ' + entry.level;
    const time = new Date(entry.ts).toTimeString().slice(0, 8);
    node.textContent = `${time}  ${entry.source.padEnd(7)} ${entry.text}`;
    return node;
  }

  window.FishingbotApps = window.FishingbotApps || {};
  // store: { lines: array, subscribe(fn) -> unsubscribe, api }
  window.FishingbotApps.log = function mountLog(body, store) {
    body.append(document.getElementById('tpl-log').content.cloneNode(true));
    const q = (sel) => body.querySelector(sel);
    const list = q('[data-role="list"]');
    const filter = q('[data-role="filter"]');
    const auto = q('[data-role="autoscroll"]');
    const count = q('[data-role="count"]');
    let since = 0; // "Clear" hides older lines in this window only

    const passes = (entry) => {
      const mode = filter.value;
      if (mode === 'all') return true;
      if (mode === 'error') return entry.level === 'error';
      return entry.level === 'warn' || entry.level === 'error';
    };

    function draw() {
      const visible = store.lines.slice(since).filter(passes).slice(-MAX_LINES);
      list.replaceChildren(...visible.map(lineNode));
      count.textContent = `${visible.length} of ${store.lines.length - since} lines`;
      if (auto.checked) list.scrollTop = list.scrollHeight;
    }

    filter.addEventListener('change', draw);
    auto.addEventListener('change', draw);
    q('[data-role="clear"]').addEventListener('click', () => {
      since = store.lines.length;
      draw();
    });

    const unsubscribe = store.subscribe(draw);
    body._cleanup = unsubscribe;
    store.api.getSettings().then((view) => {
      auto.checked = view.interface.autoScrollLog;
      draw();
    });
    draw();
  };
})();
