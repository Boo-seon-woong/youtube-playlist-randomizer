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

contextBridge.exposeInMainWorld('winctl', {
  setFullScreen: (flag) => ipcRenderer.send('window:set-fullscreen', flag),
  cursor: () => ipcRenderer.invoke('window:cursor'),
  onFsKey: (callback) => ipcRenderer.on('window:fs-key', () => callback()),
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
