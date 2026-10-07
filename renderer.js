let player = null;
let playerReady = false;
let pendingPlay = null; // 플레이어 준비 전에 들어온 재생 요청
let playlists = [];
let activeListId = null;
let activePlaylistName = ''; // 추천 패널 표시용
let editingItem = null; // 사이드바에서 이름/링크 수정 중인 항목
let dragItem = null; // 드래그 중인 사이드바 항목 (재생목록 또는 폴더)

// 자체 대기열: iframe 플레이어의 재생목록은 곡 삭제/순서 제어가 불가능하므로
// cuePlaylist로 곡 ID 목록만 얻어온 뒤, 재생은 곡 단위로 직접 제어한다.
let queue = [];
let queueIndex = -1;
let loadToken = 0;
let titleFetchInFlight = false;
const titleCache = new Map(); // videoId -> {title, author} | null
const durationCache = new Map(); // videoId -> 재생목록에 표시된 길이(초) — 다음 곡 가사 미리 찾기에 쓴다
const fallbackIds = new Set(); // 임베드 차단 → 유튜브 워치페이지 직접 재생으로 전환된 곡
const unplayableIds = new Set(); // 직접 재생조차 불가(삭제/비공개 등) → 즉시 스킵
let watchdogTimer = null;
let stallTimer = null; // 임베드가 버퍼링(state 3)에서 진행 없이 멈춘 경우의 2차 워치독
let fallbackActive = false;
let fallbackVideoId = '';   // 지금 워치페이지로 재생 중인 영상 id
let fallbackSeenId = '';    // 폴링이 이 곡의 워치페이지를 실제로 본 영상 id — 열리기 전 이전 곡 페이지를 '곡이 바뀜'으로 오인하지 않게
let fallbackAdShowing = false; // 마지막 폴링에서 광고가 보이고 있었는가(스킵 버튼 폴링은 그때만 돈다)
// 직접 재생은 계정과 분리된 메모리 전용 게스트 신원으로 한다. 앱 실행마다 새 방문자라 유튜브의 광고 차단 판정이 쌓이지 않고,
// 계정이 이미 표시돼 있어도(서버가 차단 안내문을 미리 넣어 보내는 상태) 영향이 없다. 로그인이 필요한 곡만 계정 세션으로 연다.
const GUEST_PLAYBACK_PARTITION = 'guest-playback'; // 메모리 전용, 계정 쿠키와 분리
let guestIdentity = 0; // 차단 안내가 뜨면 올려 새 파티션(= 새 방문자 신원)으로 바꾼다
const accountFallbackIds = new Set(); // 게스트로는 로그인이 필요하다고 나온 곡(연령 제한 등)
const enforcementRetries = new Map(); // 곡 id → 차단 안내 때문에 다시 연 횟수(곡당 2번까지)
// 광고는 main이 네트워크 단계에서 플레이어 응답의 광고 데이터를 걷어내 없앤다(ad-netprune.js — 페이지 안에는 손대지 않는다).
// 재생 중인 광고를 조작하는 구식 방식은 유튜브에 감지돼 재생 자체가 막히므로 기본값이 꺼짐이다.
let adEvasionEnabled = false; // 워치페이지에서 광고를 조작(무음·배속·점프·스킵 클릭)할지
let adEnforcementSeen = false; // 이 세션에서 광고 차단 감지 화면을 본 적이 있는가
let adCssKey = '';           // 광고 숨김 CSS 키 (감지되면 removeInsertedCSS로 걷어낸다)
let precisePlaybackActive = false; // 소수점 볼륨 선택 후 HTML5 video.volume 정밀 재생 사용
let fallbackPollTimer = null;
let skipPollTimer = null;
let fallbackStall = 0;

const nameInput = document.getElementById('name-input');
const urlInput = document.getElementById('url-input');
const formError = document.getElementById('form-error');
const listEl = document.getElementById('playlist-list');
const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');
const placeholder = document.getElementById('player-placeholder');
let fallbackView = document.getElementById('fallback-view');
const npThumb = document.getElementById('np-thumb');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const npBadge = document.getElementById('np-badge');

let lyricsPublishedState = {
  id: '', title: '', artist: '', status: 'idle', progress: 0, duration: 0, coverUrl: '', volume: 100,
};

let lyricsStateAt = performance.now(); // 마지막 상태 갱신 시각 — 가사 보기 오버레이의 진행 위치 보간용

function publishLyricsState(patch = {}) {
  lyricsPublishedState = { ...lyricsPublishedState, ...patch };
  lyricsStateAt = performance.now();
  try { window.lyrics.update(lyricsPublishedState); } catch {}
}

// 하단 재생 바의 현재 곡 표시. id가 없으면 썸네일 없이 메시지만 보여준다.
function setNowPlaying(id, title, author, badge) {
  if (id) {
    npThumb.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    npThumb.hidden = false;
  } else {
    npThumb.hidden = true;
  }
  npTitle.textContent = title || '';
  npTitle.title = title || '';
  npArtist.textContent = author || '';
  npBadge.hidden = !badge;
  publishLyricsState({
    id: id || '',
    title: title || '',
    artist: author || '',
    altTitle: '',
    altArtist: '',
    status: id ? 'playing' : 'idle',
    progress: 0,
    duration: 0,
    coverUrl: id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '',
  });
}

const TRASH_SVG = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/></svg>';
// WSLg에는 이모지 폰트가 없어 tofu로 보이므로 아이콘은 전부 SVG 사용
const PENCIL_SVG = '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const FOLDER_OPEN_SVG = '<svg viewBox="0 0 24 24"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';
const SHUFFLE_SVG = '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M6 3l14 9-14 9V3z"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const PERSON_SVG = '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const REFRESH_SVG = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>';
const LOGOUT_SVG = '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>';
const LIST_PLUS_SVG = '<svg viewBox="0 0 24 24"><path d="M3 6h13M3 12h13M3 18h7M18 15v6M15 18h6"/></svg>';
const LIST_SVG = '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';

// "https://www.youtube.com/playlist?list=PL..." / "watch?v=...&list=PL..." / raw ID
function extractListId(url) {
  const match = url.match(/[?&]list=([\w-]+)/);
  if (match) return match[1];
  if (/^[\w-]{13,}$/.test(url.trim())) return url.trim();
  return null;
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    // fs=0: 유튜브 자체 전체화면 버튼 제거 — 전체화면 진입은 앱의 몰입 모드로 일원화
    // controls=0: 유튜브 컨트롤 바·상단 제목줄('More videos'·YouTube 로고 포함)을 아예 띄우지 않는다.
    //   앱 전용 재생바로 재생 지점을 옮길 때마다 유튜브 UI가 나타나는 것을 막기 위함이며,
    //   중앙 플레이어는 마우스 상호작용도 차단해 두었으므로 그 컨트롤은 어차피 쓸 수 없다.
    playerVars: { rel: 0, fs: 0, controls: 0, disablekb: 1, iv_load_policy: 3, modestbranding: 1 },
    events: {
      onReady: async () => {
        // 첫 곡을 틀기 전에 임베드 프레임에 오디오 가드(볼륨 상한)가 심겼는지 확인한다 —
        // 가드 없이 재생이 시작되면 유튜브의 저장 볼륨으로 잠깐 소리가 날 수 있다
        try { audioGuardOk = await window.winctl.audioGuard(); } catch { audioGuardOk = false; }
        if (audioGuardOk) precisePlaybackActive = false;
        playerReady = true;
        applyVolume(); // 저장된 마스터 볼륨을 임베드 플레이어에 반영
        if (pendingPlay) {
          const p = pendingPlay;
          pendingPlay = null;
          playPlaylist(p.listId, p.shuffle, p.preset);
        }
        if (pendingQueuePlay) {
          pendingQueuePlay = false;
          playCurrent();
        }
      },
      onStateChange: onPlayerStateChange,
      onError: () => {
        // 임베드 차단 곡: 유튜브 워치페이지 직접 재생으로 전환
        const id = queue[queueIndex];
        if (!id || fallbackActive) return;
        fallbackIds.add(id);
        markFallback(id);
        startFallback(id);
      },
    },
  });
};

// iframe API가 (캐시 리로드 등으로) 콜백 정의보다 먼저 로드를 끝냈으면 콜백이 불리지 않는다 → 직접 호출
if (window.YT && window.YT.Player && !player) window.onYouTubeIframeAPIReady();

// ── 몰입 모드: 앱이 직접 관리하는 전체화면 (창 전체화면 + 사이드바 숨김) ──
// 유튜브 자체(요소) 전체화면은 소유자가 iframe/webview라 임베드↔폴백 전환 때 풀리기 쉽다.
// 그래서 임베드는 fs=0으로 버튼을 없애고 폴백은 CSS로 버튼을 숨겨, 전체화면 진입을
// 컨트롤 바의 앱 자체 버튼(몰입 모드)으로 일원화한다. 그 외 경로(워치페이지 단축키 등)로
// 요소 전체화면이 되더라도 아래 fullscreenchange 훅이 즉시 몰입 모드로 흡수한다.

const fsExitBtn = document.getElementById('fs-exit-btn');

function enterImmersive() {
  closeBrowse(); // 전체화면은 영상을 보려는 것 — 곡 구성 오버레이는 닫고 미니 플레이어도 원래 크기로
  setCenterMin(false);
  document.body.classList.add('immersive');
  window.winctl.setFullScreen(true);
  startCursorWatch();
}

function exitImmersive() {
  document.body.classList.remove('immersive');
  window.winctl.setFullScreen(false);
  stopCursorWatch();
}

function toggleImmersive() {
  if (document.body.classList.contains('immersive')) exitImmersive();
  else enterImmersive();
}

// 전체화면 해제(✕) 버튼은 크롬의 F11 전체화면처럼 **화면 맨 위에 커서를 붙였을 때만** 내려온다.
// 마우스가 iframe/webview 위에 있으면 DOM mousemove가 오지 않으므로, 커서 화면 좌표를 IPC로
// 폴링해서(창 상단 기준 y = pt.y - window.screenY) 위치를 판단한다.
const FS_REVEAL_EDGE = 6; // 이 띠에 커서가 닿으면 내려온다 (화면 맨 위에 붙이는 동작)
const FS_REVEAL_KEEP = 96; // 내려온 뒤에는 여기보다 아래로 내려가야 사라진다 — 버튼까지 갈 여유
let cursorWatchTimer = null;
let fsRevealTimer = null;

function setFsReveal(on) {
  clearTimeout(fsRevealTimer);
  fsExitBtn.classList.toggle('reveal', on);
}

function updateFsReveal(y) {
  if (!document.body.classList.contains('immersive')) return;
  if (y <= FS_REVEAL_EDGE) setFsReveal(true);
  else if (fsExitBtn.classList.contains('reveal') && y > FS_REVEAL_KEEP) setFsReveal(false);
}

let lastWatchedCursor = null;

function startCursorWatch() {
  // 진입 직후엔 잠깐 보여 준다 — 해제 방법을 모른 채 갇히지 않도록 (2.5초 뒤 자동으로 올라감)
  fsExitBtn.classList.add('reveal');
  clearTimeout(fsRevealTimer);
  fsRevealTimer = setTimeout(() => fsExitBtn.classList.remove('reveal'), 2500);
  clearInterval(cursorWatchTimer);
  cursorWatchTimer = setInterval(async () => {
    let pt = null;
    try { pt = await window.winctl.cursor(); } catch {}
    if (pt) {
      updateFsReveal(pt.y - window.screenY);
      if (lastWatchedCursor && (pt.x !== lastWatchedCursor.x || pt.y !== lastWatchedCursor.y)) pokeLyricsKind();
      lastWatchedCursor = pt;
    }
  }, 150);
}

function stopCursorWatch() {
  clearInterval(cursorWatchTimer);
  clearTimeout(fsRevealTimer);
  fsExitBtn.classList.remove('reveal');
}

// 앱 화면(iframe 밖) 위에서는 폴링을 기다리지 않고 즉시 반응한다
document.addEventListener('mousemove', (e) => updateFsReveal(e.clientY));

// 요소 전체화면(iframe/webview 소유)을 해제하고 몰입 모드(창 전체화면)로 흡수한다.
// exitFullscreen 완료 후에 창 전체화면을 걸어야 한다 — 동시에 던지면 해제 완료 시점에
// 창 전체화면까지 되돌아가 간헐적으로 전체화면이 풀린다.
function absorbElementFullscreen() {
  if (!document.fullscreenElement) return;
  const keep = () => {
    if (!document.body.classList.contains('immersive')) enterImmersive();
    else window.winctl.setFullScreen(true); // 이미 몰입 중이면 창 전체화면만 재보장
  };
  document.exitFullscreen().then(keep, keep);
}

// 어떤 경로로든 요소 전체화면이 시작되면 즉시 몰입 모드로 전환
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) absorbElementFullscreen();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lyricsSearchBackdrop.hidden) {
    closeLyricsSearch();
  } else if (e.key === 'Escape' && !soundBackdrop.hidden) {
    closeSoundPanel();
  } else if (e.key === 'Escape' && !settingsBackdrop.hidden) {
    closeSettings();
  } else if (e.key === 'Escape' && !searchPanel.hidden) {
    closeSearchPanel();
  } else if (e.key === 'Escape' && !browsePanel.hidden) {
    closeBrowse();
  } else if (e.key === 'Escape' && document.body.classList.contains('immersive') && !document.fullscreenElement) {
    exitImmersive();
  } else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.altKey && !e.metaKey
    && (e.target.tagName !== 'INPUT' || e.target.type === 'range')) {
    toggleImmersive(); // f: 전체화면 토글 (입력창 타이핑 중에는 무시 — 볼륨 슬라이더 포커스는 예외)
  }
});

fsExitBtn.addEventListener('click', exitImmersive);
// F11(기본 메뉴의 전체화면 토글)처럼 앱 버튼을 거치지 않은 전체화면 변화도 몰입 모드에 반영
window.winctl.onFullScreen((flag) => {
  if (flag === document.body.classList.contains('immersive')) return;
  if (flag) enterImmersive();
  else exitImmersive();
});
document.getElementById('fs-btn').addEventListener('click', toggleImmersive);
// 직접 재생(webview) 화면에서 누른 f — main이 before-input-event로 가로채 전달
window.winctl.onFsKey(() => toggleImmersive());

// ── 폴백 재생: 임베드가 차단된 곡을 앱 내장 브라우저 뷰(유튜브 워치페이지)로 재생 ──

function guestPartition() {
  return guestIdentity ? `${GUEST_PLAYBACK_PARTITION}-${guestIdentity}` : GUEST_PLAYBACK_PARTITION;
}

// partition: '' = 기본(계정) 세션, 그 외 = 게스트 파티션 이름
function selectFallbackSession(partition) {
  if ((fallbackView.getAttribute('partition') || '') === partition) return;
  // Electron의 partition은 첫 탐색 이후 변경할 수 없으므로 웹뷰를 새로 만든다.
  const view = document.createElement('webview');
  view.id = 'fallback-view';
  if (partition) view.setAttribute('partition', partition);
  view.setAttribute('src', 'about:blank');
  view.addEventListener('console-message', onFallbackConsoleMessage);
  view.addEventListener('dom-ready', onFallbackReady);
  clearTimeout(adGateTimer);
  adCssKey = '';
  const previous = fallbackView;
  fallbackView = view;
  previous.replaceWith(view);
}

function startFallback(id) {
  absorbElementFullscreen();
  selectFallbackSession(accountFallbackIds.has(id) ? '' : guestPartition());
  fallbackActive = true;
  fallbackVideoId = id;
  fallbackSeenId = '';
  fallbackAdShowing = false;
  fallbackStall = 0;
  clearTimeout(watchdogTimer);
  clearTimeout(stallTimer);
  try { player.stopVideo(); } catch {}
  placeholder.hidden = true;
  fallbackView.classList.add('active');
  // 광고 소리 차단은 호스트 단에서: 워치페이지가 뜨는 순간부터 웹뷰 오디오를 통째로 막고,
  // 주입 스크립트가 "광고 아님"을 알려올 때만 연다 → 주입 전 프리롤·광고 사이 전환 구간도 새지 않는다
  fallbackAdGate(true);
  loadFallbackPage(fallbackView, id);
  updateQueueHighlight();
  const info = titleCache.get(id);
  setNowPlaying(id, (info && info.title) || id, (info && info.author) || '', true);
  clearInterval(fallbackPollTimer);
  fallbackPollTimer = setInterval(() => pollFallback(id), 1000);
  clearInterval(skipPollTimer);
  skipPollTimer = setInterval(pollSkipClick, 300);
}

// 웹뷰가 붙고 main이 광고 제거(네트워크 단계) 준비와 서비스 워커 정리를 끝낸 뒤에 곡을 연다 — 먼저 열면 첫 응답을 놓치고,
// 서비스 워커가 응답한 탐색은 가로채지 못한다. 기다리는 동안 이전 곡 페이지는 about:blank로 내려 소리가 섞이지 않게 한다.
async function loadFallbackPage(view, id) {
  let wcId = null;
  try {
    wcId = view.getWebContentsId();
    if (view.getURL() !== 'about:blank') view.src = 'about:blank';
  } catch {
    // 막 만든 웹뷰는 붙기 전까지 webContents가 없다
    await new Promise((resolve) => view.addEventListener('did-attach', resolve, { once: true }));
    try { wcId = view.getWebContentsId(); } catch {}
  }
  // 준비가 3초 안에 안 끝나면 그냥 연다 — 곡이 영영 안 열리는 것보다 광고가 남는 편이 낫다(소리는 오디오 게이트가 막는다)
  try { await Promise.race([window.fallbackctl.prepare(wcId), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
  if (view !== fallbackView || !fallbackActive || fallbackVideoId !== id) return; // 그 사이 다른 곡·세션으로 바뀌었다
  view.src = `https://www.youtube.com/watch?v=${id}`;
}

function stopFallback() {
  if (!fallbackActive) return;
  // 웹뷰가 요소 전체화면을 쥔 채 숨겨지면(display:none) 전체화면이 통째로 풀린다
  // → 숨기기 전에 몰입 모드로 전환해 전체화면을 이어간다 (폴백→임베드 전환 시 풀림 방지)
  absorbElementFullscreen();
  fallbackActive = false;
  clearInterval(fallbackPollTimer);
  clearInterval(skipPollTimer);
  fallbackView.classList.remove('active');
  fallbackView.src = 'about:blank';
  fallbackAdGate(false);
}

// ── 오디오 게이트(호스트 단): "실제 음악이 재생 중"일 때만 웹뷰 소리를 연다 ──
// 광고 감지의 찰나 지연을 쫓아 새는 소리를 막는 건 불가능에 가깝다. 대신 웹뷰 오디오를
// setAudioMuted로 기본 차단해 두고, 주입 스크립트가 "광고 아님 + 영상 재생 중"을 알려올 때만 연다.
// 프리롤·광고 묶음 사이·로딩·정지 구간은 전부 '재생 아님'이라 조용하다. 열 때는 250ms 확인 후.
let adGateTimer = null;

function fallbackAdGate(muted) {
  clearTimeout(adGateTimer);
  adGateTimer = null;
  try { fallbackView.setAudioMuted(muted); } catch {}
}

function onFallbackConsoleMessage(e) {
  if (e.currentTarget !== fallbackView) return;
  const msg = String(e.message || '');
  if (msg.startsWith('__ymp_enforced:')) {
    handleAdBlockEnforcement();
    return;
  }
  if (!msg.startsWith('__ymp_playing:')) return;
  const playing = msg.endsWith('1');
  if (!playing) {
    fallbackAdGate(true);
    return;
  }
  clearTimeout(adGateTimer);
  adGateTimer = setTimeout(() => { try { fallbackView.setAudioMuted(false); } catch {} }, 250);
}
fallbackView.addEventListener('console-message', onFallbackConsoleMessage);

// 유튜브가 "서비스 약관을 위반하는 광고 차단 프로그램" 안내(화면을 가리는 팝업·플레이어 안 차단 화면)를 띄웠다
// = 이 재생 신원이 표시됐다. 안내는 CSS로 가려 둔 채 그 신원을 버리고 새 게스트 신원으로 같은 곡을 다시 연다.
// 곡당 2번까지 — 그래도 막히면 큐가 그 곡에서 멈추지 않도록 다음 곡으로 넘긴다.
function handleAdBlockEnforcement() {
  if (!fallbackActive) return;
  const id = fallbackVideoId;
  if (adEvasionEnabled) {
    // 구식 '광고 강제 스킵'을 켜 둔 상태였다면 그것부터 영구히 끈다 — 재생 중인 광고를 조작하는 방식
    // (무음·16배속·끝점프·페이지 안 스킵 클릭)은 플레이어가 직접 감지한다. 사용자 귀는 호스트 오디오 게이트가 막는다.
    adEnforcementSeen = true;
    adEvasionEnabled = false;
    precisePlaybackActive = false; // 정밀 볼륨 때문에 멀쩡한 곡까지 워치페이지로 보내지 않는다
    window.winctl.disableAdBlock();
    paintAdBlockToggle();
    saveSettings(); // 다음 실행부터는 아예 차단하지 않는다
    if (adCssKey) {
      fallbackView.removeInsertedCSS(adCssKey).catch(() => {});
      adCssKey = '';
    }
    fallbackView.executeJavaScript('window.__adEvade = false; 0').catch(() => {});
  }
  // 임베드로 재생할 수 있는 곡이었다면(정밀 볼륨 때문에 워치페이지로 갔던 경우) 임베드로 되돌린다
  if (!fallbackIds.has(id)) {
    precisePlaybackActive = false; // 다시 워치페이지로 보내 같은 안내를 되풀이하지 않게
    showToast('유튜브 광고 차단 안내 — 임베드 재생으로 되돌립니다');
    stopFallback();
    playCurrent();
    return;
  }
  const tries = enforcementRetries.get(id) || 0;
  if (tries < 2) {
    enforcementRetries.set(id, tries + 1);
    if (!accountFallbackIds.has(id)) guestIdentity++; // 계정 세션(로그인이 필요한 곡)은 바꿀 신원이 없다 — 같은 세션으로 한 번 더
    showToast('유튜브 광고 차단 안내 — 새 게스트 신원으로 다시 엽니다');
    startFallback(id);
    return;
  }
  showToast('유튜브가 이 곡의 재생을 막았습니다 — 다음 곡으로 넘어갑니다');
  stopFallback();
  nextTrack();
}

// 광고 스킵 버튼 네이티브 클릭: 네트워크 단계 제거를 빠져나온 광고(서버가 영상 스트림에 끼워 넣는 광고 등)에
// 건너뛰기 버튼이 뜨면, 주입 스크립트가 남긴 버튼 좌표(__skipRect)를 소비해 main이 실제 마우스 입력을 보낸다.
// 사람이 누른 것과 같은 신뢰된 클릭이라 감지되지 않는다(플레이어는 건너뛰기 클릭의 isTrusted를 검사한다 —
// 페이지 안 click()은 그래서 쓰지 않는다). 클릭 직전 elementFromPoint로 그 자리가 여전히 스킵 버튼인지 재검증해
// 좌표가 낡았을 때의 오클릭(영상 일시정지 등)을 방지한다. 광고가 보이는 동안에만 돈다.
async function pollSkipClick() {
  if (!fallbackActive || !fallbackAdShowing) return;
  let rect = null;
  try {
    rect = await fallbackView.executeJavaScript(`(() => {
      const r = window.__skipRect;
      window.__skipRect = null;
      if (!r) return null;
      const el = document.elementFromPoint(r.x, r.y);
      const btn = el && el.closest('button, [role="button"]');
      if (!btn) return null;
      const label = (btn.textContent || '') + (btn.getAttribute('aria-label') || '');
      return (label.includes('건너뛰기') || /skip/i.test(label)) ? r : null;
    })()`);
  } catch {}
  if (rect) window.fallbackctl.click(rect.x, rect.y);
}

// 종료/이탈 감지: 영상이 끝났거나 유튜브 자동재생으로 다른 영상에 넘어가면 다음 곡으로
async function pollFallback(id) {
  if (!fallbackActive || queue[queueIndex] !== id) return;
  const view = fallbackView;
  let st = null;
  try {
    st = await fallbackView.executeJavaScript(
      "(() => { const v = document.querySelector('video'); const m = location.href.match(/[?&]v=([\\w-]{11})/); let ps = null; try { const mp = document.getElementById('movie_player'); const r = mp && mp.getPlayerResponse ? mp.getPlayerResponse() : null; ps = r && r.playabilityStatus ? r.playabilityStatus.status : null; } catch (e) {} return { vid: m ? m[1] : null, ended: v ? v.ended : false, paused: v ? v.paused : true, t: v ? v.currentTime : 0, d: v ? v.duration || 0 : 0, ad: !!document.querySelector('.ad-showing'), ps }; })()"
    );
  } catch {}
  // 세션 교체 전에 시작한 비동기 폴링 결과로 새 웹뷰의 곡을 넘기지 않는다.
  if (view !== fallbackView || !fallbackActive || queue[queueIndex] !== id) return;
  fallbackAdShowing = !!(st && st.ad);
  if (st && st.vid === id) {
    fallbackSeenId = id;
    // 게스트로는 로그인이 필요한 곡(연령 제한 등) → 로그인돼 있으면 계정 세션으로 다시 연다
    if (st.ps === 'LOGIN_REQUIRED' && accountState.loggedIn && !accountFallbackIds.has(id)) {
      accountFallbackIds.add(id);
      startFallback(id);
      return;
    }
  }
  // 이 곡의 페이지가 열리기 전(이전 곡 페이지·about:blank·로딩 중)에 읽은 값은 시작 대기로만 센다 —
  // 곡을 열기 전에 광고 제거 준비를 기다리므로 첫 폴링이 이전 곡 페이지를 읽을 수 있다
  if (!st || fallbackSeenId !== id || (st.t === 0 && !st.d && !st.ad)) {
    // 워치페이지에서도 재생 시작 실패(삭제/비공개 등) → 10초 후 포기하고 스킵
    if (++fallbackStall >= 10) {
      stopFallback();
      unplayableIds.add(id);
      markUnplayable(id);
      nextTrack();
    }
    return;
  }
  const info = titleCache.get(id);
  publishLyricsState({
    id,
    title: (info && info.title) || id,
    artist: (info && info.author) || '',
    status: st.paused ? 'paused' : 'playing',
    progress: Number(st.t) * 1000,
    duration: Number(st.d) * 1000,
    coverUrl: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  });
  fallbackStall = 0;
  // 광고 재생 중에는 종료 판정을 보류 (광고 종료를 곡 종료로 오인 방지)
  if (st.ad) return;
  if (st.ended || (st.vid && st.vid !== id)) {
    stopFallback();
    nextTrack();
  }
}

// 워치페이지의 페이지 요소(헤더/댓글/추천)와 광고 배너를 숨기고, 광고 자동 스킵을 주입
function onFallbackReady(e) {
  if (e.currentTarget !== fallbackView) return;
  fallbackView.insertCSS(`
    #masthead-container, #secondary, #below, ytd-comments, tp-yt-app-drawer { display: none !important; }
    .ytp-fullscreen-button { display: none !important; } /* 전체화면은 앱 버튼(몰입 모드)으로만 */
    /* 플레이어를 웹뷰 뷰포트 전체에 고정 — 페이지 배치 크기 때문에 몰입(전체화면) 시
       화면을 꽉 채우지 못하는 문제 해결. 크기 재계산은 주입 스크립트의 resize 디스패치가 유도 */
    #movie_player { position: fixed !important; top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important; z-index: 999; background: #000 !important; }
    ytd-app { background: #0f0f0f !important; }
    ytd-watch-flexy #columns, ytd-watch-flexy #primary { padding: 0 !important; margin: 0 !important; max-width: 100% !important; }
    ytd-watch-flexy #player { max-height: 100vh; }
    html, body { overflow: hidden !important; }
  `).catch(() => {});
  // 광고 요소(#player-ads·#masthead-ad·ytd-ad-slot-renderer 등)는 **숨기지 않는다** — 유튜브가 같은 이름의 미끼 요소를
  // 만들어 숨겨지는지 검사한다(감지기 e.h_, 예전엔 이 숨김 때문에 매 페이지 걸렸다). 광고는 main이 네트워크 단계에서 걷어낸다.
  // 차단 안내(팝업·플레이어 안 화면)는 가려 둔다 — 감지되면 곧바로 새 신원으로 다시 연다(handleAdBlockEnforcement).
  fallbackView.insertCSS(`
    ytd-enforcement-message-view-model, yt-enforcement-message-view-model,
    tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), tp-yt-paper-dialog:has(yt-enforcement-message-view-model),
    tp-yt-iron-overlay-backdrop, ytd-mealbar-promo-renderer, yt-mealbar-promo-renderer { display: none !important; }
  `).catch(() => {});
  // 아래는 '광고 강제 스킵'(구식 방식)을 켰을 때만 — 재생 중인 광고를 가리고 감지 팝업을 숨긴다.
  // 따로 넣어 두는 이유: 유튜브가 광고 차단을 감지하면 이 스타일만 걷어낸다(removeInsertedCSS).
  if (adEvasionEnabled) {
    fallbackView.insertCSS(`
      tp-yt-paper-dialog:has(ytd-enforcement-message-view-renderer),
      tp-yt-paper-dialog:has([class*="enforcement"]), ytd-popup-container tp-yt-paper-dialog:has(#dismiss-button) { opacity: 0 !important; }
      tp-yt-iron-overlay-backdrop { display: none !important; }
      .ad-showing .html5-main-video { visibility: hidden !important; }
    `).then((key) => { adCssKey = key; }).catch(() => {});
  }
  // 앱 마스터 볼륨을 페이지에 전달 (주입 인터벌이 100ms 주기로 video.volume에 강제한다)
  // __appWantsPlay: 앱이 "지금 재생 중이어야 한다"고 보는 상태 — 주입 인터벌이 이걸 보고 재생을 밀어준다
  fallbackView.executeJavaScript(`window.__appVolume = ${effectiveVolume()}; window.__appWantsPlay = true; window.__adEvade = ${adEvasionEnabled}; 0`).catch(() => {});
  // 영상 광고: 감지 즉시 무음 + 16배속 + 끝으로 점프, 스킵 버튼 자동 클릭,
  // 프리미엄 팝업/일시정지 확인창 자동 처리. 100ms 주기로 돌아 광고 노출 시간을 최소화한다.
  fallbackView.executeJavaScript(`
    // 고정 배치된 플레이어에 맞춰 유튜브가 영상/컨트롤 크기를 다시 계산하도록 유도
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 1500);
    if (!window.__adSkipInstalled) {
      window.__adSkipInstalled = true;
      window.__adActive = false;
      // 광고 시작 순간을 100ms 인터벌이 아니라 클래스 변화로 즉시 잡아 그 자리에서 음소거한다
      // (인터벌만 쓰면 최대 100ms 동안 광고 소리가 새어 나온다). ad-interrupting이 ad-showing보다 먼저 붙는다.
      // "실제 음악이 재생 중"일 때만 소리를 낸다. 광고 중·정지 중·로딩 중은 전부 '재생 아님'으로 보고
      // 호스트가 웹뷰 오디오를 통째로 막는다(console-message로 상태 변화만 알린다). 광고 감지의
      // 찰나 지연을 쫓기보다, 음악이 확실히 나오는 순간에만 여는 쪽이 단순하고 새지 않는다.
      window.__playReported = null;
      // 앱 마스터 볼륨을 video에 즉시 반영한다. 100ms 인터벌에만 맡기면 유튜브가 자기 기억 볼륨(보통 100%)을
      // 재생 시작 직후 복원하는 순간과 겹쳐 최대 100ms 동안 원래 볼륨이 새어 나온다(실측: 폴백 전환 시 큰 소리).
      window.__applyVolume = () => {
        const v = document.querySelector('video');
        if (!v || typeof window.__appVolume !== 'number') return;
        const target = Math.min(1, Math.max(0, window.__appVolume / 100));
        if (Math.abs(v.volume - target) > 0.0005) v.volume = target;
      };
      // 유튜브가 볼륨을 바꾸는 즉시(같은 이벤트 턴에) 되돌린다 — 폴링 간격만큼의 누출을 없앤다
      document.addEventListener('volumechange', window.__applyVolume, true);
      window.__reportPlaying = () => {
        const moviePlayer = document.querySelector('#movie_player');
        const v = document.querySelector('video');
        const ad = !!moviePlayer && (moviePlayer.classList.contains('ad-showing') || moviePlayer.classList.contains('ad-interrupting'));
        // 호스트가 웹뷰 음소거를 푸는 신호이므로, 소리를 열기 전에 볼륨부터 맞춘다
        if (!ad) window.__applyVolume();
        const playing = !!v && !ad && !v.paused && v.readyState >= 2 && v.currentTime > 0.2;
        if (window.__playReported === playing) return;
        window.__playReported = playing;
        console.log('__ymp_playing:' + (playing ? 1 : 0));
      };
      window.__muteIfAd = () => {
        const moviePlayer = document.querySelector('#movie_player');
        const v = document.querySelector('video');
        window.__reportPlaying();
        if (!moviePlayer || !v || window.__adEvade === false) return;
        const ad = moviePlayer.classList.contains('ad-showing') || moviePlayer.classList.contains('ad-interrupting');
        if (ad) {
          window.__adActive = true;
          if (!v.muted) v.muted = true;
        }
      };
      // 재생/정지/소스 교체 이벤트에서도 즉시 보고 (인터벌 100ms 사이의 틈을 줄인다)
      document.addEventListener('play', window.__reportPlaying, true);
      document.addEventListener('pause', window.__reportPlaying, true);
      document.addEventListener('playing', window.__reportPlaying, true);
      document.addEventListener('emptied', window.__reportPlaying, true);
      document.addEventListener('loadstart', window.__reportPlaying, true);
      // #movie_player는 dom-ready 시점에 아직 없을 수 있으므로 인터벌에서 생길 때 한 번 붙인다
      window.__installAdObserver = () => {
        if (window.__adObserver) return;
        const moviePlayer = document.querySelector('#movie_player');
        if (!moviePlayer) return;
        window.__adObserver = new MutationObserver(window.__muteIfAd);
        window.__adObserver.observe(moviePlayer, { attributes: true, attributeFilter: ['class'] });
        window.__muteIfAd();
      };
      window.__installAdObserver();
      setInterval(() => {
        window.__installAdObserver();
        const video = document.querySelector('video');
        const adShowing = !!document.querySelector('.ad-showing, .ad-interrupting');
        window.__reportPlaying();
        // __adEvade가 꺼지면(유튜브가 광고 차단을 감지한 뒤) 광고를 평범하게 재생시킨다 —
        // 무음·배속·점프·스킵 클릭이 남아 있으면 계속 감지돼 재생 자체가 막힌다.
        // 사용자 귀에 들어가는 소리는 호스트 오디오 게이트(setAudioMuted)가 계속 막아 준다.
        if (adShowing && video && window.__adEvade !== false) {
          window.__adActive = true;
          if (!video.muted) video.muted = true;
          // duration을 모르는 광고(스트리밍형)도 배속으로 빨리 소진 — 스킵 카운트다운도 같이 줄어든다
          try { if (video.playbackRate !== 16) video.playbackRate = 16; } catch {}
          if (isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
        } else if (window.__adActive && video) {
          video.muted = false;
          try { video.playbackRate = 1; } catch {}
          window.__adActive = false;
        }
        // 앱 마스터 볼륨 강제: 워치페이지(유튜브) 자체 볼륨 조작을 덮어써 앱 볼륨으로 통일
        if (!adShowing) window.__applyVolume();
        // 창이 최소화되었거나 다른 창에 가려져 있으면 워치페이지가 자동재생을 시작하지 않는다
        // (실측: video.play()는 성공하지만 페이지 스스로는 시작하지 않아 다음 곡에서 재생이 멈춤).
        // 앱이 재생 중이어야 한다고 보는 동안, 아직 시작되지 않은(앞부분에서 멈춘) 영상만 직접 밀어준다
        // — 사용자가 곡 도중에 멈춘 것을 되살리지 않도록 1.5초 미만일 때만 개입한다.
        if (video && window.__appWantsPlay && video.paused && !adShowing && video.currentTime < 1.5) {
          video.play().catch(() => {});
        }
        // 스킵 버튼: 클래스는 자주 바뀌므로 텍스트/aria-label('건너뛰기'/'Skip')로도 찾는다.
        // 좌표를 __skipRect에 남기면 호스트가 네이티브 입력(sendInputEvent)으로 누른다 — 신뢰된 클릭이라 감지되지 않는다.
        // 페이지 안 click()은 구식 강제 스킵(__adEvade)에서만: 플레이어가 isTrusted가 거짓인 건너뛰기 클릭을 감지한다.
        // 전면 스폰서 카드(인터스티셜)는 .ad-showing 없이 뜰 수 있어 구식 모드에서는 늘 찾던 그대로 둔다.
        const findSkip = adShowing || window.__adEvade !== false;
        const cands = new Set(findSkip ? document.querySelectorAll(
          '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, ' +
          '.ytp-ad-skip-button-slot button, .ytp-ad-skip-button-container button'
        ) : []);
        for (const b of (findSkip ? document.querySelectorAll('#movie_player button, #movie_player [role="button"]') : [])) {
          const label = (b.textContent || '') + (b.getAttribute('aria-label') || '');
          if (label.includes('건너뛰기') || /skip ?ads?/i.test(label) || /^\\s*skip\\s*$/i.test(label)) cands.add(b);
        }
        window.__skipRect = null;
        for (const btn of cands) {
          const r = btn.getBoundingClientRect();
          if (!window.__skipRect && r.width > 0 && r.height > 0) {
            window.__skipRect = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          if (window.__adEvade !== false) btn.click();
        }
        // 광고 차단 안내가 떴으면 호스트에 알린다(호스트는 새 게스트 신원으로 다시 연다).
        // 지금의 안내 요소(…-view-model)는 띄울 때만 만들어지고 우리 CSS로 가려져 있으므로 '내용이 있는지'로 본다 —
        // 영상이 뒤에서 계속 재생되는 팝업도 있어(사용자 스크린샷) 재생 여부를 조건으로 두면 놓친다.
        // 옛 요소 이름은 아무 문제가 없어도 숨겨진 채 DOM에 상주하므로(실측: enfInDom=true, enfVisible=false)
        // 예전처럼 화면에 보이고 음악이 재생 중이 아닐 때만 친다. 어느 쪽이든 연속 2회(약 200ms) 유지될 때만 확정한다.
        if (!window.__enforcedReported) {
          const vm = document.querySelector('ytd-enforcement-message-view-model, yt-enforcement-message-view-model');
          const enf = document.querySelector('ytd-enforcement-message-view-renderer, yt-playability-error-supported-renderers');
          const shown = !!(vm && (vm.textContent || '').trim())
            || (!!(enf && enf.getClientRects().length > 0 && enf.offsetParent !== null
              && (enf.textContent || '').match(/광고 차단|ad ?block/i)) && window.__playReported !== true);
          if (shown) {
            window.__enfStreak = (window.__enfStreak || 0) + 1;
            if (window.__enfStreak >= 2) {
              window.__enforcedReported = true;
              console.log('__ymp_enforced:1');
            }
          } else {
            window.__enfStreak = 0;
          }
        }
        const dismiss = document.querySelector('ytd-mealbar-promo-renderer #dismiss-button button, yt-mealbar-promo-renderer #dismiss-button button');
        if (dismiss) dismiss.click();
        const cont = document.querySelector('yt-confirm-dialog-renderer #confirm-button button');
        if (cont) cont.click();
        // 광고 차단 감지 팝업: 재생을 멈추므로 닫기 버튼을 눌러 해제하고, 닫힌 직후 재생 재개
        // 마크업이 자주 바뀌므로 렌더러 이름이 아니라 팝업 텍스트("광고 차단"/"ad blocker")로 찾는다
        let enfDialog = null;
        for (const dlg of (window.__adEvade === false ? [] : document.querySelectorAll('tp-yt-paper-dialog, ytd-popup-container dialog'))) {
          if (dlg.offsetParent === null && dlg.style.display === 'none') continue;
          const text = dlg.textContent || '';
          if (/광고 차단|ad ?block/i.test(text)) { enfDialog = dlg; break; }
        }
        if (enfDialog) {
          const closeBtn = enfDialog.querySelector('#dismiss-button button, #close-button button, [aria-label*="닫기"], [aria-label*="Close"], yt-icon-button#close-button, #dismiss-button');
          if (closeBtn) closeBtn.click();
          window.__enfDismissedAt = Date.now();
        } else if (window.__enfDismissedAt && Date.now() - window.__enfDismissedAt < 5000) {
          if (video && video.paused && !adShowing) video.play();
          if (video && !video.paused) window.__enfDismissedAt = 0;
        }
      }, 100);
    }
    0;
  `).catch(() => {});
}
fallbackView.addEventListener('dom-ready', onFallbackReady);

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED) {
    nextTrack();
    return;
  }
  // 폴백 재생 중에는 iframe의 잔여 상태 변화(stopVideo 등)가 재생 바 표시를 덮어쓰지 않도록
  if (fallbackActive) return;
  const data = player.getVideoData();
  if (data && data.title) {
    // 임베드 플레이어의 getVideoData()는 원어 제목을 준다 — 재생목록 스크랩(hl=ko)의 한국어 현지화 제목이
    // 캐시에 있으면 그쪽을 쓴다. 폴백 전환 후에만 한국어 제목으로 바뀌던(상호작용해야 번역되던) 원인.
    const vid = data.video_id || queue[queueIndex];
    const cached = titleCache.get(vid);
    setNowPlaying(vid, (cached && cached.title) || data.title, (cached && cached.author) || data.author || '');
  }
  const state = event.data === YT.PlayerState.PLAYING ? 'playing'
    : event.data === YT.PlayerState.PAUSED ? 'paused' : lyricsPublishedState.status;
  let progress = 0;
  let duration = 0;
  try {
    progress = player.getCurrentTime() * 1000;
    duration = player.getDuration() * 1000;
  } catch {}
  publishLyricsState({ status: state, progress, duration, altTitle: (data && data.title) || '', altArtist: (data && data.author) || '' });
}

// 임베드 플레이어의 진행 시각을 가사 창으로 보낸다. 가사 창은 이 값을 보간해
// Lyrs처럼 현재 줄을 부드럽게 따라간다.
setInterval(() => {
  if (!playerReady || fallbackActive || !queue[queueIndex]) return;
  let state;
  try { state = player.getPlayerState(); } catch { return; }
  if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.PAUSED) return;
  const data = player.getVideoData();
  let progress = 0;
  let duration = 0;
  try {
    progress = player.getCurrentTime() * 1000;
    duration = player.getDuration() * 1000;
  } catch {}
  // 제목은 곡 시작 때 정한 표시 제목(한국어 현지화 우선)을 유지한다 — 여기서 임베드의 원어 제목으로 덮으면
  // 가사 키가 갈라져 같은 곡을 두 번 찾았다. 원어 제목은 altTitle로 보내 검색어로만 쓴다.
  const vid = (data && data.video_id) || queue[queueIndex];
  // 같은 곡일 때만 이어 쓴다 — 곡이 막 바뀐 순간 새 id에 이전 곡 제목이 붙으면 새 곡을 옛 제목으로 찾는다.
  // 제목 자리에 id가 들어 있던 경우(제목 미수신)도 새로 정한다.
  const sameTrack = lyricsPublishedState.id === vid && lyricsPublishedState.title && lyricsPublishedState.title !== vid;
  const cachedInfo = titleCache.get(vid);
  publishLyricsState({
    id: vid,
    title: sameTrack ? lyricsPublishedState.title : ((cachedInfo && cachedInfo.title) || (data && data.title) || ''),
    artist: sameTrack ? lyricsPublishedState.artist : ((cachedInfo && cachedInfo.author) || (data && data.author) || ''),
    altTitle: (data && data.title) || '',
    altArtist: (data && data.author) || '',
    status: state === YT.PlayerState.PLAYING ? 'playing' : 'paused',
    progress,
    duration,
  });
}, 250);

// preset: 곡 구성 화면에서 넘어온 경우 — items(이미 받아둔 전곡, 있으면 재수집 생략), startId(이 곡부터)
async function playPlaylist(listId, shuffle, preset = {}) {
  if (!playerReady) {
    pendingPlay = { listId, shuffle, preset };
    placeholder.textContent = '플레이어 준비 중… 준비되면 자동으로 재생됩니다';
    return;
  }
  activeListId = listId;
  const ref = allPlaylistRefs().find((p) => p.listId === listId)
    || accountPlaylists.find((p) => p.listId === listId);
  activePlaylistName = (ref && ref.name) || '';
  closeBrowse(); // 재생을 누른 순간 중앙은 곡 구성 대신 영상
  placeholder.hidden = true;
  const token = ++loadToken;
  renderList();
  queueCount.textContent = '불러오는 중…';
  if (!recsPanel.hidden) loadRecs(true); // 추천 패널이 열려 있으면 새 재생목록 기준으로 갱신

  // 첫 페이지(~100곡, 제목/아티스트 포함)만 받는 즉시 재생을 시작하고,
  // 나머지는 continuation을 백그라운드로 따라가며 대기열에 이어 붙인다 (전곡 완료를 기다리지 않음)
  let first = null;
  if (preset.items) {
    first = { items: preset.items, cont: null }; // 곡 구성 화면이 전곡을 이미 받아둔 경우
  } else {
    try {
      first = await window.playlist.fetchFirst(listId);
    } catch {}
  }
  if (token !== loadToken) return;

  if (first && first.items.length > 0) {
    for (const it of first.items) {
      if (it.title) titleCache.set(it.id, { title: it.title, author: it.author || '' });
      if (it.seconds) durationCache.set(it.id, it.seconds);
    }
    const firstVideoId = first.items[0].id;
    queue = first.items.map((it) => it.id);
    if (shuffle) shuffleArray(queue);
    queueIndex = 0;
    if (preset.startId) queueIndex = Math.max(0, queue.indexOf(preset.startId)); // 곡 구성에서 고른 곡부터
    renderQueue();
    playCurrent();

    // 백그라운드 이어받기: 도착하는 대로 추가. 셔플 중이면 아직 안 들은 구간에 무작위 삽입.
    let total = first.items.length;
    let cont = first.cont;
    let guard = 50; // 무한 루프 방지 (최대 ~5000곡)
    while (cont && guard-- > 0) {
      queueCount.textContent = `${total}곡 불러오는 중…`;
      let more = null;
      try {
        more = await window.playlist.fetchMore(cont);
      } catch {}
      if (token !== loadToken) return; // 다른 재생목록이 시작됨 → 이어받기 중단
      if (!more) break;
      for (const it of more.items) {
        if (it.title) titleCache.set(it.id, { title: it.title, author: it.author || '' });
        if (it.seconds) durationCache.set(it.id, it.seconds);
        if (shuffle) {
          const pos = queueIndex + 1 + Math.floor(Math.random() * (queue.length - queueIndex));
          queue.splice(pos, 0, it.id);
        } else {
          queue.push(it.id);
        }
      }
      total += more.items.length;
      renderQueue();
      cont = more.cont;
    }
    if (token !== loadToken) return;

    // 전곡 확보 후 사이드바 썸네일/곡 수 최신화 (계정 재생목록 포함)
    let metaChanged = false;
    for (const p of [...allPlaylistRefs(), ...accountPlaylists]) {
      if (p.listId === listId && (p.thumb !== firstVideoId || p.count !== total)) {
        p.thumb = firstVideoId;
        p.count = total;
        metaChanged = true;
      }
    }
    if (metaChanged) {
      window.store.save(playlists);
      renderList();
    }
  } else {
    // 수집 실패 시 예비 경로: iframe 재생목록에서 ID 수집 (최대 200곡)
    player.cuePlaylist({ list: listId });
    captureQueue(token, shuffle, 20);
  }
}

// cuePlaylist 후 곡 ID 목록이 채워질 때까지 기다렸다가 자체 대기열로 가져온다
function captureQueue(token, shuffle, retries) {
  if (token !== loadToken) return;
  const ids = player.getPlaylist();
  if (!ids || ids.length === 0) {
    if (retries > 0) setTimeout(() => captureQueue(token, shuffle, retries - 1), 400);
    return;
  }
  queue = ids.slice();
  if (shuffle) shuffleArray(queue);
  queueIndex = 0;
  renderQueue();
  fetchMissingTitles();
  playCurrent();
}

let pendingQueuePlay = false; // 플레이어 준비 전에 검색 결과 등에서 들어온 곡 단위 재생 요청

// 다음 곡 가사 미리 찾기: 곡이 시작되고 3초 뒤(지금 곡의 가사 검색과 겹치지 않게) 다음 재생 가능한 곡을 main에 알린다.
// 제목·가수는 setNowPlaying이 쓸 값과 똑같이 넘긴다(캐시의 현지화 제목) — main은 영상 id로 캐시한다.
let lyricsPrefetchTimer = null;

function scheduleLyricsPrefetch() {
  clearTimeout(lyricsPrefetchTimer);
  lyricsPrefetchTimer = setTimeout(() => {
    if (queue.length < 2) return;
    for (let n = 1; n < Math.min(queue.length, 6); n++) {
      const id = queue[(queueIndex + n) % queue.length];
      if (unplayableIds.has(id)) continue;
      const info = titleCache.get(id);
      if (!info || !info.title) return;
      try {
        window.lyrics.prefetch({ id, title: info.title, artist: info.author || '', duration: (durationCache.get(id) || 0) * 1000 });
      } catch {}
      return;
    }
  }, 3000);
}

function playCurrent() {
  // 임베드 프레임에 유튜브 자체 UI 숨김 CSS를 다시 심는다 (프레임이 새로 준비됐을 수 있다)
  try { window.appinfo.refreshEmbedChrome(); } catch {}
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  if (!playerReady) {
    pendingQueuePlay = true;
    return;
  }
  placeholder.hidden = true;
  const id = queue[queueIndex];
  if (unplayableIds.has(id)) {
    nextTrack();
    return;
  }
  scheduleLyricsPrefetch();
  if (fallbackIds.has(id) || precisePlaybackActive) {
    startFallback(id);
    return;
  }
  if (fallbackActive) stopFallback(); // 전체화면 전환은 stopFallback이 처리
  player.loadVideoById(id);
  applyVolume(); // 곡 로드 후에도 앱 마스터 볼륨 유지
  updateQueueHighlight();
  // 워치독: onError조차 오지 않고 시작도 못 하는 곡은 8초 후 폴백으로 전환
  clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    const state = player.getPlayerState();
    if (!fallbackActive && queue[queueIndex] === id && (state === -1 || state === 5)) {
      fallbackIds.add(id);
      markFallback(id);
      startFallback(id);
    }
  }, 8000);
  // 2차 워치독: 버퍼링(state 3)에서 15초째 진행이 전혀 없으면(스트림 차단/오류)
  // 임베드 재생을 포기하고 직접 재생으로 전환 — "아예 재생이 안 되는" 곡 방지
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (fallbackActive || queue[queueIndex] !== id) return;
    let t = 0;
    try { t = player.getCurrentTime(); } catch {}
    if (player.getPlayerState() === 3 && t < 0.5) {
      fallbackIds.add(id);
      markFallback(id);
      startFallback(id);
    }
  }, 15000);
}

function togglePlayback() {
  if (fallbackActive) {
    fallbackView.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      if (!v) return false;
      if (v.paused) { window.__appWantsPlay = true; v.play(); }
      else { window.__appWantsPlay = false; v.pause(); } // 사용자가 멈춘 곡을 주입 인터벌이 되살리지 않도록
      return true;
    })()`).catch(() => {});
    return;
  }
  if (!playerReady) return;
  try {
    if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  } catch {}
}

// 재생 불가로 판명된 곡은 건너뛰고 다음/이전 재생 가능 곡으로 이동
function stepTrack(direction) {
  if (queue.length === 0) return;
  for (let n = 1; n <= queue.length; n++) {
    const i = (queueIndex + direction * n + queue.length * n) % queue.length;
    if (!unplayableIds.has(queue[i])) {
      queueIndex = i;
      playCurrent();
      return;
    }
  }
  setNowPlaying(null, '재생 가능한 곡이 없습니다');
}

function nextTrack() {
  stepTrack(1);
}

function prevTrack() {
  stepTrack(-1);
}

// 셔플 버튼: 현재 곡은 유지한 채 나머지 순서를 섞는다
function reshuffleQueue() {
  if (queue.length === 0) return;
  const current = queue[queueIndex];
  const rest = queue.filter((_, i) => i !== queueIndex);
  shuffleArray(rest);
  queue = [current, ...rest];
  queueIndex = 0;
  renderQueue();
  updateQueueHighlight();
}

function removeFromQueue(i) {
  queue.splice(i, 1);
  if (queue.length === 0) {
    queueIndex = -1;
    renderQueue();
    player.stopVideo();
    return;
  }
  if (i < queueIndex) {
    queueIndex--;
  } else if (i === queueIndex) {
    if (queueIndex >= queue.length) queueIndex = 0;
    renderQueue();
    playCurrent();
    return;
  }
  renderQueue();
  updateQueueHighlight();
}

function renderQueue() {
  queueList.innerHTML = '';
  queueCount.textContent = queue.length ? `${queue.length}곡` : '';
  queue.forEach((id, i) => {
    const li = document.createElement('li');
    li.dataset.videoId = id;

    const num = document.createElement('span');
    num.className = 'q-idx';
    num.textContent = i + 1;

    const thumb = document.createElement('img');
    thumb.className = 'q-thumb';
    thumb.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    thumb.loading = 'lazy';

    const meta = document.createElement('div');
    meta.className = 'q-meta';
    const title = document.createElement('div');
    title.className = 'q-title';
    const author = document.createElement('div');
    author.className = 'q-author';
    const info = titleCache.get(id);
    title.textContent = (info && info.title) || id;
    author.textContent = (info && info.author) || '';
    meta.append(title, author);
    li.title = (info && info.title) || id; // 레일에서는 제목이 안 보인다

    const del = document.createElement('button');
    del.className = 'q-del';
    del.title = '대기열에서 삭제';
    del.innerHTML = TRASH_SVG;
    del.onclick = (e) => {
      e.stopPropagation();
      removeFromQueue(i);
    };

    li.append(num, thumb, meta, del);
    li.onclick = () => {
      closeBrowse();
      queueIndex = i;
      playCurrent();
    };
    if (unplayableIds.has(id)) decorateUnplayable(li);
    else if (fallbackIds.has(id)) decorateFallback(li);
    queueList.appendChild(li);
  });
  updateQueueHighlight();
}

function decorateUnplayable(li) {
  li.classList.add('unplayable');
  li.title = `${li.title ? li.title + ' — ' : ''}재생 불가 (삭제되었거나 비공개인 영상)`;
}

function decorateFallback(li) {
  li.title = `${li.title ? li.title + ' — ' : ''}임베드 차단 곡 — 유튜브 페이지로 직접 재생됩니다`;
  if (!li.querySelector('.q-badge')) {
    const badge = document.createElement('span');
    badge.className = 'q-badge';
    badge.textContent = '직접 재생';
    li.querySelector('.q-author').prepend(badge);
  }
}

function markUnplayable(id) {
  for (const li of queueList.children) {
    if (li.dataset.videoId === id) decorateUnplayable(li);
  }
}

function markFallback(id) {
  for (const li of queueList.children) {
    if (li.dataset.videoId === id) decorateFallback(li);
  }
}

function updateQueueHighlight() {
  Array.from(queueList.children).forEach((li, i) => li.classList.toggle('current', i === queueIndex));
  const current = queueList.children[queueIndex];
  if (current) current.scrollIntoView({ block: 'nearest' });
}

function updateQueueTitles() {
  for (const li of queueList.children) {
    const info = titleCache.get(li.dataset.videoId);
    if (info) {
      li.querySelector('.q-title').textContent = info.title;
      li.querySelector('.q-author').textContent = info.author || '';
    }
  }
}

async function fetchMissingTitles() {
  if (titleFetchInFlight) return;
  titleFetchInFlight = true;
  try {
    while (true) {
      const missing = queue.filter((id) => !titleCache.has(id)).slice(0, 20);
      if (missing.length === 0) break;
      const map = await window.titles.fetch(missing);
      for (const [id, info] of Object.entries(map)) titleCache.set(id, info || null);
      updateQueueTitles();
    }
  } finally {
    titleFetchInFlight = false;
  }
}

// ── 사이드바: 폴더 관리 (Windows 탐색기 스타일 드래그 앤 드롭) ──
// playlists 항목: {type:'playlist', name, url, listId} 또는 {type:'folder', name, open, items:[...]}
// 폴더 안에 폴더를 넣을 수 있다(중첩 깊이 제한 없음). 구버전 데이터({name,url,listId})는
// 로드 시 type을 붙여 마이그레이션.

function normalizeItems(raw) {
  return (raw || []).map((it) => {
    if (it.type === 'folder') return { ...it, items: normalizeItems(it.items) };
    return it.type ? it : { type: 'playlist', ...it };
  });
}

function findLocation(item, arr = playlists, folder = null) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === item) return { arr, index: i, folder };
    if (arr[i].type === 'folder') {
      const loc = findLocation(item, arr[i].items, arr[i]);
      if (loc) return loc;
    }
  }
  return null;
}

function removeItem(item) {
  const loc = findLocation(item);
  if (loc) loc.arr.splice(loc.index, 1);
}

async function persistAndRender() {
  await window.store.save(playlists);
  renderList();
}

function allPlaylistRefs(arr = playlists) {
  const refs = [];
  for (const item of arr) {
    if (item.type === 'folder') refs.push(...allPlaylistRefs(item.items));
    else refs.push(item);
  }
  return refs;
}

// 사이드바 썸네일/곡 수: 첫 곡 ID(thumb)와 총 곡 수(count)를 playlists.json에 캐시.
// 없는 항목만 백그라운드로 한 번 수집하고, 재생 시 전곡 수집 결과로 최신화된다.
let metaFetchInFlight = false;

async function fetchMissingMeta() {
  if (metaFetchInFlight) return;
  metaFetchInFlight = true;
  try {
    const missing = allPlaylistRefs().filter((p) => !p.thumb);
    if (missing.length === 0) return;
    let changed = false;
    await Promise.all(missing.map(async (p) => {
      try {
        const meta = await window.playlist.meta(p.listId);
        if (meta && meta.firstVideoId) {
          p.thumb = meta.firstVideoId;
          if (meta.count != null) p.count = meta.count;
          changed = true;
        }
      } catch {}
    }));
    if (changed) {
      await window.store.save(playlists);
      renderList();
    }
  } finally {
    metaFetchInFlight = false;
  }
}

// folder 안(자손 포함)에 item이 들어 있는지 — 폴더를 자기 자신의 하위로 넣는 순환 방지용
function folderContains(folder, item) {
  for (const it of folder.items) {
    if (it === item) return true;
    if (it.type === 'folder' && folderContains(it, item)) return true;
  }
  return false;
}

// 드롭 존 규칙: 행의 위/아래 가장자리(25%)에 걸치면 단순 위치 이동(before/after),
// 행 가운데(50%)에 완전히 겹치면 병합 — 폴더면 그 안으로, 재생목록이면 새 폴더로 묶기.
function canMergeInto(source, target) {
  if (!source || source === target) return false;
  if (source.type === 'folder' && folderContains(source, target)) return false; // 자기 하위로 이동 불가
  if (target.type === 'folder') return true; // 재생목록 추가 또는 폴더 중첩
  return source.type !== 'folder'; // 폴더를 재생목록 위에 겹치는 것은 불가
}

function canReorderAround(source, target) {
  if (!source || source === target) return false;
  return !(source.type === 'folder' && folderContains(source, target)); // 자기 하위 옆으로는 불가
}

function dropZoneFor(e, li, target) {
  const merge = canMergeInto(dragItem, target);
  const reorder = canReorderAround(dragItem, target);
  if (!merge && !reorder) return null;
  const rect = li.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;
  if (!reorder) return 'into';
  if (!merge) return ratio < 0.5 ? 'before' : 'after';
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'into';
}

function performDrop(source, target, zone) {
  if (!source) return;
  if (target === null) {
    // 목록 빈 공간 → 루트(폴더 밖) 맨 아래로 이동
    removeItem(source);
    playlists.push(source);
    persistAndRender();
    return;
  }
  if (zone === 'before' || zone === 'after') {
    if (!canReorderAround(source, target)) return;
    removeItem(source);
    const loc = findLocation(target); // source 제거 후 다시 찾아야 같은 배열에서도 인덱스가 맞는다
    loc.arr.splice(loc.index + (zone === 'after' ? 1 : 0), 0, source);
  } else if (zone === 'into' && canMergeInto(source, target)) {
    removeItem(source);
    if (target.type === 'folder') {
      target.items.push(source); // 재생목록 추가 또는 폴더 중첩(폴더 안 폴더)
      target.open = true;
    } else {
      // 재생목록 위에 완전히 겹침 → 그 자리에 새 폴더로 묶고 바로 이름 입력
      const loc = findLocation(target);
      const folder = { type: 'folder', name: '새 폴더', open: true, items: [target, source] };
      loc.arr.splice(loc.index, 1, folder);
      editingItem = folder;
    }
  } else {
    return;
  }
  persistAndRender();
}

function makeDraggable(li, item) {
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    dragItem = item;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.name);
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    dragItem = null;
    li.classList.remove('dragging');
    listEl.classList.remove('drag-over-root');
  });
}

// intoOnly: 빈 폴더 힌트 행처럼 "안으로 넣기"만 의미 있는 대상 (가장자리 존 없음)
function makeDropTarget(li, target, intoOnly) {
  let zone = null;
  const mark = (z) => {
    li.classList.toggle('drag-over', z === 'into');
    li.classList.toggle('drag-over-before', z === 'before');
    li.classList.toggle('drag-over-after', z === 'after');
  };
  li.addEventListener('dragover', (e) => {
    zone = intoOnly ? (canMergeInto(dragItem, target) ? 'into' : null) : dropZoneFor(e, li, target);
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    mark(zone);
  });
  li.addEventListener('dragleave', () => mark(null));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    mark(null);
    performDrop(dragItem, target, zone);
  });
}

// 목록의 빈 공간에 놓으면 루트(폴더 밖) 맨 아래로 이동
listEl.addEventListener('dragover', (e) => {
  if (e.target !== listEl || !dragItem) return;
  e.preventDefault();
  listEl.classList.add('drag-over-root');
});
listEl.addEventListener('dragleave', (e) => {
  if (e.target === listEl) listEl.classList.remove('drag-over-root');
});
listEl.addEventListener('drop', (e) => {
  if (e.target !== listEl || !dragItem) return;
  e.preventDefault();
  listEl.classList.remove('drag-over-root');
  performDrop(dragItem, null);
});

// ── 우클릭 컨텍스트 메뉴: 행 위치를 기준으로 동작해 원하는 위치에 새 폴더를 만들 수 있다 ──

const ctxMenu = document.getElementById('ctx-menu');

function closeCtxMenu() {
  ctxMenu.hidden = true;
}

function openCtxMenu(x, y, entries) {
  ctxMenu.innerHTML = '';
  for (const entry of entries) {
    if (entry === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.innerHTML = entry.svg;
    const label = document.createElement('span');
    label.textContent = entry.label;
    btn.appendChild(label);
    btn.onclick = () => {
      closeCtxMenu();
      entry.action();
    };
    ctxMenu.appendChild(btn);
  }
  // 화면 밖으로 나가지 않도록 일단 그린 뒤 크기를 재서 배치
  ctxMenu.style.left = '-9999px';
  ctxMenu.style.top = '0px';
  ctxMenu.hidden = false;
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

document.addEventListener('click', closeCtxMenu);
window.addEventListener('blur', closeCtxMenu);
document.addEventListener('contextmenu', closeCtxMenu); // 행 핸들러는 stopPropagation으로 자신을 제외

// 새 폴더를 arr의 index 자리(생략 시 맨 뒤)에 만들고 바로 이름 입력으로 들어간다
function createFolder(arr, index) {
  const folder = { type: 'folder', name: '새 폴더', open: true, items: [] };
  arr.splice(index == null ? arr.length : index, 0, folder);
  editingItem = folder;
  persistAndRender();
}

// 목록 빈 공간 우클릭 → 최상위에 새 폴더
listEl.addEventListener('contextmenu', (e) => {
  if (e.target !== listEl) return;
  e.preventDefault();
  e.stopPropagation();
  openCtxMenu(e.clientX, e.clientY, [
    { svg: PLUS_SVG, label: '새 폴더', action: () => createFolder(playlists) },
  ]);
});

// ── 디자인 설정: 테마 프리셋 + 색상 사용자 지정 (Slack의 테마 설정 참고) ──
// 기본 3색(포인트/배경/패널)만 저장하고, 나머지 표면 색(hover·active·input·tile)은
// styles.css의 color-mix가 패널 색에서 파생한다. 저장은 settings.json (localStorage는
// 서버 포트가 매번 바뀌어 오리진이 달라지므로 유지되지 않는다).

const THEME_PRESETS = [
  { name: '미드나이트', accent: '#ff5252', base: '#000000', panel: '#121212' },
  { name: '그린', accent: '#1db954', base: '#000000', panel: '#121212' },
  { name: '오션', accent: '#4da3ff', base: '#020c14', panel: '#0e1a24' },
  { name: '바이올렛', accent: '#b18cff', base: '#0a0512', panel: '#180f26' },
  { name: '로즈', accent: '#ff6b9d', base: '#12040a', panel: '#1f0d16' },
  { name: '앰버', accent: '#ffb02e', base: '#0c0800', panel: '#1a1408' },
];
const DEFAULT_THEME = THEME_PRESETS[0];
let theme = { ...DEFAULT_THEME };

const settingsBackdrop = document.getElementById('settings-backdrop');
const colorInputs = {
  accent: document.getElementById('color-accent'),
  base: document.getElementById('color-base'),
  panel: document.getElementById('color-panel'),
};

// 포인트 색 위에 올라가는 글자색: 상대 명도가 낮으면(어두운 포인트 색) 흰색, 아니면 검정
function accentTextColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum < 0.2 ? '#fff' : '#000';
}

function applyTheme(t) {
  theme = { accent: t.accent, base: t.base, panel: t.panel };
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.accent);
  root.setProperty('--on-accent', accentTextColor(theme.accent));
  root.setProperty('--bg-base', theme.base);
  root.setProperty('--panel', theme.panel);
  syncSettingsUI();
  try { window.lyrics.setTheme(theme); } catch {} // 가사 창·설정 팝업도 같은 색을 쓴다
}

// 가사 보기(영상 위 가사)의 글꼴·크기 — settings.json의 lyricsView에 저장
const LYRIC_FONT_STACKS = {
  default: '"Pretendard", "Segoe UI", sans-serif',
  'noto-sans': '"Noto Sans KR", "Pretendard", sans-serif',
  'noto-serif': '"Noto Serif KR", "Batang", serif',
  'nanum-myeongjo': '"Nanum Myeongjo", "Batang", serif',
  'gowun-batang': '"Gowun Batang", "Batang", serif',
  'gowun-dodum': '"Gowun Dodum", "Pretendard", sans-serif',
  'ibm-plex': '"IBM Plex Sans KR", "Segoe UI", sans-serif',
};
const DEFAULT_LYRICS_VIEW = { scale: 100 };
let lyricsView = { ...DEFAULT_LYRICS_VIEW };
const lvScale = document.getElementById('lv-scale');

function applyLyricsView(next) {
  lyricsView = { scale: Math.max(60, Math.min(180, Number(next && next.scale) || 100)) };
  document.documentElement.style.setProperty('--lv-scale', String(lyricsView.scale / 100));
  lvScale.value = lyricsView.scale;
  document.getElementById('lv-scale-value').textContent = `${lyricsView.scale}%`;
}

// 글꼴은 플로팅 가사 창 설정(fontFamily) 하나를 가사 보기에도 같이 쓴다
function applyLyricsFont(fontFamily) {
  document.documentElement.style.setProperty('--lv-font', LYRIC_FONT_STACKS[fontFamily] || LYRIC_FONT_STACKS.default);
}

lvScale.addEventListener('input', () => applyLyricsView({ ...lyricsView, scale: Number(lvScale.value) }));
lvScale.addEventListener('change', saveSettings);

// settings.json은 테마 3색 + 마스터 볼륨 + 패널 레이아웃 + 가사 보기 글꼴/크기를 한 객체로 저장한다
function saveSettings() {
  window.uiSettings.save({ ...theme, volume: masterVolume, layout, lyricsView, adEnforcedV2: adEnforcementSeen, eq: eqState });
}

function syncSettingsUI() {
  for (const [key, input] of Object.entries(colorInputs)) input.value = theme[key];
  for (const btn of document.querySelectorAll('.theme-preset')) {
    const p = THEME_PRESETS[btn.dataset.index];
    btn.classList.toggle('selected', p.accent === theme.accent && p.base === theme.base && p.panel === theme.panel);
  }
}

// 프리셋 스와치 렌더링 (배경 위 패널 + 포인트 색 미리보기)
for (const [i, p] of THEME_PRESETS.entries()) {
  const btn = document.createElement('button');
  btn.className = 'theme-preset';
  btn.dataset.index = i;
  const preview = document.createElement('span');
  preview.className = 'preset-preview';
  preview.style.background = p.base;
  const panelChip = document.createElement('span');
  panelChip.className = 'pv-panel';
  panelChip.style.background = p.panel;
  const accentBar = document.createElement('span');
  accentBar.className = 'pv-accent';
  accentBar.style.background = p.accent;
  preview.append(panelChip, accentBar);
  const name = document.createElement('span');
  name.textContent = p.name;
  btn.append(preview, name);
  btn.onclick = () => {
    applyTheme(p);
    saveSettings();
  };
  document.getElementById('theme-presets').appendChild(btn);
}

for (const [key, input] of Object.entries(colorInputs)) {
  input.addEventListener('input', () => applyTheme({ ...theme, [key]: input.value })); // 실시간 미리보기
  input.addEventListener('change', saveSettings); // 색 선택을 마쳤을 때만 저장
}

function openSettings() {
  syncSettingsUI();
  settingsBackdrop.hidden = false;
}

function closeSettings() {
  settingsBackdrop.hidden = true;
}

window.appinfo.version().then((v) => {
  document.getElementById('app-version').textContent = `버전 ${v}`; // 어떤 빌드가 실행 중인지 확인용
}).catch(() => {});

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-reset').addEventListener('click', () => {
  applyTheme(DEFAULT_THEME);
  saveSettings();
});
settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === settingsBackdrop) closeSettings();
});

// ── 플로팅 가사 창 설정: 디자인 설정 패널을 아래로 스크롤하면 나오는 섹션 ──
// 값은 main이 lyrics-settings.json에 저장하고 플로팅 창에 즉시 반영한다.
let lyricsSettings = {};
const lsNumberInputs = {
  width: document.getElementById('ls-width'),
  height: document.getElementById('ls-height'),
};
const lsRangeInputs = {
  width: document.getElementById('ls-width-slider'),
  height: document.getElementById('ls-height-slider'),
  backgroundOpacity: document.getElementById('ls-opacity'),
  uiOpacity: document.getElementById('ls-ui-opacity'),
  fontSize: document.getElementById('ls-font-size'),
};
const lsSelects = {
  coverMode: document.getElementById('ls-cover-mode'),
  videoFit: document.getElementById('ls-video-fit'),
  fontFamily: document.getElementById('ls-font-family'),
  foreignMode: document.getElementById('ls-foreign-mode'),
};
const lsToggleInputs = {
  showProgressBar: document.getElementById('ls-progress'),
  showPlaybackControls: document.getElementById('ls-playback'),
  showPreviousButton: document.getElementById('ls-previous'),
  showPauseButton: document.getElementById('ls-pause'),
  showNextButton: document.getElementById('ls-next'),
  showVolumeButton: document.getElementById('ls-volume'),
  showLyrics: document.getElementById('ls-lyrics'),
  showTrackInfo: document.getElementById('ls-track-info'),
  alwaysOnTop: document.getElementById('ls-topmost'),
  clickThrough: document.getElementById('ls-lock'),
  autoSync: document.getElementById('ls-autosync'),
  asrGpu: document.getElementById('ls-asrgpu'),
};

function paintLyricsSettings(next) {
  lyricsSettings = { ...lyricsSettings, ...(next || {}) };
  applyLyricsFont(lyricsSettings.fontFamily);
  for (const [key, input] of Object.entries(lsNumberInputs)) input.value = lyricsSettings[key] ?? '';
  for (const [key, input] of Object.entries(lsRangeInputs)) input.value = lyricsSettings[key] ?? 0;
  document.getElementById('ls-opacity-value').textContent = `${lyricsSettings.backgroundOpacity ?? ''}%`;
  document.getElementById('ls-ui-opacity-value').textContent = `${lyricsSettings.uiOpacity ?? ''}%`;
  document.getElementById('ls-font-size-value').textContent = `${lyricsSettings.fontSize ?? ''}px`;
  for (const [key, sel] of Object.entries(lsSelects)) if (lyricsSettings[key]) sel.value = lyricsSettings[key];
  for (const [key, input] of Object.entries(lsToggleInputs)) input.checked = !!lyricsSettings[key];
}

function saveLyricsSettings(patch) {
  paintLyricsSettings(patch);
  window.lyricsOverlay.saveSettings(lyricsSettings).then(paintLyricsSettings).catch(() => {});
}

for (const [key, input] of Object.entries(lsNumberInputs)) {
  input.addEventListener('change', () => {
    const value = Number(input.value);
    if (Number.isFinite(value)) saveLyricsSettings({ [key]: value });
    else paintLyricsSettings();
  });
}
for (const [key, input] of Object.entries(lsRangeInputs)) {
  input.addEventListener('input', () => saveLyricsSettings({ [key]: Number(input.value) }));
}
for (const [key, input] of Object.entries(lsToggleInputs)) {
  input.addEventListener('change', () => saveLyricsSettings({ [key]: input.checked }));
}
for (const [key, sel] of Object.entries(lsSelects)) {
  sel.addEventListener('change', () => saveLyricsSettings({ [key]: sel.value }));
}
document.getElementById('lyrics-settings-reset').addEventListener('click', () => {
  window.lyricsOverlay.resetSettings().then(paintLyricsSettings).catch(() => {});
});
window.lyricsOverlay.onSettings(paintLyricsSettings);
window.lyricsOverlay.getSettings().then(paintLyricsSettings).catch(() => {});
// 플로팅 창의 톱니 버튼 → 디자인 설정을 열고 가사 창 섹션까지 스크롤
// 전역 단축키 등록 결과를 설정 패널에 그대로 보여준다 (다른 프로그램이 선점하면 등록에 실패한다)
window.lyricsOverlay.shortcuts().then((list) => {
  const el = document.getElementById('ls-shortcuts');
  if (!el || !Array.isArray(list) || list.length === 0) return;
  el.replaceChildren();
  el.append('단축키 — ');
  list.forEach((s, i) => {
    const key = document.createElement('b');
    key.textContent = s.accelerator;
    el.append(i ? ', ' : '', key, ` ${s.label}`);
    if (!s.ok) {
      const warn = document.createElement('span');
      warn.className = 'ls-shortcut-fail';
      warn.textContent = ' (등록 실패 — 다른 프로그램이 사용 중)';
      el.append(warn);
    }
  });
  el.append('. 게임이나 작업 중인 프로그램에서 창이 전환되지 않고 가사 창만 바뀝니다.');
}).catch(() => {});
window.lyrics.onOpenSettings(() => {
  openSettings();
  const panel = document.getElementById('settings-panel');
  requestAnimationFrame(() => panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' }));
});

// ── 사운드 세팅: 앱 마스터 볼륨 (일반 재생·직접 재생 공통) ──
// 유튜브 볼륨은 임베드/워치페이지가 따로 기억해 모드 전환 때마다 따로 논다. 그래서 앱이
// 볼륨의 단일 기준이 된다 — 임베드는 IFrame API setVolume, 직접 재생은 주입 인터벌이
// video.volume을 100ms 주기로 강제(__appVolume). 값은 settings.json의 volume에 저장.

let masterVolume = 100; // 0.00 ~ 100.00 (소숫점 둘째자리)

const soundBackdrop = document.getElementById('sound-backdrop');
const volSlider = document.getElementById('vol-slider');
const soundVolSlider = document.getElementById('sound-vol-slider');
const soundVolInput = document.getElementById('sound-vol-input');
const soundVolReadout = document.getElementById('sound-vol-readout');
const soundFill = document.getElementById('sound-fill');

function clampVolume(v) {
  const n = Number(v);
  if (!isFinite(n)) return masterVolume;
  return Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
}

function paintVolumeUI() {
  publishLyricsState({ volume: masterVolume }); // 플로팅 창 볼륨 슬라이더 동기화
  const v = masterVolume;
  for (const el of [volSlider, soundVolSlider]) {
    el.value = v;
    // 채워진 구간을 포인트 색으로 — range 트랙을 요소 배경 그라디언트로 그린다
    el.style.background = `linear-gradient(to right, var(--accent) ${v}%, var(--panel-active) ${v}%)`;
  }
  volSlider.title = `마스터 볼륨 ${v.toFixed(2)}`;
  soundVolReadout.textContent = v.toFixed(2);
  if (document.activeElement !== soundVolInput) soundVolInput.value = v.toFixed(2);
  soundFill.style.width = v + '%';
}

// 체감 볼륨 커브: 슬라이더 값(0~100)을 dB 선형(로그) 커브로 출력 진폭에 매핑한다 — 1은 충분히 작고
// 100은 충분히 크게, 전 구간이 40dB에 고르게 퍼진다. 제곱 커브는 저볼륨이 0으로 반올림돼 1~7이
// 통째로 무음이 되는 데드존을 만들었다(실측 신고). 이 커브는 1부터 바로 들린다(출력 ≥1).
// UI·저장값은 그대로 선형 0~100.
function effectiveVolume() {
  if (masterVolume <= 0) return 0;
  return 100 * Math.pow(10, (masterVolume - 100) / 50);
}

// 오디오 가드(audio-guard.js)에 현재 볼륨 상한·EQ를 보낸다 — main이 모든 유튜브 프레임에 즉시 뿌린다.
// 가드는 유튜브가 영상 요소에 쓰는 볼륨을 쓰는 순간 이 상한으로 잘라 내므로, 곡 전환 때 유튜브가
// 자기 저장 볼륨(보통 100%)을 복원해도 소리가 새지 않는다.
let audioGuardOk = false; // 임베드 프레임에 가드가 심긴 것을 확인했는가 (player onReady에서 확인)

function pushAudio() {
  try { window.winctl.setAudio({ cap: effectiveVolume() / 100, eq: { enabled: eqState.enabled, gains: eqState.gains } }); } catch {}
}

function applyVolume() {
  const out = effectiveVolume();
  pushAudio(); // 먼저 상한부터 — 볼륨을 내릴 때 유튜브에 전달되기 전에 이미 잘려 있게
  if (playerReady) {
    try {
      // 가드가 있으면 유튜브에는 올림값을 주고 가드가 정확한 상한(소수점까지)으로 자른다.
      // 가드가 없으면 예전처럼 반올림값 — 이때 올림을 쓰면 저볼륨에서 최대 2배가 될 수 있다.
      player.setVolume(audioGuardOk ? Math.min(100, Math.ceil(out)) : out);
      // 임베드 플레이어는 볼륨 0에서 unMute()하면 최소 볼륨 5로 되살린다(실측) — 무음은 0에서만.
      if (out < 0.5 && !(audioGuardOk && out > 0)) player.mute();
      else player.unMute();
    } catch {}
  }
  if (fallbackActive) {
    fallbackView.executeJavaScript(`window.__appVolume = ${effectiveVolume()}; 0`).catch(() => {});
  }
}

// Alt+` 음소거 토글: 0으로 내리기 전 볼륨을 기억했다가 복원한다 (0에서 켜면 직전 볼륨, 없으면 50)
let preMuteVolume = 0;

function toggleMute() {
  if (masterVolume > 0) {
    preMuteVolume = masterVolume;
    setMasterVolume(0, true);
  } else {
    setMasterVolume(preMuteVolume > 0 ? preMuteVolume : 50, true);
  }
}

function setMasterVolume(v, save) {
  masterVolume = clampVolume(v);
  // IFrame API는 정수 볼륨만 지원하므로, 소수점 값을 선택하면 현재 곡부터
  // HTML5 video.volume을 직접 제어하는 워치페이지 경로로 전환한다.
  if (!Number.isInteger(masterVolume) && !adEnforcementSeen && !audioGuardOk) precisePlaybackActive = true;
  paintVolumeUI();
  if (precisePlaybackActive && !fallbackActive && queueIndex >= 0 && queue[queueIndex]) {
    startFallback(queue[queueIndex]);
  } else {
    applyVolume();
  }
  if (save) saveSettings();
}

for (const el of [volSlider, soundVolSlider]) {
  el.addEventListener('input', () => setMasterVolume(el.value, false)); // 드래그 중 실시간 반영
  el.addEventListener('change', () => setMasterVolume(el.value, true)); // 조작을 마쳤을 때 저장
}

// 소숫점 둘째자리까지 실수 직접 입력 (Enter 또는 포커스 아웃 시 적용)
soundVolInput.addEventListener('change', () => {
  setMasterVolume(soundVolInput.value, true);
  soundVolInput.value = masterVolume.toFixed(2);
});

function openSoundPanel() {
  paintVolumeUI();
  paintEq();
  soundBackdrop.hidden = false;
}

// ── 이퀄라이저: 6밴드(60/150/400/1k/2.4k/15kHz, ±12dB). 실제 처리는 audio-guard.js가 유튜브 프레임 안에서 한다 ──
const EQ_PRESETS = [
  { id: 'flat', name: '평탄', gains: [0, 0, 0, 0, 0, 0] },
  { id: 'bass-boost', name: '베이스 부스트', gains: [6, 4, 0, 0, 0, 0] },
  { id: 'bass-cut', name: '베이스 감소', gains: [-6, -4, 0, 0, 0, 0] },
  { id: 'treble-boost', name: '고음 부스트', gains: [0, 0, 0, 2, 4, 6] },
  { id: 'treble-cut', name: '고음 감소', gains: [0, 0, 0, -2, -4, -6] },
  { id: 'vocal', name: '보컬 강조', gains: [-2, -1, 2, 4, 3, 0] },
  { id: 'electronic', name: '일렉트로닉', gains: [4, 2, -2, 1.5, 0.5, 4] },
  { id: 'hiphop', name: '힙합', gains: [5, 4, 0, -1, 1, 3] },
  { id: 'rock', name: '록', gains: [4, 2, -1, 1, 3, 4] },
  { id: 'pop', name: '팝', gains: [-1, 1, 3, 3, 1, -1] },
  { id: 'jazz', name: '재즈', gains: [3, 2, 0, 1, 2, 3] },
  { id: 'classical', name: '클래식', gains: [4, 3, -1, 0, 2, 4] },
  { id: 'acoustic', name: '어쿠스틱', gains: [3, 2, 1, 2, 2, 2] },
];
let eqState = { enabled: false, preset: 'flat', gains: [0, 0, 0, 0, 0, 0] };

function loadEqState(saved) {
  const gains = Array.from({ length: 6 }, (_, i) => {
    const g = Number(Array.isArray(saved.gains) ? saved.gains[i] : 0);
    return Number.isFinite(g) ? Math.max(-12, Math.min(12, g)) : 0;
  });
  eqState = { enabled: !!saved.enabled, preset: String(saved.preset || 'custom'), gains };
}

const eqEnabled = document.getElementById('eq-enabled');
const eqPreset = document.getElementById('eq-preset');
const eqBody = document.getElementById('eq-body');
const eqGrid = document.getElementById('eq-grid');
const eqArea = document.getElementById('eq-area');
const eqLine = document.getElementById('eq-line');
const eqPoints = document.getElementById('eq-points');
const eqSvg = document.getElementById('eq-graph');
// 그래프 좌표 (viewBox 560×210): 왼쪽은 ±12dB 눈금 자리
const EQ_G = { left: 56, right: 544, top: 14, bottom: 196 };
const eqX = (i) => EQ_G.left + (i + 0.5) * ((EQ_G.right - EQ_G.left) / 6);
const eqY = (g) => (EQ_G.top + EQ_G.bottom) / 2 - (g / 12) * ((EQ_G.bottom - EQ_G.top) / 2);

for (const p of [...EQ_PRESETS, { id: 'custom', name: '사용자 지정' }]) {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.name;
  eqPreset.append(opt);
}

(function drawEqGrid() {
  const ns = 'http://www.w3.org/2000/svg';
  const line = (x1, y1, x2, y2) => {
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    eqGrid.append(l);
  };
  for (let i = 0; i < 6; i++) line(eqX(i), EQ_G.top, eqX(i), EQ_G.bottom);
  line(EQ_G.left, eqY(0), EQ_G.right, eqY(0));
  for (const [label, g] of [['+12dB', 12], ['-12dB', -12]]) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', 0);
    t.setAttribute('y', eqY(g) + 4);
    t.textContent = label;
    eqGrid.append(t);
  }
  for (let i = 0; i < 6; i++) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('r', 6);
    c.dataset.band = String(i);
    eqPoints.append(c);
  }
})();

// 6개 점을 지나는 매끈한 곡선 (Catmull-Rom → 3차 베지어)
function eqCurvePath(pts) {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function paintEq() {
  eqEnabled.checked = eqState.enabled;
  eqBody.classList.toggle('off', !eqState.enabled);
  eqPreset.value = EQ_PRESETS.some((p) => p.id === eqState.preset) ? eqState.preset : 'custom';
  const pts = eqState.gains.map((g, i) => [eqX(i), eqY(g)]);
  const curve = eqCurvePath(pts);
  eqLine.setAttribute('d', curve);
  eqArea.setAttribute('d', `${curve} L ${pts[5][0]} ${EQ_G.bottom} L ${pts[0][0]} ${EQ_G.bottom} Z`);
  [...eqPoints.children].forEach((c, i) => {
    c.setAttribute('cx', pts[i][0]);
    c.setAttribute('cy', pts[i][1]);
    c.setAttribute('aria-label', `${document.querySelectorAll('#eq-labels span')[i].textContent} ${eqState.gains[i] > 0 ? '+' : ''}${eqState.gains[i]}dB`);
  });
}

// 드래그 중에는 50ms마다만 프레임에 보낸다 (프레임 주입 IPC를 과하게 쏘지 않도록)
let eqPushTimer = null;
function pushEqSoon() {
  if (eqPushTimer) return;
  eqPushTimer = setTimeout(() => { eqPushTimer = null; pushAudio(); }, 50);
}

eqEnabled.addEventListener('change', () => {
  eqState = { ...eqState, enabled: eqEnabled.checked };
  paintEq();
  pushAudio();
  saveSettings();
});

eqPreset.addEventListener('change', () => {
  const p = EQ_PRESETS.find((x) => x.id === eqPreset.value);
  if (!p) return; // '사용자 지정'은 고르는 항목이 아니라 표시용
  eqState = { ...eqState, enabled: true, preset: p.id, gains: [...p.gains] };
  paintEq();
  pushAudio();
  saveSettings();
});

document.getElementById('eq-reset').addEventListener('click', () => {
  eqState = { ...eqState, preset: 'flat', gains: [0, 0, 0, 0, 0, 0] };
  paintEq();
  pushAudio();
  saveSettings();
});

// 점을 위아래로 끌어 밴드 조절 (0.5dB 단위). 끄여 있던 EQ는 조작하는 순간 켠다.
let eqDrag = -1;
eqPoints.addEventListener('pointerdown', (e) => {
  const band = Number(e.target && e.target.dataset && e.target.dataset.band);
  if (!Number.isInteger(band)) return;
  e.preventDefault();
  eqDrag = band;
  e.target.classList.add('dragging');
  try { eqSvg.setPointerCapture(e.pointerId); } catch {}
});
eqSvg.addEventListener('pointermove', (e) => {
  if (eqDrag < 0) return;
  const rect = eqSvg.getBoundingClientRect();
  const y = ((e.clientY - rect.top) / rect.height) * 210; // viewBox 좌표로
  const mid = (EQ_G.top + EQ_G.bottom) / 2;
  const g = Math.round((((mid - y) / ((EQ_G.bottom - EQ_G.top) / 2)) * 12) * 2) / 2;
  const gains = [...eqState.gains];
  gains[eqDrag] = Math.max(-12, Math.min(12, g));
  eqState = { ...eqState, enabled: true, preset: 'custom', gains };
  paintEq();
  pushEqSoon();
});
const endEqDrag = () => {
  if (eqDrag < 0) return;
  eqDrag = -1;
  for (const c of eqPoints.children) c.classList.remove('dragging');
  pushAudio();
  saveSettings();
};
eqSvg.addEventListener('pointerup', endEqDrag);
eqSvg.addEventListener('pointercancel', endEqDrag);

function closeSoundPanel() {
  soundBackdrop.hidden = true;
}

document.getElementById('sound-btn').addEventListener('click', openSoundPanel);
document.getElementById('sound-close').addEventListener('click', closeSoundPanel);
soundBackdrop.addEventListener('click', (e) => {
  if (e.target === soundBackdrop) closeSoundPanel();
});

// ── 패널 접기 / 폭 조절: 사이드바·대기열 폭을 핸들 드래그로 바꾸고, 핸들 버튼으로 접는다 ──
// 상태는 settings.json의 layout에 저장. 드래그 중에는 body.resizing으로 플레이어(iframe/webview)의
// 포인터 이벤트를 막아 마우스가 영상 위를 지나도 드래그가 끊기지 않게 한다 (+ pointer capture).

const PANEL_LIMITS = { sidebar: { min: 200, max: 520 }, queue: { min: 220, max: 560 } };
// 레일(반 최소화): 버튼이 아니라 드래그로 충분히 좁혔을 때만 들어가는 상태. 썸네일 타일만 남는다.
const RAIL_WIDTH = 76; // 타일 52 + 좌우 여백 12
const RAIL_ENTER = 150; // 드래그 폭이 이보다 좁아지면 레일, 다시 넓히면 원래 폭으로 복귀
const DEFAULT_LAYOUT = {
  sidebarWidth: 300, queueWidth: 320, sidebarCollapsed: false, queueCollapsed: false,
  sidebarRail: false, queueRail: false, centerMin: false,
};
let layout = { ...DEFAULT_LAYOUT };

const sidebarEl = document.getElementById('sidebar');
const queuePanelEl = document.getElementById('queue-panel');
const minimizeBtn = document.getElementById('minimize-btn');
const CHEVRON_LEFT_SVG = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
const CHEVRON_RIGHT_SVG = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

function clampPanelWidth(key, w) {
  const lim = PANEL_LIMITS[key];
  const max = Math.min(lim.max, Math.floor(window.innerWidth * 0.45)); // 좁은 창에서 플레이어가 짓눌리지 않게
  return Math.round(Math.min(max, Math.max(lim.min, Number(w) || lim.min)));
}

function applyLayout() {
  sidebarEl.style.width = (layout.sidebarRail ? RAIL_WIDTH : clampPanelWidth('sidebar', layout.sidebarWidth)) + 'px';
  queuePanelEl.style.width = (layout.queueRail ? RAIL_WIDTH : clampPanelWidth('queue', layout.queueWidth)) + 'px';
  document.body.classList.toggle('sidebar-collapsed', !!layout.sidebarCollapsed);
  document.body.classList.toggle('queue-collapsed', !!layout.queueCollapsed);
  document.body.classList.toggle('sidebar-rail', !!layout.sidebarRail);
  document.body.classList.toggle('queue-rail', !!layout.queueRail);
  document.body.classList.toggle('center-min', !!layout.centerMin);
  minimizeBtn.classList.toggle('active', !!layout.centerMin);
  minimizeBtn.title = layout.centerMin ? '영상 다시 표시' : '영상 최소화 — 화면 구성에서 숨기고 목록을 넓게 (재생은 계속)';
  const leftBtn = document.querySelector('#resize-left .resizer-btn');
  const rightBtn = document.querySelector('#resize-right .resizer-btn');
  leftBtn.innerHTML = layout.sidebarCollapsed ? CHEVRON_RIGHT_SVG : CHEVRON_LEFT_SVG;
  leftBtn.title = layout.sidebarCollapsed ? '내 플레이리스트 펼치기' : '내 플레이리스트 접기';
  rightBtn.innerHTML = layout.queueCollapsed ? CHEVRON_LEFT_SVG : CHEVRON_RIGHT_SVG;
  rightBtn.title = layout.queueCollapsed ? '재생 대기열 펼치기' : '재생 대기열 접기';
}

// direction: 핸들을 오른쪽으로 끌 때 패널 폭이 커지면 1(왼쪽 패널), 작아지면 -1(오른쪽 패널)
function setupResizer(handleId, key, panelEl, collapsedKey, widthKey, railKey, direction) {
  const handle = document.getElementById(handleId);
  const btn = handle.querySelector('.resizer-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    layout[collapsedKey] = !layout[collapsedKey];
    applyLayout();
    saveSettings();
  });
  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || btn.contains(e.target) || layout[collapsedKey]) return;
    if (layout.centerMin && key === 'queue') return; // 중앙 최소화 중엔 대기열이 남은 폭을 다 차지
    dragging = true;
    startX = e.clientX;
    startWidth = panelEl.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const raw = startWidth + (e.clientX - startX) * direction;
    // 충분히 좁히면 레일(썸네일만), 다시 넓히면 평소 상태 — 접기 버튼과 달리 폭은 그대로 따라간다
    layout[railKey] = raw < RAIL_ENTER;
    document.body.classList.toggle(railKey === 'sidebarRail' ? 'sidebar-rail' : 'queue-rail', layout[railKey]);
    if (!layout[railKey]) layout[widthKey] = clampPanelWidth(key, raw);
    panelEl.style.width = (layout[railKey] ? RAIL_WIDTH : layout[widthKey]) + 'px';
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.classList.remove('resizing');
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    saveSettings();
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}

setupResizer('resize-left', 'sidebar', sidebarEl, 'sidebarCollapsed', 'sidebarWidth', 'sidebarRail', 1);
setupResizer('resize-right', 'queue', queuePanelEl, 'queueCollapsed', 'queueWidth', 'queueRail', -1);

// 영상 최소화: 좌우 패널을 접듯 중앙을 화면 구성에서 없앤다 (CSS가 폭 0으로 접어 재생은 그대로).
// 곡 구성/검색 오버레이를 열거나 전체화면에 들어가면 자동으로 다시 펼친다 — 그 화면들은 플레이어
// 영역 안에 그려지므로. 최소화 상태에서 재생목록을 틀 때는 사이드바 행의 재생/셔플 버튼을 쓴다.
function setCenterMin(flag) {
  if (!!layout.centerMin === !!flag) return;
  layout.centerMin = !!flag;
  applyLayout();
  saveSettings();
}

minimizeBtn.addEventListener('click', () => setCenterMin(!layout.centerMin));

// ── 구글 계정 연동: 게스트 모드(기본) ↔ 로그인 시 계정 재생목록 섹션 표시 ──
// 계정 재생목록은 유튜브 계정이 원본이므로 playlists.json에 저장하지 않고
// 실행/로그인 때마다 새로 불러온다. 로컬(게스트) 목록은 로그인과 무관하게 유지.

// 주의: 'account'는 preload의 contextBridge 전역(window.account)과 이름이 겹치면
// SyntaxError가 나므로 상태 변수는 accountState로 둔다.
let accountState = { loggedIn: false, name: '', photo: '' };
let accountPlaylists = [];
let accountOpen = false; // 앱을 켜거나 로그인한 직후에는 계정 폴더를 접어 둔다 (로컬 목록이 먼저 보이게)
let accountLoading = false;

const loginBtn = document.getElementById('login-btn');
const accountBtn = document.getElementById('account-btn');
const accountAvatar = document.getElementById('account-avatar');
const accountNameEl = document.getElementById('account-name');
const guestBadge = document.getElementById('guest-badge');

const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

function updateTopbarAccount() {
  loginBtn.hidden = accountState.loggedIn;
  guestBadge.hidden = accountState.loggedIn;
  accountBtn.hidden = !accountState.loggedIn;
  if (accountState.loggedIn) {
    accountNameEl.textContent = accountState.name || '내 계정';
    if (accountState.photo) {
      accountAvatar.src = accountState.photo;
      accountAvatar.hidden = false;
    } else {
      accountAvatar.hidden = true;
    }
  }
}

function normalizeAccountPlaylists(list) {
  return (list || []).map((p) => ({
    type: 'playlist',
    account: true,
    name: p.name || p.listId,
    listId: p.listId,
    url: `https://www.youtube.com/playlist?list=${p.listId}`,
    thumb: p.thumb || undefined,
    count: p.count != null ? p.count : undefined,
  }));
}

// 목록에 없는 썸네일/곡 수만 개별 조회로 보충 (WL 등 비공개 목록도 로그인 상태라 조회된다)
async function fetchAccountMeta() {
  const missing = accountPlaylists.filter((p) => !p.thumb);
  if (missing.length === 0) return;
  let changed = false;
  await Promise.all(missing.map(async (p) => {
    try {
      const meta = await window.playlist.meta(p.listId);
      if (meta && meta.firstVideoId) {
        p.thumb = meta.firstVideoId;
        if (meta.count != null) p.count = meta.count;
        changed = true;
      }
    } catch {}
  }));
  if (changed) renderList();
}

async function refreshAccountPlaylists() {
  accountLoading = true;
  renderList();
  try {
    accountPlaylists = normalizeAccountPlaylists(await window.account.playlists());
  } catch {
    accountPlaylists = [];
  }
  accountLoading = false;
  renderList();
  fetchAccountMeta();
}

async function initAccount() {
  try {
    accountState = await window.account.status();
  } catch {
    accountState = { loggedIn: false };
  }
  updateTopbarAccount();
  renderList();
  if (accountState.loggedIn) refreshAccountPlaylists();
}

async function doLogout() {
  try {
    await window.account.logout();
  } catch {}
  accountState = { loggedIn: false, name: '', photo: '' };
  accountPlaylists = [];
  updateTopbarAccount();
  renderList();
  showToast('로그아웃했습니다 — 게스트 모드');
}

function buildAccountHeaderRow() {
  const li = document.createElement('li');
  li.classList.add('folder-row', 'account-head');
  const icon = document.createElement('span');
  icon.className = 'pl-folder-icon account-icon';
  if (accountState.photo) {
    const img = document.createElement('img');
    img.src = accountState.photo;
    img.alt = '';
    img.draggable = false;
    icon.appendChild(img);
  } else {
    icon.innerHTML = PERSON_SVG;
  }
  const meta = document.createElement('div');
  meta.className = 'pl-meta';
  const name = document.createElement('span');
  name.className = 'pl-name';
  name.textContent = '내 YouTube 플레이리스트';
  const sub = document.createElement('span');
  sub.className = 'pl-sub';
  sub.textContent = `${accountState.name || '계정'} · ${accountPlaylists.length}개`;
  meta.append(name, sub);
  const refreshBtn = iconButton(REFRESH_SVG, '계정 재생목록 새로고침', refreshAccountPlaylists);
  li.append(icon, meta, refreshBtn);
  li.style.cursor = 'pointer';
  li.title = '클릭하여 접기/펼치기 — 구글 계정의 재생목록입니다';
  li.onclick = () => {
    accountOpen = !accountOpen;
    renderList();
  };
  li.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY, [
      { svg: REFRESH_SVG, label: '새로고침', action: refreshAccountPlaylists },
      { svg: LOGOUT_SVG, label: '로그아웃', action: doLogout },
    ]);
  };
  return li;
}

loginBtn.addEventListener('click', async () => {
  loginBtn.disabled = true;
  try {
    const result = await window.account.login();
    if (result && result.loggedIn) {
      showToast('로그인되었습니다');
      await initAccount();
    }
  } finally {
    loginBtn.disabled = false;
  }
});

accountBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const rect = accountBtn.getBoundingClientRect();
  openCtxMenu(rect.right - 210, rect.bottom + 6, [
    { svg: REFRESH_SVG, label: '계정 재생목록 새로고침', action: refreshAccountPlaylists },
    { svg: LOGOUT_SVG, label: '로그아웃', action: doLogout },
  ]);
});

// ── 유튜브 검색: 결과를 플레이어 위 오버레이로 표시, 곡 단위 재생/대기열/계정 목록 추가 ──

const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchPanel = document.getElementById('search-panel');
const searchList = document.getElementById('search-list');
const searchStatus = document.getElementById('search-status');

function closeSearchPanel() {
  searchPanel.hidden = true;
}

document.getElementById('search-close').addEventListener('click', closeSearchPanel);

function playVideoNow(item) {
  closeBrowse();
  titleCache.set(item.id, { title: item.title || item.id, author: item.author || '' });
  unplayableIds.delete(item.id);
  if (queue.length === 0) {
    queue = [item.id];
    queueIndex = 0;
  } else {
    // 현재 곡 다음 자리에 끼워 넣고 바로 재생 — 기존 대기열 순서는 유지
    queue.splice(queueIndex + 1, 0, item.id);
    queueIndex += 1;
  }
  renderQueue();
  playCurrent();
}

function enqueueVideo(item) {
  titleCache.set(item.id, { title: item.title || item.id, author: item.author || '' });
  queue.push(item.id);
  renderQueue();
  showToast('대기열에 추가했습니다');
}

function openAddToPlaylistMenu(item, anchor) {
  // 좋아요 표시 목록(LL)은 추가 API가 없어 제외
  const targets = accountPlaylists.filter((p) => p.listId !== 'LL');
  if (targets.length === 0) return showToast('추가할 수 있는 계정 재생목록이 없습니다');
  const rect = anchor.getBoundingClientRect();
  openCtxMenu(rect.left, rect.bottom + 4, targets.map((p) => ({
    svg: LIST_PLUS_SVG,
    label: p.name,
    action: async () => {
      let result = null;
      try {
        result = await window.account.addToPlaylist(p.listId, item.id);
      } catch {}
      if (result && result.ok) {
        showToast(`"${p.name}"에 추가했습니다`);
        if (p.count != null) {
          p.count += 1;
          renderList();
        }
      } else {
        showToast('추가하지 못했습니다');
      }
    },
  })));
}

function renderSearchResults(items) {
  searchList.innerHTML = '';
  if (!items || items.length === 0) {
    searchStatus.textContent = '검색 결과가 없습니다';
    searchStatus.hidden = false;
    return;
  }
  searchStatus.hidden = true;
  for (const item of items) {
    const li = document.createElement('li');
    const thumb = document.createElement('img');
    thumb.className = 's-thumb';
    thumb.src = `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`;
    thumb.loading = 'lazy';
    thumb.draggable = false;
    const meta = document.createElement('div');
    meta.className = 'q-meta';
    const title = document.createElement('div');
    title.className = 'q-title';
    title.textContent = item.title || item.id;
    const author = document.createElement('div');
    author.className = 'q-author';
    author.textContent = item.duration ? `${item.author} · ${item.duration}` : item.author;
    meta.append(title, author);
    li.append(thumb, meta, iconButton(PLAY_SVG, '지금 재생', () => playVideoNow(item)), iconButton(PLUS_SVG, '대기열에 추가', () => enqueueVideo(item)));
    if (accountState.loggedIn) {
      const addBtn = iconButton(LIST_PLUS_SVG, '내 재생목록에 추가', () => openAddToPlaylistMenu(item, addBtn));
      li.appendChild(addBtn);
    }
    li.onclick = () => playVideoNow(item);
    searchList.appendChild(li);
  }
}

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;
  setCenterMin(false); // 검색 결과도 플레이어 영역 오버레이
  searchPanel.hidden = false;
  searchList.innerHTML = '';
  searchStatus.textContent = '검색 중…';
  searchStatus.hidden = false;
  let items = [];
  try {
    items = await window.ytsearch.videos(query);
  } catch {}
  renderSearchResults(items);
});

// ── 재생목록 곡 구성 보기: 사이드바 클릭 시 중앙 오버레이에 곡 목록만 표시, 재생은 버튼으로 ──
// 재생 중인 대기열(셔플 순서 포함)을 덮어쓰지 않고 다른 재생목록을 살펴볼 수 있다.
// 곡 목록은 재생과 같은 스트리밍 수집(fetchFirst/fetchMore)으로 받아 도착하는 대로 이어 붙이고,
// 전곡을 받은 뒤 재생을 누르면 재수집 없이 그 목록으로 바로 대기열을 만든다.

const browsePanel = document.getElementById('browse-panel');
const browseListEl = document.getElementById('browse-list');
const browseStatus = document.getElementById('browse-status');
const browseThumb = document.getElementById('browse-thumb');
const browseName = document.getElementById('browse-name');
const browseSub = document.getElementById('browse-sub');
let browse = null; // { listId, name, thumb, items, done, error }
let browseToken = 0;

function cacheTitles(items) {
  for (const it of items) {
    if (it.title) titleCache.set(it.id, { title: it.title, author: it.author || '' });
    if (it.seconds) durationCache.set(it.id, it.seconds);
  }
}

function renderBrowseHead() {
  browseName.textContent = browse.name;
  browseName.title = browse.name;
  const n = browse.items.length;
  browseSub.textContent = browse.error ? '곡 목록을 불러오지 못했습니다 (비공개이거나 빈 재생목록)' : browse.done ? `${n}곡` : `${n}곡 불러오는 중…`;
  const firstId = browse.items[0] ? browse.items[0].id : browse.thumb;
  browseThumb.hidden = !firstId;
  if (firstId) browseThumb.src = `https://i.ytimg.com/vi/${firstId}/mqdefault.jpg`;
  browseStatus.hidden = !(browse.error || (n === 0 && !browse.done));
  browseStatus.textContent = browse.error ? '곡 목록을 불러오지 못했습니다' : '불러오는 중…';
}

// from 이후의 곡만 이어 붙인다 (배치마다 전체를 다시 그리지 않음)
function appendBrowseRows(from) {
  for (let i = from; i < browse.items.length; i++) {
    const it = browse.items[i];
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'q-idx';
    num.textContent = i + 1;
    const thumb = document.createElement('img');
    thumb.className = 'q-thumb';
    thumb.src = `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`;
    thumb.loading = 'lazy';
    thumb.draggable = false;
    const meta = document.createElement('div');
    meta.className = 'q-meta';
    const title = document.createElement('div');
    title.className = 'q-title';
    title.textContent = it.title || it.id;
    const author = document.createElement('div');
    author.className = 'q-author';
    author.textContent = it.author || '';
    meta.append(title, author);
    li.append(num, thumb, meta);
    li.title = '클릭하면 이 곡부터 재생목록을 재생합니다';
    li.onclick = () => playFromBrowse(false, it.id);
    browseListEl.appendChild(li);
  }
}

async function openBrowse(pl) {
  setCenterMin(false); // 곡 구성은 플레이어 영역에 그려진다 — 중앙이 최소화돼 있으면 다시 펼친다
  const token = ++browseToken;
  browse = { listId: pl.listId, name: pl.name || pl.listId, thumb: pl.thumb, items: [], done: false, error: false };
  browseListEl.innerHTML = '';
  browseListEl.scrollTop = 0;
  renderBrowseHead();
  browsePanel.hidden = false;
  let first = null;
  try {
    first = await window.playlist.fetchFirst(pl.listId);
  } catch {}
  if (token !== browseToken) return;
  if (!first || first.items.length === 0) {
    browse.error = true;
    browse.done = true;
    renderBrowseHead();
    return;
  }
  cacheTitles(first.items);
  browse.items.push(...first.items);
  appendBrowseRows(0);
  renderBrowseHead();
  let cont = first.cont;
  let guard = 50;
  while (cont && guard-- > 0) {
    let more = null;
    try {
      more = await window.playlist.fetchMore(cont);
    } catch {}
    if (token !== browseToken) return;
    if (!more) break;
    cacheTitles(more.items);
    const from = browse.items.length;
    browse.items.push(...more.items);
    appendBrowseRows(from);
    renderBrowseHead();
    cont = more.cont;
  }
  browse.done = true;
  renderBrowseHead();
}

function closeBrowse() {
  if (browsePanel.hidden) return;
  browseToken++; // 진행 중인 수집 중단
  browse = null;
  browsePanel.hidden = true;
}

// 곡 구성 화면의 재생/셔플/곡 클릭 → 대기열 교체. 전곡을 이미 받았으면 재수집 없이 바로 재생.
function playFromBrowse(shuffle, startId) {
  if (!browse) return;
  const preset = browse.done && !browse.error ? { items: browse.items.slice(), startId } : { startId };
  playPlaylist(browse.listId, shuffle, preset);
}

document.getElementById('browse-play').addEventListener('click', () => playFromBrowse(false));
document.getElementById('browse-shuffle').addEventListener('click', () => playFromBrowse(true));
document.getElementById('browse-close').addEventListener('click', closeBrowse);

// ── 추천 곡: 현재 곡을 시드로 유튜브 관련 동영상(watch next)을 하단 패널에 표시 ──
// 재생 바의 토글 버튼으로 열고 닫으며, 새로고침은 대기열에서 무작위 곡을 시드로 뽑아
// 매번 다른 추천을 보여준다. 이미 대기열에 있는 곡은 목록에서 제외.

const recsPanel = document.getElementById('recs-panel');
const recsListEl = document.getElementById('recs-list');
const recsStatus = document.getElementById('recs-status');
const recsSeedEl = document.getElementById('recs-seed');
const recsBtn = document.getElementById('recs-btn');
let recsLoading = false;
let recsListId = null; // 추천을 불러온 재생목록
let recsToken = null; // 다음 배치용 continuation (새로고침 때마다 전진)

function setRecsStatus(message) {
  recsListEl.innerHTML = '';
  recsStatus.textContent = message || '';
  recsStatus.hidden = !message;
}

// reset=true면 activeListId로 처음부터, 아니면 continuation을 이어받아 다음 추천 배치
async function loadRecs(reset) {
  if (recsLoading) return;
  if (!activeListId) {
    recsListEl.innerHTML = '';
    recsSeedEl.textContent = '';
    setRecsStatus('저장된 재생목록을 재생하면 그 재생목록 기준 추천이 표시됩니다');
    return;
  }
  if (reset || recsListId !== activeListId) {
    recsListId = activeListId;
    recsToken = null;
  }
  recsLoading = true;
  setRecsStatus('추천 불러오는 중…');
  recsSeedEl.textContent = activePlaylistName ? `"${activePlaylistName}" 기준` : '';
  let res = null;
  try {
    res = await window.recs.fetch(recsListId, recsToken);
  } catch {}
  recsLoading = false;
  if (recsListId !== activeListId) return; // 그새 다른 재생목록으로 바뀜
  recsToken = (res && res.next) || null;
  const items = (res && res.items) || [];
  const inQueue = new Set(queue);
  renderRecs(items.filter((v) => v && !inQueue.has(v.id)), items.length > 0);
}

// hadRaw: 유튜브가 추천을 주긴 했는데 전부 대기열에 이미 있어 걸러진 경우와,
// 애초에 "맞춤 동영상" 섹션이 없는 재생목록을 구분해 안내 문구를 다르게 낸다.
function renderRecs(items, hadRaw) {
  recsListEl.innerHTML = '';
  if (!items || items.length === 0) {
    if (hadRaw) {
      setRecsStatus('새 추천이 없습니다 — 새로고침을 눌러 보세요');
    } else if (!accountState.loggedIn) {
      setRecsStatus('맞춤 추천은 로그인 후 내 재생목록에서 제공됩니다');
    } else {
      setRecsStatus('이 재생목록은 유튜브 맞춤 추천을 제공하지 않습니다');
    }
    return;
  }
  recsStatus.hidden = true;
  for (const item of items) {
    const li = document.createElement('li');
    const thumb = document.createElement('img');
    thumb.className = 'r-thumb';
    thumb.src = `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`;
    thumb.loading = 'lazy';
    thumb.draggable = false;
    const title = document.createElement('div');
    title.className = 'r-title';
    title.textContent = item.title || item.id;
    title.title = item.title || '';
    const author = document.createElement('div');
    author.className = 'r-author';
    author.textContent = item.duration ? `${item.author} · ${item.duration}` : item.author;
    const actions = document.createElement('div');
    actions.className = 'r-actions';
    const queueBtn = document.createElement('button');
    queueBtn.title = '대기열에 추가';
    queueBtn.innerHTML = PLUS_SVG;
    queueBtn.onclick = (e) => {
      e.stopPropagation();
      enqueueVideo(item);
      li.remove();
    };
    actions.appendChild(queueBtn);
    if (accountState.loggedIn) {
      const addBtn = document.createElement('button');
      addBtn.title = '내 재생목록에 추가';
      addBtn.innerHTML = LIST_PLUS_SVG;
      addBtn.onclick = (e) => {
        e.stopPropagation();
        openAddToPlaylistMenu(item, addBtn);
      };
      actions.appendChild(addBtn);
    }
    li.append(thumb, actions, title, author);
    li.title = '클릭하여 지금 재생';
    li.onclick = () => {
      playVideoNow(item);
      li.remove();
    };
    recsListEl.appendChild(li);
  }
}

function toggleRecs() {
  const opening = recsPanel.hidden;
  recsPanel.hidden = !opening;
  recsBtn.classList.toggle('active', opening);
  if (opening) loadRecs(false);
}

recsBtn.addEventListener('click', toggleRecs);
document.getElementById('recs-refresh').addEventListener('click', () => loadRecs(false)); // 다음 추천 배치
document.getElementById('recs-close').addEventListener('click', toggleRecs);

function iconButton(svg, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'pl-icon';
  btn.title = title;
  btn.innerHTML = svg;
  btn.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return btn;
}

// 이름(+재생목록이면 링크) 인라인 수정 폼
function buildEditForm(item) {
  const form = document.createElement('form');
  form.className = 'pl-edit-form';
  const nameIn = document.createElement('input');
  nameIn.value = item.name;
  nameIn.placeholder = item.type === 'folder' ? '폴더 이름' : '플레이리스트 이름';
  form.appendChild(nameIn);
  let urlIn = null;
  if (item.type === 'playlist') {
    urlIn = document.createElement('input');
    urlIn.value = item.url;
    urlIn.placeholder = '유튜브 재생목록 링크';
    form.appendChild(urlIn);
  }
  const err = document.createElement('p');
  err.className = 'error';
  err.hidden = true;
  const buttons = document.createElement('div');
  buttons.className = 'pl-edit-buttons';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = '저장';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = '취소';
  cancelBtn.onclick = () => {
    editingItem = null;
    renderList();
  };
  buttons.append(saveBtn, cancelBtn);
  form.append(buttons, err);
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) {
      err.textContent = '이름을 입력하세요';
      err.hidden = false;
      return;
    }
    if (urlIn) {
      const url = urlIn.value.trim();
      const listId = extractListId(url);
      if (!listId) {
        err.textContent = '유효한 재생목록 링크가 아닙니다 (list= 파라미터 필요)';
        err.hidden = false;
        return;
      }
      if (item.listId !== listId) {
        // 다른 재생목록으로 바뀌면 썸네일/곡 수 다시 수집
        delete item.thumb;
        delete item.count;
      }
      item.url = url;
      item.listId = listId;
    }
    item.name = name;
    editingItem = null;
    persistAndRender();
    fetchMissingMeta();
  };
  return form;
}

function buildPlaylistRow(pl, depth) {
  const li = document.createElement('li');
  li.classList.add('playlist-row');
  if (depth) li.style.marginLeft = depth * 24 + 'px';
  if (pl.listId === activeListId) li.classList.add('active');
  if (editingItem === pl) {
    li.appendChild(buildEditForm(pl));
    return li;
  }
  if (!pl.account) {
    // 계정 재생목록은 유튜브 계정이 원본이라 드래그 정리/수정/삭제 대상이 아니다
    makeDraggable(li, pl);
    makeDropTarget(li, pl);
  }

  // 첫 곡 썸네일 (fetchMissingMeta가 채우기 전에는 빈 타일)
  let thumb;
  if (pl.thumb) {
    thumb = document.createElement('img');
    thumb.src = `https://i.ytimg.com/vi/${pl.thumb}/mqdefault.jpg`;
    thumb.loading = 'lazy';
    thumb.draggable = false; // 이미지 자체 드래그가 행 드래그를 가로채지 않도록
  } else {
    thumb = document.createElement('div');
  }
  thumb.className = 'pl-thumb';

  const meta = document.createElement('div');
  meta.className = 'pl-meta';
  const name = document.createElement('span');
  name.className = 'pl-name';
  name.textContent = pl.name;
  name.title = pl.url;
  const sub = document.createElement('span');
  sub.className = 'pl-sub';
  sub.textContent = pl.count != null ? `재생목록 · ${pl.count}곡` : '재생목록';
  meta.append(name, sub);

  // 행 클릭은 곡 구성 보기이므로, 바로 재생하는 버튼을 따로 둔다 (중앙을 최소화한 상태에서도 재생 가능)
  const playBtn = iconButton(PLAY_SVG, '재생', () => playPlaylist(pl.listId, false));
  playBtn.classList.add('pl-play'); // 레일 상태에서 썸네일 위에 겹쳐 보여줄 버튼
  const shuffleBtn = iconButton(SHUFFLE_SVG, '셔플 재생', () => playPlaylist(pl.listId, true));
  li.append(thumb, meta, playBtn, shuffleBtn);
  if (!pl.account) {
    const editBtn = iconButton(PENCIL_SVG, '이름/링크 수정', () => {
      editingItem = pl;
      renderList();
    });
    const deleteBtn = iconButton(TRASH_SVG, '삭제', () => {
      removeItem(pl);
      persistAndRender();
    });
    li.append(editBtn, deleteBtn);
  }
  li.title = `${pl.name} — 클릭하여 곡 구성 보기 · 우클릭으로 더 보기`; // 레일에서는 이름이 안 보인다
  li.onclick = () => openBrowse(pl); // 바로 재생하지 않고 중앙에 곡 구성만 표시 — 재생은 그 화면의 버튼으로
  li.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const entries = [
      { svg: LIST_SVG, label: '곡 구성 보기', action: () => openBrowse(pl) },
      { svg: PLAY_SVG, label: '재생', action: () => playPlaylist(pl.listId, false) },
      { svg: SHUFFLE_SVG, label: '셔플 재생', action: () => playPlaylist(pl.listId, true) },
    ];
    if (!pl.account) {
      entries.push(
        '-',
        {
          svg: FOLDER_SVG,
          label: '같은 위치에 새 폴더',
          action: () => {
            const loc = findLocation(pl);
            createFolder(loc.arr, loc.index + 1);
          },
        },
        { svg: PENCIL_SVG, label: '이름/링크 수정', action: () => { editingItem = pl; renderList(); } },
        { svg: TRASH_SVG, label: '삭제', action: () => { removeItem(pl); persistAndRender(); } }
      );
    }
    openCtxMenu(e.clientX, e.clientY, entries);
  };
  return li;
}

function buildFolderRow(folder, depth) {
  const li = document.createElement('li');
  li.classList.add('folder-row');
  if (depth) li.style.marginLeft = depth * 24 + 'px';
  if (editingItem === folder) {
    li.appendChild(buildEditForm(folder));
    return li;
  }
  makeDraggable(li, folder);
  makeDropTarget(li, folder);

  // 열림/닫힘은 폴더 아이콘 모양으로 표현 (별도 caret 컬럼을 두면 재생목록 행과 정렬이 어긋난다)
  const icon = document.createElement('span');
  icon.className = 'pl-folder-icon';
  icon.innerHTML = folder.open ? FOLDER_OPEN_SVG : FOLDER_SVG;

  const meta = document.createElement('div');
  meta.className = 'pl-meta';
  const name = document.createElement('span');
  name.className = 'pl-name';
  name.textContent = folder.name;
  const sub = document.createElement('span');
  sub.className = 'pl-sub';
  sub.textContent = `폴더 · ${folder.items.length}개 항목`;
  meta.append(name, sub);

  const removeFolder = () => {
    const loc = findLocation(folder);
    loc.arr.splice(loc.index, 1, ...folder.items); // 폴더 자리를 안의 항목들로 대체
    persistAndRender();
  };

  const editBtn = iconButton(PENCIL_SVG, '폴더 이름 수정', () => {
    editingItem = folder;
    renderList();
  });
  const deleteBtn = iconButton(TRASH_SVG, '폴더 삭제 (안의 항목은 한 단계 밖으로 이동)', removeFolder);

  li.append(icon, meta, editBtn, deleteBtn);
  li.style.cursor = 'pointer';
  li.title = '클릭하여 접기/펼치기 · 우클릭으로 더 보기 · 재생목록이나 폴더를 여기로 드래그하면 폴더 안에 들어갑니다';
  li.onclick = () => {
    folder.open = !folder.open;
    persistAndRender();
  };
  li.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY, [
      {
        svg: PLUS_SVG,
        label: '이 폴더 안에 새 폴더',
        action: () => {
          folder.open = true;
          createFolder(folder.items);
        },
      },
      '-',
      { svg: PENCIL_SVG, label: '폴더 이름 수정', action: () => { editingItem = folder; renderList(); } },
      { svg: TRASH_SVG, label: '폴더 삭제 (항목은 밖으로 이동)', action: removeFolder },
    ]);
  };
  return li;
}

function buildEmptyFolderHint(folder, depth) {
  const li = document.createElement('li');
  li.className = 'folder-empty';
  li.style.marginLeft = depth * 24 + 'px';
  li.textContent = '비어 있음 — 재생목록을 여기로 드래그';
  makeDropTarget(li, folder, true);
  return li;
}

function renderList() {
  listEl.innerHTML = '';
  // 로그인 시: 계정 재생목록 섹션을 로컬(게스트) 목록 위에 표시 — 로컬 목록은 그대로 유지된다
  if (accountState.loggedIn) {
    listEl.appendChild(buildAccountHeaderRow());
    if (accountOpen) {
      if (accountPlaylists.length === 0) {
        const hint = document.createElement('li');
        hint.className = 'folder-empty';
        hint.style.marginLeft = '24px';
        hint.textContent = accountLoading ? '계정 재생목록 불러오는 중…' : '계정에 재생목록이 없습니다';
        listEl.appendChild(hint);
      } else {
        for (const pl of accountPlaylists) listEl.appendChild(buildPlaylistRow(pl, 1));
      }
    }
    const sep = document.createElement('li');
    sep.className = 'list-sep';
    listEl.appendChild(sep);
  }
  const renderInto = (items, depth) => {
    for (const item of items) {
      if (item.type === 'folder') {
        listEl.appendChild(buildFolderRow(item, depth));
        if (item.open) {
          if (item.items.length === 0) listEl.appendChild(buildEmptyFolderHint(item, depth + 1));
          else renderInto(item.items, depth + 1);
        }
      } else {
        listEl.appendChild(buildPlaylistRow(item, depth));
      }
    }
  };
  renderInto(playlists, 0);
  // 수정 폼이 열렸으면 이름 입력창에 바로 포커스
  const focusIn = listEl.querySelector('.pl-edit-form input');
  if (focusIn) {
    focusIn.focus();
    focusIn.select();
  }
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}

document.getElementById('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const url = urlInput.value.trim();
  if (!name) return showError('플레이리스트 이름을 입력하세요');
  const listId = extractListId(url);
  if (!listId) return showError('유효한 재생목록 링크가 아닙니다 (list= 파라미터 필요)');
  showError('');
  playlists.push({ type: 'playlist', name, url, listId });
  await window.store.save(playlists);
  nameInput.value = '';
  urlInput.value = '';
  renderList();
  fetchMissingMeta();
});

document.getElementById('new-folder-btn').addEventListener('click', () => createFolder(playlists));

document.getElementById('play-now-btn').addEventListener('click', () => {
  const listId = extractListId(urlInput.value.trim());
  if (!listId) return showError('유효한 재생목록 링크가 아닙니다 (list= 파라미터 필요)');
  showError('');
  playPlaylist(listId, false);
});

document.getElementById('prev-btn').addEventListener('click', prevTrack);
document.getElementById('next-btn').addEventListener('click', nextTrack);
document.getElementById('play-btn').addEventListener('click', togglePlayback);

// ── 하단 전용 재생바 ──
// 중앙 플레이어는 마우스 상호작용을 막아 두었으므로(유튜브 자체 UI로 상태가 어긋나는 것 방지)
// 재생 지점 이동은 이 바에서만 한다. 진행 위치는 가사 창으로 보내는 상태(lyricsPublishedState)를
// 그대로 쓰고, 폴링 사이는 lyricsProgressNow()로 보간해 부드럽게 채운다.
const playBtn = document.getElementById('play-btn');
const progressTrack = document.getElementById('progress-track');
const progressFill = document.getElementById('progress-fill');
const pbElapsed = document.getElementById('pb-elapsed');
const pbDuration = document.getElementById('pb-duration');
let seekPreview = null; // 드래그 중에는 미리보기 값이 우선
function fractionFromEvent(e) {
  const rect = progressTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

// 같은 글자는 다시 쓰지 않는다 — 같은 값이라도 다시 쓰면 레이아웃·다시 그리기가 일어난다(주기적으로 도는 표시용)
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
let progressBarWidth = '';

function paintProgressBar() {
  const duration = lyricsPublishedState.duration;
  const progress = seekPreview != null ? seekPreview * duration : lyricsProgressNow();
  const width = duration > 0 ? `${Math.min(100, Math.max(0, progress / duration * 100)).toFixed(2)}%` : '0%';
  if (width !== progressBarWidth) { progressBarWidth = width; progressFill.style.width = width; }
  setText(pbElapsed, formatClock(progress));
  setText(pbDuration, formatClock(duration));
  const playing = lyricsPublishedState.status === 'playing';
  playBtn.classList.toggle('paused', !playing);
  const tip = playing ? '일시정지' : '재생';
  if (playBtn.title !== tip) playBtn.title = tip;
}

progressTrack.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !lyricsPublishedState.duration) return;
  seekPreview = fractionFromEvent(e);
  document.body.classList.add('seeking');
  try { progressTrack.setPointerCapture(e.pointerId); } catch {} // 캡처 실패가 나머지 처리를 막지 않도록
  paintProgressBar();
});
progressTrack.addEventListener('pointermove', (e) => {
  if (seekPreview == null) return;
  seekPreview = fractionFromEvent(e);
  paintProgressBar();
});
const endSeek = (e) => {
  if (seekPreview == null) return;
  const fraction = seekPreview;
  seekPreview = null;
  document.body.classList.remove('seeking');
  try { progressTrack.releasePointerCapture(e.pointerId); } catch {}
  seekToFraction(fraction);
  paintProgressBar();
};
progressTrack.addEventListener('pointerup', endSeek);
progressTrack.addEventListener('pointercancel', endSeek);
setInterval(paintProgressBar, 250);
paintProgressBar();
document.getElementById('shuffle-btn').addEventListener('click', reshuffleQueue);
document.getElementById('lyrics-btn').addEventListener('click', () => window.lyricsctl.toggle());
window.lyrics.onControl((action, value) => {
  if (action === 'previous') prevTrack();
  else if (action === 'toggle-play') togglePlayback();
  else if (action === 'next') nextTrack();
  else if (action === 'seek') seekToFraction(value);
  else if (action === 'seek-by') seekBySeconds(value);
  else if (action === 'volume-step') setMasterVolume(masterVolume + value, true); // 전역 단축키(Alt+1/Alt+2)
  else if (action === 'mute-toggle') toggleMute(); // 전역 단축키(Alt+`)
  else if (action === 'volume') setMasterVolume(value, false); // 드래그 중 실시간 반영
  else if (action === 'volume-save') setMasterVolume(value, true); // 조작을 마쳤을 때 저장
});

// Alt+Q/E를 꾹 누를 때: 현재 위치에서 몇 초 앞뒤로 (전역 단축키 자동 반복마다 호출)
function seekBySeconds(seconds) {
  const d = lyricsPublishedState.duration;
  if (!(d > 0)) return;
  const target = Math.max(0, Math.min(d, lyricsProgressNow() + Number(seconds) * 1000));
  seekToFraction(target / d);
}

// 플로팅 창 재생바 클릭 → 곡의 해당 지점(0~1 비율)으로 이동. 임베드는 seekTo, 직접 재생은 video.currentTime.
function seekToFraction(fraction) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  if (fallbackActive) {
    // 워치페이지 폴링은 1초 주기라, 이동 결과가 돌아올 때까지 재생바가 옛 위치로 되돌아가 둔하게 느껴진다
    // → 앱이 아는 재생시간으로 즉시 반영해 두고(낙관적), 다음 폴링이 실제 값으로 정정한다.
    const known = lyricsPublishedState.duration;
    if (known > 0) publishLyricsState({ progress: known * f });
    fallbackView.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      if (!v) return;
      const d = v.duration || ${known / 1000};
      if (d) v.currentTime = d * ${f};
    })()`).catch(() => {});
    return;
  }
  if (!playerReady) return;
  try {
    const d = player.getDuration();
    if (d > 0) {
      player.seekTo(d * f, true);
      publishLyricsState({ progress: d * f * 1000, duration: d * 1000 });
    }
  } catch {}
}

// ── 가사 보기: 영상 위 오버레이 ──
// main이 찾은 현재 곡 가사(lyrics:data)를 오른쪽에 전부 나열하고, 진행 위치를 보간해
// 현재 블록을 세로 중앙에 맞춰 부드럽게 이동시킨다. 멀어질수록 흐리고 옅게.
// 오버레이는 pointer-events: none이라 영상 조작을 가리지 않는다 (몰입 모드의 곡 정보 컨트롤만 예외).
const lyricsViewEl = document.getElementById('lyrics-overlay');
const lyricsViewport = document.getElementById('lyrics-overlay-viewport');
const lyricsViewList = document.getElementById('lyrics-overlay-list');
const lyricsViewMsg = document.getElementById('lyrics-overlay-msg');
const lyricsViewBtn = document.getElementById('lyrics-view-btn');
const loThumb = document.getElementById('lo-thumb');
const loTitle = document.getElementById('lo-title');
const loArtist = document.getElementById('lo-artist');
const loTrBadge = document.getElementById('lo-tr-badge');
const npTrBadge = document.getElementById('np-tr-badge');
const loPause = document.getElementById('lo-pause');
const loTime = document.getElementById('lo-time');
let lyricsViewOn = false;
let lyricsViewData = null; // { lines: [{time, text}], source, language, unavailable }
let lyricsViewIndex = -2;
let lyricsViewTimer = null;
let lyricsViewOffset = 0; // 곡별 가사 싱크 보정(ms) — 플로팅 창과 같은 값 (main이 Alt+A/D로 바꾼다)
window.lyricsOverlay.onOffset((ms) => {
  lyricsViewOffset = Number(ms) || 0;
  if (lyricsViewOn) tickLyricsView(true);
});
window.lyricsOverlay.getOffset().then((ms) => { lyricsViewOffset = Number(ms) || 0; }).catch(() => {});

function lyricsProgressNow() {
  const s = lyricsPublishedState;
  if (s.status !== 'playing') return s.progress;
  return Math.min(s.duration || Infinity, s.progress + performance.now() - lyricsStateAt);
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// 싱크 없는 가사(본문만): 현재 줄 강조 없이 전부 나열하고 마우스 휠로 스크롤한다
let lyricsPlainScroll = 0;

function lyricsViewIsPlain() {
  return !!(lyricsViewData && lyricsViewData.plain && lyricsViewData.lines && lyricsViewData.lines.length);
}

function applyPlainScroll() {
  const top = lyricsViewport.clientHeight * 0.18;
  const min = Math.min(top, lyricsViewport.clientHeight * 0.5 - lyricsViewList.offsetHeight);
  lyricsPlainScroll = Math.max(min, Math.min(top, lyricsPlainScroll));
  lyricsViewList.style.transform = `translateY(${Math.round(lyricsPlainScroll)}px)`;
}

lyricsViewport.addEventListener('wheel', (e) => {
  if (!lyricsViewIsPlain()) return;
  e.preventDefault();
  lyricsPlainScroll -= e.deltaY;
  applyPlainScroll();
}, { passive: false });

function renderLyricsView() {
  lyricsViewList.replaceChildren();
  lyricsViewList.style.transform = '';
  lyricsViewIndex = -2;
  const plain = lyricsViewIsPlain();
  lyricsViewEl.toggleAttribute('data-plain', plain);
  const lines = (lyricsViewData && lyricsViewData.lines) || [];
  for (const line of lines) {
    const li = document.createElement('li');
    const parts = String(line.text).split('\n');
    // 영어가 아닌 외국어 원문에 발음·번역 줄이 딸리면 원문을 작게(사용자 요청 — 플로팅 창과 같은 규칙)
    const foreign = parts.length > 1 && /[\u3040-\u30ff\u4e00-\u9fff\u0400-\u04ff\u0e00-\u0e7f]/.test(parts[0]) && !/[\uac00-\ud7a3]/.test(parts[0]);
    li.className = foreign ? 'lo-block far foreign' : 'lo-block far';
    li.dataset.foreign = foreign ? '1' : '';
    parts.forEach((part, i) => {
      const el = document.createElement('div');
      el.className = i === 0 ? 'lo-main' : 'lo-sub';
      el.textContent = part;
      li.append(el);
    });
    lyricsViewList.append(li);
  }
  let msg = '';
  if (!lyricsPublishedState.id) msg = '재생 중인 곡이 없습니다';
  else if (!lyricsViewData) msg = '가사를 찾는 중…';
  else if (lyricsViewData.unavailable || lines.length === 0) msg = '가사를 찾지 못했습니다';
  lyricsViewMsg.textContent = msg;
  lyricsViewMsg.hidden = !msg;
  if (plain) {
    for (const li of lyricsViewList.children) li.className = `lo-block plain${li.dataset.foreign ? ' foreign' : ''}`;
    lyricsPlainScroll = lyricsViewport.clientHeight * 0.18;
    applyPlainScroll();
  }
  tickLyricsView(true);
}

function tickLyricsView(force) {
  const s = lyricsPublishedState;
  setText(loTitle, s.title || '');
  setText(loArtist, s.artist || '');
  if (loThumb.dataset.src !== (s.coverUrl || '')) {
    loThumb.dataset.src = s.coverUrl || '';
    loThumb.src = s.coverUrl || '';
  }
  setText(loTime, `${formatClock(lyricsProgressNow())} / ${formatClock(s.duration)}`);
  loPause.classList.toggle('paused', s.status !== 'playing');

  const blocks = lyricsViewList.children;
  if (blocks.length === 0 || lyricsViewIsPlain()) return; // 싱크 없는 가사는 휠로만 움직인다
  const progress = lyricsProgressNow();
  const lines = lyricsViewData.lines;
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= progress + 225 + lyricsViewOffset) index = i; // 곡별 싱크 보정(Alt+A/D)
    else break;
  }
  if (index === lyricsViewIndex && !force) return;
  lyricsViewIndex = index;
  const center = Math.max(index, 0);
  for (let i = 0; i < blocks.length; i++) {
    const d = Math.abs(i - center);
    blocks[i].className = `lo-block ${i === index ? 'current' : d <= 1 ? 'd1' : d === 2 ? 'd2' : d === 3 ? 'd3' : 'far'}${blocks[i].dataset.foreign ? ' foreign' : ''}`;
  }
  const target = blocks[center];
  const y = lyricsViewport.clientHeight / 2 - target.offsetTop - target.offsetHeight / 2;
  lyricsViewList.style.transform = `translateY(${Math.round(y)}px)`;
}

// 한글 가사를 못 찾아 번역으로 채운 가사면 가사 보기에서 제목 옆에 '번역 결과'를 단다
// (몰입 모드는 왼쪽 아래 곡 정보의 제목 옆, 평소엔 하단 재생 바 제목 아래 — 가사 보기를 연 동안만)
function updateTranslatedBadges() {
  const d = lyricsViewData;
  const on = !!(d && d.machineTranslated);
  const tip = !on ? '' : d.translatedBy === 'web' ? '한글 가사를 찾지 못해 웹 번역(Bing·구글)으로 옮긴 가사입니다'
    : '한글 가사를 찾지 못해 내장 모델로 번역한 가사입니다';
  loTrBadge.hidden = !on;
  loTrBadge.title = tip;
  npTrBadge.hidden = !(on && lyricsViewOn);
  npTrBadge.title = tip;
}

// ── 미리 듣기: 자동 싱크용 숨은 분석 임베드 — main(분석 관리자)이 곡 id를 주면 띄우고 null이면 치운다.
// 화면 밖에 둔 작은 iframe(소리는 analysis-capture.js가 스피커로 내보내지 않는다). 화면 배치·조작에 영향 없음.
// 예전엔 화면 안(왼쪽 위, 투명도 0.01)에 두어 5.5배속 영상 프레임마다 창 전체가 다시 합성됐다 — 화면 밖이면 합성할
// 것이 없다(실측: 화면 밖에서도 소리 받기·5.5배속 재생 그대로).
window.ympAnalysis.onLoad((id, start) => {
  let f = document.getElementById('analysis-frame');
  if (!id) { if (f) f.remove(); return; }
  if (!f) {
    f = document.createElement('iframe');
    f.id = 'analysis-frame';
    f.allow = 'autoplay';
    f.tabIndex = -1;
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:200px;height:112px;pointer-events:none;z-index:-1;border:0';
    document.body.append(f);
  }
  // start: 저장본에서 이어 하는 곡은 이미 들은 지점부터(main이 정한다)
  const from = Math.max(0, Math.floor(Number(start) || 0));
  f.src = `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&rel=0&playsinline=1${from ? `&start=${from}` : ''}&ymp=analysis`;
});

// ── 가사 종류 표시: 싱크 가사/텍스트 가사 · 번역 출처 · 자동 싱크 상태를 플레이어 오른쪽 위에 작게 ──
// 마우스를 움직일 때만 잠깐 보인다(전체화면의 ✕처럼). 플로팅 창에는 띄우지 않는다(사용자 명세).
const lyricsKindEl = document.getElementById('lyrics-kind');
const lkMain = document.getElementById('lk-main');
const lkSync = document.getElementById('lk-sync');
let lyricsKindTimer = null;
const LYRIC_SOURCE_LABELS = { alsong: '알송', lrclib: 'LRCLIB', netease: 'NetEase', bugs: 'Bugs', utaten: 'utaten', genius: 'Genius', uta5: 'uta5', desc: '영상 설명란', user: '직접 입력' };

function lyricsKindText(d) {
  if (!lyricsPublishedState.id) return null;
  if (!d) return { main: '가사 찾는 중…', sync: '' };
  if (d.unavailable) return { main: d.deleted ? '가사 삭제됨' : d.mismatch ? '소리와 맞는 가사를 찾지 못함' : '가사 없음', sync: '' };
  const text = d.origin === 'text' || d.plain;
  const src = LYRIC_SOURCE_LABELS[d.source] || d.source || '';
  const firstLines = (d.baseLines || d.lines || []).map((l) => String(l.text || '').split('\n')[0]).join(' ');
  const koreanSong = /[\uac00-\ud7a3]/.test(firstLines);
  let tr;
  if (d.machineTranslated) tr = d.translatedBy === 'web' ? '웹 번역' : '내장 모델 번역';
  else if (koreanSong) tr = '한국어 가사';
  else if (d.hasKorean) tr = '번역 포함';
  else if (String(d.augmented || '').startsWith('pron')) tr = '번역 없음 · 발음 표기';
  else tr = '번역 없음';
  const s = d.sync || {};
  const pct = Math.round((s.progress || 0) * 100);
  let sync;
  switch (s.kind) {
    case 'rough': sync = lyricsSettings.autoSync ? '대략 싱크 — 소리로 맞추는 중' : '대략 싱크(같은 간격)'; break;
    case 'auto-partial': sync = `자동 싱크 계산 중 ${pct}%`; break;
    case 'auto': sync = s.replacedDb ? '자동 싱크 (원본 싱크가 어긋나 교체)' : '자동 싱크 완료'; break;
    case 'db-shifted': sync = `원본 싱크 · 소리로 ${s.shiftMs > 0 ? '+' : ''}${((s.shiftMs || 0) / 1000).toFixed(1)}초 보정`; break;
    case 'db-verified': sync = '원본 싱크 · 소리로 확인됨'; break;
    default: sync = s.verdict === 'mismatch' ? '원본 싱크 · 소리와 다를 수 있음' : '원본 싱크';
  }
  if (d.fromStore) sync += ' · 저장됨';
  return { main: `${text ? '텍스트 가사' : '싱크 가사'}${src ? ` (${src})` : ''} · ${tr}`, sync };
}

function paintLyricsKind() {
  const t = lyricsKindText(lyricsViewData);
  lkMain.textContent = t ? t.main : '';
  lkSync.textContent = t ? t.sync : '';
  lkSync.hidden = !(t && t.sync);
  return !!t;
}

function pokeLyricsKind() {
  if (!paintLyricsKind()) return;
  lyricsKindEl.classList.add('show');
  clearTimeout(lyricsKindTimer);
  lyricsKindTimer = setTimeout(() => lyricsKindEl.classList.remove('show'), 1800);
}

document.addEventListener('mousemove', pokeLyricsKind);

function setLyricsView(flag) {
  lyricsViewOn = flag;
  lyricsViewEl.hidden = !flag;
  lyricsViewBtn.classList.toggle('active', flag);
  clearInterval(lyricsViewTimer);
  updateTranslatedBadges();
  if (!flag) return;
  renderLyricsView();
  lyricsViewTimer = setInterval(() => tickLyricsView(false), 100);
}

lyricsViewBtn.addEventListener('click', () => setLyricsView(!lyricsViewOn));

// ── 가사 검색 (메인 창): 플로팅 창의 검색과 같은 IPC(lyricsOverlay.search/select)를 쓴다 ──
const lyricsSearchBackdrop = document.getElementById('lyrics-search-backdrop');
const lyricsSearchTitle = document.getElementById('lyrics-search-title');
const lyricsSearchArtist = document.getElementById('lyrics-search-artist');
const lyricsSearchStatus = document.getElementById('lyrics-search-status');
const lyricsSearchResults = document.getElementById('lyrics-search-results');

async function openLyricsSearch() {
  // 유튜브 제목 그대로가 아니라 앱이 정제한 제목/아티스트를 기본값으로
  let parsed = { title: lyricsPublishedState.title || '', artist: lyricsPublishedState.artist || '' };
  try { parsed = await window.lyricsOverlay.parse(parsed); } catch {}
  lyricsSearchTitle.value = parsed.title || '';
  lyricsSearchArtist.value = parsed.artist || '';
  lyricsSearchStatus.textContent = lyricsPublishedState.id ? '' : '재생 중인 곡이 없습니다 — 제목을 직접 입력해 검색할 수 있습니다';
  lyricsSearchResults.replaceChildren();
  lyricsSearchBackdrop.hidden = false;
  lyricsSearchTitle.focus();
}

function closeLyricsSearch() {
  lyricsSearchBackdrop.hidden = true;
}

document.getElementById('lyrics-search-btn').addEventListener('click', openLyricsSearch);
document.getElementById('lyrics-retry-btn').addEventListener('click', () => { window.lyricsOverlay.retry(); showToast('가사를 다시 찾는 중…'); });
document.getElementById('lyrics-search-close').addEventListener('click', closeLyricsSearch);
document.getElementById('lyrics-textonly-btn').addEventListener('click', async () => {
  lyricsSearchStatus.textContent = '텍스트 가사를 찾는 중…';
  let r = null;
  try { r = await window.lyricsOverlay.textOnlySearch(); } catch {}
  if (r) {
    closeLyricsSearch();
    showToast(`텍스트 가사를 적용했습니다 (${LYRIC_SOURCE_LABELS[r.source] || r.source}) — 소리에 맞춰 싱크를 잡습니다`);
  } else {
    lyricsSearchStatus.textContent = '텍스트 가사를 찾지 못했습니다 — 가사를 직접 붙여넣을 수 있습니다.';
  }
});
document.getElementById('lyrics-paste-btn').addEventListener('click', async () => {
  const text = document.getElementById('lyrics-paste').value;
  let r = null;
  try { r = await window.lyricsOverlay.pasteLyrics(text); } catch {}
  if (r) {
    document.getElementById('lyrics-paste').value = '';
    closeLyricsSearch();
    showToast(r.plain ? `가사 ${r.lines}줄을 적용했습니다 — 소리에 맞춰 싱크를 잡습니다` : `싱크 가사 ${r.lines}줄을 적용했습니다`);
  } else {
    lyricsSearchStatus.textContent = '붙여넣은 가사가 비었거나 너무 짧습니다(두 줄 이상).';
  }
});
document.getElementById('lyrics-delete-btn').addEventListener('click', async () => {
  let ok = false;
  try { ok = await window.lyricsOverlay.deleteLyrics(); } catch {}
  closeLyricsSearch();
  showToast(ok ? '이 곡의 가사를 지웠습니다 — 다시 찾기로 다시 찾을 수 있습니다' : '지울 가사가 없습니다');
});
lyricsSearchBackdrop.addEventListener('click', (e) => { if (e.target === lyricsSearchBackdrop) closeLyricsSearch(); });
document.getElementById('lyrics-search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  lyricsSearchStatus.textContent = '검색 중…';
  lyricsSearchResults.replaceChildren();
  let candidates = [];
  try {
    candidates = await window.lyricsOverlay.search({ title: lyricsSearchTitle.value, artist: lyricsSearchArtist.value });
  } catch {
    lyricsSearchStatus.textContent = '가사 검색에 실패했습니다.';
    return;
  }
  if (!candidates || candidates.length === 0) {
    lyricsSearchStatus.textContent = '가사를 찾지 못했습니다.';
    return;
  }
  lyricsSearchStatus.textContent = `${candidates.length}개 결과 — 클릭하면 현재 곡의 가사로 적용됩니다`;
  for (const candidate of candidates) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'lr-main';
    const title = document.createElement('div');
    title.className = 'lr-title';
    title.textContent = candidate.title || '(제목 없음)';
    const artist = document.createElement('div');
    artist.className = 'lr-artist';
    artist.textContent = candidate.artist || candidate.album || '';
    main.append(title, artist);
    const source = document.createElement('span');
    source.className = 'lr-source';
    source.textContent = `${LYRIC_SOURCE_LABELS[candidate.source] || candidate.source}${candidate.plain ? ' · 텍스트(자동 싱크)' : ' · 싱크'}${candidate.hasKorean ? ' · 한국어' : ' · 원어'}`;
    li.append(main, source);
    li.addEventListener('click', async () => {
      lyricsSearchStatus.textContent = '가사 적용 중…';
      const selected = await window.lyricsOverlay.select(candidate);
      if (selected) {
        closeLyricsSearch();
        showToast('가사를 적용했습니다');
      } else {
        lyricsSearchStatus.textContent = '가사를 불러오지 못했습니다.';
      }
    });
    lyricsSearchResults.append(li);
  }
});
new ResizeObserver(() => { if (lyricsViewOn) tickLyricsView(true); }).observe(lyricsViewport);
window.lyricsOverlay.onData((data) => {
  lyricsViewData = data;
  updateTranslatedBadges();
  if (lyricsKindEl.classList.contains('show')) paintLyricsKind();
  if (lyricsViewOn) renderLyricsView();
});
window.lyrics.getData().then((data) => {
  lyricsViewData = data;
  updateTranslatedBadges();
  if (lyricsViewOn) renderLyricsView();
}).catch(() => {});
document.getElementById('lo-prev').addEventListener('click', prevTrack);
document.getElementById('lo-next').addEventListener('click', nextTrack);
loPause.addEventListener('click', togglePlayback);

const adBlockToggle = document.getElementById('ls-adblock');
function paintAdBlockToggle() {
  adBlockToggle.checked = adEvasionEnabled;
}
adBlockToggle.addEventListener('change', () => {
  adEvasionEnabled = adBlockToggle.checked;
  adEnforcementSeen = !adEvasionEnabled; // 끈 상태 = 감지 이후와 같은 취급 (재시작해도 유지)
  if (adEvasionEnabled) {
    showToast('광고 차단을 다시 켰습니다 — 유튜브가 감지하면 재생이 막힐 수 있습니다 (앱 재시작 후 적용)');
  } else {
    window.winctl.disableAdBlock();
    fallbackView.executeJavaScript('window.__adEvade = false; 0').catch(() => {});
    if (adCssKey) { fallbackView.removeInsertedCSS(adCssKey).catch(() => {}); adCssKey = ''; }
  }
  saveSettings();
});

(async () => {
  const saved = await window.uiSettings.load();
  if (saved && saved.accent && saved.base && saved.panel) applyTheme(saved);
  else syncSettingsUI();
  if (saved && saved.volume != null) masterVolume = clampVolume(saved.volume);
  if (saved && saved.eq) loadEqState(saved.eq);
  pushAudio(); // 영상이 뜨기 전에 가드 상태를 먼저 맞춰 둔다
  // 한 번 광고 차단 감지에 걸린 적이 있으면 다음 실행부터는 처음부터 차단·조작을 하지 않는다
  // — 매 실행마다 다시 걸려 곡이 건너뛰어지는 일을 막는다.
  // (v1.30.0까지의 `adEnforced`는 숨겨진 DOM 요소를 보고 오탐한 값이라 무시하고 키를 새로 뒀다)
  if (saved && saved.adEnforcedV2) {
    adEnforcementSeen = true;
    adEvasionEnabled = false;
    window.winctl.disableAdBlock();
  }
  paintAdBlockToggle();
  precisePlaybackActive = !Number.isInteger(masterVolume) && !adEnforcementSeen;
  paintVolumeUI(); // 저장값이 없어도 슬라이더 채움 표시는 초기화 필요
  if (saved && saved.layout) layout = { ...DEFAULT_LAYOUT, ...saved.layout };
  applyLayout(); // 저장값이 없어도 핸들 버튼 아이콘은 그려야 한다
  applyLyricsView(saved && saved.lyricsView);
  playlists = normalizeItems(await window.store.load());
  renderList();
  fetchMissingMeta();
  initAccount(); // 저장된 세션 쿠키가 있으면 자동으로 계정 섹션 표시
})();
