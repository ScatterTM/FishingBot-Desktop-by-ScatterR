// Hosts the shared loot editor (loot-editor.js) in the offline loot window.
// Saving does not reach the server: the change goes to the desktop queue instead.
(() => {
  'use strict';

  const api = window.fishingbot;
  const noticeBox = document.getElementById('notice');
  const view = document.getElementById('view');
  const title = document.getElementById('page-title');

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function notice(text, tone) {
    noticeBox.textContent = text;
    noticeBox.className = 'small ' + (tone === 'error' ? 'bad' : tone === 'good' ? 'ok' : '');
  }

  function setView(html, heading) {
    view.innerHTML = html;
    if (heading) title.textContent = heading;
  }

  async function call(name, payload) {
    if (name !== 'loot-table') throw new Error('This action needs the server.');
    const result = await api.lootQueue(payload);
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  api.lootAssets().then((data) => {
    if (!data.ok) {
      setView('<p class="hint bad">' + esc(data.error) + '</p>');
      return;
    }
    const strings = data.strings || {};
    window.FishingbotI18n = {
      t: (key) => (Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : null),
      getLanguage: () => 'en',
      loadLanguage: async () => 'en',
    };
    if (!data.snapshot) {
      setView('<div class="card"><p class="small">There is no saved copy of the loot table yet. Start the server once; the current table is then saved here.</p></div>');
      return;
    }
    window.FishingbotLoot.mount({
      settings: data.snapshot,
      call,
      notice,
      setView,
      esc,
      keepPage: true,
      saveMessage: 'Queued. The server applies it on its next start.',
    });
  }).catch((error) => {
    view.replaceChildren();
    notice('Could not load the loot table: ' + error.message, 'error');
  });
})();
