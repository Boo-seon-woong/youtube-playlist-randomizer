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
  if ((line.match(/[、,，]/g) || []).length >= 3) return false; // 나열(배급처·출연진 목록 — 실측: 애니 OP 설명란)
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
    .map((b, _i, all) => {
      // 언어를 모를 때: 일본어 덩어리와 한국어 덩어리가 함께 있으면 한국어 쪽은 번역·발음 표기(한국 팬 자막 영상 — 실측: Doomer,
      // 25時、ナイトコードで。)로 보고 일본어(원문)를 고른다
      if (!hint.lang && b.lang === 'ko' && all.some((o) => o.lang === 'ja' && o.lines.length >= 8)) return { ...b, score: b.score - 100 };
      return b;
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

// ── 1단계: 곡 정보 확인 (iTunes 검색 — 무료·키 없음) ──
// 영상 제목은 영문·로마자·한국어 표기거나 원제가 빠진 경우가 많다("Tokyo Manaka - Pop & Cute"). 일본·한국 스토어에서 찾으면
// 원어 곡명·가수가 나온다(실측: → ポッペンキュート / 東京真中, "Yomitan Akane GUNUNU" → ぐぬぬ / 読谷あかね). 이 이름으로 모든
// 가사 출처를 다시 찾는다. 채택: 제목·가수가 맞거나(가나는 로마자로 바꿔 비교 — ぐぬぬ ↔ GUNUNU), 1순위 결과이면서
// 곡 길이가 영상과 3초(또는 3%) 안. 틀린 곡을 집어도 그 가사는 소리 검증(자동 싱크)에서 걸러진다.
const KANA_ROMA = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o', カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko', サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to', ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no', ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo', ヤ: 'ya', ユ: 'yu', ヨ: 'yo', ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa', ヲ: 'o', ン: 'n',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo', ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo', パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po', ヴ: 'vu', ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o',
};
function kanaRomaji(text) {
  const k = String(text || '').replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  let out = '';
  for (let i = 0; i < k.length; i++) {
    const c = k[i];
    if (c === 'ッ') { const nx = KANA_ROMA[k[i + 1]]; if (nx) out += nx[0]; continue; }
    if (c === 'ー') { const m = out.match(/[aeiou]$/); if (m) out += m[0]; continue; }
    if ('ャュョ'.includes(c)) { out = out.replace(/i$/, '') + { ャ: 'ya', ュ: 'yu', ョ: 'yo' }[c]; continue; }
    out += KANA_ROMA[c] != null ? KANA_ROMA[c] : c;
  }
  return out;
}
const loose = (t) => String(t || '').toLowerCase().replace(/[\(\[（【].*?[\)\]）】]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
const romaLoose = (t) => loose(kanaRomaji(t)).replace(/(.)\1+/g, '$1').replace(/ou/g, 'o').replace(/uu/g, 'u');
function nameMatches(a, b) {
  const x = loose(a);
  const y = loose(b);
  if (!x || !y) return false;
  // 포함 관계는 짧은 쪽이 긴 쪽의 60% 이상일 때만("cute" ⊂ "popcute" 같은 우연한 포함 배제 — 실측 "Cute / Koresawa")
  const contains = (p, q) => Math.min(p.length, q.length) >= 3 && Math.min(p.length, q.length) / Math.max(p.length, q.length) >= 0.6 && (p.includes(q) || q.includes(p));
  if (x === y || contains(x, y)) return true;
  const rx = romaLoose(a);
  const ry = romaLoose(b);
  return rx.length >= 3 && (rx === ry || contains(rx, ry));
}

async function itunesSearchMany(term, country) {
  const data = JSON.parse(await fetchText(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&attribute=artistTerm&country=${country}&limit=50`, {}, 6000));
  return (data.results || []).map((r) => ({ title: r.trackName || '', artist: r.artistName || '', duration: Number(r.trackTimeMillis) || 0 }));
}

async function itunesSearch(term, country) {
  const data = JSON.parse(await fetchText(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&country=${country}&limit=5`, {}, 5000));
  return (data.results || []).map((r) => ({ title: r.trackName || '', artist: r.artistName || '', duration: Number(r.trackTimeMillis) || 0 }));
}

// queries: buildLyricQueries 결과, durationMs: 영상 길이. 반환: [{title, artist}] (최대 3)
// iTunes 검색은 분당 약 20회 제한 — 곡마다 2회(검색어 1개 × 스토어 2곳)만, 같은 곡은 한 번만(실행 중 캐시)
const identityCache = new Map();
function identifySong(queries, durationMs) {
  const key = `${(queries.pairs || [])[0] ? `${queries.pairs[0].title}\u0000${queries.pairs[0].artist}` : ''}|${Math.round((durationMs || 0) / 5000)}`;
  if (!identityCache.has(key)) {
    const p = identifySongUncached(queries, durationMs).catch(() => []);
    identityCache.set(key, p);
    if (identityCache.size > 500) identityCache.delete(identityCache.keys().next().value);
  }
  return identityCache.get(key);
}

async function identifySongUncached(queries, durationMs) {
  const titles = queries.titles || [];
  const artists = queries.artists || [];
  const korean = [...titles, ...artists].some((t) => /[\uac00-\ud7a3]/.test(t));
  const countries = korean ? ['KR', 'JP'] : ['JP', 'US'];
  const terms = [...new Set((queries.pairs || []).slice(0, 1).map((p) => `${p.title} ${p.artist || ''}`.trim()))];
  const found = [];
  await Promise.all(countries.flatMap((country) => terms.map(async (term) => {
    let list = [];
    try { list = await itunesSearch(term, country); } catch { return; }
    list.forEach((r, rank) => {
      if (/instrumental|off vocal|karaoke|カラオケ|inst\.?\)/i.test(r.title)) return;
      const titleOk = titles.some((t) => nameMatches(r.title, t));
      const artistOk = artists.some((a) => nameMatches(r.artist, a));
      const durOk = durationMs > 0 && r.duration > 0 && Math.abs(r.duration - durationMs) <= Math.max(3000, durationMs * 0.03);
      // 1순위 결과의 제목 일치(로마자로 같은 것 포함 — ぐぬぬ ↔ GUNUNU)는 그 자체로 강한 증거
      if (titleOk && (artistOk || durOk)) found.push({ ...r, strong: true, score: 2 + (artistOk ? 2 : 0) + (durOk ? 1 : 0) });
      else if (titleOk && rank === 0) found.push({ ...r, strong: false, titleOnly: true, score: 1 });
      // 제목이 안 맞고 가수·길이만 맞는 결과는 약하다 — 같은 가수의 비슷한 길이 다른 곡일 수 있다(실측: 人生パッパラパー →
      // "Dopamine Loop"). 제목이 맞는 결과와 길이가 같은(같은 음원의 다른 나라 표기 — Pop & Cute ↔ ポッペンキュート,
      // 둘 다 152.75초) 경우에만 쓴다.
      else if (artistOk && durOk) found.push({ ...r, strong: false, score: 2 });
    });
  })));
  // 제목이 한국어 음역(팬픽션 = ファンフィクション)이라 아무 것도 못 찾았을 때: 채널(원곡 가수)의 곡 목록에서 길이가 맞는
  // 곡이 딱 하나면 그것 — 틀려도 자동 싱크의 소리 판정이 걸러 낸다
  if (!found.some((r) => r.strong) && durationMs > 0) {
    for (const a of artists.slice(0, 2)) {
      let list = [];
      try { list = (await itunesSearch(a, korean ? 'KR' : 'JP')).concat(); } catch { continue; }
      try { list = list.concat(await itunesSearchMany(a, korean ? 'KR' : 'JP')); } catch {}
      const near = list.filter((r) => nameMatches(r.artist, a) && r.duration > 0 && Math.abs(r.duration - durationMs) <= 2500
        && !/instrumental|off vocal|karaoke|カラオケ/i.test(r.title));
      const uniq = near.filter((r, i) => near.findIndex((o) => loose(o.title) === loose(r.title)) === i);
      if (uniq.length === 1) { found.push({ ...uniq[0], strong: true, score: 1 }); break; }
    }
  }
  let strong = found.filter((r) => r.strong).sort((a, b) => b.score - a.score);
  // 제목만 맞은 1순위 결과는 다른 근거가 하나도 없을 때만(같은 제목의 다른 가수 곡이 섞이지 않게 — 실측 "Gununu / Kōya Ogata")
  if (!strong.length) strong = found.filter((r) => r.titleOnly).slice(0, 1);
  const localized = found.filter((r) => !r.strong && !r.titleOnly && strong.some((x) => x.duration > 0 && Math.abs(x.duration - r.duration) <= 1500));
  const out = [];
  // 제목이 확인된 것 중 최고 1개 + 같은 음원의 다른 표기(원어명) + 나머지 순 — 최대 3개
  for (const r of [...strong.slice(0, 1), ...localized, ...strong.slice(1)]) {
    if (out.length >= 3) break;
    if (!out.some((o) => loose(o.title) === loose(r.title) && loose(o.artist) === loose(r.artist))) out.push({ title: r.title, artist: r.artist });
  }
  return out;
}

// ── 2단계: 웹 검색(야후 재팬) → 가사 사이트 페이지에서 본문 ──
// 정확한 곡 정보로 검색하면 일본 가사 사이트가 바로 나온다(실측: ポッペンキュート 東京真中 歌詞 → utaten·Genius·uta5·atwiki).
// 본문을 뽑을 수 있는 곳만 쓴다: utaten, Genius, uta5(atwiki·miraheze는 봇 확인으로 403, petitlyrics는 스크립트로 불러옴).
// 구글·빙 직접 검색은 봇 판정으로 엉뚱한 결과(빙: 목걸이 줄)를 줘서 쓰지 않는다.
async function yahooSearch(q) {
  const html = await fetchText(`https://search.yahoo.co.jp/search?p=${encodeURIComponent(q)}`, { 'Accept-Language': 'ja' }, 6000);
  const urls = [];
  for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/(?:utaten\.com\/lyric\/[^"]+|genius\.com\/[^"]+-lyrics|www\.uta5\.com\/kasi\/\d+))"/g)) {
    const u = decodeHtml(m[1]);
    if (!urls.includes(u)) urls.push(u);
  }
  return urls.slice(0, 5);
}

async function uta5Lyrics(url) {
  const html = await fetchText(url);
  const at = html.search(/<div[^>]*class="[^"]*uta5-lyrics-main[^"]*"/);
  if (at < 0) return null;
  const title = decodeHtml((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  const lines = toLines(htmlToLines(sliceDiv(html, at).inner));
  const tm = title.match(/^(.+?)\s*[–-]\s*(.+?)\s*歌詞/);
  return lines.length >= 4 ? { lines, plain: true, title: tm ? tm[2] : '', artist: tm ? tm[1] : '' } : null;
}

// pairs: [{title, artist}] (확인된 원어 곡명 우선). accept({title, artist}) — 제목·가수 판정
async function fetchWebLyricsCandidates(pairs, accept) {
  const out = [];
  const seen = new Set();
  for (const p of pairs.slice(0, 2)) {
    let urls = [];
    try { urls = await yahooSearch(`${p.title} ${p.artist || ''} 歌詞`.trim()); } catch { continue; }
    for (const url of urls) {
      if (out.length >= 3 || seen.has(url)) continue;
      seen.add(url);
      let body = null;
      try {
        if (url.includes('utaten.com')) {
          const id = (url.match(/lyric\/([^/]+)/) || [])[1];
          const html = await fetchText(url);
          const t = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
          const m = decodeHtml(t).match(/^(.+?)\s*歌詞\s*(.+?)\s*(?:ふりがな付|\||-)/);
          body = await utatenLyrics(id);
          if (body) Object.assign(body, { title: m ? m[1] : p.title, artist: m ? m[2] : p.artist });
        } else if (url.includes('genius.com')) {
          body = await geniusLyrics(url);
          if (body) Object.assign(body, { title: p.title, artist: p.artist });
        } else {
          body = await uta5Lyrics(url);
        }
      } catch {}
      if (!body || !accept({ title: body.title || p.title, artist: body.artist || p.artist })) continue;
      out.push({ source: url.includes('utaten') ? 'utaten' : url.includes('genius') ? 'genius' : 'uta5', id: url, title: body.title || p.title, artist: body.artist || p.artist, duration: 0, lines: body.lines, plain: true });
    }
    if (out.length) break;
  }
  return out;
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
  identifySong,
  fetchWebLyricsCandidates,
  nameMatches,
  extractDescriptionLyrics,
  scriptOf,
  fetchBugsCandidates,
  fetchUtatenCandidates,
  fetchGeniusCandidates,
  parseBugsTimed,
};
