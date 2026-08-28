const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('store', {
  load: () => ipcRenderer.invoke('playlists:load'),
  save: (playlists) => ipcRenderer.invoke('playlists:save', playlists),
});

contextBridge.exposeInMainWorld('titles', {
  fetch: (ids) => ipcRenderer.invoke('titles:fetch', ids),
});

contextBridge.exposeInMainWorld('playlist', {
  fetchFirst: (listId) => ipcRenderer.invoke('playlist:fetchFirst', listId),
  fetchMore: (cont) => ipcRenderer.invoke('playlist:fetchMore', cont),
  meta: (listId) => ipcRenderer.invoke('playlist:meta', listId),
});

contextBridge.exposeInMainWorld('uiSettings', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (settings) => ipcRenderer.invoke('settings:save', settings),
});

contextBridge.exposeInMainWorld('appinfo', {
  version: () => ipcRenderer.invoke('app:version'),
  refreshEmbedChrome: () => ipcRenderer.send('embed:refresh-chrome'),
});

contextBridge.exposeInMainWorld('winctl', {
  setFullScreen: (flag) => ipcRenderer.send('window:set-fullscreen', flag),
  cursor: () => ipcRenderer.invoke('window:cursor'),
  onFsKey: (callback) => ipcRenderer.on('window:fs-key', () => callback()),
});

contextBridge.exposeInMainWorld('lyrics', {
  update: (state) => ipcRenderer.send('lyrics:update', state),
  getData: () => ipcRenderer.invoke('lyrics:data:get'),
  setTheme: (theme) => ipcRenderer.send('app:theme', theme),
  onControl: (callback) => {
    const handler = (_event, action, value) => callback(action, value);
    ipcRenderer.on('lyrics:control', handler);
    return () => ipcRenderer.off('lyrics:control', handler);
  },
  onOpenSettings: (callback) => ipcRenderer.on('lyrics:open-settings', () => callback()),

});

contextBridge.exposeInMainWorld('lyricsctl', {
  toggle: () => ipcRenderer.send('lyrics:toggle'),
});

contextBridge.exposeInMainWorld('lyricsOverlay', {
  hide: () => ipcRenderer.send('lyrics:hide'),
  retry: () => ipcRenderer.send('lyrics:retry'),
  control: (action, value) => ipcRenderer.send('lyrics:control', action, value),
  search: (params) => ipcRenderer.invoke('lyrics:search', params),
  parse: (params) => ipcRenderer.invoke('lyrics:parse', params),
  select: (candidate) => ipcRenderer.invoke('lyrics:select', candidate),
  openSettings: () => ipcRenderer.send('lyrics:settings:open'),
  closeSettings: () => ipcRenderer.send('lyrics:settings:close'),
  setHit: (flag) => ipcRenderer.send('lyrics:hit', flag),
  drag: (flag) => ipcRenderer.send('lyrics:drag', flag),
  onTheme: (callback) => ipcRenderer.on('lyrics:theme', (_event, theme) => callback(theme)),
  getTheme: () => ipcRenderer.invoke('lyrics:theme:get'),
  getSettings: () => ipcRenderer.invoke('lyrics:settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('lyrics:settings:save', settings),
  resetSettings: () => ipcRenderer.invoke('lyrics:settings:reset'),
  shortcuts: () => ipcRenderer.invoke('lyrics:shortcuts'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('lyrics:state', handler);
    return () => ipcRenderer.off('lyrics:state', handler);
  },
  onData: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('lyrics:data', handler);
    return () => ipcRenderer.off('lyrics:data', handler);
  },
  onSettings: (callback) => {
    const handler = (_event, settings) => callback(settings);
    ipcRenderer.on('lyrics:settings', handler);
    return () => ipcRenderer.off('lyrics:settings', handler);
  },
  onDragging: (callback) => ipcRenderer.on('lyrics:dragging', (_event, flag) => callback(flag)),
  onFlash: (callback) => ipcRenderer.on('lyrics:flash', (_event, text) => callback(text)),
});

contextBridge.exposeInMainWorld('fallbackctl', {
  click: (x, y) => ipcRenderer.send('fallback:click', { x, y }),
});

contextBridge.exposeInMainWorld('account', {
  status: () => ipcRenderer.invoke('account:status'),
  login: () => ipcRenderer.invoke('account:login'),
  logout: () => ipcRenderer.invoke('account:logout'),
  playlists: () => ipcRenderer.invoke('account:playlists'),
  addToPlaylist: (playlistId, videoId) => ipcRenderer.invoke('account:addToPlaylist', { playlistId, videoId }),
});

contextBridge.exposeInMainWorld('ytsearch', {
  videos: (query) => ipcRenderer.invoke('search:videos', query),
});

contextBridge.exposeInMainWorld('recs', {
  fetch: (listId, token) => ipcRenderer.invoke('recs:fetch', { listId, token }),
});
