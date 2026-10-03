// v1.31.0(배포본) 가사 검색 그대로 — 기준 측정용
const http = require('http');
const ALSong_ENC_DATA = '8456ec35caba5c981e705b0c5d76e4593e020ae5e3d469c75d1c6714b6b1244c0732f1f19cc32ee5123ef7de574fc8bc6d3b6bd38dd3c097f5a4a1aa1b438fea0e413baf8136d2d7d02bfcdcb2da4990df2f28675a3bd621f8234afa84fb4ee9caa8f853a5b06f884ea086fd3ed3b4c6e14f1efac5a4edbf6f6cb475445390b0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
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

async function findLyricsForTrack(title, artist, targetDuration) {
  const queries = buildLyricQueries(title, artist);
  const alsong = (await resolveAlsongCandidates(queries, targetDuration)).filter((c) => c.match.accepted);
  const korean = alsong.find((candidate) => candidate.hasKorean);
  if (korean) return preferKoreanLabel(korean, alsong, queries);

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

module.exports = { findLyricsForTrack, buildLyricQueries };
