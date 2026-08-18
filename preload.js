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
