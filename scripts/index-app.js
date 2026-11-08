    /* ==================================================================
       ICONS
       Thin wrapper over the sprite at the top of <body>. Returns a
       string so it can be dropped straight into innerHTML, and a node
       builder for the handful of places that need a live element.
       Size is inherited from the parent's font-size, so a rule like
       `.foo { font-size: 1.3rem }` rescales the icon with the text.
       ================================================================== */
    const TIER_ICON = {
      unique: 'void', godly: 'flame', legendary: 'gem', epic: 'shard',
      rare: 'drop', uncommon: 'leaf', common: 'fish', treasury: 'key'
    };

    function icon(name, extraClass) {
      const id = String(name || '').replace(/^i-/, '');
      return `<svg class="ic${extraClass ? ' ' + extraClass : ''}" aria-hidden="true" focusable="false"><use href="#i-${id}"></use></svg>`;
    }

    function iconEl(name, extraClass) {
      const span = document.createElement('span');
      span.innerHTML = icon(name, extraClass);
      return span.firstElementChild;
    }

    /* Escape anything that will land inside a template literal that ends
       up in innerHTML. Tier names and fish names come from the API. */
    function escText(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    /* Status lines are icon + text, so they have to go through innerHTML.
       Every caller passes untrusted fragments (fish names, event names),
       so the text half is always escaped. Assign via .innerHTML, never
       .textContent, or the icon disappears. */
    function statusHTML(iconName, text) {
      return `${icon(iconName)}<span>${escText(text)}</span>`;
    }

    /* ==================================================================
       TOASTS
       The single feedback channel for the whole product.

       Why this exists: the old design wrote every confirmation into one
       fixed element per panel. Buy a perk from the Loot Table tab and the
       confirmation landed in a container on a tab you were not looking
       at, so it read as "nothing happened". Toasts live outside the view
       tree, so a confirmation is impossible to miss no matter where the
       user is when the request resolves.
       ================================================================== */
    const TOAST_META = {
      success: { icon: 'check-ring', label: 'Confirmed' },
      error:   { icon: 'warn',      label: 'Failed' },
      info:    { icon: 'info',      label: 'Notice' }
    };
    const TOAST_TTL = { success: 4200, error: 6500, info: 4000 };
    const MAX_TOASTS = 4;
    let toastSeq = 0;

    function dismissToast(el) {
      if (!el || el.dataset.leaving === '1') return;
      el.dataset.leaving = '1';
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    }

    function toast(message, type = 'info', opts = {}) {
      const region = document.getElementById('toastRegion');
      if (!region) return null;
      const kind = TOAST_META[type] ? type : 'info';
      const meta = TOAST_META[kind];
      const ttl = opts.ttl || TOAST_TTL[kind];
      const id = ++toastSeq;

      const el = document.createElement('div');
      el.className = `toast toast--${kind}`;
      el.dataset.toastId = String(id);
      el.innerHTML = `
        <span class="toast-icon">${icon(meta.icon)}</span>
        <div class="toast-body"><span class="toast-label">${escText(opts.label || meta.label)}</span><span class="toast-msg">${escText(message)}</span></div>
        <button type="button" class="toast-close" aria-label="Dismiss">${icon('x')}</button>
        <span class="toast-drain" style="animation-duration:${ttl}ms"></span>
      `;

      const close = () => dismissToast(el);
      el.querySelector('.toast-close').addEventListener('click', close);
      // Hovering pauses neither the drain nor the timer - a confirmation
      // that vanishes while you are reading it is worse than no toast.
      el.addEventListener('click', (ev) => { if (ev.target.closest('a')) dismissToast(el); });

      region.appendChild(el);
      // requestAnimationFrame so the drain animation actually runs instead
      // of being coalesced with the entry transform.
      requestAnimationFrame(() => el.querySelector('.toast-drain').classList.add('run'));

      // Oldest out first once the stack is full.
      const live = Array.from(region.children).filter(n => n.dataset.leaving !== '1');
      live.slice(0, Math.max(0, live.length - MAX_TOASTS)).forEach(dismissToast);

      setTimeout(close, ttl);
      return el;
    }

    /* Collapse repeats of the same message instead of stacking them. */
    const lastToastByKey = new Map();
    function toastOnce(key, message, type = 'info', opts = {}) {
      const prev = lastToastByKey.get(key);
      if (prev && Date.now() - prev.at < 1200) return null;
      lastToastByKey.set(key, { at: Date.now() });
      return toast(message, type, opts);
    }

    /* ---------- Button busy feedback ----------
       A button that starts a request is disabled and dimmed until the response
       arrives, the same as the Shop's Buy button (runPurchase). This is set up
       once here, so each handler does not need its own code. */
    const busyButtons = new WeakSet();
    let clickedButton = null;
    document.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('button') : null;
      clickedButton = (btn && !btn.disabled) ? btn : null;
      if (clickedButton) setTimeout(() => { clickedButton = null; }, 0);
    }, true);
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const btn = clickedButton;
      clickedButton = null;
      if (!btn || busyButtons.has(btn) || !btn.isConnected) return nativeFetch(input, init);
      const wasDisabled = btn.disabled;
      busyButtons.add(btn);
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
      const done = () => {
        busyButtons.delete(btn);
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        if (btn.isConnected && !wasDisabled) btn.disabled = false;
      };
      return nativeFetch(input, init).finally(done);
    };

    /* ---------- Report a problem and submit an idea ----------
       Both are emailed to the Fishing Hub inbox by /api/report. The screenshot is
       read here, sent once, and not stored anywhere on the site. */
    const FEEDBACK_MAX_PNG_BYTES = 2 * 1024 * 1024;
    const FEEDBACK_TEXT = {
      report: {
        title: 'Report a problem',
        lede: 'Describe what went wrong. The report is emailed to the Fishing Hub team. An optional PNG screenshot is attached to that email only and is not stored on this website.',
        subject: 'Title', description: 'Description', submit: 'Send report', sent: 'Thanks, your report was sent.'
      },
      idea: {
        title: 'Submit an idea',
        lede: 'Tell us what you would like to see. The idea is emailed to the Fishing Hub team. An optional PNG sketch or screenshot is attached to that email only and is not stored on this website.',
        subject: 'Title', description: 'Your idea', submit: 'Send idea', sent: 'Thanks, your idea was sent.'
      }
    };
    function openFeedbackModal(kind) {
      const k = FEEDBACK_TEXT[kind] ? kind : 'report';
      const t = FEEDBACK_TEXT[k];
      document.getElementById('feedbackKind').value = k;
      document.getElementById('feedbackTitle').textContent = t.title;
      document.getElementById('feedbackLede').textContent = t.lede;
      document.getElementById('feedbackSubjectLabel').textContent = t.subject;
      document.getElementById('feedbackDescriptionLabel').textContent = t.description;
      document.getElementById('feedbackSubmit').textContent = t.submit;
      const sender = document.getElementById('feedbackSender');
      if (sender) sender.textContent = currentFishdexLogin
        ? `Sent as ${currentFishdexLogin} unless you tick "Send anonymously".`
        : 'You are not logged in, so it is sent without a name.';
      document.getElementById('feedbackModal')?.classList.add('active');
      document.getElementById('feedbackSubject')?.focus();
    }
    function closeFeedbackModal() {
      document.getElementById('feedbackModal')?.classList.remove('active');
    }
    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('The screenshot could not be read.'));
        reader.readAsDataURL(file);
      });
    }
    async function submitFeedback(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const kind = document.getElementById('feedbackKind').value === 'idea' ? 'idea' : 'report';
      const t = FEEDBACK_TEXT[kind];
      const label = kind === 'idea' ? 'Idea' : 'Report';
      const submitBtn = document.getElementById('feedbackSubmit');
      const title = document.getElementById('feedbackSubject').value.trim();
      const description = document.getElementById('feedbackDescription').value.trim();
      const anonymous = document.getElementById('feedbackAnonymous').checked;
      const file = document.getElementById('feedbackPng').files[0] || null;
      if (!title || !description) {
        toast('Enter a title and a description.', 'error', { label });
        return;
      }
      if (file && (file.type !== 'image/png' || file.size > FEEDBACK_MAX_PNG_BYTES)) {
        toast('The screenshot must be a PNG file up to 2 MB.', 'error', { label });
        return;
      }
      if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.add('is-busy'); }
      try {
        const png = file ? await readFileAsDataUrl(file) : null;
        const res = await fetch('/api/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, title, description, anonymous, png })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'It could not be sent.');
        form.reset();
        closeFeedbackModal();
        toast(data.message || t.sent, 'success', { label: `${label} sent` });
      } catch (error) {
        toast(error.message || 'It could not be sent.', 'error', { label });
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.classList.remove('is-busy'); }
      }
    }
    // Footer links such as /?feedback=idea open the form when the homepage loads.
    (function openFeedbackFromLink() {
      const url = new URL(location.href);
      const kind = url.searchParams.get('feedback');
      if (kind !== 'report' && kind !== 'idea') return;
      url.searchParams.delete('feedback');
      history.replaceState({}, document.title, url.pathname + (url.search || '') + url.hash);
      setTimeout(() => openFeedbackModal(kind), 0);
    })();

    let baseTiers = [];
    let cachedLeaderboardData = null;
    const LEADERBOARD_PAGE_SIZE = 25;
    const MAIL_PAGE_SIZE = 25;
    // One shared page for the currently selected leaderboard section.
    // Keeping a single pager avoids duplicate controls and makes page 2 mean
    // page 2 of whichever leaderboard tab is currently visible.
    let leaderboardPage = 1;
    // The "rares" list shown/expanded in the UI is filtered and re-sorted by
    // Fish Index % for display (see renderLeaderboards). refreshVaultGrid and
    // renderBestCatchShowcase are called with that display index afterwards,
    // so they must look entries up from this same filtered+sorted list -
    // NOT from cachedLeaderboardData.rares, which is in the backend's own
    // (different) order and would hand back the wrong user's inventory.
    let lastRenderedRares = [];
    const userVaultState = {};
    const openAccordions = new Set();
    let isAdminLoggedIn = false;
    let authToken = null;
    let adminSessionUser = null;
    let loadedAdminInventoryItems = [];
    let adminVaultFilterTab = 'all';
    let eventCountdownTimer = null;
    let eventExpiresAtMs = null;
    let cachedFishdexData = null;

    const defaultTiersConfig = [
      { id: 'unique', name: 'SECRET', basePct: 0.00, items: ['Webcamfish', 'conquerorfish', 'RAGEfish', 'Betatestfish'] },
      { id: 'godly', name: 'GODLY', basePct: 0.01, items: ['Vipfish (gives VIP role)', 'Cthulu (choose to end stream or not)', 'Starfish King', 'Moonfish', 'Cosmic Jellyfish', 'The Ancient Leviathan'] },
      { id: 'legendary', name: 'LEGENDARY', basePct: 0.50, items: ['1.5x Luck (permanent)', 'Raidfish (control the raid)', 'Squidink (run ad break)', 'Salesmanfish (free channel point redeem)', 'Badmapfish (free skip bad map)', 'GRANDPA?? (10s chat slowmode for 5m)', 'Golden Fish', 'Crystal Fish', 'Rainbow Fish', 'Ghost Fish', 'Lava Fish', 'Ice Fish'] },
      { id: 'epic', name: 'EPIC', basePct: 1.00, items: ['Timesomeoneoutfor1minutefish', '240kfish (plays nick raid song)', 'Shieldfish (protect from next timeout)', 'Freesongrequestfish', '2x Luck (Lasts 10 minutes)', 'Great White Shark', 'Hammerhead Shark', 'Tiger Shark', 'Manta Ray', 'Giant Squid', 'Nautilus', 'Horseshoe Crab', 'Lobster', 'Giant Crab', 'Blue Lobster', 'Vampire Squid', 'Whale Shark', 'Oarfish', 'Coelacanth', 'Deep-Sea Dragonfish', 'Goblin Shark', 'Sawfish', 'Electric Ray', 'Sea Turtle'] },
      { id: 'rare', name: 'RARE', basePct: 5.00, items: ['kendricklamaar', 'dogwithdacoolglasses', 'duckwithflowerhat', 'cockfish', 'peekayfish', 'trackmaniacar', 'slashedfish', 'intaxfish', 'biblo', 'joel', 'scatterrfish', 'shark', 'Aethfish', 'ibrafish', 'creavesfish (smelly creaves)', 'anglerfish', 'deepseadiver', 'ninjafish', 'goldfish', 'titanic', 'giantoceanicmantaray', 'walterwhite', '240nickscarbonnet', 'thebloop', 'Arctic Char', 'Tiger Trout', 'Koi', 'Electric Eel', 'Pufferfish', 'Lionfish', 'Angelfish', 'Triggerfish', 'Butterflyfish', 'Parrotfish', 'Swordfish', 'Tuna'] },
      { id: 'uncommon', name: 'UNCOMMON', basePct: 25.00, items: ['Barracuda', 'Grouper', 'Snapper', 'Moray Eel', 'Flying Fish', 'Lanternfish', 'Needlefish', 'Stingray', 'Octopus', 'bass', 'trout', 'boot', 'shrimp', 'pollock', 'schmish', 'bottleofjoe', 'duck', 'duckling', 'nemo', 'clownfish', 'tropicalfish', 'catfish', 'dogfish', 'fischfish', 'yabbfish', 'mackerel', 'roosterfish', 'copper', 'axolotl', 'salmon', 'robertlogia', 'frog', 'deutschlandfish', 'squid', 'neofish', 'oldertimer', 'petahfihh', 'tntfish'] },
      { id: 'common', name: 'COMMON', basePct: 68.49, isCommon: true, items: ['baldcap', 'weave', 'toupe', 'seaweed', 'weed', 'jellyfish', 'hook', 'seahorse', 'humanfoot', 'deadrat', 'aliverat', 'greggssausageroll', 'trash', 'tasselledwobbegong', 'redlippedbatfish', 'aspenfish', 'tylersmayhem', 'Bluegill', 'Smallmouth Bass', 'Largemouth Bass', 'Common Carp', 'Minnow', 'Perch', 'Roach', 'Sardine', 'Anchovy', 'Herring', 'Cod', 'Haddock', 'Flounder', 'Mullet', 'Smelt', 'Pike', 'Walleye', 'Sunfish', 'Crappie', 'Eel'] },
      { id: 'treasury', name: 'TREASURY', basePct: 2.00, luckImmune: true, items: ['Seamine (10min timeout)', 'Soggyboot (self-timeout 5m)', 'Rusty Boot', 'Old Fishing Rod', 'Lost Wallet', 'Glass Bottle', 'Message in a Bottle', 'Pirate Coin', 'Silver Coin', 'Gold Coin', 'Ancient Coin', 'Pearl', 'Black Pearl', 'Emerald', 'Ruby', 'Sapphire', 'Golden Ring', 'Ancient Crown', 'Pirate Compass', 'Treasure Map', "Ship's Anchor", 'Golden Anchor', 'gold', 'silver', 'bronze'] }
    ];

    function handleAdminAction() {
      if (isAdminLoggedIn) {
        handleAdminLogout();
      } else {
        document.getElementById('adminLoginModal').classList.add('active');
      }
    }

    function closeAdminModal() {
      document.getElementById('adminLoginModal').classList.remove('active');
      document.getElementById('loginError').style.display = 'none';
      document.getElementById('adminLoginForm').reset();
    }

    /* ---------- Interactive Guide / first-run tutorial ------------------- */
    const GUIDE_ENTRIES = [
      ['getting-started','Getting Started','fish','Start with !fish. Catch 25 fish to unlock Treasury Fishing, then get your first Area to Level 3 for the Auto-Fishing License.','!fish 25 catches Area Level 3 auto-fishing'],
      ['shop','Shop','store','The Shop uses Treasury for Normal Perks, Fishing Gear and Pond Perks once the Pond is unlocked. You do not need to buy everything at once.','treasury perks rods bait pond'],
      ['areas','Areas','globe','Areas are a core progression path. Level them up to unlock more of the game. Your first important milestone is Area Level 3.','area level progression unlock'],
      ['autofish','Auto-Fishing','automation','Area Level 3 unlocks the Auto-Fishing License. After that, configure Auto-Fishing and make sure it is enabled before expecting it to run.','auto fish license enabled'],
      ['index','Fishdex','grid','The Fishdex tracks the fish you have discovered. New species are a major part of collection progress and can feed into other bonuses.','fishdex collection discovered fish'],
      ['perks','Perks','sparkle','Perks improve different parts of fishing. They are progression choices, so pick the ones that match what you are trying to do next.','perks upgrades luck cooldown'],
      ['gear','Fishing Gear','anchor','Rods and bait change how you fish. Check their descriptions and active effects when you are deciding what to equip.','rod bait gear fishing'],
      ['pond','Pond','fish','The Pond is a separate collection system with its own fish, hauls, upgrades and Pond Perks. It unlocks later as you progress.','pond collection haul upgrades'],
      ['luck','Luck','clover','Luck affects the rarity side of a fishing roll. Different bonuses can contribute to Luck, including perks, gear and player bonuses. VIP/Sub/Mod can provide a 1.5× multiplier alongside other applicable Luck bonuses.','luck rarity vip sub mod multiplier'],
      ['weight','Fish Weight','layers','Fish Weight is different from Luck. After the rarity side of the roll, weight helps decide which individual fish is selected. Selected fish and upgrades can change weight.','weight odds selected fish'],
      ['events','Events','sparkle','Events are temporary changes that can affect fishing, including odds, Luck or other mechanics. Check the active event before you fish when one is running.','events temporary odds'],
      ['treasury','Treasury','coin-stack','Treasury is the main progression currency used throughout the Shop. Spend it on upgrades that support your current goal rather than trying to buy everything immediately.','treasury currency shop'],
      ['achievements','Achievements','trophy','Achievements track longer-term milestones and give you another way to see what you have accomplished.','achievements milestones'],
      ['customisations','Customisations','sliders','Customisations let you adjust available personal presentation options without changing the core fishing progression.','settings customisation'],
      ['trading','Trading & Mail','gift','Trading and Mail are used for player-to-player interactions when those features are available to your account.','trading gifts mail'],
    ];

    function renderGuideReference(query = '') {
      const host = document.getElementById('guideReferenceList');
      if (!host) return;
      const q = String(query || '').trim().toLowerCase();
      const entries = GUIDE_ENTRIES.filter(([,title,,body,tags]) => !q || `${title} ${body} ${tags}`.toLowerCase().includes(q));
      const count = document.getElementById('guideResultCount');
      if (count) count.textContent = `${entries.length} ${entries.length === 1 ? 'FEATURE' : 'FEATURES'}`;
      host.innerHTML = entries.length ? entries.map(([id,title,iconName,body]) => `
        <article class="guide-ref-item" data-guide-entry="${escText(id)}">
          <div class="guide-ref-head"><span class="guide-ref-icon">${icon(iconName)}</span><h3>${escText(title)}</h3></div>
          <p>${escText(body).replace(/(!fish|1\.5×|Area Level 3)/g, '<strong>$1</strong>')}</p>
        </article>`).join('') : '<div class="guide-ref-empty">No Guide entry matches that search. Try a feature name such as <strong>Shop</strong>, <strong>Luck</strong>, <strong>Pond</strong> or <strong>Auto-Fishing</strong>.</div>';
    }

    function openGuideModal() {
      const modal = document.getElementById('guideModal');
      if (!modal) return;
      modal.classList.add('active');
      const input = document.getElementById('guideSearchInput');
      if (input) { input.value = ''; renderGuideReference(); setTimeout(() => input.focus(), 0); }
    }
    function closeGuideModal() { document.getElementById('guideModal')?.classList.remove('active'); }

    let tutorialHintEl = null;
    let tutorialStepCueEl = null;
    let tutorialTargetNoteEl = null;
    let tutorialHintTarget = null;
    let tutorialHintKey = null;
    let tutorialHintTimer = null;
    let tutorialLivePollTimer = null;
    let tutorialAreaPollTimer = null;
    let tutorialTreasuryPollTimer = null;
    let tutorialFlowActive = false;
    let tutorialReplayActive = false;
    let tutorialCurrentProgressTarget = 0;
    let tutorialDragState = null;
    let tutorialStateLogin = null;

    function tutorialStateKey(login) {
      return `fishyTutorialState:${String(login || '').toLowerCase()}`;
    }
    function readTutorialState(login) {
      try {
        const raw = localStorage.getItem(tutorialStateKey(login));
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) { return {}; }
    }
    // Writes are skipped when nothing changed. The tutorial re-saves state on
    // every poll and step change, and an unchanged write was still a
    // serialise plus a localStorage round-trip on the hot path.
    window.__tutorialStateWriteCache = window.__tutorialStateWriteCache || new Map();
    function writeTutorialState(login, state) {
      const key = tutorialStateKey(login);
      let serialized = '';
      try { serialized = JSON.stringify(state || {}); } catch (e) { return; }
      if (window.__tutorialStateWriteCache.get(key) === serialized) return;
      try {
        localStorage.setItem(key, serialized);
        window.__tutorialStateWriteCache.set(key, serialized);
      } catch (e) { console.warn('[scripts/index-app.js:252] ignored error:', e?.message || e); }
    }
    const TUTORIAL_STATE_VERSION = 10;

    function updateTutorialProgressUI(caught = Number(cachedFishdexData?.totalCaught || 0)) {
      const current = Math.max(0, Number(caught) || 0);
      const target = 25;
      const pct = Math.min(100, (current / target) * 100);
      if (tutorialHintEl && tutorialCurrentKey() === 'progress') {
        updateTutorialHintContent(
          'Your first milestone is 25 catches. Use !fish in chat. This progress updates live while you fish.',
          {
            kicker:'FIRST GOAL',
            dismiss:'Catch 25 fish, then continue here',
            scroll:false,
            progress:{ target:25, current, label:'CATCH 25 FISH', copy: current >= 25 ? 'Goal complete. Continue to the next step.' : `${25 - Math.min(current,25)} more catch${25 - Math.min(current,25) === 1 ? '' : 'es'} to go` }
          }
        );
      }
    }

    function clearTutorialHint() {
      tutorialDragState = null;
      if (tutorialHintTimer) clearTimeout(tutorialHintTimer);
      tutorialHintTimer = null;
      tutorialHintTarget?.classList.remove('tutorial-target');
      tutorialHintTarget = null;
      tutorialHintKey = null;
      document.getElementById('guideTopBtn')?.classList.remove('tutorial-target');
      if (tutorialHintEl?._tutorialCleanupTargetClick) tutorialHintEl._tutorialCleanupTargetClick();
      if (tutorialHintEl?._tutorialCleanup) tutorialHintEl._tutorialCleanup();
      tutorialHintEl?.remove();
      tutorialHintEl = null;
      tutorialStepCueEl?.remove();
      tutorialStepCueEl = null;
      tutorialTargetNoteEl?.remove();
      tutorialTargetNoteEl = null;
      document.querySelectorAll('.tutorial-sidebar-label').forEach((node) => node.remove());
      tutorialPlacementFn = null;
      tutorialCurrentProgressTarget = 0;
      document.body.classList.remove('tutorial-flow-active');
    }

    function tutorialHubForTarget(targetKey) {
      if (targetKey === 'treasury-only') return 'perks';
      if (targetKey === 'first-area') return 'areas';
      if (targetKey === 'autofish-license' || targetKey === 'autofish-final' || targetKey === 'autofish') return 'autofish';
      return null;
    }

    function syncTutorialSidebarLabel(targetKey) {
      document.querySelectorAll('.tutorial-sidebar-label').forEach((node) => node.remove());
      const hub = tutorialHubForTarget(targetKey);
      if (!hub) return;
      const nav = document.querySelector(`.hub-sidebar .hub-nav-btn[data-hub="${CSS.escape(hub)}"]`);
      if (!nav) return;
      const label = document.createElement('span');
      label.className = 'tutorial-sidebar-label';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = 'TUTORIAL';
      nav.appendChild(label);
    }

    function tutorialProgressMarkup(progress) {
      if (!progress) return '';
      const target = Math.max(1, Number(progress.target || 1));
      const current = Math.max(0, Math.min(target, Number(progress.current ?? 0) || 0));
      const pct = Math.min(100, (current / target) * 100);
      const label = progress.label || 'TASK PROGRESS';
      const suffix = progress.isArea ? 'is-area' : '';
      const copy = progress.copy || (current >= target ? 'Goal complete. Continue to the next step.' : `${target - current} more step${target - current === 1 ? '' : 's'} to go`);
      return `
        <div class="tutorial-task-progress" aria-label="${escText(label)}">
          <div class="tutorial-task-progress-head"><span>${escText(label)}</span><strong data-tutorial-progress-count>${current} / ${target}</strong></div>
          <div class="tutorial-task-progress-track"><div class="tutorial-task-progress-fill ${suffix}" data-tutorial-progress-fill style="width:${pct}%"></div></div>
          <div class="tutorial-task-progress-copy" data-tutorial-progress-copy>${escText(copy)}</div>
        </div>`;
    }

    function bindTutorialHintAction(options) {
      const actionBtn = tutorialHintEl?.querySelector('[data-tutorial-action]');
      if (!actionBtn) return;
      actionBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (actionBtn.disabled) return;
        if (typeof options?.action?.onClick === 'function') options.action.onClick();
      };
    }

    function updateTutorialHintContent(text, options = {}) {
      if (!tutorialHintEl) return false;
      const wasCollapsed = tutorialHintEl.classList.contains('collapsed');
      const body = tutorialHintEl.querySelector('.tutorial-hint-body');
      const kicker = tutorialHintEl.querySelector('.tutorial-hint-kicker');
      if (kicker) kicker.textContent = options.kicker || 'NEXT STEP';
      const progress = options.progress ? tutorialProgressMarkup(options.progress) : '';
      const actionMarkup = options.action
        ? `<button type="button" class="tutorial-hint-action" data-tutorial-action ${options.action.disabled ? 'disabled' : ''}>${escText(options.action.label || 'DONE')}</button>${options.action.status ? `<div class="tutorial-hint-status" data-tutorial-action-status>${escText(options.action.status)}</div>` : ''}`
        : '';
      const sig = JSON.stringify([
        text,
        options.dismiss || '',
        options.progress || null,
        options.action ? [options.action.label || '', !!options.action.disabled, options.action.status || ''] : null
      ]);
      const unchanged = tutorialHintEl._tutorialSig === sig;
      tutorialHintEl._tutorialSig = sig;
      if (body && !unchanged) {
        body.innerHTML = `<div class="tutorial-hint-text">${escText(text)}</div>${progress}${options.dismiss ? `<div class="tutorial-hint-dismiss">${escText(options.dismiss)}</div>` : ''}${actionMarkup}`;
      }
      bindTutorialHintAction(options);
      tutorialCurrentProgressTarget = options.progress ? Number(options.progress.target || 0) : 0;
      if (!unchanged && tutorialHintTarget) syncTutorialSidebarLabel(tutorialCurrentKey());
      tutorialHintEl.classList.toggle('collapsed', wasCollapsed && options.startCollapsed !== false);
      if (!unchanged) requestAnimationFrame(() => { if (tutorialHintEl) scheduleTutorialPlacement(); });
      return true;
    }

    function rebindTutorialHintTarget(targetKey, shouldScroll = false) {
      if (!tutorialHintEl) return false;
      tutorialHintKey = targetKey;
      tutorialSyncHighlight(targetKey);
      if (shouldScroll && tutorialHintTarget) scrollTutorialTarget(tutorialHintTarget);
      scheduleTutorialPlacement();
      return !!tutorialHintTarget;
    }

    let tutorialPlacementFn = null;
    function scheduleTutorialPlacement() {
      if (typeof tutorialPlacementFn === 'function') tutorialPlacementFn();
    }

    // The step the tutorial is on. Reads the key, not the node, so a step
    // still knows what it is even when its control is not on screen yet.
    function tutorialCurrentKey() {
      return tutorialHintKey || '';
    }

    function scrollTutorialTarget(el, behavior = 'smooth') {
      if (!el) return;
      const mobile = window.matchMedia?.('(max-width: 760px)').matches;
      el.scrollIntoView({
        behavior,
        block: mobile ? 'start' : 'center',
        inline: 'nearest'
      });
    }

    function tutorialTargetInView(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    }

    // Re-attaches the highlight to the live node for this step. Panels rebuild
    // their markup on refresh, which detaches the node the tutorial held, so
    // this looks the control up again by its guide key. Returns true when the
    // highlighted node changed.
    function tutorialSyncHighlight(targetKey = tutorialCurrentKey()) {
      if (!tutorialHintEl || !targetKey) return false;
      const live = document.querySelector(`[data-guide-target="${CSS.escape(targetKey)}"]`);
      if (!live) return false;
      if (live === tutorialHintTarget) {
        if (!live.classList.contains('tutorial-target')) live.classList.add('tutorial-target');
        return false;
      }
      tutorialHintTarget?.classList.remove('tutorial-target');
      tutorialHintTarget = live;
      tutorialHintKey = targetKey;
      live.classList.add('tutorial-target');
      syncTutorialSidebarLabel(targetKey);
      return true;
    }

    // Called by panels right after they render, so a control that appears
    // (or is rebuilt) during an active step is highlighted immediately.
    function tutorialAfterRender() {
      if (!tutorialFlowActive || !tutorialHintEl) return;
      if (tutorialSyncHighlight()) scheduleTutorialPlacement();
    }

    // Where the task card points: the highlighted control when it is on
    // screen, otherwise the hub tab that owns it, otherwise Profile.
    function tutorialAnchorElement() {
      const live = tutorialHintTarget;
      if (live && live.isConnected && live.getBoundingClientRect().width > 0) return live;
      const key = tutorialCurrentKey();
      const hub = tutorialHubForTarget(key) || key;
      const navBtn = hub ? document.querySelector(`.hub-sidebar .hub-nav-btn[data-hub="${CSS.escape(hub)}"]`) : null;
      if (navBtn && navBtn.getBoundingClientRect().width > 0) return navBtn;
      return document.getElementById('fishdexTabBtn');
    }

    function showTutorialHint(targetKey, text, options = {}) {
      const existingTargetKey = tutorialCurrentKey() || '';
      if (tutorialHintEl && existingTargetKey === targetKey) {
        updateTutorialHintContent(text, options);
        const changed = tutorialSyncHighlight(targetKey);
        // Scroll only when the control is new or off screen, so a refresh of
        // the same step never yanks the page.
        if (options.scroll !== false && tutorialHintTarget && (changed || !tutorialTargetInView(tutorialHintTarget))) {
          scrollTutorialTarget(tutorialHintTarget);
        }
        return true;
      }

      clearTutorialHint();
      tutorialHintKey = targetKey;
      // A control that is not rendered yet no longer blocks the step. The
      // instructions still show, anchored to the owning hub tab, and the
      // highlight attaches as soon as the panel renders (tutorialAfterRender).
      const target = document.querySelector(`[data-guide-target="${CSS.escape(targetKey)}"]`);
      tutorialHintTarget = target || null;
      if (target) target.classList.add('tutorial-target');
      syncTutorialSidebarLabel(targetKey);
      document.body.classList.add('tutorial-flow-active');
      if (target && options.scroll !== false) scrollTutorialTarget(target);
      tutorialCurrentProgressTarget = options.progress ? Number(options.progress.target || 0) : 0;

      const el = document.createElement('div');
      el.className = 'tutorial-hint';
      el.innerHTML = `<div class="tutorial-hint-head" data-tutorial-drag-handle><div class="tutorial-hint-kicker">${escText(options.kicker || 'NEXT STEP')}</div><button type="button" class="tutorial-hint-collapse" data-tutorial-collapse aria-label="Expand tutorial task" title="Expand tutorial task"><svg class="ic" aria-hidden="true"><use href="#i-plus"></use></svg></button></div><div class="tutorial-hint-body"></div>`;
      document.body.appendChild(el);
      tutorialHintEl = el;

      const cue = document.createElement('div');
      cue.className = 'tutorial-step-cue';
      cue.setAttribute('aria-hidden', 'true');
      cue.textContent = 'TUTORIAL';
      document.body.appendChild(cue);
      tutorialStepCueEl = cue;

      const collapseBtn = el.querySelector('[data-tutorial-collapse]');
      const setTutorialTaskCollapsed = (collapsed) => {
        el.classList.toggle('collapsed', collapsed);
        collapseBtn?.setAttribute('aria-label', collapsed ? 'Expand tutorial task' : 'Collapse tutorial task');
        collapseBtn?.setAttribute('title', collapsed ? 'Expand tutorial task' : 'Collapse tutorial task');
        const iconUse = collapseBtn?.querySelector('use');
        if (iconUse) iconUse.setAttribute('href', collapsed ? '#i-plus' : '#i-minus');
      };
      collapseBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setTutorialTaskCollapsed(!el.classList.contains('collapsed'));
        requestAnimationFrame(() => scheduleTutorialPlacement());
      });

      let placeRaf = 0;
      const clampTaskPosition = () => {
        const width = el.offsetWidth || 350;
        const height = el.offsetHeight || 160;
        const maxLeft = Math.max(8, window.innerWidth - width - 8);
        const maxTop = Math.max(8, window.innerHeight - height - 8);
        let left = parseFloat(el.style.left);
        let top = parseFloat(el.style.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
        left = Math.min(Math.max(8, left), maxLeft);
        top = Math.min(Math.max(8, top), maxTop);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        return true;
      };
      const place = () => {
        placeRaf = 0;
        if (!tutorialHintEl) return;
        const anchor = tutorialAnchorElement();
        const rect = anchor
          ? anchor.getBoundingClientRect()
          : { left: window.innerWidth / 2 - 175, top: window.innerHeight - 260, bottom: window.innerHeight - 240, right: window.innerWidth / 2 + 175, width: 0, height: 0 };
        const width = el.offsetWidth || 350;
        const height = el.offsetHeight || 160;
        // A newly-created tutorial task always anchors itself to the active
        // control. We deliberately do not restore an old localStorage x/y so
        // the popup cannot resurrect in the top-left corner on later steps.
        if (!tutorialDragState && !el.dataset.userPositioned) {
          const left = Math.min(Math.max(10, rect.left), Math.max(10, window.innerWidth - width - 10));
          const gap = 14;
          const below = rect.bottom + gap;
          const top = below + height < window.innerHeight - 8 ? below : Math.max(8, rect.top - height - gap);
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
        } else if (el.dataset.userPositioned) {
          clampTaskPosition();
        }
        el.classList.add('active');

        if (tutorialStepCueEl) {
          const cueWidth = tutorialStepCueEl.offsetWidth || 118;
          const cueHeight = tutorialStepCueEl.offsetHeight || 26;
          const cueAnchor = document.getElementById('fishdexTabBtn');
          if (!cueAnchor) {
            tutorialStepCueEl.classList.add('is-hidden');
          } else {
            const cueRect = cueAnchor.getBoundingClientRect();
            const inView = cueRect.bottom > 0 && cueRect.top < window.innerHeight && cueRect.right > 0 && cueRect.left < window.innerWidth;
            if (!inView) {
              tutorialStepCueEl.classList.add('is-hidden');
            } else {
              const cueLeft = Math.min(Math.max(8, cueRect.left + ((cueRect.width - cueWidth) / 2)), window.innerWidth - cueWidth - 8);
              const tutorialProfileGapPx = 3;
              const aboveTop = cueRect.top - cueHeight - tutorialProfileGapPx;
              const cueTop = aboveTop >= 8 ? aboveTop : Math.min(Math.max(8, cueRect.bottom + 3), window.innerHeight - cueHeight - 8);
              tutorialStepCueEl.style.left = `${cueLeft}px`;
              tutorialStepCueEl.style.top = `${cueTop}px`;
              tutorialStepCueEl.classList.remove('is-hidden');
              tutorialStepCueEl.classList.add('active');
            }
          }
        }
      };
      const placementFn = () => { if (!placeRaf) placeRaf = requestAnimationFrame(place); };
      tutorialPlacementFn = placementFn;
      // Capture phase: panels scroll inside their own containers, and those
      // scroll events never reach window. Capture sees every one of them.
      window.addEventListener('scroll', placementFn, { passive:true, capture:true });
      window.addEventListener('resize', placementFn);
      el._tutorialCleanup = () => {
        window.removeEventListener('scroll', placementFn, true);
        window.removeEventListener('resize', placementFn);
        if (tutorialPlacementFn === placementFn) tutorialPlacementFn = null;
        tutorialDragState = null;
      };

      // Drag the task from anywhere on its surface. The dragged position lives
      // only for the current task, while changing steps re-anchors automatically.
      el.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        if (event.target.closest('button, input, select, textarea, a')) return;
        const rect = el.getBoundingClientRect();
        tutorialDragState = { pointerId:event.pointerId, offsetX:event.clientX - rect.left, offsetY:event.clientY - rect.top };
        el.dataset.userPositioned = '1';
        el.classList.add('dragging');
        try { el.setPointerCapture(event.pointerId); } catch (e) {}
        event.preventDefault();
      });
      el.addEventListener('pointermove', (event) => {
        if (!tutorialDragState || tutorialDragState.pointerId !== event.pointerId) return;
        el.style.left = `${event.clientX - tutorialDragState.offsetX}px`;
        el.style.top = `${event.clientY - tutorialDragState.offsetY}px`;
        clampTaskPosition();
        event.preventDefault();
      });
      const endDrag = (event) => {
        if (!tutorialDragState || tutorialDragState.pointerId !== event.pointerId) return;
        clampTaskPosition();
        tutorialDragState = null;
        el.classList.remove('dragging');
        try { el.releasePointerCapture(event.pointerId); } catch (e) {}
      };
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);

      updateTutorialHintContent(text, options);
      requestAnimationFrame(place);
      setTimeout(place, 250);
      return true;
    }

    function tutorialState(login) {
      const state = readTutorialState(login);
      if (Number(state.version || 0) !== TUTORIAL_STATE_VERSION) {
        state.version = TUTORIAL_STATE_VERSION;
        // v9 could save an unusable top-left task position. Start v10 cleanly
        // and let the active target determine the popup's position.
        delete state.taskPosition;
      }
      if (!state.tutorialStage) state.tutorialStage = 'catches';
      writeTutorialState(login, state);
      return state;
    }

    // Self-scheduling loops instead of fixed setInterval timers. A loop never
    // overlaps itself, so a slow network cannot stack requests, and it only
    // polls quickly while its step is on screen.
    const tutorialPollers = {
      progress: { timer: null, gen: 0 },
      area: { timer: null, gen: 0 },
      treasury: { timer: null, gen: 0 }
    };
    function stopTutorialLivePolling() {
      Object.values(tutorialPollers).forEach((p) => { p.gen++; if (p.timer) clearTimeout(p.timer); p.timer = null; });
    }
    function startTutorialPoller(name, run, delayFor) {
      const p = tutorialPollers[name];
      if (p.timer) clearTimeout(p.timer);
      p.gen++;
      const gen = p.gen;
      const tick = async () => {
        p.timer = null;
        if (gen !== p.gen || !tutorialFlowActive) return;
        if (!document.hidden) { try { await run(); } catch (e) { console.warn('[scripts/index-app.js:665] ignored error:', e?.message || e); } }
        if (gen === p.gen && tutorialFlowActive) p.timer = setTimeout(tick, delayFor());
      };
      p.timer = setTimeout(tick, 0);
    }

    function markTutorialCompleted(reason = 'done') {
      if (!tutorialFlowActive) return;
      const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
      if (!login) return;
      const state = tutorialState(login);
      state.version = TUTORIAL_STATE_VERSION;
      state.tutorialStarted = true;
      state.tutorialCompleted = true;
      state.tutorialMode = 'guided';
      state.tutorialStage = 'complete';
      state.completionReason = reason;
      state.treasuryTutorialDone = true;
      writeTutorialState(login, state);
      tutorialFlowActive = false;
      clearTutorialHint();
      stopTutorialLivePolling();
      toast('Tutorial complete. Open the Guide any time for more info.', 'success', { label: 'Tutorial complete' });
      updateTutorialTopButton();
    }

    let tutorialRewardInFlight = false;
    async function claimTutorialRewardAndFinish() {
      if (tutorialRewardInFlight) return;
      tutorialRewardInFlight = true;
      const btn = tutorialHintEl?.querySelector('[data-tutorial-action]');
      if (btn) { btn.disabled = true; btn.textContent = 'CLAIMING…'; }
      try {
        const res = await fetch('/api/progression', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'claim-tutorial-reward' }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || 'Could not claim the reward.');
        markTutorialCompleted('final-done');
        if (!data.alreadyClaimed && data.items?.length) {
          toast(`Reward claimed: ${data.items.length} Treasury items (${data.items.join(', ')}).`, 'success', { label: 'Tutorial reward' });
          try { await loadPerksStatus(); } catch (e) { console.warn('[scripts/index-app.js:705] ignored error:', e?.message || e); }
        }
      } catch (err) {
        // Keep the final step open so the reward is never lost; DONE can be retried.
        toast(err.message || 'Could not claim the reward. Try DONE again.', 'error', { label: 'Tutorial reward' });
        const again = tutorialHintEl?.querySelector('[data-tutorial-action]');
        if (again) { again.disabled = false; again.textContent = 'DONE'; }
      } finally {
        tutorialRewardInFlight = false;
      }
    }

    function showTutorialFinalStep() {
      if (!tutorialFlowActive || !currentFishdexLogin) return;
      if (!document.getElementById('hubPanel-autofish')?.classList.contains('active')) switchHubTab('autofish');
      const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
      if (login) {
        const state = tutorialState(login);
        if (state.tutorialStage === 'complete-pending' && tutorialCurrentKey() === 'autofish-final') return;
        state.tutorialStage = 'complete-pending';
        writeTutorialState(login, state);
      }
      const replayAlreadyRewarded = tutorialReplayActive || guideRewardClaimed(login);
      const shown = showTutorialHint('autofish-final',
        replayAlreadyRewarded
          ? 'You\u2019ve completed the six steps again. Your tutorial reward was already claimed, so you can press DONE to finish and return to the Guide.'
          : 'You\u2019ve completed the tutorial! Auto-Fish is unlocked. For more info on any feature, check out the Guide (highlighted at the top). Press DONE to claim your reward of 10 random Treasury items and explore freely.',
        {
          kicker:'TUTORIAL COMPLETE',
          dismiss:'Press DONE to finish the tutorial',
          keepOnTargetClick:true,
          scroll:false,
          action:{
            label:'DONE',
            disabled:false,
            onClick:() => replayAlreadyRewarded ? markTutorialCompleted('replay-done') : claimTutorialRewardAndFinish()
          },
          startCollapsed:false
        }
      );
      if (shown) {
        showTutorialFinalStep._retries = 0;
        document.getElementById('guideTopBtn')?.classList.add('tutorial-target');
      } else if ((showTutorialFinalStep._retries = (showTutorialFinalStep._retries || 0) + 1) <= 8) {
        // The licensed panel may not have rendered yet (e.g. a status load was
        // already in flight when the license was bought). Refresh and retry.
        setTimeout(async () => {
          if (!tutorialFlowActive) return;
          try { await loadAutoFishStatus(true); } catch (e) { console.warn('[scripts/index-app.js:750] ignored error:', e?.message || e); }
          if (tutorialFlowActive && !tutorialHintEl) showTutorialFinalStep();
        }, 600);
      }
    }

    function showAutoFishTutorialStep() {
      if (!tutorialFlowActive || !currentFishdexLogin) return;
      switchHubTab('autofish', { load: false });
      (async () => {
        try { await loadAutoFishStatus(true); } catch (e) { console.warn('[scripts/index-app.js:760] ignored error:', e?.message || e); }
        if (!tutorialFlowActive) return;
        const data = window.__lastAutoFishData || {};
        if (data?.licensed) {
          showTutorialFinalStep();
          return;
        }
        const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
        if (login) {
          const state = tutorialState(login);
          state.tutorialStage = 'autofish-license';
          writeTutorialState(login, state);
        }
        showAutoFishLicenseHint();
      })();
    }

    function showAutoFishLicenseHint() {
      if (!tutorialFlowActive) return;
      const shown = showTutorialHint('autofish-license',
        'Last task: unlock Auto-Fish. Your Area is Level 3, so press Purchase License to buy Fishy’s Auto-Fishing License.',
        { kicker:'UNLOCK AUTO-FISH', dismiss:'Press Purchase License to continue', keepOnTargetClick:true, scroll:true }
      );
      if (shown) { showAutoFishLicenseHint._retries = 0; return; }
      // Panel not rendered (or not eligible yet): refresh and retry a few times.
      if ((showAutoFishLicenseHint._retries = (showAutoFishLicenseHint._retries || 0) + 1) <= 8) {
        setTimeout(async () => {
          if (!tutorialFlowActive || tutorialHintEl) return;
          try { await loadAutoFishStatus(true); } catch (e) { console.warn('[scripts/index-app.js:788] ignored error:', e?.message || e); }
          if (!tutorialFlowActive || tutorialHintEl) return;
          if (window.__lastAutoFishData?.licensed) showTutorialFinalStep();
          else showAutoFishLicenseHint();
        }, 700);
      }
    }

    function tutorialHasTreasuryOnlyEnabled(data) {
      return !!data?.shop?.treasuryOnly?.owned && data.shop.treasuryOnly.toggleOn === true;
    }

    async function refreshTutorialTreasuryState() {
      if (!tutorialFlowActive || document.hidden || !cachedFishdexData?.user?.login) return;
      if (tutorialCurrentKey() !== 'treasury-only') return;
      try {
        const res = await fetch('/api/perks?check=treasuryOnly', { cache:'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        window.__tutorialTreasuryOnlyCheck = data;
        if (tutorialCurrentKey() === 'treasury-only' && data?.treasuryOnly?.enabled === true) {
          const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
          if (login) {
            const state = tutorialState(login);
            state.tutorialStage = 'areas';
            state.treasuryTutorialDone = true;
            writeTutorialState(login, state);
          }
          clearTutorialHint();
          showAreasTutorialStep();
        }
      } catch (e) { console.warn('[scripts/index-app.js:849] ignored error:', e?.message || e); }
    }

    function showTreasuryTutorialStep() {
      if (!tutorialFlowActive) return;
      if (!currentFishdexLogin) {
        showTutorialHint('fishdex-login', 'Connect your Twitch account to continue. Your Fishy progress is tied to your Twitch login.', { kicker:'ACCOUNT SETUP', dismiss:'Log in with Twitch, then return to the tutorial', scroll:true });
        return;
      }

      // Render the tutorial step immediately. The Perks panel/status request can
      // be slow on a cold load, but that must never make the tutorial appear to
      // skip the Treasury Only step after catch 25. The live checks below will
      // advance the tutorial as soon as the actual setting is known/enabled.
      // Perks opens as a popup over the World Map (not as a full tab). The popup waits for the map to load.
      if (window.WorldMapBridge && typeof WorldMapBridge.openBuilding === 'function') WorldMapBridge.openBuilding('perks');
      else switchHubTab('perks');
      showTutorialHint(
        'treasury-only',
        'Enable Treasury Only Mode on the highlighted card. Once you switch it on, the tutorial will take you straight to your first Area.',
        { kicker:'NEXT STEP', scroll:true, keepOnTargetClick:true }
      );

      // The full Perks request is intentionally kept in the background so the
      // tutorial card is not blocked by unrelated inventory/timer reads.
      loadPerksStatus().catch(() => {});
      refreshTutorialTreasuryState().catch(() => {});
    }

    function areaTutorialCopy(area) {
      const level = Math.max(0, Number(area?.level || 0));
      const name = area?.name || 'your first Area';
      return level > 0
        ? `Upgrade ${name} until it reaches Level 3. The tutorial will stay on this Area through every upgrade.`
        : `Unlock ${name} first. After it unlocks, keep upgrading it until Level 3. The tutorial will stay on this Area.`;
    }

    function updateAreasTutorialStep(area, options = {}) {
      if (!tutorialFlowActive || !currentFishdexLogin || !area) return;
      const level = Math.max(0, Math.min(3, Number(area.level || 0)));
      if (level >= 3) { showAutoFishTutorialStep(); return; }
      const copy = areaTutorialCopy(area);
      const dismiss = level > 0 ? 'Upgrade the highlighted Area until it reaches Level 3' : 'Unlock the highlighted Area, then upgrade it to Level 3';
      showTutorialHint('first-area', copy, {
        kicker: level > 0 ? 'UPGRADE AREA' : 'UNLOCK AREA',
        dismiss,
        keepOnTargetClick:true,
        scroll: options.scroll !== false,
        progress:{
          target:3,
          current:level,
          label:'AREA LEVEL',
          isArea:true,
          copy: level >= 3 ? 'Goal complete. Continue to Auto-Fish.' : `${3 - level} area level${3 - level === 1 ? '' : 's'} to go`
        }
      });
      if (level >= 3) {
        showAutoFishTutorialStep();
      }
    }

    async function showAreasTutorialStep() {
      if (!tutorialFlowActive) return;
      if (!currentFishdexLogin) {
        showTutorialHint('fishdex-login', 'Connect your Twitch account to continue. Your Fishy progress is tied to your Twitch login.', { kicker:'ACCOUNT SETUP', dismiss:'Log in with Twitch, then return to the tutorial', scroll:true });
        return;
      }
      switchHubTab('areas', { load: false });
      await loadFishingAreas(true);
      if (!tutorialFlowActive) return;
      const area = (fishingAreasData?.areas || []).find((a) => a.id === 'forest') || (fishingAreasData?.areas || [])[0];
      if (!area) return;
      const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
      if (login) {
        const state = tutorialState(login);
        state.tutorialStage = Number(area.level || 0) >= 3 ? 'autofish-license' : 'area-level-3';
        state.treasuryTutorialDone = true;
        writeTutorialState(login, state);
      }
      if (Number(area.level || 0) >= 3) {
        showAutoFishTutorialStep();
        return;
      }
      updateAreasTutorialStep(area, { scroll:true });
    }

    // The top-bar Tutorial button was intentionally removed. The normal
    // first-run / wipe intro is the entry point; once guided onboarding is
    // active, the draggable task card is the tutorial control.
    function updateTutorialTopButton() {}


    async function pollTutorialProgress() {
      if (!tutorialFlowActive || document.hidden || !cachedFishdexData?.user?.login) return;
      try {
        const res = await fetch('/api/fishdex', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        cachedFishdexData = { ...cachedFishdexData, ...data };
        const caught = Number(data.totalCaught || 0);
        updateTutorialProgressUI(caught);
      } catch (e) { console.warn('[scripts/index-app.js:951] ignored error:', e?.message || e); }
    }

    async function pollTutorialAreaProgress() {
      if (!tutorialFlowActive || document.hidden || !cachedFishdexData?.user?.login) return;
      // Only the first-Area step needs live Area data.
      if (tutorialCurrentKey() !== 'first-area') return;
      try {
        const res = await fetch('/api/areas', { cache:'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        fishingAreasData = data;
        const area = (data?.areas || []).find((a) => a.id === 'forest') || (data?.areas || [])[0];
        if (!area) return;
        if (tutorialCurrentKey() === 'first-area') {
          if (Number(area.level || 0) >= 3) {
            const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
            if (login) {
              const s = tutorialState(login);
              s.tutorialStage = 'autofish-license';
              writeTutorialState(login, s);
            }
            clearTutorialHint();
            showAutoFishTutorialStep();
          } else {
            rebindTutorialHintTarget('first-area', false);
            updateAreasTutorialStep(area, { scroll:false });
          }
        }
      } catch (e) { console.warn('[scripts/index-app.js:980] ignored error:', e?.message || e); }
    }

    function startTutorialLivePolling() {
      startTutorialPoller('progress', pollTutorialProgress, () => (tutorialCurrentKey() === 'progress' ? 3000 : 15000));
      startTutorialPoller('area', pollTutorialAreaProgress, () => (tutorialCurrentKey() === 'first-area' ? 2000 : 15000));
      startTutorialPoller('treasury', refreshTutorialTreasuryState, () => (tutorialCurrentKey() === 'treasury-only' ? 1200 : 15000));
    }

    function restartSixStepTutorial() {
      const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
      if (!login) {
        openTutorialOffer();
        toast('Log in with Twitch to restart the six-step tutorial.', 'info', { label: 'Your guide' });
        return;
      }
      tutorialReplayActive = guideRewardClaimed(login);
      tutorialFlowActive = false;
      clearTutorialHint();
      stopTutorialLivePolling();
      try { sessionStorage.setItem('fishyTutorialStarted', '1'); } catch (e) {}
      startInteractiveTutorial({ replay: true });
    }

    function startInteractiveTutorial(options = {}) {
      // Commit the guided choice BEFORE advancing the tutorial UI. This keeps
      // a concurrent Fishdex/Profile refresh from seeing the old welcome state
      // and immediately opening the intro again.
      tutorialFlowActive = true;
      if (options.replay) tutorialReplayActive = guideRewardClaimed(cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin);
      try { sessionStorage.setItem('fishyTutorialStarted','1'); } catch(e) {}
      const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
      if (login) {
        const state = readTutorialState(login);
        state.version = TUTORIAL_STATE_VERSION;
        state.tutorialStarted = true;
        state.introDismissed = true;
        state.seen = true;
        state.tutorialCompleted = !!state.tutorialCompleted;
        state.tutorialMode = 'guided';
        state.tutorialStage = state.tutorialCompleted ? 'complete' : (state.treasuryTutorialDone ? 'areas' : 'catches');
        writeTutorialState(login, state);
      }
      updateTutorialTopButton();
      startTutorialLivePolling();
      const caught = Number(cachedFishdexData?.totalCaught || 0);
      if (caught < 25) {
        showTutorialHint('progress', 'Your first milestone is 25 catches. Use !fish in chat. This progress updates live while you fish.', { kicker:'FIRST GOAL', dismiss:'Catch 25 fish, then continue here', scroll:true, progress:{ target:25, label:'CATCH 25 FISH' } });
        return;
      }
      const stateNow = tutorialState(login);
      if (!stateNow.treasuryTutorialDone) {
        showTreasuryTutorialStep();
        return;
      }
      showAreasTutorialStep();
    }

    function initGuideSearch() {
      const input = document.getElementById('guideSearchInput');
      if (input && !input.dataset.bound) {
        input.dataset.bound = '1';
        input.addEventListener('input', () => renderGuideReference(input.value));
      }
      renderGuideReference();
    }

    /* ---------- Site updates (public read, admin add/edit/remove) ---------- */
    let siteUpdates = [];
    let editingUpdateId = null;

    function formatUpdateDate(iso) {
      const d = new Date(iso);
      return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function updatesLastSeen() {
      try { return localStorage.getItem('updatesSeen') || ''; } catch (e) { return ''; }
    }

    function refreshUpdatesDot() {
      const dot = document.getElementById('updatesDot');
      if (!dot) return;
      dot.hidden = !(siteUpdates.length && siteUpdates[0].id !== updatesLastSeen());
    }

    async function loadUpdates() {
      try {
        const res = await fetch('/api/updates');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load updates.');
        siteUpdates = Array.isArray(data.updates) ? data.updates : [];
      } catch (err) {
        console.error('Failed to load updates:', err);
      }
      refreshUpdatesDot();
      renderUpdates();
    }

    function renderUpdates() {
      const list = document.getElementById('updatesList');
      const form = document.getElementById('updatesAdminForm');
      if (!list || !form) return;
      form.style.display = isAdminLoggedIn ? 'flex' : 'none';
      if (!siteUpdates.length) {
        list.innerHTML = `<div class="updates-empty">${isAdminLoggedIn ? 'No updates yet. Post the first one above.' : 'No updates yet.'}</div>`;
        return;
      }
      list.innerHTML = siteUpdates.map((u) => `
        <article class="update-entry">
          <div class="update-date">${escText(formatUpdateDate(u.date))}${u.edited ? ' · edited' : ''}</div>
          <div class="update-title">${escText(u.title)}</div>
          <div class="update-body">${escText(u.body)}</div>
          ${isAdminLoggedIn ? `<div class="update-actions">
            <button class="success-btn" type="button" onclick='startEditUpdate(${JSON.stringify(u.id)})'>${icon('edit')}Edit</button>
            <button class="danger-btn" type="button" onclick='removeUpdate(${JSON.stringify(u.id)})'>${icon('trash')}Remove</button>
          </div>` : ''}
        </article>`).join('');
    }

    async function openUpdatesModal() {
      document.getElementById('updatesModal').classList.add('active');
      renderUpdates();
      await loadUpdates();
      // Opening the list counts as reading it.
      try { if (siteUpdates.length) localStorage.setItem('updatesSeen', siteUpdates[0].id); } catch (e) {}
      refreshUpdatesDot();
    }

    function closeUpdatesModal() {
      document.getElementById('updatesModal').classList.remove('active');
      cancelUpdateEdit();
    }

    function startEditUpdate(id) {
      const u = siteUpdates.find((x) => x.id === id);
      if (!u) return;
      editingUpdateId = id;
      document.getElementById('updateTitleInput').value = u.title;
      document.getElementById('updateBodyInput').value = u.body;
      document.getElementById('updatesFormHeading').textContent = 'Edit update';
      document.getElementById('updateSubmitLabel').textContent = 'Save changes';
      document.getElementById('updateCancelBtn').style.display = '';
      document.getElementById('updateTitleInput').focus();
    }

    function cancelUpdateEdit() {
      editingUpdateId = null;
      const t = document.getElementById('updateTitleInput');
      const b = document.getElementById('updateBodyInput');
      if (t) t.value = '';
      if (b) b.value = '';
      const h = document.getElementById('updatesFormHeading');
      if (h) h.textContent = 'Post a new update';
      const l = document.getElementById('updateSubmitLabel');
      if (l) l.textContent = 'Post update';
      const c = document.getElementById('updateCancelBtn');
      if (c) c.style.display = 'none';
    }

    async function runTreasuryBatches(action) {
      const status = document.getElementById('treasuryStatus');
      const buttons = ['treasuryBackfillBtn', 'treasuryCheckBtn'].map((id) => document.getElementById(id)).filter(Boolean);
      const verb = action === 'treasuryCheck' ? 'Checking' : 'Copying';
      buttons.forEach((b) => { b.disabled = true; });
      const failed = [];
      let cursor = 0;
      let total = 0;
      let done = 0;
      try {
        do {
          const res = await fetch('/api/admin/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ action, cursor, size: 25 })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) throw new Error(data.error || 'The request failed. Try again.');
          total = data.total;
          done += data.processed;
          failed.push(...data.failed);
          status.textContent = `${verb} players... ${done} of ${total}`;
          cursor = data.next;
        } while (typeof cursor === 'number');
        if (failed.length) {
          status.textContent = `Finished. ${failed.length} player(s) need attention: ${failed.join(', ')}. Run "Copy Treasury items" again, then check.`;
        } else {
          status.textContent = action === 'treasuryCheck'
            ? `Finished. All ${total} players match.`
            : `Finished. Treasury items copied for all ${total} players. Now run "Check copies".`;
        }
      } catch (err) {
        status.textContent = err.message || 'Something went wrong. Try again.';
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
      }
    }
    async function updatesRequest(body) {
      const res = await fetch('/api/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not save the update.');
      siteUpdates = data.updates || [];
      return data;
    }

    async function submitUpdate() {
      const title = document.getElementById('updateTitleInput').value;
      const body = document.getElementById('updateBodyInput').value;
      const btn = document.getElementById('updateSubmitBtn');
      btn.disabled = true;
      try {
        const data = await updatesRequest(editingUpdateId
          ? { action: 'update', id: editingUpdateId, title, body }
          : { action: 'add', title, body });
        toast(data.message, 'success', { label: 'Updates' });
        cancelUpdateEdit();
        // The admin just wrote this; it should not light the "new" dot for them.
        try { if (siteUpdates.length) localStorage.setItem('updatesSeen', siteUpdates[0].id); } catch (e) {}
        refreshUpdatesDot();
        renderUpdates();
      } catch (err) {
        toast(err.message, 'error', { label: 'Update not saved' });
      } finally {
        btn.disabled = false;
      }
    }

    async function removeUpdate(id) {
      if (!confirm('Remove this update for everyone?')) return;
      try {
        const data = await updatesRequest({ action: 'remove', id });
        toast(data.message, 'success', { label: 'Updates' });
        if (editingUpdateId === id) cancelUpdateEdit();
        refreshUpdatesDot();
        renderUpdates();
      } catch (err) {
        toast(err.message, 'error', { label: 'Update not removed' });
      }
    }

    loadUpdates();
    initGuideSearch();
    function openUniqueModal() {
      document.getElementById('uniqueModal').classList.add('active');
    }
    function closeUniqueModal() {
      document.getElementById('uniqueModal').classList.remove('active');
    }

    /* Single place that flips the top rail between its logged-out and
       logged-in shapes, so the two login paths cannot drift apart. */
    function markAdminSessionLive(live, username) {
      isAdminLoggedIn = !!live;
      if (live) adminSessionUser = username || adminSessionUser;
      try { if (progressionData) { renderAchievements(); renderTitles(); } } catch (e) { console.warn('[scripts/index-app.js:1564] ignored error:', e?.message || e); }

      const label = document.getElementById('adminBtnText');
      if (label) label.textContent = live ? 'Sign out' : 'MasterAdmin login';

      // The mark names the action, not the state: a closed padlock invites
      // you in, an arrow leaving takes you out. Matching the label is what
      // makes the button legible before the words are read.
      const iconUse = document.querySelector('#adminAuthIcon use');
      if (iconUse) iconUse.setAttribute('href', live ? '#i-out' : '#i-lock');

      const tab = document.getElementById('adminTabBtn');
      if (tab) tab.style.display = live ? 'inline-flex' : 'none';

      if (live) { loadPerksStatus(); loadProgression(true); }

      const btn = document.getElementById('adminAuthBtn');
      if (btn) btn.classList.toggle('is-live', !!live);

      // Trading is tied to the logged-in Twitch profile, not the operator
      // session. The nav is shown by syncTradingIdentity() after Twitch login.
      // Admin logout therefore must not hide a player's real trading mail.
    }

    async function submitAdminLogin(event) {
      event.preventDefault();
      const username = document.getElementById('adminUser').value.trim();
      const password = document.getElementById('adminPass').value;
      const errorEl = document.getElementById('loginError');

      // Disable button during request
      const submitBtn = document.querySelector('#adminLoginForm button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      if (!username || !password) {
        errorEl.textContent = 'Enter both a username and a password.';
        errorEl.style.display = 'block';
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      try {
        const response = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await response.json();

        if (response.ok && data.token) {
          authToken = data.token;
          adminSessionUser = data.username || username;
          markAdminSessionLive(true, adminSessionUser);
          document.getElementById('adminSessionUserLabel').textContent = adminSessionUser;
          errorEl.style.display = 'none';
          
          // Store token in sessionStorage for persistence across refreshes
          sessionStorage.setItem('adminToken', authToken);
          loadBroadcasterAdminAccounts().catch(() => {});
          sessionStorage.setItem('adminTokenExpiry', data.expiresAt.toString());
          
          closeAdminModal();
          switchView('admin');
          startAdminAuditFeed();
        } else {
          // Show specific error message from backend
          errorEl.textContent = data.error || 'Invalid credentials.';
          if (data.attemptsLeft !== undefined) {
            errorEl.textContent += ` Attempts remaining: ${data.attemptsLeft}`;
          }
          if (data.locked) {
            errorEl.textContent = `Account locked. ${data.retryAfter} minutes until retry.`;
          }
          errorEl.style.display = 'block';
        }
      } catch (err) {
        console.error('Login error:', err);
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.style.display = 'block';
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    // Validate existing session on page load
    /* Re-checks a stored admin token against the server.
       Called once on page load, so it stays silent by default: a visitor who
       was never signed in must not get an error toast for having no token.
       Pass { announce: true } to surface a drop to a user who is actually
       looking at the panel. */
    async function validateAdminSession(opts = {}) {
      const storedToken = sessionStorage.getItem('adminToken');
      const storedExpiry = sessionStorage.getItem('adminTokenExpiry');

      // One exit for every way a stored session stops being good, so the
      // top rail can never be left half-signed-in.
      const drop = (reason) => {
        sessionStorage.removeItem('adminToken');
        sessionStorage.removeItem('adminTokenExpiry');
        authToken = null;
        markAdminSessionLive(false);
        if (opts.announce) {
          showFeedback(reason, 'error', 'adminFeedback', { label: 'Session closed' });
        }
        return false;
      };

      if (!storedToken || !storedExpiry) return false;

      // Check if token is already expired
      if (Date.now() > parseInt(storedExpiry, 10)) {
        return drop('Your operator session expired. Sign in again to continue.');
      }

      try {
        const response = await fetch('/api/admin/validate', {
          headers: { 'Authorization': `Bearer ${storedToken}` }
        });
        const data = await response.json();

        if (response.ok && data.valid) {
          authToken = storedToken;
          loadBroadcasterAdminAccounts().catch(() => {});
          adminSessionUser = data.username || null;
          markAdminSessionLive(true, adminSessionUser);
          const label = document.getElementById('adminSessionUserLabel');
          if (label) label.textContent = adminSessionUser || 'Operator';
          return true;
        }

        return drop('Your operator session is no longer valid. Sign in again to continue.');
      } catch (err) {
        console.error('Session validation error:', err);
        // A network blip is not a rejected session, so the token stays put
        // and the user keeps whatever they had.
        markAdminSessionLive(false);
        if (opts.announce) {
          showFeedback('Could not reach the server to check your session.', 'error', 'adminFeedback', { label: 'Offline' });
        }
        return false;
      }
    }

    async function handleAdminLogout() {
      const who = adminSessionUser || 'the current operator';

      let serverAcknowledged = false;
      try {
        const res = await fetch('/api/admin/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        serverAcknowledged = res.ok;
        if (!res.ok) {
          console.warn('Logout request returned', res.status);
        }
      } catch (err) {
        console.error('Logout error:', err);
      } finally {
        // The local session is torn down regardless. Leaving the token in
        // place because the server was unreachable would keep a half-live
        // session that fails confusingly on the next action.
        authToken = null;
        adminSessionUser = null;
        markAdminSessionLive(false);
        sessionStorage.removeItem('adminToken');
        sessionStorage.removeItem('adminTokenExpiry');

        stopAdminAuditFeed();
        switchView('loottable');

        if (serverAcknowledged) {
          toast(`Session closed for ${who}. The audit trail is unchanged.`, 'success', {
            label: 'Signed out'
          });
        } else {
          toast(
            `Signed out of this browser, but the server did not confirm it. Reload before logging in again.`,
            'info',
            { label: 'Signed out locally', ttl: 7000 }
          );
        }
      }
    }

    let adminAuditEvents = [];
    let adminAuditPollBusy = false;

    const adminAuditActionLabels = {
      adminLogin: 'Admin login',
      adminLoginFailed: 'Failed admin login',
      setGlobalEventLuck: 'Started global luck event',
      clearGlobalEventLuck: 'Ended global luck event',
      resetAllFishMessages: 'Reset all custom !fish messages',
      giveFish: 'Awarded fish',
      fishCatch: 'Live !fish catch',
      giveFishBatch: 'Awarded inventory batch',
      removeFish: 'Removed fish',
      multiDeleteFish: 'Deleted inventory items',
      setPerk: 'Updated user perk',
      recalcBestCatch: 'Recalculated best catch',
      clearUser: 'Wiped user data',
      wipeRarity: 'Wiped one rarity',
      setCooldown: 'Changed fishing cooldown',
      setUserLuck: 'Changed user luck',
      resetUserLuck: 'Reset user luck'
    };

    function renderAdminAuditLog() {
      const list = document.getElementById('adminAuditList');
      const search = (document.getElementById('adminAuditSearch')?.value || '').trim().toLowerCase();
      if (!list) return;
      const matches = adminAuditEvents.filter((event) => {
        const haystack = [event.action, adminAuditActionLabels[event.action] || '', event.actor, event.target, event.details, event.occurredAt]
          .join(' ').toLowerCase();
        return !search || haystack.includes(search);
      });
      const count = document.getElementById('adminAuditCount');
      if (count) count.textContent = `${matches.length} of ${adminAuditEvents.length} recent action${adminAuditEvents.length === 1 ? '' : 's'}`;
      if (!matches.length) {
        list.innerHTML = `<div class="log-placeholder">${adminAuditEvents.length ? 'No matching actions.' : 'No audit actions recorded yet.'}</div>`;
        return;
      }
      list.innerHTML = matches.map((event) => {
        const label = adminAuditActionLabels[event.action] || event.action || 'Admin action';
        const target = event.target ? `@${event.target}` : 'Global';
        const timestamp = event.occurredAt ? new Date(event.occurredAt).toLocaleString() : 'Unknown time';
        return `<article class="admin-audit-entry ${event.status === 'error' ? 'error' : 'success'}">
          <div class="admin-audit-entry-top"><strong class="admin-audit-action">${escapeHtml(label)}</strong><span class="admin-audit-target">${escapeHtml(target)}</span></div>
          <p class="admin-audit-details">${escapeHtml(event.details || 'Action completed.')}</p>
          <div class="admin-audit-meta"><span>${escapeHtml(event.actor || 'admin')}</span><time>${escapeHtml(timestamp)}</time></div>
          <button class="audit-delete-btn" onclick="deleteAuditEntry('${escapeHtml(event.id || '')}')" aria-label="Delete this audit entry" title="Delete entry">${icon('x')}</button>
        </article>`;
      }).join('');
    }

    async function deleteAuditEntry(id) {
      if (!id) return;
      try {
        const response = await fetch('/api/admin/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ action: 'deleteAuditEntry', entryId: id })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Server refused the deletion.');
        // Drop it locally at once; the poll will then bring in the server's
        // own "deleted an audit entry" record, so the wipe stays visible.
        adminAuditEvents = adminAuditEvents.filter(e => e.id !== id);
        renderAdminAuditLog();
        toast('Audit entry deleted.', 'success', { label: 'Deleted' });
      } catch (err) {
        showFeedback(`Could not delete that audit entry. ${(err && err.message) || 'Unknown error'}`, 'error', 'adminFeedback', { label: 'Not deleted' });
      }
    }

    async function refreshAdminAuditLog() {
      if (!isAdminLoggedIn || adminAuditPollBusy) return;
      adminAuditPollBusy = true;
      const status = document.getElementById('adminAuditStatus');
      try {
        const response = await fetch('/api/admin/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ action: 'getAuditLog', limit: 50 })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Live audit feed unavailable.');
        const nextEvents = Array.isArray(data.auditLog) ? data.auditLog : [];
        const newEventArrived = nextEvents[0]?.id && nextEvents[0].id !== adminAuditEvents[0]?.id;
        adminAuditEvents = nextEvents;
        if (status) {
          status.textContent = 'LIVE';
          status.classList.remove('offline');
        }
        renderAdminAuditLog();
        const list = document.getElementById('adminAuditList');
        if (newEventArrived && list && list.scrollTop < 8) list.scrollTop = 0;
      } catch (error) {
        if (status) {
          status.textContent = 'OFFLINE';
          status.classList.add('offline');
        }
        const count = document.getElementById('adminAuditCount');
        if (count && !adminAuditEvents.length) count.textContent = 'Reconnecting to the audit feed…';
      } finally {
        adminAuditPollBusy = false;
      }
    }

    function startAdminAuditFeed() {
      stopAdminAuditFeed();
      refreshAdminAuditLog();
      window.adminAuditInterval = setInterval(refreshAdminAuditLog, 10000);
    }

    function stopAdminAuditFeed() {
      if (window.adminAuditInterval) clearInterval(window.adminAuditInterval);
      window.adminAuditInterval = null;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[character]);
    }

    async function loadAdminInventory() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) {
        showFeedback('Please enter a target username to inspect.', 'error', 'adminInvFeedback');
        return;
      }

      const loadBtn = document.getElementById('adminLoadBtn');
      if (loadBtn) loadBtn.disabled = true;

      try {
        // Live read straight from the player's inventory (not the cached,
        // top-50-only public leaderboard).
        const data = await adminPerksRequest({ action: 'getInventory', targetUser: target });
        const liveItems = Array.isArray(data.items) ? data.items : [];

        const container = document.getElementById('adminInvContainer');
        const hasItems = liveItems.length > 0;

        loadedAdminInventoryItems = liveItems;
        adminVaultFilterTab = 'all';
        document.getElementById('adminVaultSearchInput').value = '';

        const filterBtns = container.querySelectorAll('.vault-filter-tabs .vault-tab-btn');
        filterBtns.forEach(btn => {
          if (btn.textContent.trim().toLowerCase() === 'all') btn.classList.add('active');
          else btn.classList.remove('active');
        });

        container.style.display = 'flex';
        renderAdminInventoryGrid();

        if (hasItems) {
          showFeedback(`Inventory loaded for @${target}.`, 'success', 'adminInvFeedback');
        } else {
          showFeedback(`@${target} has no items yet. You can still award them items below.`, 'success', 'adminInvFeedback');
        }

        const awardBtn = document.getElementById('adminAwardBtn');
        const refreshBtn = document.getElementById('adminRefreshBtn');
        const recalcBtn = document.getElementById('adminRecalcBtn');
        const deselectBtn = document.getElementById('adminDeselectBtn');
        if (loadBtn) loadBtn.classList.add('hidden');
        if (awardBtn) awardBtn.classList.remove('hidden');
        document.getElementById('adminPerksBtn')?.classList.remove('hidden');
        if (refreshBtn) refreshBtn.classList.remove('hidden');
        if (recalcBtn) recalcBtn.classList.remove('hidden');
        if (deselectBtn) deselectBtn.classList.remove('hidden');
      } catch (err) {
        showFeedback((err && err.message) || 'Failed to load user inventory from server.', 'error', 'adminInvFeedback');
      } finally {
        if (loadBtn) loadBtn.disabled = false;
      }
    }

    // Refresh keeps the currently loaded user's active tab/search filters,
    // unlike Load which is for switching to inspect a different user.
    async function refreshAdminInventory() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) return;

      const refreshBtn = document.getElementById('adminRefreshBtn');
      const refreshIcon = document.getElementById('adminRefreshIcon');
      if (refreshBtn) refreshBtn.disabled = true;
      if (refreshIcon) refreshIcon.classList.add('spin');

      try {
        const data = await adminPerksRequest({ action: 'getInventory', targetUser: target });
        const liveItems = Array.isArray(data.items) ? data.items : [];

        loadedAdminInventoryItems = liveItems;
        renderAdminInventoryGrid();

        if (liveItems.length) {
          const distinct = new Set(liveItems.map((entry) => String(entry).trim().toLowerCase())).size;
          showFeedback(
            `@${target}: ${distinct} distinct fish, ${liveItems.length.toLocaleString('en-US')} items in total.`,
            'success',
            'adminInvFeedback',
            { label: 'Inventory refreshed' }
          );
        } else {
          showFeedback(
            `@${target} has no items right now.`,
            'info',
            'adminInvFeedback',
            { label: 'Inventory empty' }
          );
        }
      } catch (err) {
        showFeedback(
          `Could not read @${target}'s inventory from the local database. ${(err && err.message) || 'Unknown error'}`,
          'error',
          'adminInvFeedback',
          { label: 'Inventory not refreshed' }
        );
      } finally {
        if (refreshBtn) refreshBtn.disabled = false;
        if (refreshIcon) refreshIcon.classList.remove('spin');
      }
    }

    // Close/deselect the currently inspected user's inventory
    function deselectAdminUser() {
      const input = document.getElementById('adminInspectUser');
      const container = document.getElementById('adminInvContainer');
      const loadBtn = document.getElementById('adminLoadBtn');
      const awardBtn = document.getElementById('adminAwardBtn');
      const refreshBtn = document.getElementById('adminRefreshBtn');
      const recalcBtn = document.getElementById('adminRecalcBtn');
      const deselectBtn = document.getElementById('adminDeselectBtn');

      if (input) input.value = '';
      if (container) container.style.display = 'none';
      loadedAdminInventoryItems = [];

      if (loadBtn) loadBtn.classList.remove('hidden');
      if (awardBtn) awardBtn.classList.add('hidden');
      document.getElementById('adminPerksBtn')?.classList.add('hidden');
      if (refreshBtn) refreshBtn.classList.add('hidden');
      if (recalcBtn) recalcBtn.classList.add('hidden');
      if (deselectBtn) deselectBtn.classList.add('hidden');
    }

    // Re-scans the user's full inventory server-side and fixes their stored
    // best-catch tier/name (fixes stale/corrupted values from before the
    // parseItem() tier-parsing bug was patched).
    async function recalcAdminBestCatch() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) return;

      const recalcBtn = document.getElementById('adminRecalcBtn');
      if (recalcBtn) recalcBtn.disabled = true;

      try {
        const res = await fetch('/api/admin/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            action: 'recalcBestCatch',
            targetUser: target
          })
        });

        const result = await res.json();
        if (res.ok) {
          showFeedback(result.message || `Recalculated best catch for @${target}.`, 'success', 'adminInvFeedback');
          refreshLeaderboardEntry(target);
        } else {
          showFeedback(result.error || 'Failed to recalculate best catch.', 'error', 'adminInvFeedback');
        }
      } catch (err) {
        showFeedback('Error executing recalculate request.', 'error', 'adminInvFeedback');
      } finally {
        if (recalcBtn) recalcBtn.disabled = false;
      }
    }

    // Forces the cached leaderboard data to drop so the next leaderboard view
    // re-fetches fresh best-catch values from the server.
    function refreshLeaderboardEntry(target) {
      cachedLeaderboardData = null;
      if (document.getElementById('leaderboard-view')?.classList.contains('active')) {
        fetchLeaderboard();
      }
    }

    document.addEventListener("DOMContentLoaded", () => {
      const adminSearchInput = document.getElementById("adminInspectUser");

      // Auto close/deselect the loaded inventory when the search field is cleared
      if (adminSearchInput) {
        adminSearchInput.addEventListener("input", (e) => {
          if (e.target.value.trim() === "") {
            deselectAdminUser();
          }
        });
      }

      // FIX: prevent click-and-drag text selection on leaderboard rows from
      // triggering the inventory accordion to open/close
      document.addEventListener("click", (e) => {
        const accordionRow = e.target.closest(".accordion-row");
        if (accordionRow) {
          const selectedText = window.getSelection ? window.getSelection().toString() : "";
          if (selectedText.length > 0) {
            e.stopImmediatePropagation();
          }
        }
      }, true); // capture phase, runs before the row's inline onclick
    });

    function setAdminVaultTab(tabName) {
      adminVaultFilterTab = tabName;
      const container = document.getElementById('adminInvContainer');
      const filterBtns = container.querySelectorAll('.vault-filter-tabs .vault-tab-btn');
      filterBtns.forEach(btn => {
        if (btn.textContent.trim().toLowerCase() === tabName) btn.classList.add('active');
        else btn.classList.remove('active');
      });
      renderAdminInventoryGrid();
    }

    function filterAdminInventory() {
      renderAdminInventoryGrid();
    }

    function renderAdminInventoryGrid() {
      const grid = document.getElementById('adminInvGrid');
      const searchQuery = document.getElementById('adminVaultSearchInput').value.toLowerCase().trim();

      const counts = {};
      loadedAdminInventoryItems.forEach(item => {
        const cleanStr = typeof item === 'string' ? item : (item.name || 'Unknown Catch');
        const match = cleanStr.match(/^(.*?)\s*\[([A-Z]+)\]$/);
        const fishName = match ? match[1].trim() : cleanStr;
        const tierName = match ? match[2].trim() : 'COMMON';
        const groupKey = `${fishName.toLowerCase()}_${tierName.toLowerCase()}`;

        if (!counts[groupKey]) {
          counts[groupKey] = {
            name: fishName,
            tier: tierName,
            rawStrings: [],
            count: 0
          };
        }
        counts[groupKey].count++;
        counts[groupKey].rawStrings.push(cleanStr);
      });

      let itemsArray = Object.values(counts).map((group, idx) => {
        const details = getTierDisplayByName(group.tier);
        return {
          name: group.name,
          tier: group.tier,
          count: group.count,
          rawStrings: group.rawStrings,
          ...details,
          originalIndex: idx
        };
      });

      itemsArray = itemsArray.filter(item => {
        const matchesTab = adminVaultFilterTab === 'all' || item.tierId === adminVaultFilterTab;
        const matchesSearch = item.name.toLowerCase().includes(searchQuery);
        return matchesTab && matchesSearch;
      });

      window._adminItemsArray = itemsArray;

      document.getElementById('adminInvCountText').textContent = `${itemsArray.length} items shown`;

      if (itemsArray.length === 0) {
        grid.innerHTML = `<div class="grid-empty">No inventory items found matching your filters.</div>`;
        return;
      }

      grid.innerHTML = itemsArray.map(item => `
        <div class="inventory-item-card" id="admin-item-${item.originalIndex}" style="--slot-accent: ${item.accent};" onclick="toggleAdminItemSelect(${item.originalIndex})">
          <div class="item-info-group">
            <input type="checkbox" id="admin-chk-${item.originalIndex}" onclick="event.stopPropagation(); toggleAdminItemSelect(${item.originalIndex})">
            <div class="fish-icon-frame">${icon(item.icon)}</div>
            <div class="item-text-details">
              <span class="item-name" title="${escText(item.name)}">${escText(item.name)}</span>
              <span class="item-rarity">${escText(item.label)}</span>
            </div>
          </div>
          <span class="item-quantity-badge">x${item.count}</span>
        </div>
      `).join('');
    }

    function toggleAdminItemSelect(idx) {
      const card = document.getElementById(`admin-item-${idx}`);
      const chk = document.getElementById(`admin-chk-${idx}`);
      if (chk && card) {
        chk.checked = !chk.checked;
        if (chk.checked) {
          card.classList.add('selected');
        } else {
          card.classList.remove('selected');
        }
      }
    }

    function toggleSelectAllAdminInv(select) {
      const visibleCards = document.querySelectorAll('.inventory-item-card');
      visibleCards.forEach(card => {
        const idx = card.id.replace('admin-item-', '');
        const chk = document.getElementById(`admin-chk-${idx}`);
        if (chk && card) {
          chk.checked = select;
          if (select) card.classList.add('selected');
          else card.classList.remove('selected');
        }
      });
    }

    async function adminMultiDelete() {
      const target = document.getElementById('adminInspectUser').value.trim();
      const itemsArray = window._adminItemsArray || [];
      const selectedItemsToGym = [];

      itemsArray.forEach(item => {
        const chk = document.getElementById(`admin-chk-${item.originalIndex}`);
        if (chk && chk.checked) {
          selectedItemsToGym.push(...item.rawStrings);
        }
      });

      if (selectedItemsToGym.length === 0) {
        showFeedback('Please select at least one item to delete.', 'error', 'adminInvFeedback');
        return;
      }

      const confirmed = confirm(`Are you sure you want to permanently delete selected item(s) from @${target}?`);
      if (!confirmed) return;

      try {
        const res = await fetch('/api/admin/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            action: 'multiDeleteFish',
            targetUser: target,
            items: selectedItemsToGym
          })
        });

        const result = await res.json();
        if (res.ok) {
          showFeedback(result.message || 'Successfully deleted selected items!', 'success', 'adminInvFeedback');
          loadAdminInventory();
        } else {
          showFeedback(result.error || 'Failed to delete items.', 'error', 'adminInvFeedback');
        }
      } catch (err) {
        showFeedback('Error executing multi-delete request.', 'error', 'adminInvFeedback');
      }
    }

    /* ---------- Award Items modal (merged "Give Fish to User" + multi-select + amounts) ---------- */
    let awardSelectedItems = [];
    let awardSelectedIdCounter = 0;
    let awardModalFilterTab = 'all';

    function getAwardCatalogItems() {
      const list = [];
      (baseTiers || []).forEach(tier => {
        (tier.items || []).forEach(fishName => {
          const details = getFishRarityDetails(fishName);
          list.push({ name: fishName, ...details });
        });
      });
      return list;
    }

    /* ---------- Admin: Manage Perks modal ---------- */
    async function adminPerksRequest(body) {
      const res = await fetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ ...body })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');
      return data;
    }

    function openPerksModal() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) {
        showFeedback('Load a user first to manage their perks.', 'error', 'adminInvFeedback');
        return;
      }
      document.getElementById('perksModalUsername').textContent = `@${target}`;
      document.getElementById('perksModalList').innerHTML = '<div class="state-message">Loading perks...</div>';
      document.getElementById('managePerksModal').classList.add('active');
      setAdminPerksSection('perks');
      renderAdminPerks();
    }

    function closePerksModal() {
      document.getElementById('managePerksModal').classList.remove('active');
    }

    function openAutoFishGlobalAdminModal() {
      const modal = document.getElementById('adminAutoFishGlobalModal');
      if (!modal) return;
      modal.classList.add('active');
      renderAdminAutoFishGlobalControls();
    }

    function closeAutoFishGlobalAdminModal() {
      document.getElementById('adminAutoFishGlobalModal')?.classList.remove('active');
    }

    async function renderAdminPerks() {
      const target = document.getElementById('adminInspectUser').value.trim();
      const list = document.getElementById('perksModalList');
      try {
        const data = await adminPerksRequest({ action: 'getPerks', targetUser: target });
        list.innerHTML = Object.entries(data.perks).map(([id, p]) => {
          const mins = Math.ceil(p.remainingSeconds / 60);
          let status = p.owned ? 'Owned' : 'Not owned';
          if (p.owned && p.remainingSeconds > 0 && p.ttl) status = `Owned · ~${mins}m left` + (p.rarity ? ` · ${p.rarity.toUpperCase()}` : '');
          const raritySelect = id === 'rarityBoost'
            ? `<select class="shop-rarity-select admin-perk-rarity" aria-label="Rarity boost tier" id="adminPerkRarity">${data.rarities.map(r => `<option value="${r}"${r === (p.rarity || 'epic') ? ' selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`).join('')}</select>`
            : '';
          const canToggle = true;
          return `<div class="admin-perk-row admin-perk-row--toggle${p.owned ? '' : ' perk-not-owned'}">
            <div class="admin-perk-main">
              <div class="admin-perk-name">${escapeHtmlFishdex(p.name)}</div>
              <div class="admin-perk-status">${status}</div>
            </div>
            <div class="admin-perk-actions">
              ${raritySelect}
              ${canToggle ? `<label class="admin-perk-addremove" title="${p.owned ? 'Remove perk' : 'Add perk'}"><span>${p.owned ? 'REMOVE' : 'ADD'}</span><span class="perk-switch admin-perk-toggle"><input type="checkbox" ${p.owned ? 'checked' : ''} onchange="toggleAdminPerk('${id}', this.checked, this)" aria-label="${p.owned ? 'Remove' : 'Add'} ${escapeHtmlFishdex(p.name)}"><span class="perk-switch-slider"></span></span></label>` : ''}
            </div>
          </div>`;
        }).join('');

        renderAdminPondPerks(data);
        renderAdminAreaControls(data.areaSettings || { masterEnabled:true, doubleCatchEnabled:true, areas:{} });
        renderAdminAutoFishControls(data.autoFish);
      } catch (err) {
        list.innerHTML = '';
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
    }

    function setAdminPerksSection(section) {
      const next = ['perks','pond','areas','autofish','tools'].includes(section) ? section : 'perks';
      document.querySelectorAll('.admin-perks-nav-btn').forEach((btn) => {
        const active = btn.dataset.adminPerksSection === next;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.admin-perks-section').forEach((panel) => {
        const active = panel.id === `adminPerksSection-${next}`;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
    }

    async function renderAdminPondPerks(payload) {
      const box = document.getElementById('adminPondPerksList');
      if (!box) return;
      const pond = payload?.pond || {};
      if (!pond.unlocked) { box.innerHTML = '<div class="state-message">This player has not unlocked the Personal Pond. Pond perks become available at Prestige 1.</div>'; return; }
      const featureEntries = Object.entries(pond.features || {});
      const treasuryEntries = Object.entries(pond.treasury || {});
      const row = (kind, id, cfg, level) => {
        const max = Number(cfg.max || 0);
        const current = Math.max(0, Math.min(max, Number(level) || 0));
        const options = Array.from({length:max + 1}, (_, n) => `<option value="${n}" ${n === current ? 'selected' : ''}>Level ${n}${n === max ? ' · MAX' : ''}</option>`).join('');
        return `<div class="admin-pond-row"><div><div class="admin-pond-row__name">${escText(cfg.name || id)}</div><div class="admin-pond-row__meta">Current level ${current}/${max} · admin set</div></div><select class="admin-pond-level" id="adminPondLevel_${kind}_${id}" aria-label="${escText(cfg.name || id)} level">${options}</select><button class="shop-item-cta admin-pond-apply" type="button" onclick="setAdminPondPerk('${kind}','${id}')">Apply</button></div>`;
      };
      const pondLevel = Math.max(1, Math.min(5, Number(pond.level || 1)));
      const pondLevelOptions = Array.from({length: 5}, (_, n) => n + 1).map((n) => `<option value="${n}" ${n === pondLevel ? 'selected' : ''}>Level ${n}</option>`).join('');
      box.innerHTML = `<div class="admin-pond-group"><div class="admin-pond-group-head"><strong>Pond level</strong><span>MasterAdmin can set Level 1–5 directly; this does not charge FishyTokens.</span></div><div class="admin-pond-row"><div><div class="admin-pond-row__name">Personal Pond Level</div><div class="admin-pond-row__meta">Current level ${pondLevel}/5</div></div><select class="admin-pond-level" id="adminPondLevel_level" aria-label="Personal Pond level">${pondLevelOptions}</select><button class="shop-item-cta admin-pond-apply" type="button" onclick="setAdminPondLevel()">Apply</button></div></div><div class="admin-pond-group"><div class="admin-pond-group-head"><strong>Pond systems</strong><span>Deep Water, Lucky Water, Finder, Bait Slots and Familiarity.</span></div>${featureEntries.map(([id,cfg]) => row('feature',id,cfg,pond.featureLevels?.[id])).join('')}</div><div class="admin-pond-group"><div class="admin-pond-group-head"><strong>Pond Treasury perks</strong><span>Includes Treasury Waters, available only at Pond Level 5.</span></div>${treasuryEntries.map(([id,cfg]) => row('treasury',id,cfg,pond.treasuryLevels?.[id])).join('')}</div><div class="admin-pond-group"><div class="admin-pond-group-head"><strong>FishyTokens</strong><span>Add tokens to the same Pond token balance used by upgrades.</span></div><div class="admin-pond-row"><div><div class="admin-pond-row__name">Add FishyTokens</div><div class="admin-pond-row__meta">Target: @${escText(document.getElementById('adminInspectUser')?.value.trim() || 'user')}</div></div><input class="admin-form-input" id="adminPondTokenAmount" type="number" min="1" max="1000000" step="1" value="100" aria-label="FishyTokens amount"><button class="shop-item-cta admin-pond-apply" type="button" onclick="addAdminPondTokens()">Add Tokens</button></div></div>`;
    }

    async function setAdminPondLevel() {
      const target = document.getElementById('adminInspectUser').value.trim();
      const level = Number(document.getElementById('adminPondLevel_level')?.value);
      try {
        const data = await adminPerksRequest({ action:'setPondLevel', targetUser:target, level });
        showFeedback(`Pond Level set to ${data.level}.`, 'success', 'perksModalFeedback');
        await renderAdminPerks();
      } catch (err) { showFeedback(err.message, 'error', 'perksModalFeedback'); }
    }

    async function addAdminPondTokens() {
      const target = document.getElementById('adminInspectUser').value.trim();
      const amount = Math.max(1, Math.min(1000000, parseInt(document.getElementById('adminPondTokenAmount')?.value || '0', 10) || 0));
      try {
        const data = await adminPerksRequest({ action:'addPondTokens', targetUser:target, amount });
        showFeedback(`Added ${Number(data.amount).toLocaleString()} FishyTokens. New balance: ${Number(data.balance).toLocaleString()}.`, 'success', 'perksModalFeedback');
        await renderAdminPerks();
      } catch (err) { showFeedback(err.message, 'error', 'perksModalFeedback'); }
    }

    async function setAdminPondPerk(kind, perk) {
      const target = document.getElementById('adminInspectUser').value.trim();
      const level = Number(document.getElementById(`adminPondLevel_${kind}_${perk}`)?.value);
      try {
        const data = await adminPerksRequest({ action:'setPondPerk', targetUser:target, kind, pondPerk:perk, level });
        showFeedback(data.message, 'success', 'perksModalFeedback');
        await renderAdminPerks();
      } catch (err) { showFeedback(err.message, 'error', 'perksModalFeedback'); }
    }

    function renderAdminAreaControls(settings) {
      const box = document.getElementById('adminAreaFeatureControls');
      const checks = document.getElementById('adminAreaChecks');
      const areas = settings.areas || {};
      const ids = Object.keys(areas);
      const sw = (checked, onchange) => `<label class="perk-switch"><input type="checkbox" ${checked ? 'checked' : ''} onchange="${onchange}"><span class="perk-switch-slider"></span></label>`;
      if (box) {
        box.innerHTML = `
          <div class="area-feature-row"><div><div class="area-feature-name">${icon('globe')} All fishing areas</div><div class="area-feature-sub">Turns the whole area system on or off for everyone.</div></div>${sw(settings.masterEnabled !== false, "setAreaFeature('areas', null, this.checked)")}</div>
          <div class="area-feature-row"><div><div class="area-feature-name">Double Catch</div><div class="area-feature-sub">Turns the Double Catch perk on or off for everyone.</div></div>${sw(settings.doubleCatchEnabled !== false, "setAreaFeature('doubleCatch', null, this.checked)")}</div>
          <div class="area-admin-grid">${ids.map((id) => {
            const a = areas[id];
            return `<div class="area-admin-row"><span class="area-admin-name">${icon(a.icon)}<span>${escText(a.name)}</span></span><span class="area-level">${a.level ? 'Lv.' + a.level : 'Not owned'}</span>${sw(a.enabled !== false, `setAreaFeature('area', ${escText(JSON.stringify(id))}, this.checked)`)}</div>`;
          }).join('')}</div>`;
      }
      if (checks) {
        checks.innerHTML = `<label class="area-admin-check"><input type="checkbox" id="adminAreaAll" onchange="document.querySelectorAll('.admin-area-cb').forEach((c) => c.checked = this.checked)"> All areas</label>` +
          ids.map((id) => `<label class="area-admin-check"><input type="checkbox" class="admin-area-cb" value="${escText(id)}">${icon(areas[id].icon)}<span>${escText(areas[id].name)}</span></label>`).join('');
      }
    }


    function renderAdminAutoFishControls(payload) {
      const box = document.getElementById('adminAutoFishControls');
      if (!box || !payload) return;
      const c = payload.config || {};
      const st = payload.state || {};
      const field = (key, label, value, step = 1) =>
        `<div class="autofish-admin-field"><label>${escText(label)}</label><input id="adminAuto_${escText(key)}" type="number" step="${step}" value="${escText(value ?? '')}"></div>`;
      const section = (title, subtitle, content, open = false) => `
        <details class="admin-collapse autofish-admin-section" ${open ? 'open' : ''}>
          <summary><span class="admin-collapse__title">${escText(title)}</span><span class="admin-collapse__sub">${escText(subtitle)}</span><span class="admin-collapse__chevron" aria-hidden="true">⌄</span></summary>
          <div class="admin-collapse__body">${content}</div>
        </details>`;

      const playerStats = `
        <div class="autofish-admin-grid">
          ${field('userLevel','Auto-Fish level',st.level)}
          ${field('userXp','Auto-Fish XP',st.xp)}
          ${field('userPrestige','Prestige',st.prestige)}
          ${field('userAutoCasts','Lifetime Auto casts',st.autoCasts)}
          ${field('userManualCasts','Lifetime manual casts',st.manualCasts)}
          ${field('userEventsCompleted','Slots completed',st.eventsCompleted)}
          ${field('userTreasuryEarned','Treasury earned',st.treasuryEarned)}
          ${field('userStopAfter','Stop after casts (0 = off)',st.stopAfter)}
          <div class="autofish-admin-field"><label>Target area</label><select id="adminAuto_userTargetArea" class="autofish-admin-select"><option value="">Select area</option>${Object.entries(st.areas || {}).map(([id,a]) => `<option value="${escText(id)}" ${st.targetArea === id ? 'selected' : ''}>${escText(a.name)} · Lv.${a.level}</option>`).join('')}</select></div>
        </div>`;

      const playerActions = `
        <div class="autofish-admin-actionbar">
          <div class="autofish-admin-switches">
            <div class="autofish-admin-switch-row"><span>License</span><label class="perk-switch"><input id="adminAuto_userLicensed" type="checkbox" ${st.licensed ? 'checked' : ''}><span class="perk-switch-slider"></span></label></div>
            <div class="autofish-admin-switch-row"><span>Session active</span><label class="perk-switch"><input id="adminAuto_userActive" type="checkbox" ${st.active ? 'checked' : ''}><span class="perk-switch-slider"></span></label></div>
            <div class="autofish-admin-switch-row"><span>Trophy fishing · Treasury Only</span><label class="perk-switch"><input id="adminAuto_userTrophy" type="checkbox" ${st.trophyMode ? 'checked' : ''}><span class="perk-switch-slider"></span></label></div>
          </div>
          <div class="autofish-admin-actions-row">
            <button class="success-btn" onclick="saveAdminAutoPlayer()">Save player changes</button>
            <button class="danger-btn" onclick="resetAdminAutoProgression()">Reset progression</button>
          </div>
          <div class="autofish-admin-hint">Edit the values above, choose a target, then save once. License and session changes are applied together.</div>
        </div>`;

      box.innerHTML = `
        <div class="autofish-admin-user">
          <div class="autofish-admin-user-head">
            <div>
              <div class="admin-perk-name">Auto-Fish for @${escText(document.getElementById('adminInspectUser').value.trim())}</div>
              <div class="autofish-admin-user-summary">Level ${st.level} · ${Number(st.xp || 0).toLocaleString()} XP · Prestige ${st.prestige}/${c.prestigeMax || 5} · ${st.licensed ? 'Licensed' : 'Not licensed'} · ${st.active ? 'Session active' : 'Idle'} · Target: ${escText(st.targetArea || 'none')}</div>
            </div>
          </div>
          ${section('Player progression','Level, XP, prestige and lifetime counters',playerStats,true)}
          ${section('Player actions','Apply values, license and session controls',playerActions)}
        </div>`;
    }

    async function renderAdminAutoFishGlobalControls() {
      const box = document.getElementById('adminAutoFishGlobalControls');
      if (!box) return;
      box.innerHTML = '<div class="state-message">Loading global Auto-Fish settings…</div>';
      try {
        const data = await adminPerksRequest({ action:'getAutoFishGlobal' });
        const c = data.autoFish?.config || {};
        const field = (key, label, value, step = 1) =>
          `<div class="autofish-admin-field"><label>${escText(label)}</label><input id="adminAuto_${escText(key)}" type="number" step="${step}" value="${escText(value ?? '')}"></div>`;
        const section = (title, subtitle, content, open = false) => `
          <details class="admin-collapse autofish-admin-section" ${open ? 'open' : ''}>
            <summary><span class="admin-collapse__title">${escText(title)}</span><span class="admin-collapse__sub">${escText(subtitle)}</span><span class="admin-collapse__chevron" aria-hidden="true">⌄</span></summary>
            <div class="admin-collapse__body">${content}</div>
          </details>`;
        const xpProgression = `
          <div class="autofish-admin-grid">
            ${field('manualXp','XP per manual cast',c.manualXp)}
            ${field('autoXp','XP per Auto-Fish cast',c.autoXp)}
            ${field('activeEventXp','XP per collected Fishy treat',c.activeEventXp)}
            ${field('levelEfficiencyStart','Level 1 efficiency %',c.levelEfficiencyStart)}
            ${field('levelEfficiencyStep','Efficiency gain / level %',c.levelEfficiencyStep)}
          </div>`;
        const sessions = `
          <div class="autofish-admin-grid">
            ${field('baseIntervalSeconds','Auto-Fish base interval (sec)',c.baseIntervalSeconds)}
            ${field('sessionMinutesStart','Level 1 session minutes',c.sessionMinutesStart)}
            ${field('sessionMinutesPerLevel','Session minutes / level',c.sessionMinutesPerLevel)}
            ${field('sessionMinutesPerPrestige','Session minutes / prestige',c.sessionMinutesPerPrestige)}
            ${field('attentionBase','Base Fishy treat slots',c.attentionBase)}
            ${field('attentionEveryLevels','Levels per extra Fishy treat slot',c.attentionEveryLevels)}
            ${field('attentionPerPrestige','Fishy treat slots / prestige',c.attentionPerPrestige)}
          </div>`;
        const slots = `
          <div class="autofish-admin-grid">
            ${field('eventChancePerCast','Manual !fish Fishy treat chance %',Number(c.eventChancePerCast || 0) * 100,0.1)}
            ${field('eventDurationSeconds','Slot duration (sec)',c.eventDurationSeconds)}
            ${field('eventCooldownSeconds','Slot cooldown (sec)',c.eventCooldownSeconds)}
          </div>`;
        box.innerHTML = `
          <div class="autofish-global-admin-head">
            <div><div class="admin-perk-name">Global Auto-Fish</div><div class="admin-perk-status">${c.enabled === false ? 'Disabled for every player.' : 'Enabled for licensed players.'}</div></div>
            <label class="perk-switch" title="Enable or disable Auto-Fish globally"><input id="adminAuto_enabled" type="checkbox" ${c.enabled !== false ? 'checked' : ''} onchange="setAdminAutoGlobal(this.checked)"><span class="perk-switch-slider"></span></label>
          </div>
          <p class="autofish-global-admin-note">These values affect the whole Auto-Fish system. Player-specific progression remains in Manage Perks. Changes are saved together.</p>
          <div class="fishy-admin-buddy">${fishyBuddy('idle', 'I’m Fishy! I watch the line while Auto-Fish runs.', false, true)}<div class="fishy-admin-buddy__copy"><strong>Fishy companion</strong><span>Cosmetic only. The companion does not change fishing odds or rewards.</span></div></div>
          ${section('License & limits','License cost, level cap and prestige cap',`<div class="autofish-admin-grid">${field('licenseCost','License Treasury cost',c.licenseCost)}${field('maxLevel','Maximum Auto-Fish level',c.maxLevel)}${field('prestigeMax','Maximum prestige',c.prestigeMax)}${field('xpPerLevel','XP required per level',c.xpPerLevel)}</div>`,true)}
          ${section('XP & progression','Manual XP, Auto-Fish XP and efficiency',xpProgression)}
          ${section('Sessions & Fishy treat count','Auto-Fish timing, session length and max Fishy treats in the tank',sessions)}
          ${section('Fishy treats','Manual !fish spawn chance, duration and cooldown',slots)}
          <div class="autofish-global-admin-savebar"><button class="success-btn" onclick="saveAdminAutoConfig()">Save Auto-Fish Values</button></div>
          <div id="autoFishGlobalFeedback" class="form-feedback" aria-live="polite"></div>
        `;
      } catch (err) {
        box.innerHTML = `<div class="state-message">${escText(err.message || 'Could not load global Auto-Fish settings.')}</div>`;
      }
    }

    async function saveAdminAutoConfig() {
      const numericKeys = ['licenseCost','maxLevel','prestigeMax','xpPerLevel','manualXp','autoXp','activeEventXp','baseIntervalSeconds','levelEfficiencyStart','levelEfficiencyStep','sessionMinutesStart','sessionMinutesPerLevel','sessionMinutesPerPrestige','attentionBase','attentionEveryLevels','attentionPerPrestige','eventDurationSeconds','eventCooldownSeconds'];
      const body = { action:'setAutoFish', mode:'config', enabled: document.getElementById('adminAuto_enabled')?.checked !== false };
      numericKeys.forEach((key) => {
        const el = document.getElementById(`adminAuto_${key}`);
        if (el) body[key] = Number(el.value);
      });
      const chance = document.getElementById('adminAuto_eventChancePerCast');
      if (chance) body.eventChancePerCast = Number(chance.value) / 100;
      try {
        const data = await adminPerksRequest(body);
        await renderAdminAutoFishGlobalControls();
        showFeedback(data.message, 'success', 'autoFishGlobalFeedback');
      } catch (err) { showFeedback(err.message, 'error', 'autoFishGlobalFeedback'); }
    }

    async function setAdminAutoGlobal(enabled) {
      try {
        const data = await adminPerksRequest({ action:'setAutoFish', mode:'config', enabled });
        await renderAdminAutoFishGlobalControls();
        showFeedback(data.message, 'success', 'autoFishGlobalFeedback');
      } catch (err) { showFeedback(err.message, 'error', 'autoFishGlobalFeedback'); }
    }

    async function saveAdminAutoPlayer() {
      const target = document.getElementById('adminInspectUser').value.trim();
      const num = (key) => Number(document.getElementById(`adminAuto_${key}`)?.value || 0);
      const body = {
        action: 'setAutoFish', mode: 'playerSave', targetUser: target,
        level: num('userLevel'), xp: num('userXp'), prestige: num('userPrestige'),
        autoCasts: num('userAutoCasts'), manualCasts: num('userManualCasts'),
        eventsCompleted: num('userEventsCompleted'), treasuryEarned: num('userTreasuryEarned'),
        stopAfter: num('userStopAfter'),
        targetArea: document.getElementById('adminAuto_userTargetArea')?.value || '',
        licensed: document.getElementById('adminAuto_userLicensed')?.checked === true,
        active: document.getElementById('adminAuto_userActive')?.checked === true,
        trophyMode: document.getElementById('adminAuto_userTrophy')?.checked === true
      };
      try {
        const data = await adminPerksRequest(body);
        showFeedback(data.message || 'Player Auto-Fish settings saved.', 'success', 'perksModalFeedback');
        await renderAdminPerks();
      } catch (err) {
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
    }

    async function resetAdminAutoProgression() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!confirm('Reset Auto-Fish level and XP to Level 1? Prestige, fishing progress and lifetime counters remain.')) return;
      // Only level and XP are sent. Everything else keeps its stored value on the server.
      const body = { action: 'setAutoFish', mode: 'playerSave', targetUser: target, level: 1, xp: 0 };
      try {
        const data = await adminPerksRequest(body);
        showFeedback(data.message || 'Auto-Fish progression reset.', 'success', 'perksModalFeedback');
        await renderAdminPerks();
      } catch (err) {
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
    }

    async function setAdminAutoUserField(field, explicitValue) {
      const target = document.getElementById('adminInspectUser').value.trim();
      const map = { level:'userLevel', xp:'userXp', prestige:'userPrestige', autoCasts:'userAutoCasts', manualCasts:'userManualCasts', eventsCompleted:'userEventsCompleted', treasuryEarned:'userTreasuryEarned', stopAfter:'userStopAfter' };
      const value = (field === 'license' || field === 'active' || field === 'trophyMode') ? explicitValue : (field === 'targetArea' ? (document.getElementById('adminAuto_userTargetArea')?.value || '') : Number(document.getElementById(`adminAuto_${map[field]}`)?.value));
      try {
        const data = await adminPerksRequest({ action:'setAutoFish', targetUser:target, field, value });
        showFeedback(data.message, 'success', 'perksModalFeedback');
        renderAdminPerks();
      } catch (err) { showFeedback(err.message, 'error', 'perksModalFeedback'); }
    }

    async function setAreaFeature(feature, areaId, enabled) {
      try {
        const body = { action: 'setAreaFeature', feature, enabled };
        if (areaId) body.areaId = areaId;
        const data = await adminPerksRequest(body);
        showFeedback(data.message, 'success', 'perksModalFeedback');
      } catch (err) {
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
      renderAdminPerks();
    }

    function renderAdminDebugOutput(title, data) {
      const box = document.getElementById('adminDebugOutput');
      if (!box) return;
      box.textContent = `${title}\n\n${JSON.stringify(data, null, 2)}`;
    }

    async function runAdminDebug(kind) {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) { showFeedback('Load a user first.', 'error', 'perksModalFeedback'); return; }
      const actionMap = { snapshot:'adminDebugSnapshot', luck:'adminLuckBreakdown', fish:'adminTestFishRoll', pond:'adminTestPondRoll' };
      try {
        renderAdminDebugOutput('Running diagnostic…', { target, tool: kind });
        const data = await adminPerksRequest({ action: actionMap[kind], targetUser: target });
        renderAdminDebugOutput(kind === 'snapshot' ? 'USER STATE SNAPSHOT' : kind === 'luck' ? 'LUCK BREAKDOWN' : kind === 'fish' ? '!FISH DRY RUN' : 'POND DRY RUN', data.snapshot || data.breakdown || data.roll || data.pondRoll || data);
        showFeedback('Diagnostic complete.', 'success', 'perksModalFeedback');
      } catch (err) {
        renderAdminDebugOutput('DIAGNOSTIC ERROR', { error: err.message });
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
    }

    async function addAdminPondTokensFromDebug() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) { showFeedback('Load a user first.', 'error', 'perksModalFeedback'); return; }
      const amount = Math.max(1, Math.min(1000000, parseInt(document.getElementById('adminDebugTokenAmount')?.value || '0', 10) || 0));
      try {
        const data = await adminPerksRequest({ action:'addPondTokens', targetUser:target, amount });
        renderAdminDebugOutput('FISHYTOKENS', data);
        showFeedback(`Added ${Number(data.amount).toLocaleString()} FishyTokens to @${data.targetUser}.`, 'success', 'perksModalFeedback');
      } catch (err) {
        renderAdminDebugOutput('FISHYTOKENS ERROR', { error: err.message });
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
    }

    async function runAdminRepair(dryRun) {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) { showFeedback('Load a user first.', 'error', 'perksModalFeedback'); return; }
      if (!dryRun && !confirm(`Apply the proposed repairs to @${target}?`)) return;
      try {
        const data = await adminPerksRequest({ action:'adminRepairUserState', targetUser:target, dryRun });
        renderAdminDebugOutput(dryRun ? 'REPAIR PREVIEW' : 'REPAIR RESULT', data);
        showFeedback(data.message || 'Repair check complete.', 'success', 'perksModalFeedback');
        if (!dryRun) await renderAdminPerks();
      } catch (err) {
        renderAdminDebugOutput('REPAIR ERROR', { error: err.message });
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
    }

    async function spawnAdminTreasurySlot() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) {
        showFeedback('Load a user first.', 'error', 'perksModalFeedback');
        return;
      }
      const amount = Math.max(0, Math.min(50, parseInt(document.getElementById('adminTreasurySlotAmount')?.value || '0', 10) || 0));
      try {
        const data = await adminPerksRequest({ action:'spawnTreasurySlot', targetUser:target, amount });
        showFeedback(data.message || 'Fishy treat spawned in the tank.', 'success', 'perksModalFeedback');
        renderAdminPerks();
      } catch (err) {
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
    }

    async function setAdminAreas() {
      const target = document.getElementById('adminInspectUser').value.trim();
      const all = document.getElementById('adminAreaAll')?.checked;
      const picked = [...document.querySelectorAll('.admin-area-cb:checked')].map((c) => c.value);
      const level = parseInt(document.getElementById('adminAreaLevel').value, 10) || 0;
      try {
        const data = await adminPerksRequest({ action: 'setUserAreas', targetUser: target, areaIds: all ? 'all' : picked, level });
        showFeedback(data.message, 'success', 'perksModalFeedback');
      } catch (err) {
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
      renderAdminPerks();
    }

    async function toggleAdminPerk(perk, enabled, control) {
      const target = document.getElementById('adminInspectUser').value.trim();
      const body = { action: 'setPerk', targetUser: target, perk, enabled };
      if (perk === 'rarityBoost' && enabled) body.rarity = document.getElementById('adminPerkRarity')?.value || 'epic';
      try {
        const data = await adminPerksRequest(body);
        showFeedback(data.message, 'success', 'perksModalFeedback');
      } catch (err) {
        if (enabled && /does not own/i.test(err.message)) {
          try {
            const grantBody = { action: 'grantPerk', targetUser: target, perk };
            if (perk === 'rarityBoost') grantBody.rarity = document.getElementById('adminPerkRarity')?.value || 'epic';
            const data = await adminPerksRequest(grantBody);
            showFeedback(data.message, 'success', 'perksModalFeedback');
          } catch (grantErr) {
            if (control) control.checked = false;
            showFeedback(grantErr.message, 'error', 'perksModalFeedback');
          }
        } else {
          if (control) control.checked = !enabled;
          showFeedback(err.message, 'error', 'perksModalFeedback');
        }
      }
      renderAdminPerks();
    }

    async function setAdminPerk(perk, enabled) {
      const target = document.getElementById('adminInspectUser').value.trim();
      const body = { action: 'setPerk', targetUser: target, perk, enabled };
      if (perk === 'rarityBoost' && enabled) body.rarity = document.getElementById('adminPerkRarity').value;
      try {
        const data = await adminPerksRequest(body);
        showFeedback(data.message, 'success', 'perksModalFeedback');
      } catch (err) {
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
      renderAdminPerks();
    }

    async function grantAdminPerk(perk) {
      const target = document.getElementById('adminInspectUser').value.trim();
      const body = { action: 'grantPerk', targetUser: target, perk };
      if (perk === 'rarityBoost') body.rarity = document.getElementById('adminPerkRarity').value;
      try {
        const data = await adminPerksRequest(body);
        showFeedback(data.message, 'success', 'perksModalFeedback');
      } catch (err) {
        showFeedback(err.message, 'error', 'perksModalFeedback');
      }
      renderAdminPerks();
    }


    function openAwardModal() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) {
        showFeedback('Load a user first to award them items.', 'error', 'adminInvFeedback');
        return;
      }

      document.getElementById('awardModalUsername').textContent = `@${target}`;
      awardSelectedItems = [];
      awardModalFilterTab = 'all';
      document.getElementById('awardSearchInput').value = '';

      const modal = document.getElementById('awardItemsModal');
      const filterBtns = modal.querySelectorAll('.vault-filter-tabs .vault-tab-btn');
      filterBtns.forEach(btn => {
        if (btn.textContent.trim().toLowerCase() === 'all') btn.classList.add('active');
        else btn.classList.remove('active');
      });

      renderAwardCatalogGrid();
      renderAwardSelectedList();
      modal.classList.add('active');
    }

    function closeAwardModal() {
      document.getElementById('awardItemsModal').classList.remove('active');
    }

    function setAwardTab(tabName) {
      awardModalFilterTab = tabName;
      const modal = document.getElementById('awardItemsModal');
      const filterBtns = modal.querySelectorAll('.vault-filter-tabs .vault-tab-btn');
      filterBtns.forEach(btn => {
        if (btn.textContent.trim().toLowerCase() === tabName) btn.classList.add('active');
        else btn.classList.remove('active');
      });
      renderAwardCatalogGrid();
    }

    function renderAwardCatalogGrid() {
      const grid = document.getElementById('awardCatalogGrid');
      if (!grid) return;
      const scrollPos = grid.scrollTop;
      const searchQuery = document.getElementById('awardSearchInput').value.toLowerCase().trim();

      const catalog = getAwardCatalogItems().filter(item => {
        const matchesTab = awardModalFilterTab === 'all' || item.tierId === awardModalFilterTab;
        const matchesSearch = item.name.toLowerCase().includes(searchQuery);
        return matchesTab && matchesSearch;
      });

      window._awardCatalogArray = catalog;

      if (catalog.length === 0) {
        grid.innerHTML = `<div class="grid-empty grid-empty--tight">No matching items in the loot table.</div>`;
        return;
      }

      grid.innerHTML = catalog.map((item, idx) => {
        const isSelected = awardSelectedItems.some(sel => sel.name === item.name && sel.tierId === item.tierId);
        return `
          <div class="inventory-item-card ${isSelected ? 'selected' : ''}" id="award-item-${idx}" style="--slot-accent: ${item.accent};" onclick="toggleAwardItem(${idx})">
            <div class="item-info-group">
              <input type="checkbox" id="award-chk-${idx}" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleAwardItem(${idx})">
              <div class="fish-icon-frame">${icon(item.icon)}</div>
              <div class="item-text-details">
                <span class="item-name" title="${escText(item.name)}">${escText(item.name)}</span>
                <span class="item-rarity">${escText(item.label)}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

      grid.scrollTop = scrollPos;
    }

    function toggleAwardItem(idx) {
      const catalog = window._awardCatalogArray || [];
      const item = catalog[idx];
      if (!item) return;

      const existingIndex = awardSelectedItems.findIndex(sel => sel.name === item.name && sel.tierId === item.tierId);
      if (existingIndex > -1) {
        awardSelectedItems.splice(existingIndex, 1);
      } else {
        awardSelectedItems.push({ id: ++awardSelectedIdCounter, name: item.name, tierId: item.tierId, tierLabel: item.label, amount: 1 });
      }

      renderAwardCatalogGrid();
      renderAwardSelectedList();
    }

    function removeAwardItem(id) {
      awardSelectedItems = awardSelectedItems.filter(sel => sel.id !== id);
      renderAwardCatalogGrid();
      renderAwardSelectedList();
    }

    function updateAwardAmount(id, value) {
      const entry = awardSelectedItems.find(sel => sel.id === id);
      if (!entry) return;
      let amt = parseInt(value, 10);
      if (isNaN(amt) || amt < 1) amt = 1;
      if (amt > 99) amt = 99;
      entry.amount = amt;
      renderAwardSelectedList();
    }

    function renderAwardSelectedList() {
      const wrap = document.getElementById('awardSelectedList');
      const countLabel = document.getElementById('awardSelectedCount');
      if (countLabel) countLabel.textContent = awardSelectedItems.length;
      if (!wrap) return;

      if (awardSelectedItems.length === 0) {
        wrap.innerHTML = `<div class="award-selected-empty">No items selected yet. Click the items above to add them.</div>`;
        return;
      }

      wrap.innerHTML = awardSelectedItems.map(entry => `
        <div class="award-selected-row">
          <div class="award-selected-info">
            <span class="award-selected-name" title="${escText(entry.name)}">${escText(entry.name)}</span>
            <span class="award-selected-tier">${entry.tierLabel}</span>
          </div>
          <div class="award-selected-controls">
            <label class="award-amount-label" for="award-amt-${entry.id}">Qty</label>
            <input type="number" id="award-amt-${entry.id}" class="award-amount-input" min="1" max="99" value="${entry.amount}" onchange="updateAwardAmount(${entry.id}, this.value)">
            <button class="icon-btn" onclick="removeAwardItem(${entry.id})" title="Remove ${escText(entry.name)}" aria-label="Remove ${escText(entry.name)}">
              <svg class="ic" aria-hidden="true" focusable="false"><use href="#i-x"></use></svg>
            </button>
          </div>
        </div>
      `).join('');
    }

    async function confirmAwardItems() {
      const target = document.getElementById('adminInspectUser').value.trim();
      if (!target) {
        showFeedback('No target user loaded.', 'error', 'awardModalFeedback');
        return;
      }
      if (awardSelectedItems.length === 0) {
        showFeedback('Select at least one item to award.', 'error', 'awardModalFeedback');
        return;
      }

      const confirmBtn = document.getElementById('awardConfirmBtn');
      if (confirmBtn) confirmBtn.disabled = true;

      try {
        const res = await fetch('/api/admin/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            action: 'giveFishBatch',
            targetUser: target,
            items: awardSelectedItems.map(entry => ({ fish: entry.name, tier: entry.tierId.toUpperCase(), amount: entry.amount }))
          })
        });

        const result = await res.json();
        if (res.ok) {
          closeAwardModal();
          showFeedback(result.message || 'Successfully awarded items!', 'success', 'adminInvFeedback');
          refreshAdminInventory();
        } else {
          showFeedback(result.error || 'Failed to award items.', 'error', 'awardModalFeedback');
        }
      } catch (err) {
        showFeedback('Error executing award request.', 'error', 'awardModalFeedback');
      } finally {
        if (confirmBtn) confirmBtn.disabled = false;
      }
    }

    /* Past-tense labels for the admin toast headers. The backend message is
       used for the body, but the header needs a stable verb per action and
       the backend only has one per action for the happy path. */
    const ADMIN_ACTION_LABELS = {
      setGlobalEventLuck: 'Event started',
      clearGlobalEventLuck: 'Event cleared',
      resetAllFishMessages: 'Messages reset',
      clearUser: 'User wiped',
      wipeRarity: 'Rarity wiped',
      setCooldown: 'Cooldown updated',
      setLuck: 'Luck updated',
      giveFish: 'Fish awarded',
      giveFishBatch: 'Batch awarded',
      setPerk: 'Perk granted',
      removePerk: 'Perk removed',
      resetInventory: 'Inventory reset',
      clearAllBans: 'Bans cleared',
      createCustomTitle: 'Title created',
      assignCustomTitle: 'Title granted',
      revokeCustomTitle: 'Title revoked',
      createCustomAchievement: 'Achievement created',
      deleteCustomAchievement: 'Achievement deleted',
      updateCustomAchievement: 'Achievement updated',
      updateBuiltinAchievement: 'Achievement updated',
      updateCustomTitle: 'Title updated'
    };

    function syncAdminTitleColor(source){ const picker=document.getElementById('adminCustomTitleColor'); const hex=document.getElementById('adminCustomTitleColorHex'); if(!picker||!hex)return; const raw=String(source==='picker'?picker.value:hex.value||'#D7DDD9').trim().toUpperCase(); if(/^#[0-9A-F]{6}$/.test(raw)){ picker.value=raw.toLowerCase(); hex.value=raw; } }
    function resetAdminTitleColor(){ const picker=document.getElementById('adminCustomTitleColor'); const hex=document.getElementById('adminCustomTitleColorHex'); if(picker)picker.value='#d7ddd9'; if(hex)hex.value='#D7DDD9'; }
    document.addEventListener('DOMContentLoaded',()=>{ document.getElementById('adminCustomTitleColor')?.addEventListener('input',()=>syncAdminTitleColor('picker')); document.getElementById('adminCustomTitleColorHex')?.addEventListener('input',()=>syncAdminTitleColor('hex')); });

    async function loadAdminCustomTitles() {
      if (!isAdminLoggedIn || !authToken) return;
      try {
        const res = await fetch('/api/admin/action', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body:JSON.stringify({action:'listCustomTitles'}) });
        const data = await res.json(); if(!res.ok) throw new Error(data.error||'Could not load custom titles.');
        const select=document.getElementById('adminCustomTitleSelect');
        if(select) { select.innerHTML=(data.titles||[]).length ? data.titles.map(t=>`<option value="${escapeHtmlFishdex(t.id)}">${escText(t.name)}</option>`).join('') : '<option value="">No custom titles yet</option>'; refreshCustomSelect('adminCustomTitleSelect'); }
        window.__adminTitleCatalog=data.titles||[]; const list=document.getElementById('adminCustomTitleList');
        if(list) list.innerHTML=(data.titles||[]).length ? data.titles.map(t=>{const color=safeTitleColor(t.color)||'#D7DDD9'; return `<div class="admin-title-row"><span class="admin-title-swatch" style="background:${color}" aria-hidden="true"></span><div class="admin-title-meta"><div class="admin-title-name" style="color:${color}">${escText(t.name)}</div><div class="admin-title-desc">${escText(t.description||'Admin-created title.')} · <span class="admin-title-color">${color}</span></div></div><span class="achievement-status">${escText(t.createdBy||'Admin')}</span>${adminPenButton('title',t.id)}</div>`}).join('') : '<div class="log-placeholder">No custom titles created yet.</div>';
      } catch(e) { showFeedback(e.message,'error','adminFeedback'); }
    }
    function switchAdminBuilder(panel){
      const titles=panel==='titles';
      document.getElementById('adminBuilderTabTitles')?.classList.toggle('active',titles);
      document.getElementById('adminBuilderTabAchievements')?.classList.toggle('active',!titles);
      document.getElementById('adminBuilderTitles')?.classList.toggle('active',titles);
      document.getElementById('adminBuilderAchievements')?.classList.toggle('active',!titles);
      if(!titles) loadAdminGlobalAchievements();
    }
    async function loadAdminGlobalAchievements(){
      if(!isAdminLoggedIn || !authToken) return;
      try{
        const res=await fetch('/api/admin/action',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`},body:JSON.stringify({action:'listCustomAchievements'})});
        const data=await res.json(); if(!res.ok) throw new Error(data.error||'Could not load global achievements.');
        const typeNames=Object.fromEntries((data.types||[]).map(t=>[t.id,t.name]));
        window.__adminAchievementCatalog=[...(data.builtins||[]),...(data.achievements||[])]; const list=document.getElementById('adminGlobalAchievementList');
        if(list) list.innerHTML=(data.achievements||[]).length ? data.achievements.map(a=>`<div class="global-achievement-row"><span class="global-achievement-icon">${icon(a.icon||'trophy')}</span><div class="global-achievement-meta"><div class="global-achievement-name">${escText(a.name)}</div><div class="global-achievement-desc">${escText(a.desc||'Global achievement.')}${a.award?` · Title: ${escText(a.award)}`:''}</div></div><span class="global-achievement-type">${escText(typeNames[a.stat]||a.stat||'Achievement')}</span><span class="global-achievement-req">${Number(a.target||0).toLocaleString('en-US')} required ${adminPenButton('achievement',a.id)} <button class="danger-btn" type="button" onclick='adminGlobalAchievementAction("deleteCustomAchievement", ${JSON.stringify(a.id)})'><svg class="ic"><use href="#i-trash"></use></svg> Delete</button></span></div>`).join('') : '<div class="log-placeholder">No global achievements created yet.</div>';
      }catch(e){ showFeedback(e.message,'error','adminFeedback'); }
    }
    let adminEditCtx = null;
    function adminPenButton(kind, id){ if(!isAdminLoggedIn) return ''; return `<button class="admin-pen" type="button" title="Edit" aria-label="Edit" onclick='event.stopPropagation();openAdminEdit(${JSON.stringify(kind)},${JSON.stringify(String(id))})'>${icon('edit')}</button>`; }
    function adminFindEditable(kind,id){
      if(kind==='title') return (progressionData?.customTitles||[]).find(t=>t.id===id)||(window.__adminTitleCatalog||[]).find(t=>t.id===id)||null;
      return (progressionData?.achievements||[]).find(a=>a.id===id)||(window.__adminAchievementCatalog||[]).find(a=>a.id===id)||null;
    }
    function openAdminEdit(kind,id){
      if(!isAdminLoggedIn) return;
      const item=adminFindEditable(kind,id); if(!item){ toast('Could not find that item. Refresh and try again.','error',{label:'Edit failed'}); return; }
      const builtin=kind==='achievement'&&!!item.builtin;
      adminEditCtx={kind,id,builtin};
      const set=(i,v)=>{const el=document.getElementById(i); if(el) el.value=v;};
      const show=(i,on)=>{const el=document.getElementById(i); if(el) el.style.display=on?'':'none';};
      document.getElementById('adminEditHeading').textContent=kind==='title'?'Edit title':(builtin?'Edit built-in achievement':'Edit global achievement');
      document.getElementById('adminEditNote').textContent=builtin?'Built-in achievements keep their type and title reward. Cosmetics unlock by title name, so renaming a title would lock them.':'';
      set('adminEditName',item.name||''); set('adminEditDesc',(kind==='title'?item.description:item.desc)||'');
      document.getElementById('adminEditDesc').maxLength=kind==='title'?120:160; document.getElementById('adminEditName').maxLength=kind==='title'?32:48;
      show('adminEditTypeWrap',kind==='achievement'&&!builtin); show('adminEditReqWrap',kind==='achievement'); show('adminEditAwardWrap',kind==='achievement'&&!builtin); show('adminEditColorWrap',kind==='title');
      if(kind==='achievement'){ set('adminEditType',item.stat||'casts'); set('adminEditReq',item.target||1); set('adminEditAward',item.award||''); if(!builtin) refreshCustomSelect('adminEditType'); }
      if(kind==='title') set('adminEditColor',(safeTitleColor(item.color)||'#D7DDD9').toUpperCase());
      const err=document.getElementById('adminEditError'); err.textContent=''; err.classList.remove('show');
      document.getElementById('adminEditModal').classList.add('active');
    }
    function closeAdminEditModal(){ document.getElementById('adminEditModal')?.classList.remove('active'); adminEditCtx=null; }
    async function saveAdminEdit(){
      if(!adminEditCtx||!isAdminLoggedIn||!authToken) return;
      const {kind,id,builtin}=adminEditCtx; const val=(i)=>document.getElementById(i)?.value.trim()||'';
      const payload=kind==='title'
        ? {action:'updateCustomTitle',titleId:id,titleName:val('adminEditName'),titleDescription:val('adminEditDesc'),titleColor:val('adminEditColor')}
        : {action:builtin?'updateBuiltinAchievement':'updateCustomAchievement',achievementId:id,titleName:val('adminEditName'),titleDescription:val('adminEditDesc'),achievementRequirement:val('adminEditReq')};
      if(kind==='achievement'&&!builtin){ payload.achievementType=val('adminEditType'); payload.achievementAward=val('adminEditAward'); }
      const err=document.getElementById('adminEditError'); const btn=document.getElementById('adminEditSave'); btn.disabled=true;
      try{
        const res=await fetch('/api/admin/action',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`},body:JSON.stringify(payload)});
        const data=await res.json(); if(!res.ok) throw new Error(data.error||'Save failed.');
        closeAdminEditModal(); toast(data.message||'Saved.','success',{label:'Admin edit'});
        cachedLeaderboardData=null;
        await Promise.all([loadAdminCustomTitles(),loadAdminGlobalAchievements(),(typeof loadProgression==='function'?loadProgression(true):null)].filter(Boolean));
        renderAchievements(); renderTitles();
      }catch(e){ err.textContent=e.message; err.classList.add('show'); }
      finally{ btn.disabled=false; }
    }
    async function adminGlobalAchievementAction(actionType, achievementId=''){
      if(!isAdminLoggedIn || !authToken) return;
      const payload={action:actionType};
      if(actionType==='createCustomAchievement'){
        payload.titleName=document.getElementById('adminGlobalAchievementName')?.value.trim();
        payload.titleDescription=document.getElementById('adminGlobalAchievementDescription')?.value.trim();
        payload.achievementType=document.getElementById('adminGlobalAchievementType')?.value;
        payload.achievementRequirement=document.getElementById('adminGlobalAchievementRequirement')?.value;
        payload.achievementAward=document.getElementById('adminGlobalAchievementAward')?.value.trim()||'';
        if(!payload.titleName){showFeedback('Enter an achievement title first.','error','adminFeedback');return;}
        if(!Number.isInteger(Number(payload.achievementRequirement))||Number(payload.achievementRequirement)<1){showFeedback('Enter a whole-number requirement greater than 0.','error','adminFeedback');return;}
      } else payload.achievementId=achievementId;
      try{
        const res=await fetch('/api/admin/action',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`},body:JSON.stringify(payload)});
        const data=await res.json(); if(!res.ok) throw new Error(data.error||'Global achievement action failed.');
        showFeedback(data.message||`${ADMIN_ACTION_LABELS[actionType]||'Achievement action'} applied.`,'success','adminFeedback');
        if(actionType==='createCustomAchievement'){document.getElementById('adminGlobalAchievementName').value='';document.getElementById('adminGlobalAchievementDescription').value='';document.getElementById('adminGlobalAchievementRequirement').value='100';document.getElementById('adminGlobalAchievementAward').value='';}
        await loadAdminGlobalAchievements();
      }catch(e){showFeedback(e.message,'error','adminFeedback');}
    }

    async function adminCustomTitleAction(actionType) {
      if (!isAdminLoggedIn || !authToken) return;
      const payload={action:actionType};
      if(actionType==='createCustomTitle'){ payload.titleName=document.getElementById('adminCustomTitleName')?.value.trim(); payload.titleDescription=document.getElementById('adminCustomTitleDescription')?.value.trim(); payload.titleColor=(document.getElementById('adminCustomTitleColorHex')?.value||document.getElementById('adminCustomTitleColor')?.value||'#D7DDD9').trim(); if(!payload.titleName){showFeedback('Enter a title name first.','error','adminFeedback');return;} if(!safeTitleColor(payload.titleColor)){showFeedback('Use a valid hex color such as #FF6B4A.','error','adminFeedback');return;} }
      else { payload.targetUser=document.getElementById('adminCustomTitleTarget')?.value.trim(); payload.titleId=document.getElementById('adminCustomTitleSelect')?.value; if(!payload.targetUser||!payload.titleId){showFeedback('Choose both a player and a title.','error','adminFeedback');return;} }
      try { const res=await fetch('/api/admin/action',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`},body:JSON.stringify(payload)}); const data=await res.json(); if(!res.ok) throw new Error(data.error||'Admin title action failed.'); showFeedback(data.message||`${ADMIN_ACTION_LABELS[actionType]||'Title action'} applied.`,'success','adminFeedback'); if(actionType==='createCustomTitle'){document.getElementById('adminCustomTitleName').value='';document.getElementById('adminCustomTitleDescription').value='';resetAdminTitleColor();} await loadAdminCustomTitles(); cachedLeaderboardData=null; } catch(e){ showFeedback(e.message,'error','adminFeedback'); }
    }

    async function adminAction(actionType) {
      let payload = { 
        action: actionType
      };

      if (actionType === 'setGlobalEventLuck') {
        const eventName = document.getElementById('adminEventNameInput').value.trim();
        const multiplier = parseFloat(document.getElementById('adminEventMultiplierInput').value);
        if (isNaN(multiplier) || multiplier < 1.0) {
          showFeedback('Please enter a valid global event luck multiplier (>= 1.0).', 'error');
          return;
        }
        payload.eventName = eventName || 'Global Luck Event';
        payload.multiplier = multiplier;

        const durationRaw = document.getElementById('adminEventDurationInput').value;
        const durationUnit = document.getElementById('adminEventDurationUnit').value;
        const durationVal = parseFloat(durationRaw);
        if (!isNaN(durationVal) && durationVal > 0) {
          const unitToSeconds = { seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800 };
          payload.durationSeconds = Math.round(durationVal * (unitToSeconds[durationUnit] || 60));
        }
      } else if (actionType === 'clearGlobalEventLuck') {
        // no extra params needed
      } else if (actionType === 'resetAllFishMessages') {
        const confirmedReset = confirm('Reset the custom !fish message text of ALL players back to the system default? This cannot be undone.');
        if (!confirmedReset) return;
      } else if (actionType === 'clearUser') {
        const target = document.getElementById('targetUsername').value.trim();
        if (!target) {
          showFeedback('Please provide a target username to clear.', 'error');
          return;
        }
        const confirmed = confirm(`DANGER: Are you sure you want to completely wipe all user data, catches, inventories, area progress, and Auto-Fish progress for @${target}? This cannot be undone.`);
        if (!confirmed) return;
        payload.targetUser = target;
      } else if (actionType === 'wipeRarity') {
        const target = document.getElementById('targetUsername').value.trim();
        const rarityEl = document.getElementById('wipeRaritySelect');
        const rarityValue = rarityEl ? rarityEl.value : '';
        if (!target) {
          showFeedback('Please provide a target username first.', 'error');
          return;
        }
        if (!rarityValue) {
          showFeedback('Please choose a rarity to wipe.', 'error');
          return;
        }
        const rarityLabel = rarityEl.options[rarityEl.selectedIndex].text;
        const confirmedRarity = confirm(`Remove ALL ${rarityLabel} items from @${target}'s inventory? Nothing else will be changed. This cannot be undone.`);
        if (!confirmedRarity) return;
        payload.targetUser = target;
        payload.rarity = rarityValue;
      }

      try {
        const res = await fetch('/api/admin/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify(payload)
        });

        const result = await res.json();

        if (!res.ok || result.success === false) {
          showFeedback(
            stripChatGlyphs(result.error || result.message || `Server refused the action (${res.status}).`),
            'error',
            'adminFeedback',
            { label: 'Action not applied' }
          );
          return;
        }

        showFeedback(
          stripChatGlyphs(result.message || `${ADMIN_ACTION_LABELS[actionType] || 'Action'} applied.`),
          'success',
          'adminFeedback',
          { label: ADMIN_ACTION_LABELS[actionType] || 'Action applied' }
        );

        if (actionType === 'setGlobalEventLuck' || actionType === 'clearGlobalEventLuck') {
          checkGlobalEventStatus();
        }

        if (actionType === 'wipeRarity') {
          cachedLeaderboardData = null;
          const inspectedUser = document.getElementById('adminInspectUser').value.trim();
          if (inspectedUser && inspectedUser.toLowerCase() === payload.targetUser.toLowerCase()
              && document.getElementById('adminInvContainer')?.style.display !== 'none') {
            refreshAdminInventory();
          }
        }

        if (actionType === 'clearUser') {
          document.getElementById('targetUsername').value = '';
          const inspectedUser = document.getElementById('adminInspectUser').value.trim();
          if (inspectedUser && inspectedUser.toLowerCase() === payload.targetUser.toLowerCase()) {
            deselectAdminUser();
            showFeedback(
              `@${payload.targetUser} was wiped, so their inventory view was closed.`,
              'info',
              'adminInvFeedback'
            );
          }
        }
      } catch (err) {
        // A throw here means the request never completed. Claiming success
        // would tell the operator a destructive change landed when nothing did.
        showFeedback(
          `The request never reached the server, so nothing was changed. ${(err && err.message) || 'Network error'}`,
          'error',
          'adminFeedback',
          { label: 'Action not applied', ttl: 8000 }
        );
      }
    }

    /* ------------------------------------------------------------------
       FEEDBACK
       One entry point for every confirmation and every failure in the
       product.
       Toast-only: it raises a toast in the bottom-right region and
       nothing else. Inline slots were removed, so the toast is the
       single feedback channel.

       The `quiet` option suppresses the toast for high-frequency
       background polling that should not interrupt.
       ------------------------------------------------------------------ */
    function showFeedback(message, type = 'info', targetId = 'adminFeedback', opts = {}) {
      const text = String(message == null ? '' : message).trim();
      if (!text) return;

      // Toast-only. The inline slots are gone: every confirmation and every
      // failure lands in the bottom-right toast region, so there is exactly
      // one feedback channel. `targetId` is kept so the ~90 existing call
      // sites do not need to change.
      if (!opts.quiet) {
        toast(text, type, { label: opts.label, ttl: opts.ttl });
      }
    }

    async function checkGlobalEventStatus() {
      const bannerContainer = document.getElementById('globalEventBannerContainer');
      const luckTile = document.getElementById('statusLuckTile');
      const cooldownTile = document.getElementById('statusCooldownTile');
      try {
        const res = await fetch('/api/admin/action');
        const data = await res.json();

        // The cooldown seconds can come back under a few different key names
        // depending on the backend route that answered — check them all so the
        // tile populates on page load instead of only after an admin edits it.
        if (cooldownTile && data) {
          const cooldownValue = [data.cooldown, data.cooldownSeconds, data.fishCooldown, data.castCooldown, data.cooldownSecs]
            .find(v => v !== undefined && v !== null && v !== '');
          if (cooldownValue !== undefined) {
            cooldownTile.innerHTML = `${cooldownValue}<small>s</small>`;
            const input = document.getElementById('adminCooldownInput');
            if (input && !input.value) input.value = cooldownValue;
          }
        }

        if (eventCountdownTimer) {
          clearInterval(eventCountdownTimer);
          eventCountdownTimer = null;
        }

        if (data && data.success && data.globalLuck && data.globalLuck > 1.0) {
          eventExpiresAtMs = data.eventExpires || null;

          bannerContainer.innerHTML = `
            <div class="global-event-banner">
              <div class="event-lead">
                <span class="event-mark"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-bolt"></use></svg></span>
                <div>
                  <h4 class="event-title">Active global luck event: ${escText(data.eventName || 'Stream Boost')}</h4>
                  <p class="event-note">All community chat casts receive a server-wide <strong class="event-figure">${escText(String(data.globalLuck))}x</strong> luck multiplier.${eventExpiresAtMs ? ` Ends in <strong class="event-figure" id="eventCountdownSpan">--</strong>.` : ''}</p>
                </div>
              </div>
              <span class="event-status"><b>${escText(String(data.globalLuck))}x</b> active</span>
            </div>
          `;
          if (luckTile) luckTile.textContent = `${data.globalLuck}x, ${data.eventName || 'Active'}`;

          if (eventExpiresAtMs) {
            const tickCountdown = () => {
              const remainingMs = eventExpiresAtMs - Date.now();
              if (remainingMs <= 0) {
                clearInterval(eventCountdownTimer);
                eventCountdownTimer = null;
                checkGlobalEventStatus(); // event just expired server-side too — refresh and disable
                return;
              }
              const label = formatCountdown(remainingMs);
              const span = document.getElementById('eventCountdownSpan');
              if (span) span.textContent = label;
              const sub = document.getElementById('statusLuckSub');
              if (sub) sub.textContent = `Ends in ${label}`;
            };
            tickCountdown();
            eventCountdownTimer = setInterval(tickCountdown, 1000);
          } else {
            const sub = document.getElementById('statusLuckSub');
            if (sub) sub.textContent = 'No time limit. Server-wide multiplier';
          }
        } else {
          eventExpiresAtMs = null;
          bannerContainer.innerHTML = '';
          if (luckTile) luckTile.textContent = 'None';
          const sub = document.getElementById('statusLuckSub');
          if (sub) sub.textContent = 'Server-wide multiplier';
        }
      } catch (err) {
        bannerContainer.innerHTML = '';
        if (luckTile) luckTile.textContent = 'None';
      }
    }

    function formatCountdown(ms) {
      let totalSeconds = Math.max(0, Math.floor(ms / 1000));
      const weeks = Math.floor(totalSeconds / 604800); totalSeconds -= weeks * 604800;
      const days = Math.floor(totalSeconds / 86400); totalSeconds -= days * 86400;
      const hours = Math.floor(totalSeconds / 3600); totalSeconds -= hours * 3600;
      const minutes = Math.floor(totalSeconds / 60); totalSeconds -= minutes * 60;
      const seconds = totalSeconds;

      const parts = [];
      if (weeks > 0) parts.push(`${weeks}w`);
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
      return parts.slice(0, 2).join(' ');
    }

    /* ---------- My Fish Index tab ---------- */
    let fishdexRefreshedTimeout = null;
    async function refreshFishdex() {
      const icon = document.getElementById('fishdexRefreshIcon');
      const note = document.getElementById('fishdexRefreshedNote');
      const btn = document.getElementById('fishdexRefreshBtn');
      if (icon) icon.classList.add('spin');
      if (btn) btn.disabled = true;

      try {
        const startedAt = performance.now();
        const res = await fetch('/api/fishdex');
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        const data = await res.json();

        cachedFishdexData = data;
        renderFishdexData(data);

        if (note) {
          note.classList.remove('failed');
          note.innerHTML = `${icon('check')} Refreshed`;
        }

        // The inline note vanishes in under two seconds and sits next to the
        // button you just pressed. Neither is enough for a confirmation that
        // the numbers actually changed, so state them.
        const caught = Number(data.totalCaught ?? data.total ?? 0);
        const completion = Number(data.completionPct ?? data.percentComplete ?? 0);
        toast(
          caught
            ? `${caught.toLocaleString('en-US')} fish logged. Index ${completion.toFixed(1)}% complete, refreshed in ${Math.round(performance.now() - startedAt)} ms.`
            : 'Fish index refreshed from the local database. Nothing caught yet.',
          'success',
          { label: 'Index refreshed' }
        );
      } catch (err) {
        const detail = (err && err.message) || 'Unknown error';

        if (note) {
          note.classList.add('failed');
          note.innerHTML = `${icon('warn')} Refresh failed`;
        }

        showFeedback(
          `Could not refresh your fish index. ${detail}`,
          'error',
          'adminFeedback',
          { label: 'Index refresh failed', ttl: 7000 }
        );
      } finally {
        if (icon) icon.classList.remove('spin');
        if (btn) btn.disabled = false;
        if (note) {
          if (fishdexRefreshedTimeout) clearTimeout(fishdexRefreshedTimeout);
          note.classList.add('visible');
          fishdexRefreshedTimeout = setTimeout(() => note.classList.remove('visible'), 1800);
        }
      }
    }

    let broadcasterAdminAuthenticated = false;
    let broadcasterAdminEligible = false;
    let broadcasterAdminChannel = '';

    function openBroadcasterAdminTab() {
      if (!broadcasterAdminEligible && !broadcasterAdminAuthenticated) return;
      if (!broadcasterAdminAuthenticated) {
        openBroadcasterAdminLogin();
        return;
      }
      switchHubTab('broadcaster-admin');
      loadBroadcasterAdminTools();
    }

    async function syncBroadcasterAdmin() {
      const nav = document.getElementById('broadcasterAdminNavBtn');
      if (!currentFishdexLogin) {
        broadcasterAdminAuthenticated = false;
        broadcasterAdminEligible = false;
        broadcasterAdminChannel = '';
        if (nav) nav.style.display = 'none';
        return;
      }
      try {
        const res = await fetch('/api/broadcaster-admin', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        broadcasterAdminAuthenticated = !!data.authenticated;
        broadcasterAdminEligible = !!data.eligible;
        broadcasterAdminChannel = String(data.broadcaster || currentFishdexLogin).toLowerCase();
        if (nav) {
          nav.style.display = broadcasterAdminEligible || broadcasterAdminAuthenticated ? 'flex' : 'none';
          nav.title = broadcasterAdminAuthenticated ? 'Open your channel Admin panel' : 'Unlock your channel Admin panel';
        }
        if (broadcasterAdminAuthenticated) {
          const channel = document.getElementById('broadcasterAdminChannel');
          const role = document.getElementById('broadcasterAdminRole');
          const eventChannel = document.getElementById('badminEventChannel');
          if (channel) channel.textContent = `@${broadcasterAdminChannel}`;
          if (role) role.textContent = broadcasterAdminChannel;
          if (eventChannel) eventChannel.textContent = `@${broadcasterAdminChannel}`;
        }
        // The local unified control hub embeds this existing Broadcaster
        // Admin surface. Resolve its requested tab only after Fishdex has
        // established the viewer login and this endpoint has checked access.
        if (new URLSearchParams(window.location.search).get('localHubTab') === 'broadcaster') {
          if (broadcasterAdminAuthenticated) {
            switchHubTab('broadcaster-admin');
          } else if (broadcasterAdminEligible) {
            openBroadcasterAdminLogin();
          }
        }
      } catch (e) {
        broadcasterAdminAuthenticated = false;
        broadcasterAdminEligible = false;
        broadcasterAdminChannel = '';
        if (nav) nav.style.display = 'none';
      }
    }

    function openBroadcasterAdminLogin() {
      if (!broadcasterAdminEligible) return;
      const modal = document.getElementById('broadcasterAdminLoginModal');
      if (modal) modal.classList.add('active');
      const input = document.getElementById('broadcasterAdminPass');
      if (input) setTimeout(() => input.focus(), 50);
    }

    function closeBroadcasterAdminLogin() {
      const modal = document.getElementById('broadcasterAdminLoginModal');
      if (modal) modal.classList.remove('active');
      const error = document.getElementById('broadcasterAdminLoginError');
      if (error) error.style.display = 'none';
      const form = document.getElementById('broadcasterAdminLoginForm');
      if (form) form.reset();
    }

    async function submitBroadcasterAdminLogin(event) {
      event.preventDefault();
      const error = document.getElementById('broadcasterAdminLoginError');
      const password = document.getElementById('broadcasterAdminPass')?.value || '';
      try {
        const res = await fetch('/api/broadcaster-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'login', password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Admin authentication failed.');
        closeBroadcasterAdminLogin();
        await syncBroadcasterAdmin();
        switchHubTab('broadcaster-admin');
        await loadBroadcasterAdminTools();
        toast('Broadcaster Admin unlocked.', 'success', { label: 'Admin' });
      } catch (e) {
        if (error) {
          error.textContent = e.message || 'Invalid password. Please try again.';
          error.style.display = 'block';
        }
      }
    }

    async function broadcasterToolsRequest(body) {
      const res = await fetch('/api/broadcaster-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          broadcasterAdminAuthenticated = false;
          toast('Your Broadcaster Admin session expired. Please unlock Admin again.', 'error', { label: 'Admin session' });
        }
        throw new Error(data.error || `Broadcaster Admin request failed (${res.status}).`);
      }
      return data;
    }

    // Twitch verification card on the profile (see loadProfileTwitchVerify).
    let profileTwitchMode = 'connect';
    // Shown at most once per page load. Nothing is stored, so a reload shows it again.
    let twitchVerifyPromptShown = false;

    function openTwitchVerifyPrompt() {
      document.getElementById('twitchVerifyPromptModal')?.classList.add('active');
    }

    function closeTwitchVerifyPrompt() {
      document.getElementById('twitchVerifyPromptModal')?.classList.remove('active');
    }

    async function loadProfileTwitchVerify() {
      const box = document.getElementById('profileTwitchVerify');
      if (!box) return;
      let data = null;
      try {
        const res = await fetch('/api/auth/broadcaster-status', { cache: 'no-store' });
        data = res.ok ? await res.json() : null;
      } catch { data = null; }
      if (!data || !data.eligible) { box.style.display = 'none'; return; }

      const statusEl = document.getElementById('profileTwitchStatus');
      const noteEl = document.getElementById('profileTwitchNote');
      const connectBtn = document.getElementById('profileTwitchConnect');
      const disconnectBtn = document.getElementById('profileTwitchDisconnect');
      box.style.display = 'flex';
      if (data.connected) {
        const since = data.connectedAt ? new Date(data.connectedAt).toLocaleDateString() : '';
        statusEl.textContent = `Connected as ${data.login}`;
        noteEl.textContent = 'Mods, VIPs and subs in your chat get their luck from Twitch.' +
          (since ? ` Connected ${since}.` : '') + ' Role cache is refreshed about once per minute.';
      } else {
        statusEl.textContent = 'Not connected';
        noteEl.textContent = "Mod, VIP and sub luck isn't checked yet. Until you connect, luck comes from your bot's level data, or the base rate if there's none.";
      }

      profileTwitchMode = data.canManage ? 'connect' : 'unlock';
      const connectLabel = document.getElementById('profileTwitchConnectLabel') || connectBtn;
      connectLabel.textContent = !data.canManage ? 'Unlock Broadcaster Admin' : (data.connected ? 'Reconnect Twitch' : 'Connect Twitch');
      disconnectBtn.style.display = data.connected && data.canManage ? '' : 'none';

      if (!data.connected && !twitchVerifyPromptShown) {
        twitchVerifyPromptShown = true;
        openTwitchVerifyPrompt();
      }
    }

    async function runAdminTwitchDebug() {
      const resultEl = document.getElementById('adminTwitchDebugResult');
      const statusEl = document.getElementById('adminTwitchDebugStatus');
      const channelInput = document.getElementById('adminTwitchDebugChannel');
      const viewerInput = document.getElementById('adminTwitchDebugUser');
      if (!resultEl || !statusEl) return;
      const channel = String(channelInput?.value || '').trim().replace(/^@+/, '');
      const viewer = String(viewerInput?.value || '').trim().replace(/^@+/, '');
      if (!channel) { resultEl.className = 'admin-twitch-debug__result bad'; resultEl.textContent = 'Enter a streamer/channel first.'; statusEl.textContent = 'INPUT REQUIRED'; return; }
      statusEl.textContent = 'TESTING…'; resultEl.className = 'admin-twitch-debug__result'; resultEl.textContent = 'Checking Twitch broadcaster verification and role endpoints…';
      try {
        const qs = new URLSearchParams({ channel });
        if (viewer) qs.set('viewer', viewer);
        const res = await fetch(`/api/auth/broadcaster-debug?${qs.toString()}`, { cache: 'no-store', headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {} });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Diagnostic failed (${res.status}).`);
        const checks = data.checks || {};
        const lines = [
          `Channel: @${data.channel || channel}`,
          `Broadcaster connection: ${data.verified ? 'VERIFIED' : 'NOT VERIFIED'}`,
          `Stored Twitch login: ${data.broadcasterLogin ? '@' + data.broadcasterLogin : '—'}`,
          `Connected: ${data.connectedAt ? new Date(data.connectedAt).toLocaleString() : '—'}`,
          `Required scopes: ${data.missingScopes?.length ? 'MISSING ' + data.missingScopes.join(', ') : 'OK'}`,
          `Token refresh: ${data.tokenHealthy ? 'OK' : (data.verified ? 'FAILED / NOT TESTED' : '—')}`
        ];
        if (viewer) {
          lines.push(`Test user: @${data.viewer || viewer}`, `Twitch user found: ${data.viewerFound ? 'YES' : 'NO'}`, `Resolved role: ${String(data.role || 'unknown').toUpperCase()}${data.level ? ` (${data.level})` : ''}`, `Moderator check: ${checks.moderator ? (checks.moderator.match ? 'MATCH' : `no match (HTTP ${checks.moderator.status})`) : '—'}`, `VIP check: ${checks.vip ? (checks.vip.match ? 'MATCH' : `no match (HTTP ${checks.vip.status})`) : '—'}`, `Subscriber check: ${checks.subscriber ? (checks.subscriber.match ? 'MATCH' : `no match (HTTP ${checks.subscriber.status})`) : '—'}`);
        } else {
          lines.push('Viewer role: skipped — enter a viewer username to test Moderator/VIP/Subscriber luck.');
        }
        if (data.error) lines.push(`Problem: ${data.error}`);
        resultEl.textContent = lines.join('\n');
        const ok = !!data.verified && (!viewer || (!!data.tokenHealthy && !!data.viewerFound && !data.error));
        resultEl.className = `admin-twitch-debug__result ${ok ? 'ok' : 'bad'}`; statusEl.textContent = ok ? 'PASS' : 'CHECK RESULT';
      } catch (error) { statusEl.textContent = 'ERROR'; resultEl.className = 'admin-twitch-debug__result bad'; resultEl.textContent = error?.message || 'Diagnostic failed.'; }
    }

    function profileTwitchConnect() {
      if (profileTwitchMode === 'unlock') { openBroadcasterAdminTab(); return; }
      window.location.href = '/api/auth/broadcaster-connect';
    }

    async function profileTwitchDisconnect() {
      if (!confirm('Disconnect Twitch? Mod, VIP and sub luck will stop being checked in your chat until you reconnect.')) return;
      try {
        const res = await fetch('/api/auth/broadcaster-disconnect', { method: 'POST', cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not disconnect Twitch.');
      } catch (err) {
        alert(err.message || 'Could not disconnect Twitch.');
      }
      loadProfileTwitchVerify();
    }

    async function loadBroadcasterAdminTools() {
      if (!broadcasterAdminAuthenticated) return;
      try {
        const res = await fetch('/api/broadcaster-tools', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) {
            broadcasterAdminAuthenticated = false;
            throw new Error('Your Broadcaster Admin session is no longer valid. Unlock Admin again.');
          }
          throw new Error(data.error || `Could not load channel settings (${res.status}).`);
        }
        const cooldown = document.getElementById('badminCooldown');
        const stat = document.getElementById('broadcasterAdminCooldown');
        const simpleChatBox = document.getElementById('badminSimpleChat');
        if (simpleChatBox) simpleChatBox.checked = !!data.simpleChat;
        fillBroadcasterOverlay(data);
        if (cooldown) cooldown.value = Number(data.cooldown ?? 0);
        if (stat) stat.textContent = formatBroadcasterCooldown(data.cooldown, data.systemDefaultCooldown);
        const channel = document.getElementById('broadcasterAdminChannel');
        const eventChannel = document.getElementById('badminEventChannel');
        const role = document.getElementById('broadcasterAdminRole');
        if (channel) channel.textContent = `@${data.channel}`;
        if (eventChannel) eventChannel.textContent = `@${data.channel}`;
        window.__bcDenied = Array.isArray(data.denied) ? data.denied : [];
        applyBroadcasterDenials();
        if (role) role.textContent = data.channel;
        renderBroadcasterEventStatus(data.channelEvent, data.globalEvent);
        renderBroadcasterProgress(data.progress);
      } catch (e) {
        toast(e.message || 'Could not load channel settings.', 'error', { label: 'Admin' });
      }
    }

    // Tabs in the Broadcaster Admin panel (Overview, Shop, Settings, Inventory).
    function setBroadcasterAdminTab(name) {
      document.querySelectorAll('[data-badmin-panel]').forEach((panel) => {
        panel.classList.toggle('is-active', panel.dataset.badminPanel === name);
      });
      document.querySelectorAll('[data-badmin-tab]').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.badminTab === name);
      });
    }

    // Buy the next level of a channel upgrade from the Shop tab.
    async function buyChannelUpgradeFromPanel(upgradeId) {
      await runPurchase('channel-upgrade:' + upgradeId, async () => {
        try {
          const res = await fetch('/api/broadcaster-tools', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'buy-channel-upgrade', upgrade: upgradeId })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) throw new Error(data.error || 'Could not buy this upgrade.');
          toast(data.message || 'Upgrade bought.', 'success', { label: 'Channel shop' });
          refreshInBackground(() => loadBroadcasterAdminTools());
        } catch (err) {
          toast(err.message || 'Could not buy this upgrade.', 'error', { label: 'Channel shop' });
        }
      });
    }

    // Community catches, channel points, and the Go to Shop notification.
    function renderBroadcasterProgress(progress) {
      if (!progress) return;
      const ledger = document.getElementById('badminActiveBonuses');
      if (ledger) {
        const active = (progress.upgrades || []).filter((u) => u.level > 0);
        ledger.innerHTML = `
          <div class="badmin-bonus-head"><span>Active for viewers in this chat</span><span>${active.length} / ${(progress.upgrades || []).length}</span></div>
          ${active.length
            ? active.map((u) => `<div class="badmin-bonus-row"><span>${escText(u.name)}</span><span class="badmin-bonus-value">${escText(u.values[u.level - 1])}</span><span class="badmin-bonus-level">Lv ${Number(u.level)}/${Number(u.maxLevel)}</span></div>`).join('')
            : '<div class="badmin-bonus-empty">No bonuses yet. Viewers in this chat get the normal odds.</div>'}`;
      }
      const catches = document.getElementById('bcCommunityCatches');
      const points = document.getElementById('bcChannelPoints');
      const dot = document.getElementById('badminShopDot');
      const list = document.getElementById('badminShopList');
      if (catches) catches.textContent = Number(progress.catches || 0).toLocaleString();
      if (points) points.textContent = Number(progress.available ?? progress.points ?? 0).toLocaleString();
      if (dot) dot.hidden = !progress.shopAvailable || bcDenied('shopPurchases');
      if (list) {
        list.innerHTML = (progress.upgrades || []).map((u) => `
          <div class="badmin-upgrade-row">
            <div class="badmin-upgrade-copy">
              <strong>${escText(u.name)}</strong> <span class="micro-label">Level ${Number(u.level)}/${Number(u.maxLevel)}</span>
              <div class="badmin-section-copy">${escText(u.description)} Levels: ${u.values.map(escText).join(' → ')}</div>
            </div>
            ${u.nextCost === null
              ? '<button type="button" class="success-btn" disabled>Maxed</button>'
              : `<button type="button" class="success-btn" ${u.affordable && !bcDenied('shopPurchases') ? '' : 'disabled'} title="${bcDenied('shopPurchases') ? 'Turned off by MasterAdmin' : (u.affordable ? '' : 'Not enough channel points yet')}" onclick="buyChannelUpgradeFromPanel('${escText(u.id)}')">Buy · ${Number(u.nextCost).toLocaleString()} pts</button>`}
          </div>`).join('');
      }
    }

    function renderBroadcasterEventStatus(channelEvent, globalEvent) {
      const status = document.getElementById('badminEventStatus');
      const meta = document.getElementById('badminEventMeta');
      const global = document.getElementById('badminGlobalEventStatus');
      if (global) global.textContent = globalEvent?.active ? `Global event: ${globalEvent.multiplier}x` : 'Global event: inactive';
      if (!status || !meta) return;
      if (globalEvent?.active) {
        status.textContent = `Global event active · ${globalEvent.multiplier}x`;
        meta.textContent = `${globalEvent.name || 'Global Luck Event'} overrides this channel event while it is active.`;
      } else if (channelEvent?.active) {
        status.textContent = `${channelEvent.name || 'Channel Luck Event'} · ${channelEvent.multiplier}x`;
        meta.textContent = channelEvent.expiresAt ? `Ends ${new Date(channelEvent.expiresAt).toLocaleString()}` : 'Runs until you end it.';
      } else {
        status.textContent = 'No channel event active';
        meta.textContent = 'Start an event above. Global events are controlled by MasterAdmin.';
      }
    }

    // Sub-tabs inside the OBS overlay tab: Alerts (including the live feed) and Luck banner.
    function setOverlaySubTab(name) {
      document.querySelectorAll('[data-ov-sub]').forEach((el) => {
        const on = el.dataset.ovSub === name;
        el.classList.toggle('is-active', on);
        el.classList.toggle('active', on);
        if (el.tagName === 'BUTTON') el.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (name === 'luck') { paintLuckPreview(); paintLuckTiles(); }
    }

    function overlayUrlFor(channel, key) {
      return `${location.origin}/overlay.html?channel=${encodeURIComponent(channel)}&key=${encodeURIComponent(key)}`;
    }

    const OV_SAMPLE = { user: 'Viewer', fish: 'Golden Fish', rarity: 'LEGENDARY' };
    // Header sample for the alert preview: the same text a real catch shows.
    const OV_SAMPLE_STATS = '☘️2.5x · weight 1.2x';
    // Sample numbers for the banner's points bar and the {community} token in the alert preview.
    const OV_SAMPLE_POINTS = { maxed: false, available: 320, cost: 500, name: 'Channel luck', level: 1, pct: 320 / 500 };
    const OV_SAMPLE_COMMUNITY = 1284;
    // Header text for the preview: the sample luck and weight and/or the community count, as the switches choose.
    function ovPreviewStats(look) {
      const parts = [];
      if (look.alertStats) parts.push(OV_SAMPLE_STATS);
      if (look.alertCommunity) parts.push(OV_SAMPLE_COMMUNITY.toLocaleString('en-US') + ' community catches');
      return parts.join(' · ');
    }
    const OV_STYLE_VALUES = ['card', 'pill', 'banner', 'ticket', 'playful', 'glass', 'tag', 'terminal'];
    const OV_ANIM_VALUES = ['slide', 'fade', 'pop'];
    const OV_FONT_VALUES = ['display', 'body', 'mono', 'serif'];
    const OV_LUCK_SAMPLE_MS = ((30 + 3) * 86400 + 4 * 3600 + 5 * 60 + 6) * 1000;
    const OV_SAMPLE_START = Date.now();
    let ovLoopTimer = null;

    function ovEsc(value) {
      return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Same rule as the overlay page: literal text is escaped, token values are bold.
    function ovRenderTemplate(template, values) {
      return String(template).split(/(\{user\}|\{fish\}|\{rarity\})/).map((part) => {
        const m = part.match(/^\{(user|fish|rarity)\}$/);
        return m ? `<b>${ovEsc(values[m[1]])}</b>` : ovEsc(part);
      }).join('');
    }

    function ovVal(id) {
      const el = document.getElementById(id);
      if (!el) return undefined;
      return el.type === 'checkbox' ? el.checked : el.value;
    }

    function ovPick(name, fallback) {
      return document.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
    }

    // Colour on the tile samples and the alert preview. Rarity colour wins when it is on.
    function applyOverlayColour(el, accent, useRarity, tierId) {
      Array.from(el.classList).forEach((c) => { if (c.startsWith('ovx-rarity-')) el.classList.remove(c); });
      if (useRarity) {
        el.classList.add(`ovx-rarity-${tierId}`);
        el.style.removeProperty('--accent');
      } else {
        el.style.setProperty('--accent', accent);
      }
    }

    // The alert look shown in the preview. The test alert sends this same look.
    function currentOverlayLook() {
      return {
        style: ovPick('bovStyle', 'card'),
        animation: ovPick('bovAnim', 'slide'),
        animationMs: Number(ovVal('bovAnimMs')) || 420,
        font: ovPick('bovFont', 'display'),
        accent: (ovVal('bovAccent') || '#c9a227').toLowerCase(),
        rarityColors: !!ovVal('bovRarityColors'),
        alertTemplate: (ovVal('bovTemplate') || '').trim() || '{user} caught {fish}',
        alertTextScale: Number(ovVal('bovTextScale')) || 100,
        alertSize: Number(ovVal('bovAlertSize')) || 100,
        soundVolume: Number(ovVal('bovSoundVolume')) ?? 80,
        alertUpper: !!ovVal('bovAlertUpper'),
        showTier: !!ovVal('bovShowTier'),
        alertStats: !!ovVal('bovAlertStats'),
        alertCommunity: !!ovVal('bovAlertCommunity'),
        sound: !!ovVal('bovSound'),
        soundId: ovVal('bovSoundId') || 'chime',
        alertAlign: ovPick('bovAlign', 'center'),
        alertHorizontalPosition: ovPick('bovHorizontalPosition', 'center'),
        alertBg: ovBgValue('bovBgCustom', 'bovBg'),
        alertBgTransparency: Number(ovVal('bovBgTransparency')) || 0
      };
    }

    // The custom background colour, or '' for the style's own background.
    function ovBgValue(customId, colourId) {
      return ovVal(customId) ? (ovVal(colourId) || '#050807').toLowerCase() : '';
    }

    function currentLuckSettings() {
      return {
        accent: (ovVal('bovLuckAccent') || '#c9a227').toLowerCase(),
        luckScale: Number(ovVal('bovLuckScale')) || 100,
        luckTemplate: (ovVal('bovLuckTemplate') || '').trim() || '{name} · {multiplier}x luck · {time}',
        luckTimer: !!ovVal('bovLuckTimer'),
        luckStyle: ovPick('bovLuckStyle', 'bar'),
        luckAlign: ovPick('bovLuckAlign', 'center'),
        luckHorizontalPosition: ovPick('bovLuckHorizontalPosition', 'center'),
        luckBg: ovBgValue('bovLuckBgCustom', 'bovLuckBg'),
        luckBgTransparency: Number(ovVal('bovLuckBgTransparency')) || 0,
        pointsBar: !!ovVal('bovPointsBar'),
        pointsBarGoal: ovVal('bovPointsGoal') || 'luck',
        pointsBarColor: ovBgValue('bovPtsBarCustom', 'bovPtsBarColor')
      };
    }

    // Sample luck banner with a live countdown, drawn by the same renderer as the overlay.
    function paintLuckPreview() {
      const host = document.getElementById('bovLuckPreview');
      if (!host || !window.OverlayRender) return;
      const s = currentLuckSettings();
      const luckSide = ['left', 'center', 'right'].includes(s.luckHorizontalPosition) ? s.luckHorizontalPosition : 'center';
      const luckStage = host.closest('.ov-preview-stage');
      if (luckStage) luckStage.style.justifyContent = luckSide === 'left' ? 'flex-start' : luckSide === 'right' ? 'flex-end' : 'center';
      host.style.width = 'min(85%, 460px)';
      host.style.justifyContent = luckSide === 'left' ? 'flex-start' : luckSide === 'right' ? 'flex-end' : 'center';
      // The sample counts down from OV_LUCK_SAMPLE_MS and starts again when it reaches zero.
      const left = OV_LUCK_SAMPLE_MS - ((Date.now() - OV_SAMPLE_START) % OV_LUCK_SAMPLE_MS);
      const time = s.luckTimer ? window.OverlayRender.countdown(left) : '';
      let el = host.firstElementChild;
      if (!el) { el = document.createElement('div'); host.appendChild(el); }
      window.OverlayRender.paintLuck(el, s, { showText: true, name: 'Weekend Luck', multiplier: 2, time, points: OV_SAMPLE_POINTS });
      el.style.width = 'auto';
      el.style.margin = '0';
      const hex = document.getElementById('bovLuckHex');
      if (hex) hex.textContent = s.accent.toUpperCase();
    }

    // The luck style tiles show a sample banner in the current colour.
    function paintLuckTiles() {
      if (!window.OverlayRender) return;
      const accent = (ovVal('bovLuckAccent') || '#c9a227').toLowerCase();
      document.querySelectorAll('.ovx-luck[data-luck-style]').forEach((el) => {
        window.OverlayRender.paintLuck(el, { accent, luckScale: 100, luckStyle: el.dataset.luckStyle, luckTemplate: '{name} {multiplier}x' }, { name: 'Luck', multiplier: 2, time: '' });
      });
    }

    // Only a change of style, animation or font plays the entrance again.
    // Replay always plays it. Colour, text and size update in place.
    // The background colour is used only when its custom switch is on. Transparency always applies.
    function syncOverlayBgInputs() {
      [['bovBg', 'bovBgCustom', 'bovBgRow', 'bovBgHex'], ['bovLuckBg', 'bovLuckBgCustom', 'bovLuckBgRow', 'bovLuckBgHex'], ['bovPtsBarColor', 'bovPtsBarCustom', 'bovPtsBarRow', 'bovPtsBarHex', 'Banner colour']].forEach(([colourId, customId, rowId, hexId, offText = 'Style default']) => {
        const on = !!ovVal(customId);
        const input = document.getElementById(colourId);
        if (input) input.disabled = !on;
        document.getElementById(rowId)?.classList.toggle('is-disabled', !on);
        const hex = document.getElementById(hexId);
        if (hex) hex.textContent = on ? (ovVal(colourId) || '').toUpperCase() : offText;
      });
    }

    function updateOverlayPreview({ restart = false } = {}) {
      const look = currentOverlayLook();
      const tierId = ovVal('bovPreviewTier') || 'legendary';
      const tierLabel = document.querySelector(`#bovPreviewTier option[value="${tierId}"]`)?.textContent || 'Legendary';

      // The accent is disabled while rarity colours are on.
      const accentInput = document.getElementById('bovAccent');
      if (accentInput) accentInput.disabled = look.rarityColors;
      document.getElementById('bovAccentRow')?.classList.toggle('is-disabled', look.rarityColors);
      const hex = document.getElementById('bovHex');
      if (hex) hex.textContent = look.rarityColors ? 'Set by rarity' : look.accent.toUpperCase();

      // Options that some styles ignore are hidden for those styles: the terminal always uses mono text, and the pill has no rarity label.
      document.getElementById('bovFontField')?.toggleAttribute('hidden', look.style === 'terminal');
      document.getElementById('bovShowTierField')?.toggleAttribute('hidden', look.style === 'pill');

      syncOverlayBgInputs();
      const outputs = {
        bovSecondsOut: `${ovVal('bovSeconds')} s`,
        bovAnimMsOut: `${ovVal('bovAnimMs')} ms`,
        bovTextScaleOut: `${look.alertTextScale}%`,
        bovSoundVolumeOut: `${ovVal('bovSoundVolume')}%`,
        bovAlertSizeOut: `${look.alertSize}%`,
        bovLuckScaleOut: `${ovVal('bovLuckScale')}%`,
        bovBgTransparencyOut: `${ovVal('bovBgTransparency')}%`,
        bovLuckBgTransparencyOut: `${ovVal('bovLuckBgTransparency')}%`
      };
      Object.entries(outputs).forEach(([id, text]) => { const el = document.getElementById(id); if (el) el.textContent = text; });
      document.getElementById('bovSoundRow')?.toggleAttribute('hidden', !look.sound);

      // Style tiles follow the same colour rule.
      document.querySelectorAll('.ov-tile-sample').forEach((el) => {
        el.style.setProperty('--accent', look.accent);
        const alert = el.querySelector('.ovx-alert');
        if (alert) applyOverlayColour(alert, look.accent, look.rarityColors, tierId);
      });

      const host = document.getElementById('bovPreviewHost');
      if (host && window.OverlayRender) {
        const horizontalSide = ['left', 'center', 'right'].includes(look.alertHorizontalPosition) ? look.alertHorizontalPosition : 'center';
        host.dataset.horizontalPosition = horizontalSide;
        host.style.width = 'min(85%, 460px)';
        const stage = host.closest('.ov-preview-stage');
        if (stage) stage.style.justifyContent = horizontalSide === 'left' ? 'flex-start' : horizontalSide === 'right' ? 'flex-end' : 'center';
        const data = { user: OV_SAMPLE.user, fish: OV_SAMPLE.fish, rarity: tierLabel.toUpperCase(), tierId, stats: ovPreviewStats(look), community: OV_SAMPLE_COMMUNITY };
        const key = `${look.style}|${look.animation}|${look.font}`;
        let el = host.firstElementChild;
        if (restart || !el || el.dataset.key !== key) {
          el = window.OverlayRender.build(look, data);
          el.dataset.key = key;
          host.replaceChildren(el);
          window.OverlayRender.enter(el, look.animation, look.animationMs, look.alertHorizontalPosition);
        } else {
          window.OverlayRender.paint(el, look, data);
        }
      }
      paintLuckPreview();
      paintLuckTiles();
      const count = document.getElementById('bovCount');
      if (count) count.textContent = String((ovVal('bovTemplate') || '').length);
    }

    function replayOverlayPreview() {
      updateOverlayPreview({ restart: true });
    }

    // Loop replays the alert after it has finished, so the whole entrance and exit can be checked.
    function syncOverlayLoop() {
      if (ovLoopTimer) { clearInterval(ovLoopTimer); ovLoopTimer = null; }
      if (!ovVal('bovLoop')) return;
      const ms = Math.max(3, Number(ovVal('bovSeconds')) || 6) * 1000 + 1400;
      ovLoopTimer = setInterval(() => updateOverlayPreview({ restart: true }), ms);
    }

    function insertInto(id, token, max) {
      const t = document.getElementById(id);
      if (!t) return;
      const start = t.selectionStart ?? t.value.length;
      const end = t.selectionEnd ?? start;
      t.value = (t.value.slice(0, start) + token + t.value.slice(end)).slice(0, max);
      t.focus();
      t.setSelectionRange(start + token.length, start + token.length);
      markOverlayDirty();
    }

    function insertOverlayToken(token) { insertInto('bovTemplate', token, 120); }
    function insertLuckToken(token) { insertInto('bovLuckTemplate', token, 100); }

    function previewOverlaySound() {
      window.OverlaySounds?.play(ovVal('bovSoundId') || 'chime', Number(ovVal('bovSoundVolume')));
    }

    function toggleOverlayLink() {
      const el = document.getElementById('bovUrl');
      const btn = document.getElementById('bovRevealBtn');
      if (!el) return;
      const reveal = el.type === 'password';
      el.type = reveal ? 'text' : 'password';
      if (btn) btn.textContent = reveal ? 'Hide' : 'Show';
    }

    async function copyOverlayLink() {
      const el = document.getElementById('bovUrl');
      if (!el?.value) { toast('Load the overlay settings first.', 'error', { label: 'OBS overlay' }); return; }
      try {
        await navigator.clipboard.writeText(el.value);
        toast('Overlay link copied. Keep it private.', 'success', { label: 'OBS overlay' });
      } catch (e) {
        toast('Could not copy. Click Show and copy the link by hand.', 'error', { label: 'OBS overlay' });
      }
    }

    // Any change in the overlay tabs marks every Save row as unsaved.
    function markOverlayDirty() {
      document.querySelectorAll('.ov-dirty').forEach((el) => { el.textContent = 'Unsaved changes'; el.classList.add('is-dirty'); });
      updateOverlayPreview();
    }

    function setOverlayClean() {
      document.querySelectorAll('.ov-dirty').forEach((el) => { el.textContent = 'Saved'; el.classList.remove('is-dirty'); });
    }

    // The preview rarity and loop switches are not saved settings, so they do not mark the panel.
    const ovDirtyFrom = (e) => e.target.closest?.('.ov-layout') && !['bovPreviewTier', 'bovLoop'].includes(e.target.id);
    document.addEventListener('input', (e) => { if (ovDirtyFrom(e)) markOverlayDirty(); });
    document.addEventListener('change', (e) => { if (ovDirtyFrom(e)) markOverlayDirty(); });
    document.addEventListener('change', (e) => { if (e.target.id === 'bovPreviewTier') updateOverlayPreview({ restart: true }); });
    document.addEventListener('change', (e) => { if (e.target.id === 'bovAnimMs') updateOverlayPreview({ restart: true }); });
    document.addEventListener('change', (e) => { if (e.target.id === 'bovLoop' || e.target.id === 'bovSeconds') syncOverlayLoop(); });
    document.addEventListener('input', (e) => { if (e.target.id === 'bovSeconds') syncOverlayLoop(); });
    setInterval(paintLuckPreview, 1000);

    // The status pill follows the Overlay on switch straight away, not only after a save.
    function setOverlayStatus(on) {
      const status = document.getElementById('bovStatus');
      if (!status) return;
      status.textContent = on ? 'On' : 'Off';
      status.classList.toggle('is-on', !!on);
    }
    // The hide !fish switch works only while the overlay is on. Turning the overlay off clears it.
    function syncHideChatLock() {
      const on = !!ovVal('bovEnabled');
      const box = document.getElementById('bovHideChat');
      if (box) { box.disabled = !on; if (!on) box.checked = false; }
      document.getElementById('bovHideChatRow')?.classList.toggle('is-disabled', !on);
    }
    document.addEventListener('change', (e) => {
      if (e.target.id !== 'bovEnabled') return;
      setOverlayStatus(e.target.checked);
      syncHideChatLock();
    });

    function syncPointsBarGoalLock() {
      const on = !!ovVal('bovPointsBar');
      const row = document.getElementById('bovPointsGoalRow');
      if (row) row.hidden = !on;
    }
    document.addEventListener('change', (e) => {
      if (e.target.id !== 'bovPointsBar') return;
      syncPointsBarGoalLock();
    });

    function fillBroadcasterOverlay(data) {
      const o = data.overlay || {};
      const set = (id, value) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = value ?? '';
      };
      const radio = (name, value) => {
        const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
        if (input) input.checked = true;
      };
      set('bovEnabled', o.enabled);
      set('bovLuck', o.luckBanner);
      set('bovLuckTimer', o.luckTimer ?? true);
      set('bovLuckTemplate', o.luckTemplate ?? '{name} · {multiplier}x luck · {time}');
      set('bovLuckScale', o.luckScale ?? 100);
      set('bovLuckAccent', o.luckAccent ?? '#c9a227');
      set('bovSound', o.sound);
      set('bovSoundId', o.soundId);
      set('bovHideChat', data.hideFishChat);
      set('bovMinTier', o.minTier);
      set('bovSeconds', o.alertSeconds);
      set('bovAccent', o.accent);
      set('bovRarityColors', o.rarityColors);
      set('bovAnimMs', o.animationMs ?? 420);
      set('bovTextScale', o.alertTextScale ?? 100);
      set('bovAlertSize', o.alertSize ?? 100);
      set('bovSoundVolume', o.soundVolume ?? 80);
      set('bovAlertUpper', o.alertUpper);
      set('bovShowTier', o.showTier ?? true);
      set('bovAlertStats', o.alertStats);
      set('bovAlertCommunity', o.alertCommunity);
      set('bovNewFish', o.newFishAlert);
      set('bovPointsBar', o.pointsBar);
      set('bovPointsGoal', ['luck', 'rarity', 'lucky-chat'].includes(o.pointsBarGoal) ? o.pointsBarGoal : 'luck');
      set('bovPtsBarCustom', !!o.pointsBarColor);
      set('bovPtsBarColor', o.pointsBarColor || '#c9a227');
      set('bovIgnored', (o.ignoredViewers || []).join('\n'));
      radio('bovLuckPosition', o.luckPosition === 'bottom' ? 'bottom' : 'top');
      radio('bovLuckHorizontalPosition', ['left', 'center', 'right'].includes(o.luckHorizontalPosition) ? o.luckHorizontalPosition : (['left', 'center', 'right'].includes(o.luckAlign) ? o.luckAlign : 'center'));
      set('bovTemplate', o.alertTemplate ?? '{user} caught {fish}');
      radio('bovPosition', o.position === 'bottom' ? 'bottom' : 'top');
      radio('bovHorizontalPosition', ['left', 'center', 'right'].includes(o.alertHorizontalPosition) ? o.alertHorizontalPosition : 'center');
      radio('bovStyle', o.style || 'card');
      radio('bovAnim', o.animation || 'slide');
      radio('bovFont', o.font || 'display');
      radio('bovLuckStyle', o.luckStyle || 'bar');
      radio('bovAlign', o.alertAlign || 'center');
      radio('bovLuckAlign', o.luckAlign || 'center');
      set('bovBgCustom', !!o.alertBg);
      set('bovBg', o.alertBg || '#050807');
      set('bovBgTransparency', o.alertBgTransparency ?? 0);
      set('bovLuckBgCustom', !!o.luckBg);
      set('bovLuckBg', o.luckBg || '#050807');
      set('bovLuckBgTransparency', o.luckBgTransparency ?? 0);
      ['bovSoundId', 'bovMinTier', 'bovPointsGoal'].forEach(refreshCustomSelect);
      setOverlayStatus(!!o.enabled);
      syncHideChatLock();
      syncPointsBarGoalLock();
      const url = document.getElementById('bovUrl');
      if (url && data.overlayKey) url.value = overlayUrlFor(data.channel, data.overlayKey);
      updateOverlayPreview();
      setOverlayClean();
    }

    async function saveBroadcasterOverlay({ silent = false } = {}) {
      const seconds = Number(ovVal('bovSeconds'));
      if (!Number.isFinite(seconds) || seconds < 3 || seconds > 30) {
        toast('Show alerts for 3 to 30 seconds.', 'error', { label: 'OBS overlay' });
        return false;
      }
      const template = (ovVal('bovTemplate') || '').trim();
      if (!template) {
        toast('The alert message cannot be empty.', 'error', { label: 'OBS overlay' });
        return false;
      }
      try {
        const saved = await broadcasterToolsRequest({
          action: 'set-overlay',
          settings: {
            enabled: ovVal('bovEnabled'),
            luckBanner: ovVal('bovLuck'),
            luckTimer: ovVal('bovLuckTimer'),
            luckTemplate: (ovVal('bovLuckTemplate') || '').trim() || '{name} · {multiplier}x luck · {time}',
            luckScale: Number(ovVal('bovLuckScale')) || 100,
            luckAccent: ovVal('bovLuckAccent'),
            alertSize: Number(ovVal('bovAlertSize')) || 100,
            luckStyle: ovPick('bovLuckStyle', 'bar'),
            luckPosition: ovPick('bovLuckPosition', 'top'),
            luckHorizontalPosition: ovPick('bovLuckHorizontalPosition', 'center'),
            soundVolume: Number(ovVal('bovSoundVolume')) ?? 80,
            alertUpper: !!ovVal('bovAlertUpper'),
            showTier: !!ovVal('bovShowTier'),
            alertStats: !!ovVal('bovAlertStats'),
            alertCommunity: !!ovVal('bovAlertCommunity'),
            newFishAlert: !!ovVal('bovNewFish'),
            pointsBar: !!ovVal('bovPointsBar'),
            pointsBarGoal: ovVal('bovPointsGoal') || 'luck',
            pointsBarColor: ovBgValue('bovPtsBarCustom', 'bovPtsBarColor'),
            ignoredViewers: ovVal('bovIgnored') || '',
            sound: ovVal('bovSound'),
            soundId: ovVal('bovSoundId') || 'chime',
            minTier: ovVal('bovMinTier'),
            alertSeconds: seconds,
            position: ovPick('bovPosition', 'top'),
            alertHorizontalPosition: ovPick('bovHorizontalPosition', 'center'),
            accent: ovVal('bovAccent'),
            rarityColors: !!ovVal('bovRarityColors'),
            alertTemplate: template,
            alertTextScale: Number(ovVal('bovTextScale')) || 100,
            style: ovPick('bovStyle', 'card'),
            animation: ovPick('bovAnim', 'slide'),
            animationMs: Number(ovVal('bovAnimMs')) || 420,
            font: ovPick('bovFont', 'display'),
            alertAlign: ovPick('bovAlign', 'center'),
            alertBg: ovBgValue('bovBgCustom', 'bovBg'),
            alertBgTransparency: Number(ovVal('bovBgTransparency')) || 0,
            luckAlign: ovPick('bovLuckAlign', 'center'),
            luckBg: ovBgValue('bovLuckBgCustom', 'bovLuckBg'),
            luckBgTransparency: Number(ovVal('bovLuckBgTransparency')) || 0
          }
        });
        const hide = await broadcasterToolsRequest({ action: 'set-hide-fish-chat', enabled: !!ovVal('bovHideChat') });
        fillBroadcasterOverlay({ overlay: saved.overlay, hideFishChat: !!hide.hideFishChat, channel: null, overlayKey: null });
        if (!silent) toast('Overlay saved.', 'success', { label: 'OBS overlay' });
        return true;
      } catch (e) {
        toast(e.message || 'Could not save the overlay.', 'error', { label: 'OBS overlay' });
        return false;
      }
    }

    async function testBroadcasterOverlay() {
      // The test alert is the preview on screen, so no save is needed first.
      try {
        await broadcasterToolsRequest({
          action: 'overlay-test',
          tierId: ovVal('bovPreviewTier') || 'legendary',
          preview: currentOverlayLook()
        });
        toast('Test alert sent to the overlay.', 'success', { label: 'OBS overlay' });
      } catch (e) {
        toast(e.message || 'Could not send a test alert.', 'error', { label: 'OBS overlay' });
      }
    }

    async function rotateBroadcasterOverlayKey() {
      if (!confirm('Create a new overlay link? The old link will stop working.')) return;
      try {
        const data = await broadcasterToolsRequest({ action: 'overlay-rotate-key' });
        const url = document.getElementById('bovUrl');
        if (url) url.value = overlayUrlFor(data.channel, data.overlayKey);
        toast('New overlay link created. Update your Browser Source.', 'success', { label: 'OBS overlay' });
      } catch (e) {
        toast(e.message || 'Could not create a new link.', 'error', { label: 'OBS overlay' });
      }
    }

    async function saveBroadcasterSimpleChat(enabled) {
      const box = document.getElementById('badminSimpleChat');
      try {
        const data = await broadcasterToolsRequest({ action: 'set-simple-chat', enabled: !!enabled });
        if (box) box.checked = !!data.simpleChat;
        toast(`Simple chat is ${data.simpleChat ? 'on' : 'off'}.`, 'success', { label: 'Simple chat' });
      } catch (e) {
        if (box) box.checked = !enabled;
        toast(e.message || 'Could not save simple chat.', 'error', { label: 'Simple chat' });
      }
    }

    function formatBroadcasterCooldown(seconds, systemDefaultCooldown) {
      const value = Number(seconds);
      if (Number.isFinite(value) && value > 0) return `${Math.round(value)}s`;
      const fallback = Number(systemDefaultCooldown);
      const defaultSeconds = Number.isFinite(fallback) && fallback >= 0 ? Math.round(fallback) : 60;
      return `System default (${defaultSeconds}s)`;
    }

    async function saveBroadcasterCooldown() {
      const input = document.getElementById('badminCooldown');
      const btn = document.getElementById('badminCooldownBtn');
      const seconds = Number(input?.value);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
        toast('Enter a cooldown from 0 to 86400 seconds.', 'error', { label: 'Cooldown' }); return;
      }
      if (btn) btn.disabled = true;
      try {
        const data = await broadcasterToolsRequest({ action: 'set-channel-cooldown', seconds: Math.round(seconds) });
        const displayCooldown = formatBroadcasterCooldown(data.cooldown, data.systemDefaultCooldown);
        document.getElementById('broadcasterAdminCooldown').textContent = displayCooldown;
        toast(`Your channel cooldown is now ${displayCooldown}.`, 'success', { label: 'Cooldown saved' });
      } catch (e) { toast(e.message, 'error', { label: 'Cooldown' }); }
      finally { if (btn) btn.disabled = false; }
    }

    async function startBroadcasterEvent() {
      const name = String(document.getElementById('badminEventName')?.value || '').trim();
      const multiplier = Number(document.getElementById('badminEventMultiplier')?.value);
      const durationSeconds = Number(document.getElementById('badminEventDuration')?.value);
      if (!name) { toast('Give the event a name first.', 'error', { label: 'Event' }); return; }
      if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5) { toast('Use a multiplier between 1x and 5x.', 'error', { label: 'Event' }); return; }
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 2592000) { toast('Duration must be 0 to 2,592,000 seconds.', 'error', { label: 'Event' }); return; }
      const btn = document.getElementById('badminStartEventBtn');
      if (btn) btn.disabled = true;
      try {
        await broadcasterToolsRequest({ action:'start-channel-event', eventName:name, multiplier, durationSeconds:Math.round(durationSeconds) });
        await loadBroadcasterAdminTools();
        toast(`${name} started at ${multiplier}x.`, 'success', { label: 'Channel event' });
      } catch (e) { toast(e.message, 'error', { label: 'Event' }); }
      finally { if (btn) btn.disabled = false; }
    }

    async function endBroadcasterEvent() {
      if (!confirm('End your channel luck event now?')) return;
      const btn = document.getElementById('badminEndEventBtn');
      if (btn) btn.disabled = true;
      try {
        await broadcasterToolsRequest({ action:'end-channel-event' });
        await loadBroadcasterAdminTools();
        toast('Channel event ended.', 'success', { label: 'Channel event' });
      } catch (e) { toast(e.message, 'error', { label: 'Event' }); }
      finally { if (btn) btn.disabled = false; }
    }

    let broadcasterInventoryItems = [];
    let broadcasterInventoryDisplayItems = [];
    let broadcasterVaultFilterTab = 'all';

    function setBroadcasterVaultTab(tabName) {
      broadcasterVaultFilterTab = tabName;
      document.querySelectorAll('[data-badmin-vault-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.badminVaultTab === tabName);
      });
      renderBroadcasterInventoryGrid();
    }

    function filterBroadcasterInventory() {
      renderBroadcasterInventoryGrid();
    }

    function renderBroadcasterInventoryGrid() {
      const grid = document.getElementById('badminInvGrid');
      const countEl = document.getElementById('badminInventoryCount');
      if (!grid) return;

      const query = String(document.getElementById('badminVaultSearchInput')?.value || '').trim().toLowerCase();
      const groups = {};
      broadcasterInventoryItems.forEach(raw => {
        const parsed = parseRareCatchString(String(raw));
        const tierName = parsed.tierName || 'COMMON';
        const details = getTierDisplayByName(tierName);
        const key = `${parsed.name.toLowerCase()}_${details.tierId}`;
        if (!groups[key]) {
          groups[key] = { name: parsed.name, tier: tierName, count: 0, rawStrings: [] };
        }
        groups[key].count += 1;
        groups[key].rawStrings.push(String(raw));
      });

      let items = Object.values(groups).map((group, originalIndex) => {
        const details = getTierDisplayByName(group.tier);
        return { ...group, originalIndex, tierId: details.tierId, label: details.label, accent: details.accent, icon: details.icon };
      });

      if (broadcasterVaultFilterTab !== 'all') {
        items = items.filter(item => item.tierId === broadcasterVaultFilterTab);
      }
      if (query) {
        items = items.filter(item => `${item.name} ${item.label}`.toLowerCase().includes(query));
      }

      broadcasterInventoryDisplayItems = items;
      if (countEl) countEl.textContent = `${items.length} item${items.length === 1 ? '' : 's'} shown`;
      if (!items.length) {
        grid.innerHTML = `<div class="grid-empty">${broadcasterInventoryItems.length ? 'No inventory items match these filters.' : 'Load a viewer to inspect their inventory.'}</div>`;
        updateBroadcasterDeleteButton();
        return;
      }

      grid.innerHTML = items.map(item => `
        <div class="inventory-item-card" id="badmin-item-${item.originalIndex}" style="--slot-accent: ${item.accent};" onclick="toggleBroadcasterItemSelect(${item.originalIndex})">
          <div class="item-info-group">
            <input type="checkbox" id="badmin-chk-${item.originalIndex}" onclick="event.stopPropagation(); toggleBroadcasterItemSelect(${item.originalIndex})">
            <div class="fish-icon-frame">${icon(item.icon)}</div>
            <div class="item-text-details">
              <span class="item-name" title="${escText(item.name)}">${escText(item.name)}</span>
              <span class="item-rarity">${escText(item.label)}</span>
            </div>
          </div>
          <span class="item-quantity-badge">x${item.count}</span>
        </div>
      `).join('');
      updateBroadcasterDeleteButton();
    }

    async function loadBroadcasterInventory() {
      const input = document.getElementById('badminInventoryUser');
      const targetUser = String(input?.value || '').trim().toLowerCase().replace(/^@/,'');
      if (!/^[a-z0-9_]{1,25}$/.test(targetUser)) {
        toast('Enter a valid Twitch username.', 'error', { label:'Inventory' }); return;
      }
      const grid = document.getElementById('badminInvGrid');
      if (grid) grid.innerHTML = '<div class="grid-empty">Loading inventory…</div>';
      try {
        const data = await broadcasterToolsRequest({ action:'get-inventory', targetUser });
        broadcasterInventoryItems = Array.isArray(data.items) ? data.items.map(String) : [];
        broadcasterVaultFilterTab = 'all';
        document.querySelectorAll('[data-badmin-vault-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.badminVaultTab === 'all'));
        const search = document.getElementById('badminVaultSearchInput');
        if (search) search.value = '';
        renderBroadcasterInventoryGrid();
      } catch (e) {
        if (grid) grid.innerHTML = `<div class="grid-empty">${escapeHtml(e.message || 'Could not load inventory.')}</div>`;
        const countEl = document.getElementById('badminInventoryCount');
        if (countEl) countEl.textContent = '0 items shown';
      }
    }

    function toggleBroadcasterItemSelect(idx) {
      const card = document.getElementById(`badmin-item-${idx}`);
      const chk = document.getElementById(`badmin-chk-${idx}`);
      if (!card || !chk) return;
      chk.checked = !chk.checked;
      card.classList.toggle('selected', chk.checked);
      updateBroadcasterDeleteButton();
    }

    function toggleBroadcasterInventorySelectAll(select) {
      document.querySelectorAll('#badminInvGrid .inventory-item-card').forEach(card => {
        const idx = card.id.replace('badmin-item-', '');
        const chk = document.getElementById(`badmin-chk-${idx}`);
        if (chk) {
          chk.checked = !!select;
          card.classList.toggle('selected', !!select);
        }
      });
      updateBroadcasterDeleteButton();
    }

    function updateBroadcasterDeleteButton() {
      const btn = document.getElementById('badminDeleteBtn');
      if (btn) btn.disabled = !document.querySelector('#badminInvGrid input[type="checkbox"]:checked');
    }

    async function deleteBroadcasterInventory() {
      const targetUser = String(document.getElementById('badminInventoryUser')?.value || '').trim().toLowerCase().replace(/^@/,'');
      const selected = [];
      broadcasterInventoryDisplayItems.forEach(item => {
        const chk = document.getElementById(`badmin-chk-${item.originalIndex}`);
        if (chk?.checked) selected.push(...item.rawStrings);
      });
      if (!selected.length) return;
      if (!confirm(`Permanently delete ${selected.length} selected inventory item${selected.length === 1 ? '' : 's'} from @${targetUser}?`)) return;
      const btn = document.getElementById('badminDeleteBtn');
      if (btn) btn.disabled = true;
      try {
        const data = await broadcasterToolsRequest({ action:'multi-delete-fish', targetUser, items:selected });
        toast(data.message || 'Selected inventory items deleted.', 'success', { label:'Inventory' });
        await loadBroadcasterInventory();
      } catch (e) {
        toast(e.message || 'Could not delete selected inventory items.', 'error', { label:'Inventory' });
        updateBroadcasterDeleteButton();
      }
    }

    async function logoutBroadcasterAdmin() {
      try {
        await fetch('/api/broadcaster-admin', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'logout'}) });
      } finally {
        broadcasterAdminAuthenticated = false;
        const nav = document.getElementById('broadcasterAdminNavBtn');
        if (nav) nav.style.display = broadcasterAdminEligible ? 'flex' : 'none';
        const panel = document.getElementById('hubPanel-broadcaster-admin');
        if (panel) panel.classList.remove('active');
        switchHubTab('shop');
      }
    }

    async function loadFishdexView(force = false) {
      const loggedOutEl = document.getElementById('fishdexLoggedOut');
      const loggedInEl = document.getElementById('fishdexLoggedIn');
      const loadingEl = document.getElementById('fishdexLoading');
      const errorEl = document.getElementById('fishdexError');

      if (cachedFishdexData && !force) {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'none';
        loggedOutEl.style.display = 'none';
        loggedInEl.style.display = 'block';
        renderFishdexData(cachedFishdexData);
        return;
      }

      loggedOutEl.style.display = 'none';
      loggedInEl.style.display = 'none';
      errorEl.style.display = 'none';
      loadingEl.style.display = 'block';
      loadingEl.textContent = 'Loading your fish index...';

      let me;
      try {
        me = await (await fetch('/api/auth/me')).json();
      } catch (e) {
        me = { loggedIn: false };
      }

      if (!me.loggedIn) {
        loadingEl.style.display = 'none';
        loggedOutEl.style.display = 'block';
        return;
      }

      try {
        const res = await fetch('/api/fishdex');
        if (!res.ok) throw new Error('bad response');
        const data = await res.json();
        cachedFishdexData = data;
        loadingEl.style.display = 'none';
        loggedInEl.style.display = 'block';
        renderFishdexData(data);
      } catch (err) {
        loadingEl.style.display = 'none';
        errorEl.style.display = 'block';
        errorEl.textContent = 'Could not load your fish index. Try refreshing the page.';
      }
    }

    let currentFishdexLogin = null;
    let perkTempCountdownTimer = null;
    let perkEventCountdownTimer = null;
    let rarityBoostShopCountdownTimer = null;
    let fishingStatusCountdownTimer = null;

    // Keep the live client-side timer state separate from the API payload so
    // disabling a timed perk can freeze the UI immediately, before the POST
    // round-trip finishes. The server remains authoritative; these values are
    // overwritten by the next successful status sync.
    let perkTempDisplayedRemaining = 0;
    let rarityBoostDisplayedRemaining = 0;
    let perkStatusRequestSeq = 0;

    let profileStreamerData = null;
    let profileStreamerChangeTimer = null;

    async function loadProfileStreamerStatus() {
      const wrap = document.getElementById('profileStreamerPicker');
      const select = document.getElementById('profileStreamerSelect');
      const meta = document.getElementById('profileStreamerCooldown');
      if (!wrap || !select || !currentFishdexLogin) return;
      try {
        const res = await fetch('/api/streamer', { cache:'no-store' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load streamers.');
        profileStreamerData = data;
        if (window.__tutorialPerksData?.fishing) renderFishingStatus(window.__tutorialPerksData.fishing);
        const rows = Array.isArray(data.broadcasters) ? data.broadcasters : [];
        select.innerHTML = rows.length ? (data.selected ? '' : '<option value="" disabled selected>Choose your streamer</option>') + rows.map((row) => {
          const cooldownLabel = row.usesSystemDefault ? `System default (${Number(row.cooldownSeconds)}s)` : `${Number(row.cooldownSeconds)}s`;
          return `<option value="${escText(row.channel)}" ${row.channel === data.selected ? 'selected' : ''}>@${escText(row.channel)} · ${cooldownLabel}${Number(row.cooldownRemainingSeconds || 0) > 0 ? ` · ${Number(row.cooldownRemainingSeconds)}s left` : ''}</option>`;
        }).join('') : '<option value="">No enabled streamers</option>';
        select.disabled = !rows.length || Number(data.changeCooldownRemainingSeconds || 0) > 0;
        wrap.style.display = rows.length ? 'flex' : 'none';
        const remaining = Number(data.changeCooldownRemainingSeconds || 0);
        const changeLabel = remaining > 0 ? `${Math.floor(remaining / 60)}m ${remaining % 60}s` : '';
        meta.textContent = remaining > 0 ? `Streamer change in ${changeLabel}` : (data.selected ? `Selected @${data.selected}` : 'Choose your streamer');
        if (profileStreamerChangeTimer) clearTimeout(profileStreamerChangeTimer);
        if (remaining > 0) profileStreamerChangeTimer = setTimeout(loadProfileStreamerStatus, 1000);
      } catch (error) {
        wrap.style.display = 'none';
        console.error('Failed to load streamer selection:', error);
      }
    }

    async function selectProfileStreamer(channel) {
      if (!channel) return;
      try {
        const res = await fetch('/api/streamer', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ streamer: channel }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not change streamer.');
        toast(data.initialSelection ? `Streamer set to @${data.selected}.` : `Streamer set to @${data.selected}. You can change it again in 5 minutes.`, 'success', {label:'Streamer selected'});
        await loadProfileStreamerStatus();
        loadPerksStatus();
      } catch (error) {
        toast(error.message || 'Could not change streamer.', 'error', {label:'Streamer not changed'});
        await loadProfileStreamerStatus();
      }
    }

    /* ---------- Fishing status pill (cooldown / timeout / ready) ---------- */
    function renderFishingStatus(fishing) {
      const pill = document.getElementById('fishingStatusPill');
      const textEl = document.getElementById('fishingStatusText');
      const subEl = document.getElementById('fishingStatusSub');
      if (!pill || !textEl || !fishing) return;

      if (fishingStatusCountdownTimer) { clearInterval(fishingStatusCountdownTimer); fishingStatusCountdownTimer = null; }
      pill.style.display = 'inline-flex';

      // Show base cooldown in the subtle sub-line (only when on cooldown or ready)
      const baseCooldown = fishing.baseCooldownSeconds;
      if (subEl) {
        const selectedLabel = profileStreamerData?.selected ? `@${profileStreamerData.selected}` : 'No streamer selected';
        subEl.textContent = baseCooldown ? `${selectedLabel} · Cooldown: ${baseCooldown}s` : selectedLabel;
      }

      let timeoutRemaining = Math.max(0, Math.round((fishing.timeoutRemainingMs || 0) / 1000));
      let cooldownRemaining = Math.max(0, Math.round((fishing.cooldownRemainingMs || 0) / 1000));

      const formatShort = (totalSeconds) => {
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
      };

      const tick = () => {
        if (timeoutRemaining > 0) {
          pill.className = 'fishing-status-pill timeout';
          textEl.innerHTML = statusHTML('rod-broken', `Rod broken, back in ` + formatShort(timeoutRemaining));
          timeoutRemaining--;
        } else if (cooldownRemaining > 0) {
          pill.className = 'fishing-status-pill cooldown';
          textEl.innerHTML = statusHTML('hourglass', `On cooldown, back in ` + formatShort(cooldownRemaining));
          cooldownRemaining--;
        } else {
          pill.className = 'fishing-status-pill ready';
          textEl.innerHTML = statusHTML('rod', profileStreamerData?.selected ? `Ready to fish · @${profileStreamerData.selected}` : 'Ready to fish');
          if (fishingStatusCountdownTimer) { clearInterval(fishingStatusCountdownTimer); fishingStatusCountdownTimer = null; }
        }
      };
      const needsTicking = timeoutRemaining > 0 || cooldownRemaining > 0;
      tick();
      if (needsTicking) {
        fishingStatusCountdownTimer = setInterval(tick, 1000);
      }
    }

    function renderFishdexData(data) {
      loadProfileTwitchVerify();
      document.getElementById('fishdexAvatar').src = data.user.avatar || '';
      document.getElementById('fishdexUsername').textContent = data.user.displayName || data.user.login;

      currentFishdexLogin = data.user.login;
      updateTutorialTopButton();
      syncBroadcasterAdmin();
      loadProgression(true).catch(() => {});
      syncTradingIdentity(data.user);
      loadPerksStatus();
      loadProfileStreamerStatus();

      updateNextStepCard(data);
      const progress = fishdexIndexProgress(data);
      updateTutorialProgressUI(progress.caught);
      const pct = progress.pct;
      document.getElementById('fishdexProgressCount').textContent =
        `${progress.caught.toLocaleString()} / ${progress.total.toLocaleString()} caught (${pct}%)`;
      document.getElementById('fishdexProgressFill').style.width = `${pct}%`;

      // Only claim completion when the catalog is non-empty and full. An
      // empty catalog reads 0/0, which must never show a seal.
      const progressRow = document.getElementById('fishdexProgressRow');
      if (progressRow) {
        progressRow.classList.toggle('is-complete', progress.total > 0 && pct >= 100);
      }

      const statCaughtEl = document.getElementById('fishdexStatCaught');
      if (statCaughtEl) statCaughtEl.textContent = `${progress.caught.toLocaleString()} / ${progress.total.toLocaleString()}`;
      const statPctEl = document.getElementById('fishdexStatPct');
      if (statPctEl) statPctEl.textContent = `${pct}%`;

      const ringEl = document.getElementById('profileAvatarRing');
      if (ringEl) ringEl.style.setProperty('--ring-pct', pct);

      const rankTagEl = document.getElementById('fishdexRankTag');
      if (rankTagEl) {
        const tiers = [
          { name: 'Novice', threshold: 0 },
          { name: 'Rookie', threshold: 5 },
          { name: 'Angler', threshold: 25 },
          { name: 'Seasoned Angler', threshold: 50 },
          { name: 'Master Angler', threshold: 75 },
          { name: 'Legendary Fisher', threshold: 100 }
        ];
        let rank = 'Novice';
        let nextThreshold = 5;
        for (let i = tiers.length - 1; i >= 0; i--) {
          if (pct >= tiers[i].threshold) {
            rank = tiers[i].name;
            nextThreshold = tiers[i + 1] ? tiers[i + 1].threshold : 100;
            break;
          }
        }
        rankTagEl.textContent = rank;
        const progressToNext = nextThreshold > pct ? nextThreshold - pct : 0;
        rankTagEl.title = progressToNext > 0
          ? `${progressToNext.toFixed(1)}% to ${tiers.find(t => t.threshold === nextThreshold)?.name || 'next rank'}`
          : 'Maximum rank reached';
      }

      const container = document.getElementById('fishdexTiers');
      container.innerHTML = data.tiers.map((tier) => {
        const caughtInTier = tier.items.filter((i) => i.caught).length;
        const itemsHtml = tier.items.map((item) => {
          if (item.caught) {
            return `<div class="dex-item-cell caught"${item.area ? ` title="${escapeHtmlFishdex(item.area.name)}"` : ''}>
              ${item.area ? `<span class="dex-area-tag">${icon(item.area.icon)}</span>` : ''}<span class="item-name">${escapeHtmlFishdex(item.name)}</span>
              ${item.count > 1 ? `<span class="item-count">x${item.count}</span>` : ''}
            </div>`;
          }
          return `<div class="dex-item-cell locked"${item.area ? ` title="${escapeHtmlFishdex(item.area.name)}"` : ''}>${item.area ? `<span class="dex-area-tag">${icon(item.area.icon)}</span>` : ''}<span class="item-name">???</span></div>`;
        }).join('');

        const collapsedClass = dexExpandedTiers.has(tier.id) ? '' : ' collapsed';
        return `
          <div class="tier-card ${tier.id}${collapsedClass}" data-tier-id="${tier.id}">
            <button type="button" class="dex-tier-header" aria-expanded="${collapsedClass ? 'false' : 'true'}" onclick="toggleDexTier('${tier.id}', this)">
              <span class="dex-tier-name">${icon(TIER_ICON[tier.id] || 'fish', 'ic--sm')}${escapeHtmlFishdex(tier.name)}</span>
              <span class="dex-tier-right">
                <span class="tier-count">${caughtInTier} / ${tier.items.length}</span>
                <svg class="ic dex-tier-chevron" aria-hidden="true" focusable="false"><use href="#i-chev-down"></use></svg>
              </span>
            </button>
            <div class="dex-item-grid">${itemsHtml}</div>
          </div>`;
      }).join('');
    }

    /* ---------- Fish Index: collapsible rarity tiers ---------- */
    // Remember which Fishdex tiers are open, per browser. Empty = everything starts collapsed.
    const DEX_EXPANDED_KEY = 'fishingHub.fishdex.expandedTiers';
    function loadDexExpanded() {
      try {
        const value = JSON.parse(localStorage.getItem(DEX_EXPANDED_KEY) || '[]');
        return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
      } catch (e) { return []; }
    }
    function saveDexExpanded() {
      try { localStorage.setItem(DEX_EXPANDED_KEY, JSON.stringify([...dexExpandedTiers])); } catch (e) {}
    }
    let dexExpandedTiers = new Set(loadDexExpanded());

    function toggleDexTier(tierId, btn) {
      const card = btn.closest('.tier-card');
      if (!card) return;
      const collapsed = card.classList.toggle('collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
      if (collapsed) dexExpandedTiers.delete(tierId);
      else dexExpandedTiers.add(tierId);
      saveDexExpanded();
    }

    function toggleAllDexTiers(expand) {
      document.querySelectorAll('#fishdexTiers .tier-card').forEach((card) => {
        card.classList.toggle('collapsed', !expand);
        card.querySelector('.dex-tier-header')?.setAttribute('aria-expanded', String(expand));
        if (expand) dexExpandedTiers.add(card.dataset.tierId);
      });
      if (!expand) dexExpandedTiers.clear();
      saveDexExpanded();
    }

    function escapeHtmlFishdex(str) {
      return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ---------- Perks Shop status (ownership, active buffs, toggles) ---------- */
    async function loadPerksStatus() {
      const requestSeq = ++perkStatusRequestSeq;
      try {
        // Perk ownership and toggle state can change outside this page; don't
        // let browser/proxy caching keep old controls visible after a purchase.
        const res = await fetch('/api/perks', { cache: 'no-store' });
        const data = await res.json();
        // Multiple status requests can overlap (initial page load, a toggle,
        // and a purchase can all trigger one). Never let an older response
        // overwrite the newer toggle state and restart an old countdown.
        if (requestSeq !== perkStatusRequestSeq) return;
        if (!res.ok || !data || data.error) {
          throw new Error(data?.error || `Perks request failed (${res.status}).`);
        }
        window.__tutorialPerksData = data;
        keepScrollPositions(() => {
          renderPerksStatus(data);
          renderTreasuryShop(data);
        });
      } catch (err) {
        if (requestSeq === perkStatusRequestSeq) {
          console.error('Failed to load perk status:', err);
        }
      }
    }

    function setPerkLocked(cardId, locked) {
      const card = document.getElementById(cardId);
      if (card) card.classList.toggle('locked', !!locked);
    }

    function setupPerkToggleRow(rowId, inputId, toggleOn) {
      const row = document.getElementById(rowId);
      const input = document.getElementById(inputId);
      if (row) row.style.display = 'flex';
      if (input) input.checked = !!toggleOn;
    }


    let autoFishRefreshTimer = null;

    async function autoFishRequest(body = null) {
      const res = await fetch('/api/autofish', body ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      } : { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || 'Auto-Fish request failed.');
        err.details = data;
        throw err;
      }
      return data;
    }

    function fishyBuddy(state = 'idle', message = '', mini = false, admin = false) {
      const cls = ['fishy-buddy', state ? `is-${state}` : '', mini ? 'fishy-buddy--mini' : '', admin ? 'fishy-buddy--admin' : ''].filter(Boolean).join(' ');
      const extras = state === 'event' ? '<span class="fishy-buddy__spark fishy-buddy__spark--1">!</span><span class="fishy-buddy__spark fishy-buddy__spark--2">!</span>' : state === 'excited' ? '<span class="fishy-buddy__spark fishy-buddy__spark--1">✦</span><span class="fishy-buddy__spark fishy-buddy__spark--2">✦</span>' : state === 'sleepy' ? '<span class="fishy-buddy__zzz">Zz</span>' : '';
      return `<div class="${cls}" aria-label="Fishy, your Auto-Fish buddy">${message ? `<div class="fishy-buddy__bubble">${escText(message)}</div>` : ''}<div class="fishy-buddy__swim"><div class="fishy-buddy__fish"><div class="fishy-buddy__fin fishy-buddy__fin--top"></div><div class="fishy-buddy__fin fishy-buddy__fin--left"></div><div class="fishy-buddy__fin fishy-buddy__fin--right"></div><div class="fishy-buddy__tail"></div><div class="fishy-buddy__body"></div><div class="fishy-buddy__belly"></div><span class="fishy-buddy__eye fishy-buddy__eye--l"></span><span class="fishy-buddy__eye fishy-buddy__eye--r"></span><span class="fishy-buddy__cheek fishy-buddy__cheek--l"></span><span class="fishy-buddy__cheek fishy-buddy__cheek--r"></span><span class="fishy-buddy__mouth"></span>${extras}</div></div></div>`;
    }

    // Purchase helpers. A purchase answers as soon as the server replies; the
    // status refreshes run in the background (like the Perks buy), and a second
    // click on the same purchase is ignored while the first one is in flight.
    const purchaseInFlight = new Set();
    // While the server works, the clicked button reads "Buying…" and is
    // disabled, the same as the Perks buy. window.event is read synchronously,
    // before the first await, so it still points at the clicked button.
    async function runPurchase(key, task) {
      if (purchaseInFlight.has(key)) return;
      purchaseInFlight.add(key);
      const clicked = window.event?.target?.closest?.('button') || null;
      const originalText = clicked ? clicked.textContent : '';
      if (clicked) { clicked.disabled = true; clicked.textContent = 'Buying…'; }
      try { await task(); } finally {
        purchaseInFlight.delete(key);
        if (clicked && clicked.isConnected) { clicked.disabled = false; clicked.textContent = originalText; }
      }
    }
    function refreshInBackground(...tasks) {
      tasks.forEach((task) => { Promise.resolve().then(task).catch(() => {}); });
    }
    async function pondRequest(body = null) {
      const res = await fetch('/api/pond', body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      } : { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        const err = new Error(data?.error || 'Pond request failed.');
        err.details = data;
        throw err;
      }
      return data;
    }

    // Pond sections fold away by default. Open state is kept across re-renders (window.__pondFoldOpen).
    function pondFoldAttr(key) { return window.__pondFoldOpen?.[key] ? ' open' : ''; }
    function pondFishTierClass(tier) { return String(tier || '').toLowerCase().replace(/[^a-z]/g, ''); }

    function pondJsString(value) { return JSON.stringify(String(value == null ? '' : value)).replace(/'/g, '\\u0027'); }
    function pondAttr(value) {
      return String(value == null ? '' : value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function pondFishVariant(name) {
      let h = 0; for (const ch of String(name || '')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
      return Math.abs(h) % 8;
    }
    function pondFishAssetSlug(name) {
      return String(name || '').replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'fish';
    }
    function pondFishyIcon(name, tier, mini = false) {
      const symbol = `fish-${pondFishAssetSlug(name)}`;
      const sprite = '/pond-fish/pond-fish-sprite.svg?v=2';
      return `<svg class="pond-fishy-icon${mini ? ' is-mini' : ''}" viewBox="0 0 240 160" aria-hidden="true" focusable="false"><use href="${sprite}#${pondAttr(symbol)}"></use></svg>`;
    }
    function pondFishMotion(name, index) {
      let h = 0; for (const ch of String(name || '')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
      const n = Math.abs(h + index * 977);
      const left = 12 + (n % 76);
      const top = 18 + (Math.floor(n / 7) % 60);
      return `left:${left}%;top:${top}%;`;
    }

    // The pond fish use one continuous animation loop rather than jumping from
    // waypoint to waypoint. Each fish has its own velocity, target and gentle
    // steering, so they wander naturally through the whole tank while keeping
    // their own movement independent from the others.
    function pondMotionKey(slot, index) {
      return `${slot?.dataset?.fish || ''}::${index}`;
    }
    function pondMotionRandom(min, max) { return min + Math.random() * (max - min); }
    function pondMotionMakeState(slot, index, existing = null) {
      const key = pondMotionKey(slot, index);
      const rect = slot?.parentElement?.getBoundingClientRect?.();
      const width = Math.max(1, rect?.width || 900);
      const height = Math.max(1, rect?.height || 180);
      const fishW = Math.max(40, slot.offsetWidth || 78);
      const fishH = Math.max(35, slot.offsetHeight || 72);
      const halfW = Math.min(11, (fishW / width) * 50);
      const halfH = Math.min(18, (fishH / height) * 50);
      const state = existing || {
        x: pondMotionRandom(10 + halfW, 90 - halfW),
        y: pondMotionRandom(18 + halfH, 82 - halfH),
        vx: pondMotionRandom(-3.5, 3.5),
        vy: pondMotionRandom(-2.2, 2.2),
        tx: pondMotionRandom(12 + halfW, 88 - halfW),
        ty: pondMotionRandom(20 + halfH, 80 - halfH),
        angle: pondMotionRandom(-7, 7),
        targetAngle: pondMotionRandom(-10, 10),
        seed: Math.random()
      };
      state.key = key;
      state.last = performance.now();
      state.nextTarget = performance.now() + pondMotionRandom(1200, 3400);
      state.widthRatio = width;
      state.heightRatio = height;
      return state;
    }
    function pondMotionPickTarget(state) {
      state.tx = pondMotionRandom(10, 90);
      state.ty = pondMotionRandom(18, 82);
      state.nextTarget = performance.now() + pondMotionRandom(1800, 4200);
    }
    function pondMotionFrame(now) {
      const pond = document.querySelector('.personal-pond__water');
      const slots = pond ? [...pond.querySelectorAll('.personal-pond__slot')] : [];
      if (!pond || !slots.length || !window.__pondMotionRunning) {
        window.__pondMotionRaf = null;
        return;
      }
      const rect = pond.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const states = window.__pondMotionStates || (window.__pondMotionStates = new Map());
      const liveKeys = new Set();
      slots.forEach((slot, index) => {
        const key = pondMotionKey(slot, index);
        liveKeys.add(key);
        let state = states.get(key);
        if (!state) {
          state = pondMotionMakeState(slot, index);
          states.set(key, state);
        }
        const dt = Math.min(0.04, Math.max(0.001, (now - (state.last || now)) / 1000));
        state.last = now;
        state.widthRatio = width;
        state.heightRatio = height;
        if (now >= state.nextTarget) pondMotionPickTarget(state);

        // Smooth steering: accelerate toward the current target instead of
        // snapping position/rotation to a new waypoint.
        const dx = state.tx - state.x;
        const dy = state.ty - state.y;
        const distance = Math.hypot(dx, dy) || 1;
        const desiredSpeed = 4.0 + (state.seed || 0) * 2.2;
        const desiredVx = (dx / distance) * desiredSpeed;
        const desiredVy = (dy / distance) * desiredSpeed * 0.72;
        const steering = Math.min(1, dt * 0.9);
        state.vx += (desiredVx - state.vx) * steering;
        state.vy += (desiredVy - state.vy) * steering;
        state.x += state.vx * dt;
        state.y += state.vy * dt;

        const padX = Math.min(10, ((slot.offsetWidth || 78) / width) * 50);
        const padY = Math.min(17, ((slot.offsetHeight || 72) / height) * 50);
        if (state.x < 8 + padX) { state.x = 8 + padX; state.vx = Math.abs(state.vx) * 0.82; state.tx = pondMotionRandom(18, 88); }
        if (state.x > 92 - padX) { state.x = 92 - padX; state.vx = -Math.abs(state.vx) * 0.82; state.tx = pondMotionRandom(12, 82); }
        if (state.y < 16 + padY) { state.y = 16 + padY; state.vy = Math.abs(state.vy) * 0.82; state.ty = pondMotionRandom(24, 78); }
        if (state.y > 84 - padY) { state.y = 84 - padY; state.vy = -Math.abs(state.vy) * 0.82; state.ty = pondMotionRandom(20, 74); }

        const heading = Math.max(-13, Math.min(13, Math.atan2(state.vy, Math.max(0.25, Math.abs(state.vx))) * 28 * (state.vx >= 0 ? 1 : -1)));
        state.angle += (heading - state.angle) * Math.min(1, dt * 2.4);
        slot.style.left = `${state.x.toFixed(3)}%`;
        slot.style.top = `${state.y.toFixed(3)}%`;
        slot.style.transform = `translate(-50%,-50%) rotate(${state.angle.toFixed(2)}deg)`;
      });
      for (const key of states.keys()) if (!liveKeys.has(key)) states.delete(key);
      window.__pondMotionRaf = requestAnimationFrame(pondMotionFrame);
    }
    function startPondFishMotion() {
      const pond = document.querySelector('.personal-pond__water');
      if (!pond) return;
      if (window.__pondMotionRaf) cancelAnimationFrame(window.__pondMotionRaf);
      window.__pondMotionRunning = true;
      window.__pondMotionStates = window.__pondMotionStates || new Map();
      const slots = [...pond.querySelectorAll('.personal-pond__slot')];
      const liveKeys = new Set(slots.map((slot, index) => pondMotionKey(slot, index)));
      for (const key of window.__pondMotionStates.keys()) if (!liveKeys.has(key)) window.__pondMotionStates.delete(key);
      window.__pondMotionRaf = requestAnimationFrame(pondMotionFrame);
    }
    function pondTierInfo(tier) {
      const key = String(tier || 'COMMON').toUpperCase();
      return TIER_DISPLAY_BY_NAME[key] || TIER_DISPLAY_BY_NAME.COMMON;
    }
    function renderPondFishSelection(pond) {
      const catalog = Array.isArray(pond.catalog) ? pond.catalog : [];
      if (pond.treasuryModeActive) {
        const treasuryCatalog = Array.isArray(pond.treasuryCatalog) ? pond.treasuryCatalog : catalog;
        if (!treasuryCatalog.length) return '<div class="personal-pond__empty">No Treasury loot is available.</div>';
        return treasuryCatalog.map((fish) => {
          const tier = pondTierInfo('TREASURY');
          return `<article class="personal-pond__fish personal-pond__fish--treasury" style="--slot-accent:${tier.accent}">
            <div class="personal-pond__fish-top"><div class="personal-pond__fish-title"><span class="personal-pond__fish-visual">${pondFishyIcon(fish.name, 'TREASURY', true)}</span><div class="personal-pond__fish-title-copy"><span class="personal-pond__fish-name" title="${pondAttr(fish.name)}">${escText(fish.name)}</span><span class="personal-pond__fish-rarity">${escText(tier.label)}</span></div></div></div>
            <div class="personal-pond__fish-meta"><span>Treasury loot</span><span>!fish Treasury Only pool</span></div>
          </article>`;
        }).join('');
      }
      const unlocked = new Set(Array.isArray(pond.unlockedFish) ? pond.unlockedFish : []);
      const selected = new Set(Array.isArray(pond.selected) ? pond.selected : []);
      const upgrades = pond.fishUpgrades || {};
      const maxUpgrades = Number(pond.fishMaxUpgrades || 2);
      const level = Number(pond.level || 1);
      return catalog.map((fish) => {
        const owned = unlocked.has(fish.name);
        const isSelected = selected.has(fish.name);
        const upgradeLevel = Math.max(0, Math.min(maxUpgrades, Number(upgrades[fish.name]) || 0));
        const weightBonus = upgradeLevel * 50;
        const focusBonus = isSelected ? 25 : 0;
        const tier = pondTierInfo(fish.tier);
        const costs = Array.isArray(pond.fishUpgradeCosts?.[fish.tier]) ? pond.fishUpgradeCosts[fish.tier] : [];
        const nextCost = costs[upgradeLevel];
        const selectLabel = isSelected ? 'Selected · click to remove' : `Select (${selected.size}/${Math.min(3, level)})`;
        const selectButton = owned
          ? `<button type="button" class="vault-tab-btn ${isSelected ? 'active' : ''}" data-pond-fish-action="toggle" data-pond-fish="${pondAttr(fish.name)}" onclick='togglePondFish(${pondJsString(fish.name)})'>${selectLabel}</button>`
          : `<button type="button" class="vault-tab-btn" data-pond-fish-action="unlock" data-pond-fish="${pondAttr(fish.name)}" onclick='unlockPondFish(${pondJsString(fish.name)})'>Unlock · ${Number(fish.unlockCost || 0).toLocaleString()} 🪙</button>`;
        const upgradeButton = owned && upgradeLevel < maxUpgrades
          ? `<button type="button" class="shop-item-cta" data-pond-fish-action="upgrade" data-pond-fish="${pondAttr(fish.name)}" onclick='upgradePondFish(${pondJsString(fish.name)})'>Upgrade · ${Number(nextCost || 0).toLocaleString()} 🪙</button>`
          : owned ? `<button type="button" class="vault-tab-btn" disabled>MAX · +${weightBonus}% weight</button>` : '';
        return `<article class="personal-pond__fish ${isSelected ? 'is-selected' : ''} ${owned ? '' : 'is-locked'}" style="--slot-accent:${tier.accent}">
          <div class="personal-pond__fish-top"><div class="personal-pond__fish-title"><span class="personal-pond__fish-visual">${pondFishyIcon(fish.name, fish.tier, true)}</span><div class="personal-pond__fish-title-copy"><span class="personal-pond__fish-name" title="${pondAttr(fish.name)}">${escText(fish.name)}</span><span class="personal-pond__fish-rarity">${escText(tier.label)}</span></div></div></div>
          <div class="personal-pond__fish-meta"><span>${isSelected ? `Target +${focusBonus}%` : 'Base weight'}</span><span>Upgrade +${weightBonus}%</span><span>+${Number(fish.tokenValue || 0).toLocaleString()} tokens</span>${owned ? `<span>Upgrade ${upgradeLevel}/${maxUpgrades}</span>` : ''}</div>
          <div class="personal-pond__fish-actions">${selectButton}${upgradeButton}</div>
        </article>`;
      }).join('');
    }
    function renderPondConverter(pond) {
      const inventory = Array.isArray(pond.inventory) ? pond.inventory : [];
      const filter = window.__pondConverterFilter || 'all';
      const search = String(window.__pondConverterSearch || '').trim().toLowerCase();
      const filtered = inventory.filter((entry) => {
        const tier = String(entry.tier || '').toLowerCase();
        const matchesTier = filter === 'all' || tier === filter;
        return matchesTier && String(entry.item || '').toLowerCase().includes(search);
      });
      const tabs = [['all','All'],['common','Common'],['uncommon','Uncommon'],['rare','Rare'],['epic','Epic'],['legendary','Legendary']];
      const tabsHtml = tabs.map(([id,label]) => `<button type="button" class="vault-tab-btn ${filter === id ? 'active' : ''}" onclick='setPondConverterFilter(${pondJsString(id)})'>${label}</button>`).join('');
      const cards = filtered.length ? filtered.map((entry, index) => {
        const tier = pondTierInfo(entry.tier);
        const inputId = `pond-convert-${index}`;
        return `<article class="personal-pond__converter-card" style="--slot-accent:${tier.accent}">
          <div class="personal-pond__converter-icon">${icon(tier.icon)}</div>
          <div class="personal-pond__converter-info"><span class="personal-pond__converter-name" title="${pondAttr(entry.item)}">${escText(entry.item)}</span><span class="personal-pond__converter-meta"><span>${escText(tier.label)}</span><span>×${Number(entry.count || 0).toLocaleString()}</span><span>${Number(entry.tokenValue || 0).toLocaleString()} 🪙 each</span></span></div>
          <div class="personal-pond__converter-action"><input id="${inputId}" type="number" min="1" max="${Number(entry.count || 1)}" value="1" aria-label="Amount of ${pondAttr(entry.item)} to convert"><button type="button" class="vault-tab-btn" onclick='convertPondInventory(${pondJsString(entry.item)}, Number(document.getElementById(${pondJsString(inputId)}).value) || 1)'>Convert</button></div>
        </article>`;
      }).join('') : '<div class="personal-pond__hint" style="padding:12px">No fish match these filters.</div>';
      return `<div class="personal-pond__converter-toolbar"><div class="personal-pond__converter-tabs">${tabsHtml}</div><div class="vault-search-box personal-pond__converter-search"><svg class="ic" aria-hidden="true"><use href="#i-search"></use></svg><input class="vault-search-input" value="${pondAttr(window.__pondConverterSearch || '')}" placeholder="Search inventory" oninput="setPondConverterSearch(this.value)"></div></div><div class="personal-pond__converter-grid">${cards}</div>`;
    }
    function renderPondTreasuryPerkShop(pond) {
      const wrap = document.getElementById('pondTreasuryPerkShop');
      if (!wrap) return;
      updateShopCategoryVisibility(!!pond?.unlocked);
      if (!pond?.unlocked || !pond?.treasuryPerkInfo) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
      const order = ['speciesHunter','baitSaver','collectorInstinct','stillWaters','deepCurrent','biggerHaul','fishyFortune','treasuryWaters'];
      const groups = [
        ['collection','Collection',['speciesHunter','collectorInstinct']],
        ['pond','Pond',['stillWaters','deepCurrent','baitSaver']],
        ['economy','Economy',['biggerHaul','fishyFortune']],
        ['waters','Waters',['treasuryWaters']]
      ];
      const active = window.__pondPerkCategory || 'collection';
      window.__pondGiftInfo = Object.fromEntries(order.map((id) => {
        const info = pond.treasuryPerkInfo[id] || {};
        return [id, { label: info.label || id, level: Number(info.level || 0), max: Number(info.max || 0), nextCost: info.nextCost == null ? null : Number(info.nextCost) }];
      }));
      const effectFor = (id, info) => {
        const level = Number(info?.level || 0);
        if (id === 'speciesHunter') {
          const fishdexCount = Number(pond.speciesHunterFishdexCount || 0);
          const cap = Number(info?.cap || 0);
          const counted = Math.min(fishdexCount, cap);
          const bonus = (counted * 0.01).toFixed(2);
          return `+${bonus}× Luck · ${counted}/${cap} Fishdex fish counted`;
        }
        if (id === 'baitSaver') return `${Number(info?.value || 0)}% chance to keep premium bait after a cast`;
        if (id === 'collectorInstinct') return `Uncaught fish +${Number(info?.value || 0)}% weight`;
        if (id === 'stillWaters') return `Common weight −${Number(info?.value || 0)}% · redistributed upward`;
        if (id === 'deepCurrent') return `Rare+ weight +${Number(info?.value || 0)}% · +1 min Pond timer`;
        if (id === 'biggerHaul') return `+${Number(info?.value || 0)} fish when collecting`;
        if (id === 'fishyFortune') return `Common–Rare FishyToken value +${Number(info?.value || 0)}%`;
        if (id === 'treasuryWaters') return Number(pond.level || 1) >= 5 ? 'Treasury-only Pond loot · no timeout loot' : 'Requires Pond Level 5';
        return info?.desc || '';
      };
      const iconFor = { speciesHunter:'i-search', collectorInstinct:'i-fish', stillWaters:'i-drop', deepCurrent:'i-drop', baitSaver:'i-fish', biggerHaul:'i-bag', fishyFortune:'i-coin-stack', treasuryWaters:'i-drop' };
      const card = (id) => {
        const info = pond.treasuryPerkInfo[id] || {};
        const level = Number(info.level || 0), max = Number(info.max || 0), cost = info.nextCost;
        const balance = Number(pond.treasuryBalance ?? pond.treasury?.balance ?? window.__lastTreasuryBalance ?? 0);
        const maxed = cost == null;
        const levelLocked = id === 'treasuryWaters' && Number(pond.level || 1) < 5;
        const affordable = !maxed && !levelLocked && balance >= Number(cost);
        const priceText = maxed ? 'MAX' : pondPriceMarkup(id, level, cost);
        return `<article class="shop-item-card pond-perk-card ${maxed ? 'is-maxed' : ''}" data-pond-perk="${id}" data-pond-level="${level}">
          <div class="shop-item-icon treasury-icon"><svg class="ic" aria-hidden="true"><use href="#${iconFor[id] || 'i-sparkle'}"></use></svg></div>
          <div class="shop-item-name">${escText(info.label || id)}</div>
          <div class="shop-item-desc">${escText(info.desc || '')}</div>
          <div class="shop-item-status ${maxed ? '' : 'dim'}">Level ${level}/${max} · ${escText(effectFor(id, info))}</div>
          <div class="shop-item-footer">
            <span class="shop-item-price treasury-price">${levelLocked ? 'LEVEL 5' : priceText}</span>
            <button class="shop-item-cta" type="button" ${maxed || !affordable ? 'disabled' : ''} onclick="upgradePondTreasuryPerk('${id}')">${maxed ? 'Maxed' : levelLocked ? 'Locked' : affordable ? 'Upgrade' : `Need ${Number(cost) - balance} more`}</button>
            <button class="shop-item-cta gift-perk-btn gift-icon-btn" type="button" ${levelLocked ? 'disabled' : ''} onclick="openPerkGiftModal('${id}')" title="Gift the next level of this Pond perk" aria-label="Gift the next level of this Pond perk"><svg class="ic" aria-hidden="true"><use href="#i-gift"></use></svg></button>
          </div>
        </article>`;
      };
      const activeGroup = groups.find(([id]) => id === active) || groups[0];
      const tabs = groups.map(([id,label,ids]) => `<button type="button" class="pond-perk-tab ${activeGroup[0] === id ? 'active' : ''}" role="tab" aria-selected="${activeGroup[0] === id}" onclick="setPondPerkCategory('${id}')"><span>${label}</span><small>${ids.length}</small></button>`).join('');
      const cards = activeGroup[2].map(card).join('');
      wrap.style.display = 'block';
      window.__lastTreasuryBalance = Number(document.getElementById('treasuryBalance')?.textContent?.match(/\d+/)?.[0] || window.__lastTreasuryBalance || 0);
      wrap.innerHTML = `<section class="pond-treasury-perk-shell">
        <div class="pond-treasury-perk-head"><div><div class="shop-section-kicker">Pond Perks</div><h3>Upgrade the Pond with Treasury</h3><p>Permanent upgrades. Only one category is shown at a time so the shop stays easy to scan.</p></div></div>
        <div class="pond-perk-tabs" role="tablist" aria-label="Pond perk categories">${tabs}</div>
        <div class="shop-grid shop-grid--category pond-perk-grid">${cards}</div>
      </section>`;
      const pondBalance = Number(window.__lastTreasuryBalance || 0);
      window.__shopCategoryBuyable = window.__shopCategoryBuyable || {};
      window.__shopCategoryBuyable.pond = order.some((id) => { const info = pond.treasuryPerkInfo[id] || {}; return info.nextCost != null && pondBalance >= Number(info.nextCost); });
      updateShopCategoryBuyDots();
    }
    function setPondPerkCategory(category) {
      window.__pondPerkCategory = category;
      if (window.__pondLastStatus) renderPondTreasuryPerkShop(window.__pondLastStatus);
    }

    function renderPondFeatureSystems(pond) {
      const features = pond.featureInfo || {};
      const level = (id) => Number(features[id]?.level || 0);
      const next = (id) => features[id]?.nextCost;
      const button = (id) => next(id) ? `<button type="button" class="shop-item-cta" data-pond-feature="${pondAttr(id)}" onclick="upgradePondFeature('${id}')">Upgrade · ${Number(next(id)).toLocaleString()} 🪙</button>` : `<button type="button" class="vault-tab-btn" data-pond-feature="${pondAttr(id)}" disabled>${level(id) ? 'MAX LEVEL' : 'Unavailable'}</button>`;
      const baitLevel = level('baitSlots');
      const baitIds = Array.isArray(pond.baitSlots) ? pond.baitSlots : [];
      const baitInventory = pond.baitInventory || {};
      const baitOptions = (pond.baitCatalog || [
        {id:'worm',name:'Worm Bait',multiplier:1},
        {id:'minnow',name:'Minnow Bait',multiplier:1.08},
        {id:'rare',name:'Rare Bait',multiplier:1.16},
        {id:'legend',name:'Legend Bait',multiplier:1.28}
      ]);
      const baitConfig = baitLevel ? `<div class="personal-pond__bait-config">${Array.from({length:baitLevel}, (_,i) => {
        const selectedBait = baitIds[i] || 'worm';
        const options = baitOptions.map(b => `<option value="${pondAttr(b.id)}" ${selectedBait === b.id ? 'selected' : ''}>${escText(b.name)} · ${b.id === 'worm' ? '∞' : Number(baitInventory[b.id] || 0)} · ${Math.round((Number(b.multiplier || 1)-1)*100)}% rarity</option>`).join('');
        return `<div class="personal-pond__bait-slot"><label>Slot ${i+1}</label><select onchange="setPondBaitSlot(${i}, this.value)">${options}</select></div>`;
      }).join('')}</div>` : '';
      const finder = Array.isArray(pond.fishFinder) ? pond.fishFinder : [];
      const familiar = Object.entries(pond.familiarity || {}).filter(([,count]) => Number(count) > 0).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,5);
      const familiarHtml = level('familiarity') && familiar.length ? `<div class="personal-pond__familiarity-list">${familiar.map(([name,count]) => `<div class="personal-pond__familiarity-row"><span>${escText(name)}</span><span>${Number(count)} catches · +${Math.min(level('familiarity')*10, Math.floor(Number(count)/5))}%</span></div>`).join('')}</div>` : '';
      const cards = [
        ['03','Deep Water','Higher-rarity tiers get more weight.','deepWater','#83cfbd',`Level ${level('deepWater')}/3`,button('deepWater')],
        ['04','Lucky Water','Your normal Luck is amplified by 10% per level.','luckyWater','#ffc46b',`Level ${level('luckyWater')}/3`,button('luckyWater')],
        ['05','Fish Finder','Shows the live effective weight and chance of every fish.','fishFinder','#8ec7ff',level('fishFinder') ? 'ACTIVE' : 'LOCKED',button('fishFinder')],
        ['06','Bait Slots','Use your existing bait inventory for pond-only rarity boosts.','baitSlots','#c3a4ff',`Level ${baitLevel}/2`,button('baitSlots') + baitConfig],
        ['08','Familiarity','Every 5 catches of a fish adds +1% weight, capped by this upgrade.','familiarity','#ffd56e',`Level ${level('familiarity')}/3`,button('familiarity') + familiarHtml]
      ];
      const liveOddsOpen = window.__pondLiveOddsOpen === true;
      const activeBaits = Array.isArray(finder[0]?.baitOptions) ? finder[0].baitOptions : [];
      const uniqueBaits = [...new Map(activeBaits.map((bait) => [bait.id, bait])).values()];
      const baitText = uniqueBaits.length ? uniqueBaits.map((bait) => `${bait.name} +${Math.round((Number(bait.multiplier || 1) - 1) * 100)}% rarity`).join(' · ') : 'Worm Bait +0% rarity';
      const baitCountNote = activeBaits.length > 1 ? ` · ${activeBaits.length} usable bait slots are averaged for the displayed chance` : '';
      const finderRows = finder.map(row => {
        const chance = Number(row.chance || 0) * 100;
        const totalBonus = Number(row.bonusPercent || 0);
        const selectedBonus = Number(row.selectedBonusPercent || 0);
        const upgradeBonus = Number(row.upgradeBonusPercent || 0);
        const familiarityBonus = Number(row.familiarityBonusPercent || 0);
        const baitBonus = Number(row.baitBonusPercent || 0);
        const collectorBonus = Number(row.collectorBonusPercent || 0);
        const fishBonus = [selectedBonus ? `target +${selectedBonus.toFixed(0)}%` : '', upgradeBonus ? `upgrade +${upgradeBonus.toFixed(0)}%` : '', familiarityBonus ? `familiarity +${familiarityBonus.toFixed(0)}%` : '', collectorBonus ? `collector +${collectorBonus.toFixed(0)}%` : ''].filter(Boolean).join(' · ') || 'no fish bonus';
        return `<div class="personal-pond__finder-row"><span class="personal-pond__finder-name">${escText(row.name)}</span><span class="personal-pond__finder-weight">${Number(row.weight).toFixed(4)} <small>fish +${totalBonus.toFixed(0)}% (${fishBonus}) · bait +${baitBonus.toFixed(0)}% rarity</small></span><span class="personal-pond__finder-chance">${chance.toFixed(2)}%</span></div>`;
      }).join('');
      const finderPanel = level('fishFinder') ? `<div class="personal-pond__feature-card" style="--feature-accent:#8ec7ff;margin-top:7px"><div class="personal-pond__feature-kicker">05 · LIVE</div><div class="personal-pond__feature-title">${pond.treasuryModeActive ? 'Fish Finder · Treasury loot pool' : 'Fish Finder · all 146 pond fish'}</div><div class="personal-pond__feature-copy">${pond.treasuryModeActive ? 'Shows each Treasury item share of the Treasury Only catch chance. Misses are Mud, matching !fish Treasury Only mode.' : 'Your actual current chance to catch each fish. Fish bonuses are individual weight added by selection, fish upgrades and Familiarity. Active bait boosts rarity weighting and is included in the displayed chance.'}</div><button type="button" class="vault-tab-btn personal-pond__odds-toggle" aria-expanded="${liveOddsOpen ? 'true' : 'false'}" onclick="togglePondLiveOdds()">${liveOddsOpen ? 'CLOSE LIVE ODDS' : 'VIEW LIVE ODDS'}</button>${liveOddsOpen ? `<div class="personal-pond__bait-live"><b>ACTIVE BAIT:</b> ${escText(baitText)}${escText(baitCountNote)}</div><div class="personal-pond__finder"><div class="personal-pond__finder-row personal-pond__finder-head"><span class="personal-pond__finder-name">FISH</span><span class="personal-pond__finder-weight">WEIGHT · BONUSES</span><span class="personal-pond__finder-chance">ACTUAL CHANCE</span></div>${finderRows}</div>` : ''}</div>` : '';
      return `<details class="personal-pond__section pond-fold" data-pond-fold="systems"${pondFoldAttr('systems')}><summary class="personal-pond__section-head"><b>Pond systems</b><span>5 active systems</span></summary><div class="pond-fold__body"><div class="personal-pond__feature-grid">${cards.map(([num,title,copy,id,accent,state,action]) => `<article class="personal-pond__feature-card" style="--feature-accent:${accent}"><div class="personal-pond__feature-kicker">${num} · ACTIVE</div><div class="personal-pond__feature-title">${title}</div><div class="personal-pond__feature-copy">${copy}</div><div class="personal-pond__feature-level"><span>${state}</span><span>${id === 'fishFinder' && level(id) ? 'LIVE ODDS' : ''}</span></div><div class="personal-pond__feature-action">${action}</div></article>`).join('')}</div>${finderPanel}</div></details>`;
    }

    function capturePondPageViewport() {
      const active = document.activeElement;
      const panel = document.getElementById('personalPondPanel');
      let focus = null;
      if (active && panel?.contains(active)) {
        focus = {
          id: active.id || '',
          pondAction: active.getAttribute('data-pond-action') || '',
          pondFeature: active.getAttribute('data-pond-feature') || '',
          pondFishAction: active.getAttribute('data-pond-fish-action') || '',
          pondFish: active.getAttribute('data-pond-fish') || ''
        };
      }
      return { x: window.scrollX, y: window.scrollY, focus };
    }
    function restorePondPageViewport(viewport) {
      if (!viewport) return;
      const restore = () => {
        window.scrollTo({ left: viewport.x, top: viewport.y, behavior: 'instant' });
        if (!viewport.focus) return;
        const esc = (v) => (window.CSS?.escape ? CSS.escape(v) : String(v).replace(/([\\"'#.:\[\],= ])/g, '\\$1'));
        let target = viewport.focus.id ? document.getElementById(viewport.focus.id) : null;
        if (!target && viewport.focus.pondFeature) target = document.querySelector(`[data-pond-feature=\"${esc(viewport.focus.pondFeature)}\"]`);
        if (!target && viewport.focus.pondAction) target = document.querySelector(`[data-pond-action=\"${esc(viewport.focus.pondAction)}\"]`);
        if (!target && viewport.focus.pondFishAction && viewport.focus.pondFish) target = document.querySelector(`[data-pond-fish-action=\"${esc(viewport.focus.pondFishAction)}\"][data-pond-fish=\"${esc(viewport.focus.pondFish)}\"]`);
        if (target) { try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); } }
      };
      requestAnimationFrame(() => { restore(); requestAnimationFrame(restore); });
    }

    function renderPersonalPond(pond) {
      const box = document.getElementById('personalPondPanel');
      if (!box) return;

      // Preserve the user's viewport and local scroll positions whenever the
      // pond re-renders. Selection/unlock/upgrade actions replace the pond
      // markup, and removing the focused button can otherwise make the browser
      // jump back to the top of the page. Restoring focus with preventScroll
      // keeps the user exactly where they were.
      const active = document.activeElement;
      const activePondButton = active && box.contains(active) && active.matches('[data-pond-fish-action][data-pond-fish]')
        ? { action: active.dataset.pondFishAction, fish: active.dataset.pondFish }
        : null;
      const fishGrid = box.querySelector('.personal-pond__fish-grid');
      const converterGrid = box.querySelector('.personal-pond__converter-grid');
      const viewport = { x: window.scrollX, y: window.scrollY };
      const localScroll = {
        fishTop: fishGrid?.scrollTop || 0,
        fishLeft: fishGrid?.scrollLeft || 0,
        converterTop: converterGrid?.scrollTop || 0,
        converterLeft: converterGrid?.scrollLeft || 0
      };
      const restorePondViewport = () => {
        window.scrollTo(viewport.x, viewport.y);
        const nextFishGrid = box.querySelector('.personal-pond__fish-grid');
        const nextConverterGrid = box.querySelector('.personal-pond__converter-grid');
        if (nextFishGrid) { nextFishGrid.scrollTop = localScroll.fishTop; nextFishGrid.scrollLeft = localScroll.fishLeft; }
        if (nextConverterGrid) { nextConverterGrid.scrollTop = localScroll.converterTop; nextConverterGrid.scrollLeft = localScroll.converterLeft; }
        if (activePondButton) {
          const selector = `[data-pond-fish-action="${CSS.escape(activePondButton.action)}"][data-pond-fish="${CSS.escape(activePondButton.fish)}"]`;
          const nextButton = box.querySelector(selector);
          if (nextButton) nextButton.focus({ preventScroll: true });
        }
      };
      const prestige = Number(window.__lastAutoFishData?.prestige || 0);
      if (!pond || pond.unlocked === false) {
        if (prestige < 1) {
          box.innerHTML = `<section class="personal-pond"><div class="personal-pond__locked"><div class="personal-pond__head"><div><span class="personal-pond__eyebrow">PERSONAL POND · LOCKED</span><h3 class="personal-pond__title">Fishy’s Pond</h3><div class="personal-pond__sub">Your personal pond unlocks at Prestige 1. Once unlocked, fish appear automatically and stay until you collect them.</div></div><div class="personal-pond__token">PRESTIGE 1</div></div><div class="personal-pond__water"><div class="personal-pond__empty">🐟 Reach Prestige 1 to open Fishy’s Pond.</div></div></div></section>`;
        } else if (!window.__pondLastStatus) {
          box.innerHTML = `<section class="personal-pond"><div class="personal-pond__locked"><div class="personal-pond__head"><div><span class="personal-pond__eyebrow">PERSONAL POND</span><h3 class="personal-pond__title">Fishy’s Pond</h3><div class="personal-pond__sub">Loading your pond…</div></div></div><div class="personal-pond__water"><div class="personal-pond__empty">🐟 Fishy is getting the pond ready…</div></div></div></section>`;
        }
        return;
      }
      const pending = Array.isArray(pond.pending) ? pond.pending : [];
      const stash = Array.isArray(pond.stash) ? pond.stash : [];
      const serverSelected = new Set(Array.isArray(pond.selected) ? pond.selected : []);
      // Keep an unsaved local selection draft across harmless pond refreshes.
      // The server remains authoritative once the user presses Save pond selection.
      const hasDraft = window.__pondSelectionDirty === true && window.__pondSelection instanceof Set;
      const selected = hasDraft ? new Set(window.__pondSelection) : serverSelected;
      window.__pondSelection = new Set(selected);
      window.__pondLastStatus = { ...pond, selected:[...selected] };
      const remaining = Math.max(0, Number(pond.nextSpawnAt || 0) - Number(pond.now || Date.now()));
      const nextText = pending.length >= Number(pond.capacity || 3) ? 'Pond full' : formatAutoFishCooldown(remaining);
      const stashCounts = new Map(); stash.forEach((item) => stashCounts.set(item, (stashCounts.get(item) || 0) + 1));
      const stashHtml = stashCounts.size ? [...stashCounts].map(([item,count]) => `<span class="personal-pond__stash-item">${escText(item)} ×${count}</span>`).join('') : '<span class="personal-pond__hint">Nothing waiting in the stash.</span>';
      const pendingHtml = pending.length ? pending.map((item,index) => {
        const tier = (pond.treasuryItemNames || []).includes(item) ? 'TREASURY' : (pond.catalog?.find((f) => f.name === item)?.tier || 'COMMON');
        return `<div class="personal-pond__slot" data-fish="${pondAttr(item)}" style="${pondFishMotion(item,index)}"><div>${pondFishyIcon(item,tier)}</div><span class="personal-pond__slot-name" title="${pondAttr(item)}">${escText(item)}</span></div>`;
      }).join('') : '<div class="personal-pond__empty">Fishy is waiting for the next catch.</div>';
      const chat = Number(window.__lastAutoFishData?.prestige || 0) >= 2;
      box.innerHTML = `
        <section class="personal-pond">
          <div class="personal-pond__autofish-note">Must have Auto-Fish enabled to work.</div>
          <div class="personal-pond__head"><div><span class="personal-pond__eyebrow">PERSONAL POND · LEVEL ${Number(pond.level || 1)}${pond.treasuryModeActive ? ' · TREASURY ONLY' : ''}</span><h3 class="personal-pond__title">Fishy’s Pond</h3><div class="personal-pond__sub">${pond.treasuryModeActive ? `Treasury Only odds from !fish: ${(Number(pond.treasuryCatchChance || 0) * 100).toFixed(1)}% Treasury catch chance. Misses act as Mud; Treasury catches go to inventory.` : `A fish appears every ${Math.round(Number(pond.intervalSeconds || 180) / 60)} min and stays until collected. ${Number(pond.capacity || 3)} pond slots.`}</div></div><div class="personal-pond__token">${Number(pond.tokens || 0).toLocaleString()} FishyTokens</div></div>
          <div class="personal-pond__water ${pending.length >= Number(pond.capacity || 3) ? 'is-full' : ''}">${pendingHtml}</div>
          <div class="personal-pond__controls"><span class="personal-pond__status">${nextText}</span><button type="button" class="success-btn" ${pending.length ? '' : 'disabled'} onclick="collectPersonalPond()">${pond.treasuryModeActive ? 'Collect to inventory' : 'Collect to stash'}</button>${stash.length ? `<button type="button" class="vault-tab-btn" onclick="pondStashAction('inventory')">Stash → Inventory</button><button type="button" class="vault-tab-btn" onclick="pondStashAction('tokens')">Stash → FishyTokens</button>` : ''}</div>
          <div class="personal-pond__section"><div class="personal-pond__section-head"><b>Pond stash</b><span>${stash.length} fish</span></div><div class="personal-pond__stash">${stashHtml}</div></div>
          ${renderPondFeatureSystems(pond)}
          <details class="personal-pond__section pond-fold" data-pond-fold="upgrades"${pondFoldAttr('upgrades')}><summary class="personal-pond__section-head"><b>Pond upgrades</b><span>${pond.nextUpgradeCost ? `Next upgrade · ${Number(pond.nextUpgradeCost).toLocaleString()} FishyTokens` : 'MAX LEVEL'}</span></summary><div class="pond-fold__body"><div class="personal-pond__upgrade-card"><div class="personal-pond__upgrade-copy"><div class="personal-pond__upgrade-title">Level ${Number(pond.level || 1)} <button type="button" class="autofish-info-btn" onclick="openPondInfo()"><svg class="ic"><use href="#i-info"></use></svg>Info</button></div><p>Leveling adds one pond slot and shortens the spawn timer. Fish selection capacity is ${Math.min(3, Number(pond.level || 1))}.</p></div><button type="button" class="shop-item-cta" data-pond-action="level-upgrade" ${pond.nextUpgradeCost ? '' : 'disabled'} onclick="upgradePersonalPond()">${pond.nextUpgradeCost ? `Upgrade · ${Number(pond.nextUpgradeCost).toLocaleString()} 🪙` : 'Fully upgraded'}</button></div></div></details>
          <details class="personal-pond__section pond-fold" data-pond-fold="fish"${pondFoldAttr('fish')}><summary class="personal-pond__section-head"><b>${pond.treasuryModeActive ? 'Treasury loot pool' : 'Choose pond fish'}</b><span class="personal-pond__selection-count">${pond.treasuryModeActive ? `${(pond.treasuryCatalog || pond.catalog || []).length} Treasury items` : `${selected.size}/${Math.min(3, Number(pond.level || 1))} selected`}</span></summary><div class="pond-fold__body"><div class="personal-pond__fish-grid">${renderPondFishSelection({ ...pond, selected:[...selected] })}</div>${pond.treasuryModeActive ? '<div class="personal-pond__controls"><span class="personal-pond__hint">Treasury Waters uses Treasury Only !fish logic. The active catalog excludes timeout loot. No normal fish selection or upgrades apply while this mode is on.</span></div>' : '<div class="personal-pond__controls"><button type="button" class="vault-tab-btn" id="pondSelectionSaveButton" onclick="applyPondFishSelection()">Saved automatically</button><span class="personal-pond__hint">All normal pond fish can roll. Selection changes are saved automatically; upgrades make selected fish heavier.</span></div>'}</div></details>
          <details class="personal-pond__section pond-fold" data-pond-fold="converter"${pondFoldAttr('converter')}><summary class="personal-pond__section-head"><b>FishyToken converter</b><span>Normal fish · no Godly/Secret</span></summary><div class="pond-fold__body">${renderPondConverter(pond)}</div></details>
          ${chat ? `<details class="personal-pond__section pond-fold" data-pond-fold="chat"${pondFoldAttr('chat')}><summary class="personal-pond__section-head"><b>Twitch chat collection</b><span>${pond.chatUnlocked ? 'UNLOCKED' : 'LOCKED'}</span></summary><div class="pond-fold__body"><div class="personal-pond__upgrade"><button type="button" class="shop-item-cta" ${pond.chatUnlocked ? 'disabled' : ''} onclick="enablePondChat()">${pond.chatUnlocked ? '!fish pond enabled' : 'Enable !fish pond'}</button><span class="personal-pond__hint">At Prestige 2, enable this once and <code>!fish pond</code> collects ready pond fish directly into inventory.</span></div></details>` : ''}
        </section>`;
      if (!box.dataset.foldBound) {
        box.dataset.foldBound = '1';
        box.addEventListener('toggle', (event) => {
          const fold = event.target;
          if (!fold?.matches?.('details[data-pond-fold]')) return;
          window.__pondFoldOpen = { ...(window.__pondFoldOpen || {}), [fold.dataset.pondFold]: fold.open };
        }, true);
      }
      window.__pondMotionRunning = false;
      startPondFishMotion();
      // The browser may perform its own focus/scroll adjustment after the
      // replaced DOM is committed, so restore on the next two frames.
      requestAnimationFrame(() => {
        restorePondViewport();
        requestAnimationFrame(restorePondViewport);
      });
    }
    function togglePondLiveOdds() {
      window.__pondLiveOddsOpen = !window.__pondLiveOddsOpen;
      const pond = window.__pondLastStatus;
      if (!pond) return;
      const viewport = capturePondPageViewport();
      renderPersonalPond(pond);
      restorePondPageViewport(viewport);
    }
    function setPondConverterFilter(filter) { window.__pondConverterFilter = filter; renderPersonalPond(window.__pondLastStatus); }
    function setPondConverterSearch(value) { window.__pondConverterSearch = value || ''; renderPersonalPond(window.__pondLastStatus); const input = document.querySelector('.personal-pond__converter-search input'); if (input) { input.focus(); input.setSelectionRange(input.value.length,input.value.length); } }
    async function loadPondStatus() {
      try {
        const pond = await pondRequest();
        renderPersonalPond(pond);
        renderPondTreasuryPerkShop(pond);
        // The first Pond request can create the unlock record at Prestige 1.
        // Refresh perks if their initial response raced ahead of that unlock.
        if (pond?.unlocked && window.__tutorialPerksData?.pond?.unlocked !== true && !window.__pondPerksRefreshPending) {
          window.__pondPerksRefreshPending = true;
          try {
            await loadPerksStatus();
          } finally {
            window.__pondPerksRefreshPending = false;
          }
        }
      } catch (err) {
        console.error('Failed to load Personal Pond:', err);
      }
    }
    function tickPersonalPondTimer() {
      const pond = window.__pondLastStatus;
      const status = document.querySelector('.personal-pond__status');
      if (!pond || !status || !document.getElementById('personalPondPanel')) return;
      const pending = Array.isArray(pond.pending) ? pond.pending : [];
      const capacity = Number(pond.capacity || 3);
      if (pending.length >= capacity) { status.textContent = 'Pond full'; return; }
      const offset = Number(pond.now || 0) - Date.now();
      const remaining = Math.max(0, Number(pond.nextSpawnAt || 0) - (Date.now() + offset));
      status.textContent = remaining <= 0 ? 'CATCH READY' : formatAutoFishCooldown(remaining);
      if (remaining <= 0 && Date.now() - Number(window.__pondLastPollAt || 0) > 3500) {
        window.__pondLastPollAt = Date.now();
        loadPondStatus();
      }
    }
    if (!window.__pondTimerTicker) window.__pondTimerTicker = setInterval(tickPersonalPondTimer, 1000);
    async function collectPersonalPond() { const treasuryMode = window.__pondLastStatus?.treasuryModeActive === true; try { const d = await pondRequest({ action:'collect' }); const mixed = Number(d.normalCount || 0) > 0 && Number(d.treasuryCount || 0) > 0 && !d.toInventory && !treasuryMode; const toInventory = !!d.toInventory || treasuryMode || (!Number(d.normalCount || 0) && Number(d.treasuryCount || 0) > 0); const message = !d.count ? (treasuryMode ? 'Your Treasury Pond has no catches waiting.' : 'Your pond is empty.') : mixed ? `Collected ${d.normalCount} normal fish to your stash and ${d.treasuryCount} Treasury fish to your inventory.` : `Collected ${d.count} pond fish into your ${toInventory ? 'inventory' : 'stash'}.`; toast(message, 'success', {label:'Personal Pond'}); await Promise.all([loadAutoFishStatus(), loadPondStatus()]); } catch (err) { toast(err.message,'error',{label:'Personal Pond'}); } }
    async function pondStashAction(mode) { try { const d = await pondRequest({ action:'stash', mode }); toast(mode === 'tokens' ? `Converted ${d.count} pond fish into ${d.value} FishyTokens.` : `Moved ${d.count} pond fish into your inventory.`, 'success', {label:'Pond stash'}); await loadAutoFishStatus(); } catch (err) { toast(err.message,'error',{label:'Pond stash'}); } }
    async function upgradePersonalPond() { const viewport = capturePondPageViewport(); try { const d = await pondRequest({ action:'upgrade' }); toast(`Pond upgraded to Level ${d.level}.`, 'success', {label:'Personal Pond'}); await loadAutoFishStatus(true, viewport); } catch (err) { restorePondPageViewport(viewport); toast(err.message,'error',{label:'Pond upgrade'}); } }
    async function unlockPondFish(name) { await runPurchase('pond-fish:' + name, async () => { const viewport = capturePondPageViewport(); try { await pondRequest({ action:'unlockFish', fish:name }); toast(`${name} unlocked for your pond.`, 'success', {label:'Pond fish'}); refreshInBackground(() => loadAutoFishStatus(true, viewport)); } catch (err) { restorePondPageViewport(viewport); toast(err.message,'error',{label:'Pond fish'}); } }); }
    async function upgradePondFish(name) { await runPurchase('pond-fish:' + name, async () => { const viewport = capturePondPageViewport(); try { const d = await pondRequest({ action:'upgradeFish', fish:name }); toast(`${name} upgraded to +${d.weightBonus}% pond weight.`, 'success', {label:'Pond fish'}); refreshInBackground(() => loadAutoFishStatus(true, viewport)); } catch (err) { restorePondPageViewport(viewport); toast(err.message,'error',{label:'Pond fish upgrade'}); } }); }
    function queuePondSelectionSave() {
      if (window.__pondSelectionSaveTimer) clearTimeout(window.__pondSelectionSaveTimer);
      window.__pondSelectionSaveTimer = setTimeout(() => { applyPondFishSelection(true); }, 180);
    }
    async function togglePondFish(name) {
      const current = new Set(window.__pondSelection || window.__pondLastStatus?.selected || []);
      const max = Math.min(3, Number(window.__pondLastStatus?.level || 1));
      const key = String(name || '');
      if (current.has(key)) current.delete(key);
      else {
        if (current.size >= max) { toast('Upgrade your pond to select more fish.', 'info', {label:'Pond capacity'}); return; }
        current.add(key);
      }
      window.__pondSelection = current;
      window.__pondSelectionDirty = true;
      window.__pondLastStatus = { ...(window.__pondLastStatus || {}), selected:[...current] };
      const fishGrid = document.querySelector('.personal-pond__fish-grid');
      const card = fishGrid ? [...fishGrid.querySelectorAll('[data-pond-fish-action="toggle"][data-pond-fish]')].find((button) => button.dataset.pondFish === key)?.closest('.personal-pond__fish') : null;
      const button = card?.querySelector('[data-pond-fish-action="toggle"]');
      if (card && button) {
        const selected = current.has(key);
        card.classList.toggle('is-selected', selected);
        button.classList.toggle('active', selected);
        button.textContent = selected ? 'Selected · click to remove' : `Select (${current.size}/${max})`;
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      }
      const count = document.querySelector('.personal-pond__selection-count');
      if (count) count.textContent = `${current.size}/${max} selected`;
      const saveButton = document.getElementById('pondSelectionSaveButton');
      if (saveButton) { saveButton.disabled = false; saveButton.textContent = 'Saving…'; }
      queuePondSelectionSave();
    }
    async function applyPondFishSelection(silent = false) {
      const fish = [...(window.__pondSelection || [])];
      const saveKey = JSON.stringify(fish);
      const saveButton = document.getElementById('pondSelectionSaveButton');
      if (saveButton) { saveButton.disabled = true; saveButton.textContent = 'Saving…'; }
      try {
        const d = await pondRequest({ action:'selectFish', fish });
        if (JSON.stringify([...(window.__pondSelection || [])]) === saveKey) {
          window.__pondSelectionDirty = false;
          window.__pondLastStatus = { ...(window.__pondLastStatus || {}), selected:[...(d.selected || fish)] };
          if (saveButton) { saveButton.disabled = false; saveButton.textContent = 'Saved automatically'; }
        } else if (saveButton) {
          saveButton.disabled = false;
          saveButton.textContent = 'Saving…';
        }
        if (!silent) toast('Pond fish selection saved.', 'success', {label:'Personal Pond'});
      } catch (err) {
        if (saveButton) { saveButton.disabled = false; saveButton.textContent = 'Retry save'; }
        if (!silent) toast(err.message,'error',{label:'Pond selection'});
      }
    }
    async function upgradePondFeature(feature) {
      await runPurchase('pond-feature:' + feature, async () => {
        const viewport = capturePondPageViewport();
        try {
          const d = await pondRequest({ action:'upgradeFeature', feature });
          toast(`${d.featureInfo?.label || feature} upgraded to Level ${d.level}.`, 'success', {label:'Pond system'});
          refreshInBackground(() => loadAutoFishStatus(true, viewport));
        } catch (err) {
          restorePondPageViewport(viewport);
          toast(err.message || 'Not enough FishyTokens.', 'error',{label:'Pond system'});
        }
      });
    }
    async function upgradePondTreasuryPerk(perk) {
      await runPurchase('pond-perk:' + perk, async () => {
        const viewport = capturePondPageViewport();
        try {
          const d = await pondRequest({ action:'upgradeTreasuryPerk', perk });
          toast(`${d.perkInfo?.label || perk} upgraded to Level ${d.level}.`, 'success', {label:'Pond perk'});
          refreshInBackground(
            () => Promise.all([loadPondStatus(), loadPerksStatus()]).then(() => restorePondPageViewport(viewport))
          );
        } catch (err) {
          restorePondPageViewport(viewport);
          toast(err.message || 'Not enough Treasury.', 'error', {label:'Pond perk'});
        }
      });
    }

    async function setPondBaitSlot(index, baitId) {
      const slots = Array.isArray(window.__pondLastStatus?.baitSlots) ? [...window.__pondLastStatus.baitSlots] : [];
      const max = Number(window.__pondLastStatus?.featureUpgrades?.baitSlots || 0);
      while (slots.length < max) slots.push('worm');
      slots[index] = baitId || 'worm';
      try {
        const d = await pondRequest({ action:'setBaitSlots', baitSlots:slots.slice(0,max) });
        window.__pondLastStatus = { ...(window.__pondLastStatus || {}), baitSlots:d.baitSlots };
        await loadPondStatus();
      } catch (err) { toast(err.message,'error',{label:'Pond bait'}); await loadPondStatus(); }
    }

    async function enablePondChat() { try { await pondRequest({ action:'enableChat' }); toast('!fish pond is now enabled at Prestige 2.', 'success', {label:'Pond chat'}); await loadAutoFishStatus(); } catch (err) { toast(err.message,'error',{label:'Pond chat'}); } }
    async function convertPondInventory(item, count) { try { const d = await pondRequest({ action:'convert', item, count }); toast(`Converted ${d.count} fish into ${d.value} FishyTokens.`, 'success', {label:'FishyToken converter'}); await loadAutoFishStatus(); } catch (err) { toast(err.message,'error',{label:'FishyToken converter'}); } }

    async function openPondInfo() {
      const modal = document.getElementById('pondInfoModal'); const content = document.getElementById('pondInfoContent');
      if (!modal || !content) return; modal.classList.add('active');
      const costs = Array.isArray(window.__pondLastStatus?.nextUpgradeCost) ? window.__pondLastStatus.nextUpgradeCost : null;
      const levels = [
        { level:1, cost:'Starting level', cap:3, interval:180, effect:'Base pond · 3 slots · 1 fish every 3 min' },
        { level:2, cost:'100 FishyTokens', cap:4, interval:160, effect:'4 slots · faster fish · 2 pond fish choices' },
        { level:3, cost:'350 FishyTokens', cap:5, interval:140, effect:'5 slots · faster fish · 3 pond fish choices' },
        { level:4, cost:'900 FishyTokens', cap:6, interval:120, effect:'6 slots · faster fish · 3 pond fish choices' },
        { level:5, cost:'2,000 FishyTokens', cap:7, interval:100, effect:'7 slots · fastest pond timer' }
      ];
      const luck = Number(window.__pondLastStatus?.luckMultiplier || 1).toFixed(2);
      content.innerHTML = `<div class="pond-info-grid"><section class="pond-info-section"><div class="pond-info-section__header"><div><span class="pond-info-section__eyebrow">PROGRESSION</span><h4>Pond levels</h4></div><span class="pond-info-section__count">${levels.length} levels</span></div>${levels.map(row => `<article class="pond-info-card"><div class="pond-info-card__head"><h4>Level ${row.level}</h4><span class="pond-info-card__cost">${row.cost}</span></div><div class="pond-info-card__effects"><span>${row.cap} pond slots</span><span>${Math.round(row.interval/60)} min base timer</span><span>${row.effect}</span></div></article>`).join('')}</section><section class="pond-info-section"><div class="pond-info-section__header"><div><span class="pond-info-section__eyebrow">ROLL LOGIC</span><h4>How your pond chooses a fish</h4></div><span class="pond-info-section__count">${luck}× Luck</span></div><article class="pond-info-card"><div class="pond-info-card__head"><h4>1 · Every pond fish can roll</h4><span class="pond-info-card__cost">146 FISH</span></div><div class="pond-info-card__effects"><span>Locked fish can still appear. You do not have to unlock a fish for it to be rolled.</span><span>Unlocking only lets you target that fish and buy its weight upgrades.</span></div></article><article class="pond-info-card"><div class="pond-info-card__head"><h4>2 · Rarity sets the starting chance</h4><span class="pond-info-card__cost">LUCK APPLIES</span></div><div class="pond-info-card__effects"><span>Rarity gives each fish its starting share of the pond's weight.</span><span>Your normal Luck is added on top, making rarer tiers more likely just like normal fishing.</span></div></article><article class="pond-info-card"><div class="pond-info-card__head"><h4>3 · Selecting a fish gives it a little more weight</h4><span class="pond-info-card__cost">+25%</span></div><div class="pond-info-card__effects"><span>Selecting a fish adds +25% to that fish's individual weight.</span><span>It is a focus bonus — it makes the fish more likely, but never guarantees it.</span></div></article><article class="pond-info-card"><div class="pond-info-card__head"><h4>4 · Upgrades make your fish heavier</h4><span class="pond-info-card__cost">+50% / +100%</span></div><div class="pond-info-card__effects"><span>Upgrade 1 = +50% weight. Upgrade 2 = +100% weight.</span><span>If that fish is also selected, the bonuses add together: selected + fully upgraded = 2.25× its base weight.</span></div></article><article class="pond-info-card"><div class="pond-info-card__head"><h4>5 · The pond makes one weighted roll</h4><span class="pond-info-card__cost">SERVER-SIDE</span></div><div class="pond-info-card__effects"><span>The game adds up all fish weights, picks one random point, and the fish covering that point wins.</span><span>More weight = more chance. Nothing is guaranteed.</span></div></article><article class="pond-info-card"><div class="pond-info-card__head"><h4>Easy example</h4><span class="pond-info-card__cost">10 + 20 = 30</span></div><div class="pond-info-card__effects"><span>Fish A has weight 10 and Fish B has weight 20. Together that is 30.</span><span>Fish A has 10/30 = 33% chance. Fish B has 20/30 = 67% chance.</span></div></article></section><section class="pond-info-section"><div class="pond-info-section__header"><div><span class="pond-info-section__eyebrow">POND SYSTEMS</span><h4>How the extra upgrades work</h4></div><span class="pond-info-section__count">5 systems</span></div><article class="pond-info-card"><div class="pond-info-card__effects"><span><b>Deep Water</b> — each level adds +10% weight to non-Common rarity tiers.</span><span><b>Lucky Water</b> — each level makes your normal Luck 10% stronger inside the pond. It stacks on top of your normal Luck.</span><span><b>Fish Finder</b> — unlocks a live list showing every pond fish's current weight and final chance.</span><span><b>Bait Slots</b> — uses your existing bait inventory for pond spawns. Premium bait is consumed only when the pond actually uses it.</span><span><b>Familiarity</b> — every 5 times you collect the same fish gives it +1% individual weight, up to the Familiarity level cap.</span></div></article></section></div>`;
    }
    function closePondInfo() { document.getElementById('pondInfoModal')?.classList.remove('active'); }
    document.addEventListener('click', (event) => { const modal = document.getElementById('pondInfoModal'); if (modal && event.target === modal) closePondInfo(); });

    function fishyMessageForAutoFish(data) {
      if (data.autoBrokenUntil && data.autoBrokenUntil > autoFishNow()) {
        return ['excited', '💥 My Auto-Fish broke! I’ll be back when the repair countdown reaches zero.'];
      }
      if (Array.isArray(data.events) && data.events.length) return ['event', 'Psst! I found Treasury! Come collect it! 💰'];
      if (data.active) return ['fishing', data.autoCasts > 0 ? 'I’m on watch! You can relax — I’ve got the line. 🎣' : 'Okay, buddy! I’ll keep an eye on the water.'];
      if (data.masteryComplete) return ['excited', 'We made it! Fishy Mastery is complete! ✨'];
      if (data.prestige > 0 && data.xp === 0) return ['excited', 'New prestige, new adventure! Let’s go!'];
      if (data.licensed) return ['idle', 'Hey! I’m Fishy. I’ll watch the line while you do your thing. 🐟'];
      if (data.areaLevel3Eligible) return ['excited', `You reached Level 3 in ${data.areaLevel3Area?.name || 'a fishing area'}! I’m ready for my license. ⚙️`];
      return ['idle', 'Hi! I’m Fishy. Reach Area 1 Level 3 and I can become your little automation buddy!'];
    }

    async function openAutoFishInfo() {
      const modal = document.getElementById('autoFishInfoModal');
      const content = document.getElementById('autoFishInfoContent');
      if (!modal || !content) return;

      // The info screen is informational and must always be available.
      // Fetch the server status/config even when the player has no license
      // or Auto-Fish is globally disabled; this also keeps the displayed
      // level/prestige values in sync with admin changes.
      content.innerHTML = '<div class="autofish-info-loading">Loading Auto-Fish progression…</div>';
      modal.classList.add('active');
      try {
        const fresh = await autoFishRequest();
        window.__lastAutoFishData = fresh;
      } catch (err) {
        if (!window.__lastAutoFishData) {
          content.innerHTML = `<div class="autofish-empty">Could not load Auto-Fish information. ${escText(err.message || 'Please try again.')}</div>`;
          return;
        }
      }

      const data = window.__lastAutoFishData || {};
      const levels = Array.isArray(data.levelTable) ? data.levelTable : [];
      const prestiges = Array.isArray(data.prestigeTable) ? data.prestigeTable : [];
      const cfg = data.config || {};

      const rows = levels.map((row) => {
        const features = Array.isArray(row.features) && row.features.length ? row.features : ['Core Auto-Fish'];
        const featureHtml = features.map((feature) => `<li>${escText(feature)}</li>`).join('');
        return `
          <article class="autofish-level-card">
            <div class="autofish-level-card__head">
              <div><span class="autofish-level-card__eyebrow">AUTO-FISH</span><h4>Level ${Number(row.level) || 0}</h4></div>
              <span class="autofish-level-badge">${Number(row.efficiency) || 0}% efficiency</span>
            </div>
            <div class="autofish-level-stats">
              <div><span>Max session</span><strong>${Number(row.sessionMinutes) || 0} min</strong></div>
              <div><span>Max tank capacity</span><strong>${Number(row.attention) || 0} treats</strong></div>
            </div>
            <div class="autofish-level-unlocks"><span>UNLOCKS</span><ul>${featureHtml}</ul></div>
          </article>`;
      }).join('');

      const prestigeRows = prestiges.map((p, i) => {
        const perks = Array.isArray(p.perks) ? p.perks : [];
        return `
        <article class="autofish-prestige-card">
          <div class="autofish-prestige-card__head"><div><span class="autofish-level-card__eyebrow">PRESTIGE ${i + 1}</span><h4>${i + 1}. ${escText(p.name)}</h4></div></div>
          <div class="autofish-prestige-requirements"><span>REQUIREMENTS</span><ul>
            <li>Auto-Fish Level ${Number(p.level) || 0}</li>
            <li>Area Progress ${Number(p.areaProgress) || 0}</li>
            <li>${Number(p.manualCasts || 0).toLocaleString()} lifetime manual casts</li>
            <li>${Number(p.treasuryEarned || 0).toLocaleString()} Treasury earned</li>
            <li>${Number(p.eventsCompleted || 0).toLocaleString()} Fishy treats collected</li>
          </ul></div>
          <div class="autofish-prestige-perks"><span>PERKS YOU GAIN</span><ul>${perks.map(perk => `<li>${escText(perk)}</li>`).join('') || '<li>Prestige title unlocked</li>'}</ul></div>
          <p class="autofish-info-note">Prestige resets Auto-Fish level and XP only. Areas, Fishdex, cosmetics, manual progression and previous prestige remain.</p>
        </article>`;
      }).join('');

      content.innerHTML = `
        <div class="autofish-info-status">
          <span class="autofish-info-status__dot ${cfg.enabled === false ? 'is-off' : ''}"></span>
          <strong>${cfg.enabled === false ? 'Auto-Fish is currently disabled' : 'Auto-Fish progression'}</strong>
          <span>${data.licensed ? 'License active' : 'License not yet purchased'}</span>
        </div>
        <div class="autofish-info-grid">
          <section class="autofish-info-section"><div class="autofish-info-section__header"><div><span class="autofish-section-eyebrow">PROGRESSION</span><h4>All Auto-Fish Levels</h4></div><span class="autofish-section-count">${levels.length} levels</span></div><div class="autofish-level-list">${rows || '<div class="autofish-empty">No level data available.</div>'}</div></section>
          <section class="autofish-info-section"><div class="autofish-info-section__header"><div><span class="autofish-section-eyebrow">MASTERY</span><h4>Prestige Tiers</h4></div><span class="autofish-section-count">${prestiges.length}/5</span></div><div class="autofish-prestige-list">${prestigeRows || '<div class="autofish-empty">No prestige tiers available.</div>'}</div><div class="autofish-final-note">Grandmaster is the final tier. Reaching Prestige 5 completes Auto-Fish progression.</div></section>
        </div>`;
    }

function closeAutoFishInfo() { document.getElementById('autoFishInfoModal')?.classList.remove('active'); }
    document.addEventListener('click', (event) => {
      const modal = document.getElementById('autoFishInfoModal');
      if (modal && event.target === modal) closeAutoFishInfo();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAutoFishInfo();
    });

    function closeAutoFishTargetPickers(except) {
      document.querySelectorAll('.autofish-target-picker.is-open').forEach((el) => { if (el !== except) el.classList.remove('is-open'); });
    }
    function toggleAutoFishTargetPicker() {
      const picker = document.getElementById('autoFishTargetPicker');
      if (!picker) return;
      const open = !picker.classList.contains('is-open');
      closeAutoFishTargetPickers(picker);
      picker.classList.toggle('is-open', open);
    }
    async function selectAutoFishTarget(encoded) {
      const value = encoded === '__none__' ? '' : decodeURIComponent(encoded);
      closeAutoFishTargetPickers();
      await setAutoFishTarget(value);
    }
    // (i) info icon with a hover / focus / tap tooltip. Pass inline=true to place it in running text.
    function afTip(text, inline = false) {
      if (!text) return '';
      return `<span class="af-tip${inline ? ' af-tip--inline' : ''}" tabindex="0" role="note"><svg class="ic" aria-hidden="true"><use href="#i-info"></use></svg><span class="af-tip__bubble" role="tooltip">${escText(text)}</span></span>`;
    }
    function placeAfTip(tip) {
      const bubble = tip.querySelector('.af-tip__bubble');
      if (!bubble) return;
      tip.classList.remove('is-left');
      bubble.style.width = '';
      let r = bubble.getBoundingClientRect();
      if (r.left < 8) {
        tip.classList.add('is-left');
        r = bubble.getBoundingClientRect();
        if (r.right > window.innerWidth - 8) bubble.style.width = `${Math.max(140, window.innerWidth - r.left - 8)}px`;
      }
    }
    document.addEventListener('mouseover', (event) => { const tip = event.target.closest?.('.af-tip'); if (tip) placeAfTip(tip); });
    document.addEventListener('focusin', (event) => { const tip = event.target.closest?.('.af-tip'); if (tip) placeAfTip(tip); });

    const AF_TIPS = {
      strategy: 'Choose which fishing area Auto-Fish casts in. Unlocks at Auto-Fish Level 3. With "Select area" chosen, no area is fixed and Fishy fishes in the area you currently have selected.',
      xp: 'Auto-Fish XP. You earn it from your own !fish casts on Twitch, from Fishy\u2019s auto casts and from collecting Fishy treats. Filling the bar levels Fishy up.',
      efficiency: 'How fast Fishy casts during a session. It rises with each Auto-Fish level and each Prestige.',
      tankCapacity: 'How many Fishy treats the tank can hold at once, and the biggest reward a single treat can give. It grows with your Auto-Fish level and each Prestige. While the tank is full, no new treat appears until you collect some.',
      autoCasts: 'Casts Fishy made for you during Auto-Fish sessions. Press Start Auto-Fish and leave the session running to raise this.',
      manualCastsStat: 'Casts you made yourself with the !fish command on Twitch. Only manual casts can fill the tank, and they count towards Prestige.',
      tankTreasury: 'Fishy treats you have collected. A treat appears in Fishy\u2019s tank when you fish with the !fish command in Twitch chat (a chance on each successful cast, only while the tank has room). Press COLLECT before it expires to get its Treasury reward. Auto-Fish casts never fill the tank.',
      prestige: 'Your Auto-Fish Prestige tier (max 5). Meet every requirement below, then press the Prestige button. Prestiging resets only your Auto-Fish level and XP.',
      // Prestige requirement cards, keyed by the server check key
      level: 'Your Auto-Fish level. Earn XP with !fish casts on Twitch, Auto-Fish sessions and by collecting Fishy treats. Prestiging resets your level, so you rebuild it each tier.',
      areaProgress: 'The combined level of all your fishing areas. Buy new fishing areas and upgrade them in the shop to raise it.',
      manualCasts: 'Casts you made yourself with !fish on Twitch over your whole account. Auto-Fish casts do not count \u2013 keep fishing manually.',
      treasuryEarned: 'Treasury you have caught while fishing. Every Treasury catch counts, so keep fishing to raise it.',
      eventsCompleted: 'Fishy treats you have collected. A treat appears in Fishy\u2019s tank while you fish with !fish on Twitch \u2013 press COLLECT on it before it expires.'
    };
    function renderAutoFishTargetPicker(data, hasTargetableArea = true) {
      const current = data.targetArea || '';
      const selectedArea = current && data.areas?.[current] ? `${data.areas[current].name} \u00b7 Lv.${data.areas[current].level}` : '';
      const selectedLabel = selectedArea || 'Select area';
      const opts = [`<button type="button" class="autofish-target-picker__option is-disabled" tabindex="-1">Select auto-fish perk</button>`,
        `<button type="button" class="autofish-target-picker__option ${!current ? 'is-selected' : ''}" onclick="selectAutoFishTarget('__none__')">Select area</button>`,
        ...Object.entries(data.areas || {}).filter(([,a]) => a.level > 0).map(([id,a]) => `<button type="button" class="autofish-target-picker__option ${current === id ? 'is-selected' : ''}" onclick="selectAutoFishTarget('${encodeURIComponent(id)}')">${escText(a.name)} \u00b7 Lv.${a.level}</button>` )
      ].join('');
      return `<div class="autofish-target-picker" id="autoFishTargetPicker">
        <span class="autofish-target-picker__label">Auto-Fish strategy${afTip(AF_TIPS.strategy, true)}</span>
        <button type="button" class="autofish-target-picker__button ${current ? '' : 'is-placeholder'}" onclick="toggleAutoFishTargetPicker()" aria-haspopup="listbox" aria-expanded="false"><span>${escText(selectedLabel)}</span><span class="autofish-target-picker__chevron">\u2304</span></button>
        <div class="autofish-target-picker__menu" role="listbox">${opts}${hasTargetableArea ? '' : '<div class="autofish-target-picker__option is-disabled" style="text-transform:none;letter-spacing:0;line-height:1.4">No areas to pick yet \u2013 unlock a fishing area in the shop first.</div>'}</div>
      </div>`;
    }
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.autofish-target-picker')) closeAutoFishTargetPickers();
    });

    let __fishyRandomMotionTimer = null;
    let __fishyMotionState = null;
    function startFishyRandomMotion() {
      if (__fishyRandomMotionTimer) { clearTimeout(__fishyRandomMotionTimer); __fishyRandomMotionTimer = null; }
      const pool = document.querySelector('.autofish-license-fishy.is-swimming');
      const swimmer = pool?.querySelector('.fishy-buddy__swim');
      if (!pool || !swimmer) return;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      const applyState = (state, immediate = false) => {
        if (!state) return;
        swimmer.style.transition = immediate ? 'none' : '';
        swimmer.style.left = `${state.x}%`;
        swimmer.style.top = `${state.y}%`;
        swimmer.style.transform = `rotate(${state.angle}deg) scale(${state.scale})`;
        if (immediate) requestAnimationFrame(() => { swimmer.style.transition = ''; });
      };
      if (__fishyMotionState) applyState(__fishyMotionState, true);
      const move = () => {
        const maxX = Math.max(8, Math.min(76, ((pool.clientWidth - swimmer.offsetWidth) / Math.max(1, pool.clientWidth)) * 100));
        const maxY = Math.max(8, Math.min(66, ((pool.clientHeight - swimmer.offsetHeight - 24) / Math.max(1, pool.clientHeight)) * 100));
        const x = 6 + Math.random() * Math.max(8, maxX - 6);
        const y = 7 + Math.random() * Math.max(8, maxY - 7);
        const angle = -13 + Math.random() * 26;
        const scale = .96 + Math.random() * .1;
        __fishyMotionState = { x, y, angle, scale };
        applyState(__fishyMotionState, false);
        __fishyRandomMotionTimer = setTimeout(move, (reduced ? 4200 : 1800) + Math.random() * (reduced ? 1800 : 1900));
      };
      __fishyRandomMotionTimer = setTimeout(move, reduced ? 2500 : 1100);
    }

    const AUTO_FISH_PRESTIGE_FALLBACKS = [
      { level: 5, areaProgress: 3, manualCasts: 100, treasuryEarned: 25, eventsCompleted: 2, name: 'Apprentice' },
      { level: 7, areaProgress: 6, manualCasts: 300, treasuryEarned: 75, eventsCompleted: 5, name: 'Skilled' },
      { level: 9, areaProgress: 10, manualCasts: 700, treasuryEarned: 150, eventsCompleted: 10, name: 'Expert' },
      { level: 10, areaProgress: 15, manualCasts: 1500, treasuryEarned: 300, eventsCompleted: 20, name: 'Master' },
      { level: 10, areaProgress: 20, manualCasts: 3000, treasuryEarned: 600, eventsCompleted: 35, name: 'Grandmaster' }
    ];

    function getReliablePrestigeRequirement(data) {
      const prestige = Math.max(0, Math.min(4, Number(data?.prestige || 0)));
      if (prestige >= 5) return null;
      const serverReq = data?.prestigeRequirements;
      const fallback = AUTO_FISH_PRESTIGE_FALLBACKS[prestige];
      // Treat a server object with missing/zero requirement fields as malformed and
      // fall back to the canonical progression table rather than displaying 0/0.
      if (serverReq && fallback && [
        'level', 'areaProgress', 'manualCasts', 'treasuryEarned', 'eventsCompleted'
      ].every((key) => Number(serverReq[key]) > 0)) {
        return { ...fallback, ...serverReq };
      }
      return fallback ? { ...fallback } : null;
    }

    // Server-clock aware "now": nextCastAt / expiresAt are server timestamps, so a
    // client clock that is off by even a few seconds would show a wrong (or stuck)
    // countdown. serverNow is sent with every status payload.
    window.__autoFishClockOffset = window.__autoFishClockOffset || 0;
    function autoFishNow() { return Date.now() + (window.__autoFishClockOffset || 0); }

    function renderAutoFish(data) {
      const box = document.getElementById('autoFishPanel');
      if (!box || !data) return;
      // Whichever endpoint supplied this data (/api/perks on page load or
      // /api/autofish on polls), the countdown ticker must read the same copy.
      window.__lastAutoFishData = data;
      if (Number(data.serverNow) > 0) window.__autoFishClockOffset = Number(data.serverNow) - Date.now();
      const cfg = data.config || {};
      const xpNext = Number.isFinite(Number(data.xpToNext)) ? Number(data.xpToNext) : 0;
      const xpPct = xpNext > 0 ? Math.min(100, (Number(data.xp || 0) / xpNext) * 100) : 100;
      const prestigeIndex = Math.max(0, Number(data.prestige || 0));
      const req = getReliablePrestigeRequirement(data);
      const areaOptions = Object.entries(data.areas || {}).filter(([,a]) => a.level > 0)
        .map(([id,a]) => `<option value="${escText(id)}"${data.targetArea === id ? ' selected' : ''}>${escText(a.name)} · Lv.${a.level}</option>`).join('');
      const areaTargetingUnlocked = !!data.featureUnlocks?.areaTargeting;
      const hasTargetableArea = Object.values(data.areas || {}).some((a) => a.level > 0);
      let html = '';

      if (!data.licensed) {
        const eligible = !!data.areaLevel3Eligible;
        const licenseCost = Number(cfg.licenseCost || 0);
        const areaName = data.areaLevel3Area?.name || 'a fishing area';
        const licenseMessage = eligible
          ? `You did it! ${areaName} reached Level 3. That means I can finally get my Auto-Fishing License.`
          : `Hi! I’m Fishy. Get Area 1 to Level 3 and I can become your Auto-Fish buddy.`;
        html = `
          <div class="autofish-hero autofish-license-card ${tutorialFlowActive && eligible ? 'tutorial-nav-target' : ''}" ${tutorialFlowActive && eligible ? 'data-guide-target="autofish-license" data-guide-tip="Purchase the Auto-Fishing License to finish the tutorial."' : ''}>
            <div class="autofish-license-fishy">
              ${fishyBuddy(eligible ? 'excited' : 'idle', '', false)}
              <div class="autofish-fishy-name">Fishy</div>
              <div class="autofish-fishy-role">Your Auto-Fish buddy</div>
              
            </div>
            <div class="autofish-license-copy">
              <div class="autofish-license-topline">
                <span class="autofish-license-badge ${eligible ? 'is-ready' : 'locked'}"><svg class="ic" aria-hidden="true"><use href="#i-automation"></use></svg> ${eligible ? 'License unlocked' : 'License locked'}</span>
                <span class="autofish-license-cost"><svg class="ic" aria-hidden="true"><use href="#i-coin-stack"></use></svg> ${licenseCost.toLocaleString()} Treasury</span>
              </div>
              <div class="autofish-title" style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">Unlock Fishy’s Auto-Fishing License <button class="autofish-info-btn" type="button" onclick="openAutoFishInfo()"><svg class="ic"><use href="#i-info"></use></svg>Levels &amp; perks</button></div>
              <div class="autofish-sub">${eligible ? `<b>Requirement met.</b> ${escText(areaName)} is Level ${data.areaLevel3Area?.level || 3}. You can purchase the license now.` : `Reach <b>Area 1 Level 3</b>. The server checks your real area progression whenever this panel loads, including immediately after an area purchase.`}</div>
              <div class="autofish-license-check">
                <span class="${eligible ? 'ok' : ''}"><svg class="ic" aria-hidden="true"><use href="#${eligible ? 'i-check-ring' : 'i-lock'}"></use></svg></span>
                <span>${eligible ? `Level 3 detected · ${escText(areaName)}` : 'Area 1 Level 3 required'}</span>
              </div>
              <div class="autofish-actions" style="margin-top:14px">
                <button class="shop-item-cta ${tutorialFlowActive && eligible ? 'tutorial-license-action' : ''}" ${eligible && cfg.enabled !== false ? '' : 'disabled'} onclick="buyAutoFishLicense()"><svg class="ic" aria-hidden="true"><use href="#i-automation"></use></svg> ${eligible ? 'Purchase License' : 'Reach Area Level 3'}</button>
              </div>
              <div class="autofish-requirements" style="margin-top:9px">${cfg.enabled === false ? 'Auto-Fish is currently disabled globally. Your Area Level 3 progress is still saved.' : eligible ? `Fishy is ready. Spend ${licenseCost.toLocaleString()} Treasury to unlock Auto-Fish.` : 'Once Area 1 reaches Level 3, this card will update automatically.'}</div>
            </div>
          </div>
          ${req ? `<div class="autofish-prestige-progress">
            <div class="autofish-prestige-progress__head">
              <div><b>Prestige progression · ${escText(req.name)}</b><span>Requirements stay visible even before the Auto-Fishing License is purchased.</span></div>
              <strong class="is-missing">LOCKED</strong>
            </div>
            <div class="autofish-prestige-checks">${(data.prestigeChecks || []).map((item) => `<div class="autofish-prestige-check is-missing"><span>!</span><div><b>${escText(item.label)}</b><small>${Number(item.current || 0).toLocaleString()} / ${Number(item.required || 0).toLocaleString()}</small></div>${afTip(AF_TIPS[item.key])}</div>`).join('')}</div>
          </div>` : ''}
`;
      } else {
        const remaining = data.active && data.expiresAt ? Math.max(0, Math.ceil((data.expiresAt - autoFishNow()) / 1000)) : 0;
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const autoBrokenRemaining = data.autoBrokenUntil ? Math.max(0, Math.ceil((data.autoBrokenUntil - autoFishNow()) / 1000)) : 0;
        const autoBrokenCountdown = autoBrokenRemaining > 0 ? formatAutoFishCooldown(autoBrokenRemaining) : '';
        const [fishyState, fishyMsg] = fishyMessageForAutoFish(data);
        html = `
          <div class="autofish-hero ${tutorialFlowActive ? 'tutorial-nav-target' : ''}" ${tutorialFlowActive ? 'data-guide-target="autofish-final" data-guide-tip="Your Auto-Fish license is now unlocked. Press DONE to finish the tutorial."' : ''}>
            <div class="autofish-license-fishy is-swimming" style="--fishy-t:${(Date.now() / 1000 % 3600).toFixed(2)}">
              ${fishyBuddy(fishyState, '', false)}
              ${(data.events || []).length ? (() => {
                const slot = data.events[0];
                const amount = Math.max(1, Number(slot.treasuryAmount) || 1);
                return `<div class="autofish-tank-slot" role="status">
                  <div class="autofish-tank-slot__icon" aria-hidden="true"><svg class="ic"><use href="#i-fishy-treat"></use></svg></div>
                  <span class="autofish-tank-slot__label">FISHY TREAT</span>
                  <strong class="autofish-tank-slot__amount">+${amount} Treasury</strong>
                  <button class="success-btn autofish-tank-slot__button" onclick="completeAutoFishEvent('${escText(slot.id)}')">COLLECT</button>
                </div>`;
              })() : ''}
              <div class="autofish-fishy-name">Fishy</div>
              <div class="autofish-fishy-role" id="autoFishSessionTimer">${data.active ? `${mins}m ${String(secs).padStart(2, '0')}s` : 'Ready to fish with you'}</div>
              
            </div>
            <div>
              <div class="autofish-title" style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">Level ${data.level} · ${escText(data.prestigeTitle || 'No Prestige')} <button class="autofish-info-btn" type="button" onclick="openAutoFishInfo()"><svg class="ic"><use href="#i-info"></use></svg>Levels &amp; perks</button></div>
              <div class="autofish-sub">${data.active ? `Fishy is watching the line on the server. <span id="autoFishSessionRemaining">${mins}m ${secs}s</span> remain in this session. If you leave, missed casts are settled when you return.` : 'Start a session and Fishy will watch the line for you. Manual fishing remains the fastest way to progress.'}</div>
              <div class="autofish-progress"><span style="width:${xpPct}%"></span></div>
              <div class="autofish-requirements">${Number(data.xp || 0).toLocaleString()} XP / ${xpNext ? Number(xpNext).toLocaleString() : 'MAX'}${afTip(AF_TIPS.xp, true)} · ${data.efficiency}% efficiency${afTip(AF_TIPS.efficiency, true)} · Max tank capacity: ${data.onScreenTreasuryCount || data.attentionCapacity}${afTip(AF_TIPS.tankCapacity, true)}</div>
              <div class="autofish-stats">
                <div class="autofish-stat"><span class="autofish-stat-label">Auto casts</span><span class="autofish-stat-value">${Number(data.autoCasts || 0).toLocaleString()}</span>${afTip(AF_TIPS.autoCasts)}</div>
                <div class="autofish-stat"><span class="autofish-stat-label">Manual casts</span><span class="autofish-stat-value">${Number(data.manualCasts || 0).toLocaleString()}</span>${afTip(AF_TIPS.manualCastsStat)}</div>
                <div class="autofish-stat"><span class="autofish-stat-label">Fishy treats</span><span class="autofish-stat-value">${Number(data.eventsCompleted || 0).toLocaleString()}</span>${afTip(AF_TIPS.tankTreasury)}</div>
                <div class="autofish-stat"><span class="autofish-stat-label">Prestige</span><span class="autofish-stat-value">${data.prestige}/5</span>${afTip(AF_TIPS.prestige)}</div>
              </div>
            </div>
            <div class="autofish-session-controls">
              <span class="autofish-session-controls__eyebrow">AUTO-FISH SESSION</span>
              ${areaTargetingUnlocked ? renderAutoFishTargetPicker(data, hasTargetableArea) : '<div class="autofish-requirements">Area targeting unlocks at Level 3.</div>'}
<details class="af-more"><summary>Trophy fishing · ${data.trophyMode ? 'On' : 'Off'}</summary>              <div class="autofish-trophy-toggle ${data.trophyMode ? 'is-on' : ''} ${data.featureUnlocks?.trophyFishing ? '' : 'is-locked'}" id="autoFishTrophyToggle">
                <div class="autofish-trophy-toggle__copy">
                  <span class="autofish-trophy-toggle__title">🏆 Trophy fishing</span>
                  <span class="autofish-trophy-toggle__hint">${data.featureUnlocks?.trophyFishing ? 'Uses Treasury Only Mode for Auto-Fish casts, so non-Treasury catches become Mud.' : 'Unlocks permanently when you reach Auto-Fish Level 5. Prestige 1 keeps it unlocked.'}</span>
                </div>
                <label class="perk-switch" title="Toggle Trophy Fishing"><input type="checkbox" ${data.trophyMode ? 'checked' : ''} ${data.featureUnlocks?.trophyFishing ? '' : 'disabled'} onchange="setAutoFishTrophyMode(this.checked)"><span class="perk-switch-slider"></span></label>
              </div></details>
              <div class="autofish-session-controls__row">
                <div class="autofish-session-controls__status ${data.active ? 'is-active' : ''}" id="autoFishLiveCooldown" aria-live="polite">
                  <span class="autofish-session-controls__dot"></span>
                  <div class="autofish-session-controls__status-copy">
                    <span class="autofish-session-controls__status-label">${data.autoBrokenUntil && data.autoBrokenUntil > autoFishNow() ? 'Auto-Fish broke' : data.active ? 'Next cast' : 'Session status'}</span>
                    <strong id="autoFishCooldownValue">${data.autoBrokenUntil && data.autoBrokenUntil > autoFishNow() ? formatAutoFishCooldown(data.autoBrokenUntil - autoFishNow()) : data.active && data.nextCastAt ? formatAutoFishCooldown(Math.max(0, data.nextCastAt - autoFishNow())) : 'READY'}</strong>
                  </div>
                </div>
              </div>
              <div class="autofish-session-controls__action-row ${data.featureUnlocks?.stopConditions ? 'has-stop-control' : 'start-only'}">
                ${data.active
                  ? `<button class="danger-btn autofish-session-controls__button" onclick="stopAutoFish()">Stop session</button>`
                  : `<button class="success-btn autofish-session-controls__button" ${cfg.enabled === false ? 'disabled' : ''} onclick="startAutoFish()">${cfg.enabled === false ? 'Auto-Fish disabled' : 'Start Auto-Fish'}</button>`}
                ${data.featureUnlocks?.stopConditions ? `
                  <div class="autofish-stop-control">
                    <div class="autofish-stop-control__field">
                      <label for="autoFishStopAfter">Stop after casts</label>
                      <input id="autoFishStopAfter" type="number" min="0" max="1000000" value="${Number(data.stopAfter || 0)}" placeholder="0 = unlimited" title="Stop after this many lifetime Auto-Fish casts">
                      <div class="autofish-stop-control__hint">0 = unlimited · Current: ${Number(data.stopAfter || 0) ? Number(data.stopAfter).toLocaleString() : 'unlimited'}</div>
                    </div>
                    <button class="shop-item-cta autofish-stop-control__button" onclick="setAutoFishStopAfter()">Set limit</button>
                  </div>` : ''}
              </div>
            </div>
          </div>
`;


        const nextPrestigeReq = req;
        if (nextPrestigeReq) {
          const req = nextPrestigeReq;
          const serverChecks = Array.isArray(data.prestigeChecks) ? data.prestigeChecks : [];
          const prestigeChecks = serverChecks.length
            ? serverChecks.map((item) => [item.label, Number(item.current || 0), Number(item.required || 0), item.key])
            : [
              ['Auto-Fish level', Number(data.level || 0), Number(req.level || 0), 'level'],
              ['Area progress', Number(data.areaProgress || 0), Number(req.areaProgress || 0), 'areaProgress'],
              ['Lifetime manual casts', Number(data.manualCasts || 0), Number(req.manualCasts || 0), 'manualCasts'],
              ['Treasury earned', Number(data.treasuryEarned || 0), Number(req.treasuryEarned || 0), 'treasuryEarned'],
              ['Fishy treats collected', Number(data.eventsCompleted || 0), Number(req.eventsCompleted || 0), 'eventsCompleted']
            ];
          const prestigeReady = data.prestigeReady === true || prestigeChecks.every(([, cur, need]) => cur >= need);
          const missingCount = prestigeChecks.filter(([,cur,need]) => cur < need).length;
          html += `<div class="autofish-prestige-progress ${prestigeReady ? 'is-ready' : ''}">
            <div class="autofish-prestige-progress__head">
              <div>
                <b>${prestigeReady ? '✨ Prestige ready: ' : 'Next prestige: '}${escText(req.name)}</b>
                <span>${prestigeReady ? 'Every requirement is complete. You can prestige whenever you are ready.' : 'Prestiging resets only Auto-Fish level and XP.'}</span>
                ${prestigeReady ? '<span class="autofish-prestige-progress__ready-badge">✓ ALL REQUIREMENTS MET</span>' : ''}
              </div>
              <strong class="${prestigeReady ? 'is-ready' : 'is-missing'}">${prestigeReady ? 'READY' : `${missingCount} missing`}</strong>
            </div>
            <details class="af-more"><summary>Requirements · ${prestigeChecks.filter(([, cur, need]) => cur < need).length} missing</summary><div class="autofish-prestige-checks">${prestigeChecks.map(([label, cur, need, key]) => `<div class="autofish-prestige-check ${cur >= need ? 'is-met' : 'is-missing'}"><span>${cur >= need ? '✓' : '!'}</span><div><b>${escText(label)}</b><small>${cur.toLocaleString()} / ${need.toLocaleString()}${cur < need ? ` · need ${(need-cur).toLocaleString()} more` : ' · complete'}</small></div>${afTip(AF_TIPS[key])}</div>`).join('')}</div>
          </div></details>
          <div class="autofish-actions"><button class="shop-item-cta autofish-prestige-button" ${prestigeReady ? '' : 'disabled'} onclick="prestigeAutoFish()">${prestigeReady ? `✨ Prestige to ${escText(req.name)}` : 'Complete requirements first'}</button></div>`;
        } else if (data.masteryComplete) {
          html += `<div class="autofish-prestige-progress is-ready">
            <div class="autofish-prestige-progress__head">
              <div><b>✨ Auto-Fish Mastery complete</b><span>Prestige 5 is the final tier. All Prestige requirements have been completed.</span><span class="autofish-prestige-progress__ready-badge">✓ GRANDMASTER</span></div>
              <strong class="is-ready">5/5</strong>
            </div>
            <div class="autofish-prestige-checks">
              <div class="autofish-prestige-check is-met"><span>✓</span><div><b>Prestige progression</b><small>5 / 5 complete</small></div></div>
              <div class="autofish-prestige-check is-met"><span>✓</span><div><b>Auto-Fish mastery</b><small>Grandmaster unlocked</small></div></div>
            </div>
          </div>`;
        } else {
          html += `<div class="autofish-prestige-progress">
            <div class="autofish-prestige-progress__head"><div><b>Prestige progression</b><span>Complete the requirements above to unlock the next Prestige.</span></div><strong class="is-missing">LOCKED</strong></div>
          </div>`;
        }
      }
      renderPanelHTML(box, html);
      tutorialAfterRender();
      startFishyRandomMotion();
      if (Number(data.prestige || 0) >= 1) {
        if (data.pond?.unlocked) window.__pondLastStatus = data.pond;
        else loadPondStatus();
      }
    }


    function formatAutoFishCooldown(ms) {
      const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
      const m = Math.floor(total / 60);
      const sec = total % 60;
      return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
    }

    function tickAutoFishCooldown() {
      const sessionData = window.__lastAutoFishData;
      const timerEl = document.getElementById('autoFishSessionTimer');
      if (timerEl && sessionData?.active && sessionData.expiresAt) {
        const left = Math.max(0, Math.ceil((sessionData.expiresAt - autoFishNow()) / 1000));
        const m = Math.floor(left / 60), sec = left % 60;
        timerEl.textContent = `${m}m ${String(sec).padStart(2, '0')}s`;
        const sentenceEl = document.getElementById('autoFishSessionRemaining');
        if (sentenceEl) sentenceEl.textContent = `${m}m ${sec}s`;
      }
      // Session over: the server credits the casts still owed and closes the
      // session when it is asked to settle, so ask as soon as the timer hits zero.
      if (sessionData?.active && sessionData.expiresAt && sessionData.expiresAt <= autoFishNow() && Date.now() - (window.__autoFishLastSettleAt || 0) > 4000) {
        window.__autoFishLastSettleAt = Date.now();
        loadAutoFishStatus(true);
      }
      const el = document.getElementById('autoFishCooldownValue');
      const data = window.__lastAutoFishData;
      if (!el || !data) return;
      const wrap = document.getElementById('autoFishLiveCooldown');
      const brokenRemaining = data.autoBrokenUntil ? Math.max(0, data.autoBrokenUntil - autoFishNow()) : 0;
      if (brokenRemaining > 0) {
        el.textContent = formatAutoFishCooldown(brokenRemaining);
        wrap?.classList.add('is-active');
        wrap?.classList.remove('is-ready');
        const label = wrap?.querySelector('.autofish-session-controls__status-label');
        if (label) label.textContent = 'Auto-Fish broke';
        if (timerEl) timerEl.textContent = `Auto-Fish broke · ${formatAutoFishCooldown(brokenRemaining)}`;
        return;
      }
      if (!data.active || !data.nextCastAt) {
        el.textContent = data?.config?.enabled === false ? 'OFF' : 'READY';
        wrap?.classList.remove('is-active');
        wrap?.classList.add('is-ready');
        if (wrap) {
          const label = wrap.querySelector('.autofish-session-controls__status-label');
          if (label) label.textContent = 'Session status';
        }
        return;
      }
      const remaining = Math.max(0, data.nextCastAt - autoFishNow());
      el.textContent = remaining > 0 ? formatAutoFishCooldown(remaining) : 'READY';
      const readyLabel = wrap?.querySelector('.autofish-session-controls__status-label');
      if (readyLabel && remaining <= 0) readyLabel.textContent = 'Session status';
      wrap?.classList.add('is-active');
      wrap?.classList.remove('is-ready');
      // The cast is due, but casts only happen when the server settles them.
      // Without this the timer sat on READY until the 30s heartbeat (or forever
      // after a refresh, when no heartbeat had been started).
      if (remaining <= 0 && Date.now() - (window.__autoFishLastSettleAt || 0) > 4000) {
        window.__autoFishLastSettleAt = Date.now();
        loadAutoFishStatus(true);
      }
    }

    if (!window.__autoFishCooldownTicker) {
      window.__autoFishCooldownTicker = setInterval(tickAutoFishCooldown, 1000);
    }

    let autoFishStatusInFlight = false;
    async function loadAutoFishStatus(silent = true, preserveViewport = null) {
      const viewport = preserveViewport || capturePondPageViewport();
      if (autoFishStatusInFlight) {
        // Wait for the running load so callers (e.g. the tutorial) see fresh data.
        for (let i = 0; i < 40 && autoFishStatusInFlight; i++) await new Promise((r) => setTimeout(r, 100));
        return;
      }
      autoFishStatusInFlight = true;
      window.__autoFishLastSettleAt = Date.now();
      try {
        const data = await autoFishRequest();
        window.__lastAutoFishData = data;
        renderAutoFish(data);
        if (tutorialFlowActive && data?.licensed) {
          showTutorialFinalStep();
        } else if (tutorialFlowActive && data && !data.licensed && data.areaLevel3Eligible && !tutorialHintEl
          && document.getElementById('hubPanel-autofish')?.classList.contains('active')) {
          // Panel just rendered with the license target: make sure the step is visible.
          showAutoFishLicenseHint();
        }
        // Auto-Fish status owns the whole panel that contains the pond. Re-rendering
        // that panel must never move the player's document position. Keep the exact
        // viewport and restore the active pond control without browser auto-scroll.
        restorePondPageViewport(viewport);
        if (!silent && data) toast('Auto-Fish status refreshed.', 'success', { label: 'Auto-Fish' });
        if (autoFishRefreshTimer) clearTimeout(autoFishRefreshTimer);
        // This is a lightweight status heartbeat. It never schedules a client-side cast;
        // the server settles any casts that became due since the previous request.
        // While the server still owes casts (long backlog / just-ended session) poll
        // again right away so the fish land without waiting for the next heartbeat.
        if (data?.settlement?.pending) autoFishRefreshTimer = setTimeout(() => loadAutoFishStatus(true), 2500);
        else if (data?.active || data?.event) autoFishRefreshTimer = setTimeout(() => loadAutoFishStatus(true), 30000);
      } catch (err) {
        const box = document.getElementById('autoFishPanel');
        if (box) box.innerHTML = `<div class="state-message">${escText(err.message || 'Could not load Auto-Fish.')}</div>`;
      } finally {
        autoFishStatusInFlight = false;
      }
    }

    async function buyAutoFishLicense() {
      await runPurchase('autofish-license', async () => {
        try {
          const data = await autoFishRequest({ action: 'buyLicense' });
          toast(data.message || 'Auto-Fishing License purchased.', 'success', { label: 'Auto-Fish unlocked' });
          refreshInBackground(() => loadAutoFishStatus(false), () => loadPerksStatus());
          if (tutorialFlowActive) showTutorialFinalStep();
        } catch (err) { toast(err.message, 'error', { label: 'License purchase failed' }); }
      });
    }

    async function startAutoFish() {
      try {
        await autoFishRequest({ action: 'start', targetArea: null });
        toast('Auto-Fish session started. The server handles the casts.', 'success', { label: 'Auto-Fish started' });
        await loadAutoFishStatus();
      } catch (err) { toast(err.message, 'error', { label: 'Auto-Fish not started' }); }
    }

    async function stopAutoFish() {
      try {
        const data = await autoFishRequest({ action: 'stop' });
        if (data?.pending) {
          toast('Fishy is still bringing in the last catches. Press stop again in a moment.', 'info', { label: 'Auto-Fish' });
          await loadAutoFishStatus();
          return;
        }
        const items = Object.entries(data?.mail?.meta?.items || {}).filter(([, n]) => Number(n) > 0);
        const preview = items.slice(0, 3).map(([item, count]) => `${item} ×${count}`).join(' · ');
        toast(preview ? `Fishy brought home: ${preview}${items.length > 3 ? ' · +more' : ''}. Full report is in Mail.` : 'Fishy finished the session. Your report is in Mail.', 'success', { label: 'Auto-Fish report' });
        await Promise.all([loadAutoFishStatus(), loadTradingMail(true)]);
      } catch (err) { toast(err.message, 'error', { label: 'Auto-Fish' }); }
    }

    async function setAutoFishTarget(targetArea) {
      try { await autoFishRequest({ action: 'target', targetArea }); await loadAutoFishStatus(); }
      catch (err) { toast(err.message, 'error', { label: 'Area target' }); }
    }

    async function setAutoFishTrophyMode(enabled) {
      try {
        await autoFishRequest({ action: 'trophyMode', enabled: !!enabled });
        toast(enabled ? 'Trophy fishing enabled. Auto-Fish will use Treasury Only Mode.' : 'Trophy fishing disabled. Auto-Fish will use normal fishing rolls.', 'success', { label: 'Trophy fishing' });
        await loadAutoFishStatus();
      } catch (err) {
        toast(err.message, 'error', { label: 'Trophy fishing' });
        await loadAutoFishStatus();
      }
    }

    async function setAutoFishStopAfter() {
      try {
        const value = Math.max(0, parseInt(document.getElementById('autoFishStopAfter')?.value, 10) || 0);
        await autoFishRequest({ action: 'stopAfter', value });
        toast(value ? `Auto-Fish will stop after ${value.toLocaleString()} casts.` : 'Auto-Fish stop limit cleared.', 'success', { label: 'Stop condition' });
        await loadAutoFishStatus();
      } catch (err) { toast(err.message, 'error', { label: 'Stop condition' }); }
    }

    async function completeAutoFishEvent(eventId) {
      try {
        const data = await autoFishRequest({ action: 'event', eventId });
        const reward = Math.max(0, Number(data.treasuryAmount) || 0);
        toast(`Fishy gave you ${reward} Treasury${reward === 1 ? '' : ' items'}! +${data.xp || 0} Auto-Fish XP`, 'success', { label: 'Treasury collected' });
        await loadAutoFishStatus();
      } catch (err) { toast(err.message, 'error', { label: 'Event expired' }); }
    }

    async function prestigeAutoFish() {
      if (!confirm('Prestige resets only Auto-Fish level and XP. Your areas, Fishdex, cosmetics, and existing prestige are retained. Continue?')) return;
      try {
        const data = await autoFishRequest({ action: 'prestige' });
        toast(`Prestiged to ${data.title}. Auto-Fish level reset to 1.`, 'success', { label: 'Prestige complete' });
        await loadAutoFishStatus();
      } catch (err) {
        const missing = Array.isArray(err.details?.missing) ? err.details.missing : [];
        if (missing.length) {
          const lines = missing.map((m) => `${m.label}: ${m.current}/${m.required} (need ${m.shortfall} more)`).join(' · ');
          toast(lines, 'error', { label: 'Prestige requirements' });
        } else {
          toast(err.message, 'error', { label: 'Prestige unavailable' });
        }
      }
    }

    function renderPondPerkToggleMenu(pond) {
      const list = document.getElementById('pondPerkToggleList');
      const menu = list?.closest('.pond-perk-toggle-menu');
      if (!list || !menu) return;
      const info = pond?.treasuryPerks || {};
      const toggles = pond?.treasuryPerkToggles || {};
      // Show these cards only when the Pond is unlocked and at least one perk is owned.
      if (!pond?.unlocked) {
        menu.style.display = 'none';
        list.innerHTML = '';
        return;
      }
      const definitions = {
        speciesHunter: { name: 'Species Hunter', max: 5, icon: 'i-search', desc: 'Adds luck for each unique Fishdex fish, up to this perk’s level cap.' },
        collectorInstinct: { name: "Collector’s Instinct", max: 3, icon: 'i-fish', desc: 'Increases the weight of fish you have never caught before.' },
        baitSaver: { name: 'Bait Saver', max: 5, icon: 'i-fish', desc: 'Gives premium Pond bait a chance not to be consumed.' },
        stillWaters: { name: 'Still Waters', max: 3, icon: 'i-drop', desc: 'Shifts some weight away from Common fish toward higher rarities.' },
        deepCurrent: { name: 'Deep Current', max: 3, icon: 'i-drop', desc: 'Lengthens Pond cycles and improves Rare-and-higher weighting.' },
        biggerHaul: { name: 'Bigger Haul', max: 3, icon: 'i-bag', desc: 'Adds extra fish when you collect a completed Pond haul.' },
        fishyFortune: { name: 'Fishy Fortune', max: 3, icon: 'i-coin-stack', desc: 'Converts Common through Rare Pond fish into more FishyTokens.' },
        treasuryWaters: { name: 'Treasury Waters', max: 1, icon: 'i-drop', desc: 'At Pond Level 5, uses Treasury Only odds; misses are Mud.' }
      };
      const order = Object.keys(definitions);
      const owned = order.filter(id => Number(info[id]) > 0);
      if (!owned.length) {
        menu.style.display = 'none';
        list.innerHTML = '';
        return;
      }
      menu.style.display = '';
      renderPanelHTML(list, owned.map(id => {
        const definition = definitions[id];
        const level = Math.max(0, Number(info[id]) || 0);
        const on = toggles[id] !== false;
        return `<div class="shop-item-card pond-perk-toggle-item ${on ? '' : 'is-disabled'}">
          <div class="shop-item-icon"><svg class="ic" aria-hidden="true" focusable="false"><use href="#${definition.icon}"></use></svg></div>
          <div class="shop-item-name">${escText(definition.name)}</div>
          <div class="shop-item-desc">${escText(definition.desc)}</div>
          <div class="shop-item-status ${on ? '' : 'dim'}">Level ${level}/${definition.max} · ${on ? 'Enabled' : 'Disabled'}</div>
          <div class="shop-item-toggle-row">
            <span class="shop-item-toggle-label">Use this perk</span>
            <label class="perk-switch"><input type="checkbox" aria-label="${escText(definition.name)} toggle" ${on ? 'checked' : ''} onchange="togglePerk('pond:${id}', this.checked)"><span class="perk-switch-slider"></span></label>
          </div>
        </div>`;
      }).join(''));
    }

    function renderPerksStatus(data) {
      renderChannelPerk(data?.channelPerk);
      renderFishingStatus(data.fishing);
      renderAutoFish(data.autoFish);
      renderPondPerkToggleMenu(data.pond);
      // /api/perks only reads state. On a fresh page load nothing else would
      // settle due casts or start the status heartbeat, so do it here.
      if (data.autoFish?.active || data.autoFish?.event) loadAutoFishStatus(true);
      loadFishingAreas(true);

      // --- 2x Luck (10 min) ---
      const temp = data.tempLuck || {};
      setPerkLocked('perkCardTemp', !temp.owned);
      const tempStatusEl = document.getElementById('perkTempStatus');
      if (perkTempCountdownTimer) { clearInterval(perkTempCountdownTimer); perkTempCountdownTimer = null; }
      if (temp.owned) {
        setupPerkToggleRow('perkTempToggleRow', 'perkTempToggle', temp.toggleOn);
        if (temp.remainingSeconds > 0) {
          let remaining = Math.max(0, Number(temp.remainingSeconds) || 0);
          perkTempDisplayedRemaining = remaining;
          if (!temp.toggleOn) {
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            tempStatusEl.className = 'shop-item-status dim';
            tempStatusEl.textContent = `⏸ Paused · ${mins}m ${secs}s remaining on your 2x Luck`;
          } else {
            const tick = () => {
              const mins = Math.floor(remaining / 60);
              const secs = remaining % 60;
              tempStatusEl.className = 'shop-item-status';
              tempStatusEl.textContent = `⏱ You have ${mins}m ${secs}s left from your 2x Luck`;
              perkTempDisplayedRemaining = remaining;
              if (remaining <= 0) {
                clearInterval(perkTempCountdownTimer);
                perkTempCountdownTimer = null;
                tempStatusEl.className = 'shop-item-status dim';
                tempStatusEl.textContent = 'Caught. Not active right now';
              }
              remaining--;
            };
            tick();
            perkTempCountdownTimer = setInterval(tick, 1000);
          }
        } else {
          tempStatusEl.className = 'shop-item-status dim';
          tempStatusEl.textContent = 'Caught. Not active right now';
        }
      } else {
        document.getElementById('perkTempToggleRow').style.display = 'none';
        tempStatusEl.className = 'shop-item-status dim';
        tempStatusEl.textContent = 'Not caught yet';
      }

      // --- 1.5x Luck (Permanent) ---
      const perm = data.permLuck || {};
      setPerkLocked('perkCardPerm', !perm.owned);
      const permStatusEl = document.getElementById('perkPermStatus');
      if (perm.owned) {
        setupPerkToggleRow('perkPermToggleRow', 'perkPermToggle', perm.toggleOn);
        permStatusEl.className = 'shop-item-status';
        permStatusEl.innerHTML = perm.toggleOn
          ? statusHTML('check', 'Active, 1.5x permanent luck')
          : statusHTML('pause', 'Owned, currently turned off');
      } else {
        document.getElementById('perkPermToggleRow').style.display = 'none';
        permStatusEl.className = 'shop-item-status dim';
        permStatusEl.textContent = 'Not caught yet';
      }

      // --- Shieldfish ---
      const shield = data.shield || {};
      setPerkLocked('perkCardShield', !shield.owned);
      const shieldStatusEl = document.getElementById('perkShieldStatus');
      if (shield.owned) {
        setupPerkToggleRow('perkShieldToggleRow', 'perkShieldToggle', shield.toggleOn);
        shieldStatusEl.className = 'shop-item-status';
        shieldStatusEl.innerHTML = shield.toggleOn === false
          ? statusHTML('pause', `${shield.count} shield${shield.count === 1 ? '' : 's'} stored · protection off`)
          : statusHTML('shield', `${shield.count} shield${shield.count === 1 ? '' : 's'} available`);
      } else {
        document.getElementById('perkShieldToggleRow').style.display = 'none';
        shieldStatusEl.className = 'shop-item-status dim';
        shieldStatusEl.textContent = 'Not caught yet';
      }

      // --- Vipfish ---
      const vip = data.vip || {};
      setPerkLocked('perkCardVip', !vip.owned);
      const vipStatusEl = document.getElementById('perkVipStatus');
      if (vip.owned) {
        setupPerkToggleRow('perkVipToggleRow', 'perkVipToggle', vip.toggleOn);
        vipStatusEl.className = 'shop-item-status';
        vipStatusEl.innerHTML = vip.active
          ? (vip.toggleOn ? statusHTML('check', 'Active, VIP-level luck')
                          : statusHTML('pause', 'Granted, currently turned off'))
          : statusHTML('crown', 'Not granted yet');
      } else {
        document.getElementById('perkVipToggleRow').style.display = 'none';
        vipStatusEl.className = 'shop-item-status dim';
        vipStatusEl.textContent = "Not caught yet, and you're not a sub/VIP";
      }

      // --- Global Event Luck ---
      const event = data.event || {};
      const eventDescEl = document.getElementById('perkEventDesc');
      const eventStatusEl = document.getElementById('perkEventStatus');
      if (perkEventCountdownTimer) { clearInterval(perkEventCountdownTimer); perkEventCountdownTimer = null; }
      setPerkLocked('perkCardEvent', !event.active);
      if (event.active) {
        eventDescEl.textContent = `${escapeHtmlFishdex(event.name || 'Global Luck Event')} is live for everyone: a server-wide ${event.multiplier}x multiplier.`;
        setupPerkToggleRow('perkEventToggleRow', 'perkEventToggle', event.toggleOn);
        if (event.remainingSeconds && event.remainingSeconds > 0) {
          let remaining = event.remainingSeconds;
          const tick = () => {
            const label = formatCountdown(remaining * 1000);
            eventStatusEl.className = 'shop-item-status';
            eventStatusEl.innerHTML = statusHTML('bolt', `${event.multiplier}x active, ends in ${label}`);
            if (remaining <= 0) {
              clearInterval(perkEventCountdownTimer);
              perkEventCountdownTimer = null;
            }
            remaining--;
          };
          tick();
          perkEventCountdownTimer = setInterval(tick, 1000);
        } else {
          eventStatusEl.className = 'shop-item-status';
          eventStatusEl.innerHTML = statusHTML('bolt', `${event.multiplier}x active, no time limit`);
        }
      } else {
        document.getElementById('perkEventToggleRow').style.display = 'none';
        eventDescEl.textContent = 'No event currently running.';
        eventStatusEl.className = 'shop-item-status dim';
        eventStatusEl.textContent = 'No event active';
      }
    updateUserLuckDisplay(data);
  } // end of renderPerksStatus

    // Builds the profile boost summary from the player boost data.
    // Total fishing luck excludes Treasury Luck (that only affects treasury
    // drops). Every boost is listed, with inactive ones greyed out.
    let lastPerksForBoosts = null;
    function refreshProfileBoosts() { if (lastPerksForBoosts) updateUserLuckDisplay(lastPerksForBoosts); }
    function updateUserLuckDisplay(data) {
      const panel = document.getElementById('profileBoostsPanel');
      if (!panel || !data) return;
      lastPerksForBoosts = data;
      const shop = data.shop || {};
      const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      const fmt = (n) => `${Number(n.toFixed(2))}x`;
      const rows = [];
      let total = 1.0;
      const luckRow = (name, mult, active, note) => {
        if (active) total *= mult;
        rows.push({ name, val: fmt(mult), active, note });
      };
      const additiveLuckRow = (name, bonus, active, note) => {
        if (active) total += Number(bonus) || 0;
        rows.push({ name, val: `+${Number(bonus || 0).toFixed(2)}x`, active, note });
      };
      const owned = (o) => !!o?.owned;
      const stateNote = (o, on) => (!owned(o) ? 'Not owned yet' : (o.toggleOn === false ? 'Turned off' : on || ''));

      luckRow('VIP / Sub / Mod luck', 1.5, !!(data.vip?.owned && data.vip?.active && data.vip?.toggleOn), stateNote(data.vip, ''));
      luckRow('1.5x Luck (permanent)', 1.5, !!(data.permLuck?.owned && data.permLuck?.toggleOn), stateNote(data.permLuck, ''));
      const tempSecs = Math.max(0, Number(data.tempLuck?.remainingSeconds) || 0);
      luckRow('2x Luck (10 min)', 2, !!(data.tempLuck?.owned && data.tempLuck?.toggleOn && data.tempLuck?.active),
        owned(data.tempLuck) ? (data.tempLuck.toggleOn === false ? 'Turned off' : (tempSecs > 0 ? `${Math.floor(tempSecs / 60)}m ${tempSecs % 60}s left` : 'Not active right now')) : 'Not owned yet');
      luckRow('1.25x Luck (shop)', 1.25, !!(shop.luck125?.owned && shop.luck125?.toggleOn), stateNote(shop.luck125, ''));
      const ev = data.event || {};
      luckRow(ev.name || 'Global luck event', Number(ev.multiplier) > 0 ? Number(ev.multiplier) : 1, !!(ev.active && ev.multiplier && ev.toggleOn !== false),
        ev.active ? (ev.toggleOn === false ? 'Turned off' : 'Server-wide event') : 'No event running');
      const speciesHunter = data.pond?.speciesHunter || {};
      additiveLuckRow(
        'Species Hunter',
        Number(speciesHunter.bonus) || 0,
        Number(speciesHunter.level) > 0,
        Number(speciesHunter.level) > 0
          ? `Level ${Number(speciesHunter.level)}/${Number(speciesHunter.max) || 5} · ${Number(speciesHunter.fishdexCaught) || 0} Fishdex fish counted`
          : 'Not owned yet'
      );
      const fortune = data.fortune || {};
      additiveLuckRow(
        "Fisherman's Fortune",
        Number(fortune.luckAdd) || 0,
        !!fortune.active,
        !fortune.owned ? 'Not owned yet'
          : (fortune.toggleOn === false ? 'Turned off'
            : `Level ${Number(fortune.level) || 0}/${Number(fortune.maxLevel) || 10} · ×${(Number(fortune.uncaughtWeightMultiplier) || 1).toFixed(2)} weight on uncaught fish`)
      );

      const other = [];
      other.push({ name: 'Treasury Luck', val: '1.5x', active: !!(shop.treasuryLuck?.owned && shop.treasuryLuck?.toggleOn), note: stateNote(shop.treasuryLuck, 'Treasury drops only') });
      const rb = shop.rarityBoost || {};
      const rbSecs = Math.max(0, Number(rb.remainingSeconds) || 0);
      other.push({ name: `2x Rarity Luck${rb.rarity ? ` (${String(rb.rarity).toUpperCase()})` : ''}`, val: '2x', active: !!rb.active, note: rb.owned ? (rb.toggleOn === false ? 'Turned off' : (rbSecs > 0 ? `${Math.floor(rbSecs / 60)}m ${rbSecs % 60}s left` : 'Not active')) : 'Not owned yet' });
      other.push({ name: 'Treasury Only mode', val: '12x', active: !!(shop.treasuryOnly?.owned && shop.treasuryOnly?.toggleOn), note: stateNote(shop.treasuryOnly, 'Treasury odds, other casts are Mud') });
      other.push({ name: 'Cooldown reduction', val: '-15%', active: !!(shop.cooldown?.owned && shop.cooldown?.toggleOn), note: stateNote(shop.cooldown, 'Shorter !fish cooldown') });
      if (data.shield?.owned) other.push({ name: 'Shieldfish', val: `${Number(data.shield.count) || 0}x`, active: data.shield.toggleOn !== false, note: data.shield.toggleOn === false ? 'Protection disabled' : 'Blocks your next timeout' });

      const rowHtml = (r) => `<div class="profile-boosts-row${r.active ? '' : ' is-off'}"><span class="pb-name">${esc(r.name)}${r.note ? `<span class="pb-note">${esc(r.note)}</span>` : ''}</span><span class="pb-val">${esc(r.val)}</span></div>`;
      // Gear weighting: rod x bait, same formula the !fish roll uses
      // ((1 + rod bonus) x bait multiplier). It only touches non-Treasury
      // catches. Bait is spent by !fish casts only and counts once it is in stock.
      let gearHtml = '';
      try {
        const prog = (typeof progressionData !== 'undefined' && progressionData?.progression) ? progressionData.progression : null;
        if (prog) {
          const rodBonus = Math.max(0, Number(prog.rod?.bonus) || 0);
          const baitDef = prog.selectedBait || {};
          const baitIsWorm = !baitDef.id || baitDef.id === 'worm';
          const baitLeft = Number(prog.bait?.[baitDef.id]) || 0;
          const baitActive = !baitIsWorm && baitLeft >= 1;
          const baitMult = baitActive ? Math.max(1, Number(baitDef.multiplier) || 1) : 1;
          const weight = (1 + rodBonus) * baitMult;
          const pct = (m) => `+${Math.round((m - 1) * 100)}%`;
          const gearRows = [
            { name: prog.rod?.name || 'Old Rod', val: pct(1 + rodBonus), active: rodBonus > 0, note: rodBonus > 0 ? 'Equipped rod' : 'Starter rod, no bonus' },
            { name: baitDef.name || 'Worm Bait', val: pct(baitMult), active: baitActive, note: baitIsWorm ? 'Free bait, no bonus' : (baitLeft >= 1 ? `${baitLeft} left, used on !fish casts` : 'Out of bait') }
          ];
          gearHtml =
            `<p class="profile-boosts-head" style="margin-top:12px">Gear weighting (rod also applies to Treasury)</p>${gearRows.map(rowHtml).join('')}` +
            `<div class="profile-boosts-total"><span>Total weight</span><span class="pb-val">${esc(fmt(weight))}</span></div>` +
            `<div class="profile-boosts-row"><span class="pb-name">Luck x weight<span class="pb-note">Combined odds multiplier</span></span><span class="pb-val">${esc(fmt(total * weight))}</span></div>`;
        }
      } catch (e) { gearHtml = ''; }
      // Treasury odds: same formula as the !fish roll. Treasury Luck and
      // Treasury Only multiply, Auto-Fish prestige adds 0.5x per tier, and the
      // equipped rod's weight (1 + rod bonus) multiplies the result.
      let treasuryHtml = '';
      try {
        const tlOn = !!(shop.treasuryLuck?.owned && shop.treasuryLuck?.toggleOn);
        const toOn = !!(shop.treasuryOnly?.owned && shop.treasuryOnly?.toggleOn);
        const prestigeTier = Math.max(0, Math.min(5, parseInt(data.autoFish?.prestige, 10) || 0));
        const treasuryLuck = (tlOn ? 1.5 : 1) * (toOn ? 12 : 1) + prestigeTier * 0.5;
        const progT = (typeof progressionData !== 'undefined' && progressionData?.progression) ? progressionData.progression : null;
        const rodBonusT = Math.max(0, Number(progT?.rod?.bonus) || 0);
        const treasuryWeight = 1 + rodBonusT;
        treasuryHtml =
          `<p class="profile-boosts-head" style="margin-top:12px">Treasury odds</p>` +
          rowHtml({ name: 'Treasury luck', val: fmt(treasuryLuck), active: treasuryLuck > 1, note: prestigeTier > 0 ? `Includes +${Number((prestigeTier * 0.5).toFixed(2))}x from Auto-Fish prestige` : 'Treasury Luck, Treasury Only and prestige' }) +
          rowHtml({ name: 'Treasury weight', val: fmt(treasuryWeight), active: rodBonusT > 0, note: rodBonusT > 0 ? `${progT?.rod?.name || 'Equipped rod'} weight` : 'Starter rod, no bonus' }) +
          `<div class="profile-boosts-total"><span>Treasury luck x weight</span><span class="pb-val">${esc(fmt(treasuryLuck * treasuryWeight))}</span></div>`;
      } catch (e) { treasuryHtml = ''; }
      panel.innerHTML =
        `<p class="profile-boosts-head">Fishing luck</p>${rows.map(rowHtml).join('')}` +
        `<div class="profile-boosts-total"><span>Total luck</span><span class="pb-val">${esc(fmt(total))}</span></div>` +
        gearHtml +
        treasuryHtml +
        `<p class="profile-boosts-head" style="margin-top:12px">Other boosts</p>${other.map(rowHtml).join('')}`;
    }
    (function wireProfileBoosts() {
      const wrap = document.getElementById('profileBoosts');
      const btn = document.getElementById('profileBoostsBtn');
      if (!wrap || !btn) return;
      // Tap support for touch screens; hover/focus work through CSS.
      btn.addEventListener('click', (e) => { e.stopPropagation(); const open = wrap.classList.toggle('open'); btn.setAttribute('aria-expanded', String(open)); });
      document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) { wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } });
    })();

    /* ---------- Player Trading ----------------------------------------------
       Both inventories are loaded server-side for the logged-in Twitch user.
       Requests are persisted by /api/trades and only an accepted request moves
       inventory. */
    let tradingSenderUser = '';
    let tradingReceiverUser = '';
    let tradingSenderItems = [];
    let tradingReceiverItems = [];
    let tradingSelected = new Map();
    let tradingRequested = new Map();
    let tradingOfferState = 'select';
    let tradingMailTimer = null;
    let tradingMailMessages = [];
    let tradingMailFilter = 'all';
    let tradingMailPage = 1;
    let tradingMailStatus = 'all';

    function tradingSetStatus(message, type = '') {
      const el = document.getElementById('tradingStatus');
      if (!el) return;
      el.className = `trading-status${type ? ` ${type}` : ''}`;
      el.textContent = message || '';
    }

    function tradingItemDetails(item) {
      const raw = item?.raw || item || '';
      return getFishRarityDetails(raw);
    }

    function tradingSelectedCount() {
      let total = 0;
      tradingSelected.forEach((qty) => { total += Number(qty) || 0; });
      tradingRequested.forEach((qty) => { total += Number(qty) || 0; });
      return total;
    }

    function tradingMapFor(side) {
      return side === 'receive' ? tradingRequested : tradingSelected;
    }

    function tradingItemsFor(side) {
      return side === 'receive' ? tradingReceiverItems : tradingSenderItems;
    }

    function tradingSelectedFor(side, raw) {
      return Number(tradingMapFor(side).get(raw) || 0);
    }

    // Must match MAX_ITEMS_PER_SIDE in lib/game-routes/trades.js: the server
    // rejects a side with more items than this, so the builder never lets the
    // player pick more than that in the first place.
    const TRADING_MAX_PER_SIDE = 100;

    // Returns the quantity that is selected after the change (it can be lower
    // than requested when the owned count or the per-side limit is hit).
    function setTradingItemQuantity(side, raw, quantity) {
      const item = tradingItemsFor(side).find((entry) => entry.raw === raw);
      if (!item) return 0;
      const map = tradingMapFor(side);
      let others = 0;
      map.forEach((qty, key) => { if (key !== raw) others += Number(qty) || 0; });
      const room = Math.max(0, TRADING_MAX_PER_SIDE - others);
      const wanted = Math.max(0, Math.min(Number(item.count) || 0, Number(quantity) || 0));
      const next = Math.min(wanted, room);
      if (wanted > room) tradingSetStatus(`A trade can include at most ${TRADING_MAX_PER_SIDE} items per side.`, 'error');
      if (next) map.set(raw, next);
      else map.delete(raw);
      renderTradingInventory(side === 'receive' ? 'partner' : 'self');
      renderTradingOffer();
      renderTradingSummary();
      return next;
    }

    function toggleTradingItem(side, raw) {
      const item = tradingItemsFor(side).find((entry) => entry.raw === raw);
      if (!item) return;
      const current = tradingSelectedFor(side, raw);
      const applied = setTradingItemQuantity(side, raw, current ? 0 : 1);
      if (!current && !applied) return; // per-side limit reached; the status already says so
      tradingSetStatus(
        current
          ? `Removed ${item.name} from ${side === 'receive' ? 'your requested items' : 'your offer'}.`
          : `Added ${item.name} x1 to ${side === 'receive' ? 'your requested items' : 'your offer'}.`,
        'ok'
      );
    }

    function tradingStartDrag(event, side, raw) {
      if (!event?.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', JSON.stringify({ side, raw }));
      event.currentTarget.classList.add('dragging');
    }

    function tradingDragEnd(event) {
      event?.currentTarget?.classList.remove('dragging');
      document.querySelectorAll('.trading-dropzone').forEach((zone) => zone.classList.remove('is-over'));
    }

    function allowTradingDrop(event) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      event.currentTarget.classList.add('is-over');
    }

    function dropTradingItem(event, targetSide) {
      event.preventDefault();
      event.currentTarget.classList.remove('is-over');
      let payload = null;
      try { payload = JSON.parse(event.dataTransfer.getData('text/plain') || '{}'); } catch (_) { console.warn('[scripts/index-app.js:5876] ignored error:', _?.message || _); }
      if (!payload?.raw) return;
      const sourceSide = payload.side === 'receive' ? 'receive' : 'give';
      // Only move an item between a player's inventory and the matching offer
      // side. You cannot drag your fish into the requested-items side.
      if (sourceSide !== targetSide) {
        tradingSetStatus('That item belongs on the matching offer side.', 'error');
        return;
      }
      const applied = setTradingItemQuantity(targetSide, payload.raw, Math.max(1, tradingSelectedFor(targetSide, payload.raw)));
      if (!applied) return; // per-side limit reached; the status already says so
      tradingSetStatus(`Added ${tradingItemsFor(targetSide).find((item) => item.raw === payload.raw)?.name || 'item'} to the trade.`, 'ok');
    }

    function renderTradingInventory(which) {
      const side = which === 'partner' ? 'receive' : 'give';
      const items = tradingItemsFor(side);
      const grid = document.getElementById(which === 'partner' ? 'tradingInventoryGridPartner' : 'tradingInventoryGridSelf');
      if (!grid) return;
      const query = (document.getElementById(which === 'partner' ? 'tradingSearchPartner' : 'tradingSearchSelf')?.value || '').trim().toLowerCase();
      const tier = document.getElementById(which === 'partner' ? 'tradingTierFilterPartner' : 'tradingTierFilterSelf')?.value || 'all';
      const sort = document.getElementById(which === 'partner' ? 'tradingSortPartner' : 'tradingSortSelf')?.value || 'rarity';
      const rank = { secret: 8, godly: 7, legendary: 6, treasury: 4, epic: 5, rare: 3, uncommon: 2, common: 1 };
      const filtered = items.filter((item) => {
        const details = tradingItemDetails(item);
        const matchesSearch = !query || `${item.name} ${item.raw}`.toLowerCase().includes(query);
        const matchesTier = tier === 'all' || String(item.tier || '').toLowerCase() === tier || String(details.label || '').toLowerCase() === tier;
        return matchesSearch && matchesTier;
      });
      filtered.sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'quantity') return (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name);
        return (rank[b.tier] || 0) - (rank[a.tier] || 0) || a.name.localeCompare(b.name);
      });

      const meta = document.getElementById(which === 'partner' ? 'tradingPartnerInventoryMeta' : 'tradingInventoryMeta');
      if (meta) meta.textContent = `${items.length} item type${items.length === 1 ? '' : 's'} loaded`;
      if (!filtered.length) {
        grid.innerHTML = `<div class="trading-empty">No inventory items match the current filters.</div>`;
        return;
      }

      grid.innerHTML = filtered.map((item) => {
        const raw = item.raw;
        const details = tradingItemDetails(item);
        const selected = tradingSelectedFor(side, raw);
        const safeRaw = escText(raw);
        return `<button type="button" class="trading-inventory-card ${selected ? 'selected' : ''} ${selected ? 'is-offered' : ''}"
          onclick='tradingCardClick(${JSON.stringify(side)}, ${JSON.stringify(raw)})'
          draggable="true"
          ondragstart='tradingStartDrag(event, ${JSON.stringify(side)}, ${JSON.stringify(raw)})'
          ondragend="tradingDragEnd(event)">
          <div class="trading-inventory-card-top">
            <div class="trading-item-icon" style="color:${details.accent};">${icon(details.icon)}</div>
            <div style="min-width:0;"><div class="trading-inventory-card-name">${escText(item.name)}</div><div class="trading-item-tier">${escText(details.label)}</div></div>
          </div>
          <div class="trading-inventory-card-meta"><span>Owned x${item.count}</span><span>${selected ? `Selected x${selected}` : 'Click to add'}</span></div>
        </button>`;
      }).join('');
    }

    function tradingCardClick(side, raw) {
      toggleTradingItem(side, raw);
    }

    function renderTradingOffer() {
      const render = (zoneId, metaId, map, sourceItems, emptyText) => {
        const zone = document.getElementById(zoneId);
        const meta = document.getElementById(metaId);
        if (!zone) return;
        const entries = [...map.entries()];
        if (!entries.length) {
          zone.innerHTML = `<div class="trading-empty">${emptyText}</div>`;
        } else {
          zone.innerHTML = entries.map(([raw, qty]) => {
            const item = sourceItems.find((entry) => entry.raw === raw);
            if (!item) return '';
            const details = tradingItemDetails(item);
            return `<div class="trading-item" draggable="true" ondragstart='tradingStartDrag(event, ${JSON.stringify(map === tradingRequested ? 'receive' : 'give')}, ${JSON.stringify(raw)})' ondragend="tradingDragEnd(event)">
              <div class="trading-item-icon" style="color:${details.accent};">${icon(details.icon)}</div>
              <div class="trading-item-copy"><span class="trading-item-name">${escText(item.name)}</span><span class="trading-item-tier">${escText(details.label)} · owned ${item.count}</span><div class="trading-item-qty"><button class="trading-qty-btn" type="button" onclick='event.stopPropagation(); setTradingItemQuantity(${JSON.stringify(map === tradingRequested ? 'receive' : 'give')}, ${JSON.stringify(raw)}, ${qty - 1})'>−</button><span class="trading-qty-value">${qty}</span><button class="trading-qty-btn" type="button" onclick='event.stopPropagation(); setTradingItemQuantity(${JSON.stringify(map === tradingRequested ? 'receive' : 'give')}, ${JSON.stringify(raw)}, ${qty + 1})'>+</button></div></div>
              <button class="trading-remove" type="button" title="Remove" onclick='event.stopPropagation(); setTradingItemQuantity(${JSON.stringify(map === tradingRequested ? 'receive' : 'give')}, ${JSON.stringify(raw)}, 0)'>×</button>
            </div>`;
          }).join('');
        }
        const total = [...map.values()].reduce((sum, qty) => sum + Number(qty || 0), 0);
        if (meta) meta.textContent = `${total} item${total === 1 ? '' : 's'}`;
      };
      render('tradingYourOfferDrop', 'tradingYourOfferMeta', tradingSelected, tradingSenderItems, 'Click or drag your items here to offer them.');
      render('tradingTheirOfferDrop', 'tradingTheirOfferMeta', tradingRequested, tradingReceiverItems, 'Click or drag their items here to request them.');
      const senderName = document.getElementById('tradingSenderOfferName');
      const receiverName = document.getElementById('tradingReceiverOfferName');
      if (senderName) senderName.textContent = tradingSenderUser ? `@${tradingSenderUser}` : '';
      if (receiverName) receiverName.textContent = tradingReceiverUser ? `@${tradingReceiverUser}` : '';
    }

    function renderTradingSummary() {
      const list = document.getElementById('tradingSummaryList');
      const countEl = document.getElementById('tradingSummaryCount');
      const sendBtn = document.getElementById('tradingSendBtn');
      if (!list) return;
      const total = tradingSelectedCount();
      if (countEl) countEl.textContent = `${total} selected`;
      if (sendBtn) sendBtn.disabled = !tradingReceiverUser || (!tradingSelected.size && !tradingRequested.size);

      const renderSection = (label, map, sourceItems) => {
        const rows = [...map.entries()].map(([raw, qty]) => {
          const item = sourceItems.find((entry) => entry.raw === raw);
          return item ? `<div class="trading-summary-row"><span>${escText(item.name)}</span><strong>x${qty}</strong></div>` : '';
        }).join('');
        return `<div class="trading-summary-section"><div class="trading-summary-label">${label}</div>${rows || '<div class="trading-summary-row"><span>None selected</span><strong>0</strong></div>'}</div>`;
      };
      list.innerHTML = renderSection(`You give @${tradingReceiverUser || '—'}`, tradingSelected, tradingSenderItems) + renderSection(`You request from @${tradingReceiverUser || '—'}`, tradingRequested, tradingReceiverItems);
    }

    function setTradingStep(step) {
      tradingOfferState = step;
      const steps = ['tradingStep1', 'tradingStep2', 'tradingStep3', 'tradingStep4'];
      const index = { select: 0, sent: 1, incoming: 2, accepted: 3, declined: 3 }[step] ?? 0;
      steps.forEach((id, i) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('active', i === index);
        el.classList.toggle('done', i < index || step === 'accepted' && i === 3);
      });
    }

    function syncTradingIdentity(user) {
      const login = String(user?.login || currentFishdexLogin || '').toLowerCase().replace(/^@+/, '').trim();
      if (!login) return;
      tradingSenderUser = login;
      const senderInput = document.getElementById('tradingSender');
      if (senderInput) senderInput.value = login;
      const nav = document.getElementById('tradingHubNavBtn');
      const mailNav = document.getElementById('mailHubNavBtn');
      if (nav) nav.style.display = 'flex';
      if (mailNav) mailNav.style.display = 'flex';
    }

    async function loadTradingPlayers() {
      syncTradingIdentity({ login: currentFishdexLogin });
      const receiver = (document.getElementById('tradingReceiver')?.value || '').trim().replace(/^@+/, '').toLowerCase();
      if (!tradingSenderUser) {
        tradingSetStatus('Log in with Twitch before trading.', 'error');
        return;
      }
      if (!receiver) {
        tradingSetStatus('Enter a Twitch username to trade with.', 'error');
        return;
      }
      if (receiver === tradingSenderUser) {
        tradingSetStatus('Choose another player.', 'error');
        return;
      }
      const button = document.querySelector('.trading-find-btn');
      if (button) button.disabled = true;
      tradingSetStatus('Reading both inventories…');
      try {
        const res = await fetch(`/api/trades?action=inventories&partner=${encodeURIComponent(receiver)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load the trade inventories.');
        tradingSenderUser = data.self.username;
        tradingReceiverUser = data.partner.username;
        tradingSenderItems = Array.isArray(data.self.items) ? data.self.items : [];
        tradingReceiverItems = Array.isArray(data.partner.items) ? data.partner.items : [];
        tradingSelected = new Map();
        tradingRequested = new Map();
        const partnerTitle = document.getElementById('tradingPartnerInventoryTitle');
        if (partnerTitle) partnerTitle.textContent = `@${tradingReceiverUser}'s Inventory`;
        const partnerChip = document.getElementById('tradingPartnerChip');
        if (partnerChip) partnerChip.innerHTML = `<span class="status-dot"></span><span>@${escText(tradingSenderUser)} ↔ @${escText(tradingReceiverUser)} · both inventories loaded</span>`;
        tradingSetStatus(`Loaded ${tradingSenderItems.length} of your item types and ${tradingReceiverItems.length} of their item types. Click any card to add it to the matching side of the trade.`, 'ok');
        setTradingStep('select');
        renderTradingInventory('self');
        renderTradingInventory('partner');
        renderTradingOffer();
        renderTradingSummary();
      } catch (error) {
        tradingSetStatus(error?.message || 'Could not load the trade inventories.', 'error');
      } finally {
        if (button) button.disabled = false;
      }
    }

    function clearTradingOffer() {
      tradingSelected = new Map();
      tradingRequested = new Map();
      setTradingStep('select');
      renderTradingInventory('self');
      renderTradingInventory('partner');
      renderTradingOffer();
      renderTradingSummary();
      tradingSetStatus('Trade builder cleared. No inventory was changed.', '');
    }

    async function sendTradingOffer() {
      if (!tradingReceiverUser || (!tradingSelected.size && !tradingRequested.size)) return;
      const button = document.getElementById('tradingSendBtn');
      if (button) button.disabled = true;
      tradingSetStatus(`Sending trade request to @${tradingReceiverUser}…`);
      try {
        const res = await fetch('/api/trades', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            to: tradingReceiverUser,
            give: [...tradingSelected.entries()].map(([item, quantity]) => ({ item, quantity })),
            receive: [...tradingRequested.entries()].map(([item, quantity]) => ({ item, quantity }))
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not send the trade request.');
        setTradingStep('sent');
        tradingSetStatus(`Trade request sent to @${tradingReceiverUser}. Their inventory will not change unless they accept.`, 'ok');
        tradingSelected = new Map();
        tradingRequested = new Map();
        renderTradingInventory('self');
        renderTradingInventory('partner');
        renderTradingOffer();
        renderTradingSummary();
        await loadTradingMail(true);
      } catch (error) {
        tradingSetStatus(error?.message || 'Could not send the trade request.', 'error');
      } finally {
        if (button) button.disabled = false;
      }
    }

    function tradingMailStatusLabel(status) {
      if (status === 'cancelled') return 'Withdrawn by sender';
      return String(status || 'pending').replace(/^[a-z]/, (c) => c.toUpperCase());
    }

    // Collapsed mail cards are remembered per browser, so a refresh or a
    // background mail reload does not pop them open again.
    const MAIL_COLLAPSED_KEY = 'fishing-mail-collapsed';
    const mailCollapsed = (() => {
      try { const raw = JSON.parse(localStorage.getItem(MAIL_COLLAPSED_KEY) || '[]'); return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : []); }
      catch (_) { return new Set(); }
    })();
    function saveMailCollapsed() {
      try { localStorage.setItem(MAIL_COLLAPSED_KEY, JSON.stringify([...mailCollapsed].slice(-400))); } catch (_) {}
    }
    function toggleMailCollapse(card) {
      if (!card) return;
      const id = card.dataset.mailId; if (!id) return;
      const collapsed = !card.classList.contains('collapsed');
      card.classList.toggle('collapsed', collapsed);
      const btn = card.querySelector('.mail-card-toggle');
      if (btn) { btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true'); btn.setAttribute('aria-label', collapsed ? 'Expand message' : 'Collapse message'); }
      if (collapsed) mailCollapsed.add(id); else mailCollapsed.delete(id);
      saveMailCollapsed();
      updateMailCollapseAllButton();
    }
    function visibleMailIds() {
      return tradingMailMessages.filter((message) => tradingMailFilter === 'all' || mailMessageCategory(message) === tradingMailFilter).map((message) => message.id);
    }
    function updateMailCollapseAllButton() {
      const btn = document.getElementById('mailCollapseAllBtn'); if (!btn) return;
      const ids = visibleMailIds();
      btn.textContent = ids.length && ids.every((id) => mailCollapsed.has(id)) ? 'Expand all' : 'Collapse all';
      btn.disabled = !ids.length;
    }
    function toggleAllMailCollapse() {
      const ids = visibleMailIds();
      const allCollapsed = ids.length && ids.every((id) => mailCollapsed.has(id));
      for (const id of ids) { if (allCollapsed) mailCollapsed.delete(id); else mailCollapsed.add(id); }
      saveMailCollapsed();
      renderMailMessages(tradingMailMessages);
    }

    function mailMessageCategory(message) {
      if (message?.type === 'trade') return 'trade';
      const subtype = String(message?.subtype || '').toLowerCase();
      if (subtype.startsWith('fish_')) return 'fish';
      if (subtype.startsWith('perk_')) return 'perk';
      return 'account';
    }

    function mailIsPendingEntry(message) {
      return (message.type === 'trade' && message.tradeOffer?.status === 'pending') || (message.type === 'perk' && message.perkGift?.status === 'pending');
    }
    function mailMatchesStatus(message) {
      if (tradingMailStatus === 'unread') return !message.read;
      if (tradingMailStatus === 'pending') return mailIsPendingEntry(message);
      return true;
    }
    /* ===== Your guide checklist (replaces the old tutorial) ===== */
    function guideRewardKey(login) { return 'fishingHub.guideRewardClaimed:' + login; }
    function guideRewardClaimed(login) {
      try { return !!login && localStorage.getItem(guideRewardKey(login)) === '1'; } catch (e) { return false; }
    }
    const GUIDE_TARGET_HUB = { 'treasury-only': 'perks', 'first-area': 'areas', 'autofish-license': 'autofish' };
    const GUIDE_TARGET_BUILDING = { 'treasury-only': 'perks', 'autofish-license': 'autofish' };
    const GUIDE_TARGET_SELECTORS = {
      'fishdex-login': ['[data-guide-target="fishdex-login"]', '#fishdexLoggedOut'],
      'progress': ['[data-guide-target="progress"]', '#fishdexLoggedIn'],
      'treasury-only': ['[data-guide-target="treasury-only"]', '#hubPanel-perks'],
      // If the map fails to load, the forest card is the fallback guide target.
      'first-area': ['[data-guide-target="first-area"]', '#hubPanel-areas [data-area="forest"]', '#hubPanel-areas .area-card', '.area-card'],
      'autofish-license': ['[data-guide-target="autofish-license"]', '.autofish-license-card', '.autofish-hero']
    };
    function findGuideTarget(key) {
      for (const selector of (GUIDE_TARGET_SELECTORS[key] || [])) {
        const el = document.querySelector(selector);
        if (el) return el;
      }
      return null;
    }
    function spotlightGuideTarget(key) {
      const hub = GUIDE_TARGET_HUB[key];
      // Clear a previous six-step guide pin highlight when moving to another step.
      if (key !== 'first-area' && window.WorldMapBridge && typeof WorldMapBridge.clearAreaFocus === 'function') WorldMapBridge.clearAreaFocus();
      if (typeof switchView === 'function') switchView('fishdex');
      // A building step opens that building's popup on the World Map (not the full hub page).
      if (GUIDE_TARGET_BUILDING[key] && window.WorldMapBridge && typeof WorldMapBridge.openBuilding === 'function') WorldMapBridge.openBuilding(GUIDE_TARGET_BUILDING[key]);
      else if (hub && typeof switchHubTab === 'function') switchHubTab(hub);

      // The map intentionally replaces the area cards when it is working, so the
      // Area step must focus the Forest pin rather than searching for a hidden card.
      if (key === 'first-area' && window.WorldMapBridge && typeof WorldMapBridge.focusArea === 'function') {
        // Ensure the map has been mounted before testing its state: the first click
        // can happen while the Area data request is still in flight.
        if (typeof WorldMapBridge.ensure === 'function') WorldMapBridge.ensure();
        if (WorldMapBridge.showingMap()) {
          WorldMapBridge.focusArea('forest');
          const mapTarget = document.getElementById('worldMapFrame');
          if (mapTarget) mapTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }

      const started = Date.now();
      const look = () => {
        const el = findGuideTarget(key);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.remove('guide-spotlight');
          void el.offsetWidth;
          el.classList.add('guide-spotlight');
          setTimeout(() => el.classList.remove('guide-spotlight'), 3200);
          return;
        }
        if (Date.now() - started > 4000) {
          toast('Could not find this on the page yet. Try again in a moment.', 'info', { label: 'Your guide' });
          return;
        }
        setTimeout(look, 150);
      };
      setTimeout(look, 150);
    }
    const GUIDE_CACHE_KEY = 'fishingHub.guideStatus';
    const GUIDE_EMPTY = { login: '', caught: 0, treasury: false, areaLevel: 0, autofish: false };
    let guideStatus = GUIDE_EMPTY;
    try { guideStatus = { ...GUIDE_EMPTY, ...(JSON.parse(localStorage.getItem(GUIDE_CACHE_KEY) || 'null') || {}) }; } catch (e) {}
    let guideRefreshInFlight = false;
    function saveGuideStatus() {
      try { localStorage.setItem(GUIDE_CACHE_KEY, JSON.stringify(guideStatus)); } catch (e) {}
    }
    async function refreshGuide() {
      if (guideRefreshInFlight) return;
      guideRefreshInFlight = true;
      try {
        const fishdexRes = await fetch('/api/fishdex', { cache: 'no-store' });
        if (fishdexRes.status === 401) {
          guideStatus = GUIDE_EMPTY;
        } else if (fishdexRes.ok) {
          const fd = await fishdexRes.json();
          const [perkRes, areaRes, autofishRes] = await Promise.all([
            fetch('/api/perks?check=treasuryOnly', { cache: 'no-store' }),
            fetch('/api/areas', { cache: 'no-store' }),
            fetch('/api/autofish?check=licensed', { cache: 'no-store' })
          ]);
          const perk = perkRes.ok ? await perkRes.json() : {};
          const areas = areaRes.ok ? await areaRes.json() : {};
          const autofish = autofishRes.ok ? await autofishRes.json() : {};
          const list = areas?.areas || [];
          const forest = list.find((a) => a.id === 'forest') || list[0];
          guideStatus = {
            login: fd?.user?.login || '',
            caught: Number(fd?.totalCaught || 0),
            treasury: !!perk?.treasuryOnly?.enabled,
            areaLevel: Number(forest?.level || 0),
            autofish: !!autofish?.licensed
          };
        }
        saveGuideStatus();
      } catch (e) {
        // Keep the last known status if the network is unavailable.
      } finally {
        guideRefreshInFlight = false;
        updateYourGuide();
      }
    }
    function updateYourGuide() {
      const guide = document.getElementById('yourGuide');
      if (!guide) return;
      const login = guideStatus.login || '';
      const caught = Number(guideStatus.caught || 0);
      const strip = document.getElementById('startHereStrip');
      if (strip) strip.hidden = !!login;
      const areaLevel = Number(guideStatus.areaLevel || 0);
      const claimed = guideRewardClaimed(login);
      // Keep the checklist visible after the reward so the six-step tutorial can
      // be replayed from the button at the bottom. The reward itself remains one-time.
      guide.hidden = false;
      const done = {
        login: !!login,
        catches: caught >= 25,
        treasury: !!guideStatus.treasury,
        area: areaLevel >= 3,
        autofish: !!guideStatus.autofish,
        reward: claimed
      };
      const details = {
        catches: `${Math.min(caught, 25)} / 25 caught. Type !fish in the Twitch chat.`,
        area: `${areaLevel} / 3 on your first Area.`
      };
      let currentSet = false;
      guide.querySelectorAll('[data-guide-step]').forEach((row) => {
        const key = row.dataset.guideStep;
        const isDone = !!done[key];
        row.classList.toggle('is-done', isDone);
        row.classList.toggle('is-current', !isDone && !currentSet);
        if (!isDone && !currentSet) currentSet = true;
        const stateEl = row.querySelector('.yg-state');
        if (stateEl) stateEl.textContent = isDone ? 'Done' : (row.classList.contains('is-current') ? 'Next' : '');
        if (details[key]) {
          const detailEl = row.querySelector('.yg-detail');
          if (detailEl) detailEl.textContent = details[key];
        }
      });
      const rewardBtn = document.getElementById('guideRewardBtn');
      if (rewardBtn) {
        rewardBtn.disabled = claimed;
        rewardBtn.textContent = claimed ? 'Claimed' : 'Claim';
      }
    }
    function toggleYourGuide(btn) {
      const guide = document.getElementById('yourGuide');
      if (!guide) return;
      const collapsed = guide.classList.toggle('yg-collapsed');
      btn.textContent = collapsed ? 'Show steps' : 'Hide steps';
      btn.setAttribute('aria-expanded', String(!collapsed));
    }
    let guideRewardInFlight = false;
    async function claimGuideReward() {
      if (guideRewardInFlight) return;
      const login = cachedFishdexData?.user?.login || currentFishdexLogin || '';
      if (!login) { toast('Log in with Twitch to claim your reward.', 'info', { label: 'Your guide' }); return; }
      guideRewardInFlight = true;
      const btn = document.getElementById('guideRewardBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'Claiming…'; }
      try {
        const res = await fetch('/api/progression', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'claim-tutorial-reward' }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || 'Could not claim the reward.');
        try { localStorage.setItem(guideRewardKey(login), '1'); } catch (e) {}
        if (!data.alreadyClaimed && data.items?.length) {
          toast(`Reward claimed: ${data.items.length} Treasury items.`, 'success', { label: 'Your guide' });
          try { await loadPerksStatus(); } catch (e) { console.warn('[scripts/index-app.js:6320] ignored error:', e?.message || e); }
        } else {
          toast('Your reward was already claimed.', 'info', { label: 'Your guide' });
        }
      } catch (err) {
        toast(err.message || 'Could not claim the reward.', 'error', { label: 'Your guide' });
        if (btn) { btn.disabled = false; btn.textContent = 'Claim'; }
      } finally {
        guideRewardInFlight = false;
        updateYourGuide();
      }
    }
    setTimeout(updateYourGuide, 0);
    setTimeout(refreshGuide, 800);
    setInterval(() => { if (!document.hidden) refreshGuide(); }, guideStatus.login ? 45000 : 120000);

    function openTutorialOffer() {
      if (typeof switchView === 'function') switchView('fishdex');
      setTimeout(() => document.getElementById('yourGuide')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    }
    let nextStepAction = null;
    function updateNextStepCard(data) {
      const card = document.getElementById('nextStepCard');
      const text = document.getElementById('nextStepText');
      const btn = document.getElementById('nextStepBtn');
      if (!card || !text || !btn) return;
      const source = data || cachedFishdexData;
      const strip = document.getElementById('startHereStrip');
      if (strip) strip.hidden = !!source;
      if (!source) { card.hidden = true; return; }
      const pending = (tradingMailMessages || []).filter(mailIsPendingEntry).length;
      const progress = fishdexIndexProgress(source);
      const caught = progress.caught;
      const total = progress.total;
      let message, label, action;
      if (pending > 0) {
        message = `${pending} trade or gift ${pending === 1 ? 'request is' : 'requests are'} waiting for your answer.`;
        label = 'Open Mail';
        action = () => { switchView('fishdex'); switchHubTab('mail'); };
      } else if (caught === 0) {
        message = 'Catch your first fish: type !fish in the Twitch chat, and it will show up in your Fishdex.';
        label = 'Open Fishdex';
        action = () => switchView('fishdex');
      } else if (caught < 25) {
        message = `You have ${caught} of 25 catches. Reach 25 to unlock your first Area.`;
        label = 'Open Fishdex';
        action = () => switchView('fishdex');
      } else {
        const missing = total - caught;
        message = missing > 0
          ? `${missing.toLocaleString()} fish are still missing from your index. Open the Fishdex to see which tier needs them.`
          : 'Your Fishdex is complete. Check Areas and Auto-Fish for what to do next.';
        label = 'Open Fishdex';
        action = () => switchView('fishdex');
      }
      text.textContent = message;
      btn.textContent = label;
      nextStepAction = action;
      btn.onclick = () => { if (nextStepAction) nextStepAction(); };
      card.hidden = false;
    }

    function setMailStatusFilter(value) {
      tradingMailStatus = ['all', 'unread', 'pending'].includes(value) ? value : 'all';
      tradingMailPage = 1;
      renderMailMessages(tradingMailMessages);
    }
    function setMailFilter(filter) {
      tradingMailFilter = ['all', 'trade', 'fish', 'perk', 'account'].includes(filter) ? filter : 'all';
      tradingMailPage = 1;
      renderMailMessages(tradingMailMessages);
    }

    function renderMailMessages(messages) {
      updateNextStepCard();
      const list = document.getElementById('mailList');
      const pill = document.getElementById('mailCountPill');
      const hubBadge = document.getElementById('hubMailBadge');
      const tradeBadge = document.getElementById('tradingMailBadge');
      if (!list) return;
      const filtered = tradingMailMessages.filter((message) => (tradingMailFilter === 'all' || mailMessageCategory(message) === tradingMailFilter) && mailMatchesStatus(message));
      const totalPages = Math.max(1, Math.ceil(filtered.length / MAIL_PAGE_SIZE));
      tradingMailPage = Math.min(tradingMailPage, totalPages);
      const mailStart = (tradingMailPage - 1) * MAIL_PAGE_SIZE;
      const pagedFiltered = filtered.slice(mailStart, mailStart + MAIL_PAGE_SIZE);
      const isPending = (message) => (message.type === 'trade' && message.tradeOffer?.status === 'pending') || (message.type === 'perk' && message.perkGift?.status === 'pending');
      const litMessages = tradingMailMessages.filter((message) => !message.read || isPending(message));
      const pendingIncoming = tradingMailMessages.filter((message) => ((message.type === 'trade' && message.tradeOffer?.to === tradingSenderUser) || (message.type === 'perk' && message.perkGift?.to === tradingSenderUser)) && isPending(message)).length;
      if (pill) pill.textContent = `${filtered.length} message${filtered.length === 1 ? '' : 's'}`;
      if (hubBadge) { hubBadge.textContent = String(litMessages.length); hubBadge.classList.toggle('new', litMessages.length > 0); hubBadge.title = litMessages.length ? `${litMessages.length} unread or pending message${litMessages.length === 1 ? '' : 's'}` : 'No unread mail'; }
      if (tradeBadge) tradeBadge.textContent = `${pendingIncoming} pending`;
      if (!filtered.length) {
        list.innerHTML = `<div class="trading-empty">No ${tradingMailFilter === 'all' ? '' : tradingMailFilter + ' '}messages yet.</div>`;
        renderPageSwitcher('mailPageSwitcher', 1, 1, 'setMailPage');
        updateMailCollapseAllButton();
        return;
      }
      const sideRows = (entries) => (entries || []).map((entry) => `<div class="trading-mail-row"><span>${escText(entry.item)}</span><strong>x${entry.quantity}</strong></div>`).join('') || '<div class="trading-mail-row"><span>Nothing</span><strong>—</strong></div>';
      const markButton = (message, pending) => !message.read && !pending ? `<button class="mail-read-btn" type="button" onclick='markMailEntryRead(${JSON.stringify(message.id)})'>Mark as read</button>` : '';
      list.innerHTML = pagedFiltered.map((message) => {
        const pending = isPending(message); const unread = !message.read || pending; const stateClass = unread ? 'unread' : 'read';
        if (message.type === 'trade' && message.tradeOffer) {
          const offer = message.tradeOffer; const incoming = offer.to === tradingSenderUser; const other = incoming ? offer.from : offer.to;
          const actions = offer.status === 'pending' ? (incoming ? `<div class="trading-mail-actions"><button class="shop-item-cta" type="button" onclick='respondToTradingMail(${JSON.stringify(offer.id)}, "accept")'>Accept &amp; Trade</button><button class="shop-item-cta" type="button" onclick='respondToTradingMail(${JSON.stringify(offer.id)}, "decline")'>Decline</button></div>` : `<div class="trading-mail-actions"><button class="shop-item-cta" type="button" onclick='respondToTradingMail(${JSON.stringify(offer.id)}, "cancel")'>Cancel Request</button></div>`) : '';
          const failure = offer.failureReason ? `<div class="mail-card-meta">${escText(offer.failureReason)}</div>` : '';
          return `<article data-mail-id="${escText(message.id)}" class="mail-card ${mailCollapsed.has(message.id) ? 'collapsed' : ''} trade ${offer.status === 'pending' ? 'pending' : ''} ${stateClass}"><div class="mail-card-head" onclick="toggleMailCollapse(this.closest('.mail-card'))"><div style="display:flex;gap:8px;"><span class="mail-unread-dot" style="${unread ? '' : 'display:none;'}"></span><div><div class="mail-card-title">${incoming ? `Trade request from @${escText(other)}` : `Trade request to @${escText(other)}`}</div><div class="mail-card-type">Trade request · ${tradingMailStatusLabel(offer.status)}</div></div></div><span class="mail-card-date">${new Date(message.createdAt).toLocaleString()}</span><button class="mail-card-toggle" type="button" aria-expanded="${mailCollapsed.has(message.id) ? 'false' : 'true'}" aria-label="${mailCollapsed.has(message.id) ? 'Expand message' : 'Collapse message'}"></button></div><div class="mail-card-body"><div class="mail-card-message">${escText(message.message)}</div><div class="trading-mail-items"><div class="trading-mail-side"><div class="trading-mail-side-label">${incoming ? 'They give you' : 'You give them'}</div>${sideRows(offer.give)}</div><div class="trading-mail-side"><div class="trading-mail-side-label">${incoming ? 'You give them' : 'They give you'}</div>${sideRows(offer.receive)}</div></div>${failure}${actions}${markButton(message, pending)}</div></article>`;
        }
        if (message.type === 'perk' && message.perkGift) {
          const gift = message.perkGift; const incoming = gift.to === tradingSenderUser; const other = incoming ? gift.from : gift.to;
          const actions = gift.status === 'pending' ? (incoming ? `<div class="trading-mail-actions"><button class="shop-item-cta" type="button" onclick='respondToPerkGift(${JSON.stringify(gift.id)}, "accept")'>Accept Gift</button><button class="shop-item-cta" type="button" onclick='respondToPerkGift(${JSON.stringify(gift.id)}, "decline")'>Decline</button></div>` : `<div class="trading-mail-actions"><button class="shop-item-cta" type="button" onclick='respondToPerkGift(${JSON.stringify(gift.id)}, "cancel")'>Cancel Gift</button></div>`) : '';
          const rarity = gift.rarity ? ` · ${gift.rarity}` : ''; const failure = gift.failureReason ? `<div class="mail-card-meta">${escText(gift.failureReason)}</div>` : '';
          return `<article data-mail-id="${escText(message.id)}" class="mail-card ${mailCollapsed.has(message.id) ? 'collapsed' : ''} perk ${gift.status === 'pending' ? 'pending' : ''} ${stateClass}"><div class="mail-card-head" onclick="toggleMailCollapse(this.closest('.mail-card'))"><div style="display:flex;gap:8px;"><span class="mail-unread-dot" style="${unread ? '' : 'display:none;'}"></span><div><div class="mail-card-title">${incoming ? `Perk gift from @${escText(other)}` : `Perk gift to @${escText(other)}`}</div><div class="mail-card-type">Perk gift · ${tradingMailStatusLabel(gift.status)}</div></div></div><span class="mail-card-date">${new Date(message.createdAt).toLocaleString()}</span><button class="mail-card-toggle" type="button" aria-expanded="${mailCollapsed.has(message.id) ? 'false' : 'true'}" aria-label="${mailCollapsed.has(message.id) ? 'Expand message' : 'Collapse message'}"></button></div><div class="mail-card-body"><div class="mail-card-message">${escText(message.message)}${rarity ? ` <strong>${escText(rarity)}</strong>` : ''}</div><div class="mail-card-meta">${gift.status === 'pending' || gift.status === 'accepted' ? `${escText(gift.perkName)} · ${gift.cost} Treasury paid by @${escText(gift.from)}. The recipient pays nothing.` : `${escText(gift.perkName)} · ${gift.cost} Treasury returned to @${escText(gift.from)}.`}</div>${failure}${actions}${markButton(message, pending)}</div></article>`;
        }
        const category = mailMessageCategory(message); const typeLabel = category === 'fish' ? 'Fish change' : category === 'perk' ? 'Perk change' : 'Account change';
        return `<article data-mail-id="${escText(message.id)}" class="mail-card ${mailCollapsed.has(message.id) ? 'collapsed' : ''} admin ${stateClass}"><div class="mail-card-head" onclick="toggleMailCollapse(this.closest('.mail-card'))"><div style="display:flex;gap:8px;"><span class="mail-unread-dot" style="${unread ? '' : 'display:none;'}"></span><div><div class="mail-card-title">${escText(message.title || 'Account update')}</div><div class="mail-card-type">${typeLabel} · Admin feedback</div></div></div><span class="mail-card-date">${new Date(message.createdAt).toLocaleString()}</span><button class="mail-card-toggle" type="button" aria-expanded="${mailCollapsed.has(message.id) ? 'false' : 'true'}" aria-label="${mailCollapsed.has(message.id) ? 'Expand message' : 'Collapse message'}"></button></div><div class="mail-card-body"><div class="mail-card-message">${escText(message.message)}</div>${message.actor ? `<div class="mail-card-meta">Changed by @${escText(message.actor)}</div>` : ''}${markButton(message, pending)}</div></article>`;
      }).join('');
      renderPageSwitcher('mailPageSwitcher', tradingMailPage, totalPages, 'setMailPage');
      updateMailCollapseAllButton();
    }

    async function loadTradingMail(silent = false) {
      if (!currentFishdexLogin) return;
      try {
        const res = await fetch('/api/trades?action=mail');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load Mail.');
        tradingMailMessages = Array.isArray(data.messages) ? data.messages : [];
        renderMailMessages(tradingMailMessages);
      } catch (error) {
        if (!silent) {
          tradingSetStatus(error?.message || 'Could not load Mail.', 'error');
          toast(error?.message || 'Could not load Mail.', 'error', { label: 'Mail refresh failed' });
        }
      }
    }

    async function respondToTradingMail(offerId, decision) {
      try {
        const res = await fetch('/api/trades', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'respond', offerId, decision })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not respond to the trade request.');
        const offer = data.offer || {};
        if (decision === 'accept') {
          setTradingStep('accepted');
          tradingSetStatus('Trade accepted. The exact items were moved and Fishdex discoveries were preserved/updated.', 'ok');
          toast('Trade accepted. The inventories were updated and Fishdex discoveries were preserved.', 'success', { label: 'Trade completed' });
          tradingReceiverUser = offer.from === tradingSenderUser ? offer.to : offer.from;
          if (tradingReceiverUser && tradingReceiverUser !== tradingSenderUser) {
            document.getElementById('tradingReceiver').value = tradingReceiverUser;
            await loadTradingPlayers();
          }
        } else {
          tradingSetStatus(`Trade request ${decision === 'decline' ? 'declined' : 'cancelled'}.`, 'ok');
          toast(`Trade request ${decision === 'decline' ? 'declined' : 'cancelled'}.`, 'success', { label: decision === 'decline' ? 'Trade declined' : 'Trade cancelled' });
        }
        await loadTradingMail(true);
      } catch (error) {
        tradingSetStatus(error?.message || 'Could not respond to the trade request.', 'error');
        await loadTradingMail(true);
      }
    }

    async function markAllMailRead() {
      const isPendingEntry = (message) => (message.type === 'trade' && message.tradeOffer?.status === 'pending') || (message.type === 'perk' && message.perkGift?.status === 'pending');
      const unread = (tradingMailMessages || []).filter((message) => !message.read && !isPendingEntry(message));
      if (!unread.length) { toast('No unread mail to mark.', 'info', { label:'Mail' }); return; }
      try {
        const res = await fetch('/api/trades', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'markread', ids: unread.map((message) => message.id) }) });
        if (!res.ok) throw new Error('Could not mark mail as read.');
        unread.forEach((message) => { message.read = true; });
        renderMailMessages(tradingMailMessages);
        toast(`Marked ${unread.length} message${unread.length === 1 ? '' : 's'} as read.`, 'success', { label:'Mail' });
      } catch (error) {
        toast(error?.message || 'Could not mark mail as read.', 'error', { label:'Mail update failed' });
      }
    }

    async function markMailEntryRead(id) {
      try { const res = await fetch('/api/trades', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'markread', ids:[id] }) }); if (!res.ok) throw new Error('Could not mark that message as read.'); const entry=tradingMailMessages.find((message)=>message.id===id); if(entry) entry.read=true; renderMailMessages(tradingMailMessages); } catch(error) { toast(error?.message || 'Could not mark message as read.', 'error', { label:'Mail update failed' }); }
    }

    let perkGiftDraft = null;
    let perkGiftCheckSeq = 0;
    let perkGiftCheckTimer = null;
    let perkGiftLastCheck = null;
    function setPerkGiftRecipientStatus(message, state='') {
      const el=document.getElementById('perkGiftRecipientStatus');
      if(!el)return;
      el.textContent=message;
      el.className=`gift-recipient-status${state ? ` ${state}` : ''}`;
    }
    function setPerkGiftSendEnabled(enabled) {
      const btn=document.getElementById('perkGiftSendBtn');
      if(btn)btn.disabled=!enabled;
    }
    function queuePerkGiftRecipientCheck() {
      setPerkGiftSendEnabled(false);
      setPerkGiftRecipientStatus('Checking recipient perk ownership…','checking');
      if(perkGiftCheckTimer)clearTimeout(perkGiftCheckTimer);
      perkGiftCheckTimer=setTimeout(()=>checkPerkGiftRecipient(),300);
    }
    async function checkPerkGiftRecipient() {
      if(!perkGiftDraft)return false;
      const to=String(document.getElementById('perkGiftRecipient')?.value||'').trim().replace(/^@+/,'').toLowerCase();
      const seq=++perkGiftCheckSeq;
      if(!/^[a-z0-9_]{1,32}$/.test(to)){
        setPerkGiftSendEnabled(false);
        setPerkGiftRecipientStatus('Enter a valid Twitch username.','error');
        return false;
      }
      if(to===tradingSenderUser){
        setPerkGiftSendEnabled(false);
        setPerkGiftRecipientStatus('You cannot gift a perk to yourself.','error');
        return false;
      }
      setPerkGiftSendEnabled(false);
      setPerkGiftRecipientStatus('Checking whether this player already owns the perk…','checking');
      try {
        const res=await fetch('/api/trades',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'checkgiftperk',to,perk:perkGiftDraft})});
        const data=await res.json();
        if(seq!==perkGiftCheckSeq)return false;
        if(!res.ok)throw new Error(data.error||'Could not check the recipient.');
        const levelText = data.targetLevel ? ` Level ${data.targetLevel}.` : ''; const costText = typeof data.cost === 'number' ? ` ${data.cost} Treasury.` : ''; setPerkGiftRecipientStatus(`@${to} can receive this perk.${levelText}${costText}`,'ok');
        setPerkGiftSendEnabled(true);
        perkGiftLastCheck={to,perk:perkGiftDraft,checkedAt:Date.now(),valid:true};
        return true;
      } catch(error) {
        if(seq===perkGiftCheckSeq){
          setPerkGiftRecipientStatus(error?.message||'Could not check the recipient.','error');
          setPerkGiftSendEnabled(false);
        }
        return false;
      }
    }
    function openPerkGiftModal(perk) {
      if (!currentFishdexLogin) { toast('Log in with Twitch before gifting a perk.', 'error', { label:'Not logged in' }); return; }
      perkGiftDraft=perk;
      const names={luck125:'1.25x Luck',cooldown:'15% Cooldown Reduction',treasuryLuck:'1.5x Treasury Luck',rarityBoost:'2x Rarity Luck (15 min)',treasuryOnly:'Treasury Only Mode'};
      const costs={luck125:80,cooldown:45,treasuryLuck:55,rarityBoost:25,treasuryOnly:0};
      const pondGift=window.__pondGiftInfo?.[perk];
      const name=pondGift?.label || names[perk] || perk;
      const cost=pondGift?.nextCost ?? costs[perk] ?? 0;
      const target=pondGift ? `The recipient receives the next level${pondGift.level ? ` (Level ${pondGift.level})` : ''} for free after accepting.` : 'The recipient receives the perk for free after accepting.';
      const summary=document.getElementById('perkGiftSummary'); if(summary) summary.innerHTML=`<strong>${escText(name)}</strong><br>${Number(cost).toLocaleString('en-US')} Treasury will be reserved from your inventory. ${target}`;
      const wrap=document.getElementById('perkGiftRarityWrap'); if(wrap) wrap.style.display=perk==='rarityBoost'?'block':'none';
      const input=document.getElementById('perkGiftRecipient');
      setPerkGiftSendEnabled(false);
      setPerkGiftRecipientStatus('Enter a Twitch username to check perk ownership.');
      if(input){input.value='';setTimeout(()=>input.focus(),50);}
      document.getElementById('perkGiftModal')?.classList.add('active');
    }
    function closePerkGiftModal(){document.getElementById('perkGiftModal')?.classList.remove('active');perkGiftDraft=null;perkGiftCheckSeq++;if(perkGiftCheckTimer)clearTimeout(perkGiftCheckTimer);perkGiftLastCheck=null;setPerkGiftSendEnabled(false);}
    async function sendPerkGift(){
      if(!perkGiftDraft)return;
      const btn=document.getElementById('perkGiftSendBtn');
      // Set the guard BEFORE any await. This prevents two rapid clicks from
      // both passing the recipient check and creating two separate gift requests.
      if(btn?.dataset.sending==='1')return;
      if(btn){btn.dataset.sending='1';btn.disabled=true;}
      const to=String(document.getElementById('perkGiftRecipient')?.value||'').trim().replace(/^@+/,'').toLowerCase();
      if(!/^[a-z0-9_]{1,32}$/.test(to)){if(btn){delete btn.dataset.sending;btn.disabled=false;}toast('Enter a valid Twitch username.','error',{label:'Gift not sent'});return;}
      if(to===tradingSenderUser){if(btn){delete btn.dataset.sending;btn.disabled=false;}toast('You cannot gift a perk to yourself.','error',{label:'Gift not sent'});return;}
      // Reuse a very recent successful UI check instead of making a second
      // round trip. The server still performs the authoritative ownership
      // check inside the gift transaction immediately before charging Treasury.
      const cached=perkGiftLastCheck;
      const checked=(cached && cached.valid && cached.to===to && cached.perk===perkGiftDraft && (Date.now()-cached.checkedAt)<10000) ? true : await checkPerkGiftRecipient();
      if(!checked){if(btn){delete btn.dataset.sending;btn.disabled=false;}return;}
      try{const body={action:'giftperk',to,perk:perkGiftDraft};if(perkGiftDraft==='rarityBoost')body.rarity=document.getElementById('perkGiftRarity')?.value||'epic';const res=await fetch('/api/trades',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not send the perk gift.');closePerkGiftModal();
        const balanceNote = typeof data.balance === 'number' ? ` ${data.balance} Treasury item${data.balance === 1 ? '' : 's'} left.` : '';
        toast(`${data.message || 'Perk gift request sent.'}${balanceNote}`, 'success', { label: 'Gift request sent' });
        // Refresh in the background so the click/toast stays responsive.
        Promise.all([loadTradingMail(true),loadPerksStatus(), (window.__pondLastStatus ? loadPondStatus() : Promise.resolve())]).catch(()=>{});
      }catch(error){toast(error?.message||'Could not send the perk gift.','error',{label:'Gift failed'});}finally{if(btn){btn.disabled=false;delete btn.dataset.sending;}}
    }
    async function respondToPerkGift(giftId,decision){
      try{const res=await fetch('/api/trades',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'respondgift',giftId,decision})});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not respond to the perk gift.');const gift=data.gift||{};const labels={accept:'Gift accepted',decline:'Gift declined',cancel:'Gift cancelled'};const messages={accept:data.message||`${gift.perkName||'Perk'} was added to your perks for free.`,decline:'The perk gift was declined. Your Treasury has been returned to the sender.',cancel:'The perk gift was cancelled. Your reserved Treasury has been returned.'};toast(messages[decision]||'Perk gift updated.','success',{label:labels[decision]||'Mail updated'});await fetch('/api/trades',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'markread',ids:[`gift-${giftId}`]})});await loadTradingMail(true);if(decision==='accept'){loadPerksStatus();loadPondStatus();}}catch(error){toast(error?.message||'Could not respond to the perk gift.','error',{label:'Mail action failed'});await loadTradingMail(true);}
    }

    function startTradingMailPolling() {
      if (tradingMailTimer) clearInterval(tradingMailTimer);
      tradingMailTimer = setInterval(() => loadTradingMail(true), 15000);
      loadTradingMail(true);
    }

    async function refreshCurrentHub() {
      if (!currentFishdexLogin) {
        toast('Log in with Twitch to refresh player data.', 'error', { label: 'Refresh unavailable' });
        return;
      }
      const button = document.getElementById('hubRefreshBtn');
      const iconEl = document.getElementById('hubRefreshIcon');
      if (button) button.disabled = true;
      if (iconEl) iconEl.classList.add('spin');
      try {
        const active = (document.querySelector('.wb-popup .hub-panel.active') || document.querySelector('.hub-panel.active'))?.id || '';
        if (active === 'hubPanel-areas') {
          await loadFishingAreas(false);
          toast('Fishing areas are up to date.', 'success', { label: 'Refreshed' });
        } else if (active === 'hubPanel-trading') {
          const receiver = (document.getElementById('tradingReceiver')?.value || '').trim();
          const jobs = [loadTradingMail(true)];
          if (receiver) jobs.push(loadTradingPlayers());
          await Promise.all(jobs);
          toast(receiver ? 'Mail and both trading inventories are up to date.' : 'Mail is up to date. Enter a player to refresh both inventories.', 'success', { label: 'Refreshed' });
        } else if (active === 'hubPanel-mail') {
          await loadTradingMail(true);
          toast('Mail is up to date.', 'success', { label: 'Refreshed' });
        } else if (active === 'hubPanel-pond') {
          await loadPondStatus();
          toast('Pond is up to date.', 'success', { label: 'Refreshed' });
        } else if (active === 'hubPanel-achievements' || active === 'hubPanel-settings') {
          await loadProgression(true);
          if (active === 'hubPanel-settings' && document.getElementById('settingsPanel-chat')?.classList.contains('active')) await loadFishMessageSettings(true);
          toast('Player customization data is up to date.', 'success', { label: 'Refreshed' });
        } else {
          await loadTradingMail(true);
          toast('Player feedback is up to date.', 'success', { label: 'Refreshed' });
        }
      } catch (error) {
        toast(error?.message || 'Refresh failed.', 'error', { label: 'Refresh failed' });
      } finally {
        if (button) button.disabled = false;
        if (iconEl) iconEl.classList.remove('spin');
      }
    }

    document.addEventListener('change', (event) => {
      if (event.target?.matches?.('#badminInventoryList input[type="checkbox"]')) updateBroadcasterDeleteButton();
    });

    /* ---------- Hub tab switching (Shop / Perks / Index / Trading / Mail) ---------- */

    function switchHubTab(tab, options = {}) {
      const runLoaders = options.load !== false;
      if ((tab === 'trading' || tab === 'mail') && !currentFishdexLogin) return;
      if (tab === 'broadcaster-admin' && !broadcasterAdminAuthenticated) return openBroadcasterAdminLogin();
      document.querySelectorAll('.hub-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.hub === tab));
      document.querySelectorAll('.hub-panel').forEach((p) => p.classList.toggle('active', p.id === `hubPanel-${tab}`));
      if (runLoaders && (tab === 'areas' || tab === 'perks' || tab === 'shop')) loadFishingAreas(true);
      if (tab === 'settings') { switchSettingsPanel('cosmetics'); loadProgression(); }
      if (tab === 'achievements') loadProgression();
      if (tab === 'shop') { loadProgression(true); loadPerksStatus(); loadPondStatus(); }
      if (runLoaders && tab === 'autofish') loadAutoFishStatus(true);
      if (runLoaders && tab === 'pond') loadPondStatus();
      if (tab === 'broadcaster-admin') loadBroadcasterAdminTools();
      if (tab === 'trading' || tab === 'mail') {
        syncTradingIdentity({ login: currentFishdexLogin });
        startTradingMailPolling();
      }
      syncWorldBackBar(tab);
      // A building popup on the World Map closes unless this is the same hub.
      if (window.WorldMapBridge && typeof WorldMapBridge.onTabSwitch === 'function') WorldMapBridge.onTabSwitch(tab);
    }

    /* ---------- World Map buildings --------------------------------------
       Buildings on the World Map open these hubs. The sidebar keeps only
       World Map, Customisations and Broadcaster Admin. */
    const WORLD_BUILDING_HUBS = { trading: 'trading', mail: 'mail', index: 'index', achievements: 'achievements', perks: 'perks', autofish: 'autofish', shop: 'shop', pond: 'pond' };
    const WORLD_BACK_HUBS = ['perks', 'autofish', 'pond', 'shop', 'index', 'trading', 'mail', 'achievements'];

    function syncWorldBackBar(tab) {
      const bar = document.getElementById('worldBackBar');
      if (bar) bar.hidden = !WORLD_BACK_HUBS.includes(tab);
    }

    window.openWorldBuilding = function openWorldBuilding(id) {
      if (!Object.prototype.hasOwnProperty.call(WORLD_BUILDING_HUBS, id)) return false;
      const hub = WORLD_BUILDING_HUBS[id];
      switchHubTab(hub);
      // switchHubTab returns early for Trading and Mail when not logged in.
      if (!document.getElementById(`hubPanel-${hub}`)?.classList.contains('active')) return false;
      // The guide's highlight may be waiting for this panel to render (it is moved into the popup next).
      if (typeof tutorialAfterRender === 'function') tutorialAfterRender();
      // The World Map bridge shows this hub in a popup over the map (scripts/world-map-bridge.js).
      return hub;
    };

    window.worldBuildingLocked = function worldBuildingLocked(id) {
      if (id === 'trading') return document.getElementById('tradingHubNavBtn')?.style.display === 'none';
      if (id === 'mail') return document.getElementById('mailHubNavBtn')?.style.display === 'none';
      // Auto-Fish opens at Area Level 3 (the license is then bought in the hub).
      if (id === 'autofish') { const d = window.__lastAutoFishData; return !(d?.licensed || d?.areaLevel3Eligible); }
      // The Personal Pond unlocks at Prestige 1.
      if (id === 'pond') return !window.__pondLastStatus?.unlocked;
      return !Object.prototype.hasOwnProperty.call(WORLD_BUILDING_HUBS, id);
    };

    // Badges on the World Map: a number (unread mail) or true (something to do: buy, license ready).
    window.worldBuildingStatus = function worldBuildingStatus() {
      const out = {};
      const unread = (tradingMailMessages || []).filter((message) => !message.read).length;
      if (unread) out.mail = unread;
      const buy = window.__shopCategoryBuyable || {};
      if (buy.normal || buy.gear) out.shop = true;
      if (buy.pond) out.pond = true;
      const af = window.__lastAutoFishData;
      if (af?.areaLevel3Eligible && !af.licensed) out.autofish = true;
      return out;
    };

    /* ---------- Gear / Achievements / Cosmetics --------------------------- */
    let progressionData = null;
    let progressionLoadPromise = null;

    async function loadProgression(force = false) {
      if (!currentFishdexLogin) return null;
      if (progressionLoadPromise && !force) return progressionLoadPromise;
      progressionLoadPromise = (async () => {
        try {
          const res = await fetch(`/api/progression${force ? `?fresh=${Date.now()}` : ''}`, { cache: force ? 'no-store' : 'default' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not load progression.');
          progressionData = data;
          renderGear(); renderAchievements(); renderTitles(); renderCosmetics(); renderCosmeticsPreview();
          refreshProfileBoosts();
          return data;
        } catch (error) {
          toast(error?.message || 'Could not load progression.', 'error', { label: 'Progression failed' });
          return null;
        } finally { progressionLoadPromise = null; }
      })();
      return progressionLoadPromise;
    }

    function adminPriceButton(category, id, price) {
      if (!isAdminLoggedIn) return '';
      return `<button class="shop-price-edit" type="button" title="Edit price" aria-label="Edit price" data-price-category="${escText(category)}" data-price-id="${escText(id)}" onclick='editShopPrice(${JSON.stringify(category)},${JSON.stringify(id)},${Number(price)})'>${icon('edit')}</button>`;
    }

    function priceMarkup(category, id, price, suffix = ' Treasury') {
      return `<span class="shop-price-editor"><span>${Number(price).toLocaleString('en-US')}${escText(suffix)}</span>${adminPriceButton(category,id,price)}</span>`;
    }

    function pondPriceMarkup(id, levelIndex, price) {
      if (!isAdminLoggedIn) return `${Number(price).toLocaleString('en-US')} Treasury`;
      return `<span class="shop-price-editor"><span>${Number(price).toLocaleString('en-US')} Treasury</span><button class="shop-price-edit" type="button" title="Edit this Pond perk level price" aria-label="Edit this Pond perk level price" onclick='editPondPerkPrice(${JSON.stringify(id)},${Number(levelIndex)},${Number(price)})'>${icon('edit')}</button></span>`;
    }

    function editPondPerkPrice(id, levelIndex, currentPrice) {
      if (!isAdminLoggedIn || !authToken) return;
      const button = Array.from(document.querySelectorAll('.shop-price-edit')).find((el) => el.getAttribute('aria-label') === 'Edit this Pond perk level price' && el.closest('.pond-perk-card')?.dataset?.pondPerk === id && Number(el.closest('.pond-perk-card')?.dataset?.pondLevel) === Number(levelIndex));
      const wrap = button?.closest('.shop-price-editor');
      if (!wrap) return;
      wrap.innerHTML = `<input class="shop-price-input" type="number" min="0" max="1000000000" step="1" value="${Number(currentPrice)}" aria-label="New Pond perk price"><button class="shop-price-save" type="button">Save</button><button class="shop-price-cancel" type="button">Cancel</button>`;
      const input=wrap.querySelector('.shop-price-input');
      const restore=()=>{ wrap.outerHTML=pondPriceMarkup(id,levelIndex,currentPrice); };
      wrap.querySelector('.shop-price-cancel').onclick=restore;
      wrap.querySelector('.shop-price-save').onclick=async()=>{
        const price=Number(input.value);
        if(!Number.isInteger(price)||price<0||price>1000000000){toast('Enter a whole number from 0 to 1,000,000,000.','error',{label:'Invalid price'});return;}
        const save=wrap.querySelector('.shop-price-save'); save.disabled=true; save.textContent='…';
        try{const res=await fetch('/api/admin/action',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`},body:JSON.stringify({action:'pond-perk-price',pondPerk:id,pondLevel:Number(levelIndex),price})});const data=await res.json().catch(()=>({}));if(!res.ok||!data.success)throw new Error(data.error||'Could not update Pond perk price.');toast(`${id} level ${Number(levelIndex)+1} price updated to ${price.toLocaleString('en-US')} Treasury.`,'success',{label:'Pond price updated'});await loadPondStatus();}catch(error){save.disabled=false;save.textContent='Save';toast(error?.message||'Could not update Pond perk price.','error',{label:'Price update failed'});}};
      input.focus(); input.select(); input.addEventListener('keydown',(e)=>{if(e.key==='Enter')wrap.querySelector('.shop-price-save').click();if(e.key==='Escape')restore();});
    }

    function updateShopCategoryBuyDots() {
      const state = window.__shopCategoryBuyable || {};
      document.querySelectorAll('.shop-category-tab').forEach((button) => {
        button.classList.toggle('has-buyable', !!state[button.dataset.shopCategory]);
      });
      // Shop nav dot: on when any shop category has something affordable.
      const anyBuyable = Object.values(state).some(Boolean);
      document.querySelectorAll('.hub-nav-btn[data-hub="shop"]').forEach((button) => {
        button.classList.toggle('has-buyable', anyBuyable);
      });
    }

    function updateShopCategoryVisibility(pondUnlocked) {
      const pondTab = document.querySelector('.shop-category-tab[data-shop-category=\"pond\"]');
      const pondPanel = document.getElementById('shopCategory-pond');
      const visible = !!pondUnlocked;
      if (pondTab) {
        pondTab.style.display = visible ? '' : 'none';
        pondTab.setAttribute('aria-hidden', visible ? 'false' : 'true');
        if (!visible) pondTab.setAttribute('tabindex', '-1');
        else pondTab.removeAttribute('tabindex');
      }
      if (pondPanel && !visible) {
        pondPanel.classList.remove('active');
      }
      if (!visible && window.__shopCategory === 'pond') {
        setShopCategory('normal');
      }
    }

    function setShopCategory(category) {
      const pondUnlocked = !!window.__pondLastStatus?.unlocked;
      const requested = ['normal', 'pond', 'gear'].includes(category) ? category : 'normal';
      const next = requested === 'pond' && !pondUnlocked ? 'normal' : requested;
      window.__shopCategory = next;
      document.querySelectorAll('.shop-category-tab').forEach((button) => {
        const active = button.dataset.shopCategory === next;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.shop-category-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `shopCategory-${next}`);
      });
      if (next === 'pond' && window.__pondLastStatus) renderPondTreasuryPerkShop(window.__pondLastStatus);
      // Gear is already rendered by loadProgression(). Re-rendering it here
      // creates a render loop because renderGear() restores the active shop
      // category at the end of its own render.
    }

    function setGearShopSection(section) {
      const next = section === 'bait' ? 'bait' : 'rods';
      window.__gearShopSection = next;
      document.querySelectorAll('.gear-shop-tab').forEach((button) => { const active = button.dataset.gearSection === next; button.classList.toggle('active', active); button.setAttribute('aria-selected', active ? 'true' : 'false'); });
      document.querySelectorAll('.gear-shop-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `gearShopPanel-${next}`));
    }

    function renderGear() {
      if (!progressionData) return;
      const rodGrid = document.getElementById('rodGrid');
      const baitGrid = document.getElementById('baitGrid');
      const balance = Number(progressionData.treasury || 0);
      const rod = progressionData.progression?.rod || progressionData.rods?.[0];
      const rods = progressionData.rods || [];
      const equippedIndex = Math.max(0, rods.findIndex(r => r.id === rod?.id));
      const equippedLabel = document.getElementById('equippedRodLabel'); if (equippedLabel) equippedLabel.textContent = rod?.name || 'Old Rod';
      if (rodGrid) rodGrid.innerHTML = rods.map((r, i) => {
        const owned = i <= equippedIndex;
        const equipped = r.id === rod?.id;
        const next = i === equippedIndex + 1;
        const price = Number(r.cost || 0);
        const status = equipped ? 'Current rod' : owned ? 'Previous tier' : 'Locked';
        const action = next
          ? `<button class="shop-item-cta" type="button" ${balance < price ? 'disabled' : ''} onclick="upgradeRod('${escText(r.id)}')">Upgrade</button>`
          : `<span class="achievement-status">${status}</span>`;
        return `<article class="shop-item-card shop-gear-card ${owned ? 'is-owned' : ''} ${equipped ? 'is-equipped' : ''}">
          <div class="shop-item-icon treasury-icon">${icon(r.icon)}</div>
          <div class="shop-item-name">${escText(r.name)}</div>
          <div class="shop-item-desc">${escText(r.desc)}</div>
          <div class="shop-item-status ${equipped ? '' : 'dim'}">${equipped ? 'Equipped · ' : ''}${escText(status)}</div>
          <div class="shop-item-footer"><span class="shop-item-price treasury-price">${priceMarkup('rods',r.id,price)}</span>${action}</div>
        </article>`;
      }).join('');
      const selected = progressionData.progression?.selectedBait?.id || 'worm';
      const baitCounts = progressionData.progression?.bait || {};
      if (baitGrid) baitGrid.innerHTML = (progressionData.baits || []).map(b => {
        const count = Number(baitCounts[b.id] || 0);
        const equipped = b.id === selected;
        const isBasic = b.id === 'worm';
        const packCost = Number(b.cost || 0);
        const packSize = Number(b.count || 0);
        const selectAction = equipped ? '<span class="gear-selected-label">Selected</span>' : `<button class="shop-item-cta gear-select-cta" type="button" onclick="selectBait('${escText(b.id)}')">Select</button>`;
        const buyAction = !isBasic ? `<button class="shop-item-cta" type="button" ${balance < packCost ? 'disabled' : ''} onclick="buyBait('${escText(b.id)}')">Buy pack</button>` : '';
        return `<article class="shop-item-card shop-gear-card ${equipped ? 'is-equipped' : ''}">
          <div class="shop-item-icon treasury-icon">${icon(b.icon)}</div>
          <div class="shop-item-name">${escText(b.name)}</div>
          <div class="shop-item-desc">${escText(b.desc)}</div>
          <div class="shop-item-status ${equipped ? '' : 'dim'}">${equipped ? 'Selected · ' : ''}${isBasic ? 'Unlimited basic bait' : `In stock · ${count}`}</div>
          <div class="shop-item-status dim">${isBasic ? 'Free' : `50 casts per pack · ${packCost.toLocaleString('en-US')} Treasury`}</div>
          <div class="shop-item-footer"><span class="shop-item-price treasury-price">${isBasic ? 'FREE' : priceMarkup('bait',b.id,packCost,' Treasury')}</span>${selectAction}${buyAction}</div>
        </article>`;
      }).join('');
      const selectedLabel = document.getElementById('selectedBaitLabel'); if (selectedLabel) selectedLabel.textContent = progressionData.progression?.selectedBait?.name || 'Worm Bait';
      setGearShopSection(window.__gearShopSection || 'rods');
      window.__shopCategoryBuyable = window.__shopCategoryBuyable || {};
      const rodNext = rods[equippedIndex + 1];
      const rodBuyable = !!rodNext && balance >= Number(rodNext.cost || 0);
      const baitBuyable = (progressionData.baits || []).some((b) => b.id !== 'worm' && balance >= Number(b.cost || 0));
      window.__shopCategoryBuyable.gear = rodBuyable || baitBuyable;
      updateShopCategoryBuyDots();
    }

    async function progressionPost(body) {
      const res = await fetch('/api/progression', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Progression update failed.');
      return data;
    }
    async function upgradeRod(rod) { await runPurchase('rod:' + rod, async () => { try { const data = await progressionPost({action:'upgrade-rod', rod}); toast(`${data.rod.name} equipped.`, 'success', {label:'Rod upgraded'}); refreshInBackground(() => loadProgression(true)); } catch(e) { toast(e.message,'error',{label:'Rod upgrade failed'}); } }); }
    async function selectBait(bait) { try { await progressionPost({action:'select-bait', bait}); await loadProgression(true); toast('Bait selected.', 'success', {label:'Bait selected'}); } catch(e) { toast(e.message,'error',{label:'Bait selection failed'}); } }
    async function buyBait(bait) { try { const data=await progressionPost({action:'buy-bait', bait, packs:1}); toast(data.message,'success',{label:'Bait purchased'}); await loadProgression(true); } catch(e) { toast(e.message,'error',{label:'Bait purchase failed'}); } }

    function renderAchievements() {
      if (!progressionData?.achievements) return;
      const grid=document.getElementById('achievementGrid'); if(!grid) return;
      const search=(document.getElementById('achievementSearch')?.value||'').toLowerCase().trim();
      const filter=document.getElementById('achievementFilter')?.value||'all';
      const all=progressionData.achievements;
      const done=all.filter(a=>a.unlocked).length;
      const percent=all.length?Math.round(done/all.length*100):0;
      const count=document.getElementById('achievementCount'); if(count) count.textContent=`${done}/${all.length}`;
      const pct=document.getElementById('achievementPercent'); if(pct) pct.textContent=`${percent}% complete`;
      const rows=all.filter(a=>{ const matchesSearch=!search||`${a.name} ${a.desc} ${a.reward}`.toLowerCase().includes(search); const matchesFilter=filter==='all'||(filter==='completed'?a.unlocked:!a.unlocked); return matchesSearch&&matchesFilter; });
      if(!rows.length){grid.innerHTML='<div class="state-message">No achievements match these filters.</div>';return;}
      grid.innerHTML=rows.map(a=>{const pct=Math.min(100,Math.round((a.progress/a.target)*100));return `<article class="achievement-card ${a.unlocked?'unlocked':'locked'}"><span class="achievement-rarity">${a.unlocked?'Completed':'In progress'}</span><div class="achievement-body"><div class="achievement-icon-wrap"><span class="achievement-icon">${icon(a.icon)}</span></div><div><div class="achievement-name">${escText(a.name)}</div><div class="achievement-status">${escText(a.desc)}</div></div></div><div class="achievement-progress"><div class="achievement-progress-top"><span>${a.progress.toLocaleString('en-US')} / ${a.target.toLocaleString('en-US')}</span><span>${pct}%</span></div><div class="achievement-progress-track"><div class="achievement-progress-fill" style="width:${pct}%"></div></div></div><div class="achievement-reward">Reward · ${escText(a.reward)}</div>${adminPenButton('achievement',a.id)}</article>`}).join('');
    }

    function renderTitles() {
      const grid=document.getElementById('titleGrid'); if(!grid||!progressionData) return;
      const titles=progressionData.titles||[]; const equipped=progressionData.equippedTitle ?? progressionData.progression?.title ?? '';
      const count=document.getElementById('titleCount'); if(count) count.textContent=`${titles.length} available`;
      const cards=['',...titles].filter((v,i,a)=>a.indexOf(v)===i).map(title=>{const label=title||'No Title'; const active=title===equipped; const custom=(progressionData.customTitles||[]).find(t=>t.name===title); const desc=custom?.description || (title==='Admin'?'Built-in administrator title.':title?'Achievement reward title.':'Hide your title while keeping your normal rank visible.'); const color=safeTitleColor((progressionData.titleStyles||{})[title]||custom?.color||''); const colorStyle=color?`style="color:${color}"`:''; return `<article class="title-card ${active?'is-equipped':''}"><div class="gear-head"><span class="gear-icon">${icon(title==='Admin'?'lock':'crown')}</span><span class="achievement-status">${active?'EQUIPPED':'AVAILABLE'}</span></div><div class="title-name" ${colorStyle}>${escText(label)}</div><div class="gear-desc">${escText(desc)}</div><button class="vault-tab-btn title-equip" type="button" onclick='equipTitle(${JSON.stringify(title).replace(/'/g, "&#39;")})'>${active?'Equipped':'Equip'}</button>${custom?adminPenButton('title',custom.id):''}</article>`});
      grid.innerHTML=cards.join('');
    }
    async function equipTitle(title){try{const data=await progressionPost({action:'equip-title',title});if(progressionData){progressionData.equippedTitle=data.equippedTitle??data.title??'';progressionData.progression={...(progressionData.progression||{}),title:progressionData.equippedTitle};}await loadProgression(true);renderTitles();renderCosmeticsPreview();cachedLeaderboardData=null;if(document.getElementById('leaderboard-view')?.classList.contains('active')) fetchLeaderboard(true);toast(data.equippedTitle?`Title equipped: ${data.equippedTitle}`:'Title hidden.','success',{label:'Title updated'});}catch(e){toast(e.message,'error',{label:'Title update failed'});}}
    function renderCosmetics() {
      const grid=document.getElementById('cosmeticGrid'); if(!grid||!progressionData)return;
      const all=progressionData.cosmetics||[]; const p=progressionData.progression||{}; const equipped=p.cosmetics||{};
      const search=(document.getElementById('cosmeticSearch')?.value||'').toLowerCase().trim(); const filter=document.getElementById('cosmeticFilter')?.value||'all';
      const titles=new Set(progressionData.titles||[]); const casts=Number(p.casts||0);
      const unlocked=(c)=>c.unlock==='Default'||(c.unlock==='100 casts'&&casts>=100)||(c.unlock==='500 casts'&&casts>=500)||titles.has(c.unlock);
      const rows=all.filter(c=>(filter==='all'||c.category===filter)&&(!search||`${c.name} ${c.desc} ${c.unlock}`.toLowerCase().includes(search)));
      const count=document.getElementById('cosmeticCount'); if(count) count.textContent=`${all.filter(unlocked).length} unlocked`;
      grid.innerHTML=rows.map(c=>{const ok=unlocked(c),active=equipped[c.category]===c.id;return `<article class="cosmetic-card ${active?'is-equipped':''} ${ok?'':'is-locked'}"><div class="cosmetic-head"><span class="gear-icon">${icon(c.icon)}</span><span class="cosmetic-category">${escText(c.category)}</span></div><div class="gear-name">${escText(c.name)}</div><div class="cosmetic-desc">${escText(c.desc)}</div><div class="achievement-status">${ok?(active?'Equipped':'Unlocked'):`Unlock · ${escText(c.unlock)}`}</div>${ok?`<button class="vault-tab-btn" type="button" onclick='equipCosmetic(${JSON.stringify(c.id)})'>${active?'Equipped':'Equip'}</button>`:''}</article>`}).join('');
    }
    async function equipCosmetic(cosmetic){try{const data=await progressionPost({action:'equip-cosmetic',cosmetic});if(progressionData?.progression&&data.cosmetic){progressionData.progression.cosmetics={...(progressionData.progression.cosmetics||{}),[data.cosmetic.category]:data.cosmetic.id};renderCosmetics();renderCosmeticsPreview();}await loadProgression(true);cachedLeaderboardData=null;if(document.getElementById('leaderboard-view')?.classList.contains('active')) fetchLeaderboard(true);toast(`${data.cosmetic?.name||'Cosmetic'} equipped.`, 'success',{label:'Cosmetics updated'});}catch(e){toast(e.message,'error',{label:'Cosmetic update failed'});}}
    function renderCosmeticsPreview(){
      if(!progressionData)return;
      const p=progressionData.progression||{}; const cosmetics=p.cosmetics||{}; const equippedTitle=progressionData.equippedTitle ?? p.title ?? '';
      const login=currentFishdexLogin||'yourangler'; const rank=document.getElementById('fishdexRankTag')?.textContent||'Angler';
      const progress=cachedFishdexData?fishdexIndexProgress(cachedFishdexData):{caught:0};
      const identity={username:login,title:equippedTitle,titleColor:(progressionData.titleStyles||{})[equippedTitle]||'',cosmetics};
      const identityEl=document.getElementById('cosmeticLeaderboardIdentity'); if(identityEl) identityEl.innerHTML=leaderboardIdentity(identity);
      const stat=document.getElementById('cosmeticPreviewStat'); if(stat) stat.textContent=`${Number(progress.caught||0).toLocaleString('en-US')} catches`;
      const rankEl=document.getElementById('cosmeticPreviewRank'); if(rankEl) rankEl.textContent=rank;
      const tag=document.getElementById('fishdexTitleTag');if(tag){tag.textContent=equippedTitle?`· ${equippedTitle}`:''; const tc=safeTitleColor((progressionData.titleStyles||{})[equippedTitle]||''); tag.style.color=tc||'';}
    }
    function masterAdminJump(section) {
      const adminView = document.getElementById('admin-view');
      const sections = document.querySelectorAll('#admin-view [data-admin-section]');
      const navButtons = document.querySelectorAll('#admin-view .masteradmin-nav-btn');
      const allowed = new Set(['stream', 'broadcasters', 'players', 'debug']);
      if (!allowed.has(section)) section = 'stream';

      navButtons.forEach(btn => {
        const active = btn.dataset.adminTarget === section;
        btn.classList.toggle('active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      });

      sections.forEach(el => {
        const active = el.dataset.adminSection === section;
        el.classList.toggle('is-active', active);
        el.hidden = !active;
        if (active) el.open = true;
      });

      // The audit rail is deliberately never hidden: it is the persistent
      // operational context for every MasterAdmin section.
      document.getElementById('adminAuditRail')?.classList.remove('is-hidden');
      adminView?.classList.remove('is-audit');
      requestAnimationFrame(() => {
        const target = document.querySelector(`#admin-view [data-admin-section="${section}"]`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    function initMasterAdminTabs() {
      const adminView = document.getElementById('admin-view');
      if (!adminView) return;
      masterAdminJump(adminView.querySelector('.masteradmin-nav-btn.active')?.dataset.adminTarget || 'stream');
    }

    function switchSettingsPanel(panel){document.querySelectorAll('.settings-nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.settings===panel));document.querySelectorAll('.settings-subpanel').forEach(p=>p.classList.toggle('active',p.id===`settingsPanel-${panel}`));if(panel==='chat')loadFishMessageSettings(true);if(panel==='cosmetics')loadProgression();}
    document.addEventListener('DOMContentLoaded', initMasterAdminTabs);

    /* ---------- !fish Message Settings ----------------------------------- */
    const FISH_FORMAT_DEFAULTS = {
      normalTemplate: '{user} cast their line and caught a {catch}{event}{boost}{double}{effect}',
      doubleTemplate: '{user} double catch! {catches}{double}{event}{boost}{effect}',
      showChance: true, showLuck: true, showArea: true, showNew: true,
      showEvent: true, showBoost: true, showDoubleChance: true
    };
    const FISH_FORMAT_TOKENS = ['{user}','{catch}','{catches}','{tier}','{chance}','{luck}','{luckIcon}','{area}','{new}','{event}','{boost}','{double}','{effect}'];
    const FISH_FORMAT_MAX_LENGTH = 100;
    let fishFormatSettings = { ...FISH_FORMAT_DEFAULTS };

    function renderFishFormatTokenButtons() {
      document.querySelectorAll('.fish-format-tokens').forEach((wrap) => {
        const target = wrap.dataset.target;
        wrap.innerHTML = FISH_FORMAT_TOKENS.map((token) => `<button type="button" class="fish-format-token" data-token="${token}" title="Insert ${token}">${token}</button>`).join('');
        wrap.querySelectorAll('.fish-format-token').forEach((btn) => btn.addEventListener('click', () => {
          const el = document.getElementById(target);
          if (!el) return;
          const token = btn.dataset.token;
          const tokenRegex = new RegExp(token.replace(/[{}]/g, '\\$&'), 'gi');
          if (tokenRegex.test(el.value)) {
            toast(`${token} can only be used once in this template.`, 'info', { label: 'Argument already used' });
            return;
          }
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? start;
          const next = el.value.slice(0, start) + token + el.value.slice(end);
          if (next.length > FISH_FORMAT_MAX_LENGTH) {
            toast(`Templates are limited to ${FISH_FORMAT_MAX_LENGTH} characters.`, 'info', { label: 'Template too long' });
            return;
          }
          el.value = next;
          el.focus();
          el.selectionStart = el.selectionEnd = start + token.length;
          updateFishFormatPreview();
        }));
      });
    }

    function validateFishFormatForm() {
      const fields = ['fishFormatNormal','fishFormatDouble'];
      for (const id of fields) {
        const el = document.getElementById(id);
        if (!el) continue;
        const value = String(el.value || '');
        if (value.length > FISH_FORMAT_MAX_LENGTH) {
          el.value = value.slice(0, FISH_FORMAT_MAX_LENGTH);
          toast(`Templates are limited to ${FISH_FORMAT_MAX_LENGTH} characters.`, 'error', { label: 'Template too long' });
          return false;
        }
        if (/[@＠﹫]/.test(value)) {
          el.value = value.replace(/[@＠﹫]/g, '');
          toast('Messages can\'t contain the "@" symbol.', 'error', { label: '@ not allowed' });
          el.focus();
          updateFishFormatPreview();
          return false;
        }
        const slash = /^\/(\S*)/.exec(value.trim());
        if (slash && slash[1].toLowerCase() !== 'me') {
          toast(`Messages can't start with a "/" command (/${slash[1]}). Only /me is allowed.`, 'error', { label: 'Command not allowed' });
          el.focus();
          return false;
        }
        const seen = new Set();
        const duplicates = [];
        const re = /\{(user|catch|catches|tier|chance|luck|luckIcon|area|new|event|boost|double|effect)\}/gi;
        for (const match of value.matchAll(re)) {
          const token = match[1].toLowerCase();
          if (seen.has(token)) duplicates.push(`{${token}}`);
          seen.add(token);
        }
        if (duplicates.length) {
          toast(`Each argument can only be used once. Duplicate: ${[...new Set(duplicates)].join(', ')}`, 'error', { label: 'Duplicate argument' });
          el.focus();
          return false;
        }
        const requiredToken = id === 'fishFormatNormal' ? '{catch}' : '{catches}';
        if (!new RegExp(requiredToken.replace(/[{}]/g, '\\$&'), 'i').test(value)) {
          toast(`${id === 'fishFormatNormal' ? 'Normal' : 'Double-catch'} messages must include ${requiredToken}.`, 'error', { label: 'Required argument missing' });
          el.focus();
          return false;
        }
      }
      return true;
    }

    function collectFishFormatSettings() {
      const get = (id) => document.getElementById(id);
      return {
        normalTemplate: get('fishFormatNormal')?.value || FISH_FORMAT_DEFAULTS.normalTemplate,
        doubleTemplate: get('fishFormatDouble')?.value || FISH_FORMAT_DEFAULTS.doubleTemplate,
        showChance: !!get('fishFormatShowChance')?.checked,
        showLuck: !!get('fishFormatShowLuck')?.checked,
        showArea: !!get('fishFormatShowArea')?.checked,
        showNew: !!get('fishFormatShowNew')?.checked,
        showEvent: !!get('fishFormatShowEvent')?.checked,
        showBoost: !!get('fishFormatShowBoost')?.checked,
        showDoubleChance: !!get('fishFormatShowDoubleChance')?.checked
      };
    }

    function setFishFormatForm(data) {
      fishFormatSettings = { ...FISH_FORMAT_DEFAULTS, ...(data || {}) };
      const get = (id) => document.getElementById(id);
      if (get('fishFormatNormal')) get('fishFormatNormal').value = fishFormatSettings.normalTemplate;
      if (get('fishFormatDouble')) get('fishFormatDouble').value = fishFormatSettings.doubleTemplate;
      ['Chance','Luck','Area','New','Event','Boost','DoubleChance'].forEach((name) => {
        const el = get(`fishFormatShow${name}`);
        if (el) el.checked = !!fishFormatSettings[`show${name}`];
      });
      updateFishFormatPreview();
    }

    function previewFishTemplate(template, doubleMode) {
      const values = {
        user: 'YourName',
        catch: '🐟 𝘚𝘯𝘢𝘱𝘱𝘦𝘳 [🐟 𝘜𝘕𝘊𝘖𝘔𝘔𝘖𝘕 | 25.0%] ☘️1.25x 📍🌲 Whispering Forest ✨ [NEW FISH DISCOVERED]',
        catches: '🐟 𝘚𝘯𝘢𝘱𝘱𝘦𝘳 [🐟 𝘜𝘕𝘊𝘖𝘔𝘔𝘖𝘕 | 25.0%] ☘️1.25x + 🦈 𝘎𝘳𝘦𝘢𝘵 𝘞𝘩𝘪𝘵𝘦 𝘚𝘩𝘢𝘳𝘬 [💎 𝘌𝘗𝘐𝘊 | 1.0%] ☘️1.25x',
        tier: '[🐟 𝘜𝘕𝘊𝘖𝘔𝘔𝘖𝘕 | 25.0%]', chance: '25.0%', luck: '1.25x', luckIcon: '☘️',
        area: ' 📍🌲 Whispering Forest', new: ' ✨ [NEW FISH DISCOVERED]', event: ' ⚡ Weekend Event (2x)',
        boost: ' 🎯 2x EPIC boost', double: doubleMode ? ' 🎣 DOUBLE CATCH Lv.3 (7% chance)' : ' 🎣 Double 7%', effect: ''
      };
      const lookup = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
      return String(template || '').replace(/\{(user|catch|catches|tier|chance|luck|luckIcon|area|new|event|boost|double|effect)\}/gi, (_, key) => lookup[key.toLowerCase()] ?? '').replace(/\s{2,}/g, ' ').trim();
    }

    function updateFishFormatPreview() {
      const settings = collectFishFormatSettings();
      const dEl = document.getElementById('fishFormatPreview');
      if (dEl) dEl.textContent = previewFishTemplate(settings.doubleTemplate || FISH_FORMAT_DEFAULTS.doubleTemplate, true);
      const nEl = document.getElementById('fishFormatPreviewNormal');
      if (nEl) nEl.textContent = previewFishTemplate(settings.normalTemplate || FISH_FORMAT_DEFAULTS.normalTemplate, false);
    }

    async function loadFishMessageSettings(silent = false) {
      if (!currentFishdexLogin) return;
      try {
        const res = await fetch('/api/fish-settings');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load message settings.');
        setFishFormatForm(data.settings || FISH_FORMAT_DEFAULTS);
        const status = document.getElementById('fishFormatSaveStatus');
        if (status) status.textContent = 'Saved';
        renderFishFormatTokenButtons();
      } catch (error) {
        if (!silent) toast(error?.message || 'Could not load message settings.', 'error', { label: 'Settings failed' });
      }
    }

    async function saveFishMessageSettings() {
      if (!validateFishFormatForm()) return;
      const settings = collectFishFormatSettings();
      const status = document.getElementById('fishFormatSaveStatus');
      if (status) status.textContent = 'Saving…';
      try {
        const res = await fetch('/api/fish-settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(settings) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save message settings.');
        setFishFormatForm(data.settings || settings);
        if (status) status.textContent = 'Saved';
        toast('Your !fish message format was saved.', 'success', { label: 'Settings saved' });
      } catch (error) {
        if (status) status.textContent = 'Not saved';
        toast(error?.message || 'Could not save message settings.', 'error', { label: 'Save failed' });
      }
    }

    function resetFishMessageSettings() {
      setFishFormatForm(FISH_FORMAT_DEFAULTS);
      toast('Default !fish message settings loaded. Click Save settings to apply them.', 'info', { label: 'Defaults ready' });
    }

    document.addEventListener('input', (event) => {
      const targetId = event.target?.id;
      if ((targetId === 'fishFormatNormal' || targetId === 'fishFormatDouble') && /[@＠﹫]/.test(event.target.value)) {
        const pos = event.target.selectionStart ?? event.target.value.length;
        const before = event.target.value.slice(0, pos).replace(/[@＠﹫]/g, '').length;
        event.target.value = event.target.value.replace(/[@＠﹫]/g, '');
        event.target.selectionStart = event.target.selectionEnd = before;
        toast('Messages can\'t contain the "@" symbol.', 'info', { label: '@ not allowed' });
      }
      if (targetId === 'fishFormatNormal' || targetId === 'fishFormatDouble' || targetId?.startsWith('fishFormatShow')) updateFishFormatPreview();
    });

    /* ---------- Fishing Areas --------------------------------------------- */
    let fishingAreasData = null;
    let fishingAreasRequestSeq = 0;

    const AREAS_CACHE_KEY = 'fishingHub.areasCache';
    function readAreasCache(login) {
      try {
        const entry = JSON.parse(localStorage.getItem(AREAS_CACHE_KEY) || 'null');
        return entry && entry.login === login ? entry.data : null;
      } catch (e) { return null; }
    }
    function saveAreasCache(login, data) {
      try { localStorage.setItem(AREAS_CACHE_KEY, JSON.stringify({ login, data })); } catch (e) {}
    }
    function showAreasSkeleton() {
      const grid = document.getElementById('fishingAreasGrid');
      if (!grid || grid.dataset.state === 'ready' || grid.children.length) return;
      grid.dataset.state = 'loading';
      grid.setAttribute('aria-busy', 'true');
      grid.setAttribute('aria-label', 'Loading fishing areas');
      grid.innerHTML = Array.from({ length: 3 }, () =>
        '<div class="area-skel" aria-hidden="true"><span class="skel-line w-40"></span><span class="skel-line w-80"></span><span class="skel-line w-60"></span></div>'
      ).join('');
    }
    async function loadFishingAreas(silent = true) {
      const login = currentFishdexLogin || guideStatus.login || '';
      if (!login) return;
      const grid = document.getElementById('fishingAreasGrid');
      if (!fishingAreasData) {
        const cached = readAreasCache(login);
        if (cached) {
          fishingAreasData = cached;
          renderFishingAreas(cached);
        } else {
          showAreasSkeleton();
        }
      }
      const seq = ++fishingAreasRequestSeq;
      try {
        const res = await fetch('/api/areas', { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load fishing areas.');
        if (seq !== fishingAreasRequestSeq) return;
        fishingAreasData = data;
        saveAreasCache(login, data);
        if (grid) { grid.removeAttribute('aria-busy'); grid.removeAttribute('aria-label'); grid.dataset.state = 'ready'; }
        renderFishingAreas(data);
      } catch (error) {
        if (grid && grid.dataset.state === 'loading') {
          grid.dataset.state = 'error';
          grid.removeAttribute('aria-busy');
          grid.innerHTML = '<div class="state-message">Areas could not load. Check your connection, then open this tab again.</div>';
        }
        if (!silent) toast(error?.message || 'Could not load fishing areas.', 'error', { label: 'Areas refresh failed' });
      }
    }

    function renderFishingAreas(data) {
      const grid = document.getElementById('fishingAreasGrid');
      if (!grid || !data) return;
      const balance = Number(data.treasury || 0);
      const balEl = document.getElementById('areasTreasuryBalance');
      if (balEl) balEl.textContent = `${balance} treasury item${balance === 1 ? '' : 's'}`;


      // The map shows every area, so the cards are only drawn when the map has failed to load.
      if (window.WorldMapBridge) WorldMapBridge.ensure();
      const showCards = !(window.WorldMapBridge && WorldMapBridge.showingMap());
      renderPanelHTML(grid, !showCards ? '' : (data.areas || []).map((area) => {
        const unlocked = !!area.unlocked;
        const maxed = area.level >= 5;
        const nextCost = unlocked ? area.levelCosts[area.level - 1] : area.unlockCost;
        const affordable = balance >= nextCost;
        const boostNames = Object.keys(area.boost || {});
        const boostText = boostNames.length ? `Boosts: ${boostNames.slice(0, 3).map((name) => `${name} (+${area.boost[name]})`).join(' · ')}` : '';
        const lootText = `${area.lootCount} specialized catches`;
        const disabled = area.enabled === false || data.areasEnabled === false;
        const iconSvg = icon(area.icon);
        // The tutorial owns the first Area card from the moment it appears.
        // That means the player can be guided through the initial unlock and
        // then the Level 1 -> 2 -> 3 upgrades without the target disappearing.
        // Once the map is live, the guide points at its pin instead of this card.
        const mapLive = !!(window.WorldMapBridge && WorldMapBridge.isLive());
        const tutorialAreaTarget = tutorialFlowActive && !mapLive && area.id === 'forest' && Number(area.level || 0) < 3;
        const areaGuideTip = unlocked
          ? 'Upgrade your first Area until it reaches Level 3. The tutorial stays on this card after every upgrade.'
          : 'Unlock your first Area here. After it unlocks, keep upgrading it until Level 3.';
        return `<article class="area-card ${unlocked ? '' : 'locked'} ${area.selected ? 'selected' : ''} ${tutorialAreaTarget ? 'tutorial-nav-target' : ''}" data-area="${escText(area.id)}" ${tutorialAreaTarget ? 'data-guide-target="first-area" data-guide-tip="' + escText(areaGuideTip) + '"' : ''}>
          <span class="tutorial-card-label" aria-hidden="true">TUTORIAL</span>
          <div class="area-card-head"><div class="area-icon">${iconSvg}</div><div><div class="area-name">${escText(area.name)}</div><div class="area-level">${disabled ? 'Disabled' : unlocked ? `Level ${area.level}/5` : 'Locked'}</div></div></div>
          <div class="area-desc">${escText(area.description)}</div>
          <div class="area-meta"><span>${disabled ? '<span class="area-disabled-badge">Unavailable</span>' : unlocked ? `${area.catchChance}% area-loot chance` : `Unlock: ${area.unlockCost} treasury`}</span><span>${area.selected ? (data.userAreasEnabled === false ? '<span class="area-disabled-badge">PAUSED</span>' : '<span class="area-selected-badge">ACTIVE</span>') : ''}</span></div>
          <div class="area-boost">${escText(boostText)}</div>
          <div class="area-loot"><button class="area-view-more" type="button" onclick='openAreaLootModal(${JSON.stringify(area.id)})'>... View more fish (${area.lootCount})</button></div>
          <div class="area-actions">
            ${disabled ? '<button class="shop-item-cta" type="button" disabled>Disabled</button>' : unlocked && !maxed ? `<button class="shop-item-cta" type="button" ${affordable ? '' : 'disabled'} onclick='buyFishingArea(${JSON.stringify(area.id)}, "upgrade")'>Upgrade · ${nextCost}</button>` : unlocked ? '<button class="shop-item-cta" type="button" disabled>Level 5</button>' : `<button class="shop-item-cta" type="button" ${affordable ? '' : 'disabled'} onclick='buyFishingArea(${JSON.stringify(area.id)}, "buy")'>Unlock · ${nextCost}</button>`}
            ${disabled ? '' : unlocked && !area.selected ? `<button class="shop-item-cta" type="button" onclick='selectFishingArea(${JSON.stringify(area.id)})'>Fish Here</button>` : unlocked ? `<button class="shop-item-cta" type="button" onclick='selectFishingArea(null)'>Stop fishing here</button>` : ''}
          </div>
        </article>`;
      }).join(''));
      // The guide's first-Area step is shown on the map: the map pin for that area is the highlighted target.
      const guideForest = tutorialFlowActive && (data.areas || []).some((a) => a.id === 'forest' && Number(a.level || 0) < 3);
      if (window.WorldMapBridge) WorldMapBridge.update(data, { tutorialAreaId: guideForest ? 'forest' : null });
      tutorialAfterRender();
    }

    const AREA_TIER_ORDER = ['SECRET', 'GODLY', 'LEGENDARY', 'EPIC', 'RARE', 'UNCOMMON', 'COMMON'];
    async function ensureAreaLoot() {
      const areas = fishingAreasData?.areas || [];
      if (areas.length && areas.every((item) => Array.isArray(item.loot))) return true;
      try {
        const res = await fetch('/api/areas?include=loot', { cache: 'no-store' });
        if (!res.ok) return false;
        fishingAreasData = await res.json();
        return true;
      } catch (e) { return false; }
    }
    async function openAreaLootModal(areaId) {
      if (!(await ensureAreaLoot())) { toast('Could not load the fish for this area. Try again.', 'error', { label: 'Area fish' }); return; }
      const area = (fishingAreasData?.areas || []).find((a) => a.id === areaId);
      if (!area) return;
      document.getElementById('areaLootModalTitle').innerHTML = `<span class="area-loot-head">${icon(area.icon)}<span>${escText(area.name)} Fish</span></span>`;
      document.getElementById('areaLootModalDesc').textContent = `${area.description} · ${area.lootCount} specialized catches. Rates are each fish's share of this area's own loot rolls.`;
      // Same weighting the server uses: boosted fish count for more.
      const weighted = (area.loot || []).map((item) => ({ ...item, w: Number(item.weight || 0) * (1 + Number((area.boost || {})[item.name] || 0) / 10) }));
      const total = weighted.reduce((sum, item) => sum + item.w, 0) || 1;
      const rank = (t) => { const i = AREA_TIER_ORDER.indexOf(String(t).toUpperCase()); return i < 0 ? 99 : i; };
      weighted.sort((a, b) => rank(a.tier) - rank(b.tier) || b.w - a.w || a.name.localeCompare(b.name));
      document.getElementById('areaLootModalList').innerHTML = weighted.map((item) => {
        const key = String(item.tier || 'common').toLowerCase();
        const pct = (item.w / total) * 100;
        const color = `var(--tier-${escText(key)}-hi, var(--tier-${escText(key)}, var(--bone)))`;
        return `<div class="area-loot-row" style="--rc:${color}"><span class="area-loot-name">${escText(item.name)}</span><span class="area-loot-right"><span class="area-loot-tier">${escText(item.tier)}</span><span class="area-loot-rate">${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%</span></span></div>`;
      }).join('');
      document.getElementById('areaLootModal').classList.add('active');
    }
    function closeAreaLootModal() { document.getElementById('areaLootModal').classList.remove('active'); }

    async function buyFishingArea(areaId, action) {
      await runPurchase('area:' + areaId, () => buyFishingAreaNow(areaId, action));
    }
    async function buyFishingAreaNow(areaId, action) {
      try {
        const res = await fetch('/api/areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, areaId }) });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not update the fishing area.');
        toast(data.message || 'Fishing area updated.', 'success', { label: action === 'buy' ? 'Area unlocked' : 'Area upgraded' });
        // Refresh the visible Areas panel immediately. License/perk checks are
        // independent of the purchase and should not hold the unlock UI open.
        loadFishingAreas(false);
        if (tutorialFlowActive && cachedFishdexData?.user?.login) {
          const tutorialStateNow = tutorialState(cachedFishdexData.user.login);
          if (tutorialStateNow.treasuryTutorialDone) {
            const areaNow = (fishingAreasData?.areas || []).find((a) => a.id === 'forest') || (fishingAreasData?.areas || [])[0];
            if (Number(areaNow?.level || 0) >= 3) {
              clearTutorialHint();
              showAutoFishTutorialStep();
            } else if (areaNow) {
              rebindTutorialHintTarget('first-area', false);
              updateAreasTutorialStep(areaNow, { scroll:false });
            }
          }
        }
        // Re-check Fishy's Area Level 3 license gate in the background.
        // These requests must not delay the completed area purchase.
        Promise.allSettled([
          loadPerksStatus(),
          typeof loadAutoFishStatus === 'function' ? loadAutoFishStatus(true) : Promise.resolve()
        ]);
      } catch (error) {
        toast(error?.message || 'Could not update the fishing area.', 'error', { label: 'Area purchase failed' });
        void Promise.resolve().then(() => loadFishingAreas(true)).catch(() => {});
      }
    }

    async function toggleAreaFeature(action, enabled) {
      try {
        const res = await fetch('/api/areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, enabled: !!enabled }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not save that setting.');
        toast(data.message || 'Saved.', 'success', { label: action === 'toggleDouble' ? 'Double Catch' : 'Fishing areas' });
      } catch (error) {
        toast(error?.message || 'Could not save that setting.', 'error', { label: 'Setting not saved' });
      }
      await loadFishingAreas(true);
    }

    async function selectFishingArea(areaId) {
      try {
        const res = await fetch('/api/areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'select', areaId }) });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not select the fishing area.');
        toast(data.message || 'Fishing location changed.', 'success', { label: 'Fishing area changed' });
        await loadFishingAreas(false);
      } catch (error) {
        toast(error?.message || 'Could not select the fishing area.', 'error', { label: 'Area not changed' });
      }
    }


    /* Re-rendering must not move the reader. These helpers keep every scroll
       position and skip the DOM swap entirely when nothing changed. */
    function renderPanelHTML(container, html) {
      if (!container) return false;
      if (container.__renderedHtml === html) return false;
      const winX = window.scrollX;
      const winY = window.scrollY;
      const saved = [];
      container.querySelectorAll('*').forEach((el, i) => {
        if (el.scrollTop || el.scrollLeft) saved.push({ i, tag: el.tagName, cls: el.className, t: el.scrollTop, l: el.scrollLeft });
      });
      container.innerHTML = html;
      container.__renderedHtml = html;
      const next = container.querySelectorAll('*');
      saved.forEach((s) => {
        const el = next[s.i];
        if (el && el.tagName === s.tag && el.className === s.cls) { el.scrollTop = s.t; el.scrollLeft = s.l; }
      });
      if (window.scrollX !== winX || window.scrollY !== winY) window.scrollTo(winX, winY);
      return true;
    }

    // For changes that move existing nodes (appendChild between grids) rather than replacing markup.
    function keepScrollPositions(fn) {
      const saved = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.scrollTop || el.scrollLeft) saved.push([el, el.scrollTop, el.scrollLeft]);
      });
      const winX = window.scrollX;
      const winY = window.scrollY;
      const result = fn();
      saved.forEach(([el, t, l]) => { el.scrollTop = t; el.scrollLeft = l; });
      if (window.scrollX !== winX || window.scrollY !== winY) window.scrollTo(winX, winY);
      return result;
    }

    // Fisherman's Fortune: level bar and the bonus it currently gives this viewer.
    function renderFortuneDetail(fortune) {
      const el = document.getElementById('shopFortuneDetail');
      if (!el) return;
      if (!fortune || !fortune.owned) { el.hidden = true; el.innerHTML = ''; return; }
      const level = Number(fortune.level) || 0;
      const maxLevel = Number(fortune.maxLevel) || 10;
      const catches = Number(fortune.catches?.total) || 0;
      const nextAt = fortune.nextAt;
      const pct = Math.max(0, Math.min(100, Number(fortune.percent) || 0));
      const levelLabel = level >= maxLevel ? `Level ${level} · MAX` : `Level ${level} / ${maxLevel}`;
      const toNext = nextAt
        ? `${Math.max(0, Number(nextAt) - catches).toLocaleString('en-US')} catches to Level ${level + 1}`
        : 'Maximum level reached';
      const bonus = fortune.active
        ? `<span>+${(Number(fortune.luckAdd) || 0).toFixed(2)}x luck</span><span>Uncaught fish ×${(Number(fortune.uncaughtWeightMultiplier) || 1).toFixed(2)} weight</span>`
        : `<span class="dim">Turned off. Switch it on to apply your bonus.</span>`;
      el.hidden = false;
      el.innerHTML = `
        <div class="fortune-level-row"><b>${levelLabel}</b><span>${toNext}</span></div>
        <div class="progress-bar-track fortune-level-bar" role="progressbar" aria-label="Fisherman's Fortune level progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <div class="fortune-bonus-row">${bonus}</div>`;
    }

    /* ---------- Treasury Shop (buy perks with treasury catches) ---------- */
    // Most shop perks are permanent, one-time purchases. 2x Rarity Luck is
    // reusable: each purchase lasts 15 minutes, then returns to the Shop for
    // another 25-treasury purchase. While active it can still be toggled on/off.
    function renderTreasuryShop(data) {
      const balance = (data.treasury && data.treasury.balance) || 0;
      window.__lastTreasuryBalance = Number(balance);
      const shop = data.shop || {};
      document.getElementById('treasuryBalance').innerHTML = statusHTML('coin-stack', `${balance} treasury item${balance === 1 ? '' : 's'} to spend`);

      const shopGrid = document.getElementById('treasuryShopGrid');
      const ownedGrid = document.getElementById('ownedShopGrid');
      let anyOwned = false;
      let anyUnowned = false;

      ['luck125', 'cooldown', 'treasuryLuck', 'treasuryOnly', 'fishermansFortune'].forEach((id) => {
        const item = shop[id] || {};
        const card = document.getElementById(`shopCard_${id}`);
        const btn = document.getElementById(`shopBuy_${id}`);
        const status = document.getElementById(`shopStatus_${id}`);
        document.getElementById(`shopPrice_${id}`).innerHTML = id === 'treasuryOnly' ? `${Number(item.unlockCatches || 25)} manual catches` : priceMarkup('shop', id, item.cost, ' treasury');
        if (item.owned) {
          anyOwned = true;
          if (card) ownedGrid.appendChild(card);
          btn.disabled = true;
          btn.textContent = 'Owned';
          setupPerkToggleRow(`shopToggleRow_${id}`, `shopToggle_${id}`, item.toggleOn);
          status.className = 'shop-item-status';
          status.innerHTML = item.toggleOn
            ? statusHTML('check', 'Owned, active')
            : statusHTML('pause', 'Owned, currently turned off');
        } else {
          // Treasury Only Mode always lives in Perks, never the Shop.
          if (id !== 'treasuryOnly') anyUnowned = true;
          if (card) (id === 'treasuryOnly' ? ownedGrid : shopGrid).appendChild(card);
          const row = document.getElementById(`shopToggleRow_${id}`);
          if (row) row.style.display = 'none';
          if (id === 'treasuryOnly') {
            const catches = Number(item.manualCatches || 0);
            const required = Number(item.unlockCatches || 25);
            btn.disabled = true;
            btn.textContent = `${catches}/${required} catches`;
            status.className = 'shop-item-status dim';
            status.textContent = `Unlocks automatically at ${required} lifetime manual catches`;
          } else {
            btn.disabled = balance < item.cost;
            btn.textContent = 'Buy';
            status.className = 'shop-item-status dim';
            status.textContent = balance < item.cost ? `Need ${item.cost - balance} more treasury` : 'Ready to buy';
          }
        }
      });

      renderFortuneDetail(data.fortune);

      // --- 2x Rarity Luck: each purchase lasts 15 minutes, then can be
      // purchased again for 25 treasury (and may target a new rarity). ---
      const boost = shop.rarityBoost || {};
      const boostCard = document.getElementById('shopCard_rarityBoost');
      const boostBtn = document.getElementById('shopBuy_rarityBoost');
      const boostStatus = document.getElementById('shopStatus_rarityBoost');
      const select = document.getElementById('shopRaritySelect');
      document.getElementById('shopPrice_rarityBoost').innerHTML = priceMarkup('shop', 'rarityBoost', boost.cost, ' treasury');
      select.disabled = false;
      if (rarityBoostShopCountdownTimer) {
        clearInterval(rarityBoostShopCountdownTimer);
        rarityBoostShopCountdownTimer = null;
      }
      if (boost.owned) {
        anyOwned = true;
        if (boostCard) ownedGrid.appendChild(boostCard);
        if (boost.rarity) select.value = boost.rarity;
        select.disabled = true;
        boostBtn.disabled = true;
        boostBtn.textContent = 'Active';
        setupPerkToggleRow('shopToggleRow_rarityBoost', 'shopToggle_rarityBoost', boost.toggleOn);
        boostStatus.className = 'shop-item-status';
        const mins = Math.ceil((boost.remainingSeconds || 0) / 60);
        boostStatus.innerHTML = boost.toggleOn
          ? statusHTML('target', `Active, boosting ${(boost.rarity || '').toUpperCase()} · ~${mins}m left`)
          : statusHTML('pause', `Active, turned off · ~${mins}m left`);
        let remaining = Math.max(0, Number(boost.remainingSeconds) || 0);
        rarityBoostDisplayedRemaining = remaining;
        const tickRarityBoost = () => {
          if (remaining <= 0) {
            clearInterval(rarityBoostShopCountdownTimer);
            rarityBoostShopCountdownTimer = null;
            loadPerksStatus();
            return;
          }
          rarityBoostDisplayedRemaining = remaining;
          const minsLeft = Math.floor(remaining / 60);
          const secsLeft = remaining % 60;
          const timeLabel = `${minsLeft}m ${String(secsLeft).padStart(2, '0')}s`;
          boostStatus.innerHTML = boost.toggleOn
            ? statusHTML('target', `Active, boosting ${(boost.rarity || '').toUpperCase()} · ${timeLabel} left`)
            : statusHTML('pause', `Paused · ${(boost.rarity || '').toUpperCase()} · ${timeLabel} remaining`);
          if (boost.toggleOn) remaining--;
        };
        tickRarityBoost();
        if (boost.toggleOn) rarityBoostShopCountdownTimer = setInterval(tickRarityBoost, 1000);
      } else {
        anyUnowned = true;
        if (boostCard) shopGrid.appendChild(boostCard);
        const row = document.getElementById('shopToggleRow_rarityBoost');
        if (row) row.style.display = 'none';
        select.disabled = false;
        boostBtn.disabled = balance < boost.cost;
        boostBtn.textContent = 'Buy';
        boostStatus.className = 'shop-item-status dim';
        boostStatus.textContent = balance < boost.cost ? `Need ${boost.cost - balance} more treasury` : 'Ready to buy for 15 min';
      }

      window.__shopCategoryBuyable = window.__shopCategoryBuyable || {};
      window.__shopCategoryBuyable.normal = ['luck125','cooldown','treasuryLuck'].some((id) => { const item = shop[id] || {}; return !item.owned && balance >= Number(item.cost || 0); }) || (boost && !boost.owned && balance >= Number(boost.cost || 0));
      updateShopCategoryBuyDots();

      const emptyState = document.getElementById('shopEmptyState');
      if (emptyState) emptyState.style.display = anyUnowned ? 'none' : 'block';
      const ownedDivider = document.getElementById('ownedShopDivider');
      if (ownedDivider) ownedDivider.style.display = anyOwned ? 'block' : 'none';
    }

    // Human-readable name for a shop item, read straight off its card so the
    // purchase message always matches the label the player clicked.
    function shopItemName(id) {
      const el = document.querySelector(`#shopCard_${id} .shop-item-name`);
      return (el && el.textContent.trim()) || id;
    }

    function editShopPrice(category, id, currentPrice) {
      if (!isAdminLoggedIn || !authToken) return;
      const buttons = document.querySelectorAll(`.shop-price-edit[data-price-category="${CSS.escape(category)}"][data-price-id="${CSS.escape(id)}"]`);
      const button = Array.from(buttons).find((el) => el.closest('.shop-price-editor'));
      const wrap = button?.closest('.shop-price-editor');
      if (!wrap) return;
      wrap.innerHTML = `<input class="shop-price-input" type="number" min="0" max="1000000000" step="1" value="${Number(currentPrice)}" aria-label="New price"><button class="shop-price-save" type="button">Save</button><button class="shop-price-cancel" type="button">Cancel</button>`;
      const input = wrap.querySelector('.shop-price-input');
      const restore = () => { wrap.outerHTML = priceMarkup(category, id, currentPrice, category === 'shop' ? ' treasury' : category === 'bait' ? ' Treasury / pack' : ' Treasury'); };
      wrap.querySelector('.shop-price-cancel').onclick = restore;
      wrap.querySelector('.shop-price-save').onclick = async () => {
        const price = Number(input.value);
        if (!Number.isInteger(price) || price < 0 || price > 1000000000) {
          toast('Enter a whole number from 0 to 1,000,000,000.', 'error', { label: 'Invalid price' });
          return;
        }
        const save = wrap.querySelector('.shop-price-save');
        save.disabled = true; save.textContent = '…';
        try {
          const res = await fetch('/api/admin/action', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`}, body:JSON.stringify({action:'shop-price',category,id,price}) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) throw new Error(data.error || 'Could not update price.');
          toast(`${id} price updated to ${price.toLocaleString('en-US')} Treasury.`, 'success', { label:'Price updated' });
          await Promise.all([loadPerksStatus(), loadProgression(true)]);
        } catch (error) {
          save.disabled = false; save.textContent = 'Save';
          toast(error?.message || 'Could not update price.', 'error', { label:'Price update failed' });
        }
      };
      input.focus(); input.select();
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') wrap.querySelector('.shop-price-save').click(); if (event.key === 'Escape') restore(); });
    }

    async function buyShopItem(id) {
      const btn = document.getElementById(`shopBuy_${id}`);
      const body = { buy: id };
      if (id === 'rarityBoost') body.rarity = document.getElementById('shopRaritySelect').value;
      // Capture the name before the card gets relocated to the Perks tab.
      const label = shopItemName(id);
      btn.disabled = true;
      btn.textContent = 'Buying…';
      try {
        const res = await fetch('/api/perks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || !data || !data.success) {
          showFeedback(
            (data && data.error) || `The server refused the purchase (HTTP ${res.status}).`,
            'error',
            'shopFeedback',
            { label: 'Purchase failed' }
          );
          return;
        }
        // Refresh the live trading inventory too. A Treasury purchase changes
        // the same spendable inventory used by Trading, so an already-open
        // Trading panel must not keep showing the spent catches.
        if (tradingReceiverUser && typeof loadTradingPlayers === 'function') {
          loadTradingPlayers().catch(() => {});
        }

        // Use the backend message if provided, otherwise fall back to our own.
        const backendMsg = data.message ? ` ${data.message}` : '';
        const left = typeof data.balance === 'number'
          ? `${data.balance} treasury item${data.balance === 1 ? '' : 's'} left.`
          : '';
        const duration = id === 'rarityBoost' ? ' Active for 15 minutes.' : '';
        showFeedback(
          `Bought ${label}.${duration}${left ? ' ' + left : ''}${backendMsg}`,
          'success',
          'shopFeedback',
          { label: `Bought ${label}` }
        );
      } catch (err) {
        // A parse failure here means the server answered with something
        // this page cannot read, usually an HTML error page from a proxy or
        // an unhandled throw. "Could not reach the server" would be wrong:
        // it was reached, and it broke.
        showFeedback(
          'The server sent a reply this page could not read. Nothing was charged. Try again.',
          'error',
          'shopFeedback',
          { label: 'Purchase failed', ttl: 7000 }
        );
      } finally {
        // Always re-sync: this is what moves the card into the Perks tab,
        // restores the button label, and reveals the toggle switch.
        void Promise.resolve().then(() => loadPerksStatus()).catch(() => {});
        if (tutorialFlowActive && id === 'treasuryOnly') {
          const toggle = document.getElementById('shopToggle_treasuryOnly');
          if (toggle && !toggle.checked) {
            // Unlocking never turns Treasury Only on by itself; the tutorial
            // continues to point at the switch until the player opts in.
            showTreasuryTutorialStep();
          }
        }
      }
    }

    const PERK_DISPLAY_NAMES = {
      permLuck: '1.5x Permanent Luck',
      shield: 'Shieldfish',
      vip: 'Vipfish',
      event: 'Global Luck Event',
      temp2x: '2x Luck (temporary)',
      rarityBoost: '2x Rarity Luck',
      luck125: '1.25x Luck',
      cooldown: 'Cooldown Bypass',
      treasuryLuck: '1.5x Treasury Luck',
      treasuryOnly: 'Treasury Only',
      'pond:treasuryWaters': 'Treasury Waters',
      'perm': '1.5x Permanent Luck',
      'temp': '2x Luck (10 min)',
      'pond:speciesHunter': 'Species Hunter',
      'pond:baitSaver': 'Bait Saver',
      'pond:collectorInstinct': "Collector's Instinct",
      'pond:stillWaters': 'Still Waters',
      'pond:deepCurrent': 'Deep Current',
      'pond:biggerHaul': 'Bigger Haul',
      'pond:fishyFortune': 'Fishy Fortune'
    };

    function perkDisplayName(id) {
      return PERK_DISPLAY_NAMES[id] || id;
    }

    function renderChannelPerk(perk) {
      const card = document.getElementById('channelPerkCard');
      if (!card) return;
      card.hidden = false;
      const title = document.getElementById('channelPerkTitle');
      const list = document.getElementById('channelPerkList');
      const toggle = document.getElementById('channelPerkToggle');
      if (!perk || !perk.channel) {
        if (title) title.textContent = 'No channel selected';
        if (list) list.textContent = 'Pick a streamer on your Profile to get their channel perks.';
        if (toggle) { toggle.disabled = true; toggle.checked = false; }
        card.classList.add('is-off');
        return;
      }
      if (title) title.textContent = `@${perk.channel}`;
      if (toggle) { toggle.disabled = false; toggle.checked = !!perk.enabled; }
      card.classList.toggle('is-off', !perk.enabled);
      const active = (perk.upgrades || []).filter((u) => u.level > 0);
      if (list) {
        list.innerHTML = active.length
          ? active.map((u) => `<span class="channel-perk-chip">${escText(u.name)} ${escText(u.effect)}</span>`).join('')
          : '<span class="channel-perk-empty">This channel has no upgrades yet.</span>';
      }
    }

    async function toggleChannelPerk(enabled) {
      if (!currentFishdexLogin) {
        toast('Log in with Twitch before changing perks.', 'error', { label: 'Not logged in' });
        return;
      }
      try {
        const res = await fetch('/api/perks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ perk: 'channelPerk', enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not change the channel perk.');
        toast(`${enabled ? 'Channel perk on' : 'Channel perk off'} for @${data.channel}.`, 'success', { label: 'Channel perk' });
        refreshInBackground(() => loadPerksStatus());
      } catch (err) {
        toast(err.message || 'Could not change the channel perk.', 'error', { label: 'Channel perk' });
        refreshInBackground(() => loadPerksStatus());
      }
    }

    async function togglePerk(perk, enabled) {
      if (!currentFishdexLogin) {
        toast('Log in with Twitch before changing perks.', 'error', { label: 'Not logged in' });
        return;
      }

      const name = perkDisplayName(perk);

      // Freeze the visible countdown immediately when the user switches a
      // timed perk off. This avoids waiting for the POST + GET round-trip and
      // makes the website behave exactly like the server-side paused state.
      if (!enabled && perk === 'temp') {
        if (perkTempCountdownTimer) {
          clearInterval(perkTempCountdownTimer);
          perkTempCountdownTimer = null;
        }
        const statusEl = document.getElementById('perkTempStatus');
        const remaining = Math.max(0, Number(perkTempDisplayedRemaining) || 0);
        if (statusEl && remaining > 0) {
          const mins = Math.floor(remaining / 60);
          const secs = remaining % 60;
          statusEl.className = 'shop-item-status dim';
          statusEl.textContent = `⏸ Paused · ${mins}m ${secs}s remaining on your 2x Luck`;
        }
      } else if (!enabled && perk === 'rarityBoost') {
        if (rarityBoostShopCountdownTimer) {
          clearInterval(rarityBoostShopCountdownTimer);
          rarityBoostShopCountdownTimer = null;
        }
        const statusEl = document.getElementById('shopStatus_rarityBoost');
        const select = document.getElementById('shopRaritySelect');
        const remaining = Math.max(0, Number(rarityBoostDisplayedRemaining) || 0);
        const rarity = select ? String(select.value || '').toUpperCase() : '';
        if (statusEl && remaining > 0) {
          const mins = Math.floor(remaining / 60);
          const secs = remaining % 60;
          statusEl.className = 'shop-item-status';
          statusEl.innerHTML = statusHTML('pause', `Paused · ${rarity} · ${mins}m ${String(secs).padStart(2, '0')}s remaining`);
        }
      }

      try {
        const res = await fetch('/api/perks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ perk, enabled })
        });
        const data = await res.json();

        if (!res.ok || !data || !data.success) {
          showFeedback(
            (data && data.error) || `The server refused to ${enabled ? 'enable' : 'disable'} ${name}.`,
            'error',
            'shopFeedback',
            { label: 'Toggle not saved' }
          );
          loadPerksStatus();
          return;
        }

        toast(
          `${name} is now ${enabled ? 'on' : 'off'}.${data.message ? ' ' + stripChatGlyphs(data.message) : ''}`,
          'success',
          { label: enabled ? 'Perk enabled' : 'Perk disabled' }
        );
        // Treasury Only's successful POST is already authoritative. Advance
        // the tutorial immediately instead of waiting for the full Perks GET.
        const tutorialTreasuryEnable = tutorialFlowActive && perk === 'treasuryOnly' && enabled;
        if (tutorialTreasuryEnable) {
          const login = cachedFishdexData?.user?.login || currentFishdexLogin || tutorialStateLogin;
          if (login) {
            const state = tutorialState(login);
            state.tutorialStage = 'areas';
            state.treasuryTutorialDone = true;
            writeTutorialState(login, state);
          }
          clearTutorialHint();
          showAreasTutorialStep();
          loadPerksStatus();
        } else {
          await loadPerksStatus();
          if (String(perk).startsWith('pond:')) await loadPondStatus();
        }
      } catch (err) {
        showFeedback(
          `Could not save the ${name} toggle. ${(err && err.message) || 'Network error'}`,
          'error',
          'shopFeedback',
          { label: 'Toggle not saved' }
        );
        loadPerksStatus();
      }
    }

    /* ---------- Custom dropdown widget (wraps a native <select> for full styling control) ---------- */
    const customSelectPanels = {}; // selectId -> panel element (portaled to <body> so it's never clipped)

    function buildCustomSelect(selectId) {
      const select = document.getElementById(selectId);
      const wrapper = select ? select.closest('.custom-select-wrapper') : null;
      if (!select || !wrapper) return;

      select.style.display = 'none';

      if (!wrapper.querySelector('.custom-select-trigger')) {
        const trigger = document.createElement('div');
        trigger.className = 'custom-select-trigger';
        trigger.innerHTML = `<span class="custom-select-label"></span>
          <svg class="custom-select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleCustomSelect(selectId);
        });
        wrapper.appendChild(trigger);
      }

      if (!customSelectPanels[selectId]) {
        const panel = document.createElement('div');
        panel.className = 'custom-select-panel';
        panel.id = `panel-${selectId}`;
        document.body.appendChild(panel);
        customSelectPanels[selectId] = panel;
      }

      refreshCustomSelect(selectId);
    }

    function refreshCustomSelect(selectId) {
      const select = document.getElementById(selectId);
      const wrapper = select ? select.closest('.custom-select-wrapper') : null;
      const panel = customSelectPanels[selectId];
      if (!wrapper || !panel) return;

      const label = wrapper.querySelector('.custom-select-label');
      if (!label) return;

      panel.innerHTML = '';
      Array.from(select.options).forEach(opt => {
        const optDiv = document.createElement('div');
        optDiv.className = 'custom-select-option' + (opt.value === select.value ? ' selected' : '');
        optDiv.textContent = opt.textContent;
        optDiv.addEventListener('click', (e) => {
          e.stopPropagation();
          select.value = opt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          closeCustomSelect(selectId);
          refreshCustomSelect(selectId);
        });
        panel.appendChild(optDiv);
      });

      const selectedOption = select.options[select.selectedIndex];
      label.textContent = selectedOption ? selectedOption.textContent : '';
    }

    // Positions the (body-level) panel against its trigger, flipping upward if there isn't room below.
    function positionCustomSelectPanel(selectId) {
      const select = document.getElementById(selectId);
      const wrapper = select ? select.closest('.custom-select-wrapper') : null;
      const trigger = wrapper ? wrapper.querySelector('.custom-select-trigger') : null;
      const panel = customSelectPanels[selectId];
      if (!trigger || !panel) return;

      const rect = trigger.getBoundingClientRect();
      const panelMaxHeight = 260;
      const spaceBelow = window.innerHeight - rect.bottom;

      panel.style.left = `${Math.max(8, rect.left)}px`;
      panel.style.width = `${rect.width}px`;

      if (spaceBelow < panelMaxHeight + 16 && rect.top > panelMaxHeight + 16) {
        panel.style.top = 'auto';
        panel.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      } else {
        panel.style.bottom = 'auto';
        panel.style.top = `${rect.bottom + 8}px`;
      }
    }

    function toggleCustomSelect(selectId) {
      const wrapper = document.getElementById(selectId)?.closest('.custom-select-wrapper');
      const panel = customSelectPanels[selectId];
      if (!wrapper || !panel) return;

      const isOpen = wrapper.classList.contains('open');
      closeAllCustomSelects();
      if (!isOpen) {
        wrapper.classList.add('open');
        panel.classList.add('open');
        positionCustomSelectPanel(selectId);
      }
    }

    function closeCustomSelect(selectId) {
      const wrapper = document.getElementById(selectId)?.closest('.custom-select-wrapper');
      const panel = customSelectPanels[selectId];
      if (wrapper) wrapper.classList.remove('open');
      if (panel) panel.classList.remove('open');
    }

    function closeAllCustomSelects() {
      Object.keys(customSelectPanels).forEach(closeCustomSelect);
    }

    function repositionOpenCustomSelects() {
      Object.keys(customSelectPanels).forEach(selectId => {
        const wrapper = document.getElementById(selectId)?.closest('.custom-select-wrapper');
        if (wrapper && wrapper.classList.contains('open')) {
          positionCustomSelectPanel(selectId);
        }
      });
    }

    document.addEventListener('click', closeAllCustomSelects);
    window.addEventListener('resize', closeAllCustomSelects);
    window.addEventListener('scroll', repositionOpenCustomSelects, true);

    /* ---------- Global card mode toggle (Luck Event <-> Cooldown) ---------- */
    function setGlobalCardMode(mode) {
      const luckContent = document.getElementById('globalLuckModeContent');
      const cooldownContent = document.getElementById('globalCooldownModeContent');
      const luckBtn = document.getElementById('modeBtnLuck');
      const cooldownBtn = document.getElementById('modeBtnCooldown');
      const title = document.getElementById('luckCardTitle');
      const desc = document.getElementById('luckCardDesc');

      if (mode === 'cooldown') {
        luckContent.style.display = 'none';
        cooldownContent.style.display = 'flex';
        luckBtn.classList.remove('active');
        cooldownBtn.classList.add('active');
        title.textContent = 'Fishing Cooldown Settings';
        desc.textContent = 'Set how long viewers must wait between !fish casts.';
      } else {
        cooldownContent.style.display = 'none';
        luckContent.style.display = 'flex';
        cooldownBtn.classList.remove('active');
        luckBtn.classList.add('active');
        title.textContent = 'Global Stream Luck Event';
        desc.textContent = 'Trigger a server-wide luck boost for all viewers casting !fish.';
      }
    }

    /* The setcooldown / setluck endpoints were built for chat, so their success
       strings arrive with a leading emoji and casual phrasing. Strip the
       glyph and rewrite the wording so the dashboard reads as itself. */
    function stripChatGlyphs(text) {
      return String(text || '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu, '')
        .replace(/^\s*[-–—:]\s*/, '')
        .trim();
    }

    function clearBroadcasterAdminForm() {
      ['adminBroadcasterChannel', 'adminBroadcasterTwitchLogin', 'adminBroadcasterPassword'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      const enabled = document.getElementById('adminBroadcasterEnabled');
      if (enabled) enabled.checked = true;
      const save = document.getElementById('adminBroadcasterSaveBtn');
      const channel = document.getElementById('adminBroadcasterChannel');
      if (channel) channel.disabled = false;
      if (save) { save.dataset.editChannel = ''; save.textContent = 'Create / update account'; }
    }

    /* ---------- Broadcaster overwrite (MasterAdmin) ---------- */
    let bcPermissionLabels = {};

    function bcDenied(permission) {
      return Array.isArray(window.__bcDenied) && window.__bcDenied.includes(permission);
    }

    // Broadcaster panel: disable what MasterAdmin has turned off for this channel.
    function applyBroadcasterDenials() {
      const note = document.getElementById('badminDenyNote');
      const cooldownBtn = document.getElementById('badminCooldownBtn');
      const cooldownInput = document.getElementById('badminCooldown');
      const simpleChat = document.getElementById('badminSimpleChat');
      const eventBtn = document.getElementById('badminStartEventBtn');
      const deleteBtn = document.getElementById('badminDeleteBtn');
      const set = (el, off, reason) => {
        if (!el) return;
        el.disabled = off;
        el.title = off ? reason : '';
      };
      const reason = 'Turned off by MasterAdmin';
      set(cooldownBtn, bcDenied('cooldown'), reason);
      set(cooldownInput, bcDenied('cooldown'), reason);
      set(simpleChat, bcDenied('simpleChat'), reason);
      set(eventBtn, bcDenied('luckEvent'), reason);
      set(deleteBtn, bcDenied('inventoryDelete'), reason);
      if (note) note.hidden = !(window.__bcDenied || []).length;
    }

    async function adminPost(body) {
      const res = await fetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || 'Request failed.');
      return data;
    }

    function bcPermissionRow(channel, id, label, denied) {
      return `<div class="bc-perm">
        <span class="bc-perm-label">${escText(label)}</span>
        <span class="bc-perm-state ${denied ? 'is-denied' : ''}">${denied ? 'Denied' : 'Allowed'}</span>
        <label class="perk-switch" title="${denied ? 'Allow' : 'Deny'} ${escText(label)}">
          <input type="checkbox" ${denied ? '' : 'checked'} onchange="setBroadcasterPermission('${escText(channel)}', '${escText(id)}', !this.checked)">
          <span class="perk-switch-slider"></span>
        </label>
      </div>`;
    }

    async function loadBroadcasterOverview() {
      const list = document.getElementById('bcOverwriteList');
      if (!list || !authToken) return;
      try {
        const data = await adminPost({ action: 'broadcaster-overview' });
        bcPermissionLabels = data.permissions || {};
        if (!data.rows?.length) {
          list.innerHTML = '<div class="admin-card-desc">No broadcaster accounts yet. Create one in Channel settings below.</div>';
          return;
        }
        list.innerHTML = data.rows.map((row) => `
          <div class="bc-row">
            <div class="bc-row-head">
              <div class="bc-row-copy">
                <strong>@${escText(row.channel)}</strong>
                <span class="micro-label">${row.enabled ? 'Account on' : 'Account off'}</span>
                <div class="admin-card-desc">Cooldown ${row.streamCooldown === null ? `system default (${Number(row.systemDefaultCooldown ?? 60)}s)` : `${Number(row.streamCooldown)}s`} · ${Number(row.points).toLocaleString()} points · ${Number(row.catches).toLocaleString()} catches</div>
              </div>
              <button class="dex-toolbar-btn" type="button" onclick="inspectBroadcaster('${escText(row.channel)}')">Debug</button>
            </div>
            <div class="bc-perms">
              ${Object.entries(data.permissions || {}).map(([id, label]) => bcPermissionRow(row.channel, id, label, row.denied.includes(id))).join('')}
            </div>
          </div>`).join('');
      } catch (err) {
        list.innerHTML = `<div class="admin-card-desc">${escText(err.message || 'Could not load broadcasters.')}</div>`;
      }
    }

    async function setBroadcasterPermission(channel, permission, denied) {
      try {
        await adminPost({ action: 'broadcaster-permission-set', channel, permission, denied });
        toast(`${denied ? 'Denied' : 'Allowed'} for @${channel}.`, 'success', { label: 'Broadcaster overwrite' });
      } catch (err) {
        toast(err.message || 'Could not change the permission.', 'error', { label: 'Broadcaster overwrite' });
      }
      refreshInBackground(() => loadBroadcasterOverview());
    }

    function inspectBroadcaster(channel) {
      const input = document.getElementById('bcDebugChannel');
      if (input) input.value = channel;
      loadBroadcasterDebug();
      document.getElementById('bcDebugCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function loadBroadcasterDebug() {
      const channel = (document.getElementById('bcDebugChannel')?.value || '').trim().replace(/^@/, '').toLowerCase();
      const result = document.getElementById('bcDebugResult');
      if (!result) return;
      if (!/^[a-z0-9_]{1,25}$/.test(channel)) {
        result.innerHTML = '<div class="admin-card-desc">Enter a valid Twitch channel name.</div>';
        return;
      }
      result.innerHTML = '<div class="admin-card-desc">Loading…</div>';
      try {
        const d = await adminPost({ action: 'broadcaster-debug', channel });
        const p = d.progress || {};
        const fmt = (n) => Number(n || 0).toLocaleString();
        const levels = Object.entries(p.levels || {}).map(([id, lv]) => `${escText(d.upgradeNames?.[id] || id)} ${Number(lv)}/3`).join(' · ');
        const denied = (d.denied || []).map((id) => escText(bcPermissionLabels[id] || id));
        const event = d.channelEvent
          ? `${escText(d.channelEvent.name || 'Channel event')} · ${Number(d.channelEvent.multiplier)}x${d.channelEvent.expiresAt ? ` · ends ${new Date(d.channelEvent.expiresAt).toLocaleString()}` : ''}`
          : 'None';
        const casts = (d.recentCasts || []).map((c) => `
          <div class="bc-cast">
            <span>${new Date(c.at).toLocaleTimeString()}</span>
            <span>${escText(c.user || '?')}</span>
            <span class="bc-cast-points">+${fmt(c.points)} pts</span>
            <span>${escText((c.items || []).join(', ') || 'Mud')}</span>
          </div>`).join('');
        const test = d.testData
          ? `<div class="bc-debug-test"><span>Test data: ${Number(d.testData.names?.length || 0)} viewers, ${fmt(d.testData.points)} points, ${fmt(d.testData.catches)} catches.</span>
             <button class="danger-btn" type="button" onclick="clearBroadcasterTestData('${escText(channel)}')">Clear test data</button></div>`
          : '';
        result.innerHTML = `
          <div class="bc-debug-grid">
            <div><span class="micro-label">Community catches</span><strong>${fmt(p.catches)}</strong></div>
            <div><span class="micro-label">Points earned</span><strong>${fmt(p.points)}</strong></div>
            <div><span class="micro-label">Points spent</span><strong>${fmt(p.spent)}</strong></div>
            <div><span class="micro-label">Points available</span><strong>${fmt(p.available)}</strong></div>
            <div><span class="micro-label">Cooldown</span><strong>${Number(d.cooldown)}s</strong></div>
            <div><span class="micro-label">Simple chat</span><strong>${d.simpleChat ? 'On' : 'Off'}</strong></div>
            <div><span class="micro-label">Viewers with perk off</span><strong>${fmt(d.viewersPerkOff)}</strong></div>
          </div>
          <div class="bc-debug-line"><span class="micro-label">Upgrade levels</span> ${levels}</div>
          <div class="bc-debug-line"><span class="micro-label">Active event</span> ${event}</div>
          <div class="bc-debug-line"><span class="micro-label">Denied</span> ${denied.length ? denied.join(', ') : 'Nothing denied'}</div>
          ${test}
          <div class="bc-debug-line"><span class="micro-label">Last ${(d.recentCasts || []).length} casts</span></div>
          <div class="bc-casts">${casts || '<div class="admin-card-desc">No casts recorded yet.</div>'}</div>`;
      } catch (err) {
        result.innerHTML = `<div class="admin-card-desc">${escText(err.message || 'Could not load the debug data.')}</div>`;
      }
    }

    async function clearBroadcasterTestData(channel) {
      if (!window.confirm(`Remove the test viewers and their points from @${channel}? Real players are not touched.`)) return;
      try {
        const d = await adminPost({ action: 'broadcaster-debug-clear-test', channel });
        toast(`Removed ${d.removed} test viewers from @${channel}.`, 'success', { label: 'Debug' });
      } catch (err) {
        toast(err.message || 'Could not clear the test data.', 'error', { label: 'Debug' });
      }
      loadBroadcasterDebug();
    }

    async function loadBroadcasterAdminAccounts() {
      loadBroadcasterOverview().catch(() => {});
      const list = document.getElementById('broadcasterAdminAccountsList');
      if (!list || !authToken) return;
      list.innerHTML = '<div class="admin-card-desc">Loading broadcaster accounts…</div>';
      try {
        const res = await fetch('/api/admin/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ action: 'list-broadcaster-admins' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not load broadcaster accounts.');
        if (!data.accounts?.length) {
          list.innerHTML = '<div class="admin-card-desc">No broadcaster Admin accounts yet. Create the first one above.</div>';
          return;
        }
        window._broadcasterAdminAccounts = data.accounts || [];
        list.innerHTML = window._broadcasterAdminAccounts.map(account => `
          <div class="admin-list-row" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--bone-12);">
            <div style="flex:1;min-width:0;"><strong>@${escapeHtml(account.channel)}</strong><div class="admin-card-desc">Twitch login: @${escapeHtml(account.twitchLogin)} · ${account.enabled ? 'Enabled' : 'Disabled'}</div></div>
            <button class="dex-toolbar-btn" type="button" data-broadcaster-edit="${escapeHtml(account.channel)}">Edit</button>
            <button class="danger-btn" type="button" data-broadcaster-remove="${escapeHtml(account.channel)}">Remove</button>
          </div>`).join('');
        list.querySelectorAll('[data-broadcaster-edit]').forEach(btn => btn.addEventListener('click', () => editBroadcasterAdminAccountByChannel(btn.dataset.broadcasterEdit)));
        list.querySelectorAll('[data-broadcaster-remove]').forEach(btn => btn.addEventListener('click', () => deleteBroadcasterAdminAccount(btn.dataset.broadcasterRemove)));
      } catch (e) {
        list.innerHTML = `<div class="error-msg" style="display:block;">${escapeHtml(e.message || 'Could not load broadcaster accounts.')}</div>`;
      }
    }

    function editBroadcasterAdminAccountByChannel(channel) {
      const account = (window._broadcasterAdminAccounts || []).find(item => item.channel === channel);
      if (account) editBroadcasterAdminAccount(account);
    }

    function editBroadcasterAdminAccount(account) {
      document.getElementById('adminBroadcasterChannel').value = account.channel || '';
      document.getElementById('adminBroadcasterTwitchLogin').value = account.twitchLogin || account.channel || '';
      document.getElementById('adminBroadcasterPassword').value = '';
      document.getElementById('adminBroadcasterEnabled').checked = account.enabled !== false;
      const save = document.getElementById('adminBroadcasterSaveBtn');
      save.dataset.editChannel = account.channel || '';
      document.getElementById('adminBroadcasterChannel').disabled = true;
      save.textContent = 'Save account';
      document.getElementById('adminBroadcasterChannel')?.focus();
    }

    async function saveBroadcasterAdminAccount() {
      const channel = String(document.getElementById('adminBroadcasterChannel')?.value || '').trim().toLowerCase().replace(/^@/, '');
      const twitchLogin = String(document.getElementById('adminBroadcasterTwitchLogin')?.value || channel).trim().toLowerCase().replace(/^@/, '');
      const password = String(document.getElementById('adminBroadcasterPassword')?.value || '');
      const enabled = !!document.getElementById('adminBroadcasterEnabled')?.checked;
      const save = document.getElementById('adminBroadcasterSaveBtn');
      const editing = !!save?.dataset.editChannel;
      if (!/^[a-z0-9_]{1,25}$/.test(channel) || !/^[a-z0-9_]{1,25}$/.test(twitchLogin)) {
        showFeedback('Enter valid Twitch usernames.', 'error', 'adminFeedback'); return;
      }
      if (!editing && password.length < 8) {
        showFeedback('New broadcaster Admin passwords must be at least 8 characters.', 'error', 'adminFeedback'); return;
      }
      if (save) save.disabled = true;
      try {
        const res = await fetch('/api/admin/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ action: editing ? 'update-broadcaster-admin' : 'create-broadcaster-admin', channel, twitchLogin, password, enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not save broadcaster Admin account.');
        showFeedback(`@${channel} broadcaster Admin account saved.`, 'success', 'adminFeedback', { label: 'Broadcaster Admin updated' });
        clearBroadcasterAdminForm();
        await loadBroadcasterAdminAccounts();
      } catch (e) {
        showFeedback(e.message || 'Could not save broadcaster Admin account.', 'error', 'adminFeedback');
      } finally {
        if (save) save.disabled = false;
      }
    }

    async function deleteBroadcasterAdminAccount(channel) {
      if (!confirm(`Remove Broadcaster Admin access for @${channel}?`)) return;
      try {
        const res = await fetch('/api/admin/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ action: 'delete-broadcaster-admin', channel })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not remove the broadcaster Admin account.');
        clearBroadcasterAdminForm();
        await loadBroadcasterAdminAccounts();
        showFeedback(`@${channel} no longer has Broadcaster Admin access.`, 'success', 'adminFeedback', { label: 'Access removed' });
      } catch (e) {
        showFeedback(e.message || 'Could not remove the broadcaster Admin account.', 'error', 'adminFeedback');
      }
    }

    async function updateStreamCooldown() {
      const channelEl = document.getElementById('adminStreamCooldownChannel');
      const secondsEl = document.getElementById('adminStreamCooldownSeconds');
      const btn = document.getElementById('adminStreamCooldownBtn');
      const channel = String(channelEl?.value || '').trim().toLowerCase().replace(/^@/, '');
      const seconds = Number(secondsEl?.value);
      if (!/^[a-z0-9_]{1,25}$/.test(channel)) {
        showFeedback('Enter a valid Twitch broadcaster username.', 'error', 'adminFeedback');
        return;
      }
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
        showFeedback('Enter a stream cooldown from 0 to 86400 seconds.', 'error', 'adminFeedback');
        return;
      }
      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/api/admin/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            action: 'set-stream-cooldown',
            channel,
            seconds: Math.round(seconds)
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'The stream cooldown was not changed.');
        const cooldownLabel = Number(data.cooldown) > 0
          ? `${Number(data.cooldown)}s`
          : `the system default (${Number(data.systemDefaultCooldown ?? 60)}s)`;
        showFeedback(`@${channel} now uses ${cooldownLabel} fishing cooldown.`, 'success', 'adminFeedback', { label: 'Stream cooldown updated' });
      } catch (e) {
        showFeedback(e.message || 'The stream cooldown was not changed.', 'error', 'adminFeedback', { label: 'Cooldown not changed' });
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function updateGlobalCooldown() {
      const input = document.getElementById('adminCooldownInput');
      const seconds = parseInt(input.value, 10);
      if (isNaN(seconds) || seconds < 0) {
        showFeedback('Enter a cooldown in whole seconds, zero or greater.', 'error');
        return;
      }

      const btn = document.getElementById('adminCooldownBtn');
      if (btn) btn.disabled = true;

      try {
        const res = await fetch(`/api/setcooldown?seconds=${seconds}`, {
          headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
        });
        const raw = stripChatGlyphs(await res.text());

        // The endpoint reports failures inside a 200 body, so a resolved fetch
        // proves nothing on its own. Only the wording is trustworthy.
        const looksLikeFailure = !res.ok || /error|usage|invalid|not connected|missing/i.test(raw);

        if (looksLikeFailure) {
          showFeedback(raw || 'The server rejected the cooldown change.', 'error', 'adminFeedback', {
            label: 'Cooldown not changed'
          });
          return;
        }

        showFeedback(
          seconds === 0
            ? 'Cooldown removed. Every angler can cast again immediately.'
            : `Cooldown set to ${seconds} second${seconds === 1 ? '' : 's'} between casts.`,
          'success',
          'adminFeedback',
          { label: 'Cooldown updated' }
        );

        const tile = document.getElementById('statusCooldownTile');
        if (tile) tile.innerHTML = `${seconds}<small>s</small>`;
        checkGlobalEventStatus();
      } catch (err) {
        showFeedback('Could not reach the cooldown endpoint.', 'error', 'adminFeedback', {
          label: 'Cooldown not changed'
        });
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    /* ---------- Diagnostics refresh for the wide status card ---------- */
    function formatBytes(bytes) {
      if (bytes === null || bytes === undefined || isNaN(bytes)) return '--';
      const gb = bytes / (1024 ** 3);
      if (gb >= 1) return `${gb.toFixed(1)} GB`;
      return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
    }

    // manual = true when the operator presses Refresh. Routine reads (opening
    // the tab) stay quiet; a failure always shows, because it needs attention.
    async function refreshDiagnostics(manual = false) {
      const syncTile = document.getElementById('statusSyncTile');
      if (syncTile) {
        syncTile.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      await checkGlobalEventStatus();

      const dbBadge = document.getElementById('statusDbBadge');
      const memTile = document.getElementById('statusMemTile');
      const memSub = document.getElementById('statusMemSub');
      const diskTile = document.getElementById('statusDiskTile');
      const diskSub = document.getElementById('statusDiskSub');

      try {
        const res = await fetch('/api/admin-tools?tool=diagnostics', {
          headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
        });
        const data = await res.json();

        if (dbBadge) {
          dbBadge.innerHTML = data.dbConnected
            ? '<span class="status-dot"></span> Connected'
            : '<span class="status-dot"></span> Not connected';
          dbBadge.classList.toggle('operational', !!data.dbConnected);
        }
        if (data.metricsAvailable) {
          if (memTile) {
            memTile.innerHTML = data.memory.percent !== null ? `${data.memory.percent.toFixed(1)}<small>%</small>` : '--<small>%</small>';
            if (memSub) memSub.textContent = `${formatBytes(data.memory.usedBytes)} / ${formatBytes(data.memory.totalBytes)}`;
          }
          if (diskTile) {
            diskTile.innerHTML = data.disk.percent !== null ? `${data.disk.percent.toFixed(1)}<small>%</small>` : '--<small>%</small>';
            if (diskSub) diskSub.textContent = `${formatBytes(data.disk.usedBytes)} / ${formatBytes(data.disk.totalBytes)}`;
          }
        } else {
          // Metrics API isn't reachable (e.g. not available in this local edition
          // build) - show that plainly instead of a stale/fake number.
          if (memTile) memTile.innerHTML = 'N/A';
          if (diskTile) diskTile.innerHTML = 'N/A';
          if (memSub) memSub.textContent = 'Metrics API unavailable';
          if (diskSub) diskSub.textContent = 'Metrics API unavailable';
        }

        // The summary has to agree with the badges above it. Reporting a
        // clean sync while the database status says "Not connected" is worse
        // than saying nothing, because an operator stops looking.
        if (!res.ok) {
          showFeedback(`Diagnostics read failed (HTTP ${res.status}).`, 'error', 'adminFeedback', { label: 'Diagnostics' });
        } else if (!data.dbConnected) {
          showFeedback('Diagnostics reached the server, but Local database is not connected.', 'error', 'adminFeedback', { label: 'Diagnostics' });
        } else if (!data.metricsAvailable) {
          showFeedback('The local database is connected. Host metrics are not exposed by this endpoint.', 'info', 'adminFeedback', { label: 'Diagnostics', quiet: !manual });
        } else {
          showFeedback('Local diagnostics read.', 'success', 'adminFeedback', { label: 'Diagnostics', quiet: !manual });
        }
      } catch (err) {
        if (dbBadge) {
          dbBadge.innerHTML = '<span class="status-dot"></span> Unknown';
          dbBadge.classList.remove('operational');
        }
        showFeedback('Could not reach diagnostics endpoint.', 'error');
      }
    }

    async function initApp() {
      bindLeaderboardScrollHooks();
      // The server's tier endpoint is a static copy of the same canonical
      // table used by !fish; it is a local application data file. Start with the bundled
      // copy so the page always renders, then quietly replace it if the API is
      // reachable. An API hiccup on initial page load should not look like a
      // database failure to the user.
      baseTiers = defaultTiersConfig;
      try {
        const response = await fetch('/api/fish?action=tiers', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Server responded ${response.status}`);
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
          baseTiers = data;
        }
      } catch (err) {
        console.warn('[Fish Hub] Live tier endpoint unavailable; using bundled tier table.', err);
      }
      renderLootTable();
      loadViewerOdds();
      checkGlobalEventStatus();
      buildCustomSelect('adminEventDurationUnit');
      buildCustomSelect('adminCustomTitleSelect');
      buildCustomSelect('adminGlobalAchievementType');
      buildCustomSelect('wipeRaritySelect');
      buildCustomSelect('perkGiftRarity');
      buildCustomSelect('adminAreaLevel');
      buildCustomSelect('bovMinTier');
      buildCustomSelect('bovSoundId');
      buildCustomSelect('bovPreviewTier');
      buildCustomSelect('bovPointsGoal');

      // Validate existing admin session on page load
      const sessionValid = await validateAdminSession();
      if (sessionValid) {
        startAdminAuditFeed();
      }

      // If we just came back from a Twitch login redirect, jump straight to the Fish Index tab
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('view') === 'fishdex') {
        switchView('fishdex');
        window.history.replaceState({}, '', window.location.pathname);
      }

      const syncTile = document.getElementById('statusSyncTile');
      if (syncTile) syncTile.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    async function refreshLootTable() {
      const icon = document.getElementById('lootRefreshIcon');
      const btn = document.getElementById('lootRefreshBtn');
      if (icon) icon.classList.add('spin');
      if (btn) btn.disabled = true;

      const startedAt = performance.now();

      try {
        const response = await fetch('/api/fish?action=tiers');
        if (!response.ok) throw new Error(`Server responded ${response.status}`);
        const data = await response.json();

        if (!Array.isArray(data) || data.length === 0) {
          throw new Error('The local database returned an empty loot table.');
        }

        baseTiers = data;
        renderLootTable();

        // Keep whatever the filter box already had. Silently clearing it would
        // look like the table lost most of its rows.
        const items = data.reduce((sum, t) => sum + (t.items ? t.items.length : 0), 0);
        toast(
          `${data.length} tiers, ${items} fish, refreshed from the local database in ${Math.round(performance.now() - startedAt)} ms.`,
          'success',
          { label: 'Loot table refreshed' }
        );
      } catch (err) {
        // Keep the last known-good table on screen. Overwriting it with the
        // hardcoded fallback would show stale default odds as if they were live.
        renderLootTable();
        showFeedback(
          `Could not refresh the loot table, so the previous odds are still shown. ${(err && err.message) || 'Unknown error'}`,
          'error',
          'adminFeedback',
          { label: 'Loot table not refreshed', ttl: 8000 }
        );
      } finally {
        if (icon) icon.classList.remove('spin');
        if (btn) btn.disabled = false;
      }
    }

    function switchView(viewName) {
      if (viewName === 'admin' && !isAdminLoggedIn) return;

      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.view-panel').forEach(panel => panel.classList.remove('active'));

      if (viewName === 'loottable') {
        document.querySelectorAll('.tab-btn')[0].classList.add('active');
        document.getElementById('loottable-view').classList.add('active');
        loadViewerOdds();
      } else if (viewName === 'leaderboard') {
        document.querySelectorAll('.tab-btn')[1].classList.add('active');
        document.getElementById('leaderboard-view').classList.add('active');
        
        if (!cachedLeaderboardData) fetchLeaderboard();

        if (!window.leaderboardInterval) {
          window.leaderboardInterval = setInterval(() => {
            if (document.getElementById('leaderboard-view').classList.contains('active')) {
              fetchLeaderboard(false);
            }
          }, 30000);
        }
      } else if (viewName === 'admin') {
        document.getElementById('adminTabBtn').classList.add('active');
        document.getElementById('admin-view').classList.add('active');
        refreshDiagnostics();
        startAdminAuditFeed();
        loadAdminCustomTitles();
        loadAdminGlobalAchievements();
      } else if (viewName === 'fishdex') {
        document.getElementById('fishdexTabBtn').classList.add('active');
        document.getElementById('fishdex-view').classList.add('active');
        // The World Map is the default hub. Perks is a building popup on the map, not a full tab.
        switchHubTab('areas');
        loadFishdexView();
      } else if (viewName === 'guide') {
        openGuideModal();
      }
    }

    // Used by the Perks Shop cards on the My Fish Index tab to jump to the
    // Loot Table view with the matching item already searched for.
    function viewInLootTable(query) {
      switchView('loottable');
      const searchBox = document.getElementById('searchInput');
      if (searchBox) {
        searchBox.value = query;
        renderLootTable();
        searchBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    function switchSubTab(subTabName) {
      document.querySelectorAll('.sub-tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.sub-panel').forEach(panel => panel.classList.remove('active'));

      if (subTabName === 'catches') {
        document.querySelectorAll('.sub-tab-btn')[0].classList.add('active');
        document.getElementById('lb-catches').classList.add('active');
      } else {
        document.querySelectorAll('.sub-tab-btn')[1].classList.add('active');
        document.getElementById('lb-rares').classList.add('active');
      }

      // The same pager controls whichever leaderboard is visible.
      renderLeaderboards();
    }

    function toggleAccordion(index) {
      const detailRow = document.getElementById(`detail-${index}`);
      if (detailRow) {
        const opening = !detailRow.classList.contains('open');
        detailRow.classList.toggle('open', opening);
        if (opening) {
          openAccordions.add(index);
          // Build the expensive vault contents only when the user actually
          // opens a row. Hidden rows should not consume layout/DOM work.
          renderBestCatchShowcase(index);
          refreshVaultGrid(index);
        } else {
          openAccordions.delete(index);
        }
      }
    }

    function updateLuckDisplay() {
      const val = parseFloat(document.getElementById('luckInput').value) || 1.0;
      document.getElementById('luckValue').textContent = val.toFixed(1) + 'x';
      renderLootTable();
    }

    function resetLuck() {
      document.getElementById('luckInput').value = '1.0';
      updateLuckDisplay();
    }

    /* The colophon under the wordmark. Counts the live table rather than a
       hardcoded list, and swaps to the filtered count while a search is
       active so the number never describes something the user cannot see.
       Luck is deliberately not written here: it is a Profile fact, set by
       updateUserLuckDisplay from the logged-in user's real perks. */
    function updateMastheadMeta(mult, searchQuery) {
      const listed = baseTiers.filter(t => t.id !== 'unique');
      const totalItems = listed.reduce((n, t) => n + t.items.length, 0);
      const shownItems = searchQuery
        ? listed.reduce((n, t) => n + t.items.filter(i => i.toLowerCase().includes(searchQuery)).length, 0)
        : totalItems;

      const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
      };
      set('metaItemCount', searchQuery ? `${shownItems}/${totalItems}` : String(totalItems));
      set('metaTierCount', String(listed.length));
    }

    // Per-viewer odds. Fortune adds luck for the logged-in viewer only, so the
    // table is rebuilt from /api/perks?check=fortuneOdds after login or a change.
    let viewerOdds = null;
    let lastTierPcts = {};

    function viewerLuckAdd() {
      return viewerOdds && viewerOdds.fortune && viewerOdds.fortune.active
        ? Number(viewerOdds.fortune.luckAdd) || 0
        : 0;
    }

    // Used by the item hover: chance per cast for a tier at the current luck, times the item's share of the tier.
    window.__fishChancePerCast = (tierId, withinCategory) => {
      const pct = lastTierPcts[tierId];
      return pct == null ? null : pct * withinCategory;
    };

    async function loadViewerOdds() {
      try {
        const res = await fetch('/api/perks?check=fortuneOdds', { cache: 'no-store' });
        viewerOdds = res.ok ? await res.json() : null;
      } catch (err) {
        viewerOdds = null;
      }
      if (typeof window.setLiveFishWeights === 'function') {
        window.setLiveFishWeights(viewerOdds && Array.isArray(viewerOdds.tiers) ? viewerOdds.tiers : window.__FISH_LIVE_WEIGHTS__);
      }
      renderLootTable();
    }

    function renderLootTable() {
      const mult = parseFloat(document.getElementById('luckInput').value) || 1.0;
      const luckAdd = viewerLuckAdd();
      const effectiveMult = mult + luckAdd;
      const searchQuery = document.getElementById('searchInput').value.toLowerCase().trim();
      const container = document.getElementById('tiers-container');
      const noResults = document.getElementById('noResults');

      container.innerHTML = '';
      let usedChance = 0;
      let totalVisibleItems = 0;
      lastTierPcts = {};

      updateMastheadMeta(mult, searchQuery);

      baseTiers.forEach(tier => {
        if (tier.id === 'unique') return;

        let currentPct = 0;
        if (tier.luckImmune) {
          currentPct = tier.basePct.toFixed(1);
        } else if (tier.isCommon) {
          currentPct = Math.max(0, 100 - usedChance).toFixed(2);
        } else {
          currentPct = (tier.basePct * effectiveMult).toFixed(tier.id === 'godly' ? 3 : 2);
          usedChance += parseFloat(currentPct);
        }
        lastTierPcts[tier.id] = parseFloat(currentPct);

        const matchingItems = tier.items.filter(item => item.toLowerCase().includes(searchQuery));

        if (matchingItems.length > 0) {
          totalVisibleItems += matchingItems.length;
          const card = document.createElement('div');
          card.className = `tier-card ${tier.id}`;

          const itemsHtml = tier.items.map(item => {
            const isMatch = item.toLowerCase().includes(searchQuery);
            if (!isMatch && searchQuery !== '') return '';
            const highlightClass = searchQuery !== '' ? 'highlight' : '';
            // The rarity mark is the tier's own icon, not a generic bullet, so
            // the item rows carry the same visual language as the slab above.
            const mark = icon(TIER_ICON[tier.id] || 'fish', 'ic--sm');
            return `<span class="item-pill ${highlightClass}">
              ${mark}
              <span class="item-name">${escText(item)}</span>
            </span>`;
          }).join('');

          const tierMark = icon(TIER_ICON[tier.id] || 'fish');
          // How many of this tier are actually listed. Useful, and it is the
          // one number the header was missing.
          const listed = searchQuery ? matchingItems.length : tier.items.length;
          const total = tier.items.length;
          const countNote = searchQuery && listed !== total
            ? `<span class="tier-count tier-count--filtered">${listed} of ${total}</span>`
            : `<span class="tier-count">${total}</span>`;

          card.innerHTML = `
            <div class="tier-header">
              <span class="tier-name">${tierMark}${escText(tier.name)}<small class="tier-count-suffix">fish</small></span>
              <span class="tier-pct" title="${luckAdd > 0 ? `Chance per cast at ${mult}x luck + ${luckAdd.toFixed(2)}x Fortune` : `Chance per cast at ${mult}x luck`}">${currentPct}<small>%</small></span>
            </div>
            <div class="tier-countbar">${countNote}<span class="tier-count-label">${searchQuery && listed !== total ? 'matching' : 'in this tier'}</span></div>
            <div class="item-grid">${itemsHtml}</div>
          `;
          container.appendChild(card);
        }
      });

      noResults.style.display = totalVisibleItems === 0 ? 'block' : 'none';
    }

    async function ensureOwnFishdexData() {
      if (cachedFishdexData) return cachedFishdexData;
      try {
        const me = await (await fetch('/api/auth/me')).json();
        if (!me.loggedIn) return null;
        const res = await fetch('/api/fishdex');
        if (!res.ok) return null;
        const data = await res.json();
        cachedFishdexData = data;
        return data;
      } catch (err) {
        return null;
      }
    }

    let lbRefreshInFlight = false;
    let leaderboardUserScrolling = false;
    let leaderboardScrollTimer = null;
    let leaderboardScrollHooksBound = false;

    function bindLeaderboardScrollHooks() {
      if (leaderboardScrollHooksBound) return;
      leaderboardScrollHooksBound = true;
      window.addEventListener('scroll', () => {
        if (!document.getElementById('leaderboard-view')?.classList.contains('active')) return;
        leaderboardUserScrolling = true;
        clearTimeout(leaderboardScrollTimer);
        leaderboardScrollTimer = setTimeout(() => {
          leaderboardUserScrolling = false;
          // A background poll may have completed while the user was scrolling.
          // Render once, after scrolling settles, instead of interrupting the
          // browser's scroll work.
          if (cachedLeaderboardData) renderLeaderboards();
        }, 180);
      }, { passive: true });
    }

    async function fetchLeaderboard(isManualRefresh = false) {
      // Silent background polls must not stack. A manual press always gets an
      // answer, so it gets to run even if a poll is mid-flight.
      if (lbRefreshInFlight && !isManualRefresh) return;
      lbRefreshInFlight = true;

      if (isManualRefresh) {
        document.getElementById('lb-catches').innerHTML = `<div class="state-message">Re-reading stats from the local database…</div>`;
        document.getElementById('lb-rares').innerHTML = `<div class="state-message">Re-reading stats from the local database…</div>`;
      }

      // Pull the logged-in user's own exact fish-index numbers (if any) so their
      // leaderboard row always matches their My Fish Index tab precisely.
      await ensureOwnFishdexData();

      const startedAt = performance.now();

      try {
        const response = await fetch(isManualRefresh ? `/api/leaderboard?fresh=${Date.now()}` : '/api/leaderboard');
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `The local server responded with ${response.status}`);
        }
        // data.error is a real failure. data.debug on an empty board is
        // information, so it renders as an empty state, not as an error.
        if (data.error) {
          throw new Error(data.error);
        }

        cachedLeaderboardData = data;
        if (!leaderboardUserScrolling) renderLeaderboards();

        if (isManualRefresh) {
          const rows = (data.catches || []).length;
          toast(
            `${rows} angler${rows === 1 ? '' : 's'} on the board. Read from the local database in ${Math.round(performance.now() - startedAt)} ms.`,
            'success',
            { label: 'Leaderboard refreshed' }
          );
        }
      } catch (err) {
        // Never substitute placeholder rows here. A fabricated leaderboard is
        // indistinguishable from a real one once it is on screen, and it hides
        // the actual failure from whoever has to fix it.
        cachedLeaderboardData = null;

        const detail = (err && err.message) ? err.message : 'Unknown error';
        const msg = `<div class="state-message state-message--error">Could not read the leaderboard from the local database. ${escText(detail)}</div>`;
        document.getElementById('lb-catches').innerHTML = msg;
        document.getElementById('lb-rares').innerHTML = msg;

        if (isManualRefresh) {
          toast(`Could not read the leaderboard from the local database. ${detail}`, 'error', {
            label: 'Refresh failed',
            ttl: 8000
          });
        }
      } finally {
        lbRefreshInFlight = false;
      }
    }

    function filterLeaderboards() {
      leaderboardPage = 1;
      renderLeaderboards();
    }

    // Every catch is stored server-side with its tier baked into the string
    // itself - "Name [TIER]" for rareCatches list entries, "Name (TIER)" for
    // bestItem. Parsing that suffix out gives us the *exact* tier the server
    // recorded, instead of re-guessing it from the catalog (which is fragile
    // for items whose own name contains parentheses, like "Vipfish (gives
    // VIP role)", and can misclassify or fail to match at all).
    const SECRET_TIER_DISPLAY = { tierId: 'unique', accent: 'var(--ink-000)', icon: 'void', label: 'Secret' };
    const TIER_DISPLAY_BY_NAME = {
      SECRET:    SECRET_TIER_DISPLAY,
      // Legacy alias: catches saved before the "UNIQUE" tier was renamed to
      // "SECRET" still carry the old suffix - map them to the same display.
      UNIQUE:    SECRET_TIER_DISPLAY,
      GODLY:     { tierId: 'godly',     accent: 'var(--danger)', icon: 'flame', label: 'Godly' },
      LEGENDARY: { tierId: 'legendary', accent: 'var(--brass)', icon: 'gem', label: 'Legendary' },
      EPIC:      { tierId: 'epic',      accent: 'var(--tier-epic)', icon: 'shard', label: 'Epic' },
      RARE:      { tierId: 'rare',      accent: 'var(--signal)', icon: 'drop', label: 'Rare' },
      UNCOMMON:  { tierId: 'uncommon',  accent: 'var(--ok)', icon: 'leaf', label: 'Uncommon' },
      TREASURY:  { tierId: 'treasury',  accent: 'var(--verdigris)', icon: 'key', label: 'Treasury' },
      COMMON:    { tierId: 'common',    accent: 'var(--tier-common)', icon: 'fish', label: 'Common' }
    };

    function getTierDisplayByName(tierName) {
      return TIER_DISPLAY_BY_NAME[(tierName || '').toUpperCase().trim()] || TIER_DISPLAY_BY_NAME.COMMON;
    }

    // Canonical tier order for the "which tabs does this user's vault need"
    // list - driven off the same tier ids everywhere so a tier can never
    // silently be left out of the tab bar.
    const VAULT_TAB_ORDER = [
      { id: 'unique', label: 'Secret' },
      { id: 'godly', label: 'Godly' },
      { id: 'legendary', label: 'Legendary' },
      { id: 'epic', label: 'Epic' },
      { id: 'rare', label: 'Rare' },
      { id: 'uncommon', label: 'Uncommon' },
      { id: 'common', label: 'Common' },
      { id: 'treasury', label: 'Treasury' }
    ];

    // Splits a raw catch string into its clean fish name and the tier that
    // was actually recorded for it (if any). Handles both suffix styles used
    // across the backend: "Name [TIER]" (rareCatches entries) and
    // "Name (TIER)" (bestItem). Returns tierName: null when the string has
    // no recognizable tier suffix (e.g. it was already cleaned upstream).
    function parseRareCatchString(raw) {
      const str = (typeof raw === 'string' ? raw : '').trim();
      let match = str.match(/^(.*?)\s*\[([A-Za-z]+)\]$/);
      if (match && TIER_DISPLAY_BY_NAME[match[2].toUpperCase()]) {
        return { name: match[1].trim(), tierName: match[2].toUpperCase() };
      }
      match = str.match(/^(.*?)\s*\(([A-Za-z]+)\)$/);
      if (match && TIER_DISPLAY_BY_NAME[match[2].toUpperCase()]) {
        return { name: match[1].trim(), tierName: match[2].toUpperCase() };
      }
      return { name: str, tierName: null };
    }

    // The leaderboard vault must show exactly what the admin inventory view
    // shows for the same player: the live fish:rares list, grouped by fish name
    // AND tier. These helpers keep every vault calculation on that one basis.
    //  - vaultSourceItems: the inventory list is authoritative even when it is
    //    empty. bestItem is only a fallback for an old payload with no list at
    //    all, and the literal "None" means "no items", never an item.
    //  - vaultCatchKey: name + tier. UNIQUE is the legacy name of SECRET, so it
    //    can be normalised when comparing against the stored best catch.
    function vaultSourceItems(entry) {
      if (Array.isArray(entry?.rareCatches)) return entry.rareCatches;
      const best = typeof entry?.bestItem === 'string' ? entry.bestItem.trim() : '';
      return best && best.toLowerCase() !== 'none' ? [best] : [];
    }

    function vaultCatchKey(name, tierName, normalizeLegacy = false) {
      let tier = String(tierName || 'COMMON').toUpperCase();
      if (normalizeLegacy && tier === 'UNIQUE') tier = 'SECRET';
      return `${String(name || '').toLowerCase().trim()}_${tier.toLowerCase()}`;
    }

    function getFishRarityDetails(fishName) {
      const raw = typeof fishName === 'string' ? fishName : '';

      // Prefer the tier actually recorded on the catch itself, if present.
      const { name, tierName } = parseRareCatchString(raw);
      if (tierName) {
        return getTierDisplayByName(tierName);
      }

      // No tier suffix on the string (e.g. a static catalog name) - fall
      // back to matching it against the fish catalog.
      //
      // Tiers are looked up by id, never by array position: the order the
      // API happens to return is not something to depend on, and getting
      // it wrong silently mislabels every rarity in the vault.
      const cleanName = name.toLowerCase().trim();
      const matches = (item) => {
        const n = String(item).toLowerCase().trim();
        return n === cleanName || cleanName.includes(n.split(' ')[0]);
      };

      for (const tier of baseTiers || []) {
        if (!tier || !Array.isArray(tier.items)) continue;
        if (tier.items.some(matches)) return getTierDisplayByName(tier.name);
      }

      return getTierDisplayByName('COMMON');
    }

    /* THE index percentage, defined once.
       The secret tier is a set of one-of-a-kind trophies, so it is excluded
       from both sides of the ratio. The API's own totalItems/totalCaught
       include it, which meant the profile bar and the leaderboard row for
       the same person could show different percentages. Everything that
       shows "x% caught" goes through here. */
    function fishdexIndexProgress(data) {
      const tiers = data && Array.isArray(data.tiers) ? data.tiers : [];
      let caught = 0;
      let total = 0;
      for (const tier of tiers) {
        if (!tier) continue;
        const id = String(tier.id || '').toLowerCase();
        const name = String(tier.name || '').trim().toUpperCase();
        if (id === 'unique' || name === 'UNIQUE' || name === 'SECRET') continue;
        for (const item of Array.isArray(tier.items) ? tier.items : []) {
          total += 1;
          if (item && item.caught) caught += 1;
        }
      }
      // No usable tier list (older payload shape): fall back to the raw
      // totals so the figure degrades rather than disappearing.
      if (!total) {
        total = Number(data && data.totalItems) || 0;
        caught = Number(data && data.totalCaught) || 0;
      }
      return { caught, total, pct: total > 0 ? Math.round((caught / total) * 100) : 0 };
    }

    function getTotalCatalogItemCount() {
      // Excludes the "unique" tier: those items are one-of-a-kind trophies
      // that don't count toward the Fish Index percentage.
      return (baseTiers || []).reduce((sum, tier) => sum + (tier.id !== 'unique' && tier.items ? tier.items.length : 0), 0);
    }

    function getUserIndexPercent(entry) {
      // If this row belongs to the currently logged-in user, use their exact
      // My Fish Index numbers instead of the approximate calculation below.
      if (cachedFishdexData && cachedFishdexData.user && cachedFishdexData.tiers) {
        const ownLogin = (cachedFishdexData.user.login || cachedFishdexData.user.displayName || '').toLowerCase().trim();
        if (ownLogin && ownLogin === (entry.username || '').toLowerCase().trim()) {
          return fishdexIndexProgress(cachedFishdexData).pct;
        }
      }

      const totalItems = getTotalCatalogItemCount();
      if (!totalItems) return 0;
      const rawCatches = vaultSourceItems(entry);
      const uniqueNames = new Set();
      rawCatches.forEach(item => {
        const raw = typeof item === 'string' ? item : (item.name || '');
        const { name, tierName } = parseRareCatchString(raw);
        const cleanName = name.toLowerCase().trim();
        if (cleanName && tierName !== 'UNIQUE' && tierName !== 'SECRET') uniqueNames.add(cleanName);
      });
      return Math.round((uniqueNames.size / totalItems) * 100);
    }

    function setVaultTab(userIndex, tabName) {
      if (!userVaultState[userIndex]) userVaultState[userIndex] = { tab: 'all', search: '' };
      userVaultState[userIndex].tab = tabName;
      refreshVaultGrid(userIndex);
    }

    function setVaultSearch(userIndex, query) {
      if (!userVaultState[userIndex]) userVaultState[userIndex] = { tab: 'all', search: '' };
      userVaultState[userIndex].search = query.toLowerCase().trim();
      refreshVaultGrid(userIndex);
    }

    function refreshVaultGrid(userIndex) {
      const entry = lastRenderedRares[userIndex];
      const gridContainer = document.getElementById(`vault-grid-${userIndex}`);
      if (!gridContainer || !entry) return;

      const state = userVaultState[userIndex] || { tab: 'all', search: '' };
      const rawCatches = vaultSourceItems(entry);
      const best = parseRareCatchString(entry.bestItem || '');
      const bestIdentity = vaultCatchKey(best.name, best.tierName, true);

      // Grouped by name AND tier, like the admin inventory grid, so the same
      // fish in two tiers is two cards instead of one merged card.
      const counts = {};
      rawCatches.forEach(item => {
        const raw = typeof item === 'string' ? item : (item.name || 'Unknown Catch');
        const { name: cleanName, tierName } = parseRareCatchString(raw);
        const key = vaultCatchKey(cleanName, tierName);
        if (!counts[key]) counts[key] = { name: cleanName, raw, identity: vaultCatchKey(cleanName, tierName, true), count: 0 };
        counts[key].count += (typeof item === 'object' && item.count) ? item.count : 1;
      });

      let itemsArray = Object.values(counts).map(({ name, raw, identity, count }) => {
        const details = getFishRarityDetails(raw);
        return { name, identity, count, ...details };
      });

      // The best catch has its own showcase above the search bar, so it's
      // excluded here to avoid showing it twice.
      itemsArray = itemsArray.filter(item => item.identity !== bestIdentity);

      itemsArray = itemsArray.filter(item => {
        const matchesTab = state.tab === 'all' || item.tierId === state.tab;
        const matchesSearch = item.name.toLowerCase().includes(state.search);
        return matchesTab && matchesSearch;
      });

      const tierWeight = { unique: 7, godly: 6, legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1, treasury: 0 };
      itemsArray.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return (tierWeight[b.tierId] || 0) - (tierWeight[a.tierId] || 0);
      });

      if (itemsArray.length === 0) {
        gridContainer.innerHTML = `<div class="grid-empty">No inventory items found matching your filters.</div>`;
        return;
      }

      gridContainer.innerHTML = itemsArray.map(item => `
        <div class="inventory-item-card" style="--slot-accent: ${item.accent};" title="${escText(item.name)} (${escText(item.label)})">
          <div class="item-info-group">
            <div class="fish-icon-frame">${icon(item.icon)}</div>
            <div class="item-text-details">
              <span class="item-name">${escText(item.name)}</span>
              <span class="item-rarity">${escText(item.label)}</span>
            </div>
          </div>
          <span class="item-quantity-badge">x${item.count}</span>
        </div>
      `).join('');
    }

    function renderBestCatchShowcase(userIndex) {
      const entry = lastRenderedRares[userIndex];
      const container = document.getElementById(`vault-best-${userIndex}`);
      if (!container || !entry || !entry.bestItem) {
        if (container) container.innerHTML = '';
        return;
      }

      const best = parseRareCatchString(entry.bestItem || '');
      const bestIdentity = vaultCatchKey(best.name, best.tierName, true);
      const rawCatches = vaultSourceItems(entry);
      let count = 0;
      rawCatches.forEach(item => {
        const raw = typeof item === 'string' ? item : (item.name || '');
        const { name, tierName } = parseRareCatchString(raw);
        if (vaultCatchKey(name, tierName, true) === bestIdentity) count += (typeof item === 'object' && item.count) ? item.count : 1;
      });
      // A best catch that is not in the live inventory (stale cached value, or
      // "None" for an empty inventory) is not shown: the admin view would not list it.
      if (count === 0) { container.innerHTML = ''; return; }

      const details = getFishRarityDetails(entry.bestItem);
      const cleanBestName = parseRareCatchString(entry.bestItem || '').name || entry.bestItem;

      container.innerHTML = `
        <div class="vault-best-label"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-trophy"></use></svg> Best Catch</div>
        <div class="inventory-item-card featured-item" style="--slot-accent: ${details.accent};" title="${escText(cleanBestName)} (${escText(details.label)})">
          <div class="item-info-group">
            <div class="fish-icon-frame">${icon(details.icon)}</div>
            <div class="item-text-details">
              <span class="item-name">${escText(cleanBestName)}</span>
              <span class="item-rarity">${escText(details.label)}</span>
            </div>
          </div>
          <span class="item-quantity-badge">x${count}</span>
        </div>
      `;
    }

    function renderPageSwitcher(containerId, currentPage, totalPages, onPageChange) {
      const container = document.getElementById(containerId);
      if (!container) return;
      if (totalPages <= 1) { container.innerHTML = ''; return; }

      const safePage = Math.max(1, Math.min(Number(currentPage) || 1, totalPages));
      const pages = [];
      const addPage = (n) => { if (n >= 1 && n <= totalPages && !pages.includes(n)) pages.push(n); };
      addPage(1);
      for (let n = safePage - 2; n <= safePage + 2; n++) addPage(n);
      addPage(totalPages);

      const parts = [];
      parts.push(`<button type="button" class="page-switcher-btn" ${safePage <= 1 ? 'disabled' : ''} onclick="${onPageChange}(1)">First</button>`);
      parts.push(`<button type="button" class="page-switcher-btn" ${safePage <= 1 ? 'disabled' : ''} onclick="${onPageChange}(${safePage - 1})">‹</button>`);
      let previous = 0;
      pages.forEach((page) => {
        if (previous && page > previous + 1) parts.push('<span class="page-switcher-info">…</span>');
        parts.push(`<button type="button" class="page-switcher-btn ${page === safePage ? 'active' : ''}" aria-current="${page === safePage ? 'page' : 'false'}" onclick="${onPageChange}(${page})">${page}</button>`);
        previous = page;
      });
      parts.push(`<button type="button" class="page-switcher-btn" ${safePage >= totalPages ? 'disabled' : ''} onclick="${onPageChange}(${safePage + 1})">›</button>`);
      parts.push(`<button type="button" class="page-switcher-btn" ${safePage >= totalPages ? 'disabled' : ''} onclick="${onPageChange}(${totalPages})">Last</button>`);
      parts.push(`<span class="page-switcher-info">Page ${safePage} of ${totalPages}</span>`);
      container.innerHTML = parts.join('');
    }

    function setLeaderboardPage(page) {
      leaderboardPage = Math.max(1, Number(page) || 1);
      renderLeaderboards();
      // Do not smooth-scroll the entire page on every page click. Keeping the
      // user's current scroll position makes leaderboard browsing feel instant.
    }

    function setMailPage(page) {
      const totalPages = Math.max(1, Math.ceil(tradingMailFilteredCount() / MAIL_PAGE_SIZE));
      tradingMailPage = Math.max(1, Math.min(Number(page) || 1, totalPages));
      renderMailMessages(tradingMailMessages);
      // Keep the current scroll position when paging through Mail.
    }

    function tradingMailFilteredCount() {
      return tradingMailMessages.filter((message) => tradingMailFilter === 'all' || mailMessageCategory(message) === tradingMailFilter).length;
    }

    function safeTitleColor(value){ const v=String(value||'').trim(); return /^#[0-9a-f]{6}$/i.test(v)?v:''; }

    function leaderboardIdentity(entry) {
      const c = entry?.cosmetics || {};
      const frameClass = c.frame === 'frame_signal' ? ' signal-frame' : c.frame === 'frame_brass' ? ' brass-frame' : '';
      const effectIcon = c.effect === 'effect_stars' ? icon('star') : c.effect === 'effect_spark' ? icon('sparkle') : '';
      const nameplate = c.nameplate === 'nameplate_signal' ? ' signal-nameplate' : c.nameplate === 'nameplate_brass' ? ' brass-nameplate' : '';
      const titleColor = safeTitleColor(entry?.titleColor || ''); const title = entry?.title ? `<span class="leaderboard-title" style="color:${titleColor || '#D7DDD9'}">${escText(entry.title)}</span>` : '';
      const effect = effectIcon ? `<span class="leaderboard-effect" aria-hidden="true">${effectIcon}</span>` : '';
      return `<span class="leaderboard-player${frameClass}${nameplate}">${effect}<span class="leaderboard-player-name">@${escText(entry.username)}</span>${title}</span>`;
    }

    function renderLeaderboards() {
      if (!cachedLeaderboardData) return;

      const searchFilter = document.getElementById('leaderboardSearchInput').value.toLowerCase().trim();
      // True when nobody has been recorded yet and no search is narrowing the view.
      const noBoardData = !searchFilter
        && !(cachedLeaderboardData.catches || []).length
        && !(cachedLeaderboardData.rares || []).length;
      const catchesContainer = document.getElementById('lb-catches');
      const filteredCatches = cachedLeaderboardData.catches ? cachedLeaderboardData.catches.filter(e => e.username.toLowerCase().includes(searchFilter)) : [];

      const catchesTotalPages = Math.max(1, Math.ceil(filteredCatches.length / LEADERBOARD_PAGE_SIZE));
      const catchesStart = (Math.min(leaderboardPage, catchesTotalPages) - 1) * LEADERBOARD_PAGE_SIZE;
      const pagedCatches = filteredCatches.slice(catchesStart, catchesStart + LEADERBOARD_PAGE_SIZE);

      if (filteredCatches.length === 0) {
        catchesContainer.innerHTML = noBoardData
          ? `<div class="state-message">No catches recorded yet. Type <strong>!fish</strong> in the Twitch chat to log the first one.</div>`
          : `<div class="state-message">No matching fishing stats found.</div>`;
      } else {
        let html = `<table class="lb-table"><thead><tr><th class="lb-rank-col">Rank</th><th>Twitch User</th><th class="lb-num-col">Catches</th></tr></thead><tbody>`;
        pagedCatches.forEach((entry, index) => {
          const absoluteIndex = catchesStart + index;
          const rank = String(absoluteIndex + 1).padStart(2, '0');
          const rankClass = absoluteIndex === 0 ? ' is-first' : absoluteIndex <= 2 ? ' is-podium' : '';
          html += `<tr><td class="lb-rank-cell"><span class="lb-rank-num${rankClass}">${rank}</span></td>` +
                  `<td class="lb-user-cell">${leaderboardIdentity(entry)}</td>` +
                  `<td class="lb-num-cell">${Number(entry.count).toLocaleString('en-US')}</td></tr>`;
        });
        html += `</tbody></table>`;
        catchesContainer.innerHTML = html;
      }

      const raresContainer = document.getElementById('lb-rares');
      let filteredRares = cachedLeaderboardData.rares ? cachedLeaderboardData.rares.filter(e => e.username.toLowerCase().includes(searchFilter)) : [];

      // Always rank by fish index completion %, highest first.
      filteredRares = filteredRares.slice().sort((a, b) => (b.dexPct ?? 0) - (a.dexPct ?? 0));

      const raresTotalPages = Math.max(1, Math.ceil(filteredRares.length / LEADERBOARD_PAGE_SIZE));
      const raresStart = (Math.min(leaderboardPage, raresTotalPages) - 1) * LEADERBOARD_PAGE_SIZE;
      const pagedRares = filteredRares.slice(raresStart, raresStart + LEADERBOARD_PAGE_SIZE);

      // refreshVaultGrid/renderBestCatchShowcase use the current page's display
      // index, while ranks retain their position within the filtered result set.
      lastRenderedRares = pagedRares;

      if (filteredRares.length === 0) {
        raresContainer.innerHTML = noBoardData
          ? `<div class="state-message">No rare catches recorded yet. Rare finds appear here as soon as someone lands one.</div>`
          : `<div class="state-message">No matching rare collection records found.</div>`;
      } else {
        let html = `<table class="lb-table"><thead><tr><th class="lb-rank-col">Rank</th><th>Twitch User</th><th class="lb-num-col">Fish Index %</th></tr></thead><tbody>`;

        pagedRares.forEach((entry, index) => {
          const absoluteIndex = raresStart + index;
          const rankNum = String(absoluteIndex + 1).padStart(2, '0');
          const rankClass = absoluteIndex === 0 ? ' is-first' : absoluteIndex <= 2 ? ' is-podium' : '';
          const rankBadge = `<span class="lb-rank-num${rankClass}">${rankNum}</span>`;

          if (!userVaultState[index]) userVaultState[index] = { tab: 'all', search: '' };

          const isOpen = openAccordions.has(index);
          const detailRowClass = isOpen ? 'accordion-detail-row open' : 'accordion-detail-row';
          const summaryRowClass = isOpen ? 'accordion-row is-open' : 'accordion-row';
          const indexPercent = entry.dexPct ?? 0;

          const rawCatches = vaultSourceItems(entry);
          const presentTiers = new Set();
          rawCatches.forEach(item => {
            const name = typeof item === 'string' ? item : (item.name || '');
            const details = getFishRarityDetails(name);
            presentTiers.add(details.tierId);
          });

          html += `
            <tr class="${summaryRowClass}" onclick="toggleAccordion(${index})">
              <td>${rankBadge}</td>
              <td>${leaderboardIdentity(entry)} <span class="row-disclosure"><span>Inventory</span><svg class="ic row-disclosure-mark" aria-hidden="true" focusable="false"><use href="#i-chev-down"></use></svg></span></td>
              <td class="lb-num-cell">
                <div class="lb-index-cell">
                  <span class="lb-index-value">${indexPercent}%</span>
                  <div class="lb-progress-track"><div class="lb-progress-fill" style="width: ${indexPercent}%;"></div></div>
                </div>
              </td>
            </tr>
            <tr id="detail-${index}" class="${detailRowClass}">
              <td colspan="3">
                <div class="detail-container">
                  <div class="detail-heading">
                    @${escText(entry.username)}'s Secure Loot &amp; Trophy Vault
                  </div>
                  <div id="vault-best-${index}" class="vault-best-catch"></div>
                  <div class="vault-toolbar">
                    <span class="vault-filter-label"><svg class="ic" aria-hidden="true" focusable="false"><use href="#i-filter"></use></svg>Filter</span><div class="vault-filter-tabs">
                      <button class="vault-tab-btn active" onclick="setVaultTab(${index}, 'all')">All</button>
                      ${VAULT_TAB_ORDER.filter(t => presentTiers.has(t.id)).map(t => `<button class="vault-tab-btn" onclick="setVaultTab(${index}, '${t.id}')">${t.label}</button>`).join('')}
                    </div>
                    <div class="vault-search-box">
                      <input type="text" class="vault-search-input" placeholder="Search vault items..." oninput="setVaultSearch(${index}, this.value)">
                    </div>
                  </div>
                  <div id="vault-grid-${index}" class="inventory-grid"></div>
                </div>
              </td>
            </tr>
          `;
        });
        html += `</tbody></table>`;
        raresContainer.innerHTML = html;

        pagedRares.forEach((_, index) => {
          if (openAccordions.has(index)) {
            renderBestCatchShowcase(index);
            refreshVaultGrid(index);
          }
        });
      }
      const raresVisible = document.getElementById('lb-rares')?.classList.contains('active');
      const activeTotalPages = raresVisible ? raresTotalPages : catchesTotalPages;
      const safeSharedPage = Math.min(leaderboardPage, activeTotalPages);
      if (leaderboardPage !== safeSharedPage) leaderboardPage = safeSharedPage;
      renderPageSwitcher('lbPager', leaderboardPage, activeTotalPages, 'setLeaderboardPage');
    }

    /* UX/accessibility hardening: Escape closes the currently visible modal;
       focus returns naturally to the triggering control when the browser can. */
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const activeModal = Array.from(document.querySelectorAll('.modal-overlay.active')).pop();
      if (!activeModal) return;
      const close = activeModal.querySelector('.modal-close');
      if (close) close.click();
    });

    // Keep the active top-level navigation state discoverable to assistive tech.
    const syncNavState = () => {
      document.querySelectorAll('.nav-pill-container .tab-btn').forEach(btn => {
        btn.setAttribute('aria-current', btn.classList.contains('active') ? 'page' : 'false');
      });
      document.querySelectorAll('.hub-sidebar .hub-nav-btn').forEach(btn => {
        btn.setAttribute('aria-current', btn.classList.contains('active') ? 'page' : 'false');
      });
    };
    syncNavState();
    new MutationObserver(syncNavState).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

    initApp();
  
