// 자동 싱크 정렬기 — 소리에서 들은 글자(whisper)와 가사 본문을 "발음 글자열"로 바꿔 맞춰 가사 줄의 시작 시각을 정한다.
// 1) 들은 글자 + 시각 → 로마자 발음열   2) 가사 본문 → 로마자 발음열   3) 두 발음열을 편집 거리로 정렬
// 로마자: 일본어는 kuromoji 읽기(가타카나) → 로마자, 한국어는 한글 자모 → 로마자, 영어는 글자 그대로.
// 같은 들은 글자열로 여러 가사 후보를 채점할 수 있어 "이 가사가 정말 이 곡의 가사인지"도 소리로 판정한다.
// 실측(/root/asrtest, whisper small-q8_0, 2026-10-04): 맞는 가사 줄 99%가 ±1초 안, 연속 일치율 82~84% /
// 다른 곡 가사는 연속 일치율 1~6%. kuromoji 토크나이저는 호출하는 쪽(가사 워커)이 넘긴다 — 이 모듈은 순수 함수뿐.

const KANA = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o', カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko', サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to', ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no', ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo', ヤ: 'ya', ユ: 'yu', ヨ: 'yo', ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa', ヲ: 'o', ン: 'n',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go', ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo', ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo', パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po', ヴ: 'vu',
  ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ャ: 'ya', ュ: 'yu', ョ: 'yo', ッ: '', ー: '', ヮ: 'wa', ヵ: 'ka', ヶ: 'ke',
};
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

function kataToRomaji(k) {
  let out = '';
  for (let i = 0; i < k.length; i++) {
    const c = k[i];
    if (c === 'ッ') { const nx = KANA[k[i + 1]]; if (nx) out += nx[0]; continue; }
    if (c === 'ー') { const m = out.match(/[aeiou]$/); if (m) out += m[0]; continue; }
    if ('ャュョ'.includes(c) && out.length) { out = out.replace(/i$/, '') + KANA[c]; continue; }
    if ('ァィゥェォ'.includes(c) && out.length) { out = out.replace(/[aeiou]$/, '') + KANA[c]; continue; }
    out += KANA[c] != null ? KANA[c] : '';
  }
  return out;
}

const CHO = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const JUNG = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const JONG = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
function hangulToRoman(ch) {
  const c = ch.charCodeAt(0) - 0xac00;
  if (c < 0 || c > 11171) return null;
  return CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + JONG[c % 28];
}

const CJK_RE = /[぀-ヿ一-鿿]/;

function romanChar(ch, pos, push) {
  const h = hangulToRoman(ch);
  if (h != null) push(h, pos);
  else if (/[a-z]/i.test(ch)) push(ch.toLowerCase(), pos);
}

// 텍스트 → [{ch, pos}] : 로마자 한 글자마다 원문 글자 위치(pos)
function romanize(text, tokenizer) {
  const out = [];
  const push = (str, pos) => { for (const ch of str) out.push({ ch, pos }); };
  if (tokenizer && CJK_RE.test(text)) {
    let pos = 0;
    for (const t of tokenizer.tokenize(text)) {
      const surf = t.surface_form;
      const start = text.indexOf(surf, pos);
      const p = start >= 0 ? start : pos;
      if (CJK_RE.test(surf)) {
        const reading = t.reading && t.reading !== '*' ? t.reading : toKata(surf);
        push(kataToRomaji(toKata(reading)), p);
      } else {
        for (let i = 0; i < surf.length; i++) romanChar(surf[i], p + i, push);
      }
      pos = p + surf.length;
    }
  } else {
    for (let i = 0; i < text.length; i++) romanChar(text[i], i, push);
  }
  return out;
}

// 들은 조각들 [{text, t0, t1, tokens?:[{text, t}]}] → 발음열 [{ch, t}] (시각은 ms)
function heardSequence(segments, tokenizer) {
  const seq = [];
  for (const seg of segments) {
    const toks = seg.tokens && seg.tokens.length ? seg.tokens : [{ text: seg.text, t: seg.t0, t1: seg.t1 }];
    let text = '';
    const charTime = [];
    toks.forEach((tok, k) => {
      const s = String(tok.text || '').replace(/�/g, '');
      const t0 = tok.t;
      const t1 = toks[k + 1] ? toks[k + 1].t : (tok.t1 != null ? tok.t1 : seg.t1);
      for (let i = 0; i < s.length; i++) charTime.push(t0 + ((Math.max(t0, t1) - t0) * i) / Math.max(1, s.length));
      text += s;
    });
    for (const r of romanize(text, tokenizer)) seq.push({ ch: r.ch, t: charTime[r.pos] != null ? charTime[r.pos] : seg.t0 });
  }
  return seq;
}

// 가사 줄 → 발음열 [{ch, line, k}] (k: 줄 안 순번). 블록의 첫 줄(원문)만 쓴다 — 발음·번역 줄은 노래가 아니다.
function lyricSequence(lines, tokenizer) {
  const seq = [];
  lines.forEach((line, li) => {
    const original = String(line.text || '').split('\n')[0];
    romanize(original, tokenizer).forEach((r, k) => seq.push({ ch: r.ch, line: li, k }));
  });
  return seq;
}

const VOWELS = new Set('aeiou');

// 겹침 정렬: 가사의 앞뒤(아직 안 들은 부분)와 들은 쪽의 뒤(끝 군더더기)는 벌점 없음. 들은 쪽 앞부분을 건너뛰는 데는
// 작은 벌점(틈의 1/4)을 준다 — 완전히 공짜면 whisper가 같은 줄을 되풀이(환각)했을 때 진짜 첫 부분을 버리고 뒤의 복사본에
// 맞춰 버린다(실측: 0초부터 부른 줄이 13초로 잡힘). 점수(×4 정수): 같은 글자 +12, 모음끼리 0, 다른 글자 -4, 틈 -4, 앞 건너뛰기 -1.
// 반환: 가사 글자마다 맞춘 들은 글자 번호(-1 = 없음)
function align(L, H) {
  const n = L.length;
  const m = H.length;
  const match = new Array(n).fill(-1);
  if (!n || !m) return match;
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const back = new Uint8Array((n + 1) * W); // 1=대각, 2=가사만, 3=들은 쪽만
  for (let i = 1; i <= n; i++) back[i * W] = 2;
  for (let j = 1; j <= m; j++) { back[j] = 3; score[j] = -j; }
  for (let i = 1; i <= n; i++) {
    const a = L[i - 1].ch;
    const row = i * W;
    const prev = (i - 1) * W;
    for (let j = 1; j <= m; j++) {
      const b = H[j - 1].ch;
      const sub = a === b ? 12 : (VOWELS.has(a) && VOWELS.has(b)) ? 0 : -4;
      let best = score[prev + j - 1] + sub;
      let bk = 1;
      const up = score[prev + j] - 4;
      if (up > best) { best = up; bk = 2; }
      const left = score[row + j - 1] - 4;
      if (left > best) { best = left; bk = 3; }
      score[row + j] = best;
      back[row + j] = bk;
    }
  }
  // 끝점: 마지막 행(가사를 다 씀) 또는 마지막 열(들은 것을 다 씀) 중 최고점
  let bi = n;
  let bj = 0;
  let bestEnd = -Infinity;
  for (let j = 0; j <= m; j++) if (score[n * W + j] > bestEnd) { bestEnd = score[n * W + j]; bi = n; bj = j; }
  for (let i = 0; i <= n; i++) if (score[i * W + m] > bestEnd) { bestEnd = score[i * W + m]; bi = i; bj = m; }
  let i = bi;
  let j = bj;
  while (i > 0 && j > 0) {
    const bk = back[i * W + j];
    if (bk === 1) { if (L[i - 1].ch === H[j - 1].ch) match[i - 1] = j - 1; i--; j--; } else if (bk === 2) i--; else j--;
  }
  return match;
}

// 연속 일치(4글자 이상 이어진 구간)에 든 가사 글자 수 — 우연한 낱글자 일치는 흩어져 있어 거의 0이 된다
function runMatched(match) {
  let run = 0;
  let total = 0;
  for (let i = 0; i <= match.length; i++) {
    const cont = i < match.length && match[i] >= 0 && (run === 0 || match[i] === match[i - 1] + 1);
    if (cont) run += 1;
    else {
      if (run >= 4) total += run;
      run = i < match.length && match[i] >= 0 ? 1 : 0;
    }
  }
  return total;
}

const RATE_MS = 70; // 노래에서 로마자 한 글자에 걸리는 평균 시간(근사) — 줄 앞쪽이 안 들렸을 때 시작 시각을 거슬러 잡는 데 쓴다

// 줄마다 시작 시각을 정한다. 일치가 적은 줄(25% 미만)이나 3글자 이상 연속으로 맞은 곳이 없는 줄은 비워 두고(null)
// 나중에 채운다 — 거의 못 들은 줄이 흩어진 낱글자 일치로 엉뚱한 곳에 몰리는 것을 막는다(실측: 첫 5줄이 같은 시각에 겹침)
function anchorLines(lineCount, L, H, match) {
  const per = Array.from({ length: lineCount }, () => []);
  const totals = new Array(lineCount).fill(0);
  for (const x of L) totals[x.line] += 1;
  L.forEach((x, idx) => { if (match[idx] >= 0) per[x.line].push({ k: x.k, j: match[idx], t: H[match[idx]].t }); });
  return per.map((ms, li) => {
    if (!totals[li] || ms.length < Math.max(2, totals[li] * 0.25)) return null;
    let longest = 1;
    let run = 1;
    for (let i = 1; i < ms.length; i++) {
      run = ms[i].k === ms[i - 1].k + 1 && ms[i].j === ms[i - 1].j + 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    if (longest < Math.min(3, totals[li])) return null;
    const head = ms.slice(0, Math.min(5, ms.length)).map((x) => x.t - x.k * RATE_MS).sort((a, b) => a - b);
    return Math.max(0, head[Math.floor(head.length / 2)]);
  });
}

// 1차(대략) 싱크: 줄들을 [start, end) 구간에 같은 간격으로 놓는다
function evenTimes(count, start, end) {
  const span = Math.max(0, end - start);
  return Array.from({ length: count }, (_, i) => Math.round(start + (span * i) / Math.max(1, count)));
}

// 아직 못 맞춘 줄의 시각 예측(중간 단계 싱크) — 맞춘 줄은 그대로 두고:
// · 맞춘 줄 사이: 줄 길이(발음 글자 수) 비례로 나눈다
// · 맨 앞(첫 맞춘 줄 이전): 맞춘 구간에서 잰 노래 빠르기(ms/글자)로 거슬러 올라간다(0초 아래면 0~첫 줄에 고르게)
// · 뒤(아직 안 들은 줄): 마지막 맞춘 줄에서 빠르기대로 이어 간다. 이미 그 뒤를 한참 들었는데(heardUntil) 가사가 안
//   나왔으면(간주) 들은 지점 뒤에서 시작한다. 곡 끝을 넘으면 남은 시간에 맞춰 줄인다.
// · 맞춘 줄이 하나도 없음: 들은 구간엔 목소리가 없었다(전주) → 들은 지점부터 목소리 끝 추정까지 줄 길이 비례.
//   예전엔 곡 전체(0초~끝)에 같은 간격이라 전주·후주만큼 어긋났다(사용자 지적: 목소리 시작~끝 구간으로).
// 맞춘 줄끼리 순서가 뒤집히거나 0.25초 안으로 붙으면 그 줄은 버린다(같은 시각에 쌓이지 않게).
const DEFAULT_PACE = 90; // ms/발음 글자 — 맞춘 줄이 2개 미만일 때
function fillTimes(anchors, durationMs, opts = {}) {
  const n = anchors.length;
  const w = (opts.letters || new Array(n).fill(12)).map((x) => Math.max(4, x || 0)); // 줄 무게(짧은 줄도 최소 시간)
  const a = anchors.slice();
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    if (a[i] < last + 250) a[i] = null; else last = a[i];
  }
  const dur = durationMs > 0 ? durationMs : 0;
  const vocalEnd = dur > 0 ? dur - Math.min(10000, dur * 0.06) : 0;
  const heardUntil = Math.max(0, opts.heardUntil || 0);
  const spread = (from, to, list) => { // list = 줄 번호들 — [from, to)에 무게 비례
    const total = list.reduce((s, i) => s + w[i], 0) || 1;
    let acc = 0;
    for (const i of list) { times[i] = Math.round(from + ((to - from) * acc) / total); acc += w[i]; }
  };
  const times = new Array(n);
  const idx = [];
  for (let i = 0; i < n; i++) if (a[i] != null) idx.push(i);
  const all = [...Array(n).keys()];
  if (!idx.length) {
    // 들은 지 20초가 안 됐으면 아직 모른다(첫 10초 창은 whisper가 목소리가 있어도 못 알아듣는 일이 있다) — 0초부터
    const from = heardUntil >= 20000 ? Math.min(heardUntil, Math.max(0, (vocalEnd || n * 3000) - n * 1500)) : 0;
    spread(from, Math.max(from + n * 1500, vocalEnd || from + n * 3000), all);
    return times;
  }
  for (const i of idx) times[i] = Math.round(a[i]);
  // 빠르기: 이웃한 맞춘 줄 사이(간주가 낀 쌍은 빼고)의 ms/글자 중앙값
  const rates = [];
  for (let k = 0; k + 1 < idx.length; k++) {
    const p = idx[k];
    const q = idx[k + 1];
    let weight = 0;
    for (let i = p; i < q; i++) weight += w[i];
    const gap = a[q] - a[p];
    if (gap > 0 && gap < 8000 * (q - p)) rates.push(gap / weight);
  }
  rates.sort((x, y) => x - y);
  const pace = rates.length >= 2 ? rates[rates.length >> 1] : DEFAULT_PACE;
  // 사이
  for (let k = 0; k + 1 < idx.length; k++) {
    const p = idx[k];
    const q = idx[k + 1];
    if (q - p > 1) {
      const list = [];
      for (let i = p; i < q; i++) list.push(i);
      spread(a[p], a[q], list);
      times[p] = Math.round(a[p]);
    }
  }
  // 앞쪽
  const first = idx[0];
  if (first > 0) {
    let t = a[first];
    for (let i = first - 1; i >= 0; i--) { t -= pace * w[i]; times[i] = Math.round(t); }
    if (times[0] < 0) spread(0, a[first], [...Array(first).keys()]);
  }
  // 뒤쪽(아직 안 들은 줄)
  const lastIdx = idx[idx.length - 1];
  if (lastIdx < n - 1) {
    let t = a[lastIdx] + pace * w[lastIdx];
    if (heardUntil > t + 6000) t = heardUntil; // 들은 구간 끝까지 가사가 없었다 = 간주 — 그 뒤에서 이어 간다
    const tail = [];
    for (let i = lastIdx + 1; i < n; i++) tail.push(i);
    const need = tail.reduce((s, i) => s + pace * w[i], 0);
    const limit = dur > 0 ? dur - 2000 : Infinity;
    if (t + need <= limit) {
      for (const i of tail) { times[i] = Math.round(t); t += pace * w[i]; }
    } else {
      spread(Math.min(t, limit - 1000 * tail.length), limit, tail);
    }
  }
  return times;
}

// 한 후보 가사를 들은 글자열에 맞춘다. 반환: 줄 시각(빈 줄 채움 포함), 맞춘 줄 표시, 채점
// opts.heardUntilMs: 여기까지 들었다(그 뒤 줄은 아직 대략 싱크) / opts.durationMs: 곡 길이
function alignLyrics(lines, heard, tokenizer, opts = {}) {
  const L = lyricSequence(lines, tokenizer);
  const H = Array.isArray(heard) && heard.length && heard[0].ch != null ? heard : heardSequence(heard || [], tokenizer);
  const match = align(L, H);
  const anchors = anchorLines(lines.length, L, H, match);
  const letters = new Array(lines.length).fill(0);
  for (const x of L) letters[x.line] += 1;
  const run = runMatched(match);
  // 들은 글자 중 연속 일치 비율 — 맞는 가사 80%대, 다른 곡 0~6%(실측). 들은 게 적으면 판단 보류
  const precision = H.length ? run / H.length : 0;
  // 가사 글자 중 지금까지 들은 구간에 해당하는 부분 대비
  const times = fillTimes(anchors, opts.durationMs || 0, { letters, heardUntil: opts.heardUntil || 0 });
  return {
    times,
    anchored: anchors.map((x) => x != null),
    score: { run, heard: H.length, lyric: L.length, precision, coverage: L.length ? run / L.length : 0 },
  };
}

// 판정: 'match' | 'mismatch' | 'unsure' — 들은 글자가 충분할 때만 판정한다
function verdict(score) {
  if (score.heard < 150) return 'unsure';
  if (score.precision >= 0.3) return 'match';
  if (score.precision < 0.12) return 'mismatch';
  return 'unsure';
}

module.exports = {
  romanize,
  heardSequence,
  lyricSequence,
  align,
  alignLyrics,
  evenTimes,
  fillTimes,
  verdict,
  kataToRomaji,
};
