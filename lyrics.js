let playback = { id: '', title: '', artist: '', status: 'idle', progress: 0, duration: 0, coverUrl: '' };
let lyricData = null;
let receivedAt = performance.now();
let searchOpen = false;

const card = document.getElementById('lyrics-card');
const cover = document.getElementById('lyrics-cover');
const title = document.getElementById('lyrics-title');
const artist = document.getElementById('lyrics-artist');
const linesEl = document.getElementById('lyrics-lines');
const statusEl = document.getElementById('lyrics-status');
const searchPanel = document.getElementById('lyrics-search-panel');
const searchForm = document.getElementById('lyrics-search-form');
const searchTitle = document.getElementById('lyrics-search-title');
const searchArtist = document.getElementById('lyrics-search-artist');
const searchStatus = document.getElementById('lyrics-search-status');
const searchResults = document.getElementById('lyrics-search-results');

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

function lineElement(line, className) {
  const el = document.createElement('div');
  el.className = `lyric-line ${className}${line ? '' : ' empty'}`;
  el.textContent = line ? line.text : '♪';
  return el;
}

function render() {
  title.textContent = playback.title || '';
  artist.textContent = playback.artist || '';
  cover.src = playback.coverUrl || '';
  cover.hidden = !playback.coverUrl;
  card.classList.toggle('paused', playback.status === 'paused');

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
  if (!searchOpen) render();
  requestAnimationFrame(animate);
}

function showSearch() {
  searchOpen = true;
  searchPanel.hidden = false;
  card.hidden = true;
  searchTitle.value = playback.title || '';
  searchArtist.value = playback.artist || '';
  searchStatus.textContent = '';
  searchResults.replaceChildren();
  searchTitle.focus();
}

function hideSearch() {
  searchOpen = false;
  searchPanel.hidden = true;
  card.hidden = false;
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
searchForm.addEventListener('submit', searchLyrics);

render();
requestAnimationFrame(animate);
