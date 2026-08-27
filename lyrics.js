let playback = { id: '', title: '', artist: '', status: 'idle', progress: 0, duration: 0, coverUrl: '' };
let lyricData = null;
let lyricsSettings = {
  width: 760, height: 240, backgroundOpacity: 94, fontSize: 16,
  showProgressBar: true, showPlaybackControls: true,
  showPreviousButton: true, showPauseButton: true, showNextButton: true,
  showTrackInfo: true, showAlbumArt: true, showStatus: true, alwaysOnTop: true,
};
let receivedAt = performance.now();
let panelMode = '';

const card = document.getElementById('lyrics-card');
const sideEl = document.getElementById('lyrics-side');
const coverBox = document.getElementById('lyrics-cover-box');
const cover = document.getElementById('lyrics-cover');
const title = document.getElementById('lyrics-title');
const artist = document.getElementById('lyrics-artist');
const linesEl = document.getElementById('lyrics-lines');
const statusEl = document.getElementById('lyrics-status');
const progressRow = document.getElementById('lyrics-progress-row');
const elapsedEl = document.getElementById('lyrics-elapsed');
const durationEl = document.getElementById('lyrics-duration');
const progressFill = document.getElementById('lyrics-progress-fill');
const playbackControls = document.getElementById('lyrics-playback-controls');
const previousButton = document.getElementById('lyrics-previous');
const pauseButton = document.getElementById('lyrics-pause');
const nextButton = document.getElementById('lyrics-next');
const searchPanel = document.getElementById('lyrics-search-panel');
const searchForm = document.getElementById('lyrics-search-form');
const searchTitle = document.getElementById('lyrics-search-title');
const searchArtist = document.getElementById('lyrics-search-artist');
const searchStatus = document.getElementById('lyrics-search-status');
const searchResults = document.getElementById('lyrics-search-results');

function applyLyricsSettings(next) {
  lyricsSettings = { ...lyricsSettings, ...(next || {}) };
  const opacity = Math.max(0, Math.min(100, Number(lyricsSettings.backgroundOpacity) || 0)) / 100;
  document.documentElement.style.setProperty('--lyrics-bg', `rgba(24, 25, 31, ${opacity})`);
  document.documentElement.style.setProperty('--lyrics-bg-2', `rgba(24, 25, 31, ${Math.max(0, opacity * 0.85)})`);
  document.documentElement.style.setProperty('--lyrics-font-size', `${lyricsSettings.fontSize}px`);
  progressRow.hidden = !lyricsSettings.showProgressBar;
  previousButton.hidden = !lyricsSettings.showPreviousButton;
  pauseButton.hidden = !lyricsSettings.showPauseButton;
  nextButton.hidden = !lyricsSettings.showNextButton;
  playbackControls.hidden = !lyricsSettings.showPlaybackControls
    || (!lyricsSettings.showPreviousButton && !lyricsSettings.showPauseButton && !lyricsSettings.showNextButton);
  document.getElementById('lyrics-track').hidden = !lyricsSettings.showTrackInfo;
  statusEl.hidden = !lyricsSettings.showStatus;
  // 왼쪽 열: 앨범 아트 정사각형은 창 높이에서 여백·재생바·컨트롤 높이를 뺀 크기 (예시 디자인처럼 세로를 꽉 채움)
  const coverSize = Math.max(80, Math.min(220,
    lyricsSettings.height - 16 - (progressRow.hidden ? 0 : 22) - (playbackControls.hidden ? 0 : 34)));
  document.documentElement.style.setProperty('--cover-size', `${coverSize}px`);
  coverBox.hidden = !lyricsSettings.showAlbumArt && !lyricsSettings.showTrackInfo;
  coverBox.classList.toggle('no-art', !lyricsSettings.showAlbumArt);
  sideEl.hidden = coverBox.hidden && progressRow.hidden && playbackControls.hidden;
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

function render() {
  title.textContent = playback.title || '';
  artist.textContent = playback.artist || '';
  if (cover.dataset.src !== (playback.coverUrl || '')) {
    cover.dataset.src = playback.coverUrl || '';
    cover.src = playback.coverUrl || '';
  }
  cover.hidden = !playback.coverUrl || !lyricsSettings.showAlbumArt;
  card.classList.toggle('paused', playback.status === 'paused');
  const progress = currentProgress();
  elapsedEl.textContent = formatTime(progress);
  durationEl.textContent = formatTime(playback.duration);
  progressFill.style.width = playback.duration > 0 ? `${Math.min(100, Math.max(0, progress / playback.duration * 100))}%` : '0%';
  pauseButton.textContent = playback.status === 'playing' ? 'Ⅱ' : '▶';
  pauseButton.title = playback.status === 'playing' ? '일시정지' : '재생';

  linesEl.replaceChildren();
  const index = currentIndex(currentProgress());
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

function showSearch() {
  openPanel('search');
  searchTitle.value = playback.title || '';
  searchArtist.value = playback.artist || '';
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

window.lyricsOverlay.onSettings(applyLyricsSettings);
window.lyricsOverlay.getSettings().then(applyLyricsSettings).catch(() => applyLyricsSettings(lyricsSettings));

render();
requestAnimationFrame(animate);
