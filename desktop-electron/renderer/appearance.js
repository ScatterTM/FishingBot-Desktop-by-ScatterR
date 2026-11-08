// Desktop appearance: wallpaper, colours, glass, icons, clock, taskbar, lock screen and interface font.
// Loaded before desktop.js and used by the Settings app. Everything here is a CSS variable,
// a body class, or the wallpaper layer, so the stylesheet itself does not change per option.
(() => {
  'use strict';

  // Accent colours: strong for solid buttons and gradients, light for text, icons and highlights.
  // Keys must match ACCENTS in settings.js (test-appearance.js checks).
  const ACCENTS = {
    signal: { strong: '#f2703f', light: '#f2703f' },
    teal: { strong: '#0f9b8e', light: '#3fcdbd' },
    blue: { strong: '#2563eb', light: '#60a5fa' },
    violet: { strong: '#7c3aed', light: '#a78bfa' },
    green: { strong: '#16a34a', light: '#4ade80' },
    pink: { strong: '#db2777', light: '#f472b6' },
  };

  // Same defaults as normalize() in settings.js. test-appearance.js checks they match.
  const DEFAULTS = Object.freeze({
    wallpaperFit: 'cover',
    wallpaperDim: 25,
    wallpaperBlur: 0,
    builtinWallpaper: 'ember',
    desktopColorOn: false,
    desktopColor: '#101214',
    accent: 'signal',
    customAccent: '#f2703f',
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
    lockUseDesktop: false,
    lockBlur: 8,
    lockDim: 45,
    lockGreeting: 'Welcome Back',
    lockShowDate: true,
    uiScale: 'auto',
    performanceMode: 'custom',
    customLook: '',
  });

  // Interface font stacks. 'system' is the look the desktop had before; the others are Windows fonts.
  const FONTS = {
    system: '"Segoe UI Semibold", "Segoe UI", system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'Consolas, ui-monospace, monospace',
    segoe: '"Segoe UI", system-ui, sans-serif',
    aptos: 'Aptos, "Segoe UI", system-ui, sans-serif',
    calibri: 'Calibri, Carlito, "Segoe UI", sans-serif',
    arial: 'Arial, Helvetica, sans-serif',
    verdana: 'Verdana, Geneva, sans-serif',
    tahoma: 'Tahoma, Verdana, sans-serif',
    cambria: 'Cambria, Georgia, serif',
    cascadia: '"Cascadia Mono", Consolas, monospace',
  };
  // CSS for each wallpaper fit: background-size and background-repeat.
  const FITS = {
    cover: { size: 'cover', repeat: 'no-repeat' },
    contain: { size: 'contain', repeat: 'no-repeat' },
    center: { size: 'auto', repeat: 'no-repeat' },
    tile: { size: 'auto', repeat: 'repeat' },
  };
  const HEX = /^#[0-9a-f]{6}$/i;
  // Animated built-in wallpapers. Loaded from the web; they show the solid background while offline.
  // Thumbnails in desktop.html use the same addresses.
  const ANIMATED_URLS = Object.freeze({
    anim1: 'https://media.giphy.com/media/JpwZX7oOiUjc4T92BN/giphy.gif',
    anim2: 'https://media.giphy.com/media/NPC82QxThOUWIl7YMK/giphy.gif',
    anim3: 'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3M2M0b29yMmtxOWxtZ2I4MnpmcTRoejdkMGQzcXdnNmZqbHMyYzR5NSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/JCOCRhPdsVHHeh2Ffc/giphy.gif',
  });

  const state = { look: { ...DEFAULTS }, wallpaper: null, avatar: null };

  function clamp(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
  }

  // Moves a colour toward white by amount (0 to 1). Used for the light tone of a custom accent.
  function lighten(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map((c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0'))
      .join('');
  }

  // The strong and light accent tones for the current choice: a preset, or the custom colour.
  function accentTones(look) {
    if (look.accent === 'custom') {
      const strong = HEX.test(look.customAccent || '') ? look.customAccent.toLowerCase() : DEFAULTS.customAccent;
      return { strong, light: lighten(strong, 0.2) };
    }
    return ACCENTS[look.accent] || ACCENTS.signal;
  }

  // CSS for the Control Centre pages in the app windows. They keep their own colours and layout; this
  // only gives their surfaces the desktop's corners and glass, so the Corner rounding and Glass settings
  // reach them too. Also carries the glass variables that the dropdowns use inside those pages.
  // Text-type fields and dropdowns of a Control Centre page. Switches, sliders, checkboxes and colour
  // pickers are left out: they have their own look, and the rules above would override it.
  const FIELDS = 'input:not(.switch):not([type=range]):not([type=checkbox]):not([type=color]),select,textarea';

  // Every panel of the Control Centre pages: cards, tiles, groups and the loot table's groups.
  const PANELS = '.card,.set-section,.modal-card,.login-card,details.card,.savebar,.tool,.inv-tile,.notice,.empty,.metric,details.tier,.tier,.oh-tile,.ov-hero,.oh-card,.oh-cmds,.loot-head,.bc-card,.bc-head,.vt-head,.danger-card,.loot-stats>div,.loot-status,.loot-seg-btn';
  function pageCss() {
    const look = state.look;
    const radius = clamp(look.cornerRadius, 0, 24, DEFAULTS.cornerRadius);
    const small = Math.round(radius * 0.58);
    const glass = clamp(look.glassOpacity, 0, 100, DEFAULTS.glassOpacity) / 100;
    const grid = clamp(look.gridOpacity, 0, 100, DEFAULTS.gridOpacity) / 100;
    const font = FONTS[look.uiFont] || FONTS.system;
    const text = clamp(look.textScale, 85, 125, DEFAULTS.textScale) / 100;
    const control = Math.max(glass, 0.25);
    const blur = Math.round(18 + (1 - glass) * 22);
    const accent = hexToRgb(accentTones(look).light);
    // Below half opacity the text on the page gets a soft shadow, so it stays readable on the wallpaper.
    const readable = grid < 0.5 && look.textShadow === true ? 'body{text-shadow:0 1px 6px rgba(0,0,0,.75)}' : '';
    return `:root{--fb-r:${radius}px;--fb-r-sm:${small}px;--fb-panel:rgba(25,28,32,${grid});--fb-control:rgba(11,13,16,${control});--fb-rail:rgba(11,13,16,${glass});` +
      `--glass-strong:rgba(20,23,27,${Math.min(1, glass + 0.18)});--glass-control:rgba(34,38,44,${control});--glass-line:rgba(255,255,255,0.08);` +
      `--glass-blur:blur(${blur}px) saturate(140%);--accent-rgb:${accent};--radius-sm:${small}px;--r-md:${Math.round(radius * 0.75)}px}` +
      `:root{--fb-font:${font}}html{zoom:${text}}body{font-family:var(--fb-font)!important}` +
      `html,body,.shell,.main{background:transparent!important}` +
      `.rail{background-color:var(--fb-rail)!important}` +
      `${PANELS},.switch-line,.share-url,.inv-list,.upload-box,.chip,.fish-row input{background-color:var(--fb-panel)!important}` +
      `${FIELDS},.switch-line,.share-url,.inv-list,.upload-box,.chip,.fish-row input{background-color:var(--fb-control)!important}` +
      `${PANELS},.switch-line,.share-url,.inv-list,.upload-box{border-radius:var(--fb-r)!important}` +
      `.btn,.top-actions button,.nav button,.jump,.chip,.chip-static,.perk-state,.fish-row button,.fish-row input,${FIELDS}{border-radius:var(--fb-r-sm)!important}` +
      readable;
  }

  // Applies a look (the appearance section from settings) to the page.
  function apply(look) {
    const next = { ...DEFAULTS, ...(look || {}) };
    state.look = next;
    const root = document.documentElement;
    // Performance mode switches off blur, transitions and animations (see desktop.css).
    root.dataset.perf = next.performanceMode === 'performance' ? 'on' : 'off';
    const body = document.body;
    if (!root || !body) return;

    const accent = accentTones(next);
    root.style.setProperty('--orange', accent.strong);
    root.style.setProperty('--orange2', accent.light);
    root.style.setProperty('--accent-rgb', hexToRgb(accent.light));

    // Window glass: 100 is solid, 0 is fully clear. The clearer the glass, the harder the background
    // behind windows, widgets and icons is blurred, so what is on top stays readable.
    const glass = clamp(next.glassOpacity, 0, 100, DEFAULTS.glassOpacity) / 100;
    // Controls (buttons, fields, dropdowns) keep a floor so they stay usable when the glass is clear.
    root.style.setProperty('--glass-control', `rgba(34, 38, 44, ${Math.max(glass, 0.25)})`);
    const glassBlur = Math.round(18 + (1 - glass) * 22);
    root.style.setProperty('--glass', `rgba(24, 27, 31, ${glass})`);
    root.style.setProperty('--glass-strong', `rgba(20, 23, 27, ${Math.min(1, glass + 0.18)})`);
    root.style.setProperty('--glass-window', `rgba(16, 18, 20, ${glass})`);
    root.style.setProperty('--glass-head', `rgba(34, 38, 44, ${Math.min(1, glass + 0.1)})`);
    root.style.setProperty('--glass-text', `rgba(12, 14, 17, ${Math.max(glass, 0.55)})`);
    root.style.setProperty('--icon-a', String(Math.max(glass, 0.3)));
    root.style.setProperty('--glass-blur', `blur(${glassBlur}px) saturate(140%)`);

    const radius = clamp(next.cornerRadius, 0, 24, DEFAULTS.cornerRadius);
    // Corner tokens, all from one setting: 0 is square everywhere, the default 12 keeps the look.
    root.style.setProperty('--radius', `${radius}px`);
    root.style.setProperty('--radius-sm', `${Math.round(radius * 0.58)}px`);
    root.style.setProperty('--r-md', `${Math.round(radius * 0.75)}px`);
    root.style.setProperty('--r-xl', `${Math.round(radius * 1.33)}px`);
    root.style.setProperty('--ui-font', FONTS[next.uiFont] || FONTS.system);
    root.style.setProperty('--text-scale', clamp(next.textScale, 85, 125, DEFAULTS.textScale) / 100);
    // The App grids opacity also sets the cards of the Settings app; below half opacity their text gets a shadow.
    const gridLevel = clamp(next.gridOpacity, 0, 100, DEFAULTS.gridOpacity) / 100;
    root.style.setProperty('--grid-panel', `rgba(25, 28, 32, ${gridLevel})`);
    root.style.setProperty('--grid-radius', `${clamp(next.cornerRadius, 0, 24, DEFAULTS.cornerRadius)}px`);
    root.style.setProperty('--grid-shadow', gridLevel < 0.5 && next.textShadow === true ? '0 1px 6px rgba(0, 0, 0, 0.75)' : 'none');

    body.classList.toggle('no-widgets', next.showWidgets === false);
    body.classList.toggle('hide-w-clock', next.widgetClock === false);
    body.classList.toggle('hide-w-srv', next.widgetSrv === false);
    body.classList.toggle('hide-w-tw', next.widgetTw === false);
    body.classList.toggle('hide-w-log', next.widgetLog === false);
    body.classList.toggle('hide-w-sys', next.widgetSys === false);
    body.classList.toggle('no-clock', next.showClock === false);
    body.classList.toggle('no-date', next.showDate === false);
    body.classList.toggle('no-icon-labels', next.showIconLabels === false);
    body.classList.toggle('reduce-motion', next.reduceMotion === true);
    body.classList.toggle('no-lock-clock', next.showLockClock === false);
    body.classList.toggle('no-lock-date', next.lockShowDate === false);
    body.classList.toggle('lock-desktop', next.lockUseDesktop === true);
    body.classList.remove('icons-small', 'icons-medium', 'icons-large');
    body.classList.add(`icons-${['small', 'large'].includes(next.iconSize) ? next.iconSize : 'medium'}`);
    // The clock and date are a widget that scales to its size, so the old size classes are not used.
    body.classList.remove('clock-plain', 'clock-card', 'clock-align-left', 'clock-align-centre', 'clock-align-right');
    body.classList.add(`clock-${next.clockStyle === 'card' ? 'card' : 'plain'}`, `clock-align-${['left', 'right'].includes(next.clockAlign) ? next.clockAlign : 'centre'}`);
    body.classList.toggle('clock-date-above', next.datePosition === 'above');
    body.classList.toggle('clock-shadow', next.clockShadow === true);
    body.classList.toggle('text-shadow', next.textShadow === true);
    root.style.setProperty('--clock-font', FONTS[next.clockFont] || FONTS.mono);
    const clockColour = next.clockColour === 'accent' ? accent.light
      : next.clockColour === 'custom' && HEX.test(next.clockCustomColour) ? next.clockCustomColour : '';
    root.style.setProperty('--clock-colour', clockColour || 'var(--ink)');

    const bar = clamp(next.taskbarOpacity, 40, 100, DEFAULTS.taskbarOpacity) / 100;
    root.style.setProperty('--taskbar-glass', `rgba(24, 27, 31, ${bar})`);
    body.classList.remove('taskbar-compact', 'taskbar-normal', 'taskbar-large');
    body.classList.add(`taskbar-${['compact', 'large'].includes(next.taskbarSize) ? next.taskbarSize : 'normal'}`);
    body.classList.remove('taskbar-align-left', 'taskbar-align-centre', 'taskbar-align-right');
    body.classList.add(`taskbar-align-${['left', 'right'].includes(next.taskbarAlign) ? next.taskbarAlign : 'centre'}`);
    body.classList.toggle('taskbar-full', next.taskbarFull === true);
    body.classList.toggle('taskbar-autohide', next.taskbarAutoHide === true);
    body.classList.toggle('no-taskbar-clock', next.showTaskbarClock === false);
    body.classList.toggle('no-taskbar-status', next.showTaskbarStatus === false);
    body.classList.toggle('no-taskbar-search', next.taskbarSearch === false);
    body.classList.remove('widget-size-compact', 'widget-size-normal', 'widget-size-large');
    body.classList.add(`widget-size-${['normal', 'large'].includes(next.widgetSize) ? next.widgetSize : 'compact'}`);
    const pill = ['soft', 'solid', 'dot'].includes(next.pillStyle) ? next.pillStyle : 'soft';
    body.classList.remove('pill-soft', 'pill-solid', 'pill-dot');
    body.classList.add(`pill-${pill}`);

    root.style.setProperty('--lock-blur', `${clamp(next.lockBlur, 0, 20, DEFAULTS.lockBlur)}px`);
    root.style.setProperty('--lock-dim', String(clamp(next.lockDim, 0, 80, DEFAULTS.lockDim) / 100));
    const greeting = document.getElementById('lock-greeting');
    if (greeting) {
      greeting.textContent = next.lockGreeting || '';
      greeting.hidden = !next.lockGreeting;
    }

    renderWallpaper();
    // The icon grid depends on the icon size and the desk area, so it is laid out again.
    if (typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('fishingbot:look'));
    }
  }

  // Names of the built-in wallpapers, shown under the preview.
  const WALLPAPER_NAMES = Object.freeze({
    ember: 'Ember', night: 'Night', forest: 'Forest', ocean: 'Ocean', sunset: 'Sunset', graphite: 'Graphite',
    anim1: 'Animated 1', anim2: 'Animated 2', anim3: 'Animated 3',
  });

  // What the wallpaper shows now: a custom image, else a solid colour, else a built-in wallpaper.
  function wallpaperSource(look = state.look) {
    const colour = look.desktopColorOn === true ? look.desktopColor : '';
    if (state.wallpaper) return { image: `url("${state.wallpaper}")`, colour: '', name: 'Your image' };
    if (colour) return { image: '', colour, name: 'Solid colour' };
    const key = look.builtinWallpaper;
    const url = ANIMATED_URLS[key] || `wallpapers/${key}.svg`;
    return { image: `url("${url}")`, colour: '', name: WALLPAPER_NAMES[key] || 'Built-in wallpaper' };
  }

  // Paints one wallpaper layer. The desktop layer and each Settings preview use this same routine, so the
  // preview is the wallpaper as it will look. The preview blurs less, because it is much smaller than the screen.
  function paintWallpaperLayer(layer, source, look, previewScale) {
    const fit = FITS[look.wallpaperFit] || FITS.cover;
    const dim = clamp(look.wallpaperDim, 0, 80, DEFAULTS.wallpaperDim) / 100;
    const blur = clamp(look.wallpaperBlur, 0, 20, 0);
    layer.style.backgroundImage = source.image;
    layer.style.backgroundColor = source.colour || '';
    layer.style.backgroundSize = fit.size;
    layer.style.backgroundRepeat = fit.repeat;
    layer.style.setProperty('--dim', String(dim));
    layer.style.setProperty('--desk-blur', `${previewScale ? blur * previewScale : blur}px`);
  }

  // Repaints the desktop wallpaper and every Settings preview from the current look.
  // Animated GIF wallpapers are decoded and redrawn for as long as they show. While the window is hidden
  // or minimised, the image is taken off the layers and put back when the window shows again.
  function parkWallpapers(parked) {
    document.querySelectorAll('#wallpaper, [data-wallpaper-live]').forEach((node) => {
      const current = node.style.backgroundImage;
      if (parked) {
        if (current && current !== 'none') {
          node.dataset.parked = current;
          node.style.backgroundImage = 'none';
        }
      } else if (node.dataset.parked) {
        // A wallpaper chosen while hidden is already shown, so only put back the one that was removed.
        if (node.style.backgroundImage === 'none' || !node.style.backgroundImage) node.style.backgroundImage = node.dataset.parked;
        delete node.dataset.parked;
      }
    });
  }
  document.addEventListener('visibilitychange', () => parkWallpapers(document.hidden));

  function renderWallpaper() {
    const layer = document.getElementById('wallpaper');
    if (layer) {
      paintWallpaperLayer(layer, wallpaperSource(), state.look, 1);
      layer.hidden = false;
    }
    paintPreviews(state.look);
  }

  // The Settings previews, painted from a look. Settings passes the form's values here as they change, so
  // the preview follows each choice at once, before the change is saved.
  function paintPreviews(look) {
    const source = wallpaperSource(look);
    document.querySelectorAll('[data-wallpaper-live]').forEach((node) => paintWallpaperLayer(node, source, look, 0.3));
    document.querySelectorAll('[data-wallpaper-name]').forEach((node) => { node.textContent = source.name; });
  }

  function previewWallpaper(look) {
    paintPreviews({ ...state.look, ...(look || {}) });
  }

  // The default taskbar icon, used while no profile picture is set.
  const MENU_LOGO = '<img class="tb-logo" src="assets/logo.svg" alt="" width="26" height="26">';

  // The profile picture (a data URL), or null for the letter. Shown on the lock screen, and it takes the
  // place of the Menu logo on the taskbar; without a picture the logo and the letter are used.
  function avatarImage() {
    if (!state.avatar) return null;
    const img = document.createElement('img');
    img.src = state.avatar;
    img.alt = '';
    img.draggable = false;
    return img;
  }

  function renderAvatar() {
    if (document.body) document.body.classList.toggle('has-avatar', !!state.avatar);
    const lock = document.getElementById('lock-avatar');
    if (lock) {
      const img = avatarImage();
      if (img) lock.replaceChildren(img);
      else lock.textContent = 'F';
    }
    const menu = document.getElementById('start-btn');
    if (menu) {
      const img = avatarImage();
      menu.classList.toggle('has-avatar', !!img);
      if (img) {
        img.className = 'tb-avatar-img';
        menu.replaceChildren(img);
      } else {
        menu.innerHTML = MENU_LOGO;
      }
    }
  }

  function setAvatar(dataUrl) {
    state.avatar = dataUrl || null;
    renderAvatar();
  }

  // Sets the custom wallpaper from a data URL, or null to use the built-in choice.
  function setWallpaper(dataUrl) {
    state.wallpaper = dataUrl || null;
    renderWallpaper();
  }

  // Loads the saved look and wallpaper once at start. A failure keeps the defaults.
  async function load(api) {
    try {
      const [settings, picture, avatar] = await Promise.all([
        api.getSettings(),
        api.appearanceWallpaper(),
        api.appearanceAvatar ? api.appearanceAvatar() : Promise.resolve(null),
      ]);
      state.wallpaper = picture && picture.ok && picture.wallpaper ? picture.wallpaper.dataUrl : null;
      state.avatar = avatar && avatar.ok && avatar.avatar ? avatar.avatar.dataUrl : null;
      apply(settings && settings.appearance);
      renderAvatar();
    } catch {
      apply(DEFAULTS);
    }
  }

  // The clock text for the chosen format: 24-hour or 12-hour, with or without seconds.
  // The date for the chosen format. Long: Friday 7 November. Short: Fri 7 Nov. Numeric: 07/11/2026.
  function dateText(now) {
    const format = state.look.dateFormat;
    const options = format === 'short' ? { weekday: 'short', day: 'numeric', month: 'short' }
      : format === 'numeric' ? { day: '2-digit', month: '2-digit', year: 'numeric' }
      : { weekday: 'long', day: 'numeric', month: 'long' };
    return now.toLocaleDateString(undefined, options);
  }

  function clockText(now) {
    const seconds = state.look.showSeconds === true;
    if (state.look.clock24h !== false) return now.toTimeString().slice(0, seconds ? 8 : 5);
    return now.toLocaleTimeString(undefined, seconds
      ? { hour: 'numeric', minute: '2-digit', second: '2-digit' }
      : { hour: 'numeric', minute: '2-digit' });
  }

  window.FishingbotAppearance = Object.freeze({
    ACCENTS,
    DEFAULTS,
    apply,
    setWallpaper,
    setAvatar,
    renderAvatar,
    renderWallpaper,
    load,
    clockText,
    dateText,
    previewWallpaper,
    accentTones,
    current: () => state.look,
    pageCss,
  });
})();
