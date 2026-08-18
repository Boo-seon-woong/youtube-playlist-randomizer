const { app, BrowserWindow, session, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// WSLg의 GPU 합성 버그로 영상이 창 밖에 그려지거나 검게 나오는 문제 방지 (Windows 네이티브에서는 불필요)
if (process.platform === 'linux') app.disableHardwareAcceleration();

// 폴백(워치페이지) 재생 시 사용자 제스처 없이도 자동 재생되도록
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const STORE_FILE = () => path.join(app.getPath('userData'), 'playlists.json');
const TITLE_CACHE_FILE = () => path.join(app.getPath('userData'), 'titles.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json'); // 디자인 설정 (테마 색)

// Block known ad/tracking domains so the embedded player stays ad-free.
const AD_URL_PATTERNS = [
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.google-analytics.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.googletagservices.com/*',
  '*://*.moatads.com/*',
  '*://*.adservice.google.com/*',
];

function loadPlaylists() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8'));
  } catch {
    return [];
  }
}

function savePlaylists(playlists) {
  fs.mkdirSync(path.dirname(STORE_FILE()), { recursive: true });
  fs.writeFileSync(STORE_FILE(), JSON.stringify(playlists, null, 2));
}

// YouTube blocks embeds without an HTTP referer (error 153), so the UI must be
// served over http://127.0.0.1 instead of file://.
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const filePath = path.join(__dirname, path.normalize(urlPath));
      if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// 영상 제목/아티스트 조회: 유튜브 oEmbed(키 불필요) + 디스크 캐시
let titleCache = null;

async function fetchTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.title ? { title: data.title, author: data.author_name || '' } : null;
  } catch {
    return null;
  }
}

async function fetchTitles(ids) {
  if (!titleCache) {
    try {
      titleCache = JSON.parse(fs.readFileSync(TITLE_CACHE_FILE(), 'utf8'));
    } catch {
      titleCache = {};
    }
  }
  const result = {};
  const toFetch = [];
  for (const id of ids) {
    if (titleCache[id]) result[id] = titleCache[id];
    else toFetch.push(id);
  }
  await Promise.all(toFetch.map(async (id) => {
    const title = await fetchTitle(id);
    result[id] = title;
    if (title) titleCache[id] = title;
  }));
  if (toFetch.length > 0) {
    fs.mkdirSync(path.dirname(TITLE_CACHE_FILE()), { recursive: true });
    fs.writeFileSync(TITLE_CACHE_FILE(), JSON.stringify(titleCache));
  }
  return result;
}

// 재생목록 전체 곡 목록 수집: iframe 플레이어의 getPlaylist()는 200곡까지만 노출하므로
// 재생목록 페이지의 ytInitialData를 파싱하고 continuation API를 따라가 전곡을 가져온다.
// 첫 페이지와 continuation을 별도 IPC로 나눠, 렌더러가 첫 ~100곡으로 즉시 재생을 시작하고
// 나머지는 백그라운드로 스트리밍한다. 신형 lockupViewModel / 구형 playlistVideoRenderer 모두 지원.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function lockupToItem(vm) {
  if (!vm.contentId || (vm.contentType && vm.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO')) return null;
  const meta = vm.metadata && vm.metadata.lockupMetadataViewModel;
  const title = meta && meta.title && meta.title.content;
  let author = '';
  try {
    author = meta.metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].text.content || '';
  } catch {}
  return { id: vm.contentId, title: title || '', author };
}

function rendererToItem(r) {
  if (!r.videoId || r.isPlayable === false) return null;
  const title = r.title && r.title.runs && r.title.runs[0] && r.title.runs[0].text;
  const author = r.shortBylineText && r.shortBylineText.runs && r.shortBylineText.runs[0] && r.shortBylineText.runs[0].text;
  return { id: r.videoId, title: title || '', author: author || '' };
}

function findToken(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.continuationCommand && typeof node.continuationCommand.token === 'string') {
    return node.continuationCommand.token;
  }
  for (const value of Object.values(node)) {
    const token = findToken(value);
    if (token) return token;
  }
  return null;
}

function collectPlaylistNodes(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.lockupViewModel) {
    const item = lockupToItem(node.lockupViewModel);
    if (item) out.items.push(item);
    return;
  }
  if (node.playlistVideoRenderer) {
    const item = rendererToItem(node.playlistVideoRenderer);
    if (item) out.items.push(item);
    return;
  }
  if (node.continuationItemViewModel || node.continuationItemRenderer) {
    const token = findToken(node.continuationItemViewModel || node.continuationItemRenderer);
    if (token && !out.continuation) out.continuation = token;
    return;
  }
  for (const value of Object.values(node)) collectPlaylistNodes(value, out);
}

// 첫 페이지(~100곡)만 파싱해 즉시 반환 — 렌더러는 이 시점에 바로 재생을 시작하고,
// 나머지는 cont 정보로 fetchPlaylistMore를 반복 호출해 백그라운드로 이어 받는다.
async function fetchPlaylistFirst(listId) {
  const res = await fetch(`https://www.youtube.com/playlist?list=${listId}&hl=ko`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' },
  });
  if (!res.ok) throw new Error('playlist page HTTP ' + res.status);
  const html = await res.text();
  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const verMatch = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
  const dataMatch = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s);
  if (!keyMatch || !dataMatch) throw new Error('playlist page parse failed');

  const out = { items: [], continuation: null };
  collectPlaylistNodes(JSON.parse(dataMatch[1]), out);
  return {
    items: out.items,
    cont: out.continuation
      ? { token: out.continuation, key: keyMatch[1], clientVersion: verMatch ? verMatch[1] : '2.20240701.00.00' }
      : null,
  };
}

// continuation 한 단계(다음 ~100곡)만 따라간다
async function fetchPlaylistMore(cont) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${cont.key}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: cont.clientVersion, hl: 'ko' } },
      continuation: cont.token,
    }),
  });
  if (!res.ok) throw new Error('continuation HTTP ' + res.status);
  const out = { items: [], continuation: null };
  collectPlaylistNodes(await res.json(), out);
  return {
    items: out.items,
    cont: out.continuation ? { ...cont, token: out.continuation } : null,
  };
}

// 헤더의 "동영상 N개" 텍스트에서 총 곡 수 추출. 완전일치로만 매칭해야 한다 —
// 페이지 전체에는 UI 언어팩의 "동영상 1개..." 같은 가짜 매치가 앞서 존재한다.
function findVideoCountText(node) {
  if (!node || typeof node !== 'object') return null;
  for (const value of Object.values(node)) {
    if (typeof value === 'string') {
      const m = value.match(/^동영상\s*([\d,]+)개$/) || value.match(/^([\d,]+)개의\s*동영상$/) || value.match(/^([\d,]+)\s*videos?$/);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    } else {
      const found = findVideoCountText(value);
      if (found != null) return found;
    }
  }
  return null;
}

// 사이드바 표시용 경량 메타: 재생목록 첫 페이지만 요청해 첫 곡 ID(썸네일용)와 총 곡 수를 얻는다
async function fetchPlaylistMeta(listId) {
  const res = await fetch(`https://www.youtube.com/playlist?list=${listId}&hl=ko`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const dataMatch = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s);
  const out = { items: [], continuation: null };
  let count = null;
  if (dataMatch) {
    try {
      const data = JSON.parse(dataMatch[1]);
      collectPlaylistNodes(data, out);
      // 곡 수 텍스트는 헤더(신형 pageHeaderViewModel) 서브트리에서만 찾는다
      count = findVideoCountText(data.header);
      if (count == null) count = findVideoCountText(data.sidebar);
    } catch {}
  }
  if (count == null && out.items.length > 0 && !out.continuation) count = out.items.length;
  return { firstVideoId: out.items.length > 0 ? out.items[0].id : null, count };
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1420,
    height: 800,
    title: 'YouTube Music',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, // 임베드 차단 곡의 워치페이지 폴백 재생용
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(async () => {
  const port = await startServer();
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: AD_URL_PATTERNS },
    (details, callback) => callback({ cancel: true })
  );

  ipcMain.handle('playlists:load', () => loadPlaylists());
  ipcMain.handle('playlists:save', (_event, playlists) => savePlaylists(playlists));
  // 디자인 설정: 렌더러 localStorage는 서버 포트가 매번 바뀌어(오리진 변경) 유지되지 않으므로 파일로 저장
  ipcMain.handle('settings:load', () => {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('settings:save', (_event, settings) => {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
  });
  ipcMain.handle('titles:fetch', (_event, ids) => fetchTitles(ids));
  ipcMain.handle('playlist:fetchFirst', (_event, listId) => fetchPlaylistFirst(listId));
  ipcMain.handle('playlist:fetchMore', (_event, cont) => fetchPlaylistMore(cont));
  ipcMain.handle('playlist:meta', (_event, listId) => fetchPlaylistMeta(listId));
  ipcMain.on('window:set-fullscreen', (event, flag) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setFullScreen(!!flag);
  });
  // 몰입 모드 해제 버튼 페이드용: 커서가 iframe/webview 위에 있어도 움직임을 알 수 있게 좌표 제공
  ipcMain.handle('window:cursor', () => screen.getCursorScreenPoint());

  // 직접 재생(webview)에서 누른 f 키를 가로채 앱 전체화면 토글로 전달
  // (preventDefault로 유튜브 자체 전체화면 단축키와의 충돌을 차단)
  let webviewWC = null; // 폴백 웹뷰의 webContents (창에 하나뿐)
  app.on('web-contents-created', (_event, wc) => {
    if (wc.getType() !== 'webview') return;
    webviewWC = wc;
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key.toLowerCase() === 'f'
          && !input.control && !input.alt && !input.meta && !input.shift) {
        event.preventDefault();
        if (wc.hostWebContents) wc.hostWebContents.send('window:fs-key');
      }
    });
  });

  // 광고 스킵 버튼을 신뢰된 네이티브 마우스 입력으로 클릭 —
  // 페이지 안에서 부르는 click()은 유튜브가 신뢰되지 않은 이벤트로 무시할 수 있다
  ipcMain.on('fallback:click', (_event, pt) => {
    if (!webviewWC || webviewWC.isDestroyed()) return;
    const x = Math.round(Number(pt && pt.x));
    const y = Math.round(Number(pt && pt.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    webviewWC.sendInputEvent({ type: 'mouseMove', x, y });
    webviewWC.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    webviewWC.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  });

  createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
