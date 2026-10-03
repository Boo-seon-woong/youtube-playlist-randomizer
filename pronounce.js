// 일본어 가사 → 한글 발음 ("真夜中に告ぐ" → "마요나카니츠구")
// 한자 읽기는 kuromoji 형태소 사전(IPADIC)의 발음(pronunciation) 필드를 쓴다 — 조사 は/へ/を가 와/에/오로,
// 장음이 ー로 나온다. 가나 → 한글은 아래 표로 옮기고 ン은 ㄴ받침, ッ는 ㅅ받침으로 붙인다.
// 번역 모델(1.7GB RAM, 줄당 0.5~1초, 실측)과 달리 사전 로드 한 번 후 곡 전체가 수 밀리초다.
const path = require('path');

let tokenizerPromise = null;
let idleTimer = null;

function getTokenizer() {
  clearTimeout(idleTimer);
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      const kuromoji = require('kuromoji');
      const dicPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
      kuromoji.builder({ dicPath }).build((err, tokenizer) => (err ? reject(err) : resolve(tokenizer)));
    });
    tokenizerPromise.catch(() => { tokenizerPromise = null; });
  }
  // 사전은 메모리를 꽤 쓰므로 5분간 안 쓰면 내려놓는다 (다음 곡에서 1초 안팎으로 다시 읽는다)
  idleTimer = setTimeout(() => { tokenizerPromise = null; }, 5 * 60 * 1000);
  if (idleTimer.unref) idleTimer.unref();
  return tokenizerPromise;
}

const BASE = {
  ア: '아', イ: '이', ウ: '우', エ: '에', オ: '오',
  カ: '카', キ: '키', ク: '쿠', ケ: '케', コ: '코',
  ガ: '가', ギ: '기', グ: '구', ゲ: '게', ゴ: '고',
  サ: '사', シ: '시', ス: '스', セ: '세', ソ: '소',
  ザ: '자', ジ: '지', ズ: '즈', ゼ: '제', ゾ: '조',
  タ: '타', チ: '치', ツ: '츠', テ: '테', ト: '토',
  ダ: '다', ヂ: '지', ヅ: '즈', デ: '데', ド: '도',
  ナ: '나', ニ: '니', ヌ: '누', ネ: '네', ノ: '노',
  ハ: '하', ヒ: '히', フ: '후', ヘ: '헤', ホ: '호',
  バ: '바', ビ: '비', ブ: '부', ベ: '베', ボ: '보',
  パ: '파', ピ: '피', プ: '푸', ペ: '페', ポ: '포',
  マ: '마', ミ: '미', ム: '무', メ: '메', モ: '모',
  ヤ: '야', ユ: '유', ヨ: '요',
  ラ: '라', リ: '리', ル: '루', レ: '레', ロ: '로',
  ワ: '와', ヰ: '이', ヱ: '에', ヲ: '오', ヴ: '부',
  ァ: '아', ィ: '이', ゥ: '우', ェ: '에', ォ: '오', ャ: '야', ュ: '유', ョ: '요', ヮ: '와',
};

// 두 글자 조합(요음·외래음) — 먼저 확인한다
const PAIRS = {
  キャ: '캬', キュ: '큐', キョ: '쿄', ギャ: '갸', ギュ: '규', ギョ: '교',
  シャ: '샤', シュ: '슈', ショ: '쇼', シェ: '셰', ジャ: '자', ジュ: '주', ジョ: '조', ジェ: '제',
  チャ: '차', チュ: '추', チョ: '초', チェ: '체', ヂャ: '자', ヂュ: '주', ヂョ: '조',
  ニャ: '냐', ニュ: '뉴', ニョ: '뇨', ヒャ: '햐', ヒュ: '휴', ヒョ: '효',
  ビャ: '뱌', ビュ: '뷰', ビョ: '뵤', ピャ: '퍄', ピュ: '퓨', ピョ: '표',
  ミャ: '먀', ミュ: '뮤', ミョ: '묘', リャ: '랴', リュ: '류', リョ: '료',
  ファ: '화', フィ: '피', フェ: '페', フォ: '포', フュ: '퓨',
  ティ: '티', ディ: '디', トゥ: '투', ドゥ: '두', テュ: '튜', デュ: '듀',
  ウィ: '위', ウェ: '웨', ウォ: '워', イェ: '예', クァ: '콰', グァ: '과', ツァ: '차', ツェ: '체', ツォ: '초',
  ヴァ: '바', ヴィ: '비', ヴェ: '베', ヴォ: '보', ヴュ: '뷰',
};

const toKatakana = (s) => String(s).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

// 이미 받침이 없을 때만 받침을 붙인다 (jong: ㄴ=4, ㅅ=19)
function addFinal(syllable, jong) {
  const code = syllable.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171 || code % 28 !== 0) return null;
  return String.fromCharCode(0xac00 + code + jong);
}

function kanaToHangul(kana) {
  const s = toKatakana(kana);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const pair = s.slice(i, i + 2);
    if (PAIRS[pair]) { out += PAIRS[pair]; i += 1; continue; }
    const c = s[i];
    if (c === 'ン') {
      const last = out.slice(-1);
      const merged = last && addFinal(last, 4);
      out = merged ? out.slice(0, -1) + merged : out + '응';
      continue;
    }
    if (c === 'ッ') {
      const last = out.slice(-1);
      const merged = last && addFinal(last, 19);
      if (merged) out = out.slice(0, -1) + merged;
      continue;
    }
    if (c === 'ー') { out += '-'; continue; }
    out += BASE[c] !== undefined ? BASE[c] : c; // 가나가 아닌 글자(영문·숫자·기호)는 그대로
  }
  return out;
}

const hasKana = (t) => /[ぁ-ゖァ-ヺ]/.test(t);
const hasJapanese = (t) => /[ぁ-ゖァ-ヺ一-鿿々]/.test(t);

// 어절(문절) 단위 띄어쓰기: 조사·조동사·접미사·비자립어·기호는 앞말에 붙이고, 접두사 다음은 붙인다.
// "僕はずっと待ってたんだ" → "보쿠와 즛토 맛테탄다"
function attachesToPrevious(t) {
  return t.pos === '助詞' || t.pos === '助動詞' || t.pos === '記号'
    || t.pos_detail_1 === '接尾' || t.pos_detail_1 === '非自立';
}

// 한 줄 → 한글 발음. 원문의 띄어쓰기는 유지하고, 그 안은 어절 단위로 띄운다.
function pronounceLine(tokenizer, line) {
  const text = String(line || '').trim();
  if (!text || !hasJapanese(text)) return '';
  return text.split(/(\s+)/).map((chunk) => {
    if (!chunk.trim() || !hasJapanese(chunk)) return chunk;
    let out = '';
    let prev = null;
    for (const t of tokenizer.tokenize(chunk)) {
      const reading = t.pronunciation && t.pronunciation !== '*' ? t.pronunciation
        : t.reading && t.reading !== '*' ? t.reading : t.surface_form;
      const glue = !prev || attachesToPrevious(t) || prev.pos === '接頭詞';
      out += (glue ? '' : ' ') + kanaToHangul(reading);
      prev = t;
    }
    return out;
  }).join('').replace(/\s+/g, ' ').trim();
}

// 가사 줄 배열의 첫 줄(원문)마다 발음을 만든다. 일본어가 아닌 곡이면 빈 배열.
async function pronounceLyrics(lines) {
  const originals = (lines || []).map((l) => String(l.text || '').split('\n')[0]);
  if (!originals.some(hasKana)) return []; // 가나가 하나도 없으면 일본어 곡이 아니다(중국어 한자 가사 오독 방지)
  const tokenizer = await getTokenizer();
  return originals.map((line) => pronounceLine(tokenizer, line));
}

module.exports = { pronounceLyrics, kanaToHangul };
