// Offline Game settings in the Control Centre look. Starts from the copy the server saved last
// time it ran. Saving queues the change; the server applies it on its next start.
(() => {
  'use strict';

  const api = window.fishingbot;
  const view = document.getElementById('view');
  const noticeBox = document.getElementById('notice');

  const NAMES = {
    full: 'Full', short: 'Short (no luck, area or event extras)', off: 'Off',
    reply: 'Reply in chat', silent: 'Silent',
    rare: 'Rare and above', epic: 'Epic and above', legendary: 'Legendary and above',
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function notice(text, tone) {
    noticeBox.textContent = text;
    noticeBox.className = 'small ' + (tone === 'error' ? 'bad' : tone === 'good' ? 'ok' : '');
  }

  const field = (id, label, value, min, max, step) =>
    `<div class="inline-field"><label for="${id}">${esc(label)}</label>` +
    `<input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${Number(value ?? 0)}"></div>`;

  const select = (id, label, options, value) =>
    `<div class="inline-field"><label for="${id}">${esc(label)}</label><select id="${id}">` +
    options.map((o) => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(NAMES[o] || o)}</option>`).join('') +
    '</select></div>';

  const toggle = (id, label, on) =>
    `<label class="toggle-line"><input type="checkbox" id="${id}"${on ? ' checked' : ''}> ${esc(label)}</label>`;

  function render(data) {
    const { snapshot, groups, chatOptions } = data;
    if (!snapshot) {
      view.innerHTML = '<div class="card b-12"><p class="small">There is no saved copy of the game settings yet. Start the server once; the current values are then saved here.</p></div>';
      return;
    }
    const chat = snapshot.chat || {};
    const when = new Date(snapshot.savedAt).toLocaleString();

    const autoGroups = groups.map((group) =>
      `<details class="card b-4"><summary><h3>${esc(group.title)}</h3></summary><div class="settings-grid">` +
      group.fields.map(([key, label, min, max, step]) => field('gs-af-' + key, label, snapshot.autoFish[key], min, max, step)).join('') +
      '</div></details>').join('');

    view.innerHTML =
      '<div class="card b-12"><div class="row"><div><h2>Game settings</h2>' +
      `<p class="small">Offline: values saved on ${esc(when)}. Changes are checked before they are saved.</p></div>` +
      '<div class="actions"><button class="btn primary" id="gs-save" type="button">Queue game settings</button></div></div></div>' +
      '<details class="card b-6" open><summary><h2>Fishing and chat</h2></summary>' +
      '<p class="small">The cooldown is global. Auto-Fish availability is set here too.</p>' +
      '<div class="settings-grid">' +
      field('gs-cooldown', 'Global !fish cooldown (seconds)', snapshot.cooldownSeconds, 0, 240, 1) +
      toggle('gs-autofish-enabled', 'Allow Auto-Fish for viewers', snapshot.autoFish.enabled) +
      select('gs-chat-detail', 'Catch reply detail', chatOptions.chatDetail, chat.chatDetail) +
      select('gs-cooldown-reply', 'Cooldown reply', chatOptions.cooldownReply, chat.cooldownReply) +
      select('gs-rare-announce', 'Rare catch announcement', chatOptions.rareAnnounceTier, chat.rareAnnounceTier) +
      '</div></details>' +
      '<details class="card b-6" open><summary><h2>World features</h2></summary>' +
      '<p class="small">Disabling a feature hides it for everyone. Player unlocks and progression are kept.</p>' +
      toggle('gs-areas-enabled', 'Enable fishing areas', snapshot.areas.enabled) +
      toggle('gs-double-catch', 'Enable double-catch progression', snapshot.areas.doubleCatchEnabled) +
      '<div class="tier"><div class="badge">Individual areas</div>' +
      snapshot.areas.items.map((item) => toggle('gs-area-' + item.id, item.name, item.enabled)).join('') +
      '</div></details>' +
      '<section class="card b-12"><h2>Auto-Fish</h2></section>' + autoGroups;

    const q = (id) => document.getElementById(id);
    document.getElementById('gs-save').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const values = {
        cooldownSeconds: Number(q('gs-cooldown').value),
        chat: {
          chatDetail: q('gs-chat-detail').value,
          cooldownReply: q('gs-cooldown-reply').value,
          rareAnnounceTier: q('gs-rare-announce').value,
        },
        autoFish: { enabled: q('gs-autofish-enabled').checked },
        areas: {
          enabled: q('gs-areas-enabled').checked,
          doubleCatchEnabled: q('gs-double-catch').checked,
          items: Object.fromEntries(snapshot.areas.items.map((item) => [item.id, q('gs-area-' + item.id).checked])),
        },
      };
      for (const group of groups) {
        for (const [key] of group.fields) values.autoFish[key] = Number(q('gs-af-' + key).value);
      }
      button.disabled = true;
      const result = await api.gameQueue(values);
      button.disabled = false;
      if (result.ok) notice(`Queued. ${result.pending} change(s) in the queue; applied on the next server start.`, 'good');
      else notice(result.error, 'error');
    });
  }

  api.gameSnapshot()
    .then((data) => {
      if (data.ok) return render(data);
      view.replaceChildren();
      notice(data.error, 'error');
      return null;
    })
    .catch((err) => {
      view.replaceChildren();
      notice('Could not load game settings: ' + err.message, 'error');
    });
})();
