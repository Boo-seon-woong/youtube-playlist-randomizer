let playback = { id: '', title: '', artist: '', status: 'idle', progress: 0, duration: 0, coverUrl: '', volume: 100 };
let lyricData = null;
let lyricsSettings = {
  width: 760, height: 240, backgroundOpacity: 94, uiOpacity: 100, fontSize: 16,
  showProgressBar: true, showPlaybackControls: true,
  showPreviousButton: true, showPauseButton: true, showNextButton: true, showVolumeButton: true,
  showTrackInfo: true, coverMode: 'art', videoFit: 'cover', fontFamily: 'default', showStatus: true, alwaysOnTop: true, clickThrough: false,
};

// 가사 글꼴 후보 (main의 LYRIC_FONTS와 같은 키) — 웹폰트가 안 받아지면 시스템 글꼴로 대체
const LYRIC_FONT_STACKS = {
  default: '"Pretendard", "Segoe UI", sans-serif',
  'noto-sans': '"Noto Sans KR", "Pretendard", sans-serif',
  'noto-serif': '"Noto Serif KR", "Batang", serif',
  'nanum-myeongjo': '"Nanum Myeongjo", "Batang", serif',
  'gowun-batang': '"Gowun Batang", "Batang", serif',
  'gowun-dodum': '"Gowun Dodum", "Pretendard", sans-serif',
  'ibm-plex': '"IBM Plex Sans KR", "Segoe UI", sans-serif',
};
let receivedAt = performance.now();
let panelMode = '';
let volumeDragging = false; // 슬라이더를 잡고 있는 동안은 메인에서 오는 볼륨 값으로 덮어쓰지 않는다
let hitCount = 0; // 커서가 올라가 있는 상호작용 요소 수
let hitSent = null; // main에 마지막으로 보낸 히트 상태 (같은 값은 다시 보내지 않는다 — mousemove마다 호출되므로)
function sendHit(flag) {
  if (hitSent === flag) return;
  hitSent = flag;
  window.lyricsOverlay.setHit(flag);
}
let draggingWindow = false; // 앨범/영상 박스를 잡고 창을 옮기는 중

const card = document.getElementById('lyrics-card');
const sideEl = document.getElementById('lyrics-side');
const coverBox = document.getElementById('lyrics-cover-box');
const cover = document.getElementById('lyrics-cover');
const videoWrap = document.getElementById('lyrics-video-wrap');
const title = document.getElementById('lyrics-title');
const artist = document.getElementById('lyrics-artist');
const linesEl = document.getElementById('lyrics-lines');
const statusEl = document.getElementById('lyrics-status');
const progressRow = document.getElementById('lyrics-progress-row');
const progressTrack = document.getElementById('lyrics-progress-track');
const elapsedEl = document.getElementById('lyrics-elapsed');
const durationEl = document.getElementById('lyrics-duration');
const progressFill = document.getElementById('lyrics-progress-fill');
const playbackControls = document.getElementById('lyrics-playback-controls');
const previousButton = document.getElementById('lyrics-previous');
const pauseButton = document.getElementById('lyrics-pause');
const nextButton = document.getElementById('lyrics-next');
const volumeButton = document.getElementById('lyrics-volume');
const volumePop = document.getElementById('lyrics-volume-pop');
const volumeSlider = document.getElementById('lyrics-volume-slider');
const volumeValue = document.getElementById('lyrics-volume-value');
const searchPanel = document.getElementById('lyrics-search-panel');
const searchForm = document.getElementById('lyrics-search-form');
const searchTitle = document.getElementById('lyrics-search-title');
const searchArtist = document.getElementById('lyrics-search-artist');
const searchStatus = document.getElementById('lyrics-search-status');
const searchResults = document.getElementById('lyrics-search-results');

// 단축키(Alt+Y)로 잠금이 바뀐 것을 창에서 바로 알 수 있게 잠깐 띄우는 알림
let lockStateKnown = false;
let flashTimer = null;

function flashMessage(text) {
  const el = document.getElementById('lyrics-flash');
  el.textContent = text;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth; // 애니메이션 재시작
  el.style.animation = '';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 1600);
}

function applyLyricsSettings(next) {
  const wasLocked = lyricsSettings.clickThrough;
  lyricsSettings = { ...lyricsSettings, ...(next || {}) };
  if (lyricsSettings.clickThrough !== wasLocked) hitSent = null; // main이 히트 상태를 새로 잡았으니 다시 보낸다
  if (lockStateKnown && lyricsSettings.clickThrough !== wasLocked) {
    flashMessage(lyricsSettings.clickThrough ? '🔒 클릭 통과 ON · 게임으로 복귀' : '🔓 클릭 통과 OFF · 가사 창 조작');
  }
  lockStateKnown = true;
  const opacity = Math.max(0, Math.min(100, Number(lyricsSettings.backgroundOpacity) || 0)) / 100;
  document.documentElement.style.setProperty('--lyrics-bg', `rgba(24, 25, 31, ${opacity})`);
  document.documentElement.style.setProperty('--lyrics-bg-2', `rgba(24, 25, 31, ${Math.max(0, opacity * 0.85)})`);
  document.documentElement.style.setProperty('--ui-opacity', String(Math.max(0, Math.min(100, Number(lyricsSettings.uiOpacity) || 0)) / 100));
  document.documentElement.style.setProperty('--lyrics-font-size', `${lyricsSettings.fontSize}px`);
  document.documentElement.style.setProperty('--lyrics-font', LYRIC_FONT_STACKS[lyricsSettings.fontFamily] || LYRIC_FONT_STACKS.default);
  progressRow.hidden = !lyricsSettings.showProgressBar;
  previousButton.hidden = !lyricsSettings.showPreviousButton;
  pauseButton.hidden = !lyricsSettings.showPauseButton;
  nextButton.hidden = !lyricsSettings.showNextButton;
  volumeButton.hidden = !lyricsSettings.showVolumeButton;
  playbackControls.hidden = !lyricsSettings.showPlaybackControls
    || (previousButton.hidden && pauseButton.hidden && nextButton.hidden && volumeButton.hidden);
  if (volumeButton.hidden || playbackControls.hidden) closeVolumePop();
  document.getElementById('lyrics-track').hidden = !lyricsSettings.showTrackInfo;
  statusEl.hidden = !lyricsSettings.showStatus;
  // 잠금(클릭 통과) 중에는 눌리지 않는 버튼을 아예 감춰 눌러도 되는 것처럼 보이지 않게 한다
  document.body.classList.toggle('locked', !!lyricsSettings.clickThrough);
  // 왼쪽 열: 사각형(앨범/영상)은 창 높이에서 여백·재생바·컨트롤 높이를 뺀 크기 (예시 디자인처럼 세로를 꽉 채움)
  const coverSize = Math.max(80, Math.min(220,
    lyricsSettings.height - 16 - (progressRow.hidden ? 0 : 22) - (playbackControls.hidden ? 0 : 34)));
  document.documentElement.style.setProperty('--cover-size', `${coverSize}px`);
  coverBox.hidden = lyricsSettings.coverMode === 'none';
  // 영상 맞춤: cover면 정사각형을 세로 기준으로 가득 채우고 좌우가 잘린다 (iframe을 16:9로 넓혀 가운데 정렬)
  document.body.classList.toggle('video-cover', lyricsSettings.videoFit !== 'contain');
  sideEl.hidden = coverBox.hidden && progressRow.hidden && playbackControls.hidden;
  ensureMiniVideo();
  render();
}

function openPanel(mode) {
  panelMode = mode;
  card.hidden = true;
  searchPanel.hidden = mode !== 'search';
}

function currentProgress() {
  if (playback.status !== 'playing') return playback.progress;
  return Math.min(playback.duration || Infinity, playback.progress + performance.now() - receivedAt);
}

function currentIndex(progress) {
  if (!lyricData || !lyricData.lines || lyricData.lines.length === 0) return -1;
  let index = -1;
  for (let i = 0; i < lyricData.lines.length; i += 1) {
    if (lyricData.lines[i].time <= progress + 225) index = i;
    else break;
  }
  return index;
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// 한 블록 = 같은 시각의 줄 묶음(원문·발음·번역). 줄마다 칩 배경을 두른다.
function lineElement(line, className) {
  const el = document.createElement('div');
  el.className = `lyric-block ${className}${line ? '' : ' empty'}`;
  for (const text of (line ? String(line.text).split('\n') : ['♪'])) {
    const chip = document.createElement('span');
    chip.className = 'lyric-chip';
    chip.textContent = text;
    el.append(chip);
  }
  return el;
}

// ── 영상 작게 표시: 메인 창과 같은 곡을 음소거로 따라가는 미러 임베드 ──
// 메인 창의 영상은 교차 출처 iframe/webview 안에 있어 프레임을 가져올 수 없으므로 두 번째 임베드를 쓴다.
// 임베드가 차단된 곡(에러 150 등)은 앨범 이미지로 되돌린다.
let mini = null;
let miniReady = false;
let miniId = '';
let miniApiLoading = false;
let miniLastError = null;
const miniBlocked = new Set();

function ensureMiniVideo() {
  if (lyricsSettings.coverMode !== 'video') {
    if (mini) {
      try { mini.destroy(); } catch {}
      mini = null;
      miniReady = false;
      miniId = '';
      const holder = document.createElement('div');
      holder.id = 'lyrics-video';
      videoWrap.prepend(holder);
    }
    return;
  }
  if (mini || miniApiLoading) return;
  if (!window.YT || !window.YT.Player) {
    miniApiLoading = true;
    window.onYouTubeIframeAPIReady = () => { miniApiLoading = false; ensureMiniVideo(); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.append(script);
    return;
  }
  mini = new YT.Player('lyrics-video', {
    width: '100%',
    height: '100%',
    playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, mute: 1, playsinline: 1, iv_load_policy: 3, modestbranding: 1, origin: location.origin },
    events: {
      onReady: () => {
        miniReady = true;
        try { mini.mute(); mini.setVolume(0); } catch {}
        try { window.appinfo.refreshEmbedChrome(); } catch {} // 유튜브 자체 UI 제거 (메인 창과 동일 처리)
      },
      onError: (event) => {
        miniLastError = event && event.data;
        if (miniId) miniBlocked.add(miniId);
        miniId = '';
        try { mini.stopVideo(); } catch {}
      },
    },
  });
}

function miniLive() {
  return !!(mini && miniReady && playback.id && miniId === playback.id && !miniBlocked.has(playback.id));
}

function syncMiniVideo() {
  if (!mini || !miniReady) return;
  const id = playback.id;
  if (!id || miniBlocked.has(id) || playback.status === 'idle') {
    if (miniId) { miniId = ''; try { mini.stopVideo(); } catch {} }
    return;
  }
  const target = currentProgress() / 1000;
  if (miniId !== id) {
    miniId = id;
    try { mini.loadVideoById({ videoId: id, startSeconds: target }); mini.mute(); } catch {}
    try { window.appinfo.refreshEmbedChrome(); } catch {} // 곡이 바뀔 때도 다시 심는다
    return;
  }
  let state = -1;
  let time = 0;
  try { state = mini.getPlayerState(); time = mini.getCurrentTime(); } catch {}
  const drifted = Math.abs(time - target) > 1.2;
  if (playback.status === 'playing') {
    if (drifted) try { mini.seekTo(target, true); } catch {}
    if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) try { mini.playVideo(); } catch {}
  } else {
    if (state === YT.PlayerState.PLAYING) try { mini.pauseVideo(); } catch {}
    if (drifted) try { mini.seekTo(target, true); } catch {}
  }
}

function render() {
  // 가사를 찾았으면 유튜브 제목 대신 가사 DB의 곡명·아티스트를 보여준다
  const matched = lyricData && !lyricData.unavailable && lyricData.title;
  title.textContent = matched ? lyricData.title : (playback.title || '');
  artist.textContent = matched ? (lyricData.artist || playback.artist || '') : (playback.artist || '');
  if (cover.dataset.src !== (playback.coverUrl || '')) {
    cover.dataset.src = playback.coverUrl || '';
    cover.src = playback.coverUrl || '';
  }
  const live = miniLive();
  videoWrap.hidden = !live;
  cover.hidden = !playback.coverUrl || lyricsSettings.coverMode === 'none' || live;
  card.classList.toggle('paused', playback.status === 'paused');
  const progress = currentProgress();
  elapsedEl.textContent = formatTime(progress);
  durationEl.textContent = formatTime(playback.duration);
  progressFill.style.width = playback.duration > 0 ? `${Math.min(100, Math.max(0, progress / playback.duration * 100))}%` : '0%';
  pauseButton.textContent = playback.status === 'playing' ? 'Ⅱ' : '▶';
  pauseButton.title = playback.status === 'playing' ? '일시정지' : '재생';
  if (!volumeDragging) {
    volumeSlider.value = Math.round(playback.volume);
    volumeValue.textContent = String(Math.round(playback.volume));
  }

  linesEl.replaceChildren();
  const index = currentIndex(progress);
  if (index < 0) {
    linesEl.append(lineElement(null, 'current'));
    statusEl.textContent = lyricData && lyricData.unavailable
      ? '가사를 찾지 못했습니다.'
      : lyricData ? '가사 시작 전' : (playback.status === 'idle' ? '' : '가사를 찾는 중…');
    return;
  }
  linesEl.append(
    lineElement(lyricData.lines[index - 1], 'previous'),
    lineElement(lyricData.lines[index], 'current'),
    lineElement(lyricData.lines[index + 1], 'next'),
  );
  const language = lyricData.language === 'ko' ? '한국어' : (lyricData.fallbackNotice || '원어');
  const state = playback.status === 'paused' ? '일시정지' : '';
  statusEl.textContent = lyricData.source ? [lyricData.source.toUpperCase(), language, state].filter(Boolean).join(' · ') : '';
}

function animate() {
  if (!panelMode) render();
  requestAnimationFrame(animate);
}

// 미러 동기화는 rAF가 아니라 인터벌로 — 창이 가려져 rAF가 멈춰도 곡 전환·시킹을 따라간다
setInterval(() => { if (!panelMode) syncMiniVideo(); }, 500);

// ── 재생바 클릭 → 곡의 해당 지점으로 이동 (메인 창이 seek 수행) ──
progressTrack.addEventListener('click', (event) => {
  if (!playback.duration) return;
  const rect = progressTrack.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  playback = { ...playback, progress: fraction * playback.duration };
  receivedAt = performance.now();
  window.lyricsOverlay.control('seek', fraction);
});

// ── 볼륨: 버튼으로 슬라이더 팝오버를 열고, 값은 앱 마스터 볼륨으로 전달 ──

function closeVolumePop() {
  volumePop.hidden = true;
  volumeButton.classList.remove('open');
}

volumeButton.addEventListener('click', () => {
  volumePop.hidden = !volumePop.hidden;
  volumeButton.classList.toggle('open', !volumePop.hidden);
});
volumeSlider.addEventListener('pointerdown', () => { volumeDragging = true; });
volumeSlider.addEventListener('input', () => {
  volumeValue.textContent = volumeSlider.value;
  playback = { ...playback, volume: Number(volumeSlider.value) };
  window.lyricsOverlay.control('volume', Number(volumeSlider.value));
});
volumeSlider.addEventListener('change', () => {
  volumeDragging = false;
  window.lyricsOverlay.control('volume-save', Number(volumeSlider.value)); // 조작을 마쳤을 때만 저장
});
volumeSlider.addEventListener('pointerup', () => { volumeDragging = false; });

async function showSearch() {
  openPanel('search');
  let parsed = { title: playback.title || '', artist: playback.artist || '' };
  try { parsed = await window.lyricsOverlay.parse(parsed); } catch {} // 정제된 제목/아티스트를 기본값으로
  searchTitle.value = parsed.title || '';
  searchArtist.value = parsed.artist || '';
  searchStatus.textContent = '';
  searchResults.replaceChildren();
  searchTitle.focus();
}

function hideSearch() {
  closePanel();
}

function closePanel() {
  panelMode = '';
  searchPanel.hidden = true;
  card.hidden = false;
  render();
}

async function searchLyrics(event) {
  event.preventDefault();
  searchStatus.textContent = '검색 중…';
  searchResults.replaceChildren();
  try {
    const candidates = await window.lyricsOverlay.search({ title: searchTitle.value, artist: searchArtist.value });
    if (!candidates || candidates.length === 0) {
      searchStatus.textContent = '동기화된 가사를 찾지 못했습니다.';
      return;
    }
    searchStatus.textContent = `${candidates.length}개 결과`;
    for (const candidate of candidates) {
      const item = document.createElement('li');
      item.className = 'lyrics-result';
      item.innerHTML = `<div class="lyrics-result-main"><div class="lyrics-result-title"></div><div class="lyrics-result-artist"></div></div><span class="lyrics-result-source"></span>`;
      item.querySelector('.lyrics-result-title').textContent = candidate.title || '(제목 없음)';
      item.querySelector('.lyrics-result-artist').textContent = candidate.artist || candidate.album || '';
      item.querySelector('.lyrics-result-source').textContent = `${candidate.source}${candidate.hasKorean ? ' · 한국어' : ' · 원어'}`;
      item.addEventListener('click', async () => {
        searchStatus.textContent = '가사 적용 중…';
        const selected = await window.lyricsOverlay.select(candidate);
        if (selected) hideSearch();
        else searchStatus.textContent = '가사를 불러오지 못했습니다.';
      });
      searchResults.append(item);
    }
  } catch {
    searchStatus.textContent = '가사 검색에 실패했습니다.';
  }
}

window.lyricsOverlay.onState((next) => {
  const changed = playback.id !== next.id || playback.title !== next.title || playback.artist !== next.artist;
  playback = next;
  receivedAt = performance.now();
  if (changed) lyricData = null;
  render();
});

window.lyricsOverlay.onData((next) => {
  lyricData = next;
  render();
});

document.getElementById('lyrics-search').addEventListener('click', showSearch);
document.getElementById('lyrics-retry').addEventListener('click', () => window.lyricsOverlay.retry());
document.getElementById('lyrics-hide').addEventListener('click', () => window.lyricsOverlay.hide());
document.getElementById('lyrics-search-close').addEventListener('click', hideSearch);
document.getElementById('lyrics-settings').addEventListener('click', () => window.lyricsOverlay.openSettings());
previousButton.addEventListener('click', () => window.lyricsOverlay.control('previous'));
pauseButton.addEventListener('click', () => window.lyricsOverlay.control('toggle-play'));
nextButton.addEventListener('click', () => window.lyricsOverlay.control('next'));
searchForm.addEventListener('submit', searchLyrics);

// 창 이동: 앨범/영상 박스를 누르는 동안 main이 커서를 따라 창을 옮긴다 (-webkit-app-region은 히트박스 모드와 충돌)
coverBox.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  try { coverBox.setPointerCapture(e.pointerId); } catch {}
  draggingWindow = true;
  sendHit(true); // 히트 알림이 아직 안 갔더라도 드래그 동안은 확실히 받게
  window.lyricsOverlay.drag(true);
});
const endDrag = () => {
  if (!draggingWindow) return;
  draggingWindow = false;
  window.lyricsOverlay.drag(false);
  if (hitCount === 0) sendHit(false); // 드래그 중 밖으로 나갔던 커서 상태를 정리
};
coverBox.addEventListener('pointerup', endDrag);
coverBox.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);

// 3) 메인 앱 테마 색 적용 (재생바·볼륨 슬라이더·컨트롤 hover)
const applyAppTheme = (theme) => {
  if (theme && theme.accent) document.documentElement.style.setProperty('--accent', theme.accent);
};
window.lyricsOverlay.onTheme(applyAppTheme);
window.lyricsOverlay.getTheme().then(applyAppTheme).catch(() => {});

// 마우스 히트박스: 상호작용 요소(.hit) 위에 커서가 있을 때만 창이 마우스를 받도록 main에 알린다.
// 창은 평소 forward 모드로 마우스를 무시하므로 mouseenter/leave는 그대로 들어온다.
// 잠금 해제 직후 main은 마우스를 통째로 받게 해 둔다 — 커서가 상호작용 요소 밖이면 첫 움직임에서 통과 모드로 되돌린다
document.addEventListener('mousemove', (e) => {
  if (draggingWindow || hitCount > 0 || !searchPanel.hidden) return;
  if (e.target && e.target.closest && e.target.closest('.hit')) return;
  sendHit(false);
});
for (const el of document.querySelectorAll('.hit')) {
  el.addEventListener('mouseenter', () => { hitCount += 1; sendHit(true); });
  el.addEventListener('mouseleave', () => {
    hitCount = Math.max(0, hitCount - 1);
    if (hitCount === 0 && !draggingWindow) sendHit(false); // 드래그 중엔 놓지 않는다
  });
}
// 검색 패널이 열리는 동안은 통째로 받는다 (입력창 타이핑)
const hitObserver = new MutationObserver(() => {
  if (!searchPanel.hidden) { hitCount = 1; sendHit(true); }
});
hitObserver.observe(searchPanel, { attributes: true, attributeFilter: ['hidden'] });

// 단축키로 볼륨을 바꿨을 때 새 값을 잠깐 띄운다 (게임 중에는 앱의 볼륨 슬라이더가 보이지 않는다)
window.lyricsOverlay.onFlash((text) => flashMessage(text));

// 창을 옮기는 동안에만 히트박스(=창 영역) 테두리를 표시 — main이 'move' 이벤트로 알려준다
window.lyricsOverlay.onDragging((flag) => document.body.classList.toggle('dragging', !!flag));

window.lyricsOverlay.onSettings(applyLyricsSettings);
window.lyricsOverlay.getSettings().then(applyLyricsSettings).catch(() => applyLyricsSettings(lyricsSettings));

render();
requestAnimationFrame(animate);
