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
let stallTimer = null; // 임베드가 버퍼링(state 3)에서 진행 없이 멈춘 경우의 2차 워치독
let fallbackActive = false;
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
const fallbackView = document.getElementById('fallback-view');
const npThumb = document.getElementById('np-thumb');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const npBadge = document.getElementById('np-badge');

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
  if (e.key === 'Escape' && !settingsBackdrop.hidden) {
    closeSettings();
  } else if (e.key === 'Escape' && !searchPanel.hidden) {
    closeSearchPanel();
  } else if (e.key === 'Escape' && document.body.classList.contains('immersive') && !document.fullscreenElement) {
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
  clearTimeout(stallTimer);
  try { player.stopVideo(); } catch {}
  placeholder.hidden = true;
  fallbackView.classList.add('active');
  fallbackView.src = `https://www.youtube.com/watch?v=${id}`;
  updateQueueHighlight();
  const info = titleCache.get(id);
  setNowPlaying(id, (info && info.title) || id, (info && info.author) || '', true);
  clearInterval(fallbackPollTimer);
  fallbackPollTimer = setInterval(() => pollFallback(id), 1000);
  clearInterval(skipPollTimer);
  skipPollTimer = setInterval(pollSkipClick, 300);
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
}

// 광고 스킵 버튼 네이티브 클릭: 주입 스크립트의 click()이 신뢰되지 않은 이벤트라 무시되는
// 경우를 대비해, 주입 스크립트가 남긴 버튼 좌표(__skipRect)를 소비해 main이 실제 마우스
// 입력을 보낸다. 클릭 직전 elementFromPoint로 그 자리가 여전히 스킵 버튼인지 재검증해
// 좌표가 낡았을 때의 오클릭(영상 일시정지 등)을 방지한다.
async function pollSkipClick() {
  if (!fallbackActive) return;
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
    /* 광고 차단 감지 팝업("광고 차단 프로그램은 허용되지 않습니다")은 주입 스크립트가
       자동으로 닫고 재생을 재개한다 — 닫히기 전까지는 화면에서 숨김 */
    tp-yt-paper-dialog:has(ytd-enforcement-message-view-renderer) { opacity: 0 !important; }
    tp-yt-iron-overlay-backdrop { display: none !important; }
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
        // 스킵 버튼: 클래스는 자주 바뀌므로 텍스트/aria-label('건너뛰기'/'Skip')로도 찾는다.
        // 전면 스폰서 카드(인터스티셜)는 영상이 없어 배속/점프가 안 통하므로 버튼 클릭이 유일한 길.
        // 페이지 내 click()은 유튜브가 신뢰되지 않은 이벤트로 무시할 수 있어, 좌표를
        // __skipRect에 남겨 호스트가 네이티브 입력(sendInputEvent)으로도 클릭한다.
        const cands = new Set(document.querySelectorAll(
          '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, ' +
          '.ytp-ad-skip-button-slot button, .ytp-ad-skip-button-container button'
        ));
        for (const b of document.querySelectorAll('#movie_player button, #movie_player [role="button"]')) {
          const label = (b.textContent || '') + (b.getAttribute('aria-label') || '');
          if (label.includes('건너뛰기') || /skip ?ads?/i.test(label) || /^\\s*skip\\s*$/i.test(label)) cands.add(b);
        }
        window.__skipRect = null;
        for (const btn of cands) {
          const r = btn.getBoundingClientRect();
          if (!window.__skipRect && r.width > 0 && r.height > 0) {
            window.__skipRect = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          btn.click();
        }
        const dismiss = document.querySelector('ytd-mealbar-promo-renderer #dismiss-button button, yt-mealbar-promo-renderer #dismiss-button button');
        if (dismiss) dismiss.click();
        const cont = document.querySelector('yt-confirm-dialog-renderer #confirm-button button');
        if (cont) cont.click();
        // 광고 차단 감지 팝업: 재생을 멈추므로 닫기 버튼을 눌러 해제하고, 닫힌 직후 재생 재개
        const enf = document.querySelector('ytd-enforcement-message-view-renderer');
        if (enf) {
          const dlg = enf.closest('tp-yt-paper-dialog') || enf;
          const closeBtn = dlg.querySelector('#dismiss-button button, #close-button button, [aria-label*="닫기"], [aria-label*="Close"]');
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
});

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED) {
    nextTrack();
    return;
  }
  // 폴백 재생 중에는 iframe의 잔여 상태 변화(stopVideo 등)가 재생 바 표시를 덮어쓰지 않도록
  if (fallbackActive) return;
  const data = player.getVideoData();
  if (data && data.title) setNowPlaying(data.video_id || queue[queueIndex], data.title, data.author || '');
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
  queueCount.textContent = '불러오는 중…';

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
      queueCount.textContent = `${total}곡 불러오는 중…`;
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

function playCurrent() {
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
}

function saveTheme() {
  window.uiSettings.save(theme);
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
    saveTheme();
  };
  document.getElementById('theme-presets').appendChild(btn);
}

for (const [key, input] of Object.entries(colorInputs)) {
  input.addEventListener('input', () => applyTheme({ ...theme, [key]: input.value })); // 실시간 미리보기
  input.addEventListener('change', saveTheme); // 색 선택을 마쳤을 때만 저장
}

function openSettings() {
  syncSettingsUI();
  settingsBackdrop.hidden = false;
}

function closeSettings() {
  settingsBackdrop.hidden = true;
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-reset').addEventListener('click', () => {
  applyTheme(DEFAULT_THEME);
  saveTheme();
});
settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === settingsBackdrop) closeSettings();
});

// ── 구글 계정 연동: 게스트 모드(기본) ↔ 로그인 시 계정 재생목록 섹션 표시 ──
// 계정 재생목록은 유튜브 계정이 원본이므로 playlists.json에 저장하지 않고
// 실행/로그인 때마다 새로 불러온다. 로컬(게스트) 목록은 로그인과 무관하게 유지.

// 주의: 'account'는 preload의 contextBridge 전역(window.account)과 이름이 겹치면
// SyntaxError가 나므로 상태 변수는 accountState로 둔다.
let accountState = { loggedIn: false, name: '', photo: '' };
let accountPlaylists = [];
let accountOpen = true;
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

  const shuffleBtn = iconButton(SHUFFLE_SVG, '셔플 재생', () => playPlaylist(pl.listId, true));
  li.append(thumb, meta, shuffleBtn);
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
  li.title = '클릭하여 재생 · 우클릭으로 더 보기';
  li.onclick = () => playPlaylist(pl.listId, false);
  li.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const entries = [
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
document.getElementById('shuffle-btn').addEventListener('click', reshuffleQueue);

(async () => {
  const savedTheme = await window.uiSettings.load();
  if (savedTheme && savedTheme.accent && savedTheme.base && savedTheme.panel) applyTheme(savedTheme);
  else syncSettingsUI();
  playlists = normalizeItems(await window.store.load());
  renderList();
  fetchMissingMeta();
  initAccount(); // 저장된 세션 쿠키가 있으면 자동으로 계정 섹션 표시
})();
