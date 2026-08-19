const { app, BrowserWindow, session, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// WSLg의 GPU 합성 버그로 영상이 창 밖에 그려지거나 검게 나오는 문제 방지 (Windows 네이티브에서는 불필요)
if (process.platform === 'linux') app.disableHardwareAcceleration();

// 폴백(워치페이지) 재생 시 사용자 제스처 없이도 자동 재생되도록
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 구글 로그인 차단 완화: 자동화 도구 흔적(navigator.webdriver 등)을 노출하지 않도록
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

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

// ── 구글 계정 연동: 로그인 창에서 만들어진 세션 쿠키로 유튜브 웹과 동일하게 인증한다 ──
// OAuth/API 키 없이, 웹 클라이언트의 SAPISIDHASH 서명(SHA1(ts + SAPISID + origin))을 그대로 사용.
// 쿠키는 Electron 기본 세션에 저장되어 앱을 재시작해도 로그인이 유지된다.
const YT_ORIGIN = 'https://www.youtube.com';

async function getSessionCookies() {
  try {
    return await session.defaultSession.cookies.get({ url: YT_ORIGIN });
  } catch {
    return [];
  }
}

// 로그인 상태면 인증 헤더(Cookie + SAPISIDHASH), 아니면 빈 객체.
// 재생목록/검색 요청에 항상 섞어 보내므로 로그인하면 비공개 재생목록(WL/LL 포함)도 열린다.
async function authHeaders() {
  const cookies = await getSessionCookies();
  const sapisid = cookies.find((c) => c.name === 'SAPISID') || cookies.find((c) => c.name === '__Secure-3PAPISID');
  if (!sapisid) return {};
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid.value} ${YT_ORIGIN}`).digest('hex');
  return {
    Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    Authorization: `SAPISIDHASH ${ts}_${hash}`,
    'X-Origin': YT_ORIGIN,
    Origin: YT_ORIGIN,
    'X-Goog-AuthUser': '0',
  };
}

// InnerTube API 키/클라이언트 버전: 홈 페이지에서 1회 추출 후 캐시 (페이지에 공개 포함된 값)
let innertubeCfg = null;

async function getInnertubeCfg() {
  if (innertubeCfg) return innertubeCfg;
  const res = await fetch(`${YT_ORIGIN}/?hl=ko`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8', ...(await authHeaders()) },
  });
  const html = await res.text();
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const ver = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
  if (!key) throw new Error('innertube config parse failed');
  innertubeCfg = { key: key[1], clientVersion: ver ? ver[1] : '2.20240701.00.00' };
  return innertubeCfg;
}

async function innertube(endpoint, body, opts) {
  const cfg = await getInnertubeCfg();
  const res = await fetch(`${YT_ORIGIN}/youtubei/v1/${endpoint}?key=${cfg.key}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...(opts && opts.anonymous ? {} : await authHeaders()),
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: cfg.clientVersion, hl: 'ko' } },
      ...body,
    }),
  });
  if (!res.ok) throw new Error(endpoint + ' HTTP ' + res.status);
  return res.json();
}

// ytInitialData류 트리에서 특정 키를 깊이 우선으로 찾는다 (중첩 경로가 자주 바뀌므로 경로 하드코딩 금지)
function findKey(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (node[key]) return node[key];
  for (const value of Object.values(node)) {
    const found = findKey(value, key);
    if (found) return found;
  }
  return null;
}

async function fetchAccountStatus() {
  const auth = await authHeaders();
  if (!auth.Cookie) return { loggedIn: false };
  try {
    const data = await innertube('account/account_menu', {});
    const hdr = findKey(data, 'activeAccountHeaderRenderer');
    if (hdr) {
      const name = (hdr.accountName && (hdr.accountName.simpleText || (hdr.accountName.runs || []).map((r) => r.text).join(''))) || '';
      let photo = '';
      try { photo = hdr.accountPhoto.thumbnails[0].url; } catch {}
      return { loggedIn: true, name, photo };
    }
  } catch {}
  // SAPISID 쿠키는 로그인 상태에서만 존재 — 메뉴 구조 파싱이 실패해도 로그인으로 취급
  return { loggedIn: true, name: '', photo: '' };
}

// 계정 재생목록 파싱: 신형 lockupViewModel(LOCKUP_CONTENT_TYPE_PLAYLIST/ALBUM)과
// 구형 gridPlaylistRenderer 모두 지원. 썸네일/곡 수는 노드 JSON 문자열에서 패턴으로 추출.
function lockupToPlaylist(vm) {
  if (!vm.contentId) return null;
  if (vm.contentType && !/PLAYLIST|ALBUM|PODCAST/.test(vm.contentType)) return null;
  const meta = vm.metadata && vm.metadata.lockupMetadataViewModel;
  const name = (meta && meta.title && meta.title.content) || '';
  const json = JSON.stringify(vm);
  const thumbMatch = json.match(/\/vi\/([\w-]{11})\//);
  let count = null;
  const cm = json.match(/동영상\s*([\d,]+)개/) || json.match(/([\d,]+)개의?\s*동영상/) || json.match(/([\d,]+)\s*videos?/);
  if (cm) count = parseInt(cm[1].replace(/,/g, ''), 10);
  return { listId: vm.contentId.replace(/^VL/, ''), name, thumb: thumbMatch ? thumbMatch[1] : null, count };
}

function gridToPlaylist(r) {
  if (!r.playlistId) return null;
  const name = (r.title && (r.title.simpleText || (r.title.runs && r.title.runs[0] && r.title.runs[0].text))) || '';
  let thumb = null;
  try {
    const m = JSON.stringify(r.thumbnail || r.thumbnails || '').match(/\/vi\/([\w-]{11})\//);
    if (m) thumb = m[1];
  } catch {}
  let count = null;
  try {
    const m = (r.videoCountShortText.simpleText || '').match(/[\d,]+/);
    if (m) count = parseInt(m[0].replace(/,/g, ''), 10);
  } catch {}
  return { listId: r.playlistId.replace(/^VL/, ''), name, thumb, count };
}

function collectAccountPlaylistNodes(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.lockupViewModel) {
    const item = lockupToPlaylist(node.lockupViewModel);
    if (item) out.items.push(item);
    return;
  }
  if (node.gridPlaylistRenderer || node.playlistRenderer) {
    const item = gridToPlaylist(node.gridPlaylistRenderer || node.playlistRenderer);
    if (item) out.items.push(item);
    return;
  }
  if (node.continuationItemViewModel || node.continuationItemRenderer) {
    const token = findToken(node.continuationItemViewModel || node.continuationItemRenderer);
    if (token && !out.continuation) out.continuation = token;
    return;
  }
  for (const value of Object.values(node)) collectAccountPlaylistNodes(value, out);
}

// 로그인한 계정의 재생목록 전체 (feed/playlists 페이지 + continuation)
async function fetchAccountPlaylists() {
  const auth = await authHeaders();
  if (!auth.Cookie) return [];
  const res = await fetch(`${YT_ORIGIN}/feed/playlists?hl=ko`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8', ...auth },
  });
  if (!res.ok) throw new Error('feed/playlists HTTP ' + res.status);
  const html = await res.text();
  const dataMatch = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s);
  if (!dataMatch) return [];
  const out = { items: [], continuation: null };
  collectAccountPlaylistNodes(JSON.parse(dataMatch[1]), out);
  let guard = 20;
  while (out.continuation && guard-- > 0) {
    const token = out.continuation;
    out.continuation = null;
    try {
      collectAccountPlaylistNodes(await innertube('browse', { continuation: token }), out);
    } catch {
      break;
    }
  }
  const seen = new Set();
  return out.items.filter((p) => p.listId && !seen.has(p.listId) && seen.add(p.listId));
}

// 유튜브 동영상 검색 (비로그인도 동작, params는 동영상 필터)
function collectSearchVideos(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.videoRenderer) {
    const r = node.videoRenderer;
    if (r.videoId) {
      out.push({
        id: r.videoId,
        title: (r.title && r.title.runs && r.title.runs[0] && r.title.runs[0].text) || '',
        author: (r.ownerText && r.ownerText.runs && r.ownerText.runs[0] && r.ownerText.runs[0].text) || '',
        duration: (r.lengthText && r.lengthText.simpleText) || '',
      });
    }
    return;
  }
  if (node.lockupViewModel) {
    const item = lockupToItem(node.lockupViewModel);
    if (item) {
      let duration = '';
      try {
        const m = JSON.stringify(node.lockupViewModel.contentImage || '').match(/"text":"(\d+:[\d:]+)"/);
        if (m) duration = m[1];
      } catch {}
      out.push({ ...item, duration });
    }
    return;
  }
  for (const value of Object.values(node)) collectSearchVideos(value, out);
}

async function searchVideos(query) {
  const data = await innertube('search', { query, params: 'EgIQAQ%3D%3D' });
  const out = [];
  collectSearchVideos(data, out);
  return out.slice(0, 30);
}

// 재생목록의 "맞춤 동영상" 추천 — 재생목록 페이지의 그 섹션과 동일한 데이터.
// 재생목록 browse 응답에는 continuation 토큰이 둘 있다: 하나는 영상 목록(다음 100곡),
// 다른 하나는 섹션 continuation으로 이 쪽이 "맞춤 동영상" 섹션을 싣는다. 영상 목록 토큰은
// playlistVideoListRenderer 서브트리 안에 있으므로, 그 밖에 있는 토큰이 섹션 토큰이다.
function findRecsToken(node, insideVideoList) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const t = findRecsToken(v, insideVideoList);
      if (t) return t;
    }
    return null;
  }
  if (!insideVideoList && node.continuationCommand && typeof node.continuationCommand.token === 'string') {
    return node.continuationCommand.token;
  }
  for (const [k, v] of Object.entries(node)) {
    const t = findRecsToken(v, insideVideoList || k === 'playlistVideoListRenderer');
    if (t) return t;
  }
  return null;
}

// 추천 응답에서 영상 항목 수집 (playlistVideoRenderer/videoRenderer/compactVideoRenderer 혼재)
function collectRecVideos(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((v) => collectRecVideos(v, out));
  const r = node.playlistVideoRenderer || node.videoRenderer || node.compactVideoRenderer;
  if (r && r.videoId) {
    const title = r.title && (r.title.simpleText || (r.title.runs && r.title.runs[0] && r.title.runs[0].text));
    const byline = r.shortBylineText || r.ownerText || r.longBylineText;
    const author = byline && byline.runs && byline.runs[0] && byline.runs[0].text;
    out.push({
      id: r.videoId,
      title: title || '',
      author: author || '',
      duration: (r.lengthText && r.lengthText.simpleText) || '',
    });
    return;
  }
  for (const v of Object.values(node)) collectRecVideos(v, out);
}

// 재생목록 추천 한 배치. token이 없으면 재생목록 browse에서 섹션 토큰을 찾아 첫 배치를,
// 있으면 그 토큰으로 다음 배치를 받는다. 응답의 다음 continuation을 next로 돌려줘
// 새로고침 때마다 다른 추천을 보여줄 수 있게 한다.
async function fetchPlaylistRecs(listId, token) {
  let contToken = token;
  if (!contToken) {
    const data = await innertube('browse', { browseId: 'VL' + String(listId).replace(/^VL/, '') });
    contToken = findRecsToken(data, false);
    if (!contToken) return { items: [], next: null };
  }
  // 같은 섹션 토큰을 다시 부르면 유튜브가 매번 다른 추천 묶음을 준다 — 새로고침이 이걸로 동작.
  // (응답 안 continuation을 이어받으면 영상 목록 쪽으로 흘러 재생목록 곡만 오므로 그러지 않는다.)
  const res = await innertube('browse', { continuation: contToken });
  const items = [];
  collectRecVideos(res, items);
  const seen = new Set();
  const deduped = items.filter((v) => v.id && !seen.has(v.id) && seen.add(v.id));
  return { items: deduped, next: contToken };
}



// 계정 재생목록에 곡 추가 (유튜브 웹의 "재생목록에 저장"과 동일한 엔드포인트)
async function addToPlaylist(playlistId, videoId) {
  const auth = await authHeaders();
  if (!auth.Cookie) return { ok: false, error: '로그인이 필요합니다' };
  try {
    const data = await innertube('browse/edit_playlist', {
      playlistId: String(playlistId).replace(/^VL/, ''),
      actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
    });
    return { ok: !!data && data.status === 'STATUS_SUCCEEDED' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 로그인 창: 구글 로그인 페이지를 별도 창으로 띄우고, SAPISID 쿠키가 생기면 성공으로 판단.
// 구글은 임베디드 브라우저의 로그인을 "안전하지 않은 브라우저"로 차단하는데, 크롬 UA로
// 위장해도 Sec-CH-UA(클라이언트 힌트)와 크롬 전용 API 검사에서 걸린다(실측). 그래서
// 로그인 창과 accounts.google.com 요청에는 Firefox UA를 쓰고 힌트 헤더를 제거한다 —
// Firefox에는 해당 검사가 적용되지 않아 통과된다 (Electron 앱들의 통용 우회법).
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';
let loginWin = null;

function openLoginWindow(parent) {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return Promise.resolve({ loggedIn: false });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    loginWin = new BrowserWindow({
      width: 500,
      height: 740,
      parent,
      autoHideMenuBar: true,
      title: 'Google 계정으로 로그인',
      backgroundColor: '#ffffff',
    });
    loginWin.webContents.setUserAgent(FIREFOX_UA);
    let closing = false;
    const check = async () => {
      if (closing) return;
      const cookies = await getSessionCookies();
      if (cookies.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) {
        closing = true;
        // 마지막 리디렉트가 나머지 쿠키를 마저 심도록 잠시 두었다가 닫고,
        // 쿠키를 즉시 디스크에 기록해 강제 종료돼도 로그인이 유지되게 한다
        setTimeout(async () => {
          try { await session.defaultSession.cookies.flushStore(); } catch {}
          finish({ loggedIn: true });
          if (loginWin && !loginWin.isDestroyed()) loginWin.close();
        }, 1500);
      }
    };
    loginWin.webContents.on('did-navigate', check);
    loginWin.on('closed', () => {
      loginWin = null;
      finish({ loggedIn: closing }); // 성공 감지 후 닫힘 대기 중에 닫혀도 성공으로 처리
    });
    loginWin.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&hl=ko&continue=' + encodeURIComponent(YT_ORIGIN + '/?hl=ko'));
  });
}

async function accountLogout() {
  await session.defaultSession.clearStorageData({ storages: ['cookies'] });
}

// 첫 페이지(~100곡)만 파싱해 즉시 반환 — 렌더러는 이 시점에 바로 재생을 시작하고,
// 나머지는 cont 정보로 fetchPlaylistMore를 반복 호출해 백그라운드로 이어 받는다.
async function fetchPlaylistFirst(listId) {
  const res = await fetch(`https://www.youtube.com/playlist?list=${listId}&hl=ko`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8', ...(await authHeaders()) },
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
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(await authHeaders()) },
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
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8', ...(await authHeaders()) },
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

let webviewWC = null; // 폴백 웹뷰의 webContents (창에 하나뿐)

app.whenReady().then(async () => {
  const port = await startServer();
  // 광고/추적 도메인 차단 — 단, 폴백(워치페이지) 웹뷰의 요청은 예외.
  // 웹뷰에서까지 광고 요청을 차단하면 유튜브가 광고 차단으로 감지해
  // "광고 차단 프로그램은 YouTube에서 허용되지 않습니다" 팝업으로 재생을 막는다.
  // 웹뷰의 광고는 주입 스크립트가 무음·16배속·자동 스킵으로 처리하므로 요청은 통과시킨다.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: AD_URL_PATTERNS },
    (details, callback) => callback({
      cancel: !(webviewWC && !webviewWC.isDestroyed() && details.webContentsId === webviewWC.id),
    })
  );

  // 구글 로그인 흐름은 Firefox로 위장 — UA 교체 + 크로미움 클라이언트 힌트(Sec-CH-UA) 제거.
  // (크롬 UA를 흉내 내면 힌트 불일치·크롬 전용 API 검사로 "안전하지 않은 브라우저" 차단)
  // accounts.* 도메인은 항상 적용하고, 로그인 흐름이 경유하는 나머지 구글 도메인
  // (ogs.google.com·gstatic 등)은 로그인 창에서 나온 요청에만 적용해 위장을 흐름 전체에서
  // 일관되게 유지한다. 그 외(웹뷰·임베드) 요청은 손대지 않는다.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://accounts.google.com/*', '*://accounts.youtube.com/*', '*://*.google.com/*',
        '*://*.gstatic.com/*', '*://*.googleusercontent.com/*', '*://*.youtube.com/*',
      ],
    },
    (details, callback) => {
      const fromLoginWin = loginWin && !loginWin.isDestroyed()
        && details.webContentsId === loginWin.webContents.id;
      const isAccounts = /^https:\/\/accounts\.(google|youtube)\.com\//.test(details.url);
      if (!fromLoginWin && !isAccounts) return callback({ requestHeaders: details.requestHeaders });
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) {
        if (/^sec-ch-ua/i.test(key)) delete headers[key];
      }
      headers['User-Agent'] = FIREFOX_UA;
      callback({ requestHeaders: headers });
    }
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
  // 구글 계정 연동 + 유튜브 검색
  ipcMain.handle('account:status', () => fetchAccountStatus());
  ipcMain.handle('account:login', (event) => openLoginWindow(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('account:logout', () => accountLogout());
  ipcMain.handle('account:playlists', () => fetchAccountPlaylists());
  ipcMain.handle('account:addToPlaylist', (_event, p) => addToPlaylist(p.playlistId, p.videoId));
  ipcMain.handle('search:videos', (_event, query) => searchVideos(query));
  ipcMain.handle('recs:fetch', (_event, p) => fetchPlaylistRecs(p.listId, p.token));
  ipcMain.on('window:set-fullscreen', (event, flag) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setFullScreen(!!flag);
  });
  // 몰입 모드 해제 버튼 페이드용: 커서가 iframe/webview 위에 있어도 움직임을 알 수 있게 좌표 제공
  ipcMain.handle('window:cursor', () => screen.getCursorScreenPoint());

  // 직접 재생(webview)에서 누른 f 키를 가로채 앱 전체화면 토글로 전달
  // (preventDefault로 유튜브 자체 전체화면 단축키와의 충돌을 차단)
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

// 종료 전에 쿠키를 디스크로 강제 플러시 — 크로미움의 지연 저장 때문에 로그인 직후
// 앱을 닫으면 세션 쿠키가 유실돼 다음 실행에서 로그아웃되는 문제 방지
app.on('before-quit', () => {
  session.defaultSession.cookies.flushStore().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
