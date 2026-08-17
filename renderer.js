let player = null;
let playerReady = false;
let pendingPlay = null; // 플레이어 준비 전에 들어온 재생 요청
let playlists = [];
let activeListId = null;
let editingItem = null; // 사이드바에서 이름/링크 수정 중인 항목
let dragItem = null; // 드래그 중인 사이드바 항목 (재생목록 또는 폴더)

// 자체 대기열: iframe 플레이어의 재생목록은 곡 삭제/순서 제어가 불가능하므로
// cuePlaylist로 곡 ID 목록만 얻어온 뒤, 재생은 곡 단위로 직접 제어한다.
let queue = [];
let queueIndex = -1;
let loadToken = 0;
let titleFetchInFlight = false;
const titleCache = new Map(); // videoId -> {title, author} | null
const fallbackIds = new Set(); // 임베드 차단 → 유튜브 워치페이지 직접 재생으로 전환된 곡
const unplayableIds = new Set(); // 직접 재생조차 불가(삭제/비공개 등) → 즉시 스킵
let watchdogTimer = null;
let fallbackActive = false;
let fallbackPollTimer = null;
let fallbackStall = 0;

const nameInput = document.getElementById('name-input');
const urlInput = document.getElementById('url-input');
const formError = document.getElementById('form-error');
const listEl = document.getElementById('playlist-list');
const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');
const placeholder = document.getElementById('player-placeholder');
const fallbackView = document.getElementById('fallback-view');
const nowPlaying = document.getElementById('now-playing');

const TRASH_SVG = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/></svg>';
// WSLg에는 이모지 폰트가 없어 tofu로 보이므로 아이콘은 전부 SVG 사용
const PENCIL_SVG = '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const CARET_SVG = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
const SHUFFLE_SVG = '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>';

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
    playerVars: { rel: 0, fs: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        if (pendingPlay) {
          const p = pendingPlay;
          pendingPlay = null;
          playPlaylist(p.listId, p.shuffle);
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

// ── 몰입 모드: 앱이 직접 관리하는 전체화면 (창 전체화면 + 사이드바 숨김) ──
// 유튜브 자체(요소) 전체화면은 소유자가 iframe/webview라 임베드↔폴백 전환 때 풀리기 쉽다.
// 그래서 임베드는 fs=0으로 버튼을 없애고 폴백은 CSS로 버튼을 숨겨, 전체화면 진입을
// 컨트롤 바의 앱 자체 버튼(몰입 모드)으로 일원화한다. 그 외 경로(워치페이지 단축키 등)로
// 요소 전체화면이 되더라도 아래 fullscreenchange 훅이 즉시 몰입 모드로 흡수한다.

const fsExitBtn = document.getElementById('fs-exit-btn');

function enterImmersive() {
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

// 몰입 모드에서 마우스가 2.5초간 멈추면 해제 버튼을 투명하게. 마우스가 iframe/webview 위에
// 있으면 DOM mousemove가 오지 않으므로, 커서 화면 좌표를 IPC로 폴링해 움직임을 감지한다.
let cursorWatchTimer = null;
let lastCursor = null;
let lastCursorMove = 0;

function startCursorWatch() {
  lastCursor = null;
  lastCursorMove = Date.now();
  fsExitBtn.classList.remove('idle');
  clearInterval(cursorWatchTimer);
  cursorWatchTimer = setInterval(async () => {
    let pt = null;
    try { pt = await window.winctl.cursor(); } catch {}
    if (!pt) return;
    if (!lastCursor || pt.x !== lastCursor.x || pt.y !== lastCursor.y) {
      lastCursor = pt;
      lastCursorMove = Date.now();
      fsExitBtn.classList.remove('idle');
    } else if (Date.now() - lastCursorMove > 2500) {
      fsExitBtn.classList.add('idle');
    }
  }, 500);
}

function stopCursorWatch() {
  clearInterval(cursorWatchTimer);
  fsExitBtn.classList.remove('idle');
}

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
  if (e.key === 'Escape' && document.body.classList.contains('immersive') && !document.fullscreenElement) {
    exitImmersive();
  } else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.altKey && !e.metaKey && e.target.tagName !== 'INPUT') {
    toggleImmersive(); // f: 전체화면 토글 (입력창 타이핑 중에는 무시)
  }
});

fsExitBtn.addEventListener('click', exitImmersive);
document.getElementById('fs-btn').addEventListener('click', toggleImmersive);
// 직접 재생(webview) 화면에서 누른 f — main이 before-input-event로 가로채 전달
window.winctl.onFsKey(() => toggleImmersive());

// ── 폴백 재생: 임베드가 차단된 곡을 앱 내장 브라우저 뷰(유튜브 워치페이지)로 재생 ──

function startFallback(id) {
  absorbElementFullscreen();
  fallbackActive = true;
  fallbackStall = 0;
  clearTimeout(watchdogTimer);
  try { player.stopVideo(); } catch {}
  placeholder.hidden = true;
  fallbackView.classList.add('active');
  fallbackView.src = `https://www.youtube.com/watch?v=${id}`;
  updateQueueHighlight();
  const info = titleCache.get(id);
  nowPlaying.textContent = '♪ ' + ((info && info.title) || id) + ' (직접 재생)';
  clearInterval(fallbackPollTimer);
  fallbackPollTimer = setInterval(() => pollFallback(id), 1000);
}

function stopFallback() {
  if (!fallbackActive) return;
  // 웹뷰가 요소 전체화면을 쥔 채 숨겨지면(display:none) 전체화면이 통째로 풀린다
  // → 숨기기 전에 몰입 모드로 전환해 전체화면을 이어간다 (폴백→임베드 전환 시 풀림 방지)
  absorbElementFullscreen();
  fallbackActive = false;
  clearInterval(fallbackPollTimer);
  fallbackView.classList.remove('active');
  fallbackView.src = 'about:blank';
}

// 종료/이탈 감지: 영상이 끝났거나 유튜브 자동재생으로 다른 영상에 넘어가면 다음 곡으로
async function pollFallback(id) {
  if (!fallbackActive || queue[queueIndex] !== id) return;
  let st = null;
  try {
    st = await fallbackView.executeJavaScript(
      "(() => { const v = document.querySelector('video'); const m = location.href.match(/[?&]v=([\\w-]{11})/); return { vid: m ? m[1] : null, ended: v ? v.ended : false, t: v ? v.currentTime : 0, d: v ? v.duration || 0 : 0, ad: !!document.querySelector('.ad-showing') }; })()"
    );
  } catch {}
  if (!st || (st.t === 0 && !st.d && !st.ad)) {
    // 워치페이지에서도 재생 시작 실패(삭제/비공개 등) → 10초 후 포기하고 스킵
    if (++fallbackStall >= 10) {
      stopFallback();
      unplayableIds.add(id);
      markUnplayable(id);
      nextTrack();
    }
    return;
  }
  fallbackStall = 0;
  // 광고 재생 중에는 종료 판정을 보류 (광고 종료를 곡 종료로 오인 방지)
  if (st.ad) return;
  if (st.ended || (st.vid && st.vid !== id)) {
    stopFallback();
    nextTrack();
  }
}

// 워치페이지의 페이지 요소(헤더/댓글/추천)와 광고 배너를 숨기고, 광고 자동 스킵을 주입
fallbackView.addEventListener('dom-ready', () => {
  fallbackView.insertCSS(`
    #masthead-container, #secondary, #below, ytd-comments, tp-yt-app-drawer { display: none !important; }
    #player-ads, #masthead-ad, ytd-ad-slot-renderer, .ytp-ad-overlay-container,
    ytd-mealbar-promo-renderer, yt-mealbar-promo-renderer { display: none !important; }
    .ytp-fullscreen-button { display: none !important; } /* 전체화면은 앱 버튼(몰입 모드)으로만 */
    .ad-showing .html5-main-video { visibility: hidden !important; } /* 광고 영상은 스킵될 때까지 화면에서 숨김 */
    /* 플레이어를 웹뷰 뷰포트 전체에 고정 — 페이지 배치 크기 때문에 몰입(전체화면) 시
       화면을 꽉 채우지 못하는 문제 해결. 크기 재계산은 주입 스크립트의 resize 디스패치가 유도 */
    #movie_player { position: fixed !important; top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important; z-index: 999; background: #000 !important; }
    ytd-app { background: #0f0f0f !important; }
    ytd-watch-flexy #columns, ytd-watch-flexy #primary { padding: 0 !important; margin: 0 !important; max-width: 100% !important; }
    ytd-watch-flexy #player { max-height: 100vh; }
    html, body { overflow: hidden !important; }
  `).catch(() => {});
  // 영상 광고: 감지 즉시 무음 + 16배속 + 끝으로 점프, 스킵 버튼 자동 클릭,
  // 프리미엄 팝업/일시정지 확인창 자동 처리. 100ms 주기로 돌아 광고 노출 시간을 최소화한다.
  fallbackView.executeJavaScript(`
    // 고정 배치된 플레이어에 맞춰 유튜브가 영상/컨트롤 크기를 다시 계산하도록 유도
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 1500);
    if (!window.__adSkipInstalled) {
      window.__adSkipInstalled = true;
      window.__adActive = false;
      setInterval(() => {
        const video = document.querySelector('video');
        const adShowing = !!document.querySelector('.ad-showing');
        if (adShowing && video) {
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
        const skips = document.querySelectorAll(
          '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, ' +
          '.ytp-ad-skip-button-slot button, .ytp-ad-skip-button-container button'
        );
        for (const btn of skips) btn.click();
        const dismiss = document.querySelector('ytd-mealbar-promo-renderer #dismiss-button button, yt-mealbar-promo-renderer #dismiss-button button');
        if (dismiss) dismiss.click();
        const cont = document.querySelector('yt-confirm-dialog-renderer #confirm-button button');
        if (cont) cont.click();
      }, 100);
    }
    0;
  `).catch(() => {});
});

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED) {
    nextTrack();
    return;
  }
  const data = player.getVideoData();
  if (data && data.title) nowPlaying.textContent = '♪ ' + data.title;
}

async function playPlaylist(listId, shuffle) {
  if (!playerReady) {
    pendingPlay = { listId, shuffle };
    placeholder.textContent = '플레이어 준비 중… 준비되면 자동으로 재생됩니다';
    return;
  }
  activeListId = listId;
  placeholder.hidden = true;
  const token = ++loadToken;
  renderList();
  queueCount.textContent = '(불러오는 중…)';

  // 첫 페이지(~100곡, 제목/아티스트 포함)만 받는 즉시 재생을 시작하고,
  // 나머지는 continuation을 백그라운드로 따라가며 대기열에 이어 붙인다 (전곡 완료를 기다리지 않음)
  let first = null;
  try {
    first = await window.playlist.fetchFirst(listId);
  } catch {}
  if (token !== loadToken) return;

  if (first && first.items.length > 0) {
    for (const it of first.items) {
      if (it.title) titleCache.set(it.id, { title: it.title, author: it.author || '' });
    }
    const firstVideoId = first.items[0].id;
    queue = first.items.map((it) => it.id);
    if (shuffle) shuffleArray(queue);
    queueIndex = 0;
    renderQueue();
    playCurrent();

    // 백그라운드 이어받기: 도착하는 대로 추가. 셔플 중이면 아직 안 들은 구간에 무작위 삽입.
    let total = first.items.length;
    let cont = first.cont;
    let guard = 50; // 무한 루프 방지 (최대 ~5000곡)
    while (cont && guard-- > 0) {
      queueCount.textContent = `(${total}곡 불러오는 중…)`;
      let more = null;
      try {
        more = await window.playlist.fetchMore(cont);
      } catch {}
      if (token !== loadToken) return; // 다른 재생목록이 시작됨 → 이어받기 중단
      if (!more) break;
      for (const it of more.items) {
        if (it.title) titleCache.set(it.id, { title: it.title, author: it.author || '' });
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

    // 전곡 확보 후 사이드바 썸네일/곡 수 최신화
    let metaChanged = false;
    for (const p of allPlaylistRefs()) {
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

function playCurrent() {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  const id = queue[queueIndex];
  if (unplayableIds.has(id)) {
    nextTrack();
    return;
  }
  if (fallbackIds.has(id)) {
    startFallback(id);
    return;
  }
  if (fallbackActive) stopFallback(); // 전체화면 전환은 stopFallback이 처리
  player.loadVideoById(id);
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
  nowPlaying.textContent = '재생 가능한 곡이 없습니다';
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
  queueCount.textContent = queue.length ? `(${queue.length}곡)` : '';
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
  li.title = '재생 불가 (삭제되었거나 비공개인 영상)';
}

function decorateFallback(li) {
  li.title = '임베드 차단 곡 — 유튜브 페이지로 직접 재생됩니다';
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

function canDrop(source, target) {
  if (!source) return false;
  if (target === null) return true; // 목록 빈 공간 → 루트(폴더 밖)로 이동
  if (source === target) return false;
  if (source.type === 'folder' && folderContains(source, target)) return false; // 자기 하위로 이동 불가
  if (target.type === 'folder') return true; // 재생목록 추가 또는 폴더 중첩
  return source.type !== 'folder'; // 폴더를 재생목록 위에 놓는 것은 불가
}

function performDrop(source, target) {
  if (!canDrop(source, target)) return;
  if (target === null) {
    removeItem(source);
    playlists.push(source);
  } else if (target.type === 'folder') {
    removeItem(source);
    target.items.push(source); // 재생목록 추가 또는 폴더 중첩(폴더 안 폴더)
    target.open = true;
  } else {
    const targetLoc = findLocation(target);
    if (targetLoc.folder) {
      // 폴더 안 재생목록 위에 놓음 → 그 폴더로 이동
      removeItem(source);
      targetLoc.folder.items.push(source);
    } else {
      // 재생목록 위에 재생목록 → 그 자리에 새 폴더로 묶고 바로 이름 입력
      removeItem(source);
      const loc = findLocation(target);
      const folder = { type: 'folder', name: '새 폴더', open: true, items: [target, source] };
      loc.arr.splice(loc.index, 1, folder);
      editingItem = folder;
    }
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

function makeDropTarget(li, target) {
  li.addEventListener('dragover', (e) => {
    if (!canDrop(dragItem, target)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    li.classList.add('drag-over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove('drag-over');
    performDrop(dragItem, target);
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
  if (depth) li.style.marginLeft = depth * 18 + 'px';
  if (pl.listId === activeListId) li.classList.add('active');
  if (editingItem === pl) {
    li.appendChild(buildEditForm(pl));
    return li;
  }
  makeDraggable(li, pl);
  makeDropTarget(li, pl);

  // 첫 곡 썸네일 + 곡 수 배지 (fetchMissingMeta가 채우기 전에는 빈 박스)
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'pl-thumb-wrap';
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
  thumbWrap.appendChild(thumb);
  if (pl.count != null) {
    const badge = document.createElement('span');
    badge.className = 'pl-count-badge';
    badge.textContent = `${pl.count}개`;
    badge.title = `동영상 ${pl.count}개`;
    thumbWrap.appendChild(badge);
  }

  const name = document.createElement('span');
  name.className = 'pl-name';
  name.textContent = pl.name;
  name.title = pl.url;

  const shuffleBtn = iconButton(SHUFFLE_SVG, '셔플 재생', () => playPlaylist(pl.listId, true));
  const editBtn = iconButton(PENCIL_SVG, '이름/링크 수정', () => {
    editingItem = pl;
    renderList();
  });
  const deleteBtn = iconButton(TRASH_SVG, '삭제', () => {
    removeItem(pl);
    persistAndRender();
  });

  li.append(thumbWrap, name, shuffleBtn, editBtn, deleteBtn);
  li.title = '클릭하여 재생';
  li.onclick = () => playPlaylist(pl.listId, false);
  return li;
}

function buildFolderRow(folder, depth) {
  const li = document.createElement('li');
  li.classList.add('folder-row');
  if (depth) li.style.marginLeft = depth * 18 + 'px';
  if (editingItem === folder) {
    li.appendChild(buildEditForm(folder));
    return li;
  }
  makeDraggable(li, folder);
  makeDropTarget(li, folder);

  const caret = document.createElement('span');
  caret.className = 'pl-caret' + (folder.open ? ' open' : '');
  caret.innerHTML = CARET_SVG;

  const icon = document.createElement('span');
  icon.className = 'pl-folder-icon';
  icon.innerHTML = FOLDER_SVG;

  const name = document.createElement('span');
  name.className = 'pl-name';
  name.textContent = folder.name;

  const count = document.createElement('span');
  count.className = 'pl-count';
  count.textContent = folder.items.length;

  const editBtn = iconButton(PENCIL_SVG, '폴더 이름 수정', () => {
    editingItem = folder;
    renderList();
  });
  const deleteBtn = iconButton(TRASH_SVG, '폴더 삭제 (안의 항목은 한 단계 밖으로 이동)', () => {
    const loc = findLocation(folder);
    loc.arr.splice(loc.index, 1, ...folder.items); // 폴더 자리를 안의 항목들로 대체
    persistAndRender();
  });

  li.append(caret, icon, name, count, editBtn, deleteBtn);
  li.style.cursor = 'pointer';
  li.title = '클릭하여 접기/펼치기 · 재생목록이나 폴더를 여기로 드래그하면 폴더 안에 들어갑니다';
  li.onclick = () => {
    folder.open = !folder.open;
    persistAndRender();
  };
  return li;
}

function buildEmptyFolderHint(folder, depth) {
  const li = document.createElement('li');
  li.className = 'folder-empty';
  li.style.marginLeft = depth * 18 + 'px';
  li.textContent = '비어 있음 — 재생목록을 여기로 드래그';
  makeDropTarget(li, folder);
  return li;
}

function renderList() {
  listEl.innerHTML = '';
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

document.getElementById('new-folder-btn').addEventListener('click', () => {
  const folder = { type: 'folder', name: '새 폴더', open: true, items: [] };
  playlists.push(folder);
  editingItem = folder; // 만들자마자 이름 입력
  persistAndRender();
});

document.getElementById('play-now-btn').addEventListener('click', () => {
  const listId = extractListId(urlInput.value.trim());
  if (!listId) return showError('유효한 재생목록 링크가 아닙니다 (list= 파라미터 필요)');
  showError('');
  playPlaylist(listId, false);
});

document.getElementById('prev-btn').addEventListener('click', prevTrack);
document.getElementById('next-btn').addEventListener('click', nextTrack);
document.getElementById('shuffle-btn').addEventListener('click', reshuffleQueue);

(async () => {
  playlists = normalizeItems(await window.store.load());
  renderList();
  fetchMissingMeta();
})();
