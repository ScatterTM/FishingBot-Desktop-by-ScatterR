/* Control Centre loot editor.
 *
 * Owns the Loot table tab: rarity odds, every fish with its weight and perk,
 * the Add / Edit fish dialog, and the area loot tables. Edits are staged in a
 * draft and written only when the user presses Save, which restarts the local
 * server. The draft survives language changes and metric refreshes, so a
 * re-render never throws away unsaved work.
 *
 * Loaded by local/manager.js before its inline script. Exposes one global:
 *   window.FishingbotLoot.mount({ settings, call, notice, setView, esc })
 */
(function () {
  'use strict';

  const NORMAL_IDS = ['godly', 'legendary', 'epic', 'rare', 'uncommon', 'common'];
  const EFFECT_IDS = ['luck', 'weight', 'treasuryLuck', 'cooldownReduction', 'timeout'];
  const MULTIPLIER_EFFECTS = ['luck', 'weight', 'treasuryLuck'];
  const RARITY_COLORS = {
    unique: '#dd705f', godly: '#e4572e', legendary: '#c9a227', epic: '#a77bd1',
    rare: '#5b9bd5', uncommon: '#46a07b', common: '#8f8a80', treasury: '#d6aa4b'
  };
  const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'’!?()_-]{0,59}$/u;
  const DEFAULT_WEIGHT = 100;

  let ctx = null;
  let base = '';
  let draft = null;
  const ui = {
    tab: 'fish',
    query: '',
    rarity: 'all',
    collapsed: new Set(),
    area: null,
    editor: null
  };

  // ---------- helpers ----------

  function tr(key, vars) {
    const i18n = window.FishingbotI18n;
    let text = i18n && typeof i18n.t === 'function' ? i18n.t(key) : key;
    if (!text) text = key;
    if (vars) text = String(text).replace(/\{(\w+)\}/g, (match, name) => (vars[name] !== undefined ? String(vars[name]) : match));
    return text;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function normalize(value) {
    return String(value ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2018\u2019\u0060\u00b4]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('en-US');
  }

  function coreName(value) {
    return normalize(String(value ?? '').replace(/\s*\([^)]*\)\s*$/, ''));
  }

  function levenshtein(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      let rowMin = current[0];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        rowMin = Math.min(rowMin, current[j]);
      }
      if (rowMin > limit) return limit + 1;
      previous = current;
    }
    return previous[b.length];
  }

  function rarityLabel(tier) {
    const key = 'rarity.' + tier.id;
    const text = tr(key);
    return text === key ? tier.name : text;
  }

  function tierById(id) {
    return draft.tiers.find((t) => t.id === id) || null;
  }

  function allFishNames() {
    return draft.tiers.flatMap((t) => t.items.map((i) => ({ name: i.name, tier: t })));
  }

  function findFish(name) {
    const wanted = normalize(name);
    for (const tier of draft.tiers) {
      const item = tier.items.find((i) => normalize(i.name) === wanted);
      if (item) return { item, tier };
    }
    return null;
  }

  function similarTo(name, exceptName) {
    const wantedCore = coreName(name);
    const wanted = normalize(name);
    if (!wanted) return [];
    const except = exceptName ? normalize(exceptName) : null;
    const out = [];
    for (const { name: other, tier } of allFishNames()) {
      if (except && normalize(other) === except) continue;
      const core = coreName(other);
      const limit = Math.max(2, Math.floor(Math.max(wantedCore.length, core.length) * 0.25));
      const substring = wantedCore.length >= 4 && core.length >= 4 && (core.includes(wantedCore) || wantedCore.includes(core));
      const distance = Math.min(levenshtein(wantedCore, core, limit), levenshtein(wanted, normalize(other), limit));
      if (substring || distance <= limit) out.push({ name: other, tier });
      if (out.length >= 4) break;
    }
    return out;
  }

  // ---------- draft ----------

  function snapshot(settings) {
    const weights = settings.weights || {};
    const tiers = (settings.tiers || []).map((t) => ({
      id: t.id,
      name: t.name,
      chance: num(t.chance, 0),
      items: (t.items || []).map((name) => ({ name: String(name), weight: num(weights[t.id]?.[name], DEFAULT_WEIGHT) }))
    }));
    const areas = {};
    for (const [id, area] of Object.entries(settings.areaLoot || {})) {
      areas[id] = {
        name: area.name,
        loot: (area.loot || []).map((row) => ({ name: String(row.name), tier: String(row.tier), weight: num(row.weight, DEFAULT_WEIGHT), boost: num(row.boost, 0) }))
      };
    }
    return { tiers, abilities: JSON.parse(JSON.stringify(settings.abilities || {})), areas };
  }

  function syncFrom(settings) {
    const next = snapshot(settings);
    const json = stable(next);
    if (!draft) {
      draft = JSON.parse(json);
    } else if (json !== base && changeCount() === 0) {
      // The server changed and there are no local edits: take the new state.
      draft = JSON.parse(json);
    }
    base = json;
  }

  function changeCount() {
    if (!draft || !base) return 0;
    const saved = JSON.parse(base);
    let changes = 0;

    const savedFish = new Map();
    for (const tier of saved.tiers) for (const item of tier.items) savedFish.set(normalize(item.name), { tier: tier.id, weight: item.weight, name: item.name });
    const draftFish = new Map();
    for (const tier of draft.tiers) for (const item of tier.items) draftFish.set(normalize(item.name), { tier: tier.id, weight: item.weight, name: item.name });
    for (const [key, value] of draftFish) {
      const old = savedFish.get(key);
      if (!old || old.tier !== value.tier || old.weight !== value.weight || old.name !== value.name) changes++;
    }
    for (const key of savedFish.keys()) if (!draftFish.has(key)) changes++;

    const keys = new Set([...Object.keys(saved.abilities), ...Object.keys(draft.abilities)]);
    for (const key of keys) if (stable(saved.abilities[key] ?? null) !== stable(draft.abilities[key] ?? null)) changes++;

    saved.tiers.forEach((tier, i) => {
      if (draft.tiers[i] && num(tier.chance, 0) !== num(draft.tiers[i].chance, 0)) changes++;
    });

    for (const id of Object.keys(saved.areas)) {
      if (stable(saved.areas[id]?.loot ?? []) !== stable(draft.areas[id]?.loot ?? [])) changes++;
    }
    return changes;
  }

  function computeIssues() {
    const blocking = [];
    const warnings = [];
    const normalTotal = draft.tiers.filter((t) => NORMAL_IDS.includes(t.id)).reduce((n, t) => n + num(t.chance, 0), 0);
    if (Math.abs(normalTotal - 100) > 0.005) blocking.push(tr('loot.issue.normal', { total: normalTotal.toFixed(2) }));
    for (const tier of draft.tiers) {
      if (!tier.items.length) blocking.push(tr('loot.issue.empty', { rarity: rarityLabel(tier) }));
      else if (!tier.items.some((i) => num(i.weight, 0) > 0)) blocking.push(tr('loot.issue.noweight', { rarity: rarityLabel(tier) }));
      const zero = tier.items.filter((i) => num(i.weight, 0) === 0).length;
      if (zero) warnings.push(tr('loot.issue.zeroWeight', { count: zero, rarity: rarityLabel(tier) }));
    }
    const seen = new Map();
    for (const { name } of allFishNames()) {
      const key = normalize(name);
      if (seen.has(key)) blocking.push(tr('loot.issue.lookalike', { a: seen.get(key), b: name }));
      else seen.set(key, name);
    }
    for (const [id, area] of Object.entries(draft.areas)) {
      if (!area.loot.length || !area.loot.some((r) => num(r.weight, 0) > 0)) blocking.push(tr('loot.issue.areaEmpty', { area: area.name || id }));
    }
    return { blocking, warnings, normalTotal };
  }

  function buildPayload() {
    const weights = {};
    for (const tier of draft.tiers) {
      for (const item of tier.items) {
        if (!weights[tier.id]) weights[tier.id] = {};
        weights[tier.id][item.name] = num(item.weight, DEFAULT_WEIGHT);
      }
    }
    const areas = {};
    for (const [id, area] of Object.entries(draft.areas)) {
      areas[id] = { loot: area.loot.map((r) => ({ name: r.name, tier: r.tier, weight: num(r.weight, 0), boost: num(r.boost, 0) })) };
    }
    return {
      tiers: draft.tiers.map((t) => ({ id: t.id, items: t.items.map((i) => i.name), chance: num(t.chance, 0) })),
      weights,
      abilities: draft.abilities,
      areas
    };
  }

  // ---------- rendering ----------

  function shareText(weight, total) {
    if (!total) return '—';
    return ((num(weight, 0) / total) * 100).toFixed(1) + '%';
  }

  function shareFill(weight, total) {
    return total > 0 ? Math.min(100, Math.max(0, num(weight, 0)) / total * 100) : 0;
  }

  function totalWeight(tier) {
    return tier.items.reduce((n, i) => n + Math.max(0, num(i.weight, 0)), 0);
  }

  function colorOf(tierId) {
    return RARITY_COLORS[tierId] || '#8f8a80';
  }

  function tierByName(name) {
    return draft.tiers.find((t) => t.name === name) || null;
  }

  // A share cell: a thin bar and the percentage. paintShare keeps both in step with the weights.
  function shareCell(weight, total, attrs) {
    return '<span class="loot-share"' + (attrs ? ' ' + attrs : '') + '>'
      + '<span class="loot-share-bar" aria-hidden="true"><span data-share-fill style="width:' + shareFill(weight, total).toFixed(2) + '%"></span></span>'
      + '<span class="loot-share-text" data-share-text>' + esc(shareText(weight, total)) + '</span></span>';
  }

  function paintShare(el, weight, total) {
    const fill = el.querySelector('[data-share-fill]');
    if (fill) fill.style.width = shareFill(weight, total).toFixed(2) + '%';
    const text = el.querySelector('[data-share-text]');
    if (text) text.textContent = shareText(weight, total);
  }

  function topHtml() {
    const issues = computeIssues();
    const changes = changeCount();
    const status = changes
      ? '<span class="loot-status is-dirty"><i class="loot-dot"></i>' + esc(tr('loot.status.dirty', { count: changes })) + '</span>'
      : '<span class="loot-status"><i class="loot-dot"></i>' + esc(tr('loot.status.clean')) + '</span>';
    const fishCount = draft.tiers.reduce((n, t) => n + t.items.length, 0);
    const perks = Object.keys(draft.abilities).length;
    const normalOk = Math.abs(issues.normalTotal - 100) <= 0.005;
    const treasury = draft.tiers.find((t) => t.id === 'treasury');
    const messages = issues.blocking.map((m) => '<li class="is-blocking">' + esc(m) + '</li>')
      .concat(issues.warnings.map((m) => '<li>' + esc(m) + '</li>'));
    return '<section class="card loot-head">'
      + '<div class="loot-head-main">'
      + '<div class="loot-head-text"><h2>' + esc(tr('loot.title')) + '</h2><p class="small">' + esc(tr('loot.lede')) + '</p></div>'
      + '<div class="loot-head-actions">' + status
      + (changes ? '<button class="btn secondary" type="button" data-act="discard">' + esc(tr('loot.discard')) + '</button>' : '')
      + '<button class="btn primary" type="button" data-act="save"' + (changes && !issues.blocking.length ? '' : ' disabled') + '>' + esc(tr('loot.save')) + '</button></div>'
      + '</div>'
      + '<div class="loot-stats">'
      + '<div><span>' + esc(tr('loot.stat.fish')) + '</span><strong>' + fishCount + '</strong></div>'
      + '<div><span>' + esc(tr('loot.stat.perks')) + '</span><strong>' + perks + '</strong></div>'
      + '<div class="' + (normalOk ? '' : 'is-bad') + '"><span>' + esc(tr('loot.stat.normal')) + '</span><strong>' + issues.normalTotal.toFixed(2) + '%</strong></div>'
      + '<div><span>' + esc(tr('loot.stat.treasury')) + '</span><strong>' + num(treasury?.chance, 0).toFixed(2) + '%</strong></div>'
      + '<div class="' + (issues.blocking.length ? 'is-bad' : '') + '"><span>' + esc(tr('loot.stat.issues')) + '</span><strong>' + issues.blocking.length + '</strong></div>'
      + '</div>'
      + (messages.length
        ? '<ul class="loot-issues">' + messages.join('') + '</ul>'
        : '<p class="loot-ok small"><i class="loot-dot"></i>' + esc(tr('loot.issues.none')) + '</p>')
      + '</section>';
  }

  function tabsHtml() {
    const button = (id, label) => '<button type="button" class="loot-seg-btn" data-act="tab" data-tab="' + id + '" aria-pressed="' + (ui.tab === id) + '">' + esc(label) + '</button>';
    return '<div class="loot-seg" role="group" aria-label="' + esc(tr('loot.title')) + '">' + button('fish', tr('loot.tab.fish')) + button('areas', tr('loot.tab.areas')) + '</div>';
  }

  function oddTile(tier, treasury) {
    const label = rarityLabel(tier);
    const max = treasury ? 25 : 100;
    return '<label class="loot-odd' + (treasury ? ' is-treasury' : '') + '" style="--rc:' + colorOf(tier.id) + '">'
      + '<span class="loot-odd-name"><i class="loot-dot"></i>' + esc(label) + '</span>'
      + '<span class="loot-odd-input"><input type="number" data-no-slider min="0" max="' + max + '" step="0.01" value="' + num(tier.chance, 0).toFixed(2) + '" data-odd="' + tier.id + '" aria-label="' + esc(label) + ' %"><span>%</span></span>'
      + '</label>';
  }

  function oddsHtml() {
    const normal = draft.tiers.filter((t) => NORMAL_IDS.includes(t.id));
    const treasury = draft.tiers.find((t) => t.id === 'treasury');
    const total = normal.reduce((n, t) => n + num(t.chance, 0), 0);
    const bar = normal.map((t) => '<span class="loot-bar-seg" data-bar="' + t.id + '" style="width:' + Math.max(0, num(t.chance, 0)).toFixed(2) + '%;background:' + colorOf(t.id) + '"></span>').join('');
    return '<section class="card loot-odds-card">'
      + '<div class="loot-section-head"><div><h2>' + esc(tr('loot.odds.title')) + '</h2><p class="small">' + esc(tr('loot.odds.hint')) + '</p></div>'
      + '<span class="loot-total' + (Math.abs(total - 100) > 0.005 ? ' is-bad' : '') + '">' + esc(tr('loot.odds.total')) + ' <strong data-normal-total>' + total.toFixed(2) + '</strong>%</span></div>'
      + '<div class="loot-bar" aria-hidden="true">' + bar + '</div>'
      + '<div class="loot-odds">' + normal.map((t) => oddTile(t, false)).join('') + (treasury ? oddTile(treasury, true) : '') + '</div>'
      + '</section>';
  }

  function rowHtml(tier, item) {
    const perk = draft.abilities[item.name];
    const total = totalWeight(tier);
    const label = tr('loot.row.weightLabel', { name: item.name });
    const attrs = 'data-tier="' + esc(tier.id) + '" data-name="' + esc(item.name) + '"';
    return '<div class="loot-row" data-row data-tier="' + esc(tier.id) + '" data-name="' + esc(item.name) + '">'
      + '<div class="loot-name"><button type="button" class="loot-name-btn" data-act="edit" ' + attrs + ' title="' + esc(tr('loot.row.edit')) + '">' + esc(item.name) + '</button>'
      + (perk ? '<span class="loot-perk" title="' + esc(perk.perkName || '') + '">' + esc(tr('loot.row.perk')) + '</span>' : '') + '</div>'
      + '<label class="loot-weight"><span class="sr-only">' + esc(label) + '</span>'
      + '<input type="number" data-no-slider min="0" max="10000" step="1" value="' + num(item.weight, DEFAULT_WEIGHT) + '" data-weight ' + attrs + ' aria-label="' + esc(label) + '"></label>'
      + shareCell(item.weight, total, 'data-share data-tier="' + esc(tier.id) + '"')
      + '<div class="loot-row-actions">'
      + '<button type="button" class="btn secondary" data-act="edit" ' + attrs + '>' + esc(tr('loot.row.edit')) + '</button>'
      + '<button type="button" class="btn danger" data-act="remove" ' + attrs + '>' + esc(tr('loot.row.remove')) + '</button>'
      + '</div></div>';
  }

  function toolsHtml() {
    const fishCount = draft.tiers.reduce((n, t) => n + t.items.length, 0);
    const chip = (id, label, count, colored) => '<button type="button" class="loot-chip" data-act="rarity-pick" data-rarity="' + esc(id) + '" aria-pressed="' + (ui.rarity === id) + '"'
      + (colored ? ' style="--rc:' + colorOf(id) + '"' : '') + '>'
      + (colored ? '<i class="loot-dot"></i>' : '') + '<span>' + esc(label) + '</span><span class="loot-chip-count">' + count + '</span></button>';
    const chips = chip('all', tr('loot.filter.all'), fishCount, false)
      + draft.tiers.map((t) => chip(t.id, rarityLabel(t), t.items.length, true)).join('');
    return '<section class="loot-tools" id="loot-tools">'
      + '<div class="loot-tools-top">'
      + '<div class="loot-search"><label for="loot-search">' + esc(tr('loot.search')) + '</label><input id="loot-search" type="search" value="' + esc(ui.query) + '" placeholder="' + esc(tr('loot.searchPlaceholder')) + '"></div>'
      + '<div class="loot-tools-actions"><button type="button" class="btn primary" data-act="add">' + esc(tr('loot.addFish')) + '</button>'
      + '<button type="button" class="btn secondary" data-act="expand">' + esc(tr('loot.expandAll')) + '</button>'
      + '<button type="button" class="btn secondary" data-act="collapse">' + esc(tr('loot.collapseAll')) + '</button></div>'
      + '</div>'
      + '<div class="loot-chips" role="group" aria-label="' + esc(tr('loot.modal.rarity')) + '">' + chips + '</div>'
      + '</section>';
  }

  function refreshTools() {
    const box = document.getElementById('loot-tools');
    if (box) box.outerHTML = toolsHtml();
  }

  function groupsHtml() {
    const query = normalize(ui.query);
    const groups = draft.tiers.filter((tier) => ui.rarity === 'all' || ui.rarity === tier.id).map((tier) => {
      const label = rarityLabel(tier);
      const items = tier.items.filter((item) => !query || normalize(item.name).includes(query) || normalize(label).includes(query) || normalize(tier.name).includes(query));
      if (query && !items.length) return '';
      const open = query ? true : !ui.collapsed.has(tier.id);
      const chance = num(tier.chance, 0).toFixed(2);
      const body = items.length
        ? '<div class="loot-row-head"><span>' + esc(tr('loot.modal.name')) + '</span><span>' + esc(tr('loot.row.weight')) + '</span><span>' + esc(tr('loot.areas.share')) + '</span><span></span></div>'
          + items.map((item) => rowHtml(tier, item)).join('')
        : '<p class="small loot-empty">' + esc(tr('loot.empty')) + '</p>';
      return '<details class="loot-group" data-group="' + esc(tier.id) + '" data-rarity="' + esc(tier.id) + '"' + (open ? ' open' : '') + ' style="--rc:' + colorOf(tier.id) + '">'
        + '<summary class="loot-group-head"><i class="loot-dot"></i><h3>' + esc(label) + '</h3>'
        + '<span class="loot-count">' + esc(tr('loot.group.entries', { count: tier.items.length })) + '</span>'
        + '<span class="loot-count">' + esc(tr('loot.group.odds', { chance })) + '</span></summary>'
        + '<div class="loot-rows">' + body + '</div>'
        + '<div class="loot-add">'
        + '<input type="text" maxlength="60" data-add-name="' + esc(tier.id) + '" placeholder="' + esc(tr('loot.group.addPlaceholder', { rarity: label })) + '" aria-label="' + esc(tr('loot.group.addName')) + '">'
        + '<input type="number" data-no-slider min="0" max="10000" step="1" value="' + DEFAULT_WEIGHT + '" data-add-weight="' + esc(tier.id) + '" aria-label="' + esc(tr('loot.group.addWeight')) + '">'
        + '<button type="button" class="btn secondary" data-act="quick-add" data-tier="' + esc(tier.id) + '">' + esc(tr('loot.group.add')) + '</button>'
        + '</div></details>';
    }).join('');
    return groups || '<p class="small loot-empty">' + esc(tr('loot.empty')) + '</p>';
  }

  function fishTabHtml() {
    return '<div class="loot-stack">' + oddsHtml() + toolsHtml()
      + '<div id="loot-groups" class="loot-groups">' + groupsHtml() + '</div></div>';
  }

  function areaIds() {
    return Object.keys(draft.areas);
  }

  function currentArea() {
    const ids = areaIds();
    if (!ui.area || !draft.areas[ui.area]) ui.area = ids[0] || null;
    return ui.area ? draft.areas[ui.area] : null;
  }

  function areaTierOptions(selected) {
    return draft.tiers.map((t) => '<option value="' + esc(t.name) + '"' + (t.name === selected ? ' selected' : '') + '>' + esc(rarityLabel(t)) + '</option>').join('');
  }

  function areaRowHtml(row, index, total) {
    return '<div class="loot-area-row" data-area-row="' + index + '">'
      + '<input type="text" maxlength="60" value="' + esc(row.name) + '" data-area-field="name" data-index="' + index + '" aria-label="' + esc(tr('loot.areas.name')) + '">'
      + '<select data-area-field="tier" data-index="' + index + '" aria-label="' + esc(tr('loot.areas.rarity')) + '">' + areaTierOptions(row.tier) + '</select>'
      + '<input type="number" data-no-slider min="0" max="10000" step="1" value="' + num(row.weight, 0) + '" data-area-field="weight" data-index="' + index + '" aria-label="' + esc(tr('loot.row.weight')) + '">'
      + '<input type="number" data-no-slider min="0" max="50" step="0.1" value="' + num(row.boost, 0) + '" data-area-field="boost" data-index="' + index + '" aria-label="' + esc(tr('loot.areas.boost')) + '">'
      + shareCell(row.weight, total, 'data-area-share="' + index + '"')
      + '<button type="button" class="btn danger" data-act="area-remove" data-index="' + index + '">' + esc(tr('loot.row.remove')) + '</button>'
      + '</div>';
  }

  function areasTabHtml() {
    const area = currentArea();
    const ids = areaIds();
    if (!area) return '<section class="card"><p class="small">' + esc(tr('loot.empty')) + '</p></section>';
    const picker = ids.map((id) => {
      const a = draft.areas[id];
      return '<button type="button" class="loot-chip" data-act="area-pick" data-area="' + esc(id) + '" aria-pressed="' + (id === ui.area) + '">'
        + '<span>' + esc(a.name || id) + '</span><span class="loot-chip-count">' + a.loot.length + '</span></button>';
    }).join('');
    const total = area.loot.reduce((n, r) => n + Math.max(0, num(r.weight, 0)), 0);
    const segs = area.loot.map((row, i) => '<span class="loot-bar-seg" data-area-seg="' + i + '" style="width:' + shareFill(row.weight, total).toFixed(2) + '%;background:' + colorOf(tierByName(row.tier)?.id) + '"></span>').join('');
    const rows = area.loot.map((row, i) => areaRowHtml(row, i, total)).join('');
    const common = draft.tiers.find((t) => t.id === 'common')?.name;
    return '<section class="card loot-areas">'
      + '<div class="loot-section-head"><div><h2>' + esc(tr('loot.areas.title')) + '</h2><p class="small">' + esc(tr('loot.areas.lede')) + '</p></div>'
      + '<span class="loot-total" data-area-total>' + esc(tr('loot.areas.total')) + ': ' + total + '</span></div>'
      + '<div class="loot-area-picker" role="group" aria-label="' + esc(tr('loot.areas.pick')) + '">' + picker + '</div>'
      + '<div class="loot-bar loot-area-bar" aria-hidden="true">' + segs + '</div>'
      + '<div class="loot-area-head"><span>' + esc(tr('loot.areas.name')) + '</span><span>' + esc(tr('loot.areas.rarity')) + '</span><span>' + esc(tr('loot.row.weight')) + '</span><span>' + esc(tr('loot.areas.boost')) + '</span><span>' + esc(tr('loot.areas.share')) + '</span><span></span></div>'
      + '<div id="loot-area-rows">' + rows + '</div>'
      + '<div class="loot-area-row loot-area-add">'
      + '<input type="text" maxlength="60" id="area-new-name" placeholder="' + esc(tr('loot.areas.namePlaceholder')) + '" aria-label="' + esc(tr('loot.areas.name')) + '">'
      + '<select id="area-new-tier" aria-label="' + esc(tr('loot.areas.rarity')) + '">' + areaTierOptions(common) + '</select>'
      + '<input type="number" data-no-slider min="0" max="10000" step="1" value="' + DEFAULT_WEIGHT + '" id="area-new-weight" aria-label="' + esc(tr('loot.row.weight')) + '">'
      + '<input type="number" data-no-slider min="0" max="50" step="0.1" value="0" id="area-new-boost" aria-label="' + esc(tr('loot.areas.boost')) + '">'
      + '<span aria-hidden="true"></span>'
      + '<button type="button" class="btn secondary" data-act="area-add">' + esc(tr('loot.areas.addRow')) + '</button></div>'
      + '<div class="loot-area-foot"><p class="small">' + esc(tr('loot.areas.boostHelp')) + '</p>'
      + '<button type="button" class="btn secondary" data-act="area-reset">' + esc(tr('loot.areas.reset')) + '</button></div>'
      + '</section>';
  }

  function bodyHtml() {
    return ui.tab === 'areas' ? areasTabHtml() : fishTabHtml();
  }

  function editorValues(mode, tier, item) {
    const perk = item ? draft.abilities[item.name] : null;
    const effect = perk && EFFECT_IDS.includes(perk.effectType) ? perk.effectType : 'luck';
    return {
      mode,
      original: item ? item.name : null,
      name: item ? item.name : '',
      tier: tier ? tier.id : 'common',
      weight: item ? num(item.weight, DEFAULT_WEIGHT) : DEFAULT_WEIGHT,
      perkOn: !!perk,
      perkName: perk ? perk.perkName || '' : '',
      perkDesc: perk ? perk.description || '' : '',
      effect,
      multiplier: perk && effect !== 'cooldownReduction' && effect !== 'timeout' ? num(perk.effectValue, 1.25) : 1.25,
      cooldown: perk && effect === 'cooldownReduction' ? num(perk.cooldownReductionPct ?? perk.effectValue, 20) : 20,
      duration: perk && effect !== 'timeout' ? num(perk.durationMinutes, 10) : 10,
      timeout: perk && effect === 'timeout' ? num(perk.timeoutMinutes ?? perk.durationMinutes, 5) : 5,
      error: ''
    };
  }

  function modalHtml() {
    const ed = ui.editor;
    if (!ed) return '<div id="loot-modal" class="modal-backdrop" hidden></div>';
    const v = ed.values;
    const title = ed.mode === 'edit' ? tr('loot.modal.editTitle', { name: ed.original }) : tr('loot.modal.addTitle');
    const rarityOpts = draft.tiers.map((t) => '<option value="' + esc(t.id) + '"' + (t.id === v.tier ? ' selected' : '') + '>' + esc(rarityLabel(t)) + '</option>').join('');
    const effectOpts = EFFECT_IDS.map((id) => '<option value="' + id + '"' + (id === v.effect ? ' selected' : '') + '>' + esc(tr('loot.effect.' + id)) + '</option>').join('');
    return '<div id="loot-modal" class="modal-backdrop" data-modal-backdrop>'
      + '<div class="modal-card loot-modal" role="dialog" aria-modal="true" aria-labelledby="loot-modal-title">'
      + '<div class="loot-modal-head"><div><div class="eyebrow">' + esc(tr('loot.title')) + '</div><h2 id="loot-modal-title">' + esc(title) + '</h2></div>'
      + '<button type="button" class="btn secondary" data-modal="close">' + esc(tr('button.close')) + '</button></div>'
      + '<section class="loot-modal-section"><h3>' + esc(tr('loot.modal.entry')) + '</h3>'
      + '<div class="loot-modal-grid">'
      + '<div class="field"><label for="lm-name">' + esc(tr('loot.modal.name')) + '</label><input id="lm-name" data-mf="name" maxlength="60" value="' + esc(v.name) + '" autocomplete="off"></div>'
      + '<div class="field"><label for="lm-tier">' + esc(tr('loot.modal.rarity')) + '</label><select id="lm-tier" data-mf="tier">' + rarityOpts + '</select></div>'
      + '<div class="field"><label for="lm-weight">' + esc(tr('loot.modal.weight')) + '</label><input id="lm-weight" data-mf="weight" type="number" data-no-slider min="0" max="10000" step="1" value="' + num(v.weight, DEFAULT_WEIGHT) + '"><p class="small">' + esc(tr('loot.modal.weightHelp')) + '</p></div>'
      + '</div>'
      + '<div id="lm-similar" class="notice warn" hidden></div>'
      + '</section>'
      + '<section class="loot-modal-section"><h3>' + esc(tr('loot.modal.perk')) + '</h3>'
      + '<label class="switch-line loot-switch"><input type="checkbox" data-mf="perkOn"' + (v.perkOn ? ' checked' : '') + '><span><strong>' + esc(tr('loot.modal.perkToggle')) + '</strong><span class="small">' + esc(tr('loot.modal.perkHelp')) + '</span></span></label>'
      + '<div data-perk-fields class="loot-perk-fields"' + (v.perkOn ? '' : ' hidden') + '>'
      + '<div class="loot-modal-grid">'
      + '<div class="field"><label for="lm-perk-name">' + esc(tr('loot.modal.perkName')) + '</label><input id="lm-perk-name" data-mf="perkName" maxlength="48" value="' + esc(v.perkName) + '" placeholder="' + esc(tr('loot.modal.perkNamePh', { name: v.name || tr('loot.modal.name') })) + '"></div>'
      + '<div class="field"><label for="lm-perk-desc">' + esc(tr('loot.modal.perkDesc')) + '</label><input id="lm-perk-desc" data-mf="perkDesc" maxlength="240" value="' + esc(v.perkDesc) + '" placeholder="' + esc(tr('loot.modal.perkDescPh')) + '"></div>'
      + '</div>'
      + '<div class="field"><label for="lm-effect">' + esc(tr('loot.modal.effect')) + '</label><select id="lm-effect" data-mf="effect">' + effectOpts + '</select><p class="small" data-effect-hint></p></div>'
      + '<div class="loot-modal-grid">'
      + '<div class="field" data-show="multiplier"><label for="lm-multiplier">' + esc(tr('loot.modal.multiplier')) + '</label><input id="lm-multiplier" data-mf="multiplier" type="number" data-no-slider min="0.05" max="10" step="0.05" value="' + num(v.multiplier, 1.25) + '"><p class="small">' + esc(tr('loot.modal.multiplierHelp')) + '</p></div>'
      + '<div class="field" data-show="cooldown"><label for="lm-cooldown">' + esc(tr('loot.modal.cooldown')) + '</label>'
      + '<div class="loot-slider"><input type="range" min="1" max="80" step="1" value="' + num(v.cooldown, 20) + '" data-mf="cooldownRange" aria-label="' + esc(tr('loot.modal.cooldown')) + '"><input id="lm-cooldown" data-mf="cooldown" type="number" data-no-slider min="1" max="80" step="1" value="' + num(v.cooldown, 20) + '"></div>'
      + '<p class="small">' + esc(tr('loot.modal.cooldownHelp')) + '</p></div>'
      + '<div class="field" data-show="temporary"><label for="lm-duration">' + esc(tr('loot.modal.duration')) + '</label><input id="lm-duration" data-mf="duration" type="number" data-no-slider min="1" max="20" step="1" value="' + num(v.duration, 10) + '"></div>'
      + '<div class="field" data-show="timeout"><label for="lm-timeout">' + esc(tr('loot.modal.timeoutLength')) + '</label><input id="lm-timeout" data-mf="timeout" type="number" data-no-slider min="1" max="20" step="1" value="' + num(v.timeout, 5) + '"><p class="small">' + esc(tr('loot.modal.timeoutHelp')) + '</p></div>'
      + '</div>'
      + '</div>'
      + '</section>'
      + '<div class="loot-preview"><strong>' + esc(tr('loot.modal.preview')) + '</strong><span data-preview-text></span></div>'
      + '<div id="lm-error" class="notice error"' + (v.error ? '' : ' hidden') + '>' + esc(v.error) + '</div>'
      + '<div class="actions loot-modal-actions"><button type="button" class="btn primary" data-modal="save">' + esc(tr('loot.modal.save')) + '</button>'
      + (ed.mode === 'edit' ? '<button type="button" class="btn danger" data-modal="delete">' + esc(tr('loot.modal.delete')) + '</button>' : '')
      + '<button type="button" class="btn secondary" data-modal="close">' + esc(tr('button.cancel')) + '</button></div>'
      + '</div></div>';
  }

  function previewSentence(v) {
    const name = v.name.trim() || tr('loot.modal.name');
    const minutes = v.effect === 'timeout' ? num(v.timeout, 5) : num(v.duration, 10);
    if (v.effect === 'timeout') return tr('loot.preview.timeout', { name, minutes });
    if (v.effect === 'cooldownReduction') return tr('loot.preview.cooldownReduction', { name, value: num(v.cooldown, 20), minutes });
    return tr('loot.preview.' + v.effect, { name, value: num(v.multiplier, 1.25), minutes });
  }

  function syncModal() {
    const ed = ui.editor;
    const host = document.getElementById('loot-modal');
    if (!ed || !host) return;
    const v = ed.values;
    const perkFields = host.querySelector('[data-perk-fields]');
    if (perkFields) perkFields.hidden = !v.perkOn;
    host.querySelectorAll('[data-show]').forEach((el) => {
      const kind = el.getAttribute('data-show');
      const visible = kind === 'multiplier' ? MULTIPLIER_EFFECTS.includes(v.effect)
        : kind === 'cooldown' ? v.effect === 'cooldownReduction'
        : kind === 'temporary' ? v.effect !== 'timeout'
        : v.effect === 'timeout';
      el.hidden = !visible;
    });
    const hint = host.querySelector('[data-effect-hint]');
    if (hint) hint.textContent = tr('loot.effect.hint.' + v.effect);
    const preview = host.querySelector('[data-preview-text]');
    if (preview) preview.textContent = previewSentence(v);
    const out = host.querySelector('[data-cool-out]');
    if (out) out.textContent = num(v.cooldown, 20) + '%';
    const similar = document.getElementById('lm-similar');
    if (similar) {
      const matches = v.name.trim() ? similarTo(v.name, ed.original) : [];
      if (matches.length) {
        similar.hidden = false;
        similar.textContent = tr('loot.modal.similar', { names: matches.map((m) => m.name + ' (' + rarityLabel(m.tier) + ')').join(', ') });
      } else {
        similar.hidden = true;
        similar.textContent = '';
      }
    }
  }

  function readModal() {
    const ed = ui.editor;
    const host = document.getElementById('loot-modal');
    if (!ed || !host) return;
    const get = (key) => host.querySelector('[data-mf="' + key + '"]');
    const v = ed.values;
    v.name = get('name')?.value ?? v.name;
    v.tier = get('tier')?.value ?? v.tier;
    v.weight = get('weight')?.value ?? v.weight;
    v.perkOn = !!get('perkOn')?.checked;
    v.perkName = get('perkName')?.value ?? v.perkName;
    v.perkDesc = get('perkDesc')?.value ?? v.perkDesc;
    v.effect = get('effect')?.value ?? v.effect;
    v.multiplier = get('multiplier')?.value ?? v.multiplier;
    v.cooldown = get('cooldown')?.value ?? v.cooldown;
    v.duration = get('duration')?.value ?? v.duration;
    v.timeout = get('timeout')?.value ?? v.timeout;
  }

  function validateEditor() {
    const v = ui.editor.values;
    const name = String(v.name || '').trim().replace(/\s+/g, ' ');
    if (!NAME_PATTERN.test(name) || /\[[^\]]*\]$/.test(name)) return tr('loot.modal.errName');
    const existing = findFish(name);
    if (existing && (ui.editor.mode === 'add' || normalize(existing.item.name) !== normalize(ui.editor.original))) return tr('loot.modal.errTaken', { name });
    if (!tierById(v.tier)) return tr('loot.modal.errName');
    const weight = Number(v.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 10000) return tr('loot.modal.errWeight');
    if (!v.perkOn) return '';
    if (v.effect === 'timeout') {
      const minutes = Number(v.timeout);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 20) return tr('loot.modal.errDuration');
    } else {
      const minutes = Number(v.duration);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 20) return tr('loot.modal.errDuration');
      if (v.effect === 'cooldownReduction') {
        const pct = Number(v.cooldown);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 80) return tr('loot.modal.errCooldown');
      } else {
        const mult = Number(v.multiplier);
        if (!Number.isFinite(mult) || mult <= 0 || mult > 10) return tr('loot.modal.errMultiplier');
      }
    }
    return '';
  }

  function perkFromValues(name, v) {
    const perkName = String(v.perkName || '').trim().slice(0, 48) || tr('loot.modal.perkNamePh', { name });
    const description = String(v.perkDesc || '').trim().slice(0, 240);
    if (v.effect === 'timeout') {
      const minutes = Number(v.timeout);
      return { perkName, description, effectType: 'timeout', effectValue: 1, durationMinutes: minutes, timeoutMinutes: minutes, cooldownReductionPct: 0 };
    }
    const minutes = Number(v.duration);
    if (v.effect === 'cooldownReduction') {
      const pct = Number(v.cooldown);
      return { perkName, description, effectType: 'cooldownReduction', effectValue: pct, durationMinutes: minutes, timeoutMinutes: minutes, cooldownReductionPct: pct };
    }
    const mult = Number(v.multiplier);
    return { perkName, description, effectType: v.effect, effectValue: mult, durationMinutes: minutes, timeoutMinutes: minutes, cooldownReductionPct: 0 };
  }

  function applyEditor() {
    const ed = ui.editor;
    const v = ed.values;
    const name = String(v.name || '').trim().replace(/\s+/g, ' ');
    if (ed.mode === 'edit' && ed.original) {
      for (const tier of draft.tiers) {
        const index = tier.items.findIndex((i) => normalize(i.name) === normalize(ed.original));
        if (index >= 0) tier.items.splice(index, 1);
      }
      delete draft.abilities[ed.original];
    }
    tierById(v.tier).items.push({ name, weight: Number(v.weight) });
    if (v.perkOn) draft.abilities[name] = perkFromValues(name, v);
    else delete draft.abilities[name];
  }

  function openEditor(mode, tierId, name) {
    const tier = tierById(tierId) || draft.tiers.find((t) => t.id === 'common') || draft.tiers[0];
    let item = null;
    let owner = tier;
    if (name) {
      const found = findFish(name);
      if (found) { item = found.item; owner = found.tier; }
    }
    ui.editor = { mode, values: editorValues(mode, owner, item), original: item ? item.name : null };
    paintModal();
    const host = document.getElementById('loot-modal');
    if (host) {
      const first = host.querySelector('[data-mf="name"]');
      if (first) first.focus();
      syncModal();
    }
  }

  function closeEditor() {
    ui.editor = null;
    paintModal();
  }

  function paintModal() {
    const host = document.getElementById('loot-modal-host');
    if (host) host.innerHTML = modalHtml();
    if (ui.editor) syncModal();
  }

  function paintAll() {
    const top = document.getElementById('loot-top');
    const body = document.getElementById('loot-body');
    if (!top || !body) return;
    top.innerHTML = topHtml();
    body.innerHTML = tabsHtml() + '<div id="loot-tab-body">' + bodyHtml() + '</div>';
    paintModal();
    bindGroups();
  }

  function refreshTop() {
    const top = document.getElementById('loot-top');
    if (top) top.innerHTML = topHtml();
  }

  function refreshGroups() {
    const box = document.getElementById('loot-groups');
    if (!box) return;
    box.innerHTML = groupsHtml();
    bindGroups();
  }

  function refreshShares(tierId) {
    const tier = tierById(tierId);
    if (!tier) return;
    const total = totalWeight(tier);
    document.querySelectorAll('[data-share][data-tier="' + tierId + '"]').forEach((el) => {
      const row = el.closest('[data-row]');
      const item = tier.items.find((i) => i.name === row?.getAttribute('data-name'));
      if (item) paintShare(el, item.weight, total);
    });
  }

  function refreshOddsTotal() {
    const normal = draft.tiers.filter((t) => NORMAL_IDS.includes(t.id));
    const total = normal.reduce((n, t) => n + num(t.chance, 0), 0);
    const strong = document.querySelector('[data-normal-total]');
    if (strong) {
      strong.textContent = total.toFixed(2);
      strong.parentElement?.classList.toggle('is-bad', Math.abs(total - 100) > 0.005);
    }
    normal.forEach((t) => {
      const seg = document.querySelector('[data-bar="' + t.id + '"]');
      if (seg) seg.style.width = Math.max(0, num(t.chance, 0)).toFixed(2) + '%';
    });
  }

  function refreshAreaSummary() {
    const area = currentArea();
    if (!area) return;
    const total = area.loot.reduce((n, r) => n + Math.max(0, num(r.weight, 0)), 0);
    area.loot.forEach((row, i) => {
      const el = document.querySelector('[data-area-share="' + i + '"]');
      if (el) paintShare(el, row.weight, total);
      const seg = document.querySelector('[data-area-seg="' + i + '"]');
      if (seg) {
        seg.style.width = shareFill(row.weight, total).toFixed(2) + '%';
        seg.style.background = colorOf(tierByName(row.tier)?.id);
      }
    });
    const out = document.querySelector('[data-area-total]');
    if (out) out.textContent = tr('loot.areas.total') + ': ' + total;
  }

  function bindGroups() {
    document.querySelectorAll('details[data-group]').forEach((el) => {
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      el.addEventListener('toggle', () => {
        const id = el.getAttribute('data-group');
        if (el.open) ui.collapsed.delete(id);
        else ui.collapsed.add(id);
      });
    });
  }

  // ---------- actions ----------

  function changeTier(tierId, name, weight) {
    const tier = tierById(tierId);
    const item = tier?.items.find((i) => normalize(i.name) === normalize(name));
    if (item) item.weight = weight;
  }

  function quickAdd(tierId) {
    const nameInput = document.querySelector('[data-add-name="' + tierId + '"]');
    const weightInput = document.querySelector('[data-add-weight="' + tierId + '"]');
    const name = String(nameInput?.value || '').trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (!NAME_PATTERN.test(name) || /\[[^\]]*\]$/.test(name)) { ctx.notice(tr('loot.modal.errName'), 'error'); return; }
    if (findFish(name)) { ctx.notice(tr('loot.modal.errTaken', { name }), 'error'); return; }
    const weight = Number(weightInput?.value ?? DEFAULT_WEIGHT);
    if (!Number.isFinite(weight) || weight < 0 || weight > 10000) { ctx.notice(tr('loot.modal.errWeight'), 'error'); return; }
    const similar = similarTo(name);
    tierById(tierId).items.push({ name, weight });
    if (similar.length) ctx.notice(tr('loot.modal.similar', { names: similar.map((m) => m.name).join(', ') }), 'warn');
    paintAll();
    const again = document.querySelector('[data-add-name="' + tierId + '"]');
    if (again) again.focus();
  }

  function removeFish(tierId, name) {
    const tier = tierById(tierId);
    if (!tier) return;
    if (!confirm(tr('loot.modal.deleteConfirm', { name }))) return;
    const index = tier.items.findIndex((i) => normalize(i.name) === normalize(name));
    if (index >= 0) tier.items.splice(index, 1);
    delete draft.abilities[name];
    paintAll();
  }

  function areaRowFromInputs(prefix) {
    const name = String(document.getElementById(prefix + 'name')?.value || '').trim().replace(/\s+/g, ' ');
    return {
      name,
      tier: document.getElementById(prefix + 'tier')?.value || draft.tiers.find((t) => t.id === 'common')?.name || 'COMMON',
      weight: Number(document.getElementById(prefix + 'weight')?.value ?? DEFAULT_WEIGHT),
      boost: Number(document.getElementById(prefix + 'boost')?.value ?? 0)
    };
  }

  function addAreaRow() {
    const area = currentArea();
    if (!area) return;
    const row = areaRowFromInputs('area-new-');
    if (!NAME_PATTERN.test(row.name) || /\[[^\]]*\]$/.test(row.name)) { ctx.notice(tr('loot.modal.errName'), 'error'); return; }
    if (area.loot.some((r) => normalize(r.name) === normalize(row.name))) { ctx.notice(tr('loot.modal.errTaken', { name: row.name }), 'error'); return; }
    if (!Number.isFinite(row.weight) || row.weight < 0 || row.weight > 10000) { ctx.notice(tr('loot.modal.errWeight'), 'error'); return; }
    if (!Number.isFinite(row.boost) || row.boost < 0 || row.boost > 50) { ctx.notice(tr('loot.areas.errBoost'), 'error'); return; }
    area.loot.push(row);
    paintAll();
  }

  function resetArea() {
    const area = currentArea();
    if (!area) return;
    const settings = ctx.settings;
    const defaults = settings.areaLoot?.[ui.area]?.defaults;
    if (!defaults) return;
    if (!confirm(tr('loot.areas.resetConfirm', { area: area.name || ui.area }))) return;
    area.loot = defaults.loot.map((r) => ({ name: r.name, tier: r.tier, weight: num(r.weight, 0), boost: num(r.boost, 0) }));
    paintAll();
  }

  function discard() {
    if (!changeCount()) return;
    if (!confirm(tr('loot.discardConfirm'))) return;
    draft = JSON.parse(base);
    ui.editor = null;
    paintAll();
    ctx.notice(tr('loot.discarded'), 'info');
  }

  function expandAll(open) {
    if (open) ui.collapsed.clear();
    else draft.tiers.forEach((t) => ui.collapsed.add(t.id));
    document.querySelectorAll('details[data-group]').forEach((d) => { d.open = open; });
  }

  async function save() {
    const issues = computeIssues();
    if (issues.blocking.length) { ctx.notice(issues.blocking[0], 'error'); return; }
    try {
      await ctx.call('loot-table', buildPayload());
      ctx.notice(ctx.saveMessage || tr('loot.saved'), 'good');
      // The offline window stays on the page: the change is only queued until the server starts.
      if (ctx.keepPage) return;
      setTimeout(() => { location.reload(); }, 4500);
    } catch (error) {
      ctx.notice(error.message, 'error');
    }
  }

  function saveEditor() {
    readModal();
    const error = validateEditor();
    if (error) {
      ui.editor.values.error = error;
      const box = document.getElementById('lm-error');
      if (box) { box.hidden = false; box.textContent = error; }
      return;
    }
    applyEditor();
    ui.editor = null;
    paintAll();
    ctx.notice(tr('loot.staged'), 'good');
  }

  function deleteEditor() {
    const ed = ui.editor;
    if (!ed || !ed.original) return;
    if (!confirm(tr('loot.modal.deleteConfirm', { name: ed.original }))) return;
    for (const tier of draft.tiers) {
      const index = tier.items.findIndex((i) => normalize(i.name) === normalize(ed.original));
      if (index >= 0) tier.items.splice(index, 1);
    }
    delete draft.abilities[ed.original];
    ui.editor = null;
    paintAll();
  }

  // ---------- events ----------

  function onClick(event) {
    const root = event.target.closest && event.target.closest('[data-loot-root]');
    const modalBackdrop = event.target.closest && event.target.closest('[data-modal-backdrop]');
    if (modalBackdrop && event.target === modalBackdrop) { closeEditor(); return; }
    if (!root) return;
    const el = event.target.closest('[data-act],[data-modal]');
    if (!el) return;
    const modal = el.getAttribute('data-modal');
    if (modal === 'close') return closeEditor();
    if (modal === 'save') return saveEditor();
    if (modal === 'delete') return deleteEditor();
    const act = el.getAttribute('data-act');
    const tier = el.getAttribute('data-tier');
    const name = el.getAttribute('data-name');
    switch (act) {
      case 'tab': ui.tab = el.getAttribute('data-tab') === 'areas' ? 'areas' : 'fish'; return paintAll();
      case 'save': return save();
      case 'discard': return discard();
      case 'expand': expandAll(true); return;
      case 'collapse': expandAll(false); return;
      case 'rarity-pick': ui.rarity = el.getAttribute('data-rarity') || 'all'; refreshTools(); refreshGroups(); return;
      case 'add': return openEditor('add', 'common', null);
      case 'edit': return openEditor('edit', tier, name);
      case 'remove': return removeFish(tier, name);
      case 'quick-add': return quickAdd(tier);
      case 'area-pick': ui.area = el.getAttribute('data-area'); return paintAll();
      case 'area-add': return addAreaRow();
      case 'area-remove': {
        const area = currentArea();
        if (area) area.loot.splice(Number(el.getAttribute('data-index')), 1);
        return paintAll();
      }
      case 'area-reset': return resetArea();
      default: return undefined;
    }
  }

  function onChange(event) {
    const target = event.target;
    if (!target.closest || !target.closest('[data-loot-root]')) return;
    if (target.hasAttribute('data-weight')) {
      const weight = Number(target.value);
      if (!Number.isFinite(weight) || weight < 0 || weight > 10000) {
        ctx.notice(tr('loot.modal.errWeight'), 'error');
        const current = tierById(target.getAttribute('data-tier'))?.items.find((i) => normalize(i.name) === normalize(target.getAttribute('data-name')));
        target.value = String(num(current?.weight, DEFAULT_WEIGHT));
        return;
      }
      changeTier(target.getAttribute('data-tier'), target.getAttribute('data-name'), weight);
      refreshShares(target.getAttribute('data-tier'));
      refreshTop();
      return;
    }
    if (target.hasAttribute('data-area-field')) {
      const area = currentArea();
      const index = Number(target.getAttribute('data-index'));
      const field = target.getAttribute('data-area-field');
      const row = area?.loot[index];
      if (!row) return;
      if (field === 'name') {
        const value = String(target.value || '').trim().replace(/\s+/g, ' ');
        if (!NAME_PATTERN.test(value) || /\[[^\]]*\]$/.test(value)) { ctx.notice(tr('loot.modal.errName'), 'error'); target.value = row.name; return; }
        row.name = value;
      } else if (field === 'tier') {
        row.tier = target.value;
      } else if (field === 'weight') {
        const w = Number(target.value);
        if (!Number.isFinite(w) || w < 0 || w > 10000) { ctx.notice(tr('loot.modal.errWeight'), 'error'); target.value = String(row.weight); return; }
        row.weight = w;
      } else if (field === 'boost') {
        const b = Number(target.value);
        if (!Number.isFinite(b) || b < 0 || b > 50) { ctx.notice(tr('loot.areas.errBoost'), 'error'); target.value = String(row.boost); return; }
        row.boost = b;
      }
      refreshAreaSummary();
      refreshTop();
      return;
    }
    if (target.hasAttribute('data-mf')) {
      readModal();
      syncModal();
      return;
    }
  }

  function onInput(event) {
    const target = event.target;
    if (!target.closest || !target.closest('[data-loot-root]')) return;
    if (target.id === 'loot-search') {
      ui.query = target.value;
      refreshGroups();
      return;
    }
    if (target.hasAttribute('data-odd')) {
      const tier = tierById(target.getAttribute('data-odd'));
      const value = Number(target.value);
      if (tier && Number.isFinite(value) && value >= 0) tier.chance = value;
      refreshOddsTotal();
      refreshTop();
      return;
    }
    if (target.hasAttribute('data-mf') && ui.editor) {
      const field = target.getAttribute('data-mf');
      if (field === 'cooldownRange') {
        const out = document.getElementById('lm-cooldown');
        if (out) out.value = target.value;
      } else if (field === 'cooldown') {
        const range = document.querySelector('[data-mf="cooldownRange"]');
        if (range && Number.isFinite(Number(target.value))) range.value = target.value;
      }
      readModal();
      syncModal();
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && ui.editor) { closeEditor(); return; }
    const target = event.target;
    if (event.key === 'Enter' && target.hasAttribute && target.hasAttribute('data-add-name')) {
      event.preventDefault();
      quickAdd(target.getAttribute('data-add-name'));
    }
  }

  // ---------- mount ----------

  function mount(context) {
    ctx = context;
    if (!ctx.settings) return;
    syncFrom(ctx.settings);
    const view = document.getElementById('view');
    if (view && !view.dataset.lootBound) {
      view.dataset.lootBound = '1';
      view.addEventListener('click', onClick);
      view.addEventListener('change', onChange);
      view.addEventListener('input', onInput);
      view.addEventListener('keydown', onKeydown);
    }
    ctx.setView(
      '<div class="loot-ed" data-loot-root id="loot-root"><div id="loot-top"></div><div id="loot-body"></div><div id="loot-modal-host"></div></div>',
      tr('nav.lootTable')
    );
    paintAll();
  }

  window.FishingbotLoot = { mount };
})();
