const { app, BrowserWindow, session, ipcMain, screen, globalShortcut, webFrameMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { hasHangul, buildLyricQueries, resolveLyricCandidate, findLyricsCandidates, searchAllLyrics, lyricFailureCount } = require('./lyrics-search');
const { LyricsStore, localListIds } = require('./lyrics-store');
const { SyncEngine } = require('./lyrics-sync');
const asrRunner = require('./asr');
const { evenTimes } = require('./lyrics-align');
const { translateLines: webTranslateLines } = require('./web-translate');

// WSLg의 GPU 합성 버그로 영상이 창 밖에 그려지거나 검게 나오는 문제 방지 (Windows 네이티브에서는 불필요)
if (process.platform === 'linux') app.disableHardwareAcceleration();

// 폴백(워치페이지) 재생 시 사용자 제스처 없이도 자동 재생되도록
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 구글 로그인 차단 완화: 자동화 도구 흔적(navigator.webdriver 등)을 노출하지 않도록
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// 창을 최소화하거나 다른 프로그램에 가려도 재생이 계속되도록 크로미움의 백그라운드 절전 동작을 끈다.
// 숨겨진 페이지는 타이머가 1초 → (5분 뒤) 1분 간격까지 늦춰지는데(Intensive Wake Up Throttling),
// 앱의 곡 종료 감지(1초 폴링)와 워치페이지 광고 스킵(100ms 인터벌)이 여기에 걸리면 곡이 끝나도
// 다음 곡으로 넘어가지 않고 광고도 넘기지 못해 "재생이 멈춘" 것처럼 보인다. 음소거 영상(가사 창의
// 미러 영상)은 아예 일시정지된다. Windows의 가림(occlusion) 판정도 같은 경로라 함께 끈다.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'IntensiveWakeUpThrottling,CalculateNativeWinOcclusion');

const STORE_FILE = () => path.join(app.getPath('userData'), 'playlists.json');
const TITLE_CACHE_FILE = () => path.join(app.getPath('userData'), 'titles.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json'); // 디자인 설정 (테마 색)
const LYRICS_BOUNDS_FILE = () => path.join(app.getPath('userData'), 'lyrics-window.json');
const LYRICS_SETTINGS_FILE = () => path.join(app.getPath('userData'), 'lyrics-settings.json');
const LYRICS_OFFSETS_FILE = () => path.join(app.getPath('userData'), 'lyrics-offsets.json'); // 곡별 가사 싱크 보정
const LYRICS_PRESETS_FILE = () => path.join(app.getPath('userData'), 'lyrics-presets.json'); // 플로팅 창 레이아웃 프리셋

// 추적 도메인만 막는다. **광고 송출 도메인(doubleclick·googlesyndication 등)은 더 이상 막지 않는다** —
// 요청 실패는 유튜브의 광고 차단 감지에 그대로 걸려 재생 자체가 막히기 때문이다. 광고는 대신
// adprune-preload.js / AD_PRUNE_SNIPPET이 플레이어 응답에서 광고 데이터를 걷어내 없앤다.
const AD_URL_PATTERNS = [
  '*://*.google-analytics.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.moatads.com/*',
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

// ── 가사: ALSong 우선, LRCLIB 보조 ──
// YouTube IFrame API는 Spotify/YouTube Music처럼 가사 데이터를 제공하지 않으므로
// 현재 곡의 제목·아티스트로 외부 가사 DB를 조회하고, 재생 시간은 renderer가 전달한다.

const DEFAULT_LYRICS_SETTINGS = {
  width: 760,
  height: 240,
  backgroundOpacity: 94,
  uiOpacity: 100, // 가사 칩을 제외한 인터페이스(앨범/영상·곡 정보·재생바·컨트롤·상태 문구) 불투명도
  fontSize: 16,
  showProgressBar: true,
  showPlaybackControls: true,
  showPreviousButton: true,
  showPauseButton: true,
  showNextButton: true,
  showVolumeButton: true,
  showLyrics: true, // 오른쪽 가사 영역 (끄면 왼쪽 사각형만 남는다)
  machineTranslate: true, // (구버전 키 — foreignMode로 대체)
  // 한국어 가사가 없는 외국어 가사의 보조 줄: 'pron'(원어+한글 발음) | 'pron+web'·'web'(+웹 번역) | 'pron+tr'·'tr'(+내장 모델 번역) | 'off'(원어만)
  // 발음은 일본어만(사전 기반, 즉시). 웹 번역은 Bing/구글 무료 번역(web-translate.js, 곡당 3~6초), 내장 모델은 오프라인이지만
  // 무겁고(RAM 1.2GB) 느리다. 기본은 발음만. 영어는 발음·번역 모두 하지 않는다.
  foreignMode: 'pron+web',
  foreignModeV: 2, // 기본값을 pron → pron+web으로 바꾼 버전 표시(예전 기본값 그대로 저장된 설정만 1회 옮긴다)
  // 자동 싱크: 싱크 없는 텍스트 가사를 재생되는 소리(음성 인식)에 맞추고, 싱크 가사도 소리로 곡이 맞는지·어긋남을 확인한다
  autoSync: true,
  showTrackInfo: true,
  coverMode: 'art', // 왼쪽 사각형: 'none' | 'art'(앨범 이미지) | 'video'(영상 작게 — 음소거 미러 임베드)
  videoFit: 'cover', // 영상 맞춤: 'cover'(상하 기준으로 채우고 좌우는 잘림) | 'contain'(전체가 보이도록)
  fontFamily: 'default', // 가사 글꼴 (LYRIC_FONTS 키)
  showStatus: true,
  alwaysOnTop: true,
  clickThrough: false, // 잠금 모드: 창을 눌러도 아래 프로그램(게임 등)으로 클릭이 지나간다
};
const COVER_MODES = ['none', 'art', 'video'];
const FOREIGN_MODES = ['pron', 'pron+web', 'web', 'pron+tr', 'tr', 'off'];
const VIDEO_FITS = ['cover', 'contain'];
// 가사 글꼴 후보 — 웹폰트(Google Fonts)라 오프라인이면 시스템 글꼴로 대체된다
const LYRIC_FONTS = ['default', 'noto-sans', 'noto-serif', 'nanum-myeongjo', 'gowun-batang', 'gowun-dodum', 'ibm-plex'];

let lyricsSettings = { ...DEFAULT_LYRICS_SETTINGS };

function normalizeLyricsSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const number = (key, min, max) => {
    const parsed = Number(source[key]);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : DEFAULT_LYRICS_SETTINGS[key];
  };
  const boolean = (key) => source[key] == null ? DEFAULT_LYRICS_SETTINGS[key] : !!source[key];
  // 구버전 설정의 showAlbumArt(true/false) → coverMode('art'/'none')
  const coverMode = COVER_MODES.includes(source.coverMode) ? source.coverMode
    : source.showAlbumArt === false ? 'none' : DEFAULT_LYRICS_SETTINGS.coverMode;
  return {
    width: number('width', 360, 1400),
    height: number('height', 150, 700),
    backgroundOpacity: number('backgroundOpacity', 0, 100),
    uiOpacity: number('uiOpacity', 0, 100),
    fontSize: number('fontSize', 10, 48),
    showProgressBar: boolean('showProgressBar'),
    showPlaybackControls: boolean('showPlaybackControls'),
    showPreviousButton: boolean('showPreviousButton'),
    showPauseButton: boolean('showPauseButton'),
    showNextButton: boolean('showNextButton'),
    showVolumeButton: boolean('showVolumeButton'),
    showLyrics: boolean('showLyrics'),
    machineTranslate: boolean('machineTranslate'),
    // 사용자가 웹 번역 품질을 확인하고 "번역 없는 가사에는 웹 번역을 더한다"로 정했다(2026-10-04) — 예전 기본값 'pron'을
    // 그대로 갖고 있던 설정은 한 번 pron+web으로 옮긴다(직접 고른 다른 값은 그대로)
    foreignMode: source.foreignModeV !== 2 && (source.foreignMode == null || source.foreignMode === 'pron') ? 'pron+web'
      : FOREIGN_MODES.includes(source.foreignMode) ? source.foreignMode : DEFAULT_LYRICS_SETTINGS.foreignMode,
    foreignModeV: 2,
    autoSync: boolean('autoSync'),
    showTrackInfo: boolean('showTrackInfo'),
    coverMode,
    videoFit: VIDEO_FITS.includes(source.videoFit) ? source.videoFit : DEFAULT_LYRICS_SETTINGS.videoFit,
    fontFamily: LYRIC_FONTS.includes(source.fontFamily) ? source.fontFamily : DEFAULT_LYRICS_SETTINGS.fontFamily,
    showStatus: boolean('showStatus'),
    alwaysOnTop: boolean('alwaysOnTop'),
    clickThrough: boolean('clickThrough'),
  };
}

function loadLyricsSettings() {
  try {
    return normalizeLyricsSettings(JSON.parse(fs.readFileSync(LYRICS_SETTINGS_FILE(), 'utf8')));
  } catch {
    return { ...DEFAULT_LYRICS_SETTINGS };
  }
}

// 크기 슬라이더를 드래그하면 값이 초당 수십 번 바뀌므로 디스크 쓰기는 묶어서 한 번만 한다
let lyricsSettingsWriteTimer = null;

function writeLyricsSettings() {
  clearTimeout(lyricsSettingsWriteTimer);
  lyricsSettingsWriteTimer = null;
  fs.mkdirSync(path.dirname(LYRICS_SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(LYRICS_SETTINGS_FILE(), JSON.stringify(lyricsSettings, null, 2));
}

function saveLyricsSettings() {
  clearTimeout(lyricsSettingsWriteTimer);
  lyricsSettingsWriteTimer = setTimeout(writeLyricsSettings, 250);
}

let lyricsWindow = null;
let lyricsSettingsWindow = null; // 플로팅 창의 톱니로 여는 별도 설정 팝업 (플로팅 창과 같은 분위기)
let lyricsServerPort = null;
// 창을 드래그하는 동안에만 히트박스 테두리를 보여주기 위한 상태 — 창이 투명해서 어디를 잡고 있는지
// 알기 어렵다. 드래그는 -webkit-app-region이 OS로 넘기므로 렌더러가 알 수 없고, 메인의 'move'로만 안다.
let lyricsDragging = false;
let lyricsDragTimer = null;
// Windows에서 setAlwaysOnTop의 기본 level('floating')은 창을 작업 표시줄 뒤에 두려고 z-order를 다시
// 끼워 넣는데, 이때 TOPMOST가 풀려 플로팅 창이 메인 창 뒤로 숨는다(Electron 41 실측 — isAlwaysOnTop()=false).
// 'screen-saver' level은 그 경로를 타지 않아 최상위가 유지된다. macOS/Linux에서는 level이 z-order에 영향 없음.
const LYRICS_TOP_LEVEL = process.platform === 'win32' ? 'screen-saver' : 'floating';
let lyricsState = { id: '', title: '', artist: '', status: 'idle', progress: 0, duration: 0, coverUrl: '', volume: 100 };
let lyricsData = null;
let lyricsKey = '';
let lyricsRequestId = 0;
let lyricsLoadingKey = '';
const lyricsCache = new Map();
let lyricsDataSentToMain; // 메인 창(가사 보기 오버레이)에 마지막으로 보낸 가사 객체 — 바뀔 때만 전송

function sendLyricsToMain() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  if (lyricsDataSentToMain === lyricsData) return;
  lyricsDataSentToMain = lyricsData;
  mainWindow.webContents.send('lyrics:data', lyricsData);
}

function sendLyricsToWindow() {
  sendLyricsToMain();
  if (!lyricsWindow || lyricsWindow.isDestroyed() || lyricsWindow.webContents.isLoading()) return;
  if (appTheme && !lyricsWindow.__themeSent) { lyricsWindow.__themeSent = true; lyricsWindow.webContents.send('lyrics:theme', appTheme); }
  lyricsWindow.webContents.send('lyrics:state', lyricsState);
  lyricsWindow.webContents.send('lyrics:data', lyricsData);
  lyricsWindow.webContents.send('lyrics:settings', lyricsSettings);
}

// 메인 앱 테마(포인트·배경·패널 색)를 가사 창과 설정 팝업에도 뿌린다 — 재생바·슬라이더·카드 배경이 따라간다
let appTheme = null;

function sendThemeToLyricsWindows() {
  if (!appTheme) return;
  for (const win of [lyricsWindow, lyricsSettingsWindow]) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send('lyrics:theme', appTheme);
  }
}

// 플로팅 창 설정 UI는 메인 창의 디자인 설정 패널과 별도 설정 팝업 두 곳 — 양쪽에 같은 값을 뿌린다
function sendLyricsSettingsToMain() {
  for (const win of [mainWindow, lyricsSettingsWindow]) {
    if (!win || win.isDestroyed() || win.webContents.isLoading()) continue;
    win.webContents.send('lyrics:settings', lyricsSettings);
  }
}

// 캐시 키는 영상 id 하나로 고정한다. 예전엔 제목까지 넣었는데, 렌더러가 곡 시작 때는 한국어 현지화 제목을,
// 재생 중엔 임베드의 원어 제목을 보내 같은 영상의 키가 둘로 갈렸다 — 다른 제목으로 두 번 찾고 창의 가사가
// '찾음 ↔ 못 찾음'으로 오락가락한 원인. 원어 제목은 altTitle로 받아 검색어에 합친다.
function lyricStateKey(state) {
  if (state.id) return `id:${state.id}`;
  return [state.title, state.artist].join('\u0000').toLowerCase();
}

// 유튜브가 영상에 등록한 저작권 음악 정보(설명란의 '음악' 카드: 곡명·아티스트·앨범). 영상 제목으로 못 찾을 때
// 마지막 수단으로 이 곡명/아티스트로 다시 검색한다. next 응답의 videoAttributeViewModel에 실려 있다.
const videoMusicCache = new Map();

// 같은 응답에서 영상 설명란도 함께 받는다 — 설명란에 적힌 가사는 "그 곡의 가사"일 가능성이 가장 높은 텍스트 가사다.
// 반환: { title, artist, description } (음악 카드가 없으면 title·artist는 빈 문자열)
async function fetchVideoMusicInfo(videoId) {
  if (!videoId) return null;
  if (videoMusicCache.has(videoId)) return videoMusicCache.get(videoId);
  let info = null;
  try {
    const data = await innertube('next', { videoId });
    const text = (x) => (x && (x.content || x.simpleText || (x.runs || []).map((r) => r.text).join(''))) || '';
    info = { title: '', artist: '', description: '' };
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.attributedDescription && !info.description) info.description = text(node.attributedDescription);
      const vm = node.videoAttributeViewModel;
      if (vm && vm.title && !info.title) {
        info.title = text(vm.title) || String(vm.title);
        info.artist = text(vm.subtitle) || String(vm.subtitle || '');
      }
      for (const value of Object.values(node)) walk(value);
    })(data);
  } catch {}
  videoMusicCache.set(videoId, info);
  return info;
}

// ── 내장 기계 번역 (한국어 가사가 없는 곡 전용 폴백) ──
// 동봉된 M2M100-418M(양자화, models/)을 별도 유틸리티 프로세스(mt-worker.js)에서 돌린다.
// 메인 프로세스에서 돌리면 우선순위를 BELOW_NORMAL까지밖에 못 내려(UI·오디오 공유) 게임 프레임이
// 30%+ 떨어졌다 — 워커는 IDLE 우선순위 + 1스레드라 전면 앱이 항상 CPU를 먼저 가져간다.
// 줄당 수 초 걸리므로 백그라운드로 진행하며 4줄마다 화면을 갱신하고, 곡별 결과는 userData/mt-cache에 저장한다.
let mtWorker = null;
let mtWorkerIdleTimer = null;
let mtJobSeq = 0;
const mtJobs = new Map(); // id → { onLine(index, ko), resolve, reject }

function getMtWorker() {
  clearTimeout(mtWorkerIdleTimer);
  if (!mtWorker) {
    const { utilityProcess } = require('electron');
    mtWorker = utilityProcess.fork(path.join(__dirname, 'mt-worker.js'), [], { serviceName: 'lyrics-mt' });
    mtWorker.on('message', (msg) => {
      const job = msg && mtJobs.get(msg.id);
      if (!job) return;
      if (msg.type === 'line') job.onLine(msg.index, msg.ko);
      else if (msg.type === 'done') {
        mtJobs.delete(msg.id);
        if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.result);
      }
    });
    mtWorker.on('exit', () => {
      mtWorker = null;
      for (const job of mtJobs.values()) job.reject(new Error('mt worker exited'));
      mtJobs.clear();
    });
  }
  return mtWorker;
}

// 워커가 살아 있는 동안 모델이 600MB+ RAM을 점유하므로, 마지막 번역 후 5분 유휴가 지나면 프로세스째 내린다
function scheduleMtWorkerStop() {
  clearTimeout(mtWorkerIdleTimer);
  mtWorkerIdleTimer = setTimeout(() => {
    if (augmentInFlight.size > 0 || !mtWorker || syncEngine.busy || captureTimer) return;
    try { mtWorker.kill(); } catch {}
    mtWorker = null;
  }, 5 * 60 * 1000);
}

// lines: 줄별 번역 원문(빈 문자열 = 생략), 줄마다 onLine(index, ko) 호출, 전체 완료 시 resolve
function runMtJob(lines, src, onLine, onStart, order) {
  return new Promise((resolve, reject) => {
    const id = ++mtJobSeq;
    if (onStart) onStart(id);
    mtJobs.set(id, { onLine, resolve, reject });
    try { getMtWorker().postMessage({ id, lines, src, order }); } catch (err) { mtJobs.delete(id); reject(err); }
  });
}

// 일본어 원문 줄들 → 한글 발음 줄들 (워커에서 kuromoji 사전으로, 곡당 수 밀리초)
function runPronJob(lines) {
  return new Promise((resolve, reject) => {
    const id = ++mtJobSeq;
    mtJobs.set(id, { onLine: () => {}, resolve, reject });
    try { getMtWorker().postMessage({ id, type: 'pron', lines }); } catch (err) { mtJobs.delete(id); reject(err); }
  });
}

// 가사 전체에서 원어를 추정한다 (m2m100의 src_lang)
function detectSourceLang(lines) {
  const text = lines.map((line) => line.text).join(' ');
  if (/[ぁ-んァ-ン]/.test(text)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[а-яА-Я]/.test(text)) return 'ru';
  return 'en';
}

// 캐시: 곡(출처-id)별 {pron: [...], ko: [...](내장 모델), web: [...](웹 번역)}. v1(mt-cache)은 루프에 빠진 번역
// ("나 나 나 …"), v2는 번역 잡 두 개가 한 생성 시퀀스를 같이 써 뒤섞인 번역(v1.32.0)이 섞여 있어 버린다.
function mtCachePath(data) {
  const dir = path.join(app.getPath('userData'), 'mt-cache-v3');
  return { dir, file: path.join(dir, `${data.source || 'x'}-${String(data.id || 'x').replace(/[^\w-]/g, '_')}.json`) };
}

// 의성어·추임새 줄("ラララ", "Na na na", "oh oh")은 번역하지 않는다 — 작은 모델이 루프에 빠지는 주범이고 뜻도 없다
function isVocalization(text) {
  const core = String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}ー〜~]/gu, '');
  if (!core) return true;
  return new Set(core).size <= 3 || /^(?:la|na|oh|ah|uh|yeah|wow|woo|hey|ooh|la-|ラ|ナ|ア|オ|ウ|ラン)+$/i.test(core);
}

// 보강 전 원본 가사 (모드를 바꿔 다시 붙일 때 쓴다). 이전 보강 표시(augmented)도 지운다 — 남겨 두면 '원어만'으로
// 돌린 곡이 예전 모드 이름을 달고 있어, 그 모드로 다시 돌아왔을 때 보강이 끝난 것으로 보고 건너뛴다
function baseLyrics(data) {
  if (!data || !data.baseLines) return data;
  const { baseLines, augmented, ...rest } = data;
  return { ...rest, lines: baseLines };
}

// ── 외국어 가사 보강: 한국어가 없는 가사에 원문 아래 줄로 한글 발음(일본어)·기계 번역을 붙인다 ──
// 설정 foreignMode: pron(원어+발음, 기본) | pron+web | web | pron+tr | tr | off. 영어(라틴 문자) 가사는 둘 다 하지 않는다.
// 발음은 사전 기반이라 즉시 붙는다. 웹 번역은 묶음(약 400자)마다, 내장 모델 번역은 한 줄씩(줄당 1~2초) 채워진다.
const augmentInFlight = new Set();
let mtCacheWrites = 0;
// 곡마다 세대 번호 — 표시 모드를 바꾸면 세대가 올라가 이전 작업은 화면을 건드리지 못하고, 진행 중 번역은 취소한다
const augmentGen = new Map(); // key → number
const mtJobOfKey = new Map(); // key → 진행 중인 번역 잡 id

function cancelForeignWork(key) {
  augmentGen.set(key, (augmentGen.get(key) || 0) + 1);
  const jobId = mtJobOfKey.get(key);
  if (jobId && mtWorker) { try { mtWorker.postMessage({ type: 'cancel', id: jobId }); } catch {} }
  mtJobOfKey.delete(key);
  for (const k of [...augmentInFlight]) if (k.startsWith(`${key}|`)) augmentInFlight.delete(k);
}

function foreignPlan(data) {
  const mode = lyricsSettings.foreignMode;
  if (!data || data.unavailable || data.hasKorean || !(data.lines || []).length || mode === 'off') return null;
  const lang = detectSourceLang(data.lines);
  if (lang === 'en') return null;
  const parts = mode.split('+');
  const plan = { mode, lang, pron: parts.includes('pron') && lang === 'ja', tr: parts.includes('tr'), web: parts.includes('web') };
  return plan.pron || plan.tr || plan.web ? plan : null;
}

async function augmentForeignLyrics(key, data) {
  const base = baseLyrics(data);
  const plan = foreignPlan(base);
  if (!plan) return;
  const jobKey = `${key}|${plan.mode}`;
  if (augmentInFlight.has(jobKey)) return;
  augmentInFlight.add(jobKey);
  const gen = augmentGen.get(key) || 0;
  const n = base.lines.length;
  const originals = base.lines.map((line) => String(line.text || '').split('\n')[0].trim());
  try {
    const { dir, file } = mtCachePath(base);
    let cache = { ...(base.augmentCache || {}) }; // 가사 저장본에 함께 저장된 발음·번역
    try { cache = { ...cache, ...(JSON.parse(fs.readFileSync(file, 'utf8')) || {}) }; } catch {}
    const saveCache = () => {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); } catch {}
      if (++mtCacheWrites % 50 === 0) pruneMtCache();
    };
    let pron = plan.pron && Array.isArray(cache.pron) && cache.pron.length === n ? cache.pron : null;
    const field = plan.web ? 'web' : 'ko'; // 웹 번역과 내장 모델 번역은 따로 캐시한다
    const translating = plan.tr || plan.web;
    const koDone = translating && Array.isArray(cache[field]) && cache[field].length === n;
    const ko = translating ? (koDone ? cache[field] : new Array(n).fill('')) : null;
    let webFailed = false;
    // final: 이 모드의 보강이 끝났다는 표시(augmented = 모드). 덜 된 결과(곡이 바뀌어 취소된 번역, 실패한 웹 번역)는
    // 표시만 하고 끝났다고 적지 않는다 — 그래야 그 곡을 다시 틀 때 이어서 번역한다(예전엔 반쯤 된 번역이 그대로 남았다)
    const publish = (final) => {
      // 그새 모드를 바꿨으면(세대가 올라감) 이 작업은 화면을 건드리지 않는다 — 끈 번역이 다시 나타나지 않게
      if ((augmentGen.get(key) || 0) !== gen || lyricsSettings.foreignMode !== plan.mode) return;
      // 그새 자동 싱크가 시각을 바꿨으면 그 시각을 쓴다(보강이 끝날 때 옛 시각으로 되돌리지 않게)
      const latest = lyricsCache.get(key);
      const fresh = latest && !latest.unavailable && latest.lines && latest.lines.length === n && latest.source === base.source
        && String(latest.id) === String(base.id) ? latest : null;
      const baseLines = fresh ? (fresh.baseLines || fresh.lines).map((l, i) => ({ ...base.lines[i], time: l.time })) : base.lines;
      const lines = baseLines.map((line, i) => {
        const parts = [line.text];
        if (pron && pron[i] && pron[i] !== originals[i]) parts.push(pron[i]);
        if (ko && ko[i]) parts.push(ko[i]);
        return { ...line, text: parts.join('\n') };
      });
      const next = {
        ...base, ...(fresh ? { sync: fresh.sync, origin: fresh.origin, fromStore: fresh.fromStore, plain: fresh.plain, roughFor: fresh.roughFor } : {}),
        lines, baseLines, augmented: final ? plan.mode : `${plan.mode}…`,
        // 한글 줄이 찾은 가사가 아니라 번역이면 가사 창·가사 보기에서 제목 옆에 '번역 결과'로 표시한다
        machineTranslated: !!(ko && ko.some(Boolean)),
        translatedBy: plan.web ? 'web' : 'model',
        fallbackNotice: webFailed ? '한글 가사 없음 · 웹 번역 실패' : plan.web ? '한글 가사 없음 · 웹 번역'
          : plan.tr ? '한글 가사 없음 · 기계 번역' : '한글 가사 없음 · 발음 표기',
      };
      lyricsCache.set(key, next);
      if (key === lyricsKey) { lyricsData = next; sendLyricsToWindow(); }
    };
    if (plan.pron && !pron) {
      try { pron = await runPronJob(originals); } catch { pron = null; }
      if (pron && pron.length === n) { cache.pron = pron; saveCache(); } else pron = null;
    }
    publish(!translating || koDone);
    const sources = originals.map((t) => (t && !hasHangul(t) && !isVocalization(t) ? t : ''));
    if (plan.web && !koDone) {
      // 네트워크 작업이라 CPU를 거의 안 쓰고 다른 곡의 작업과 겹쳐도 된다 (미리 찾기에서도 돌린다)
      const { ko: out, complete } = await webTranslateLines(sources, (partial) => {
        partial.forEach((text, i) => { if (text) ko[i] = text; });
        publish(false);
      });
      if ((augmentGen.get(key) || 0) !== gen) return;
      out.forEach((text, i) => { if (text) ko[i] = text; });
      webFailed = !complete && !ko.some(Boolean);
      if (complete) { cache.web = ko; saveCache(); }
      publish(complete);
    }
    if (plan.tr && !koDone) {
      // 다른 곡의 번역이 아직 돌고 있으면 취소한다 — 번역기는 한 번에 한 줄만 처리하므로 지금 곡이 밀리지 않게
      // (이전 곡은 다시 틀 때 처음부터 다시 번역한다; 완성된 곡만 캐시된다)
      for (const otherKey of [...mtJobOfKey.keys()]) if (otherKey !== key) cancelForeignWork(otherKey);
      // 지금 재생 중인 줄부터 번역한다(줄당 1~2초라 처음부터 하면 곡 중간에 켰을 때 한참 기다린다)
      let start = 0;
      if (!base.plain && key === lyricsKey) {
        const now = (lyricsState.progress || 0) + 1500;
        base.lines.forEach((line, i) => { if (line.time <= now) start = i; });
      }
      const order = [...Array(n).keys()].slice(start).concat([...Array(start).keys()]);
      await runMtJob(sources, plan.lang, (i, text) => {
        ko[i] = text;
        if (text && key === lyricsKey) publish(false); // 한 줄 될 때마다 바로 보인다 (곡이 바뀌었으면 캐시만 채운다)
      }, (jobId) => mtJobOfKey.set(key, jobId), order);
      if ((augmentGen.get(key) || 0) !== gen) return; // 도중에 취소됨 — 덜 된 번역은 캐시하지 않는다
      mtJobOfKey.delete(key);
      cache.ko = ko;
      saveCache();
      publish(true);
    }
  } catch {} finally {
    augmentInFlight.delete(jobKey);
    if (augmentInFlight.size === 0 && mtWorker) scheduleMtWorkerStop();
  }
}

// 표시 모드를 바꾸면 지금 곡에 바로 다시 적용한다 (원어만으로 돌아가는 경우 포함)
function reapplyForeignMode() {
  if (!lyricsKey || !lyricsData || lyricsData.unavailable) return;
  cancelForeignWork(lyricsKey); // 진행 중 번역 취소 + 이전 작업의 화면 갱신 차단
  const base = baseLyrics(lyricsData);
  if (base !== lyricsData) {
    lyricsData = base;
    lyricsCache.set(lyricsKey, base);
    sendLyricsToWindow();
  }
  augmentForeignLyrics(lyricsKey, base);
}

// ── 텍스트 가사 · 자동 싱크 · 가사 저장소 ──
// 흐름: 가사가 정해지면 activateLyrics() — 텍스트 가사(싱크 없음)는 곡 전체 길이에 같은 간격으로 놓은 1차(대략) 싱크로
// 바로 띄우고, 자동 싱크가 켜져 있으면 그 곡을 SyncEngine(lyrics-sync.js)에 올린다. 임베드·직접 재생 웹뷰 안의 오디오
// 가드(audio-guard.js)가 재생되는 소리를 16kHz로 쌓아 두면 pollCapture()가 2초마다 가져와 엔진에 넣고, 30초 창마다
// 음성 인식(whisper, 가사 워커) → 가사 후보 정렬(lyrics-align.js) 결과가 applySyncResult()로 온다.
// - 텍스트 가사: 들은 구간까지 정밀 싱크로 바뀌고(나머지는 대략), 다 들으면 'auto'.
// - 싱크 가사(DB): 소리로 곡이 맞는지 확인하고, 시각이 통째로 밀려 있으면(뮤비 인트로 등) 그만큼 옮긴다.
// - 후보가 여럿이면 소리와 맞는 쪽으로 바꾼다(다른 곡 가사는 연속 일치율 0~6%, 맞는 가사 30~85% — 실측).
// - 게스트 로컬 재생목록 곡이면 결과를 lyrics-store에 저장 → 다음엔 검색·인식 없이 바로.
// 음성 인식 스레드: 코어가 넉넉하면 4(IDLE 우선순위라 게임 등 전면 앱이 먼저 CPU를 가져간다) — 4스레드 창당 약 5초,
// 2스레드 약 8초(실측, 같은 PC의 Windows는 1.4배 느림)
const ASR_THREADS = os.cpus().length >= 12 ? 4 : os.cpus().length >= 8 ? 3 : 2;
const SYNC_CAL_MS = 250; // 정렬 시각 보정: 실측에서 정답보다 0.38초 이르게 나온다(화면은 225ms 앞서 고르므로 조금만 늦춘다)
let lyricsStore = null;
let asrReady = false;
// videoId → { candidates: [보강 전 가사], chosen, userSelected, extras, extrasMerged, doneWindows, complete, fromStore, lastSaveAt }
const syncMeta = new Map();

function runWorkerJob(payload) {
  return new Promise((resolve, reject) => {
    const id = ++mtJobSeq;
    mtJobs.set(id, { onLine: () => {}, resolve, reject });
    try { getMtWorker().postMessage({ ...payload, id }); } catch (err) { mtJobs.delete(id); reject(err); }
  }).finally(() => scheduleMtWorkerStop());
}

const syncEngine = new SyncEngine({
  runAsr: (job) => runWorkerJob({ type: 'asr', pcm: job.pcm, lang: job.lang, offsetMs: job.offsetMs, prompt: job.prompt, durationMs: job.durationMs, threads: ASR_THREADS }),
  runAlign: (job) => runWorkerJob({ type: 'align', candidates: job.candidates.map((c) => ({ lines: c.lines })), heard: job.heard, durationMs: job.durationMs, heardUntil: job.heardUntil }),
  onResult: (vid, r) => applySyncResult(vid, r),
});

// 가사의 노래 언어(원문 줄 기준) — 음성 인식 언어 지정
function lyricsLang(data) {
  const text = (data.lines || []).map((l) => String(l.text || '').split('\n')[0]).join(' ');
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[가-힣]/.test(text)) return 'ko';
  if (/[一-鿿]/.test(text)) return 'zh';
  return /[a-z]/i.test(text) ? 'en' : 'auto';
}

// 줄 시각만 바꾼다(보강된 가사면 원본 줄도 같이)
function withTimes(data, times) {
  const set = (lines) => lines.map((l, i) => ({ ...l, time: times[i] != null ? Math.max(0, Math.round(times[i])) : l.time }));
  const out = { ...data, lines: set(data.lines) };
  if (data.baseLines && data.baseLines.length === data.lines.length) out.baseLines = set(data.baseLines);
  return out;
}

// 1차(대략) 싱크: 텍스트 가사를 곡 전체 시간에 같은 간격으로 놓는다(소리 연산 없음). 곡 길이를 알게 되면 다시 놓는다.
function prepareLyrics(data, durationMs) {
  if (!data || data.unavailable || !(data.lines || []).length) return data;
  if (data.plain || (data.origin === 'text' && data.sync && data.sync.kind === 'rough')) {
    const dur = durationMs > 0 ? durationMs : data.lines.length * 4000;
    if (!data.plain && data.roughFor === dur) return data;
    return { ...withTimes(data, evenTimes(data.lines.length, 0, dur)), plain: false, origin: 'text', roughFor: dur, sync: { kind: 'rough', progress: 0 } };
  }
  if (!data.origin) return { ...data, origin: 'synced', sync: data.sync || { kind: 'db' } };
  return data;
}

// 검색 후보 → 정렬 후보(보강 전, 표시용 꼬리표 제거)
function candidateOf(c) {
  const base = baseLyrics(c) || c;
  const { match, augmented, machineTranslated, translatedBy, fallbackNotice, augmentCache, ...rest } = base;
  return { ...rest, origin: rest.origin || (rest.plain ? 'text' : 'synced') };
}

function sameBody(a, b) {
  const fp = (x) => (x.lines || []).map((l) => String(l.text || '').split('\n')[0]).join('\n');
  return a.source === b.source && String(a.id) === String(b.id) ? true : fp(a) === fp(b);
}

// 가사가 정해질 때마다(검색 결과·캐시·저장본·직접 선택) — 1차 싱크 적용 + 자동 싱크 대상 등록
function activateLyrics(key, data, opts = {}) {
  const vid = key.startsWith('id:') ? key.slice(3) : '';
  const prepared = prepareLyrics(data, lyricsState.duration);
  if (!vid || !prepared || prepared.unavailable || !(prepared.lines || []).length) {
    syncEngine.setCurrent(vid, null);
    updateCapture();
    return prepared;
  }
  let meta = syncMeta.get(vid);
  if (!meta || opts.reset) {
    const alt = searchAlternatives.get(key) || {};
    const candidates = [candidateOf(prepared)];
    for (const c of alt.alternatives || []) { const cc = candidateOf(c); if (!candidates.some((x) => sameBody(x, cc))) candidates.push(cc); }
    meta = {
      candidates, chosen: 0, userSelected: !!opts.userSelected, extras: alt.extras || null, extrasMerged: !alt.extras,
      doneWindows: (meta && meta.doneWindows) || opts.doneWindows || [], complete: !!opts.complete, fromStore: !!opts.fromStore, lastSaveAt: 0,
    };
    syncMeta.delete(vid);
    syncMeta.set(vid, meta);
    // 오래 틀어 두면 곡마다 쌓이므로 최근 200곡만 (Map은 넣은 순서 — 지금 곡·엔진이 붙잡은 곡은 남긴다)
    for (const old of syncMeta.keys()) {
      if (syncMeta.size <= 200) break;
      if (old !== vid && !syncEngine.videos.has(old)) syncMeta.delete(old);
    }
    if (!opts.fromStore) saveLyricsToStore(vid, prepared, false, true);
  }
  if (lyricsSettings.autoSync && asrReady && !meta.complete) {
    syncEngine.setCurrent(vid, { durationMs: lyricsState.duration, lang: lyricsLang(meta.candidates[meta.chosen]), candidates: meta.candidates, doneWindows: meta.doneWindows });
  } else {
    syncEngine.setCurrent(vid, null);
  }
  updateCapture();
  return prepared;
}

// 한 후보의 정렬 결과 → 표시할 가사(보강 전)
function timedFromResult(cand, result, r) {
  const info = { progress: r.progress, complete: r.complete, verdict: result.verdict, precision: Math.round(result.score.precision * 100) / 100 };
  if (cand.origin === 'text') {
    const times = result.times.map((t) => t + SYNC_CAL_MS);
    return { ...withTimes(cand, times), plain: false, origin: 'text', sync: { kind: r.complete ? 'auto' : 'auto-partial', ...info } };
  }
  const base = { ...cand, plain: false, origin: 'synced' };
  if (result.verdict !== 'match') return { ...base, sync: { kind: 'db', ...info } };
  // 싱크 가사의 시각과 소리로 맞춘 시각의 차이 — 통째로 밀려 있으면(차이가 고르면) 그만큼 옮긴다
  const diffs = [];
  result.anchored.forEach((ok, i) => { if (ok && cand.lines[i]) diffs.push(result.times[i] + SYNC_CAL_MS - cand.lines[i].time); });
  if (diffs.length < 5) return { ...base, sync: { kind: 'db-verified', ...info } };
  const sorted = diffs.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const dev = diffs.map((d) => Math.abs(d - med)).sort((a, b) => a - b);
  const mad = dev[dev.length >> 1];
  if (mad > 1500 && diffs.length >= cand.lines.length * 0.4) {
    // 줄마다 제각각 어긋난 싱크(다른 버전·엉터리 등록본) — 소리로 맞춘 시각을 쓴다
    const times = result.times.map((t) => t + SYNC_CAL_MS);
    return { ...withTimes(base, times), sync: { kind: r.complete ? 'auto' : 'auto-partial', ...info, replacedDb: true } };
  }
  if (Math.abs(med) >= 500 && mad <= 700) {
    return { ...withTimes(base, cand.lines.map((l) => l.time + med)), sync: { kind: 'db-shifted', shiftMs: Math.round(med), ...info } };
  }
  return { ...base, sync: { kind: 'db-verified', ...info } };
}

function applySyncResult(vid, r) {
  const meta = syncMeta.get(vid);
  if (!meta || !Array.isArray(r.results) || r.results.length !== meta.candidates.length) return; // 그새 후보가 바뀜
  meta.doneWindows = r.doneWindows;
  meta.complete = r.complete;
  let chosen = meta.chosen;
  const cur = r.results[chosen];
  if (!meta.userSelected) {
    let best = -1;
    let bestP = -1;
    r.results.forEach((x, i) => { if (i !== chosen && x.verdict === 'match' && x.score.precision > bestP) { best = i; bestP = x.score.precision; } });
    if (best >= 0 && (cur.verdict === 'mismatch' || (cur.verdict === 'unsure' && bestP >= cur.score.precision + 0.25))) chosen = best;
  }
  // 지금 가사가 소리와 안 맞으면 느린 출처(utaten·Genius) 후보까지 더해 다시 맞춰 본다
  if (r.results[chosen].verdict === 'mismatch' && !meta.extrasMerged && meta.extras) {
    meta.extrasMerged = true;
    Promise.resolve(typeof meta.extras === 'function' ? meta.extras() : meta.extras).then((list) => {
      const fresh = (list || []).map(candidateOf).filter((c) => !meta.candidates.some((x) => sameBody(x, c)));
      if (fresh.length && syncMeta.get(vid) === meta) { meta.candidates.push(...fresh); syncEngine.setCandidates(vid, meta.candidates); }
    }).catch(() => {});
  }
  const switched = chosen !== meta.chosen;
  meta.chosen = chosen;
  const cand = meta.candidates[chosen];
  const res = r.results[chosen];
  // 소리와 확실히 안 맞고(들은 글자 충분, 연속 일치 5% 미만) 대안도 없으면 틀린 가사를 보여 주지 않는다
  const strongMismatch = res.verdict === 'mismatch' && res.score.heard >= 400 && res.score.precision < 0.05
    && cand.source !== 'desc' && !meta.userSelected && meta.extrasMerged;
  const timed = strongMismatch ? { unavailable: true, mismatch: true, lines: [] } : timedFromResult(cand, res, r);
  const key = `id:${vid}`;
  const cached = lyricsCache.get(key);
  let display = timed;
  if (!timed.unavailable && !switched && cached && cached.baseLines && cached.baseLines.length === timed.lines.length
    && cached.source === timed.source && String(cached.id) === String(timed.id)) {
    // 발음·번역 줄은 그대로 두고 시각만 바꾼다
    display = { ...cached, sync: timed.sync, origin: timed.origin, plain: false, lines: cached.lines.map((l, i) => ({ ...l, time: timed.lines[i].time })), baseLines: timed.lines };
  }
  if (meta.fromStore) display = { ...display, fromStore: true };
  lyricsCache.set(key, display);
  if (key === lyricsKey) { lyricsData = display; sendLyricsToWindow(); }
  if (!display.unavailable && (switched || !display.augmented)) augmentForeignLyrics(key, display);
  saveLyricsToStore(vid, timed, r.complete);
  updateCapture();
}

// 저장용: 표시용 꼬리표 제거
function stripLyricsForStore(d) {
  const { baseLines, augmented, machineTranslated, translatedBy, fallbackNotice, match, fromStore, augmentCache, ...rest } = d;
  return rest;
}

// 로컬 재생목록 곡이면 가사·싱크·들은 글자를 저장한다(20초마다·다 들었을 때·처음 정해졌을 때)
function saveLyricsToStore(vid, data, complete, force = false) {
  if (!lyricsStore || !lyricsStore.isLocalVideo(vid)) return;
  const meta = syncMeta.get(vid);
  const now = Date.now();
  if (!force && !complete && meta && now - (meta.lastSaveAt || 0) < 20000) return;
  if (meta) meta.lastSaveAt = now;
  const base = baseLyrics(data) || data;
  let augment = null;
  if (!base.unavailable) { try { augment = JSON.parse(fs.readFileSync(mtCachePath(base).file, 'utf8')); } catch {} }
  lyricsStore.put(vid, {
    data: base.unavailable ? base : stripLyricsForStore(base),
    doneWindows: (meta && meta.doneWindows) || [],
    complete: !!(meta && meta.complete),
    userSelected: !!(meta && meta.userSelected),
    augment,
  });
}

// 저장본 → 표시 (검색·인식 없이 바로)
function loadStoredLyrics(state, key) {
  const stored = lyricsStore && state.id ? lyricsStore.get(state.id) : null;
  if (!stored || !stored.data) return null;
  const data = { ...stored.data, fromStore: true, augmentCache: stored.augment || null };
  syncMeta.delete(state.id);
  const meta = {
    candidates: data.unavailable ? [] : [candidateOf(data)], chosen: 0, userSelected: !!stored.userSelected, extras: null, extrasMerged: true,
    doneWindows: stored.doneWindows || [], complete: !!stored.complete, fromStore: true, lastSaveAt: Date.now(),
  };
  syncMeta.set(state.id, meta);
  return data;
}

// 사용자가 "가사 삭제" — 저장본·캐시를 지우고 이번 실행에서는 다시 찾지 않는다(다시 찾기로 찾을 수 있다)
function deleteCurrentLyrics() {
  const vid = lyricsState.id;
  if (!vid || !lyricsKey) return false;
  if (lyricsStore) lyricsStore.remove(vid);
  syncEngine.drop(vid);
  syncMeta.delete(vid);
  searchAlternatives.delete(lyricsKey);
  const data = { unavailable: true, deleted: true, lines: [] };
  lyricsCache.set(lyricsKey, data);
  lyricsData = data;
  sendLyricsToWindow();
  updateCapture();
  return true;
}

// ── 소리 받기(오디오 가드 → 엔진) ──
let captureTimer = null;

function wantCapture() {
  const vid = lyricsState.id;
  const meta = vid && syncMeta.get(vid);
  return !!(lyricsSettings.autoSync && asrReady && meta && !meta.complete && meta.candidates.length && syncEngine.videos.has(vid));
}

function updateCapture() {
  const want = wantCapture();
  if (!!audioState.capture !== want) {
    audioState = { ...audioState, capture: want };
    pushAudioState();
  }
  if (want && !captureTimer) captureTimer = setInterval(pollCapture, 2000);
  else if (!want && captureTimer) { clearInterval(captureTimer); captureTimer = null; }
}

async function pollCapture() {
  for (const f of audioFrames()) {
    let r = null;
    try { r = await f.executeJavaScript('window.__ympCapTake ? window.__ympCapTake() : null'); } catch {}
    if (!r || !Array.isArray(r.chunks)) continue;
    for (const c of r.chunks) {
      const vid = c.vid || lyricsState.id;
      if (!syncEngine.videos.has(vid) || typeof c.b64 !== 'string') continue;
      const buf = Buffer.from(c.b64, 'base64');
      const ab = new ArrayBuffer(buf.length - (buf.length % 2));
      new Uint8Array(ab).set(buf.subarray(0, ab.byteLength));
      const pcm = new Int16Array(ab);
      syncEngine.feed(vid, Number(c.t) - pcm.length / (r.rate || 16000), pcm);
    }
  }
}

// 번역 캐시(mt-cache-v3)는 곡마다 파일이 하나씩 쌓인다 — 오래된 것부터 400개만 남긴다(용량이 계속 늘지 않게)
function pruneMtCache() {
  try {
    const dir = path.join(app.getPath('userData'), 'mt-cache-v3');
    const files = fs.readdirSync(dir).map((name) => {
      const file = path.join(dir, name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(400)) { try { fs.unlinkSync(f.file); } catch {} }
  } catch {}
}

// 같은 곡을 두 번 찾지 않도록 진행 중인 검색을 공유한다 (미리 찾기 ↔ 재생 시작이 겹칠 때)
const lyricsInflight = new Map(); // key → Promise<{ data, transient }>
const searchAlternatives = new Map(); // key → { alternatives: [후보], extras: Promise<[후보]> }

function searchLyricsShared(state, key) {
  if (lyricsInflight.has(key)) return lyricsInflight.get(key);
  const failuresBefore = lyricFailureCount();
  const promise = (async () => {
    // 유튜브 음악 카드(곡명·아티스트)는 검색과 동시에 받아 넘긴다 — 있으면 검색어 맨 앞에 쓰인다
    const alt = state.altTitle && state.altTitle !== state.title ? [{ title: state.altTitle, artist: state.altArtist || state.artist }] : [];
    const info = fetchVideoMusicInfo(state.id);
    const found = await findLyricsCandidates(state.title, state.artist, state.duration, {
      musicInfo: info.then((i) => (i && i.title ? i : null)),
      description: info.then((i) => (i && i.description) || ''),
      videoId: state.id,
      alt,
    });
    const data = found.best;
    // 소리 검증·후보 교체용 대안 후보들(본문이 다른 것 위주)과 느린 출처의 추가 후보
    searchAlternatives.set(key, { alternatives: found.alternatives || [], extras: found.extras });
    // 못 찾았는데 그 사이 요청이 끝내 실패했다면 '없음'이 아니라 '모름'
    return { data, transient: !data && lyricFailureCount() > failuresBefore };
  })().finally(() => lyricsInflight.delete(key));
  lyricsInflight.set(key, promise);
  return promise;
}

// 다음 곡 가사 미리 찾기 — 렌더러가 곡 시작 몇 초 뒤 다음 곡 정보를 보낸다. 곡이 바뀌는 순간 바로 뜨게.
// 결과는 같은 키로 캐시에 넣는다(기계 번역은 실제로 재생될 때 시작). 실패는 캐시하지 않는다.
async function prefetchLyrics(info) {
  if (!info || !info.id || !info.title || info.title === info.id) return;
  const state = { id: String(info.id), title: String(info.title), artist: String(info.artist || ''), duration: Math.max(0, Number(info.duration) || 0) };
  const key = lyricStateKey(state);
  if (lyricsCache.has(key) || lyricsInflight.has(key)) return;
  // 저장해 둔 가사(로컬 재생목록 곡)가 있으면 검색하지 않는다 — 저장된 정밀 싱크가 검색 결과에 덮이지 않게
  const stored = loadStoredLyrics(state, key);
  if (stored) { lyricsCache.set(key, stored); return; }
  try {
    const { data, transient } = await searchLyricsShared(state, key);
    if (!transient && !lyricsCache.has(key)) {
      lyricsCache.set(key, data || { unavailable: true, lines: [] });
      // 발음·웹 번역도 미리 붙여 둔다(곡이 시작되면 바로 보이게). 내장 모델 번역은 지금 곡의 번역을 취소시키므로 미리 하지 않는다
      const plan = foreignPlan(data);
      if (plan && !plan.tr) augmentForeignLyrics(key, data);
    }
  } catch {}
}

// 네트워크 실패로 못 찾은 곡은 15초 간격으로 최대 3번 다시 찾는다 (그동안 창에는 '찾는 중'이 유지된다)
const lyricsRetries = new Map(); // key → 시도 횟수

function scheduleLyricsRetry(state, key) {
  const attempts = (lyricsRetries.get(key) || 0) + 1;
  lyricsRetries.set(key, attempts);
  if (attempts > 3) {
    lyricsRetries.delete(key);
    lyricsCache.set(key, { unavailable: true, lines: [] });
    if (key === lyricsKey) { lyricsData = lyricsCache.get(key); sendLyricsToWindow(); }
    return;
  }
  setTimeout(() => {
    if (key !== lyricsKey || lyricsCache.has(key)) return; // 곡이 바뀌었으면 그만
    loadLyricsForState(state, key).catch(() => {});
  }, 15000);
}

async function loadLyricsForState(state, key) {
  if (lyricsLoadingKey === key) return;
  if (lyricsCache.has(key)) {
    lyricsData = activateLyrics(key, lyricsCache.get(key));
    lyricsCache.set(key, lyricsData);
    if (lyricsData.augmented !== lyricsSettings.foreignMode) augmentForeignLyrics(key, lyricsData); // 발음·번역 (필요할 때만)
    sendLyricsToWindow();
    return;
  }
  // 로컬 재생목록 곡으로 저장해 둔 가사(싱크 포함)가 있으면 검색하지 않고 바로
  const stored = loadStoredLyrics(state, key);
  if (stored) {
    const display = stored.unavailable ? stored : activateLyrics(key, stored, { fromStore: true });
    lyricsCache.set(key, display);
    if (!display.unavailable) augmentForeignLyrics(key, display);
    if (key === lyricsKey) { lyricsData = display; sendLyricsToWindow(); }
    return;
  }
  lyricsLoadingKey = key;
  const requestId = ++lyricsRequestId;
  try {
    const { data, transient } = await searchLyricsShared(state, key);
    // 실패로 못 찾은 것은 캐시하지 않고 잠시 뒤 다시 찾는다
    // (예전엔 이걸 '가사 없음'으로 캐시해 같은 곡이 찾아졌다 말았다 했다)
    if (transient) {
      scheduleLyricsRetry(state, key);
      return;
    }
    lyricsRetries.delete(key);
    // 텍스트 가사는 1차(대략) 싱크로 바로 띄우고, 자동 싱크 대상으로 등록한다
    const displayData = data ? (key === lyricsKey ? activateLyrics(key, data, { reset: true }) : prepareLyrics(data, state.duration)) : { unavailable: true, lines: [] };
    lyricsCache.set(key, displayData);
    // 한국어 가사를 못 구한 외국어 곡은 한글 발음·기계 번역을 붙인다 (설정 foreignMode)
    augmentForeignLyrics(key, displayData);
    if (requestId !== lyricsRequestId || key !== lyricsKey) return;
    lyricsData = displayData;
    sendLyricsToWindow();
  } finally {
    if (lyricsLoadingKey === key) lyricsLoadingKey = '';
  }
}

function updateLyricsState(data) {
  if (!data || typeof data !== 'object') return;
  const next = {
    id: String(data.id || ''),
    title: String(data.title || ''),
    artist: String(data.artist || ''),
    // 임베드 플레이어가 아는 원어 제목·채널 (표시 제목이 현지화 제목일 때 검색어로 함께 쓴다)
    altTitle: String(data.altTitle || ''),
    altArtist: String(data.altArtist || ''),
    status: ['playing', 'paused', 'idle'].includes(data.status) ? data.status : 'idle',
    progress: Math.max(0, Number(data.progress) || 0),
    duration: Math.max(0, Number(data.duration) || 0),
    coverUrl: String(data.coverUrl || ''),
    volume: Math.max(0, Math.min(100, Number.isFinite(Number(data.volume)) ? Number(data.volume) : 100)),
  };
  if (pendingVolumeFlash && next.volume !== lyricsState.volume) {
    pendingVolumeFlash = false;
    // 0은 음소거 표시로 — "볼륨 0"보다 상태가 분명하다 (Alt+' 토글)
    sendLyricsFlash(next.volume === 0 ? '🔇 음소거' : `🔊 볼륨 ${Math.round(next.volume)}`);
  }
  const key = lyricStateKey(next);
  const keyChanged = key !== lyricsKey;
  lyricsState = next;
  if (keyChanged) {
    lyricsKey = key;
    // 저장된 가사(로컬 재생목록 곡)는 영상 id만으로 바로 — 제목을 아직 못 받았어도 기다리지 않는다
    if (!lyricsCache.has(key) && next.id) {
      const stored = loadStoredLyrics(next, key);
      if (stored) lyricsCache.set(key, stored);
    }
    lyricsData = lyricsCache.has(key) ? lyricsCache.get(key) : null;
    // 미리 찾아 둔 곡, 보강이 덜 끝난 곡, 다른 표시 모드로 보강했던 곡 → 지금 모드로 (다시) 붙인다.
    // (캐시에 있는 곡은 loadLyricsForState를 거치지 않아, 미리 찾은 외국어 곡에 발음이 안 붙던 문제가 있었다)
    if (lyricsData && lyricsData.augmented !== lyricsSettings.foreignMode) {
      if (lyricsData.baseLines && String(lyricsData.augmented).replace('…', '') !== lyricsSettings.foreignMode) {
        lyricsData = baseLyrics(lyricsData);
        lyricsCache.set(key, lyricsData);
      }
      augmentForeignLyrics(key, lyricsData);
    }
    // 미리 찾아 둔 곡: 1차 싱크·자동 싱크 등록 / 가사가 없는 곡: 이전 곡의 소리 받기를 멈춘다
    if (lyricsData) { lyricsData = activateLyrics(key, lyricsData); lyricsCache.set(key, lyricsData); } else { syncEngine.setCurrent(next.id, null); updateCapture(); }
    sendLyricsToWindow();
    sendLyricsOffset();
  }
  // 곡 길이를 늦게 알게 되면 자동 싱크 엔진에도 알린다(길이를 모르면 소리를 받지 못한다)
  if (next.duration > 0 && syncEngine.videos.has(next.id) && !(syncEngine.videos.get(next.id).durationMs > 0)) {
    syncEngine.ensure(next.id, { durationMs: next.duration });
  }
  if (!keyChanged && lyricsData && lyricsData.origin === 'text' && lyricsData.sync && lyricsData.sync.kind === 'rough'
    && next.duration > 0 && lyricsData.roughFor !== next.duration) {
    lyricsData = prepareLyrics(lyricsData, next.duration);
    lyricsCache.set(key, lyricsData);
  }
  sendLyricsToWindow();
  // 제목을 아직 못 받아 영상 id를 제목 자리에 둔 상태에서는 찾지 않는다 (헛검색이 '없음'으로 남지 않게)
  if (next.status !== 'idle' && next.title && next.title !== next.id && next.duration > 0 && !lyricsCache.has(key)) {
    loadLyricsForState(next, key).catch(() => {});
  }
  ensureAugmented();
}

// 지금 곡의 발음·번역이 덜 붙어 있으면(웹 번역이 일시 실패·일부만 됨, 다른 경로가 보강 전 가사로 바꿔 놓음) 스스로 다시 붙인다.
// 예전엔 그 곡을 떠났다 돌아와야 다시 시도돼, "번역이 끝났는데 원어만 뜬다 → 다른 곡 갔다 오면 붙는다"(사용자 보고)였다.
// 진행 중인 보강이 있으면 기다리고, 실패가 반복되면 8초 → 20초 → 60초 간격으로 최대 4번까지만(오프라인에서 계속 두드리지 않게).
const augmentRetry = new Map(); // key → { at, tries }
const AUGMENT_RETRY_GAPS = [8000, 20000, 60000, 60000];

function ensureAugmented() {
  if (!lyricsKey || !lyricsData || lyricsData.unavailable) return;
  const mode = lyricsSettings.foreignMode;
  if (lyricsData.augmented === mode) { augmentRetry.delete(lyricsKey); return; }
  if (augmentInFlight.has(`${lyricsKey}|${mode}`) || !foreignPlan(baseLyrics(lyricsData))) return;
  const now = Date.now();
  const st = augmentRetry.get(lyricsKey) || { at: now + 3000, tries: 0 }; // 처음 본 순간엔 3초 여유(막 시작한 보강이 곧 붙는다)
  if (!augmentRetry.has(lyricsKey)) augmentRetry.set(lyricsKey, st);
  if (now < st.at || st.tries >= AUGMENT_RETRY_GAPS.length) return;
  st.at = now + AUGMENT_RETRY_GAPS[st.tries];
  st.tries += 1;
  augmentForeignLyrics(lyricsKey, lyricsData);
}

function loadLyricsBounds() {
  try {
    const bounds = JSON.parse(fs.readFileSync(LYRICS_BOUNDS_FILE(), 'utf8'));
    if ([bounds.x, bounds.y].every(Number.isFinite)) {
      return { x: Math.round(bounds.x), y: Math.round(bounds.y), width: lyricsSettings.width, height: lyricsSettings.height };
    }
  } catch {}
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - lyricsSettings.width) / 2),
    y: Math.round(area.y + area.height - lyricsSettings.height - 30),
    width: lyricsSettings.width,
    height: lyricsSettings.height,
  };
}

// 창 이동('moved')과 크기 슬라이더는 연속으로 발생하므로 마찬가지로 묶어서 쓴다
let lyricsBoundsWriteTimer = null;

function writeLyricsBounds() {
  clearTimeout(lyricsBoundsWriteTimer);
  lyricsBoundsWriteTimer = null;
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
  fs.mkdirSync(path.dirname(LYRICS_BOUNDS_FILE()), { recursive: true });
  fs.writeFileSync(LYRICS_BOUNDS_FILE(), JSON.stringify(lyricsWindow.getBounds()));
}

function saveLyricsBounds() {
  clearTimeout(lyricsBoundsWriteTimer);
  lyricsBoundsWriteTimer = setTimeout(writeLyricsBounds, 250);
}

let lyricsOutlineTimer = null;

// 디자인 설정의 크기 슬라이더로 창 크기를 바꿀 때도 드래그할 때처럼 테두리를 잠깐 보여준다
function pulseLyricsOutline() {
  setLyricsDragging(true);
  clearTimeout(lyricsOutlineTimer);
  lyricsOutlineTimer = setTimeout(() => setLyricsDragging(false), 700);
}

function updateLyricsSettings(value, persist = true) {
  const before = lyricsSettings;
  lyricsSettings = normalizeLyricsSettings({ ...lyricsSettings, ...(value || {}) });
  if (lyricsSettings.foreignMode !== before.foreignMode) reapplyForeignMode();
  if (lyricsSettings.autoSync !== before.autoSync) {
    // 자동 싱크를 켜면 지금 곡부터 바로, 끄면 소리 받기·인식을 멈춘다(이미 맞춘 싱크는 그대로)
    syncEngine.enabled = lyricsSettings.autoSync;
    if (lyricsKey && lyricsData && !lyricsData.unavailable) { lyricsData = activateLyrics(lyricsKey, lyricsData); lyricsCache.set(lyricsKey, lyricsData); }
    else updateCapture();
    if (lyricsSettings.autoSync) syncEngine.pump();
  }
  if (lyricsSettings.width !== before.width || lyricsSettings.height !== before.height) pulseLyricsOutline();
  if (persist) saveLyricsSettings();
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    const bounds = lyricsWindow.getBounds();
    lyricsWindow.setBounds({ ...bounds, width: lyricsSettings.width, height: lyricsSettings.height });
    lyricsWindow.setAlwaysOnTop(lyricsSettings.alwaysOnTop, LYRICS_TOP_LEVEL);
    if (lyricsSettings.alwaysOnTop) keepLyricsOnTop();
    applyLyricsClickThrough();
    sendLyricsToWindow();
    saveLyricsBounds();
  }
  sendLyricsSettingsToMain();
  return lyricsSettings;
}

// Windows 작업 표시줄·알림 플라이아웃도 topmost라, 같은 밴드 안에서 z-order가 밀리면 가사 창을
// 덮어버린다(실측: 작업 표시줄이 가사 창 위로 올라옴). 폴링으로 계속 감시하지 않고 **창을 보이게
// 할 때와 Alt+5를 눌렀을 때만** 최상위를 다시 못박는다(다른 단축키는 이 동작을 하지 않는다). SetWindowPos는 SWP_NOACTIVATE라 포커스를 건드리지 않으므로 게임 중에도 안전하다.
function keepLyricsOnTop() {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || !lyricsWindow.isVisible()) return;
  if (!lyricsSettings.alwaysOnTop) return;
  if (!lyricsWindow.isAlwaysOnTop()) lyricsWindow.setAlwaysOnTop(true, LYRICS_TOP_LEVEL);
  lyricsWindow.moveTop();
}

// 마우스 히트박스: 평소에는 창이 마우스를 무시하되(forward로 mousemove는 계속 받는다), 렌더러가
// 앨범/영상·재생바·컨트롤·버튼처럼 상호작용이 있는 요소 위에 커서가 올라왔다고 알리면(lyrics:hit)
// 그 동안만 마우스를 받는다 → 가사 글자나 빈 곳을 눌러도 아래 창으로 통과한다.
// 잠금(clickThrough) 모드는 forward 없이 통째로 무시한다 — 마우스 이동까지 받으면 눌리지도 않는
// 버튼이 hover로 떠서 혼란스럽다. forward 옵션은 Windows/macOS 전용이라 Linux(개발용)에서는 예전처럼 창 전체가 받는다.
const HIT_FORWARD_SUPPORTED = process.platform !== 'linux';
let lyricsHit = false;

function applyLyricsClickThrough() {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
  if (lyricsSettings.clickThrough) {
    lyricsWindow.setIgnoreMouseEvents(true);
    return;
  }
  if (!HIT_FORWARD_SUPPORTED) {
    lyricsWindow.setIgnoreMouseEvents(false);
    return;
  }
  if (lyricsHit) lyricsWindow.setIgnoreMouseEvents(false);
  else lyricsWindow.setIgnoreMouseEvents(true, { forward: true });
}

function showLyricsSettingsWindow() {
  if (lyricsSettingsWindow && !lyricsSettingsWindow.isDestroyed()) {
    lyricsSettingsWindow.show();
    lyricsSettingsWindow.focus();
    return;
  }
  // 플로팅 창 옆에 띄운다 (화면 밖으로 나가면 작업 영역 안으로 당긴다)
  const area = screen.getPrimaryDisplay().workArea;
  const width = 440;
  const height = Math.min(820, area.height); // 레이아웃 프리셋 섹션 추가분 — 작은 화면에선 작업 영역에 맞추고 카드가 스크롤된다
  let x = area.x + Math.round((area.width - width) / 2);
  let y = area.y + Math.round((area.height - height) / 2);
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    const b = lyricsWindow.getBounds();
    x = b.x + b.width + 12;
    y = b.y - Math.round((height - b.height) / 2);
  }
  x = Math.max(area.x, Math.min(area.x + area.width - width, x));
  y = Math.max(area.y, Math.min(area.y + area.height - height, y));
  lyricsSettingsWindow = new BrowserWindow({
    x, y, width, height,
    title: '가사 창 설정',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  lyricsSettingsWindow.setAlwaysOnTop(true, LYRICS_TOP_LEVEL);
  lyricsSettingsWindow.on('closed', () => { lyricsSettingsWindow = null; });
  lyricsSettingsWindow.webContents.on('did-finish-load', () => { sendLyricsSettingsToMain(); sendThemeToLyricsWindows(); });
  lyricsSettingsWindow.once('ready-to-show', () => { lyricsSettingsWindow.show(); lyricsSettingsWindow.focus(); });
  lyricsSettingsWindow.loadURL(`http://127.0.0.1:${lyricsServerPort}/lyrics-settings.html`);
}

function toggleLyricsWindow() {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || !lyricsWindow.isVisible()) showLyricsWindow();
  else lyricsWindow.hide();
}

// 전역 단축키(Alt+1~5): 창 전환 없이 볼륨·가사 창을 조작한다.
// globalShortcut은 OS 핫키(RegisterHotKey)라 우리 창을 활성화하지 않으며, showInactive/hide와
// setIgnoreMouseEvents 모두 포커스를 옮기지 않는다. 다른 앱이 이미 쓰는 조합이면 등록에 실패한다.
// Alt+4(잠금 토글)는 조작 주체까지 함께 옮긴다. 전체화면 게임은 마우스 커서를 잡고 있어서,
// 잠금만 풀어도 포커스가 게임에 있는 한 커서가 보이지 않아 가사 창을 누를 수 없기 때문이다.
//  - 잠금 해제 → 가사 창을 focus (게임이 커서를 놓아준다)
//  - 다시 잠금 → blur 해서 원래 쓰던 창(게임)으로 돌려준다
// Alt+3(창 표시/숨김)은 요청대로 포커스를 건드리지 않는다(showInactive).
function toggleLyricsClickThrough() {
  const next = !lyricsSettings.clickThrough;
  lyricsHit = false;
  updateLyricsSettings({ clickThrough: next });
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
  if (next) {
    lyricsWindow.blur(); // 게임으로 조작 주체를 돌려준다
    return;
  }
  if (!lyricsWindow.isVisible()) lyricsWindow.show();
  // 풀자마자 잡을 수 있게 우선 마우스를 통째로 받는다. 커서가 상호작용 요소 밖에 있으면 렌더러가
  // 첫 mousemove에서 lyrics:hit(false)를 보내 통과 모드로 되돌린다 (히트 알림 왕복을 기다리지 않아도 된다).
  lyricsHit = true;
  applyLyricsClickThrough();
  lyricsWindow.focus();
}

// 볼륨은 렌더러가 소유하므로(임베드/직접 재생 양쪽에 적용) 단계 변경을 요청하고,
// 새 값이 상태로 돌아오면 가사 창에 띄운다 — 게임 중에는 앱의 볼륨 슬라이더가 보이지 않기 때문.
let pendingVolumeFlash = false;

function toggleMuteHotkey() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  pendingVolumeFlash = true; // 새 볼륨(0 또는 복원값)을 가사 창에 잠깐 띄운다
  mainWindow.webContents.send('lyrics:control', 'mute-toggle');
}

// Alt+1/2를 꾹 누르면 자동 반복 콜백마다 호출된다 — 반복 중에는 걸음을 키워 볼륨이 빠르게 슬라이드되게 한다
// (첫 입력 ±1, 반복 ±4, 1.5초 이상 누르면 ±8). 발동 시점은 그대로: 첫 콜백부터 즉시 반응.
let volStepLast = 0;
let volStepHoldStart = 0;

function stepMasterVolume(delta) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  const repeating = now - volStepLast < 250;
  if (!repeating) volStepHoldStart = now;
  volStepLast = now;
  const step = !repeating ? 1 : now - volStepHoldStart > 1500 ? 8 : 4;
  pendingVolumeFlash = true;
  mainWindow.webContents.send('lyrics:control', 'volume-step', delta * step);
}

function sendLyricsFlash(text) {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || lyricsWindow.webContents.isLoading()) return;
  lyricsWindow.webContents.send('lyrics:flash', text);
}

// ── 가사 싱크 보정: 곡(영상 id)마다 따로 저장. Alt+D = 가사를 빠르게(+), Alt+A = 늦게(−) ──
const LYRICS_OFFSET_STEP = 250;
let lyricsOffsets = {};
let lyricsOffsetsWriteTimer = null;

function loadLyricsOffsets() {
  try {
    const raw = JSON.parse(fs.readFileSync(LYRICS_OFFSETS_FILE(), 'utf8'));
    lyricsOffsets = raw && typeof raw === 'object' ? raw : {};
  } catch { lyricsOffsets = {}; }
}

function currentLyricsOffset() {
  const ms = Number(lyricsOffsets[lyricsState.id]);
  return Number.isFinite(ms) ? ms : 0;
}

function sendLyricsOffset() {
  const ms = currentLyricsOffset();
  for (const win of [lyricsWindow, mainWindow]) {
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('lyrics:offset', ms);
  }
}

// delta = null 이면 원래 싱크(0)로 되돌린다 (Alt+S). 보정 폭에는 제한을 두지 않는다(사용자 요청 — 10초 상한 제거)
function adjustLyricsOffset(delta) {
  if (!lyricsState.id) { sendLyricsFlash('재생 중인 곡이 없습니다'); return; }
  const next = delta === null ? 0 : currentLyricsOffset() + delta;
  if (next === 0) delete lyricsOffsets[lyricsState.id];
  else lyricsOffsets[lyricsState.id] = next;
  clearTimeout(lyricsOffsetsWriteTimer);
  lyricsOffsetsWriteTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(LYRICS_OFFSETS_FILE()), { recursive: true });
      fs.writeFileSync(LYRICS_OFFSETS_FILE(), JSON.stringify(lyricsOffsets));
    } catch {}
  }, 500);
  sendLyricsOffset();
  const sec = (Math.abs(next) / 1000).toFixed(2).replace(/\.?0+$/, '');
  sendLyricsFlash(next === 0 ? '🎵 가사 싱크 원래대로'
    : next > 0 ? `⏩ 가사 ${sec}초 빠르게` : `⏪ 가사 ${sec}초 늦게`);
}

function sendLyricsScroll(delta) {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || lyricsWindow.webContents.isLoading()) return;
  lyricsWindow.webContents.send('lyrics:scroll', delta);
}

// ── 플로팅 창 레이아웃 프리셋: 크기·모양·표시 항목만 저장한다 (항상 위·클릭 비활성화 같은 동작 설정은 제외) ──
const LYRICS_PRESET_KEYS = [
  'width', 'height', 'backgroundOpacity', 'uiOpacity', 'fontSize', 'fontFamily', 'coverMode', 'videoFit',
  'showLyrics', 'showTrackInfo', 'showProgressBar', 'showPlaybackControls',
  'showPreviousButton', 'showPauseButton', 'showNextButton', 'showVolumeButton',
];
const LYRICS_PRESET_MAX = 10;
let lyricsPresets = [];

function loadLyricsPresets() {
  try {
    const raw = JSON.parse(fs.readFileSync(LYRICS_PRESETS_FILE(), 'utf8'));
    lyricsPresets = Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && p.settings).slice(0, LYRICS_PRESET_MAX) : [];
  } catch { lyricsPresets = []; }
}

function writeLyricsPresets() {
  try {
    fs.mkdirSync(path.dirname(LYRICS_PRESETS_FILE()), { recursive: true });
    fs.writeFileSync(LYRICS_PRESETS_FILE(), JSON.stringify(lyricsPresets, null, 2));
  } catch {}
}

const presetNames = () => lyricsPresets.map((p) => p.name);

function saveLyricsPreset(name) {
  const clean = String(name || '').trim().slice(0, 30);
  if (!clean) return { ok: false, error: '이름을 입력하세요', names: presetNames() };
  const settings = {};
  for (const key of LYRICS_PRESET_KEYS) settings[key] = lyricsSettings[key];
  const i = lyricsPresets.findIndex((p) => p.name === clean);
  if (i >= 0) lyricsPresets[i] = { name: clean, settings }; // 같은 이름은 덮어쓴다
  else if (lyricsPresets.length >= LYRICS_PRESET_MAX) return { ok: false, error: `프리셋은 최대 ${LYRICS_PRESET_MAX}개까지 저장됩니다`, names: presetNames() };
  else lyricsPresets.push({ name: clean, settings });
  writeLyricsPresets();
  return { ok: true, names: presetNames() };
}

function applyLyricsPreset(name) {
  const preset = lyricsPresets.find((p) => p.name === name);
  if (!preset) return null;
  const patch = {};
  for (const key of LYRICS_PRESET_KEYS) if (preset.settings[key] != null) patch[key] = preset.settings[key];
  return updateLyricsSettings(patch);
}

function deleteLyricsPreset(name) {
  lyricsPresets = lyricsPresets.filter((p) => p.name !== name);
  writeLyricsPresets();
  return presetNames();
}

const LYRICS_SHORTCUTS = [
  { accelerator: 'Alt+`', label: '음소거 토글', run: () => toggleMuteHotkey() },
  { accelerator: 'Alt+1', label: '볼륨 1 감소', run: () => stepMasterVolume(-1) },
  { accelerator: 'Alt+2', label: '볼륨 1 증가', run: () => stepMasterVolume(1) },
  { accelerator: 'Alt+3', label: '가사 창 표시/숨기기', run: () => toggleLyricsWindow() },
  { accelerator: 'Alt+4', label: '가사 창 클릭 활성화/비활성화', run: toggleLyricsClickThrough },
  { accelerator: 'Alt+5', label: '가사 창 다시 맨 위로(가리기 해제)', run: () => keepLyricsOnTop() },
  { accelerator: 'Alt+Q', label: '이전 곡 (Alt+W 누른 채 Q 꾹: 되감기)', run: () => trackOrScrub('Alt+Q', -1) },
  { accelerator: 'Alt+W', label: '재생/일시정지', run: () => playToggleOrChord() },
  { accelerator: 'Alt+E', label: '다음 곡 (Alt+W 누른 채 E 꾹: 빨리 감기)', run: () => trackOrScrub('Alt+E', 1) },
  // 사용자 요청으로 방향을 맞바꿨다 — Alt+A = 늦게(왼쪽=뒤로 미룸), Alt+D = 빠르게
  { accelerator: 'Alt+A', label: '가사 싱크 늦게 (0.25초)', run: () => adjustLyricsOffset(-LYRICS_OFFSET_STEP) },
  { accelerator: 'Alt+D', label: '가사 싱크 빠르게 (0.25초)', run: () => adjustLyricsOffset(LYRICS_OFFSET_STEP) },
  { accelerator: 'Alt+S', label: '가사 싱크 원래대로', run: () => adjustLyricsOffset(null) },
  // 싱크 없는 가사(본문만)일 때 플로팅 창에서 줄 넘기기 — 게임 중엔 마우스 휠을 쓸 수 없으므로 단축키로
  { accelerator: 'Alt+Z', label: '싱크 없는 가사 위로 넘기기', run: () => sendLyricsScroll(-2) },
  { accelerator: 'Alt+X', label: '싱크 없는 가사 아래로 넘기기', run: () => sendLyricsScroll(2) },
];

// Alt+Q/E는 즉시 이전/다음 곡(판정 대기 없음). 되감기/빨리 감기는 Alt+W를 누른 채 Q/E를 꾹 누르는 코드.
// 전역 단축키는 키를 뗀 순간을 모르지만, 누르고 있으면 OS 자동 반복으로 콜백이 계속 오는 성질을 쓴다:
//  - Alt+W 콜백이 최근(350ms 안)에 왔으면 W를 누르고 있는 것 → 그때 오는 Alt+Q/E는 슬라이드
//  - 슬라이드가 시작되면 Q/E의 자동 반복(마지막 누른 키만 반복된다)이 250ms 안에 이어지는 동안 계속 슬라이드
//  - Alt+W 자체의 재생/일시정지는 250ms 뒤에 확정 — 그 안에 Q/E가 따라오면(코드) 토글하지 않는다
let wLastAt = 0;
let wTimer = null;
let wChorded = false;
const W_HELD_WINDOW = 1000; // W 콜백 후 이 시간 안에 오는 Q/E는 코드로 본다 (키 반복 지연 최대 1초를 덮는다)
const scrubState = new Map(); // key → { lastAt, lastSeek, timer }

function playToggleOrChord() {
  const now = Date.now();
  const repeat = now - wLastAt < W_HELD_WINDOW;
  wLastAt = now;
  if (repeat) return; // W를 누르고 있는 동안의 자동 반복 — 코드 창만 연장
  wChorded = false;
  clearTimeout(wTimer);
  wTimer = setTimeout(() => { if (!wChorded) sendControl('toggle-play'); }, 250);
}

// W를 '누르고 있는 중'으로 보는 창: W의 첫 반복은 키 반복 지연(기본 500ms, 최대 1초) 뒤에야 오므로
// 마지막 W 콜백 후 1초까지는 눌린 것으로 본다(그 사이 Q/E가 오면 코드). W 반복이 이어지면 창이 계속 연장된다.
function trackOrScrub(key, direction) {
  const now = Date.now();
  const st = scrubState.get(key) || { lastAt: 0, lastSeek: 0, scrubbing: false, timer: null };
  const repeat = now - st.lastAt < 250; // Q/E를 계속 누르고 있어 자동 반복으로 들어온 콜백
  st.lastAt = now;
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.lastAt = 0; st.scrubbing = false; }, 250);
  scrubState.set(key, st);
  if (repeat && !st.scrubbing) return; // 코드가 아닌데 Q/E를 붙잡고 있는 경우: 곡을 연달아 넘기지 않는다
  const chord = st.scrubbing || now - wLastAt < W_HELD_WINDOW;
  if (!chord) {
    sendControl(direction < 0 ? 'previous' : 'next'); // 단발: 즉시
    return;
  }
  st.scrubbing = true;
  wChorded = true;
  clearTimeout(wTimer);
  if (now - st.lastSeek >= 100) { // 자동 반복은 초당 30회 안팎 — 100ms마다 2초씩 = 초당 20초
    st.lastSeek = now;
    sendControl('seek-by', direction * 2);
  }
}

function sendControl(action, value) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('lyrics:control', action, value);
}

let lyricsShortcutStatus = []; // 설정 패널이 등록 성공 여부를 보여준다 (실패는 조용히 넘기면 안 된다)

function registerLyricsShortcuts() {
  lyricsShortcutStatus = LYRICS_SHORTCUTS.map(({ accelerator, label, run }) => {
    let ok = false;
    try { ok = globalShortcut.register(accelerator, run); } catch { ok = false; }
    return { accelerator, label, ok };
  });
}

// 창 이동: -webkit-app-region 드래그는 setIgnoreMouseEvents(forward) 상태와 같이 쓰면 먹지 않는다(실측 신고).
// 대신 렌더러가 앨범/영상 박스에서 pointerdown/up을 알리면 main이 커서 위치를 폴링해 창을 옮긴다.
let lyricsDragTimer2 = null;
let lyricsDragOffset = null;

function beginLyricsDrag() {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = lyricsWindow.getBounds();
  lyricsDragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  clearInterval(lyricsDragTimer2);
  setLyricsDragging(true);
  lyricsHit = true; // 드래그 중에는 커서가 박스 밖으로 살짝 나가도 마우스를 계속 받는다
  applyLyricsClickThrough();
  lyricsDragTimer2 = setInterval(() => {
    if (!lyricsWindow || lyricsWindow.isDestroyed() || !lyricsDragOffset) return endLyricsDrag();
    const c = screen.getCursorScreenPoint();
    // setPosition만 쓰면 Windows의 DPI 배율(125% 등)에서 프레임 없는 투명 창의 크기가 조금씩 커진다(실측 신고)
    // → 매번 폭·높이를 설정값으로 못박아 크기를 고정한다
    lyricsWindow.setBounds({
      x: Math.round(c.x - lyricsDragOffset.x),
      y: Math.round(c.y - lyricsDragOffset.y),
      width: lyricsSettings.width,
      height: lyricsSettings.height,
    });
  }, 16);
}

function endLyricsDrag() {
  clearInterval(lyricsDragTimer2);
  lyricsDragTimer2 = null;
  lyricsDragOffset = null;
  setLyricsDragging(false);
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    const b = lyricsWindow.getBounds();
    lyricsWindow.setBounds({ ...b, width: lyricsSettings.width, height: lyricsSettings.height });
  }
  saveLyricsBounds();
}

function setLyricsDragging(flag) {
  if (lyricsDragging === flag) return; // 'move'는 초당 수십 번 오므로 상태가 바뀔 때만 알린다
  lyricsDragging = flag;
  if (lyricsWindow && !lyricsWindow.isDestroyed() && !lyricsWindow.webContents.isLoading()) {
    lyricsWindow.webContents.send('lyrics:dragging', flag);
  }
}

function showLyricsWindow() {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    const bounds = loadLyricsBounds();
    lyricsWindow = new BrowserWindow({
      ...bounds,
      title: 'Lyrics',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: lyricsSettings.alwaysOnTop,
      show: false,
      // 가려져 있어도 가사 줄 이동과 미러 영상 동기화가 멈추지 않도록
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    lyricsWindow.setAlwaysOnTop(lyricsSettings.alwaysOnTop, LYRICS_TOP_LEVEL);
    lyricsWindow.on('move', () => {
      setLyricsDragging(true);
      clearTimeout(lyricsDragTimer);
      lyricsDragTimer = setTimeout(() => setLyricsDragging(false), 260); // 움직임이 멎으면 테두리도 사라진다
    });
    lyricsWindow.on('moved', () => {
      clearTimeout(lyricsDragTimer);
      lyricsDragTimer = setTimeout(() => setLyricsDragging(false), 120);
      saveLyricsBounds();
    });
    lyricsWindow.on('closed', () => { lyricsWindow = null; });
    lyricsWindow.webContents.on('did-finish-load', sendLyricsToWindow);
    // '영상 작게 표시'의 미러 임베드도 메인 창과 똑같이 유튜브 자체 UI를 지운다
    lyricsWindow.webContents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) return;
      try { hideEmbedChrome(webFrameMain.fromId(frameProcessId, frameRoutingId)); } catch {}
    });
    lyricsWindow.loadURL(`http://127.0.0.1:${lyricsServerPort}/lyrics.html`);
  }
  applyLyricsClickThrough();
  lyricsWindow.showInactive();
  keepLyricsOnTop(); // 작업 표시줄 등 다른 topmost 창에 밀려 있었다면 다시 위로
  sendLyricsToWindow();
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
  // 길이는 썸네일 배지("3:45")에 있다 — 다음 곡 가사를 미리 찾을 때 재생시간 비교에 쓴다
  let seconds = 0;
  try {
    const m = JSON.stringify(vm.contentImage || '').match(/"text":"((?:\d+:)?\d{1,2}:\d{2})"/);
    if (m) seconds = m[1].split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  } catch {}
  return { id: vm.contentId, title: title || '', author, seconds };
}

function rendererToItem(r) {
  if (!r.videoId || r.isPlayable === false) return null;
  const title = r.title && r.title.runs && r.title.runs[0] && r.title.runs[0].text;
  const author = r.shortBylineText && r.shortBylineText.runs && r.shortBylineText.runs[0] && r.shortBylineText.runs[0].text;
  return { id: r.videoId, title: title || '', author: author || '', seconds: Number(r.lengthSeconds) || 0 };
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

// 재생목록 응답에는 곡 목록 말고도 "맞춤 동영상" 같은 섹션이 함께 실려 있고, 섹션마다 자기
// continuation 토큰을 갖는다. 트리 전체를 훑으면 두 가지가 어긋난다(실측):
//   1) 섹션의 추천 영상이 재생목록 곡으로 딸려 들어온다 → 실제보다 곡이 많아짐
//   2) 100곡 이하 재생목록은 곡 목록 토큰이 아예 없어서, 처음 발견된 섹션 토큰을 다음 페이지로
//      오인해 따라간다(50곡·25곡짜리 목록에서 확인) → 추천 곡이 뒤에 붙고, 반대로 토큰 순서가
//      바뀌면 남은 곡을 못 받아 실제보다 곡이 적어짐
// 그래서 "영상 항목이 들어 있는 첫 배열"만 재생목록 본문으로 보고, 그 배열 안의 continuation만
// 다음 페이지로 삼는다. 배열 단위 규칙이라 lockupViewModel/playlistVideoRenderer 어느 쪽이든,
// 노드 경로가 바뀌어도 동작한다.
function playlistItemFrom(child) {
  if (!child || typeof child !== 'object') return null;
  if (child.lockupViewModel) return lockupToItem(child.lockupViewModel);
  if (child.playlistVideoRenderer) return rendererToItem(child.playlistVideoRenderer);
  return null;
}

function isVideoNode(child) {
  return !!(child && typeof child === 'object' && (child.lockupViewModel || child.playlistVideoRenderer));
}

function isContinuationNode(child) {
  return !!(child && typeof child === 'object' && (child.continuationItemViewModel || child.continuationItemRenderer));
}

function collectPlaylistNodes(node, out) {
  if (!node || typeof node !== 'object' || out.done) return;
  if (Array.isArray(node)) {
    const items = [];
    let token = null;
    let videoArray = false;
    for (const child of node) {
      if (isVideoNode(child)) {
        videoArray = true;
        const item = playlistItemFrom(child);
        if (item) items.push(item); // 비공개·삭제된 곡(재생 불가)은 여기서 걸러진다
        continue;
      }
      if (isContinuationNode(child)) {
        if (!token) token = findToken(child.continuationItemViewModel || child.continuationItemRenderer);
        continue;
      }
      collectPlaylistNodes(child, out);
      if (out.done) return;
    }
    if (videoArray) {
      out.items.push(...items);
      out.continuation = token;
      out.done = true; // 첫 영상 배열이 재생목록 본문 — 뒤따르는 추천 섹션은 보지 않는다
    }
    return;
  }
  for (const value of Object.values(node)) {
    collectPlaylistNodes(value, out);
    if (out.done) return;
  }
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
// 재생목록 browse 응답에는 continuation 토큰이 둘 있다: 곡 목록(다음 100곡) 토큰과 섹션 토큰이며,
// 이 쪽이 "맞춤 동영상"을 싣는다. 예전에는 playlistVideoListRenderer 서브트리 안/밖으로 갈랐지만
// 새 UI에는 그 노드가 아예 없어(실측) 곡 목록 토큰을 집어오게 됐다. 이제 collectPlaylistNodes와
// 같은 기준을 쓴다 — 영상 항목과 같은 배열에 있는 토큰은 곡 목록, 그렇지 않은 토큰이 섹션 토큰.
function findRecsToken(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    const videoArray = node.some(isVideoNode);
    for (const child of node) {
      if (isContinuationNode(child)) {
        if (videoArray) continue; // 곡 목록의 다음 페이지 토큰
        const token = findToken(child.continuationItemViewModel || child.continuationItemRenderer);
        if (token) return token;
        continue;
      }
      const token = findRecsToken(child);
      if (token) return token;
    }
    return null;
  }
  for (const value of Object.values(node)) {
    const token = findRecsToken(value);
    if (token) return token;
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
    contToken = findRecsToken(data);
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

  const out = { items: [], continuation: null, done: false };
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
  const out = { items: [], continuation: null, done: false };
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

// ── 임베드 플레이어(유튜브 iframe) 자체 UI 제거 ──
// controls:0으로도 seekTo 순간 제목줄·'동영상 더보기' 오버레이·공유/나중에 볼 동영상 버튼·베젤이
// 수백 ms 떠오른다. 렌더러에서는 교차 출처라 손댈 수 없지만, 메인 프로세스는 webFrameMain으로
// 그 프레임 안에서 직접 스크립트를 실행할 수 있어 CSS를 심어 아예 그리지 않게 만든다.
const EMBED_CHROME_CSS = `
  .ytp-chrome-top, .ytp-chrome-top-buttons, .ytp-chrome-bottom, .ytp-chrome-controls,
  .ytp-title, .ytp-title-channel, .ytp-title-text, .ytp-show-cards-title,
  .ytp-gradient-top, .ytp-gradient-bottom,
  .ytp-pause-overlay, .ytp-pause-overlay-container, .ytp-scroll-min,
  .ytp-suggestion-set, .ytp-suggested-action, .ytp-suggested-action-badge,
  .ytp-bezel, .ytp-bezel-text-wrapper,
  .ytp-watermark, .ytp-impression-link,
  .ytp-ce-element, .ytp-endscreen-content, .ytp-cards-teaser, .ytp-cards-button,
  .ytp-share-button, .ytp-watch-later-button, .ytp-large-play-button,
  .ytp-copylink-button, .ytp-overflow-button, .ytp-info-panel-preview {
    display: none !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
  /* 클래스 이름이 바뀌어도 통하도록: 플레이어 안에서 영상·자막·스피너를 뺀 모든 오버레이를 없앤다 */
  #movie_player > *:not(.html5-video-container):not(.ytp-caption-window-container):not(.ytp-spinner):not(.ytp-error) {
    display: none !important;
  }
`;

function refreshEmbedChrome(wc) {
  if (!wc || wc.isDestroyed()) return;
  // 곡마다 불린다 — 임베드 iframe이 그 사이 새로 로드됐어도 가드를 다시 심어 둔다(이미 있으면 무시됨).
  // 가사 창(음소거 미러)은 소리가 없으므로 메인 창일 때만.
  const isMain = mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents;
  try {
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (isMain) installAudioGuard(frame);
      hideEmbedChrome(frame);
    }
  } catch {}
}

// ── 오디오 가드: 볼륨 상한(누출 차단) + 이퀄라이저 — audio-guard.js 참고 ──
// 앱 볼륨은 렌더러가 소유하지만, 실제 소리가 나는 곳은 유튜브 프레임(임베드 iframe·직접 재생 웹뷰)이다.
// main이 현재 상태를 들고 있다가 그런 프레임이 뜰 때마다 가드를 심고, 바뀔 때마다 모든 프레임에 뿌린다.
const AUDIO_GUARD_CODE = fs.readFileSync(path.join(__dirname, 'audio-guard.js'), 'utf8');
const EQ_BANDS = 6;

// 렌더러의 체감 볼륨 커브와 같은 식 (effectiveVolume): 0~100 → 진폭 0~1 (40dB 구간 dB 선형)
function volumeToCap(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(1, Math.pow(10, (Math.min(100, v) - 100) / 50));
}

function normalizeEq(eq) {
  const src = eq && typeof eq === 'object' ? eq : {};
  const gains = Array.from({ length: EQ_BANDS }, (_, i) => {
    const g = Number(Array.isArray(src.gains) ? src.gains[i] : 0);
    return Number.isFinite(g) ? Math.max(-12, Math.min(12, g)) : 0;
  });
  return { enabled: !!src.enabled, gains };
}

// 시작 시 settings.json에서 복원 — 렌더러가 상태를 보내기 전에 뜬 프레임도 올바른 상한을 갖게
let audioState = { cap: 0, eq: normalizeEq(null) };
function loadInitialAudioState() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    audioState = { cap: saved.volume != null ? volumeToCap(saved.volume) : 1, eq: normalizeEq(saved.eq) };
  } catch {
    audioState = { cap: 1, eq: normalizeEq(null) }; // 설정 파일이 없으면 렌더러 기본 볼륨(100)과 같게
  }
}

function isYoutubeFrame(frame) {
  return !!frame && typeof frame.url === 'string' && /youtube(-nocookie)?\.com\//.test(frame.url);
}

function installAudioGuard(frame) {
  if (!isYoutubeFrame(frame)) return Promise.resolve(false);
  const code = `window.__ympAudioInit = ${JSON.stringify(audioState)};\n${AUDIO_GUARD_CODE}\n`
    + `window.__ympSetAudio && window.__ympSetAudio(${JSON.stringify(audioState)}); !!window.__ympAudio`;
  return frame.executeJavaScript(code).then((ok) => !!ok).catch(() => false);
}

// 소리가 날 수 있는 모든 유튜브 프레임 — 메인 창의 임베드 + 직접 재생 웹뷰
function audioFrames() {
  const frames = [];
  for (const wc of [mainWindow && mainWindow.webContents, webviewWC]) {
    if (!wc || wc.isDestroyed()) continue;
    try { for (const f of wc.mainFrame.framesInSubtree) if (isYoutubeFrame(f)) frames.push(f); } catch {}
  }
  return frames;
}

function pushAudioState() {
  const code = `window.__ympSetAudio && window.__ympSetAudio(${JSON.stringify(audioState)}); 0`;
  for (const f of audioFrames()) f.executeJavaScript(code).catch(() => {});
}

// 직접 재생 웹뷰용 프리로드: 광고 프루닝 + 오디오 가드를 페이지 스크립트보다 먼저 실행한다.
// 웹뷰는 샌드박스라 프리로드에서 로컬 파일을 require할 수 없으므로 두 파일을 하나로 합쳐 userData에 쓴다.
// 초기 상태는 동기 IPC로 받아 둔다 — 첫 영상이 재생되기 전에 상한이 걸려 있어야 한다.
function buildWebviewPreload() {
  const file = path.join(app.getPath('userData'), 'webview-preload.js');
  const body = [
    "try { window.__ympAudioInit = require('electron').ipcRenderer.sendSync('audio:state'); } catch (e) {}",
    fs.readFileSync(path.join(__dirname, 'adprune-preload.js'), 'utf8'),
    AUDIO_GUARD_CODE,
  ].join('\n;\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
let webviewPreloadPath = null;

const AD_PRUNE_SNIPPET = `(() => {
  if (window.__ympAdPrune) return;
  window.__ympAdPrune = true;
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
  const prune = (o) => {
    if (!o || typeof o !== 'object') return o;
    for (const k of AD_KEYS) { if (k in o) { try { delete o[k]; } catch (e) {} } }
    if (o.playerResponse) prune(o.playerResponse);
    return o;
  };
  const np = JSON.parse;
  JSON.parse = function (t, r) { return prune(np.call(this, t, r)); };
  if (window.Response && Response.prototype && Response.prototype.json) {
    const nj = Response.prototype.json;
    Response.prototype.json = function (...a) { return nj.apply(this, a).then(prune); };
  }
})()`;

function hideEmbedChrome(frame, attempt = 0) {
  if (!frame || typeof frame.url !== 'string' || !/youtube(-nocookie)?\.com\//.test(frame.url)) return;
  // 임베드 플레이어가 받는 광고 데이터를 걷어낸다 (곡 전환은 loadVideoById → XHR이라 여기서 잡힌다)
  frame.executeJavaScript(AD_PRUNE_SNIPPET).catch(() => {});
  frame.executeJavaScript(`(() => {
    // ① 알려진 클래스는 CSS로 차단
    let s = document.getElementById('__ymp_no_chrome');
    if (!s) {
      s = document.createElement('style');
      s.id = '__ymp_no_chrome';
      (document.head || document.documentElement).appendChild(s);
    }
    s.textContent = ${JSON.stringify(EMBED_CHROME_CSS)};

    // ② 클래스 이름·구조가 바뀌어도 통하도록: <video>로 이어지는 계보(조상 체인)만 남기고,
    //    그 각 단계의 형제 요소를 전부 숨긴다 = 영상 말고 화면에 그려지는 것이 남지 않는다.
    //    (자막·로딩·오류 표시와 head/script류는 예외.) 유튜브가 나중에 만들어 붙여도 옵저버가 즉시 숨긴다.
    const hideOverlays = () => {
      const v = document.querySelector('video');
      if (!v) return;
      const keep = new Set();
      for (let n = v; n; n = n.parentElement) keep.add(n);
      for (const node of keep) {
        for (const child of Array.from(node.children)) {
          if (keep.has(child)) continue;
          const tag = child.tagName;
          if (tag === 'HEAD' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'TEMPLATE') continue;
          const cls = String(child.className || '');
          if (/caption|spinner|error|loading/i.test(cls)) continue;
          if (child.style.display !== 'none') child.style.setProperty('display', 'none', 'important');
        }
      }
    };
    hideOverlays();
    if (!window.__ympChromeGuard) {
      window.__ympChromeGuard = new MutationObserver(() => {
        if (!document.getElementById('__ymp_no_chrome')) (document.head || document.documentElement).appendChild(s);
        hideOverlays();
      });
      window.__ympChromeGuard.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    }
    return document.querySelectorAll('#movie_player').length;
  })()`).catch(() => {
    if (attempt < 4) setTimeout(() => hideEmbedChrome(frame, attempt + 1), 600); // 프레임 준비 전이면 재시도
  });
}

let mainWindow = null;

function createWindow(port) {
  const win = mainWindow = new BrowserWindow({
    width: 1420,
    height: 800,
    title: 'YouTube Music',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, // 임베드 차단 곡의 워치페이지 폴백 재생용
      backgroundThrottling: false, // 최소화 중에도 곡 종료 감지·진행 위치 전달이 계속 돌아야 한다
    },
  });
  // 임베드 iframe이 뜨거나 다시 로드될 때마다 유튜브 자체 UI를 숨기는 CSS를 심는다
  win.webContents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    let frame = null;
    try { frame = webFrameMain.fromId(frameProcessId, frameRoutingId); } catch {}
    installAudioGuard(frame); // 볼륨 상한·EQ — 소리가 나는 임베드에만 (가사 창 미러는 음소거라 제외)
    try { hideEmbedChrome(frame); } catch {}
  });
  // F11(기본 메뉴의 전체화면 토글) 등 앱 버튼을 거치지 않은 경로로 전체화면이 바뀌어도
  // 렌더러의 몰입 모드(사이드바 숨김·해제 버튼)가 따라오도록 상태를 알린다
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false));
  // 폴백 웹뷰(워치페이지)에 광고 프루닝 프리로드를 붙인다 — 요청을 막는 대신 플레이어 응답에서
  // 광고 데이터를 걷어내는 방식이라 감지되지 않고 광고 대기 시간도 생기지 않는다.
  // 전역(ytInitialPlayerResponse)과 JSON.parse를 가로채야 하므로 페이지와 같은 월드가 필요하다.
  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    if (!webviewPreloadPath) {
      try { webviewPreloadPath = buildWebviewPreload(); } catch { webviewPreloadPath = path.join(__dirname, 'adprune-preload.js'); }
    }
    webPreferences.preload = webviewPreloadPath;
    webPreferences.contextIsolation = false;
    webPreferences.nodeIntegration = false;
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.on('closed', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close();
    if (lyricsSettingsWindow && !lyricsSettingsWindow.isDestroyed()) lyricsSettingsWindow.close();
    mainWindow = null;
  });
}

let webviewWC = null; // 폴백 웹뷰의 webContents (창에 하나뿐)
let adBlockEnabled = true; // 유튜브가 광고 차단을 감지하면 false로 내려간다 (adblock:disable)

app.whenReady().then(async () => {
  const port = await startServer();
  lyricsServerPort = port;
  lyricsSettings = loadLyricsSettings();
  loadInitialAudioState();
  loadLyricsOffsets();
  loadLyricsPresets();
  // 가사 저장소(게스트 로컬 재생목록 곡만) + 자동 싱크(음성 인식 실행 파일·모델이 있을 때만)
  lyricsStore = new LyricsStore(path.join(app.getPath('userData'), 'lyrics-store'));
  lyricsStore.load(localListIds(loadPlaylists()));
  asrReady = asrRunner.available();
  syncEngine.enabled = lyricsSettings.autoSync;
  pruneMtCache();
  // 광고/추적 도메인 차단 — **메인 창(앱 UI + 임베드 플레이어)에서 나온 요청만** 막는다.
  // 폴백(워치페이지) 웹뷰까지 막으면 유튜브가 광고 차단으로 감지해 "서비스 약관을 위반하는
  // 광고 차단 프로그램" 화면으로 재생을 통째로 막는다. 예전에는 "웹뷰가 아니면 차단"이라는
  // 반대 조건이었는데, 워치페이지의 광고 요청 중 서비스 워커/워커에서 나가는 것들은
  // details.webContentsId가 비어 있어 그 조건에 걸려 결국 차단됐다 — 감지의 직접 원인.
  // 그래서 화이트리스트가 아니라 **메인 창 id와 일치할 때만** 취소하도록 뒤집었다.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: AD_URL_PATTERNS },
    (details, callback) => callback({
      cancel: adBlockEnabled
        && !!mainWindow && !mainWindow.isDestroyed()
        && details.webContentsId === mainWindow.webContents.id,
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
  ipcMain.handle('playlists:save', (_event, playlists) => {
    savePlaylists(playlists);
    if (lyricsStore) lyricsStore.setLocalLists(localListIds(playlists)); // 지운 재생목록의 곡 가사는 정리된다
  });
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
  // 로컬 재생목록의 곡 목록을 가사 저장소에 알린다(끝까지 받으면 빠진 곡의 가사를 지운다)
  ipcMain.handle('playlist:fetchFirst', async (_event, listId) => {
    const r = await fetchPlaylistFirst(listId);
    if (lyricsStore) {
      const ids = (r.items || []).map((it) => it && it.id).filter(Boolean);
      lyricsStore.beginScan(String(listId), ids);
      if (!r.cont) lyricsStore.addScan(String(listId), [], true);
    }
    if (r.cont) r.cont.listId = String(listId);
    return r;
  });
  ipcMain.handle('playlist:fetchMore', async (_event, cont) => {
    const r = await fetchPlaylistMore(cont);
    if (lyricsStore && cont && cont.listId) lyricsStore.addScan(cont.listId, (r.items || []).map((it) => it && it.id).filter(Boolean), !r.cont);
    return r;
  });
  ipcMain.handle('playlist:meta', (_event, listId) => fetchPlaylistMeta(listId));
  // 구글 계정 연동 + 유튜브 검색
  ipcMain.handle('account:status', () => fetchAccountStatus());
  ipcMain.handle('account:login', (event) => openLoginWindow(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('account:logout', () => accountLogout());
  ipcMain.handle('account:playlists', () => fetchAccountPlaylists());
  ipcMain.handle('account:addToPlaylist', (_event, p) => addToPlaylist(p.playlistId, p.videoId));
  ipcMain.handle('search:videos', (_event, query) => searchVideos(query));
  ipcMain.handle('recs:fetch', (_event, p) => fetchPlaylistRecs(p.listId, p.token));
  ipcMain.handle('lyrics:settings:get', () => lyricsSettings);
  ipcMain.handle('lyrics:settings:save', (_event, settings) => updateLyricsSettings(settings));
  ipcMain.handle('lyrics:settings:reset', () => updateLyricsSettings(DEFAULT_LYRICS_SETTINGS));
  ipcMain.handle('lyrics:data:get', () => lyricsData);
  ipcMain.handle('lyrics:offset:get', () => currentLyricsOffset());
  ipcMain.on('lyrics:prefetch', (_event, info) => { prefetchLyrics(info).catch(() => {}); });
  ipcMain.handle('lyrics:presets:list', () => presetNames());
  ipcMain.handle('lyrics:presets:save', (_event, name) => saveLyricsPreset(name));
  ipcMain.handle('lyrics:presets:apply', (_event, name) => applyLyricsPreset(name));
  ipcMain.handle('lyrics:presets:delete', (_event, name) => deleteLyricsPreset(name));
  ipcMain.handle('lyrics:shortcuts', () => lyricsShortcutStatus);
  ipcMain.handle('app:version', () => app.getVersion());
  // 곡이 바뀔 때마다(임베드 프레임이 새로 준비될 수 있으므로) 유튜브 UI 숨김 CSS를 다시 심는다
  ipcMain.on('embed:refresh-chrome', (event) => refreshEmbedChrome(event.sender));
  // 플로팅 창의 설정 버튼 → 플로팅 창 옆에 별도 설정 팝업 (메인 창의 디자인 설정 섹션과 같은 값을 공유)
  ipcMain.on('lyrics:settings:open', showLyricsSettingsWindow);
  ipcMain.on('lyrics:settings:close', () => {
    if (lyricsSettingsWindow && !lyricsSettingsWindow.isDestroyed()) lyricsSettingsWindow.close();
  });
  // 렌더러가 상호작용 요소 위에 커서가 있는지 알려준다 → 그 동안만 창이 마우스를 받는다
  ipcMain.on('app:theme', (_event, theme) => {
    if (!theme || typeof theme !== 'object') return;
    appTheme = { accent: String(theme.accent || '#1db954'), base: String(theme.base || '#000'), panel: String(theme.panel || '#18191f') };
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.__themeSent = true;
    sendThemeToLyricsWindows();
  });
  ipcMain.handle('lyrics:theme:get', () => appTheme); // 창이 뜬 뒤 스스로 가져간다 (did-finish-load 시점엔 아직 isLoading일 수 있다)
  ipcMain.on('lyrics:drag', (_event, flag) => { if (flag) beginLyricsDrag(); else endLyricsDrag(); });
  ipcMain.on('lyrics:hit', (_event, flag) => {
    lyricsHit = !!flag;
    applyLyricsClickThrough();
  });
  // 플로팅 창의 재생 컨트롤 → 메인 창. seek는 0~1 비율, volume은 0~100 값을 함께 넘긴다.
  ipcMain.on('lyrics:control', (_event, action, value) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (['previous', 'toggle-play', 'next', 'seek', 'seek-by', 'volume', 'volume-save', 'volume-step', 'mute-toggle'].includes(action)) {
      mainWindow.webContents.send('lyrics:control', action, Number(value));
    }
  });
  ipcMain.on('lyrics:update', (_event, data) => updateLyricsState(data));
  ipcMain.on('lyrics:toggle', toggleLyricsWindow);
  ipcMain.on('lyrics:hide', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.hide();
  });
  ipcMain.on('lyrics:retry', () => {
    if (!lyricsKey) return;
    // 다시 찾기 = 저장본·자동 싱크 상태도 버리고 처음부터
    if (lyricsStore && lyricsState.id) lyricsStore.remove(lyricsState.id);
    syncEngine.drop(lyricsState.id);
    syncMeta.delete(lyricsState.id);
    searchAlternatives.delete(lyricsKey);
    lyricsCache.delete(lyricsKey);
    lyricsData = null;
    sendLyricsToWindow();
    if (lyricsState.status !== 'idle' && lyricsState.title) {
      loadLyricsForState(lyricsState, lyricsKey).catch(() => {});
    }
  });
  // 검색창 기본값: 유튜브 제목을 그대로 넣지 않고 정제한 제목/아티스트를 준다
  ipcMain.handle('lyrics:parse', (_event, params) => {
    const q = buildLyricQueries(String(params && params.title || ''), String(params && params.artist || ''));
    const first = q.pairs[0] || { title: String(params && params.title || ''), artist: '' };
    return { title: first.title, artist: first.artist || (q.artists[0] || '') };
  });
  ipcMain.handle('lyrics:search', (_event, params) => searchAllLyrics(
    String(params && params.title || '').trim(),
    String(params && params.artist || '').trim(),
  ));
  // 사용자가 다른 가사를 고름 = 저장된 가사를 덮어쓴다. 이미 들은 소리가 있으면 그것으로 바로 다시 맞춘다
  // (텍스트 가사도 곧바로 정밀 싱크). 사용자가 고른 가사는 소리 판정으로 다른 후보로 바꾸지 않는다.
  ipcMain.handle('lyrics:select', async (_event, candidate) => {
    const resolved = await resolveLyricCandidate(candidate);
    const data = resolved && candidate && candidate.plain ? { ...resolved, plain: true } : resolved;
    if (data) {
      const display = lyricsKey ? activateLyrics(lyricsKey, data, { reset: true, userSelected: true }) : data;
      lyricsData = display;
      if (lyricsKey) lyricsCache.set(lyricsKey, display);
      sendLyricsToWindow();
      if (lyricsKey) augmentForeignLyrics(lyricsKey, display);
    }
    return data;
  });
  // 지금 곡의 가사만 삭제(저장본 포함)
  ipcMain.handle('lyrics:delete', () => deleteCurrentLyrics());
  // 유튜브가 광고 차단을 감지하면(워치페이지의 차단 화면) 이 세션에서는 차단을 통째로 끈다 —
  // 감지를 피해 다니는 대신 차단을 그만두는 쪽이 재생을 되살리는 확실한 길이다.
  ipcMain.on('adblock:disable', () => { adBlockEnabled = false; });
  // 오디오 상태: 렌더러가 볼륨·EQ를 바꿀 때마다 보낸다 → 모든 유튜브 프레임에 즉시 반영
  ipcMain.on('audio:set', (_event, state) => {
    const next = state && typeof state === 'object' ? state : {};
    audioState = {
      ...audioState, // capture(자동 싱크용 소리 받기)는 main이 정한다
      cap: Number.isFinite(Number(next.cap)) ? Math.min(1, Math.max(0, Number(next.cap))) : audioState.cap,
      eq: next.eq ? normalizeEq(next.eq) : audioState.eq,
    };
    pushAudioState();
  });
  // 직접 재생 웹뷰 프리로드가 첫 재생 전에 동기로 받아 간다
  ipcMain.on('audio:state', (event) => { event.returnValue = audioState; });
  // 렌더러가 임베드 재생을 시작하기 전에 가드가 실제로 심겼는지 확인한다 (심긴 프레임이 하나라도 있으면 true)
  ipcMain.handle('audio:guard', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    let ok = false;
    try {
      for (const f of mainWindow.webContents.mainFrame.framesInSubtree) {
        if (isYoutubeFrame(f) && await installAudioGuard(f)) ok = true;
      }
    } catch {}
    return ok;
  });
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
    wc.setBackgroundThrottling(false); // 최소화 중 광고 스킵·종료 감지 인터벌이 늦춰지지 않도록
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

  registerLyricsShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

// 종료 전에 쿠키를 디스크로 강제 플러시 — 크로미움의 지연 저장 때문에 로그인 직후
// 앱을 닫으면 세션 쿠키가 유실돼 다음 실행에서 로그아웃되는 문제 방지
app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('before-quit', () => {
  session.defaultSession.cookies.flushStore().catch(() => {});
  if (lyricsSettingsWriteTimer) writeLyricsSettings();
  if (lyricsBoundsWriteTimer) writeLyricsBounds();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
