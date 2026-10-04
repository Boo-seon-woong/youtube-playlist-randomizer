// 추가 가사 출처 — 싱크가 없어도 되는 "텍스트 가사"를 넓게 모은다 (싱크는 자동 싱크가 맞춘다).
// lyrics-search.js가 알송·LRCLIB·NetEase와 함께 동시에 부른다. Electron 비의존 순수 Node 모듈.
//
// - 설명란(desc): 그 영상 설명에 적힌 가사 — 같은 영상이라 "그 곡의 가사"일 가능성이 가장 높다.
//   (생명성 신드롬 MV 설명란 "歌詞：" 아래 전곡 가사 실측)
// - Bugs(bugs): 한국 음원 사이트. `player/lyrics/T/<트랙>`은 싱크 가사("34.0|가사＃…"), `N/<트랙>`은 본문(실측).
// - utaten(utaten): 일본 가사 사이트(후리가나 포함 — 후리가나를 빼고 본문만). 인디·애니·보카로까지 넓다.
// - Genius(genius): 영어·한국·일본 곡. 로마자 표기·번역 항목(Genius Romanizations 등)은 뺀다.
// 막혀 있던 곳(2026-10-04): uta-net 403, vocaloidlyrics.fandom(api 410·페이지 403), atwiki 403, j-lyric 접속 불가,
// 유튜브 자막 get_transcript(FAILED_PRECONDITION — PO 토큰 필요).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

async function fetchText(url, headers = {}, timeout = 6000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,ja;q=0.9,en;q=0.8', ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeHtml(s) {
  return String(s || '').replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// HTML 조각 → 줄 배열 (<br>·문단 끝을 줄바꿈으로)
function htmlToLines(html) {
  return decodeHtml(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim());
}

const toLines = (texts) => texts.filter(Boolean).map((text) => ({ time: 0, text }));

// ── 설명란 가사 ──
// 설명란은 가사 외에 링크·크레딧·홍보·해시태그가 섞인다. 줄을 "가사 같은 줄"로 분류하고(링크·@·#·"작사:" 같은
// 크레딧·지나치게 긴 문장 제외), 빈 줄을 사이에 둔 가사 같은 줄의 가장 긴 덩어리를 고른다. "歌詞/가사/Lyrics" 표시가
// 있으면 그 뒤 덩어리를 우선한다. 노래의 문자 체계(일본어면 가나)와 다른 덩어리(영어 번역 등)는 버린다.
const CREDIT_RE = /^(?:作詞|作曲|編曲|歌唱?|唄|vocals?|music|lyrics?|words|composer?|arrange(?:ment|r)?|mix(?:ing)?|master(?:ing)?|illust(?:ration)?|movie|video|animation|guitar|bass|drums?|piano|chorus|director|producer|edit|design|thumbnail|mv|作|曲|詞|絵|動画|映像|イラスト|ミックス|マスタリング|歌词|作词|编曲|演唱|작사|작곡|편곡|노래|보컬|영상|일러스트|믹싱|마스터링)\b.*[:：／/]/i;
const NOISE_RE = /https?:\/\/|www\.|@\w|^#|[#＃]\S+\s*[#＃]|\.com\b|instagram|twitter|tiktok|youtube|spotify|apple\s*music|subscribe|チャンネル登録|配信|ダウンロード|ストリーミング|구독|좋아요|스트리밍|다운로드|■|▶|►|♦|◆|【.*(?:配信|公開|発売|情報).*】|copyright|©|℗|all rights reserved/i;
// 가사 표시 줄: "歌詞", "Lyrics:", "【歌詞】", "(日本語歌詞)", "[Korean Lyrics]", "- 가사 -" 등 (괄호·언어 이름 허용)
const MARK_RE = /^[\s\-=―ー─━~〜*＊・(（【［\[]*(?:日本語|英語|韓国語|中国語|japanese|english|korean|chinese|romaji|original|원어|일본어|한국어|영어)?\s*(?:歌詞|lyrics?|가사)[\s\-=―ー─━~〜*＊・:：)）】］\]]*$/i;

function lyricLike(line) {
  if (!line) return false;
  if (line.length > 70) return false;
  if (NOISE_RE.test(line) || CREDIT_RE.test(line)) return false;
  if (/^[\s\-=―ー─━~〜*＊・_.。]+$/.test(line)) return false; // 구분선
  return true;
}

function scriptOf(text) {
  const kana = (text.match(/[぀-ヿ]/g) || []).length;
  const han = (text.match(/[一-鿿]/g) || []).length;
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[a-z]/gi) || []).length;
  if (kana > 0 && kana + han >= hangul && kana + han >= latin / 3) return 'ja';
  if (hangul > 0 && hangul >= latin / 3) return 'ko';
  if (han > 0 && han >= latin / 3) return 'zh';
  return latin > 0 ? 'en' : '';
}

// hint.lang: 'ja' | 'ko' | 'en' | 'zh' | '' (모르면 가장 큰 덩어리)
function extractDescriptionLyrics(desc, hint = {}) {
  const raw = String(desc || '').split(/\r?\n/).map((l) => l.trim());
  if (raw.length < 8) return null;
  const blocks = [];
  let cur = null;
  let blanks = 0;
  let marked = false;
  const close = () => { if (cur && cur.lines.length) blocks.push(cur); cur = null; };
  for (const line of raw) {
    if (MARK_RE.test(line)) { close(); marked = true; continue; }
    if (!line) { blanks += 1; if (blanks > 2) close(); continue; }
    if (lyricLike(line)) {
      if (!cur) { cur = { lines: [], marked, gaps: 0 }; marked = false; }
      if (blanks && cur.lines.length) cur.gaps += 1;
      cur.lines.push(line);
    } else {
      close();
      marked = false;
    }
    blanks = 0;
  }
  close();
  // 덩어리 점수: 줄 수(8줄 이상이어야 가사로 본다) + 표시 뒤 덩어리 가산 + 연(빈 줄로 나뉜 묶음)이 있으면 가산
  const scored = blocks
    .filter((b) => b.lines.length >= 8)
    .map((b) => {
      const lang = scriptOf(b.lines.join(' '));
      const avg = b.lines.reduce((n, l) => n + l.length, 0) / b.lines.length;
      let score = b.lines.length + (b.marked ? 20 : 0) + Math.min(b.gaps, 6) * 2;
      // 산문(곡 소개·제작 후기) 걸러내기: 가사 줄은 짧고 마침표로 끝나는 일이 드물다
      // (실측: デビットビット 설명란의 제작 후기 14줄이 가사로 잡혔다 — 줄 끝 「。」「、」와 평균 길이로 가른다)
      const sentenceEnds = b.lines.filter((l) => /[。．.!！]$/.test(l) || /[、,]$/.test(l)).length / b.lines.length;
      if (sentenceEnds > 0.25) score -= 40;
      if (avg > 30) score -= 20;
      if (avg > 45) score -= 20; // 설명 문단
      if (hint.lang && lang && lang !== hint.lang) score -= 100; // 다른 언어(번역 블록 등)
      return { ...b, lang, score };
    })
    .filter((b) => b.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const best = scored[0];
  return { lines: toLines(best.lines), lang: best.lang, marked: best.marked, score: best.score };
}

// ── Bugs (한국) ──
async function bugsSearch(q) {
  const html = await fetchText(`https://music.bugs.co.kr/search/track?q=${encodeURIComponent(q)}`);
  const out = [];
  const rowRe = /<tr[^>]*\btrackId="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) && out.length < 8) {
    const row = m[2];
    const title = (row.match(/track_title="([^"]*)"/) || [])[1];
    const artist = (row.match(/artist_disp_nm="([^"]*)"/) || [])[1];
    if (title) out.push({ id: m[1], title: decodeHtml(title), artist: decodeHtml(artist || '') });
  }
  return out;
}

function parseBugsTimed(text) {
  return String(text || '').split('＃').map((part) => {
    const i = part.indexOf('|');
    if (i < 0) return null;
    const t = Number(part.slice(0, i));
    const line = part.slice(i + 1).trim();
    return Number.isFinite(t) && line ? { time: Math.round(t * 1000), text: line } : null;
  }).filter(Boolean);
}

async function bugsLyrics(trackId) {
  try {
    const timed = JSON.parse(await fetchText(`https://music.bugs.co.kr/player/lyrics/T/${trackId}`));
    const lines = parseBugsTimed(timed && timed.lyrics);
    if (lines.length >= 4) return { lines, plain: false };
  } catch {}
  try {
    const plain = JSON.parse(await fetchText(`https://music.bugs.co.kr/player/lyrics/N/${trackId}`));
    const lines = toLines(String((plain && plain.lyrics) || '').split(/\r?\n/).map((l) => l.trim()));
    if (lines.length >= 4) return { lines, plain: true };
  } catch {}
  return null;
}

// ── utaten (일본) ──
async function utatenSearch(title, artist) {
  const url = `https://utaten.com/search?sort=popular_sort_asc&title=${encodeURIComponent(title)}${artist ? `&artist_name=${encodeURIComponent(artist)}` : ''}`;
  const html = await fetchText(url);
  const out = [];
  const rowRe = /<p class="searchResult__title">\s*<a href="\/lyric\/([^"\/]+)\/">([\s\S]*?)<\/a>[\s\S]*?<td class="searchResult__artist">[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = rowRe.exec(html)) && out.length < 8) {
    out.push({ id: m[1], title: decodeHtml(m[2]).trim(), artist: decodeHtml(m[3]).trim() });
  }
  return out;
}

async function utatenLyrics(id) {
  const html = await fetchText(`https://utaten.com/lyric/${id}/`);
  const m = html.match(/<div class="hiragana"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return null;
  const body = m[1].replace(/<span class="rt">[\s\S]*?<\/span>/g, ''); // 후리가나 제거
  const lines = toLines(htmlToLines(body));
  return lines.length >= 4 ? { lines, plain: true } : null;
}

// ── Genius ──
async function geniusSearch(q) {
  const data = JSON.parse(await fetchText(`https://genius.com/api/search/song?q=${encodeURIComponent(q)}&per_page=5`));
  const hits = (((data || {}).response || {}).sections || []).flatMap((s) => s.hits || []);
  return hits.map((h) => h.result).filter(Boolean)
    .filter((r) => !/Genius (?:Romanizations|English Translations|Translations|Korea|Japan)/i.test(r.artist_names || (r.primary_artist || {}).name || ''))
    // 가수는 피처링을 뺀 주 가수 이름으로 — artist_names("東京真中 (Tokyo Manaka) (Ft. 重音テト (Kasane Teto))")는
    // 40자를 넘어 채택 판정에서 '가수 미상' 쓰레기 항목으로 걸렸다(실측: Pop & Cute를 못 찾음)
    .map((r) => ({ id: String(r.id), title: r.title || '', artist: ((r.primary_artist || {}).name || r.artist_names || '').replace(/\s*\((?:Ft|Feat)\.?[^)]*\)\s*$/i, ''), url: r.url }))
    .slice(0, 5);
}

// <div ...>에서 시작해 짝이 맞는 </div>까지의 안쪽 HTML (중첩 div를 센다)
function sliceDiv(html, openIdx) {
  const bodyStart = html.indexOf('>', openIdx) + 1;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = bodyStart;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return { inner: html.slice(bodyStart, m.index), end: m.index + 6 };
  }
  return { inner: html.slice(bodyStart), end: html.length };
}

async function geniusLyrics(url) {
  const html = await fetchText(url);
  const parts = [];
  for (const m of html.matchAll(/<div[^>]*data-lyrics-container="true"[^>]*>/g)) {
    let inner = sliceDiv(html, m.index).inner;
    // 기여자 수·번역 언어 목록 같은 머리말(data-exclude-from-selection)은 빼고 본문만
    for (;;) {
      const i = inner.search(/<div[^>]*data-exclude-from-selection="true"/);
      if (i < 0) break;
      inner = inner.slice(0, i) + inner.slice(i + sliceDiv(inner, i).end - i);
    }
    parts.push(inner);
  }
  const lines = parts.flatMap((p) => htmlToLines(p))
    .filter((l) => l && !/^\[[^\]]*\]$/.test(l)); // [Verse 1] 같은 구획 표시
  return lines.length >= 4 ? { lines: toLines(lines), plain: true } : null;
}

// 공통: 검색어 쌍(제목×가수)으로 출처를 훑어 후보를 모은다. accept(hit)으로 제목·가수가 맞는 항목만 가사까지 받는다.
async function collect(source, queries, search, lyrics, accept, maxFetch = 2) {
  const out = [];
  const seen = new Set();
  const pairs = (queries.pairs || []).slice(0, 4);
  for (const pair of pairs) {
    if (out.length >= maxFetch) break;
    let hits = [];
    try { hits = await search(pair); } catch { continue; }
    for (const hit of hits) {
      if (out.length >= maxFetch || seen.has(hit.id) || !accept(hit)) continue;
      seen.add(hit.id);
      let body = null;
      try { body = await lyrics(hit); } catch {}
      if (body) out.push({ source, id: hit.id, title: hit.title, artist: hit.artist, duration: 0, lines: body.lines, plain: body.plain });
    }
  }
  return out;
}

const fetchBugsCandidates = (queries, accept) => collect('bugs', queries,
  (p) => bugsSearch(`${p.artist ? p.artist + ' ' : ''}${p.title}`), (hit) => bugsLyrics(hit.id), accept);
const fetchUtatenCandidates = (queries, accept) => collect('utaten', queries,
  (p) => utatenSearch(p.title, p.artist), (hit) => utatenLyrics(hit.id), accept);
const fetchGeniusCandidates = (queries, accept) => collect('genius', queries,
  (p) => geniusSearch(`${p.title} ${p.artist || ''}`.trim()), (hit) => geniusLyrics(hit.url), accept);

module.exports = {
  extractDescriptionLyrics,
  scriptOf,
  fetchBugsCandidates,
  fetchUtatenCandidates,
  fetchGeniusCandidates,
  parseBugsTimed,
};
