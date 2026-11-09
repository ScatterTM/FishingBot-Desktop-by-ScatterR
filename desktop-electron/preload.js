'use strict';

// The only bridge between the desktop page and the main process.
// Control Centre pages in <webview> tags get no bridge at all.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('fishingbot', {
  info: () => ipcRenderer.invoke('app:info'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getState: () => ipcRenderer.invoke('server:state'),
  getLogHistory: () => ipcRenderer.invoke('log:history'),
  startServer: () => ipcRenderer.invoke('server:start'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  restartServer: () => ipcRenderer.invoke('server:restart'),
  refreshServer: () => ipcRenderer.invoke('server:refresh'),
  reconnectTwitch: () => ipcRenderer.invoke('twitch:reconnect'),
  downloadAsset: (kind) => ipcRenderer.invoke('download:asset', kind),
  obsCatalog: () => ipcRenderer.invoke('obs:catalog'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (section, values) => ipcRenderer.invoke('settings:save', section, values),
  setUpdateRepository: (payload) => ipcRenderer.invoke('admin:repository', payload),
  changeAdminPassword: (payload) => ipcRenderer.invoke('admin:password', payload),
  generatePairingCode: (payload) => ipcRenderer.invoke('admin:pairCode', payload),
  unlinkTwitch: (payload) => ipcRenderer.invoke('admin:unlink', payload),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  authState: () => ipcRenderer.invoke('auth:state'),
  authLogin: (payload) => ipcRenderer.invoke('auth:login', payload),
  authSetup: (payload) => ipcRenderer.invoke('auth:setup', payload),
  authLock: () => ipcRenderer.invoke('auth:lock'),
  appearanceWallpaper: () => ipcRenderer.invoke('appearance:wallpaper'),
  uploadWallpaper: () => ipcRenderer.invoke('appearance:upload'),
  resetWallpaper: () => ipcRenderer.invoke('appearance:reset'),
  undoAppearance: () => ipcRenderer.invoke('appearance:undo'),
  strings: () => ipcRenderer.invoke('app:strings'),
  queueList: () => ipcRenderer.invoke('queue:list'),
  queueClear: () => ipcRenderer.invoke('queue:clear'),
  gameSnapshot: () => ipcRenderer.invoke('game:snapshot'),
  gameQueue: (values) => ipcRenderer.invoke('game:queue', values),
  openOfflineWindow: (kind) => ipcRenderer.invoke('offline:open', kind),
  twitchConfig: () => ipcRenderer.invoke('twitch:config'),
  saveTwitchConfig: (values) => ipcRenderer.invoke('twitch:save', values),
  lootAssets: () => ipcRenderer.invoke('loot:assets'),
  lootQueue: (payload) => ipcRenderer.invoke('loot:queue', payload),
  onState: subscribe('server:state'),
  onLog: subscribe('log:line'),
  onOnline: subscribe('server:online'),
  onWebOpen: subscribe('web:open'),
  onWindowsLocked: subscribe('windows:locked'),
  onUpdateStatus: subscribe('update:status'),
  takeUpdateNotice: () => ipcRenderer.invoke('update:takeNotice'),
  webAssets: () => ipcRenderer.invoke('web:assets'),
  appearanceAvatar: () => ipcRenderer.invoke('appearance:avatar'),
  uploadAvatar: () => ipcRenderer.invoke('appearance:uploadAvatar'),
  resetAvatar: () => ipcRenderer.invoke('appearance:resetAvatar'),
  systemUsage: () => ipcRenderer.invoke('system:usage'),
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupNow: () => ipcRenderer.invoke('backup:now'),
  dbList: () => ipcRenderer.invoke('db:list'),
  dbRead: (key, kind) => ipcRenderer.invoke('db:read', { key, kind }),
  dbSave: (payload) => ipcRenderer.invoke('db:save', payload),
  dbSearch: (payload) => ipcRenderer.invoke('db:search', payload),
  dbImportChoose: () => ipcRenderer.invoke('db-import:choose'),
  dbImportStart: (payload) => ipcRenderer.invoke('db-import:start', payload),
  dbImportStatus: (payload) => ipcRenderer.invoke('db-import:status', payload),
  dbImportCancel: (payload) => ipcRenderer.invoke('db-import:cancel', payload),
});
