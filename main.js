const { app, BrowserWindow, session, ipcMain, screen, globalShortcut, webFrameMain } = require('electron');
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

// ── 가사: ALSong 우선, LRCLIB 보조 ──
// YouTube IFrame API는 Spotify/YouTube Music처럼 가사 데이터를 제공하지 않으므로
// 현재 곡의 제목·아티스트로 외부 가사 DB를 조회하고, 재생 시간은 renderer가 전달한다.
const ALSong_ENC_DATA = '8456ec35caba5c981e705b0c5d76e4593e020ae5e3d469c75d1c6714b6b1244c0732f1f19cc32ee5123ef7de574fc8bc6d3b6bd38dd3c097f5a4a1aa1b438fea0e413baf8136d2d7d02bfcdcb2da4990df2f28675a3bd621f8234afa84fb4ee9caa8f853a5b06f884ea086fd3ed3b4c6e14f1efac5a4edbf6f6cb475445390b0';

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
  showTrackInfo: true,
  coverMode: 'art', // 왼쪽 사각형: 'none' | 'art'(앨범 이미지) | 'video'(영상 작게 — 음소거 미러 임베드)
  videoFit: 'cover', // 영상 맞춤: 'cover'(상하 기준으로 채우고 좌우는 잘림) | 'contain'(전체가 보이도록)
  fontFamily: 'default', // 가사 글꼴 (LYRIC_FONTS 키)
  showStatus: true,
  alwaysOnTop: true,
  clickThrough: false, // 잠금 모드: 창을 눌러도 아래 프로그램(게임 등)으로 클릭이 지나간다
};
const COVER_MODES = ['none', 'art', 'video'];
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

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlDecode(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlBlocks(xml, tag) {
  const result = [];
  const re = new RegExp(`<(?:(?:[\\w-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:(?:[\\w-]+):)?${tag}>`, 'gi');
  for (const match of String(xml).matchAll(re)) result.push(match[1]);
  return result;
}

function xmlText(xml, tag) {
  const block = xmlBlocks(xml, tag)[0];
  return block == null ? '' : xmlDecode(block.replace(/<[^>]+>/g, '').trim());
}

// 같은 시각에 붙은 여러 줄(ALSong의 원문·발음·번역)은 한 블록으로 묶어 text를 줄바꿈으로 잇는다 —
// 창에서는 첫 줄을 원문(크게), 나머지를 발음/번역(작게)으로 그린다.
function parseLrc(text) {
  const entries = [];
  const timeRe = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const matches = [...raw.matchAll(timeRe)];
    const lyricText = raw.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (!lyricText) continue;
    for (const match of matches) {
      entries.push({
        time: (Number(match[1]) * 60 + Number(match[2])) * 1000,
        text: lyricText,
      });
    }
  }
  entries.sort((a, b) => a.time - b.time);
  const lines = [];
  for (const entry of entries) {
    const last = lines[lines.length - 1];
    if (last && last.time === entry.time) last.text += `\n${entry.text}`;
    else lines.push({ ...entry });
  }
  return lines;
}

function hasHangul(text) {
  return /[가-힣]/.test(String(text || ''));
}

function hangulCount(lines) {
  return (lines || []).reduce((count, line) => count + (String(line.text || '').match(/[가-힣]/g) || []).length, 0);
}

function normalizeMatch(text) {
  return String(text || '').toLowerCase().replace(/[\(\[\{].*?[\)\]\}]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

function textMatchScore(value, query) {
  const actual = normalizeMatch(value);
  const wanted = normalizeMatch(query);
  if (!actual || !wanted) return 0;
  if (actual === wanted) return 1;
  if (actual.includes(wanted) || wanted.includes(actual)) return 0.75;
  return 0;
}

function durationMatchScore(value, target) {
  if (!value || !target) return 0;
  return Math.max(0, 1 - Math.abs(value - target) / Math.max(target, 1000));
}

// ── 가사 검색어 정제 ──
// 렌더러가 넘기는 title/artist는 유튜브 영상 제목("[MV] IU(아이유) _ Good Day(좋은 날)",
// "BTS (방탄소년단) 'Dynamite' Official MV", "ぐぬぬ / 重音テト", "설명🔥: 요루시카 - 봄도둑(春泥棒) [가사/해석]")과
// 채널명("1theK (원더케이)", "IU - Topic")이다. ALSong 검색은 제목·아티스트 모두 부분 문자열 매칭이라
// 이 원문을 그대로 넣으면 0건이 된다(실측). 태그를 걷어낸 뒤 제목/아티스트 후보를 여러 개 뽑아
// 구체적인 조합부터 순서대로 검색한다.
const NOISE_BRACKET_RE = /\b(?:official|mv|m\/v|pv|video|audio|lyrics?|live|ver|version|visualizer|performance|teaser|remaster(?:ed)?|hd|hq|4k|color coded|ost|clip|stage|practice|sub|cover|from|youtube|feat\.?|ft\.?|prod\.?|full\s*(?:album|track)|eng|kor|jpn)\b|가사|뮤비|뮤직비디오|공식|자막|라이브|안무|버전|음원|풀버전|해석|발음|번역|불러\s*보았다|전체\s*듣기|전곡|정규\s*\d+\s*집|미니\s*\d*\s*집|オリジナル|歌ってみた|カバー|公式|ミュージックビデオ|フル|ボカロ|自作曲/i;
const BRACKET_RE = /[\(\[\{（［【]([^()\[\]{}（）［］【】]*)[\)\]\}）］】]/g;
// 구분자: " - ", " _ ", " | " 는 "아티스트 - 제목", " / " 는 일본 관례대로 "제목 / 아티스트", ": " 는 앞이 설명문인 경우가 많다
const SEPARATOR_RE = /\s+[-–—_|]\s+|\s*[:：]\s+|\s+[\/／]\s+/g;
// 이모지(+ 변형 선택자 U+FE0F)와 괄호 마스킹용 제어문자
const EMOJI_RE = new RegExp('[\\p{Extended_Pictographic}' + String.fromCharCode(0xfe0f) + ']', 'gu');
const MASK_CHAR = String.fromCharCode(1);

function stripTitleNoise(text) {
  return String(text || '')
    .replace(/　/g, ' ')
    .replace(EMOJI_RE, ' ')
    // 'ㅣ'(한글 자모)를 세로선 대신 쓰는 채널이 있다: "제목ㅣLyrics/가사" — 구분자로 취급
    .replace(/(?<![ㄱ-ㅎㅏ-ㅣ])\s*ㅣ\s*(?![ㄱ-ㅎㅏ-ㅣ])/g, ' | ') // "ㅈㅣㅂ"처럼 자모로 쓴 제목은 건드리지 않는다
    .replace(/\s*\|\s*lyrics?\s*\/?\s*(?:가사)?\s*$/i, ' ')
    // 말미의 발매일 "- 2015.03.20" 은 제목이 아니다
    .replace(/\s*[-–—]?\s*\d{4}\.\d{1,2}\.\d{1,2}\.?\s*$/, ' ')
    // 앨범 전체 재생 영상의 꼬리표
    .replace(/(?:앨범\s*)?전체\s*듣기|전곡\s*듣기|전곡|\bfull\s*(?:album|track)\b/gi, ' ')
    .replace(BRACKET_RE, (match, inner) => (NOISE_BRACKET_RE.test(inner) ? ' ' : match))
    .replace(/\b(?:official\s+)?(?:music\s+video|lyric\s+video|m\/v|mv|pv|visualizer)\b/gi, ' ')
    .replace(/\bofficial\s+(?:video|audio)\b/gi, ' ')
    .replace(/\blyrics?\b/gi, ' ')
    .replace(/\s+ver\.?\s*$/i, ' ')
    .replace(/가사|뮤비|뮤직비디오|공식\s*영상|불러\s*보았다\.?|歌ってみた|歌いました/g, ' ')
    .replace(/\s*\bcover(?:ed)?\s+by\b.*$/i, ' ') // "ヒバナ Covered by あらき" — 부른 사람은 채널명으로 충분하다
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—_|:]+|[\s\-–—_|:]+$/g, '')
    .trim();
}

function cleanChannelName(author) {
  return String(author || '')
    .replace(BRACKET_RE, (match, inner) => (NOISE_BRACKET_RE.test(inner) ? ' ' : match))
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s+official\b.*$/i, '')
    .replace(/\s*공식\s*채널.*$/, '')
    .replace(/\s*외\s*\d+명$/, '')
    .trim();
}

// "FOMO feat. Teto" → "FOMO", 아티스트 "ZERA & via" → "ZERA" (부분 문자열 검색이라 짧은 쪽이 안전하다)
function stripFeat(text) {
  return String(text || '').replace(/\s*\b(?:feat|ft)\b\.?.*$/i, '').trim();
}

function primaryArtist(text) {
  return stripFeat(text)
    .replace(/^[^.。!?]{0,40}[.。!?]\s+(?=\S)/, '') // 앞에 붙은 설명 문장("함께서 즐거웠어요. 요네즈 켄시")
    .replace(/\s*[×&,、，\/／]\s*.*$|\s+(?:x|및|and|with)\s+.*$/i, '').trim();
}

// "Good Day(좋은 날)" → ["좋은 날", "Good Day"] (한글 표기 우선), 괄호가 없으면 원문 그대로
function nameVariants(text) {
  const out = [];
  const push = (value) => {
    const v = String(value || '')
      .replace(/[\(\[（［【][^)\]）］】]*$/, '')
      .replace(/[\)\]）］】]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—_|:]+|[\s\-–—_|:]+$/g, '')
      .trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const source = String(text || '');
  const inner = [...source.matchAll(BRACKET_RE)].flatMap((m) => m[1].split(/\s*[\/／|]\s*/));
  const all = [source.replace(BRACKET_RE, ' '), ...inner];
  all.filter(hasHangul).forEach(push);
  all.forEach(push);
  // "춤 踊"처럼 구분자 없이 한글 표기와 원어 표기를 나란히 쓴 제목은 문자 체계별로도 나눈다
  for (const value of [...out]) {
    const segments = value.split(/\s+/);
    if (segments.length < 2) continue;
    const scripts = segments.map((seg) => (/[가-힣]/.test(seg) ? 'ko' : /[ぁ-んァ-ン一-龯]/.test(seg) ? 'ja' : 'other'));
    if (new Set(scripts.filter((x) => x !== 'other')).size < 2) continue;
    for (const script of ['ko', 'ja']) {
      const part = segments.filter((seg, i) => scripts[i] === script).join(' ');
      if (part) push(part);
    }
  }
  return out;
}

// 괄호 안의 구분자는 무시하고 나눈다: "ぐぬぬ / 重音テト (GUNUNU / Kasane Teto)" → ["ぐぬぬ", "重音テト (GUNUNU / Kasane Teto)"]
function splitOutsideBrackets(text) {
  const masked = text.replace(BRACKET_RE, (m) => MASK_CHAR.repeat(m.length));
  const parts = [];
  const seps = [];
  let last = 0;
  // 공백 있는 구분자가 하나도 없으면 "flos/R Sound Design" 같은 공백 없는 슬래시로 나눈다
  const matches = [...masked.matchAll(SEPARATOR_RE)];
  for (const m of matches.length > 0 ? matches : masked.matchAll(/\s*[\/／]\s*/g)) {
    parts.push(text.slice(last, m.index).trim());
    seps.push(m[0].trim());
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last).trim());
  return { parts, seps };
}

// 영상 제목에서 아티스트/제목 후보 조합을 가능성 순으로 돌려준다.
// 따옴표 제목('Dynamite', 「アイドル」) → 앞부분이 아티스트. 구분자가 있으면 첫 구분자 기준 조합,
// 3조각 이상이면 마지막 구분자 기준 조합("설명: 아티스트 - 제목")도, 마지막으로 뒤집은 조합("Title - Artist" 대비).
// titleOnly=false 인 조합의 제목은 제목 단독 검색에 쓰지 않는다(아티스트명으로 검색하면 엉뚱한 곡만 걸린다).
// 선두의 【Ado】·[레오루] 같은 라벨과 말미의 【Eve】는 제목이 아니라 아티스트 후보다
// (말미의 ()/[]는 "봄도둑(春泥棒)"처럼 병기 제목이므로 남긴다).
function splitArtistTitle(input, channel = '') {
  const labels = [];
  let text = input
    .replace(/^\s*[\[［【]([^\]］】]*)[\]］】]\s*(?=\S)/, (m, inner) => { labels.push(inner.trim()); return ''; })
    .replace(/(?<=\S)\s*【([^】]*)】\s*$/, (m, inner) => { labels.push(inner.trim()); return ''; })
    .trim();
  const withLabel = (split) => ({ ...split, artist: split.artist || labels[0] || '', labels });
  // "가사 한 줄" 제목 [아티스트 앨범] 처럼 맨 앞의 따옴표 구절은 인용문이므로 버린다
  text = text.replace(/^['‘“"][^'’”"]{6,}['’”"]\s+(?=\S)/, '').trim();
  const quoted = text.match(/^(.*?)(?:^|\s)['‘“"]([^'’”"]+)['’”"](?=\s|$)/)
    || text.match(/^(.*?)[「『《]([^」』》]+)[」』》]/);
  if (quoted && quoted[2].trim() && quoted[1].trim()) {
    return [withLabel({ title: quoted[2].trim(), artist: quoted[1].trim(), titleOnly: true })];
  }
  let { parts, seps } = splitOutsideBrackets(text);
  // "설명문: 아티스트 - 제목" (번역 채널 관례) — 콜론 앞은 설명이므로 버린다
  if (parts.length >= 3 && /^[:：]$/.test(seps[0])) {
    parts = parts.slice(1);
    seps = seps.slice(1);
  }
  // 조각이 채널명(정제본)과 같거나 서로 포함하면 그쪽이 아티스트 — "그 아이 시크릿 - Eve MV"(채널 Eve)는
  // 구분자 관례("아티스트 - 제목")와 반대로 뒤가 아티스트다
  const channelKey = normalizeMatch(channel);
  const looksLikeChannel = (part) => {
    const key = normalizeMatch(part);
    // 한 글자짜리 한자 예명("遊")도 채널명(宮下遊)에 들어 있으면 인정한다
    const meaningful = key.length >= 2 || /[\u3040-\u9fff]/.test(part);
    return !!channelKey && !!key && meaningful && (key === channelKey || channelKey.includes(key) || key.includes(channelKey));
  };
  const pair = (index) => {
    const [a, b] = [parts[index], parts[index + 1]];
    if (looksLikeChannel(b) && !looksLikeChannel(a)) return { title: a, artist: b };
    if (looksLikeChannel(a) && !looksLikeChannel(b)) return { title: b, artist: a };
    const titleFirst = /^[\/／]$/.test(seps[index]);
    return titleFirst ? { title: a, artist: b } : { title: b, artist: a };
  };
  if (parts.length < 2 || !parts[0] || !parts[1]) return [withLabel({ title: text, artist: '', titleOnly: true })];
  const first = pair(0);
  const splits = [withLabel({ ...first, titleOnly: true })];
  if (parts.length >= 3 && parts[parts.length - 1]) {
    splits.push(withLabel({ ...pair(parts.length - 2), titleOnly: true }));
  }
  splits.push(withLabel({ title: first.artist, artist: first.title, titleOnly: false }));
  return splits;
}

// 검색 순서: 1순위 조합 제목×아티스트(≤4) → 나머지 조합(각 ≤1) → 제목 단독(≤3). 첫 결과가 나오는 조합에서 멈추고,
// 제목 단독 검색은 여러 아티스트가 섞여 오므로 이후 rankLyricCandidates가 아티스트 일치로 골라낸다.
function buildLyricQueries(rawTitle, rawAuthor) {
  const cleanedChannel = cleanChannelName(rawAuthor);
  const splits = splitArtistTitle(stripTitleNoise(rawTitle), primaryArtist(cleanedChannel));
  const channel = nameVariants(primaryArtist(cleanedChannel));
  const pairs = [];
  const seen = new Set();
  const add = (title, artist) => {
    const key = (title + ' ' + artist).toLowerCase();
    if (!title || seen.has(key)) return;
    seen.add(key);
    pairs.push({ title, artist });
  };
  const allTitles = [];
  const allArtists = [];
  const titleOnly = [];
  const primaryTitles = [];
  const matchTitles = [];
  splits.forEach((split, index) => {
    const titles = nameVariants(stripFeat(split.title)).slice(0, 3);
    if (split.titleOnly) {
      // 첫 조합의 괄호 병기 변형(해바라기 / ひまわり / Himawari)은 정식 제목이다 — 단 주 제목과 문자 체계가
      // 다른 것만("Trapstar Lifestyle (Deluxe)"의 Deluxe처럼 같은 알파벳 꼬리표는 제목이 아니다)
      if (titles[0]) primaryTitles.push(titles[0]);
      if (index === 0) {
        const script = (t) => (/[가-힣]/.test(t) ? 'ko' : /[ぁ-んァ-ン一-龯]/.test(t) ? 'ja' : 'latin');
        for (const t of titles.slice(1)) if (script(t) !== script(titles[0])) primaryTitles.push(t);
      }
      matchTitles.push(...titles);
    }
    const artists = [
      ...nameVariants(primaryArtist(split.artist)),
      ...(index === 0 ? [...channel, ...split.labels.flatMap((label) => nameVariants(primaryArtist(label)))] : []),
    ].slice(0, 2);
    allTitles.push(...titles);
    allArtists.push(...artists);
    if (index === 0) for (const title of titles) for (const artist of artists) add(title, artist);
    else if (titles[0] && artists[0]) add(titles[0], artists[0]);
    if (split.titleOnly) titleOnly.push(...titles);
  });
  for (const title of titleOnly.slice(0, 3)) add(title, '');
  if (pairs.length === 0 && String(rawTitle || '').trim()) add(String(rawTitle).trim(), '');
  // 원어 표기가 섞여 있으면(가나) 일본 곡이다 — 동명의 한국 곡을 걸러내는 데 쓴다
  const expectJapanese = /[ぁ-んァ-ン]/.test(String(rawTitle || ''));
  return { pairs, titles: matchTitles.length > 0 ? matchTitles : allTitles, primaryTitles, artists: [...allArtists, ...channel], expectJapanese };
}

function hasKana(text) {
  return /[ぁ-んァ-ン]/.test(String(text || ''));
}

function candidateIsJapanese(candidate) {
  return hasKana(candidate.title) || hasKana(candidate.artist) || (candidate.lines || []).some((line) => hasKana(line.text));
}

// 제목 유사도: 정규화 후 같으면 1, 한쪽이 다른 쪽을 포함하면 길이 비율(짧은/긴) — "Deluxe" vs "Night Deluxe"는
// 0.55라 걸러지고 "Black Star (검은 별)" vs "Black Star"는 괄호가 벗겨져 1이 된다.
function titleSimilarity(value, query) {
  const actual = normalizeMatch(value);
  const wanted = normalizeMatch(query);
  if (!actual || !wanted) return 0;
  if (actual === wanted) return 1;
  if (actual.includes(wanted) || wanted.includes(actual)) {
    return Math.min(actual.length, wanted.length) / Math.max(actual.length, wanted.length);
  }
  return 0;
}

function bestTitleScore(value, titles) {
  return (titles || []).reduce((best, query) => Math.max(best, titleSimilarity(value, query)), 0);
}

// 후보 채택 기준: 제목이 거의 같고(≥0.8) 아티스트도 맞거나, 주 제목과 정확히 같다.
// 괄호 병기 같은 보조 제목 변형("keep me going (BIRDBRAIN)"의 BIRDBRAIN)은 아티스트까지 맞아야 한다 —
// 그렇지 않으면 이름만 같은 다른 곡이 걸린다.
// 제목만 정확히 같고 아티스트는 다른 후보(동명이곡)는 재생시간이 맞을 때만 받는다 — 재생시간을 아는 경우에 한해.
// DB 항목 제목도 유튜브 제목처럼 "아티스트 - 제목 feat.X" 꼴로 올라온 것이 많다("Chenomio - フィクションです。feat.重音テト").
// 그대로 비교하면 우리 제목(フィクションです。)과 길이 비율이 낮아 걸러지므로, 항목 쪽도 같은 정제를 거쳐
// 아티스트 조각·feat·잡음을 뗀 '핵심 제목'을 함께 비교한다.
function candidateTitleVariants(candidate) {
  const raw = String(candidate.title || '');
  const out = [raw];
  const cleaned = stripFeat(stripTitleNoise(raw));
  if (cleaned && cleaned !== raw) out.push(cleaned);
  const artistKey = normalizeMatch(candidate.artist);
  // "Chenomio -フィクションです。"처럼 구분자 한쪽에만 공백이 있는 경우: 앞 조각이 아티스트면 뒤만 남긴다
  const loose = (cleaned || raw).match(/^(.+?)\s*[-–—_|:：]\s*(.+)$/);
  if (loose) {
    const [, head, tail] = loose;
    const headKey = normalizeMatch(head);
    if (artistKey && headKey && (headKey === artistKey || artistKey.includes(headKey) || headKey.includes(artistKey))) out.push(tail.trim());
  }
  const { parts } = splitOutsideBrackets(cleaned || raw);
  if (parts.length >= 2) {
    const rest = parts.filter((part) => {
      const key = normalizeMatch(part);
      return !(artistKey && key && (key === artistKey || artistKey.includes(key) || key.includes(artistKey)));
    });
    if (rest.length > 0 && rest.length < parts.length) out.push(rest.join(' '));
    else out.push(...parts);
  }
  return out.filter(Boolean);
}

function bestCandidateTitleScore(candidate, titles) {
  return candidateTitleVariants(candidate).reduce((best, variant) => Math.max(best, bestTitleScore(variant, titles)), 0);
}

function lyricMatchScore(candidate, queries, targetDuration = 0) {
  const title = bestCandidateTitleScore(candidate, queries.titles);
  const primary = bestCandidateTitleScore(candidate, queries.primaryTitles || queries.titles);
  const artist = bestMatchScore(candidate.artist, queries.artists);
  const hasArtistQuery = (queries.artists || []).length > 0;
  // 가수 칸에 영상 제목을 통째로 넣은 쓰레기 항목(제목과 같거나 비정상적으로 김)도 '가수 미상'으로 본다
  const unknownArtist = !candidate.artist || /알\s*수\s*없음|unknown/i.test(candidate.artist)
    || String(candidate.artist).length > 40 || normalizeMatch(candidate.artist) === normalizeMatch(candidate.title);
  const raw = bestTitleScore(candidate.title, queries.titles); // 정제 없이 제목 그대로의 일치도 (동점 정리용)
  let accepted = !unknownArtist && title >= 0.8 && (artist > 0 || !hasArtistQuery);
  if (!accepted && primary === 1 && !unknownArtist) {
    // 제목만 같고 가수가 다른 후보(동명이곡): 재생시간이 맞고, 일본 곡이면 후보도 일본 곡이어야 한다
    const canCheckDuration = targetDuration > 0 && candidate.duration > 0;
    const durationOk = !canCheckDuration || durationMatchScore(candidate.duration, targetDuration) >= 0.85;
    const scriptOk = !queries.expectJapanese || candidateIsJapanese(candidate);
    accepted = durationOk && scriptOk;
  }
  return { title, artist, raw, accepted };
}

function bestMatchScore(value, queries) {
  return (queries || []).reduce((best, query) => Math.max(best, textMatchScore(value, query)), 0);
}

function markLyricLanguage(candidate, fallbackNotice = false) {
  const lines = candidate.lines || [];
  const korean = candidate.hasKorean === true || lines.some((line) => hasHangul(line.text));
  return {
    ...candidate,
    hasKorean: korean,
    language: korean ? 'ko' : 'original',
    fallbackNotice: !korean && fallbackNotice ? '한글 번역 없음 · 원어 가사' : (candidate.fallbackNotice || ''),
  };
}

// 정렬: 채택 기준을 통과한 후보 → 제목 유사도 → 아티스트 일치 → 한글 가사 → 재생시간 근사 → 한글 양.
// 예전에는 한글 여부를 최우선으로 두어, 이름만 비슷한 다른 곡의 한글 가사가 진짜 곡을 이기곤 했다.
function rankLyricCandidates(candidates, queries, targetDuration) {
  return [...candidates]
    .map((candidate) => ({ ...markLyricLanguage(candidate), match: lyricMatchScore(candidate, queries, targetDuration) }))
    .sort((a, b) => {
      if (a.match.accepted !== b.match.accepted) return b.match.accepted ? 1 : -1;
      const titleScore = b.match.title - a.match.title;
      if (Math.abs(titleScore) > 0.05) return titleScore;
      const artistScore = b.match.artist - a.match.artist;
      if (artistScore) return artistScore;
      // 같은 곡이 여럿이면 제목이 깔끔한 항목("뭘 알어")을 "창모 - 뭘 알어 (REMIX)"보다 앞에
      const rawScore = b.match.raw - a.match.raw;
      if (Math.abs(rawScore) > 0.05) return rawScore;
      if (queries.expectJapanese) {
        const ja = candidateIsJapanese(b) - candidateIsJapanese(a);
        if (ja) return ja;
      }
      if (a.hasKorean !== b.hasKorean) return b.hasKorean ? 1 : -1;
      const durationScore = durationMatchScore(b.duration, targetDuration) - durationMatchScore(a.duration, targetDuration);
      if (Math.abs(durationScore) > 0.02) return durationScore;
      return hangulCount(b.lines) - hangulCount(a.lines);
    });
}

function alsongRequest(action, fields) {
  const fieldXml = Object.entries(fields)
    .map(([key, value]) => `<ns1:${key}>${xmlEscape(value)}</ns1:${key}>`)
    .join('');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="ALSongWebServer">
    <SOAP-ENV:Body><ns1:${action}>${fieldXml}</ns1:${action}></SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'lyrics.alsong.co.kr',
      port: 80,
      path: '/alsongwebservice/service1.asmx',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'gSOAP/2.7',
        SOAPAction: `ALSongWebServer/${action}`,
      },
    }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`ALSong HTTP ${res.statusCode}`));
        resolve(chunks.join(''));
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('ALSong request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function lyricCandidate(source, data) {
  const lines = data.lines || [];
  return {
    source,
    id: String(data.id || ''),
    title: data.title || '',
    artist: data.artist || '',
    album: data.album || '',
    duration: Number(data.duration) || 0,
    lines,
    hasKorean: data.hasKorean === true || lines.some((line) => hasHangul(line.text)),
  };
}

async function fetchLrclibCandidates(queries) {
  const urls = queries.pairs.map((pair) => {
    const query = new URLSearchParams({ track_name: pair.title });
    if (pair.artist) query.set('artist_name', pair.artist);
    return `https://lrclib.net/api/search?${query}`;
  });
  const result = [];
  const seen = new Set();
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const json = await response.json();
      for (const item of Array.isArray(json) ? json : []) {
        if (!item.syncedLyrics) continue;
        const key = String(item.id || `${item.trackName}:${item.artistName}:${item.albumName}`);
        if (seen.has(key)) continue;
        seen.add(key);
        const lines = parseLrc(item.syncedLyrics);
        if (lines.length > 0) result.push(lyricCandidate('lrclib', {
          id: item.id,
          title: item.trackName,
          artist: item.artistName,
          album: item.albumName,
          duration: Number(item.duration) * 1000,
          lines,
        }));
      }
      if (result.length > 0) break;
    } catch {}
  }
  return result;
}

// 조합을 순서대로 검색하되 첫 결과에서 멈추지 않는다 — 앞 조합이 이름만 비슷한 엉뚱한 곡을 돌려주고
// 진짜 곡은 뒤 조합에서 나오는 경우가 있어, 채택 기준을 통과하는 후보가 나올 때까지(최대 6조합) 모아 병합한다.
async function fetchAlsongCandidates(queries) {
  const merged = new Map();
  let tried = 0;
  for (const search of queries.pairs) {
    if (tried >= 6) break;
    tried += 1;
    try {
      const fields = { encData: ALSong_ENC_DATA, pageNo: 1, title: search.title };
      if (search.artist) fields.artist = search.artist;
      const xml = await alsongRequest('GetResembleLyricList2', fields);
      for (const block of xmlBlocks(xml, 'ST_SEARCHLYRIC_LIST')) {
        const item = lyricCandidate('alsong', {
          id: xmlText(block, 'lyricID'),
          title: xmlText(block, 'title'),
          artist: xmlText(block, 'artist'),
          album: xmlText(block, 'album'),
        });
        if (item.id && !merged.has(item.id)) merged.set(item.id, item);
      }
      const hit = [...merged.values()].some((item) => lyricMatchScore(item, queries).accepted);
      if (hit) break; // 진짜 곡 후보가 나왔으면 더 넓은(느슨한) 조합은 검색하지 않는다
    } catch {}
  }
  return [...merged.values()];
}

async function resolveLyricCandidate(candidate) {
  if (!candidate) return null;
  if (candidate.lines && candidate.lines.length > 0) return markLyricLanguage(candidate);
  if (candidate.source !== 'alsong' || !candidate.id) return null;
  try {
    const xml = await alsongRequest('GetLyricByID2', { encData: ALSong_ENC_DATA, lyricID: Number(candidate.id) });
    const lyric = xmlText(xml, 'lyric');
    const lines = parseLrc(lyric);
    if (lines.length === 0) return null;
    const duration = Math.max(candidate.duration || 0, lines[lines.length - 1].time);
    return markLyricLanguage({ ...candidate, duration, lines });
  } catch {
    return null;
  }
}

async function resolveAlsongCandidates(queries, targetDuration) {
  // 최대 100건이 오므로 가사 본문을 받기 전에 메타(제목/아티스트 일치)로 먼저 추려 16건만 조회한다
  const metadata = rankLyricCandidates(await fetchAlsongCandidates(queries), queries, 0).slice(0, 16);
  const resolved = (await Promise.all(metadata.map((candidate) => resolveLyricCandidate(candidate)))).filter(Boolean);
  return rankLyricCandidates(resolved, queries, targetDuration);
}

async function findLyricsForTrack(title, artist, targetDuration) {
  const queries = buildLyricQueries(title, artist);
  const alsong = (await resolveAlsongCandidates(queries, targetDuration)).filter((c) => c.match.accepted);
  const korean = alsong.find((candidate) => candidate.hasKorean);
  if (korean) return korean;

  // ALSong에 한글 가사가 없을 때만 LRCLIB 원어 가사로 내려간다. 여기서도 채택 기준을 통과한 것만.
  const lrclib = rankLyricCandidates(await fetchLrclibCandidates(queries), queries, targetDuration)
    .filter((c) => c.match.accepted);
  if (lrclib.length > 0) return markLyricLanguage(lrclib[0], true);
  // 이름만 비슷한 다른 곡을 보여주느니 "찾지 못함"이 낫다
  return alsong.length > 0 ? markLyricLanguage(alsong[0], true) : null;
}

async function searchAllLyrics(title, artist) {
  const queries = buildLyricQueries(title, artist);
  const alsong = await resolveAlsongCandidates(queries, 0);
  const lrclib = rankLyricCandidates(await fetchLrclibCandidates(queries), queries, 0);
  const hasKoreanAlsong = alsong.some((candidate) => candidate.hasKorean);
  return [
    ...alsong.map((candidate) => markLyricLanguage(candidate, !hasKoreanAlsong)),
    ...lrclib.map((candidate) => markLyricLanguage(candidate, !hasKoreanAlsong)),
  ].slice(0, 16);
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

function lyricStateKey(state) {
  return [state.id, state.title, state.artist].join('\\u0000').toLowerCase();
}

// 유튜브가 영상에 등록한 저작권 음악 정보(설명란의 '음악' 카드: 곡명·아티스트·앨범). 영상 제목으로 못 찾을 때
// 마지막 수단으로 이 곡명/아티스트로 다시 검색한다. next 응답의 videoAttributeViewModel에 실려 있다.
const videoMusicCache = new Map();

async function fetchVideoMusicInfo(videoId) {
  if (!videoId) return null;
  if (videoMusicCache.has(videoId)) return videoMusicCache.get(videoId);
  let info = null;
  try {
    const data = await innertube('next', { videoId });
    const text = (x) => (x && (x.content || x.simpleText || (x.runs || []).map((r) => r.text).join(''))) || '';
    (function walk(node) {
      if (info || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const vm = node.videoAttributeViewModel;
      if (vm && vm.title) {
        info = { title: text(vm.title) || String(vm.title), artist: text(vm.subtitle) || String(vm.subtitle || '') };
        return;
      }
      for (const value of Object.values(node)) walk(value);
    })(data);
  } catch {}
  videoMusicCache.set(videoId, info);
  return info;
}

async function loadLyricsForState(state, key) {
  if (lyricsLoadingKey === key) return;
  if (lyricsCache.has(key)) {
    lyricsData = lyricsCache.get(key);
    sendLyricsToWindow();
    return;
  }
  lyricsLoadingKey = key;
  const requestId = ++lyricsRequestId;
  try {
    let data = await findLyricsForTrack(state.title, state.artist, state.duration);
    if (!data) {
      // 영상 제목으로 못 찾으면 유튜브에 등록된 곡명·아티스트로 한 번 더
      const music = await fetchVideoMusicInfo(state.id);
      if (music && music.title) data = await findLyricsForTrack(music.title, music.artist, state.duration);
    }
    const displayData = data || { unavailable: true, lines: [] };
    lyricsCache.set(key, displayData);
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
    status: ['playing', 'paused', 'idle'].includes(data.status) ? data.status : 'idle',
    progress: Math.max(0, Number(data.progress) || 0),
    duration: Math.max(0, Number(data.duration) || 0),
    coverUrl: String(data.coverUrl || ''),
    volume: Math.max(0, Math.min(100, Number.isFinite(Number(data.volume)) ? Number(data.volume) : 100)),
  };
  if (pendingVolumeFlash && next.volume !== lyricsState.volume) {
    pendingVolumeFlash = false;
    sendLyricsFlash(`🔊 볼륨 ${Math.round(next.volume)}`);
  }
  const key = lyricStateKey(next);
  const keyChanged = key !== lyricsKey;
  lyricsState = next;
  if (keyChanged) {
    lyricsKey = key;
    lyricsData = lyricsCache.has(key) ? lyricsCache.get(key) : null;
    sendLyricsToWindow();
  }
  sendLyricsToWindow();
  if (next.status !== 'idle' && next.title && next.duration > 0 && !lyricsCache.has(key)) {
    loadLyricsForState(next, key).catch(() => {});
  }
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
  const height = 720;
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

function stepMasterVolume(delta) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  pendingVolumeFlash = true;
  mainWindow.webContents.send('lyrics:control', 'volume-step', delta);
}

function sendLyricsFlash(text) {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || lyricsWindow.webContents.isLoading()) return;
  lyricsWindow.webContents.send('lyrics:flash', text);
}

const LYRICS_SHORTCUTS = [
  { accelerator: 'Alt+1', label: '볼륨 1 감소', run: () => stepMasterVolume(-1) },
  { accelerator: 'Alt+2', label: '볼륨 1 증가', run: () => stepMasterVolume(1) },
  { accelerator: 'Alt+3', label: '가사 창 표시/숨기기', run: () => toggleLyricsWindow() },
  { accelerator: 'Alt+4', label: '클릭 통과 켜기/끄기(조작 주체 전환)', run: toggleLyricsClickThrough },
  { accelerator: 'Alt+5', label: '가사 창 다시 맨 위로(가리기 해제)', run: () => keepLyricsOnTop() },
  { accelerator: 'Alt+Q', label: '이전 곡 (Alt+W 누른 채 Q 꾹: 되감기)', run: () => trackOrScrub('Alt+Q', -1) },
  { accelerator: 'Alt+W', label: '재생/일시정지', run: () => playToggleOrChord() },
  { accelerator: 'Alt+E', label: '다음 곡 (Alt+W 누른 채 E 꾹: 빨리 감기)', run: () => trackOrScrub('Alt+E', 1) },
];

// Alt+Q/E는 즉시 이전/다음 곡(판정 대기 없음). 되감기/빨리 감기는 Alt+W를 누른 채 Q/E를 꾹 누르는 코드.
// 전역 단축키는 키를 뗀 순간을 모르지만, 누르고 있으면 OS 자동 반복으로 콜백이 계속 오는 성질을 쓴다:
//  - Alt+W 콜백이 최근(350ms 안)에 왔으면 W를 누르고 있는 것 → 그때 오는 Alt+Q/E는 슬라이드
//  - 슬라이드가 시작되면 Q/E의 자동 반복(마지막 누른 키만 반복된다)이 250ms 안에 이어지는 동안 계속 슬라이드
//  - Alt+W 자체의 재생/일시정지는 250ms 뒤에 확정 — 그 안에 Q/E가 따라오면(코드) 토글하지 않는다
let wLastAt = 0;
let wTimer = null;
let wChorded = false;
const scrubState = new Map(); // key → { lastAt, lastSeek, timer }

function playToggleOrChord() {
  const now = Date.now();
  const repeat = now - wLastAt < 700;
  wLastAt = now;
  if (repeat) return; // W를 누르고 있는 동안의 자동 반복 — 코드 창만 연장
  wChorded = false;
  clearTimeout(wTimer);
  wTimer = setTimeout(() => { if (!wChorded) sendControl('toggle-play'); }, 250);
}

function trackOrScrub(key, direction) {
  const now = Date.now();
  const st = scrubState.get(key) || { lastAt: 0, lastSeek: 0, timer: null };
  const scrubbing = now - st.lastAt < 250 || now - wLastAt < 350;
  if (!scrubbing) {
    sendControl(direction < 0 ? 'previous' : 'next'); // 단발: 즉시
    return;
  }
  wChorded = true;
  clearTimeout(wTimer);
  st.lastAt = now;
  if (now - st.lastSeek >= 100) { // 자동 반복은 초당 30회 안팎 — 100ms마다 2초씩 = 초당 20초
    st.lastSeek = now;
    sendControl('seek-by', direction * 2);
  }
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.lastAt = 0; }, 250);
  scrubState.set(key, st);
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
  try {
    for (const frame of wc.mainFrame.framesInSubtree) hideEmbedChrome(frame);
  } catch {}
}

function hideEmbedChrome(frame, attempt = 0) {
  if (!frame || typeof frame.url !== 'string' || !/youtube(-nocookie)?\.com\//.test(frame.url)) return;
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
    try { hideEmbedChrome(webFrameMain.fromId(frameProcessId, frameRoutingId)); } catch {}
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.on('closed', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close();
    if (lyricsSettingsWindow && !lyricsSettingsWindow.isDestroyed()) lyricsSettingsWindow.close();
    mainWindow = null;
  });
}

let webviewWC = null; // 폴백 웹뷰의 webContents (창에 하나뿐)

app.whenReady().then(async () => {
  const port = await startServer();
  lyricsServerPort = port;
  lyricsSettings = loadLyricsSettings();
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
  ipcMain.handle('lyrics:settings:get', () => lyricsSettings);
  ipcMain.handle('lyrics:settings:save', (_event, settings) => updateLyricsSettings(settings));
  ipcMain.handle('lyrics:settings:reset', () => updateLyricsSettings(DEFAULT_LYRICS_SETTINGS));
  ipcMain.handle('lyrics:data:get', () => lyricsData);
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
    if (['previous', 'toggle-play', 'next', 'seek', 'seek-by', 'volume', 'volume-save', 'volume-step'].includes(action)) {
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
  ipcMain.handle('lyrics:select', async (_event, candidate) => {
    const data = await resolveLyricCandidate(candidate);
    if (data) {
      lyricsData = data;
      if (lyricsKey) lyricsCache.set(lyricsKey, data);
      sendLyricsToWindow();
    }
    return data;
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
