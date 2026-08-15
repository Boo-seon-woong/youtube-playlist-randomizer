let player = null;
let playerReady = false;
let pendingPlay = null; // 플레이어 준비 전에 들어온 재생 요청
let playlists = [];
let activeListId = null;

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
    playerVars: { rel: 0 },
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

// ── 몰입 모드: 전체화면 시청 중 임베드↔폴백 전환이 일어나면
// 요소 전체화면(전환 시 화면을 점유한 채 남음) 대신 창 전체화면 + 사이드바 숨김으로 이어간다 ──

function enterImmersive() {
  document.body.classList.add('immersive');
  window.winctl.setFullScreen(true);
}

function exitImmersive() {
  document.body.classList.remove('immersive');
  window.winctl.setFullScreen(false);
}

function handleModeSwitchFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    if (!document.body.classList.contains('immersive')) enterImmersive();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('immersive') && !document.fullscreenElement) {
    exitImmersive();
  }
});

document.getElementById('fs-exit-btn').addEventListener('click', exitImmersive);

// ── 폴백 재생: 임베드가 차단된 곡을 앱 내장 브라우저 뷰(유튜브 워치페이지)로 재생 ──

function startFallback(id) {
  handleModeSwitchFullscreen();
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
    ytd-app { background: #0f0f0f !important; }
    ytd-watch-flexy #columns, ytd-watch-flexy #primary { padding: 0 !important; margin: 0 !important; max-width: 100% !important; }
    ytd-watch-flexy #player { max-height: 100vh; }
    html, body { overflow: hidden !important; }
  `).catch(() => {});
  // 영상 광고: 감지 즉시 무음 + 끝으로 점프, 스킵 버튼 자동 클릭, 프리미엄 팝업/일시정지 확인창 자동 처리
  fallbackView.executeJavaScript(`
    if (!window.__adSkipInstalled) {
      window.__adSkipInstalled = true;
      window.__adMuted = false;
      setInterval(() => {
        const video = document.querySelector('video');
        const adShowing = !!document.querySelector('.ad-showing');
        if (adShowing && video) {
          if (!video.muted) { video.muted = true; window.__adMuted = true; }
          if (isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
        } else if (window.__adMuted && video) {
          video.muted = false;
          window.__adMuted = false;
        }
        for (const sel of ['.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern']) {
          const btn = document.querySelector(sel);
          if (btn) btn.click();
        }
        const dismiss = document.querySelector('ytd-mealbar-promo-renderer #dismiss-button button, yt-mealbar-promo-renderer #dismiss-button button');
        if (dismiss) dismiss.click();
        const cont = document.querySelector('yt-confirm-dialog-renderer #confirm-button button');
        if (cont) cont.click();
      }, 300);
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

  // 전곡 수집(200곡 제한 없음) + 제목/아티스트 동시 확보
  let items = null;
  try {
    items = await window.playlist.fetch(listId);
  } catch {}
  if (token !== loadToken) return;

  if (items && items.length > 0) {
    for (const it of items) {
      if (it.title) titleCache.set(it.id, { title: it.title, author: it.author || '' });
    }
    queue = items.map((it) => it.id);
    if (shuffle) shuffleArray(queue);
    queueIndex = 0;
    renderQueue();
    playCurrent();
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
  if (fallbackActive) {
    handleModeSwitchFullscreen();
    stopFallback();
  }
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

function renderList() {
  listEl.innerHTML = '';
  playlists.forEach((pl, index) => {
    const li = document.createElement('li');
    if (pl.listId === activeListId) li.classList.add('active');

    const name = document.createElement('span');
    name.className = 'pl-name';
    name.textContent = pl.name;
    name.title = pl.url;
    name.style.cursor = 'pointer';
    name.onclick = () => playPlaylist(pl.listId, false);

    const playBtn = document.createElement('button');
    playBtn.textContent = '재생';
    playBtn.onclick = () => playPlaylist(pl.listId, false);

    const shuffleBtn = document.createElement('button');
    shuffleBtn.textContent = '셔플';
    shuffleBtn.onclick = () => playPlaylist(pl.listId, true);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '삭제';
    deleteBtn.onclick = async () => {
      playlists.splice(index, 1);
      await window.store.save(playlists);
      renderList();
    };

    li.append(name, playBtn, shuffleBtn, deleteBtn);
    listEl.appendChild(li);
  });
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
  playlists.push({ name, url, listId });
  await window.store.save(playlists);
  nameInput.value = '';
  urlInput.value = '';
  renderList();
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
  playlists = (await window.store.load()) || [];
  renderList();
})();
