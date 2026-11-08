// Settings app. Mounted into a desktop window; uses the bridge from preload.js.
(() => {
  'use strict';

  // Reads a form into an object. Radio groups give the checked value; numbers and ranges become numbers.
  function collect(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else if (el.type === 'number' || el.type === 'range') out[el.name] = Number(el.value);
      else out[el.name] = el.value;
    }
    return out;
  }

  function fill(form, data) {
    const section = data[form.dataset.section] || {};
    for (const el of form.elements) {
      if (!el.name || el.type === 'password') continue;
      const value = section[el.name];
      if (value === undefined || value === null) continue;
      if (el.type === 'checkbox') el.checked = !!value;
      else if (el.type === 'radio') el.checked = el.value === String(value);
      else el.value = value;
    }
  }

  // The look used when the user presses Restore defaults. Must match DEFAULTS in renderer/appearance.js.
  const APPEARANCE_DEFAULTS = Object.freeze({
    wallpaperFit: 'cover',
    wallpaperDim: 25,
    wallpaperBlur: 0,
    desktopColorOn: false,
    desktopColor: '#101214',
    accent: 'signal',
    glassOpacity: 72,
    gridOpacity: 72,
    textScale: 100,
    cornerRadius: 12,
    iconSize: 'medium',
    showIconLabels: true,
    clock24h: true,
    showClock: true,
    showSeconds: false,
    clockSize: 'medium',
    clockStyle: 'plain',
    clockAlign: 'centre',
    clockColour: 'ink',
    clockCustomColour: '#f1f2f4',
    clockFont: 'mono',
    dateFormat: 'long',
    datePosition: 'below',
    clockShadow: false,
    textShadow: false,
    showDate: true,
    showWidgets: true,
    widgetClock: true,
    widgetSrv: true,
    widgetTw: true,
    widgetLog: true,
    widgetSys: true,
    reduceMotion: false,
    uiFont: 'system',
    showLockClock: true,
    customAccent: '#e4572e',
    taskbarSize: 'normal',
    taskbarSearch: true,
    widgetSize: 'compact',
    taskbarOpacity: 72,
    taskbarFull: false,
    taskbarAutoHide: false,
    taskbarAlign: 'centre',
    showTaskbarClock: true,
    showTaskbarStatus: true,
    pillStyle: 'soft',
    showAvatarTaskbar: false,
    builtinWallpaper: 'ember',
    lockUseDesktop: false,
    lockBlur: 8,
    lockDim: 45,
    lockGreeting: 'Welcome Back',
    lockShowDate: true,
    uiScale: 'auto',
    performanceMode: 'custom',
    customLook: '',
  });

  // The look Performance mode applies: the settings that cost the most to draw, turned down or off.
  const PERFORMANCE_LOOK = Object.freeze({
    showWidgets: false,
    wallpaperBlur: 0,
    lockBlur: 0,
    clockShadow: false,
    showSeconds: false,
    reduceMotion: true,
    desktopColorOn: true,
    glassOpacity: 100,
    gridOpacity: 100,
    taskbarOpacity: 100,
    pillStyle: 'dot',
    showTaskbarStatus: false,
  });

  function describeUpdate(result) {
    switch (result.status) {
      case 'upToDate': return `Fishingbot Desktop is up to date (${result.latest}).`;
      case 'installing': return `Installing ${result.latest}. Fishingbot Desktop closes now.`;
      case 'ignored': return `Update ${result.latest} is ignored.`;
      case 'deferred': return `Update ${result.latest} is available. Reminding you tomorrow.`;
      case 'busy': return 'An update check is already running.';
      case 'checking': return 'Checking for updates…';
      case 'error': return `Update failed: ${result.error || 'unknown error'}`;
      default: return 'Done.';
    }
  }

  window.FishingbotApps = window.FishingbotApps || {};
  window.FishingbotApps.settings = function mountSettings(body, api) {
    body.append(document.getElementById('tpl-settings').content.cloneNode(true));
    const q = (sel) => body.querySelector(sel);
    const status = q('#status');
    const dropdowns = window.FishingbotDropdowns;
    if (dropdowns) dropdowns.enhanceAll(body);

    function say(text, tone = 'ok') {
      status.textContent = text;
      status.className = 'muted ' + tone;
      status.classList.remove('flash');
      void status.offsetWidth;
      status.classList.add('flash');
    }

    // Tabs: one pane visible at a time. Arrow keys move between tabs, as in the Windows dialogs.
    // Only the section tabs. The Appearance group buttons also have role="tab", but they belong to a
    // different row: when they were included, clicking one hid every pane (the page looked blank).
    const tabs = Array.from(body.querySelectorAll('.settings-tab[role="tab"]'));
    function showTab(name) {
      if (!name) return;
      body.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = pane.dataset.pane !== name; });
      tabs.forEach((tab) => {
        const on = tab.dataset.tab === name;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
      });
      // A pane that was hidden is laid out again before it is painted. Reading its size forces that layout
      // now, so the tab does not show as an empty panel until another click repaints it.
      const shown = body.querySelector(`[data-pane="${name}"]`);
      if (shown) void shown.offsetHeight;
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : tabs.length - 1;
        const next = tabs[(index + step) % tabs.length];
        next.focus();
        showTab(next.dataset.tab);
      });
    });
    showTab('general');

    // Appearance groups: one group of cards at a time. The save note under them stays visible.
    const groupTabs = Array.from(body.querySelectorAll('[data-group-tab]'));
    function showGroup(name) {
      body.querySelectorAll('.ap-group').forEach((group) => { group.hidden = group.dataset.group !== name; });
      groupTabs.forEach((tab) => {
        const on = tab.dataset.groupTab === name;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
      });
      // A shorter group must not leave the scrolling part past its end.
      const scroller = body.querySelector('#look-form');
      if (scroller) scroller.scrollTop = 0;
    }
    groupTabs.forEach((tab, index) => {
      tab.addEventListener('click', () => showGroup(tab.dataset.groupTab));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : groupTabs.length - 1;
        const next = groupTabs[(index + step) % groupTabs.length];
        next.focus();
        showGroup(next.dataset.groupTab);
      });
    });
    showGroup('desktop');

    // Range sliders show their value next to them.
    body.querySelectorAll('input[type="range"]').forEach((input) => {
      const out = body.querySelector(`output[data-out="${input.name}"]`);
      const show = () => { if (out) out.textContent = input.value; };
      input.addEventListener('input', show);
      // The value bumps when it changes, so the slider reads as alive.
      input.addEventListener('input', () => {
        if (!out) return;
        out.classList.remove('bump');
        void out.offsetWidth;
        out.classList.add('bump');
      });
      show();
    });

    // Wallpaper: the current image, with upload and reset.
    // The preview is painted by appearance.js from the same look as the desktop, so it shows the built-in
    // choice, the solid colour, the fit, the dim and the blur as they are.
    function showWallpaper(picture) {
      q('#wallpaper-reset').disabled = !(picture && picture.dataUrl);
      if (window.FishingbotAppearance) window.FishingbotAppearance.renderWallpaper();
    }
    const appearance = window.FishingbotAppearance;
    api.appearanceWallpaper().then((result) => {
      if (result.ok) showWallpaper(result.wallpaper);
    });
    q('#wallpaper-upload').addEventListener('click', async () => {
      say('Choose an image…', 'muted');
      const result = await api.uploadWallpaper();
      if (!result.ok) return say(result.error, 'bad');
      if (result.cancelled) return say('No image chosen. The wallpaper is unchanged.');
      showWallpaper(result.wallpaper);
      appearance.setWallpaper(result.wallpaper && result.wallpaper.dataUrl);
      say('Wallpaper changed.');
    });
    q('#wallpaper-reset').addEventListener('click', async () => {
      const result = await api.resetWallpaper();
      if (!result.ok) return say(result.error, 'bad');
      showWallpaper(null);
      appearance.setWallpaper(null);
      say('Built-in wallpaper restored.');
    });
    // Profile picture: the preview, upload and reset. The taskbar checkbox saves with the look.
    function showProfile(picture) {
      const preview = q('#profile-preview');
      preview.replaceChildren();
      if (picture && picture.dataUrl) {
        const img = document.createElement('img');
        img.src = picture.dataUrl;
        img.alt = '';
        preview.append(img);
      } else {
        preview.append(Object.assign(document.createElement('span'), { textContent: 'F' }));
      }
      q('#profile-reset').disabled = !(picture && picture.dataUrl);
    }
    api.appearanceAvatar().then((result) => {
      if (result.ok) showProfile(result.avatar);
    });
    q('#profile-upload').addEventListener('click', async () => {
      say('Choose a picture…', 'muted');
      const result = await api.uploadAvatar();
      if (!result.ok) return say(result.error, 'bad');
      if (result.cancelled) return say('No picture chosen. The picture is unchanged.');
      showProfile(result.avatar);
      appearance.setAvatar(result.avatar && result.avatar.dataUrl);
      say('Profile picture changed.');
    });
    q('#profile-reset').addEventListener('click', async () => {
      const result = await api.resetAvatar();
      if (!result.ok) return say(result.error, 'bad');
      showProfile(null);
      appearance.setAvatar(null);
      say('The letter is back.');
    });

    // Appearance saves as the user changes it. Each save is short-delayed so a slider drag saves once.
    // The Appearance and Widgets tabs are two forms of the same look: both are read on every save.
    const look = q('#look-form');
    const lookForms = [look];
    const collectLook = () => collect(look);
    const syncRanges = () => lookForms.forEach((form) => form.querySelectorAll('input[type="range"]').forEach((input) => input.dispatchEvent(new Event('input'))));
    let saveTimer = null;
    async function saveLook() {
      const result = await api.saveSettings('appearance', collectLook());
      if (!result.ok) return say(result.error, 'bad');
      appearance.apply(result.settings.appearance);
      say(`Saved automatically at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
    }
    function queueSave() {
      say('Saving…', 'muted');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveLook, 350);
    }
    // The wallpaper previews follow each choice at once; the save below makes it the look.
    const previewLook = () => { if (window.FishingbotAppearance) window.FishingbotAppearance.previewWallpaper(collectLook()); };
    // Performance mode: turning it on keeps the current values of the affected settings and applies the preset;
    // turning it back to Custom restores what was kept. The kept values live in a hidden field, so autosave stores them.
    const perfSelect = look.querySelector('select[name="performanceMode"]');
    const customField = look.querySelector('input[name="customLook"]');
    const applyToForms = (values) => {
      lookForms.forEach((form) => fill(form, { appearance: values }));
      syncRanges();
      if (dropdowns) dropdowns.refreshAll(body);
    };
    perfSelect.addEventListener('change', () => {
      if (perfSelect.value === 'performance') {
        const current = collectLook();
        const kept = {};
        for (const key of Object.keys(PERFORMANCE_LOOK)) kept[key] = current[key];
        customField.value = JSON.stringify(kept);
        applyToForms(PERFORMANCE_LOOK);
      } else {
        let kept = {};
        try { kept = JSON.parse(customField.value || '{}') || {}; } catch { kept = {}; }
        applyToForms(kept);
        customField.value = '';
      }
    });
    lookForms.forEach((form) => {
      form.addEventListener('input', queueSave);
      form.addEventListener('input', previewLook);
      form.addEventListener('change', previewLook);
      form.addEventListener('change', queueSave);
    });
    q('#appearance-defaults').addEventListener('click', () => {
      lookForms.forEach((form) => fill(form, { appearance: APPEARANCE_DEFAULTS }));
      syncRanges();
      if (dropdowns) dropdowns.refreshAll(body);
      saveLook();
    });
    q('#reset-icons').addEventListener('click', () => {
      document.dispatchEvent(new Event('fishingbot:reset-icons'));
      say('Icon positions reset.');
    });
    q('#reset-widgets').addEventListener('click', () => {
      document.dispatchEvent(new Event('fishingbot:reset-widgets'));
      say('Widget positions reset.');
    });

    // The Client ID is shown as dots until Show is pressed. The value is saved as typed.
    const reveal = q('#client-reveal');
    const clientId = body.querySelector('input[name="clientId"]');
    reveal.addEventListener('click', () => {
      const shown = clientId.classList.toggle('masked') === false;
      reveal.textContent = shown ? 'Hide' : 'Show';
      reveal.setAttribute('aria-pressed', String(shown));
    });

    // Database backups: the newest copies, and Back up now (the server makes the copy within a minute).
    const backupStatus = q('#backup-status');
    function renderBackups() {
      api.backupList().then((result) => {
        const box = q('#backup-list');
        if (!result.ok) {
          box.replaceChildren();
          return;
        }
        const items = result.items.slice(0, 5);
        if (!items.length) {
          box.replaceChildren(...[]);
          backupStatus.textContent = result.serverOnline ? 'No backups yet.' : 'No backups yet. Start the server to make one.';
          return;
        }
        box.replaceChildren(...items.flatMap((item) => {
          const dt = document.createElement('dt');
          dt.textContent = new Date(item.modified).toLocaleString();
          const dd = document.createElement('dd');
          dd.textContent = `${Math.max(1, Math.round(item.size / 1024)).toLocaleString()} KB`;
          return [dt, dd];
        }));
      });
    }
    q('#backup-now').addEventListener('click', async () => {
      backupStatus.textContent = 'Asking the server…';
      const result = await api.backupNow();
      backupStatus.textContent = result.ok ? 'Backup requested. It appears within a minute.' : result.error;
      backupStatus.className = result.ok ? 'muted' : 'muted bad';
      if (result.ok) setTimeout(renderBackups, 65000);
    });
    renderBackups();
    q('#appearance-undo').addEventListener('click', async () => {
      const result = await api.undoAppearance();
      if (!result.ok) return say(result.error, 'bad');
      lookForms.forEach((form) => fill(form, result.settings));
      syncRanges();
      if (dropdowns) dropdowns.refreshAll(body);
      appearance.apply(result.settings.appearance);
      say('Previous look restored.');
    });

    // Plain settings forms (no password, no action button) save by themselves, shortly after
    // the last change. Appearance has its own autosave above. Forms that need the admin
    // password, or that act on the server (password, pairing code, update source, Twitch
    // credentials), keep their own button.
    let language = null;
    async function saveSection(form) {
      const values = collect(form);
      const result = await api.saveSettings(form.dataset.section, values);
      if (!result.ok) return say(result.error, 'bad');
      say(`Saved automatically at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
      if (form.dataset.section === 'security') {
        document.dispatchEvent(new CustomEvent('fishingbot:security', { detail: result.settings.security }));
      }
      // The language applies across the desktop at once; the desktop script redraws what it made.
      if (form.dataset.section === 'interface' && result.settings.interface.language !== language) {
        language = result.settings.interface.language;
        document.dispatchEvent(new CustomEvent('fishingbot:language', { detail: language }));
      }
    }
    body.querySelectorAll('form[data-section]:not([data-action]):not([data-section="appearance"])').forEach((form) => {
      let timer = null;
      const queue = () => {
        clearTimeout(timer);
        if (!form.checkValidity()) {
          say('Not saved yet: check the value you entered.', 'bad');
          return;
        }
        say('Saving…', 'muted');
        timer = setTimeout(() => saveSection(form).catch((err) => say(err.message, 'bad')), 500);
      };
      form.addEventListener('input', queue);
      form.addEventListener('change', queue);
    });

    body.querySelectorAll('form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = collect(form);
        const action = form.dataset.action;
        let result;

        if (action === 'repo') {
          result = await api.setUpdateRepository({ repository: values.repository, password: values.password });
          if (result.ok) say('Update source saved. The next check uses it.');
        } else if (action === 'password') {
          result = await api.changeAdminPassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
          if (result.ok) {
            form.reset();
            say('Password changed. Twitch Master Admin sessions were revoked.');
          }
        } else if (action === 'pair') {
          result = await api.generatePairingCode({ password: values.password });
          if (result.ok) {
            q('#pair-out').textContent = `Code ${result.code} · expires in ${result.expiresInSeconds} seconds. Enter it in Twitch: Extension, My Account, Master Admin.`;
            form.reset();
            say('Pairing code created.');
          }
        } else if (action === 'twitch') {
          result = await api.saveTwitchConfig({ clientId: values.clientId, clientSecret: values.clientSecret });
          if (result.ok) {
            form.elements.clientSecret.value = '';
            api.twitchConfig().then((data) => {
              if (data.ok) form.elements.clientSecret.placeholder = data.hasSecret ? 'Saved. Leave empty to keep it.' : 'Not set';
            });
            say('Twitch settings saved. The bot uses them on the next start.');
          }
        } else if (form.dataset.section && form.dataset.section !== 'appearance') {
          // Pressing Enter in an autosaving form: save now.
          await saveSection(form);
          return;
        }

        if (result && !result.ok) say(result.error, 'bad');
      });
    });

    // Lock now: the desktop shows its sign-in screen at once.
    q('#lock-now').addEventListener('click', () => document.dispatchEvent(new Event('fishingbot:lock-now')));

    q('#unlink-btn').addEventListener('click', async () => {
      const password = body.querySelector('form[data-action="pair"] input[name="password"]').value;
      if (!password) return say('Enter the admin password in the pairing form first.', 'bad');
      if (!window.confirm('Unlink the Twitch identity and revoke every Extension Master Admin session?')) return;
      const result = await api.unlinkTwitch({ password });
      if (result.ok) say('Twitch Master Admin unlinked. All Extension admin sessions were revoked.');
      else say(result.error, 'bad');
    });

    q('#check-updates').addEventListener('click', async () => {
      q('#update-result').textContent = 'Checking…';
      const result = await api.checkForUpdates();
      q('#update-result').textContent = result.ok ? describeUpdate(result) : result.error;
      q('#update-result').className = 'hint ' + (result.ok ? '' : 'bad');
    });

    function renderQueue() {
      api.queueList().then((result) => {
        const box = q('#queue-list');
        const items = result.ok ? result.items : [];
        if (!items.length) {
          box.textContent = 'Nothing queued.';
          box.className = 'queue-list muted';
          return;
        }
        box.className = 'queue-list';
        box.replaceChildren(...items.map((item) => {
          const row = document.createElement('div');
          row.className = 'queue-row ' + item.status;
          const label = document.createElement('span');
          label.textContent = `${item.kind} · ${new Date(item.createdAt).toLocaleString()}`;
          const state = document.createElement('span');
          state.className = 'queue-state';
          state.textContent = item.status === 'pending'
            ? 'Waiting for the next start'
            : item.status === 'applied' ? 'Applied'
              : item.status === 'superseded' ? 'Combined with a newer save'
              : `Rejected: ${item.error || 'unknown reason'}`;
          row.append(label, state);
          return row;
        }));
      });
    }
    q('#queue-clear').addEventListener('click', async () => {
      await api.queueClear();
      renderQueue();
    });
    renderQueue();

    const twitchForm = body.querySelector('form[data-action="twitch"]');
    api.twitchConfig().then((data) => {
      if (!data.ok) return;
      twitchForm.elements.clientId.value = data.clientId;
      twitchForm.elements.clientSecret.placeholder = data.hasSecret ? 'Saved. Leave empty to keep it.' : 'Not set';
    });

    // Until the saved values arrive, the cards show skeleton loaders instead of empty fields.
    // The extra viewer logins of the Folder app, each with a Remove button.
    function renderFolderViewers(logins) {
      const box = body.querySelector('#folder-viewers');
      if (!box) return;
      if (!logins.length) {
        const empty = document.createElement('li');
        empty.className = 'hint';
        empty.textContent = 'None added. Viewers found in the database are listed in the Folder app anyway.';
        box.replaceChildren(empty);
        return;
      }
      box.replaceChildren(...logins.map((login) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `@${login}`;
        const remove = document.createElement('button');
        remove.className = 'btn';
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove @${login}`);
        remove.addEventListener('click', async () => {
          const reply = await api.saveSettings('folder', { viewers: logins.filter((v) => v !== login) });
          if (reply.ok) renderFolderViewers(reply.settings.folder.viewers);
        });
        li.append(name, remove);
        return li;
      }));
    }

    const app = q('.settings-app');
    app.classList.add('is-loading');
    const loadFailsafe = setTimeout(() => app.classList.remove('is-loading'), 2500);
    api.getSettings()
      .then((data) => {
        language = data.interface && data.interface.language;
        body.querySelectorAll('form[data-section]').forEach((form) => fill(form, data));
        renderFolderViewers(data.folder ? data.folder.viewers : []);
        if (dropdowns) dropdowns.refreshAll(body);
      })
      .then(() => body.querySelectorAll('input[type="range"]').forEach((input) => input.dispatchEvent(new Event('input'))))
      .catch((err) => say(`Could not load settings: ${err.message}`, 'bad'))
      .finally(() => { clearTimeout(loadFailsafe); app.classList.remove('is-loading'); });

    // Start-menu search opens a section directly: the tab, the Appearance group, then the card itself.
    // The card is brought into view and flashed once, so the eye finds it.
    body.__goTo = (tab, group, target) => {
      showTab(tab);
      if (group) showGroup(group);
      const card = target && body.querySelector(target);
      if (!card) return;
      card.scrollIntoView({ block: 'start' });
      card.classList.remove('sm-flash');
      void card.offsetWidth;
      card.classList.add('sm-flash');
      setTimeout(() => card.classList.remove('sm-flash'), 2600);
    };
  };
})();
