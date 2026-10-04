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
  onFullScreen: (callback) => ipcRenderer.on('window:fullscreen', (_event, flag) => callback(!!flag)),
  disableAdBlock: () => ipcRenderer.send('adblock:disable'),
  // 오디오 가드: 볼륨 상한·이퀄라이저 상태를 모든 유튜브 프레임에 뿌리고, 임베드에 가드가 심겼는지 확인
  setAudio: (state) => ipcRenderer.send('audio:set', state),
  audioGuard: () => ipcRenderer.invoke('audio:guard'),
});

contextBridge.exposeInMainWorld('lyrics', {
  update: (state) => ipcRenderer.send('lyrics:update', state),
  prefetch: (info) => ipcRenderer.send('lyrics:prefetch', info), // 다음 곡 가사 미리 찾기
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
  deleteLyrics: () => ipcRenderer.invoke('lyrics:delete'), // 지금 곡의 가사만 삭제(저장본 포함)
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
  // 곡별 가사 싱크 보정(ms) — Alt+A/D
  onOffset: (callback) => ipcRenderer.on('lyrics:offset', (_event, ms) => callback(ms)),
  onScroll: (callback) => ipcRenderer.on('lyrics:scroll', (_event, delta) => callback(delta)), // Alt+Z/X
  getOffset: () => ipcRenderer.invoke('lyrics:offset:get'),
  // 플로팅 창 레이아웃 프리셋
  presets: {
    list: () => ipcRenderer.invoke('lyrics:presets:list'),
    save: (name) => ipcRenderer.invoke('lyrics:presets:save', name),
    apply: (name) => ipcRenderer.invoke('lyrics:presets:apply', name),
    remove: (name) => ipcRenderer.invoke('lyrics:presets:delete', name),
  },
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
