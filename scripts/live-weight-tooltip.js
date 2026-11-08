(function installLiveFishWeightTooltips(){
  if (window.__liveFishWeightTooltipsInstalled) return;
  window.__liveFishWeightTooltipsInstalled = true;

  const style = document.createElement('style');
  style.textContent = `
    .fish-weight-tooltip {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      min-width: 190px;
      max-width: 260px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 0;
      background: rgba(14,16,22,.96);
      color: #fff;
      box-shadow: 0 12px 35px rgba(0,0,0,.35);
      font: 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      backdrop-filter: blur(8px);
    }
    .fish-weight-tooltip .fwt-name { font-weight: 700; margin-bottom: 5px; }
    .fish-weight-tooltip .fwt-row { display:flex; justify-content:space-between; gap:16px; }
    .fish-weight-tooltip .fwt-label { opacity:.68; }
    .fish-weight-tooltip .fwt-value { font-variant-numeric: tabular-nums; font-weight:600; }
  `;
  document.head.appendChild(style);

  const tooltip = document.createElement('div');
  tooltip.className = 'fish-weight-tooltip';
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  let fishMap = new Map();

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function render(data) {
    fishMap = new Map();
    for (const tier of data || []) {
      for (const row of tier.items || []) {
        const key = String(row.item).trim();
        fishMap.set(key, { ...row, tier: tier.name, tierId: tier.id });
      }
    }
  }

  function findFishElement(start) {
    let el = start instanceof Element ? start : start?.parentElement;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      const text = (el.textContent || '').trim();
      if (text && fishMap.has(text)) return el;
    }
    return null;
  }

  function position(event) {
    const gap = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = event.clientX + gap;
    let top = event.clientY + gap;
    if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - gap;
    if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - gap;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function show(event, row, el) {
    const live = Number(row.liveWeight) || 0;
    const base = Number(row.baseWeight) || 0;
    const chance = Number(row.categoryChance) || 0;
    // Fortune's uncaught boost shows as a separate line only when it changes this fish.
    const fortuneLine = base > 0 && Math.abs(live - base) > 1e-9
      ? `<div class="fwt-row"><span class="fwt-label">Fisherman's Fortune</span><span class="fwt-value">${(live / base).toFixed(2)}x</span></div>`
      : '';
    // Chance per cast for this viewer, when the page can compute it (tier odds at the current luck).
    const perCast = typeof window.__fishChancePerCast === 'function' ? window.__fishChancePerCast(row.tierId, chance) : null;
    const perCastLine = perCast == null
      ? ''
      : `<div class="fwt-row"><span class="fwt-label">Chance per Cast</span><span class="fwt-value">${Number(perCast).toFixed(3)}%</span></div>`;
    tooltip.innerHTML = `
      <div class="fwt-name">${esc(row.item)}</div>
      <div class="fwt-row"><span class="fwt-label">Category</span><span class="fwt-value">${esc(row.tier)}</span></div>
      <div class="fwt-row"><span class="fwt-label">Base Weight</span><span class="fwt-value">${base.toLocaleString()}</span></div>
      <div class="fwt-row"><span class="fwt-label">Live Weight</span><span class="fwt-value">${live.toLocaleString()}</span></div>
      ${fortuneLine}
      <div class="fwt-row"><span class="fwt-label">Within Category</span><span class="fwt-value">${(chance * 100).toFixed(2)}%</span></div>
      ${perCastLine}`;
    tooltip.hidden = false;
    position(event);
    el.dataset.liveWeightFish = '1';
  }

  let currentElement = null;
  document.addEventListener('mousemove', (event) => {
    if (!fishMap.size) return;
    const el = findFishElement(event.target);
    if (el !== currentElement) {
      currentElement = el;
      if (!el) {
        tooltip.hidden = true;
        return;
      }
      const row = fishMap.get((el.textContent || '').trim());
      if (row) show(event, row, el);
    } else if (el && !tooltip.hidden) {
      position(event);
    }
  }, { passive: true });

  document.addEventListener('mouseleave', () => { tooltip.hidden = true; }, true);
  window.addEventListener('resize', () => { if (currentElement) tooltip.hidden = true; });

  render(window.__FISH_LIVE_WEIGHTS__ || []);

  // The page swaps in a viewer's own weights (Fortune) after login. Hover reads the new table at once.
  window.setLiveFishWeights = (data) => { render(data || []); currentElement = null; };
})();
