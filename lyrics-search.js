// 가사 검색 — 영상 제목·채널명에서 곡명/아티스트 후보를 뽑아 여러 가사 DB를 조회하고, 같은 곡인지 판정해 고른다.
// Electron에 의존하지 않는 순수 Node 모듈이라 test/에서 실제 곡으로 반복 측정할 수 있다 (main.js가 require).
const http = require('http');

const ALSong_ENC_DATA = '8456ec35caba5c981e705b0c5d76e4593e020ae5e3d469c75d1c6714b6b1244c0732f1f19cc32ee5123ef7de574fc8bc6d3b6bd38dd3c097f5a4a1aa1b438fea0e413baf8136d2d7d02bfcdcb2da4990df2f28675a3bd621f8234afa84fb4ee9caa8f853a5b06f884ea086fd3ed3b4c6e14f1efac5a4edbf6f6cb475445390b0';
// main.js의 UA와 같은 값 (모듈이 main을 거꾸로 require할 수 없어 따로 둔다)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const { extractDescriptionLyrics, fetchBugsCandidates, fetchUtatenCandidates, fetchGeniusCandidates, identifySong, fetchWebLyricsCandidates } = require('./lyrics-sources');

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
  // [mm:ss.xx]와 함께 [mm:ss:xx](NetEase 일부 등록본 — 소수점 대신 콜론)도 받는다(예전엔 본문 가사로 잘못 분류)
  const timeRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const matches = [...raw.matchAll(timeRe)];
    const lyricText = raw.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
    if (!lyricText) continue;
    for (const match of matches) {
      const frac = match[3] ? Number(`0.${match[3]}`) : 0;
      entries.push({
        time: Math.round((Number(match[1]) * 60 + Number(match[2]) + frac) * 1000),
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
    // 공연 채널 꼬리표와 연도 괄호는 제목이 아니다: "/ THE FIRST TAKE", "(2024)", "Live Clip"
    .replace(/\s*[\/／|-]?\s*THE\s+FIRST\s+TAKE\b/gi, ' ')
    .replace(/[\(\[（［]\s*(?:19|20)\d{2}\s*[\)\]）］]/g, ' ')
    .replace(/\blive\s+clip\b/gi, ' ')
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
  // "DDU-DU DDU-DU"·"Re:Zero" 같은 라틴 제목은 건드리지 않는다
  const cjkHyphen = /(?<=[\u3040-\u30ff\u4e00-\u9fff가-힣])[-–—](?=[\u3040-\u30ff\u4e00-\u9fff가-힣])/g;
  const fallback = [...masked.matchAll(/\s*[\/／]\s*/g)];
  for (const m of matches.length > 0 ? matches : fallback.length > 0 ? fallback : masked.matchAll(cjkHyphen)) {
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
  // 맨 앞의 「제목」 — 뒤에 "from/by 가수"나 "/ 가수"가 오면 그쪽을 가수로, 없으면 채널명·라벨이 가수 후보
  const leading = text.match(/^[「『《]([^」』》]+)[」』》]\s*(?:(?:from|by)\s+|[\/／\-–—]\s*)?([^\s(（\[【"“].{0,40}?)?(?=\s|$|[(（\[【"“])/i);
  if (leading && leading[1].trim()) {
    return [withLabel({ title: leading[1].trim(), artist: (leading[2] || '').trim(), titleOnly: true })];
  }
  // "米津玄師-砂の惑星 / 요네즈켄시-모래의 행성" — 같은 곡을 두 언어로 나란히 적은 형식: 각 쪽을 "가수-제목"으로 쪼갠다
  const bilingual = text.match(/^(.+?)\s*[\/／]\s*(.+)$/);
  const cjkDash = /^(.+?[\u3040-\u30ff\u4e00-\u9fff가-힣])[-–—]([\u3040-\u30ff\u4e00-\u9fff가-힣].*)$/;
  if (bilingual && cjkDash.test(bilingual[1].trim()) && cjkDash.test(bilingual[2].trim())) {
    return [bilingual[1], bilingual[2]].map((side) => {
      const [, a, t] = side.trim().match(cjkDash);
      return withLabel({ title: t.trim(), artist: a.trim(), titleOnly: true });
    });
  }
  let { parts, seps } = splitOutsideBrackets(text);
  // "설명문: 아티스트 - 제목" (번역 채널 관례) — 콜론 앞은 설명이므로 버린다
  if (parts.length >= 3 && /^[:：]$/.test(seps[0])) {
    parts = parts.slice(1);
    seps = seps.slice(1);
  }
  // "아도 라이브는 사랑이에요 - Ado - うっせぇわ" — 맨 앞이 한국어 설명 문장이면 버린다
  // (한글 + 띄어쓰기 + 8자 이상일 때만 — "Kenshi Yonezu - Lemon - Live" 같은 정상 제목은 그대로)
  if (parts.length >= 3 && hasHangul(parts[0]) && /\s/.test(parts[0]) && parts[0].length >= 8
    && normalizeMatch(parts[0]) !== normalizeMatch(channel)) {
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
  // "Crazy (feat. Yina) by chomin" — 피처링 표기 뒤의 "by 가수"는 가수 표기(잡음 제거 전 원래 제목으로 판단 —
  // "Stand by Me"처럼 제목 속 by는 그대로 둔다)
  const byForm = String(rawTitle || '').match(/^(.+?)\s*[(（\[]?\s*(?:feat\.?|ft\.?)[^)）\]]*[)）\]]?\s+by\s+([^()（）\[\]【】「」]{2,40})$/i);
  if (byForm && byForm[1].trim()) splits.unshift({ title: byForm[1].trim(), artist: byForm[2].trim(), labels: [] });
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
function candidateTitleVariants(candidate, withBrackets = false) {
  const raw = String(candidate.title || '');
  const out = [raw, ...(candidate.altTitles || [])]; // NetEase 별칭·번역 제목
  // 괄호 속 병기 제목("ポッペンキュート (Pop & Cute)" — Genius·NetEase의 원제+영문 표기). 비교용 정규화가 괄호 속을
  // 지우므로 따로 꺼낸다. 아티스트까지 맞아야 하는 비교에서만 쓴다(이름만 같은 다른 곡 방지).
  if (withBrackets) {
    for (const m of raw.matchAll(/[\(\[（［【]([^()\[\]（）［］【】]+)[\)\]）］】]/g)) {
      const inner = m[1].trim();
      if (inner && !NOISE_BRACKET_RE.test(inner)) out.push(inner);
    }
  }
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

function bestCandidateTitleScore(candidate, titles, withBrackets = false) {
  return candidateTitleVariants(candidate, withBrackets).reduce((best, variant) => Math.max(best, bestTitleScore(variant, titles)), 0);
}

function lyricMatchScore(candidate, queries, targetDuration = 0) {
  const title = bestCandidateTitleScore(candidate, queries.titles, true); // 채택에 아티스트 일치가 필요한 비교 — 괄호 병기 제목 포함
  const primary = bestCandidateTitleScore(candidate, queries.primaryTitles || queries.titles);
  const artist = bestMatchScore(candidate.artist, queries.artists);
  const hasArtistQuery = (queries.artists || []).length > 0;
  // 가수 칸에 영상 제목을 통째로 넣은 쓰레기 항목(제목과 같거나 비정상적으로 김)도 '가수 미상'으로 본다
  // 길이 판정은 괄호 병기·피처링을 뗀 핵심 이름으로(Genius·NetEase의 "東京真中 (Tokyo Manaka) (Ft. 重音テト (Kasane Teto))" 같은
  // 정상 표기가 40자를 넘어 걸리던 문제) — 쓰레기 항목은 괄호를 떼도 길거나 제목과 같다
  const artistCore = stripFeat(String(candidate.artist || '').replace(/[\(\[（【［][^()\[\]（）【】［］]*[\)\]）】］]/g, ' ')).trim();
  const unknownArtist = !candidate.artist || /알\s*수\s*없음|unknown/i.test(candidate.artist)
    || artistCore.length > 40 || normalizeMatch(candidate.artist) === normalizeMatch(candidate.title);
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
      const hangul = hangulCount(b.lines) - hangulCount(a.lines);
      if (hangul) return hangul;
      // 끝까지 같으면 항상 같은 쪽을 고른다 — 같은 곡인데 실행마다 다른 등록본이 뽑히지 않게
      return String(a.source + a.id).localeCompare(String(b.source + b.id));
    });
}

// ── 알송 요청: 동시 4개 제한 + 재시도 ──
// 실측: 같은 요청을 동시에 16개 보내면 절반(16/32)이 응답 없이 멈춰 타임아웃되고, 4개 이하면 0건이었다.
// 예전엔 가사 본문 16건을 한꺼번에 요청했고, 실패가 "가사 없음"으로 처리·캐시되어 같은 곡이
// 찾아졌다 말았다 했다(아이리 칸나 - 최종화: 3번 중 2번 '못 찾음'). 동시 수를 묶고 실패하면 다시 시도한다.
const ALSONG_MAX_INFLIGHT = 4;
const ALSONG_TIMEOUT_MS = 3000; // 성공한 요청은 중간값 20~50ms, 최대 2.1초(실측) — 막힌 요청을 오래 기다리지 않는다
const ALSONG_ATTEMPTS = 3;
let alsongInflight = 0;
const alsongQueue = [];
// 검색 중 요청이 끝내 실패한 횟수 — "정말 없음"과 "네트워크 실패로 못 찾음"을 구분해 후자는 캐시하지 않게 한다
let lyricRequestFailures = 0;

function withAlsongSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      alsongInflight += 1;
      task().then(resolve, reject).finally(() => {
        alsongInflight -= 1;
        const next = alsongQueue.shift();
        if (next) next();
      });
    };
    if (alsongInflight < ALSONG_MAX_INFLIGHT) run();
    else alsongQueue.push(run);
  });
}

async function alsongRequest(action, fields) {
  let lastError = null;
  for (let attempt = 0; attempt < ALSONG_ATTEMPTS; attempt++) {
    try {
      return await withAlsongSlot(() => alsongRequestOnce(action, fields));
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  lyricRequestFailures += 1;
  throw lastError;
}

function alsongRequestOnce(action, fields) {
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
    req.setTimeout(ALSONG_TIMEOUT_MS, () => req.destroy(new Error('ALSong request timeout')));
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

// 싱크 없는 가사(본문만): 줄마다 time 0, 후보에 plain 표시 — 화면은 스크롤로 보여 준다
function parsePlainLyrics(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim())
    .filter((line) => line && !/^(?:作词|作曲|编曲|作詞|作曲|編曲|lyrics?|composer|arranger)\s*[:：]/i.test(line))
    .map((text) => ({ time: 0, text }));
}

// 동시 실행 개수를 제한해 배열을 처리한다 (외부 서비스에 요청을 한꺼번에 쏟아붓지 않도록)
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function fetchJson(url, headers = {}, timeout = 6000) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    lyricRequestFailures += 1; // 타임아웃·네트워크 오류 — '없음'이 아니라 '모름'
    return null;
  }
}

// ── LRCLIB: 검색 한 번에 1~2초라 예전처럼 조합을 하나씩 순서대로 기다리면 10초 넘게 걸렸다.
// 앞의 2조합을 동시에 보내고, 채택 기준을 통과하는 후보가 없을 때만 나머지(최대 4조합)를 동시에 더 보낸다.
// 싱크 가사가 없는 항목의 본문(plainLyrics)은 plain 후보로 남긴다 — 다른 데서 싱크를 못 찾았을 때의 대안.
async function fetchLrclibCandidates(queries, targetDuration = 0) {
  const result = [];
  const seen = new Set();
  const take = (json) => {
    for (const item of Array.isArray(json) ? json : []) {
      const key = String(item.id || `${item.trackName}:${item.artistName}:${item.albumName}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const synced = item.syncedLyrics ? parseLrc(item.syncedLyrics) : [];
      const plain = !synced.length && item.plainLyrics ? parsePlainLyrics(item.plainLyrics) : [];
      if (!synced.length && !plain.length) continue;
      result.push({
        ...lyricCandidate('lrclib', {
          id: item.id, title: item.trackName, artist: item.artistName, album: item.albumName,
          duration: Number(item.duration) * 1000, lines: synced.length ? synced : plain,
        }),
        plain: !synced.length,
      });
    }
  };
  const search = (pair) => {
    const query = new URLSearchParams({ track_name: pair.title });
    if (pair.artist) query.set('artist_name', pair.artist);
    return fetchJson(`https://lrclib.net/api/search?${query}`);
  };
  const waves = [queries.pairs.slice(0, 2), queries.pairs.slice(2, 6)];
  for (const wave of waves) {
    if (!wave.length) break;
    (await mapLimit(wave, 4, search)).forEach(take);
    if (result.some((c) => !c.plain && lyricMatchScore(c, queries, targetDuration).accepted)) break;
  }
  return result;
}

// ── NetEase Cloud Music: 일본·중국 곡, 보컬로이드·버튜버 곡의 싱크 가사가 많고 곡 길이를 정확히 준다.
// 검색어(곡명+가수)로 곡을 찾고, 메타데이터로 채택 기준을 통과한 상위 3곡만 가사를 받는다.
const NETEASE_HEADERS = { Referer: 'https://music.163.com/' };

async function fetchNeteaseCandidates(queries, targetDuration = 0) {
  const keywords = [];
  for (const pair of queries.pairs) {
    const k = `${pair.title} ${pair.artist || ''}`.trim();
    if (k && !keywords.includes(k)) keywords.push(k);
    if (keywords.length >= 3) break;
  }
  const songs = new Map();
  const lists = await mapLimit(keywords, 3, (k) => fetchJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(k)}&type=1&limit=10`, NETEASE_HEADERS));
  for (const json of lists) {
    for (const song of (json && json.result && json.result.songs) || []) {
      if (songs.has(song.id)) continue;
      songs.set(song.id, {
        ...lyricCandidate('netease', {
          id: song.id,
          title: song.name,
          artist: (song.artists || []).map((a) => a.name).join(', '),
          album: song.album && song.album.name,
          duration: Number(song.duration) || 0,
        }),
        // 번역·별칭 제목("夜に駆ける"의 별칭 등) — 제목 비교에 함께 쓴다
        altTitles: [...(song.alias || []), ...(song.transNames || [])].filter(Boolean),
      });
    }
  }
  const picked = rankLyricCandidates([...songs.values()], queries, targetDuration)
    .filter((c) => c.match.accepted)
    .slice(0, 3);
  const resolved = await mapLimit(picked, 3, async (song) => {
    const json = await fetchJson(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&tv=-1`, NETEASE_HEADERS);
    const text = json && json.lrc && json.lrc.lyric;
    if (!text) return null;
    const synced = parseLrc(text).filter((line) => !/^(?:作词|作曲|编曲|作詞|編曲|制作人|混音|母带)\s*[:：]/.test(line.text));
    const plain = synced.length ? [] : parsePlainLyrics(text);
    if (!synced.length && !plain.length) return null;
    const { match, ...rest } = song;
    return { ...rest, lines: synced.length ? synced : plain, plain: !synced.length, hasKorean: false };
  });
  return resolved.filter(Boolean);
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

// 채택된 후보들은 같은 곡의 중복 등록본이다 — 고른 가사의 제목이 원어라도, 그중 한글 제목 등록본이 있으면
// 표기(곡명·아티스트)만 그쪽을 쓴다. 번역 모델 없이 "한국어 제목"을 얻는 가장 값싼 길.
// 표기용 제목 정리: DB 등록본 제목엔 "[가사/해석/발음]" 같은 꼬리표가 붙어 있는 경우가 많다 — 표기에서만 뗀다
function cleanLyricLabel(title) {
  const cleaned = stripFeat(stripTitleNoise(title));
  return cleaned || String(title || '');
}

function preferKoreanLabel(chosen, accepted, queries) {
  if (!chosen) return chosen;
  if (hasHangul(chosen.title)) return { ...chosen, title: cleanLyricLabel(chosen.title) };
  const ko = accepted.find((c) => hasHangul(c.title) && !/[\(\[]/.test(c.title.trim()[0] || ''));
  if (ko) {
    return { ...chosen, title: cleanLyricLabel(ko.title), artist: hasHangul(ko.artist) || !chosen.artist ? ko.artist || chosen.artist : chosen.artist };
  }
  // DB에 한글 등록본이 없으면 영상 제목의 한글 표기(괄호 병기·병렬 표기)라도 쓴다 — 같은 영상에서 나온 제목이라 안전
  const fromVideo = (queries && queries.primaryTitles || []).find((t) => hasHangul(t));
  if (fromVideo) return { ...chosen, title: fromVideo };
  return { ...chosen, title: cleanLyricLabel(chosen.title) };
}

// ── 유튜브 '음악' 정보 카드(Content ID 기반 곡명·아티스트)로 만든 검색어 ──
// 영상 제목 해석은 채널마다 표기가 제각각이라 틀리기 쉽다(설명 문구·방송명·"제목 - 가수" 역순 등).
// 카드가 있으면 그 곡명·아티스트를 검색어 맨 앞에 두고, "제목만 같은 동명이곡" 판정의 기준 제목도
// 카드 제목으로만 삼는다 — 잘못 뽑힌 영상 제목 조각("Ado", "아 진짜 이걸 어캐 참아")이 같은 이름의
// 쓰레기 등록본을 끌어들이던 문제(실측)를 막는다.
function buildCardQueries(card) {
  const titles = nameVariants(stripFeat(stripTitleNoise(card.title))).slice(0, 3);
  const artistParts = String(card.artist || '')
    .split(/\s*[,&、×]\s*|\s+(?:feat\.?|ft\.?|x|with)\s+/i)
    .map((a) => a.trim())
    .filter(Boolean);
  const artists = [...new Set(artistParts.flatMap((a) => nameVariants(primaryArtist(a))))].slice(0, 4);
  const pairs = [];
  for (const t of titles) for (const a of artists.slice(0, 2)) pairs.push({ title: t, artist: a });
  for (const t of titles.slice(0, 2)) pairs.push({ title: t, artist: '' });
  return {
    pairs, titles, primaryTitles: titles, artists,
    expectJapanese: /[ぁ-んァ-ン]/.test(`${card.title} ${card.artist}`),
  };
}

// 두 검색어 묶음 합치기. cardFirst면 동명이곡 판정 기준 제목을 앞쪽(카드)으로만 둔다.
function mergeQueries(first, second, cardFirst = true) {
  const seen = new Set();
  const pairs = [...first.pairs, ...second.pairs].filter((p) => {
    const key = `${p.title}\u0000${p.artist}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    pairs,
    titles: [...first.titles, ...second.titles],
    primaryTitles: cardFirst ? first.primaryTitles : [...first.primaryTitles, ...second.primaryTitles],
    artists: [...first.artists, ...second.artists],
    expectJapanese: first.expectJapanese || second.expectJapanese,
  };
}

// 가사 본문이 같은 곡인지: 블록의 첫 줄(원문)을 정규화해 겹치는 비율 — 표기가 다른 같은 곡(米津玄師 vs
// 요네즈 켄시)은 높고, 제목만 같은 다른 곡은 거의 0이다
function lyricFingerprint(lines) {
  return new Set((lines || []).map((l) => normalizeMatch(String(l.text).split('\n')[0])).filter((t) => t.length >= 4));
}

function lyricOverlap(a, b) {
  const A = lyricFingerprint(a);
  const B = lyricFingerprint(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

const withTimeout = (promise, ms) => Promise.race([
  Promise.resolve(promise).catch(() => null),
  new Promise((resolve) => setTimeout(() => resolve(null), ms)),
]);

// 가사 고르기 — 출처를 순서대로 기다리지 않고 동시에 조회한다(예전엔 알송 → LRCLIB 조합별 순차라 최대 60초).
// 우선순위: ① 알송 한글 가사(곡명·가수 모두 일치) — 나오면 다른 출처를 기다리지 않고 바로 돌려준다
//          ② 알송 한글 가사(제목만 일치) — 다른 출처의 확실한 가사와 본문이 겹칠 때만(동명이곡 차단)
//          ③ LRCLIB·NetEase·Bugs 싱크 원어 가사(곡명·가수 일치) → ④ 알송 원어 → ⑤ 나머지 싱크 후보
//          ⑥ 텍스트 가사(싱크 없음 — 자동 싱크가 맞춘다): 설명란 > 두 출처가 본문이 일치하는 것 > Bugs·utaten·Genius·LRCLIB
// "진짜 그 곡의 가사"가 최우선: 일본 곡이면 가나가 없는 후보(한글 발음·로마자 표기)는 버리고, 같은 영상 설명란의
// 가사와 본문이 거의 안 겹치는 싱크 가사는 다른 곡으로 보고 설명란 가사를 쓴다. 최종 판정은 자동 싱크가 소리로 한다
// (lyrics-align.js — 다른 곡 가사는 연속 일치율 0~6%) — 그래서 후보 목록(alternatives·extras)을 함께 돌려준다.
// opts.musicInfo: 유튜브 음악 카드 {title, artist} 또는 그 Promise / opts.description: 영상 설명(또는 Promise)
async function findLyricsCandidates(title, artist, targetDuration, opts = {}) {
  // 표시 제목(한국어 현지화일 수 있음)과 임베드가 아는 원어 제목을 함께 검색어로 — 어느 표기로 등록돼 있든 찾게
  let videoQueries = buildLyricQueries(title, artist);
  for (const alt of opts.alt || []) {
    if (alt && alt.title) videoQueries = mergeQueries(videoQueries, buildLyricQueries(alt.title, alt.artist), false);
  }
  let card = await withTimeout(opts.musicInfo, 1500); // 카드는 보통 0.2~0.4초 — 늦으면 영상 제목만으로 간다
  if (!card || !card.title) card = cardFromDescription(await withTimeout(opts.description, 300)) || card;
  let queries = card && card.title ? mergeQueries(buildCardQueries(card), videoQueries) : videoQueries;
  // 1단계 — 곡 정보 확인(iTunes): 원어 곡명·가수("ポッペンキュート / 東京真中")를 찾아 모든 출처의 검색어 앞쪽에 넣는다
  const identities = (await withTimeout(identifySong(queries, targetDuration), 1500)) || [];
  for (const id of identities) {
    const idq = buildCardQueries(id);
    const merged = mergeQueries(queries, idq, false);
    // 원어 곡명 조합을 둘째 자리로 — 출처마다 앞쪽 몇 조합만 검색하므로 뒤에 붙이면 잘린다
    merged.pairs = [queries.pairs[0], ...idq.pairs.slice(0, 2), ...merged.pairs.slice(1)].filter((p, i, arr) => p && arr.findIndex((x) => x && x.title === p.title && x.artist === p.artist) === i);
    queries = merged;
  }

  const kanaRe = /[\u3040-\u30ff]/;
  // 일본 곡에 가나 없는 가사(한글 발음 표기·로마자)는 그 곡의 "가사 원문"이 아니다
  const langOk = (c) => !queries.expectJapanese || c.source === 'alsong' || kanaRe.test((c.lines || []).map((l) => l.text).join(''));
  const strictAccept = (hit) => { const m = lyricMatchScore({ title: hit.title, artist: hit.artist }, queries, 0); return m.accepted && m.artist > 0; };
  const asCandidate = (c) => ({ ...lyricCandidate(c.source, c), plain: !!c.plain });

  // 설명란 가사 — 같은 영상이라 가장 믿을 만한 텍스트 가사
  const descPromise = Promise.resolve(opts.description)
    .then((d) => (d ? extractDescriptionLyrics(d, { lang: queries.expectJapanese ? 'ja' : '' }) : null))
    .then((d) => (d && d.lines.length >= 8 ? { ...lyricCandidate('desc', { id: opts.videoId || '', title: (card && card.title) || queries.titles[0] || title, artist: (card && card.artist) || queries.artists[0] || artist, lines: d.lines }), plain: true, marked: !!d.marked } : null))
    .catch(() => null);
  // 텍스트 가사 출처(utaten·Genius)는 느려서(2~5초) 백그라운드 — 싱크 가사를 못 찾았을 때만 기다린다
  // 느린 텍스트 가사 출처(utaten·Genius·웹 검색)는 필요할 때만 — 싱크 가사가 없거나, 소리 검증이 지금 가사를 거부했을 때.
  // 곡마다 미리 돌리면 곡을 빨리 넘길 때 검색 사이트가 요청을 막는다(실측: 야후 429, NetEase 빈 응답).
  const webPairs = [...identities, ...(queries.pairs || []).slice(0, 1)];
  let extrasPromise = null;
  const extras = () => extrasPromise || (extrasPromise = Promise.all([
    queries.expectJapanese || !/[\uac00-\ud7a3]/.test(`${title} ${artist}`) ? fetchUtatenCandidates(queries, strictAccept).catch(() => []) : [],
    fetchGeniusCandidates(queries, strictAccept).catch(() => []),
    // 2단계 — 웹 검색(야후 재팬)으로 가사 사이트 페이지를 찾아 본문을 받는다
    fetchWebLyricsCandidates(webPairs, strictAccept).catch(() => []),
  ]).then((lists) => {
    const all = lists.flat().map(asCandidate).filter(langOk);
    return all.filter((c, i) => all.findIndex((o) => lyricOverlap(o.lines, c.lines) >= 0.8) === i); // 같은 본문은 한 번만
  }).catch(() => []));

  // 보조 출처는 처음부터 병렬로 — 단 알송에서 ①이 먼저 나오면 결과를 쓰지 않는다
  const refsPromise = Promise.all([
    fetchLrclibCandidates(queries, targetDuration),
    fetchNeteaseCandidates(queries, targetDuration),
    fetchBugsCandidates(queries, strictAccept).then((list) => list.map(asCandidate)).catch(() => []),
  ]).then(([lrclib, netease, bugs]) => rankLyricCandidates([...lrclib, ...netease, ...bugs].filter(langOk), queries, targetDuration)
    .filter((c) => c.match.accepted));

  const alsong = (await resolveAlsongCandidates(queries, targetDuration)).filter((c) => c.match.accepted);
  const strongKorean = alsong.find((c) => c.hasKorean && c.match.artist > 0);
  const desc = await withTimeout(descPromise, 1500);
  // 설명란에 "歌詞/가사/Lyrics"로 표시된 가사와 본문이 거의 안 겹치는 싱크 가사 = 다른 곡일 가능성이 높다.
  // 표시 없는 덩어리는 곡 소개 글일 수도 있어 이 판단에 쓰지 않는다(맞는 싱크 가사를 밀어낼 수 있다)
  const conflictsWithDesc = (c) => !!desc && desc.marked && desc.lines.length >= 12 && (c.lines || []).length >= 8 && lyricOverlap(c.lines, desc.lines) < 0.1;
  const finish = (best, others) => {
    const pool = [...others, ...(desc && best !== desc ? [desc] : [])].filter((c) => c && c !== best);
    // 같은 본문(겹침 70% 이상)의 다른 등록본은 한 번만 — 소리 검증에는 본문이 다른 후보가 쓸모 있다
    const alternatives = [];
    for (const c of pool) {
      if (alternatives.length >= 4) break;
      if (best && lyricOverlap(c.lines, best.lines) >= 0.7 && !!c.plain === !!best.plain) continue;
      if (alternatives.some((a) => lyricOverlap(c.lines, a.lines) >= 0.7)) continue;
      alternatives.push(c);
    }
    return { best, alternatives, extras };
  };

  if (strongKorean && !conflictsWithDesc(strongKorean)) {
    refsPromise.catch(() => {});
    return finish(preferKoreanLabel(strongKorean, alsong, queries), alsong.filter((c) => c !== strongKorean));
  }

  const refs = await refsPromise.catch(() => []);
  const syncedRefs = refs.filter((c) => !c.plain && !conflictsWithDesc(c));
  const strongRef = syncedRefs.find((c) => c.match.artist > 0) || null;
  const others = [...syncedRefs, ...alsong.filter((c) => !conflictsWithDesc(c)), ...refs.filter((c) => c.plain)];

  const weakKorean = alsong.filter((c) => c.hasKorean && !conflictsWithDesc(c));
  if (weakKorean.length) {
    // 확실한 참조가 없으면 예전처럼 받는다(재생시간·문자 체계 검사는 이미 통과). 참조가 있으면 본문이 겹쳐야 한다.
    if (!strongRef) return finish(preferKoreanLabel(weakKorean[0], alsong, queries), others);
    const verified = weakKorean.find((c) => lyricOverlap(c.lines, strongRef.lines) >= 0.3);
    // 본문은 같은 곡인데 가수 칸이 다른 등록본(예: "Lemon / 하츠네 미쿠" = 커버 등록본) — 가사는 쓰고 표기는 참조 곡으로
    if (verified) return finish({ ...preferKoreanLabel(verified, alsong, queries), artist: strongRef.artist || verified.artist }, others);
  }
  if (strongRef) return finish(markLyricLanguage(strongRef, true), others);
  const alsongOriginal = alsong.find((c) => c.match.artist > 0 && !conflictsWithDesc(c));
  if (alsongOriginal) return finish(markLyricLanguage(alsongOriginal, true), others);
  if (syncedRefs.length) return finish(markLyricLanguage(syncedRefs[0], true), others);
  // 이름만 비슷한 다른 곡을 보여주느니 "찾지 못함"이 낫다 — 남은 알송 후보는 동명이곡 검사까지 통과한 것
  const alsongRest = alsong.filter((c) => !conflictsWithDesc(c));
  if (alsongRest.length) return finish(markLyricLanguage(alsongRest[0], true), others);

  // ⑥ 텍스트 가사: 설명란 → 두 출처가 일치하는 본문 → 나머지(곡명·가수 모두 일치한 것만)
  const texts = [...(await withTimeout(extras(), 9000) || []), ...refs.filter((c) => c.plain)];
  const plainOut = (c) => ({ ...markLyricLanguage(c), plain: true, fallbackNotice: '싱크 없는 가사' });
  // 설명란 덩어리는 표시가 있거나, 다른 출처 본문과 겹치거나, 다른 후보가 아예 없을 때만 믿는다
  const descOk = desc && (desc.marked || !texts.length || texts.some((o) => lyricOverlap(desc.lines, o.lines) >= 0.3));
  if (descOk) return finish(plainOut(desc), texts);
  const agreed = texts.find((c) => texts.some((o) => o !== c && o.source !== c.source && lyricOverlap(c.lines, o.lines) >= 0.5));
  const firstText = agreed || texts[0];
  if (firstText) return finish(plainOut(firstText), texts.filter((c) => c !== firstText));
  return finish(null, []);
}

// 음원 자동 생성 영상(…- Topic)의 저작권 설명: "Provided to YouTube by 유통사\n\n곡명 · 가수 · 가수2\n\n앨범…" —
// 음악 카드가 없을 때 이 줄을 카드처럼 쓴다(곡명·가수가 정확히 적혀 있다)
function cardFromDescription(desc) {
  const lines = String(desc || '').split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l) => /^Provided to YouTube by /i.test(l));
  if (at < 0) return null;
  const line = lines.slice(at + 1).find((l) => l);
  if (!line || !line.includes(' · ')) return null;
  const [title, ...artists] = line.split(' · ').map((x) => x.trim()).filter(Boolean);
  return title && artists.length ? { title, artist: artists.join(', ') } : null;
}

// 예전 호출 방식(가사 하나) — 측정 하네스 등
async function findLyricsForTrack(title, artist, targetDuration, opts = {}) {
  const { best } = await findLyricsCandidates(title, artist, targetDuration, opts);
  return best;
}

// 사용자 직접 검색(가사 검색 창) — 고르는 건 사용자라 기준을 느슨하게(제목이 비슷하면) 넓게 보여 준다.
// 텍스트 가사(Bugs 본문·utaten·Genius)도 함께 — 고르면 자동 싱크가 소리에 맞춘다.
async function searchAllLyrics(title, artist) {
  const queries = buildLyricQueries(title, artist);
  const loose = (hit) => bestCandidateTitleScore({ title: hit.title }, queries.titles) >= 0.5;
  const asCandidate = (c) => ({ ...lyricCandidate(c.source, c), plain: !!c.plain });
  const [alsong, lrclib, netease, bugs, utaten, genius] = await Promise.all([
    resolveAlsongCandidates(queries, 0),
    fetchLrclibCandidates(queries, 0),
    fetchNeteaseCandidates(queries, 0),
    fetchBugsCandidates(queries, loose).catch(() => []),
    fetchUtatenCandidates(queries, loose).catch(() => []),
    fetchGeniusCandidates(queries, loose).catch(() => []),
  ]);
  const others = rankLyricCandidates([...lrclib, ...netease, ...bugs.map(asCandidate), ...utaten.map(asCandidate), ...genius.map(asCandidate)], queries, 0);
  const hasKoreanAlsong = alsong.some((candidate) => candidate.hasKorean);
  return [
    ...alsong.map((candidate) => markLyricLanguage(candidate, !hasKoreanAlsong)),
    ...others.map((candidate) => ({ ...markLyricLanguage(candidate, !hasKoreanAlsong), ...(candidate.plain ? { plain: true, fallbackNotice: '싱크 없는 가사' } : {}) })),
  ].slice(0, 24);
}

// 검색 전후로 읽어 그 사이 요청이 끝내 실패했는지 판단한다 (실패 + 못 찾음 = 캐시하지 말고 나중에 다시)
function lyricFailureCount() {
  return lyricRequestFailures;
}

module.exports = {
  lyricFailureCount,
  hasHangul,
  parseLrc,
  buildLyricQueries,
  lyricMatchScore,
  rankLyricCandidates,
  resolveLyricCandidate,
  findLyricsForTrack,
  findLyricsCandidates,
  searchAllLyrics,
};
