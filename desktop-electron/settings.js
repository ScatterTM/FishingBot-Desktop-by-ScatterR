'use strict';

// Reads and writes data/app-settings.json (the file the local server reads too)
// and the few .env values the desktop app needs. Only the keys listed here are touched.

const fs = require('node:fs');
const path = require('node:path');

const LANGUAGES = ['en', 'de', 'es', 'fr', 'zh'];
// Appearance choices. The renderer's accent table (renderer/appearance.js) must use the same keys;
// test-appearance.js checks that.
const ACCENTS = ['signal', 'teal', 'blue', 'violet', 'green', 'pink'];
const WALLPAPER_FITS = ['cover', 'contain', 'center', 'tile'];
const ICON_SIZES = ['small', 'medium', 'large'];
const CLOCK_SIZES = ['small', 'medium', 'large'];
const TASKBAR_SIZES = ['compact', 'normal', 'large'];
const TASKBAR_ALIGNS = ['left', 'centre', 'right'];
// Built-in wallpapers, in renderer/wallpapers/<name>.svg.
// Animated built-in wallpapers: GIFs loaded from the web (their URLs are in renderer/appearance.js).
const ANIMATED_WALLPAPERS = ['anim1', 'anim2', 'anim3'];
const BUILTIN_WALLPAPERS = ['ember', 'night', 'forest', 'ocean', 'sunset', 'graphite', ...ANIMATED_WALLPAPERS];
const UI_FONTS = ['system', 'segoe', 'aptos', 'calibri', 'arial', 'verdana', 'tahoma', 'serif', 'cambria', 'mono', 'cascadia'];
// The on-screen clock and date (a desktop widget): plain text or a card, its font, alignment, colour and date format.
const CLOCK_STYLES = ['plain', 'card'];
const CLOCK_ALIGNS = ['left', 'centre', 'right'];
const CLOCK_COLOURS = ['ink', 'accent', 'custom'];
const DATE_FORMATS = ['long', 'short', 'numeric'];
const DATE_POSITIONS = ['below', 'above'];
// Status pill looks: soft tint (default), solid colour, or dot only.
const PILL_STYLES = ['soft', 'solid', 'dot'];
// Presets plus 'custom', which uses the colour the user picks (customAccent).
const ACCENT_CHOICES = [...ACCENTS, 'custom'];
// The only file names a stored wallpaper can have. The name comes from app-settings.json, so it is
// checked before it is used as a path.
const WALLPAPER_FILE = /^wallpaper-\d+\.(png|jpe?g|webp|gif)$/i;
// The profile picture, stored like the wallpaper. Its name is checked before it is used as a path.
const AVATAR_FILE = /^avatar-\d+\.(png|jpe?g|webp|gif)$/i;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
// Desktop scale: 'auto' fits the screen, otherwise a percentage of the default size (see main.js applyUiScale).
const WIDGET_SIZES = Object.freeze(['compact', 'normal', 'large']);
const UI_SCALES = Object.freeze(['auto', '70', '75', '80', '90', '100', '110', '125']);
// Every appearance setting except the wallpaper file, which the upload and reset actions own.
const LOOK_KEYS = Object.freeze([
  'wallpaperFit', 'wallpaperDim', 'wallpaperBlur', 'desktopColorOn', 'desktopColor', 'accent', 'glassOpacity', 'gridOpacity', 'textScale',
  'cornerRadius', 'iconSize', 'showIconLabels', 'clock24h', 'showClock', 'showSeconds', 'clockSize', 'showDate',
  'showWidgets', 'widgetClock', 'widgetSrv', 'widgetTw', 'widgetLog', 'widgetSys', 'reduceMotion', 'uiFont', 'showLockClock', 'customAccent',
  'taskbarSize', 'taskbarOpacity', 'taskbarFull', 'taskbarAutoHide', 'showTaskbarClock', 'showTaskbarStatus', 'pillStyle',
  'taskbarAlign', 'builtinWallpaper', 'lockUseDesktop', 'lockBlur', 'lockDim', 'lockGreeting', 'lockShowDate',
  'showAvatarTaskbar', 'taskbarSearch', 'widgetSize',
  'clockStyle', 'clockAlign', 'clockColour', 'clockCustomColour', 'clockFont', 'dateFormat', 'datePosition', 'clockShadow', 'textShadow',
  'uiScale', 'performanceMode', 'customLook',
]);

function settingsFile(root) {
  return path.join(root, 'data', 'app-settings.json');
}

function readRaw(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(root), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Merges the given sections into the file. Other sections and keys are kept.
function write(root, patch) {
  const raw = readRaw(root);
  for (const [section, values] of Object.entries(patch)) {
    const current = raw[section] && typeof raw[section] === 'object' ? raw[section] : {};
    raw[section] = { ...current, ...values };
  }
  fs.mkdirSync(path.dirname(settingsFile(root)), { recursive: true });
  fs.writeFileSync(settingsFile(root), JSON.stringify(raw, null, 2));
}

// Same defaults and limits as local/manager.js, so the desktop app and the server agree.
function normalize(raw) {
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  };
  const ui = raw.interface || {};
  const security = raw.security || {};
  const performance = raw.performance || {};
  const startup = raw.startup || {};
  const updates = raw.updates || {};
  const look = raw.appearance || {};
  const folder = raw.folder || {};
  return {
    // The Folder app: how it opens, what it lists, how many database backups it keeps, and the extra viewers.
    folder: {
      mode: ['all', 'viewer', 'key'].includes(folder.mode) ? folder.mode : 'all',
      showShared: folder.showShared !== false,
      showExpired: folder.showExpired !== false,
      backupKeep: num(folder.backupKeep, 50, 5, 1000),
      viewers: Array.isArray(folder.viewers)
        ? [...new Set(folder.viewers.filter((v) => typeof v === 'string' && /^[a-z0-9_]{2,25}$/.test(v)))].slice(0, 200)
        : [],
    },
    interface: {
      language: LANGUAGES.includes(ui.language) ? ui.language : 'en',
      autoScrollLog: ui.autoScrollLog !== false,
      confirmStopServer: ui.confirmStopServer !== false,
    },
    security: {
      sessionTimeoutMinutes: num(security.sessionTimeoutMinutes, 60, 5, 480),
      // 0 means never. Otherwise the desktop locks after this many minutes without mouse or keyboard.
      autoLockMinutes: num(security.autoLockMinutes, 0, 0, 240),
      // Automatic database backups: 0 = off, otherwise hours between backups (see local/auto-backup.js).
      backupIntervalHours: [0, 6, 12, 24, 168].includes(Number(security.backupIntervalHours)) ? Number(security.backupIntervalHours) : 0,
      backupKeep: num(security.backupKeep, 7, 1, 30),
      lockOnWindowsLock: security.lockOnWindowsLock !== false,
    },
    performance: {
      cpuAlertPercent: num(performance.cpuAlertPercent, 85, 5, 100),
      ramLimitMb: num(performance.ramLimitMb, 1536, 256, 8192),
      networkAlertMbps: num(performance.networkAlertMbps, 50, 1, 1000),
    },
    startup: {
      startOnPc: startup.startOnPc === true,
      startWhenObsStarts: startup.startWhenObsStarts === true,
    },
    updates: {
      autoCheck: updates.autoCheck !== false,
      ignoredVersion: typeof updates.ignoredVersion === 'string' ? updates.ignoredVersion : null,
      remindAfter: typeof updates.remindAfter === 'string' ? updates.remindAfter : null,
    },
    appearance: {
      wallpaperFile: typeof look.wallpaperFile === 'string' && WALLPAPER_FILE.test(look.wallpaperFile) ? look.wallpaperFile : null,
      avatarFile: typeof look.avatarFile === 'string' && AVATAR_FILE.test(look.avatarFile) ? look.avatarFile : null,
      showAvatarTaskbar: look.showAvatarTaskbar === true,
      taskbarSearch: look.taskbarSearch !== false,
      widgetSize: WIDGET_SIZES.includes(look.widgetSize) ? look.widgetSize : 'compact',
      wallpaperFit: WALLPAPER_FITS.includes(look.wallpaperFit) ? look.wallpaperFit : 'cover',
      wallpaperDim: num(look.wallpaperDim, 25, 0, 80),
      wallpaperBlur: num(look.wallpaperBlur, 0, 0, 20),
      desktopColorOn: look.desktopColorOn === true,
      desktopColor: typeof look.desktopColor === 'string' && HEX_COLOUR.test(look.desktopColor) ? look.desktopColor.toLowerCase() : '#101214',
      accent: ACCENT_CHOICES.includes(look.accent) ? look.accent : 'signal',
      customAccent: typeof look.customAccent === 'string' && HEX_COLOUR.test(look.customAccent) ? look.customAccent.toLowerCase() : '#e4572e',
      glassOpacity: num(look.glassOpacity, 72, 0, 100),
      gridOpacity: num(look.gridOpacity, 72, 0, 100),
      textScale: num(look.textScale, 100, 85, 125),
      uiScale: UI_SCALES.includes(String(look.uiScale)) ? String(look.uiScale) : 'auto',
      cornerRadius: num(look.cornerRadius, 12, 0, 24),
      iconSize: ICON_SIZES.includes(look.iconSize) ? look.iconSize : 'medium',
      showIconLabels: look.showIconLabels !== false,
      clock24h: look.clock24h !== false,
      showClock: look.showClock !== false,
      showSeconds: look.showSeconds === true,
      clockSize: CLOCK_SIZES.includes(look.clockSize) ? look.clockSize : 'medium',
      clockStyle: CLOCK_STYLES.includes(look.clockStyle) ? look.clockStyle : 'plain',
      clockAlign: CLOCK_ALIGNS.includes(look.clockAlign) ? look.clockAlign : 'centre',
      clockColour: CLOCK_COLOURS.includes(look.clockColour) ? look.clockColour : 'ink',
      clockCustomColour: typeof look.clockCustomColour === 'string' && HEX_COLOUR.test(look.clockCustomColour) ? look.clockCustomColour.toLowerCase() : '#f1f2f4',
      clockFont: UI_FONTS.includes(look.clockFont) ? look.clockFont : 'mono',
      dateFormat: DATE_FORMATS.includes(look.dateFormat) ? look.dateFormat : 'long',
      datePosition: DATE_POSITIONS.includes(look.datePosition) ? look.datePosition : 'below',
      clockShadow: look.clockShadow === true,
      textShadow: look.textShadow === true,
      showDate: look.showDate !== false,
      uiFont: UI_FONTS.includes(look.uiFont) ? look.uiFont : 'system',
      showLockClock: look.showLockClock !== false,
      taskbarSize: TASKBAR_SIZES.includes(look.taskbarSize) ? look.taskbarSize : 'normal',
      taskbarOpacity: num(look.taskbarOpacity, 72, 40, 100),
      taskbarFull: look.taskbarFull === true,
      taskbarAutoHide: look.taskbarAutoHide === true,
      showTaskbarClock: look.showTaskbarClock !== false,
      showTaskbarStatus: look.showTaskbarStatus !== false,
      pillStyle: PILL_STYLES.includes(look.pillStyle) ? look.pillStyle : 'soft',
      taskbarAlign: TASKBAR_ALIGNS.includes(look.taskbarAlign) ? look.taskbarAlign : 'centre',
      builtinWallpaper: BUILTIN_WALLPAPERS.includes(look.builtinWallpaper) ? look.builtinWallpaper : 'ember',
      lockUseDesktop: look.lockUseDesktop === true,
      lockBlur: num(look.lockBlur, 8, 0, 20),
      lockDim: num(look.lockDim, 45, 0, 80),
      // Plain text only: no control characters, at most 40 characters.
      lockGreeting: typeof look.lockGreeting === 'string' ? look.lockGreeting.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : 'Welcome Back',
      lockShowDate: look.lockShowDate !== false,
      showWidgets: look.showWidgets !== false,
      widgetClock: look.widgetClock !== false,
      widgetSrv: look.widgetSrv !== false,
      widgetTw: look.widgetTw !== false,
      widgetLog: look.widgetLog !== false,
      widgetSys: look.widgetSys !== false,
      reduceMotion: look.reduceMotion === true,
      performanceMode: look.performanceMode === 'performance' ? 'performance' : 'custom',
      // The look kept while Performance mode is on, as JSON text, so Custom can bring it back.
      customLook: typeof look.customLook === 'string' && look.customLook.length <= 4000 ? look.customLook : '',
    },
  };
}

// The official update source. A value in .env (FISHINGBOT_UPDATE_REPOSITORY) overrides it.
const DEFAULT_UPDATE_REPOSITORY = 'ScatterTM/FishingBot-Desktop-by-ScatterR';

function view(root) {
  const settings = normalize(readRaw(root));
  settings.updates.repository = envValue(root, 'FISHINGBOT_UPDATE_REPOSITORY') || DEFAULT_UPDATE_REPOSITORY;
  return settings;
}

function envFile(root) {
  return path.join(root, '.env');
}

function envValue(root, key) {
  let text = '';
  try {
    text = fs.readFileSync(envFile(root), 'utf8');
  } catch {
    return '';
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[1] !== key) continue;
    const value = match[2];
    const quoted = value.length >= 2 && /^(["']).*\1$/.test(value);
    return quoted ? value.slice(1, -1) : value;
  }
  return '';
}

// Sets .env values, keeping every other line and comment as it is.
function setEnvValues(root, values) {
  let lines = [];
  try {
    lines = fs.readFileSync(envFile(root), 'utf8').split(/\r?\n/);
  } catch {
    /* no .env yet */
  }
  // Drop the empty last element that a trailing newline produces.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    const entry = `${key}=${value}`;
    if (index >= 0) lines[index] = entry;
    else lines.push(entry);
  }
  fs.writeFileSync(envFile(root), lines.join('\r\n') + '\r\n');
}

// The look without the wallpaper file: what Undo restores, and what gets remembered before a change.
function lookOf(appearance) {
  const look = {};
  for (const key of LOOK_KEYS) look[key] = appearance[key];
  return look;
}

// The look from before the last change, or null when nothing has been changed yet.
function previousAppearance(root) {
  const raw = readRaw(root);
  const previous = raw.appearance && raw.appearance.previous;
  if (!previous || typeof previous !== 'object') return null;
  return lookOf(normalize({ appearance: previous }).appearance);
}

module.exports = {
  AVATAR_FILE,
  LANGUAGES, ACCENTS, ACCENT_CHOICES, WALLPAPER_FITS, ICON_SIZES, CLOCK_SIZES, CLOCK_STYLES, CLOCK_ALIGNS, CLOCK_COLOURS, DATE_FORMATS, DATE_POSITIONS, UI_FONTS, TASKBAR_SIZES, TASKBAR_ALIGNS,
  BUILTIN_WALLPAPERS, ANIMATED_WALLPAPERS, WALLPAPER_FILE, LOOK_KEYS,
  normalize, write, view, envValue, setEnvValues, lookOf, previousAppearance,
};
