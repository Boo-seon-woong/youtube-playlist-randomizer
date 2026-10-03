// 웹 번역 — 무료 웹 번역기(Bing 번역기 → 구글 번역)로 가사 줄들을 한국어로 옮긴다.
// 내장 모델 번역(mt-worker.js)과 별개인 표시 모드 'web' / 'pron+web'용. 유튜브 재생 자체가 온라인이라 네트워크 의존은
// 문제가 되지 않고, 정답(알송 사람 번역)이 있는 J-pop 7곡 + 속어 곡 53줄 비교(2026-10-04)에서 내장 1.8B 모델보다
// 확실히 자연스러웠으며 곡 전체가 1~3초에 끝난다. CPU를 거의 쓰지 않아 메인 프로세스에서 돌린다.
// Electron 비의존 순수 Node 모듈 — 하네스로 바로 돌려볼 수 있다.
//
// - Bing(www.bing.com/ttranslatev3): 품질 최상 — "写真なんて紙切れだ" → "사진 같은 건 종잇조각일 뿐",
//   "ズル休みしよう" → "몰래 쉬자". 번역기 페이지에서 IG·IID·key·token·쿠키를 긁어 쓴다(토큰 수명 약 1시간).
//   여러 줄을 \n으로 이어 보내면 문맥을 보고 번역하지만 가끔 두 줄을 한 줄로 합쳐 줄 수가 어긋난다
//   (King Gnu 白日: 61줄 → 58줄 실측) — 그 묶음은 반으로 나눠 다시 보낸다.
// - Google(translate-pa.googleapis.com, 웹 번역 위젯 te_lib의 공개 키): 배열 입출력이라 줄이 절대 어긋나지 않고 0.2초.
//   품질은 한 단계 아래("溢れてやまない" → "넘치지 않는")라 Bing이 실패하거나 작은 묶음까지 어긋날 때만 쓴다.
//   HTML 번역 API라 입력을 이스케이프하고 출력의 엔터티를 푼다(안 하면 "<fine>" 같은 꺾쇠 낱말이 사라진다).
// - translate.googleapis.com(gtx)은 429, MS Edge 번역 토큰(edge.microsoft.com/translate/auth)은 404로 막혀 있다(실측).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000; // Bing은 55줄 한 묶음에 7.4초까지 걸렸다(실측)
// 묶음 크기: Bing 무료 웹 한도는 1000자 안팎. 800자(곡당 1묶음)와 400자(2~3묶음 동시)가 곡당 3~6초로 같았고,
// 작은 묶음이 한 요청 시간이 짧아 타임아웃 여유가 크며 첫 묶음이 먼저 보인다
const CHUNK_CHARS = 400;
const BING_COOLDOWN_MS = 10 * 60 * 1000; // Bing이 막히면 그동안은 바로 구글로 (매 묶음 타임아웃을 기다리지 않게)

let bingAuth = null; // { ig, iid, key, token, cookie, expires }
let bingAuthPromise = null;
let bingDownUntil = 0;

async function fetchBingAuth() {
  const page = await fetch('https://www.bing.com/translator', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const html = await page.text();
  const ig = html.match(/IG:"([^"]+)"/);
  const abuse = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]/);
  if (!ig || !abuse) throw new Error('bing auth: page shape changed');
  return {
    ig: ig[1],
    iid: (html.match(/data-iid="([^"]+)"/) || [])[1] || 'translator.5028',
    key: abuse[1],
    token: abuse[2],
    cookie: page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
    expires: Date.now() + Math.max(60000, Number(abuse[3]) - 5 * 60 * 1000),
  };
}

function getBingAuth(force) {
  if (force) bingAuth = null;
  if (bingAuth && Date.now() < bingAuth.expires) return Promise.resolve(bingAuth);
  if (!bingAuthPromise) {
    bingAuthPromise = fetchBingAuth()
      .then((auth) => (bingAuth = auth))
      .finally(() => { bingAuthPromise = null; });
  }
  return bingAuthPromise;
}

async function bingTranslate(lines, retried = false) {
  const auth = await getBingAuth(retried);
  const body = new URLSearchParams({ fromLang: 'auto-detect', to: 'ko', text: lines.join('\n'), token: auth.token, key: auth.key });
  const res = await fetch(`https://www.bing.com/ttranslatev3?isVertical=1&IG=${auth.ig}&IID=${auth.iid}`, {
    method: 'POST',
    body,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: auth.cookie, Referer: 'https://www.bing.com/translator' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  const text = Array.isArray(json) && json[0] && json[0].translations && json[0].translations[0] && json[0].translations[0].text;
  if (typeof text !== 'string') {
    // 토큰 만료({statusCode: 205}) 등 — 인증을 새로 받아 한 번만 다시
    if (!retried) return bingTranslate(lines, true);
    throw new Error(`bing ${res.status}`);
  }
  return text.split(/\r?\n/).map((line) => line.trim());
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
});

async function googleTranslate(lines) {
  const res = await fetch('https://translate-pa.googleapis.com/v1/translateHtml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520', 'User-Agent': UA },
    body: JSON.stringify([[lines.map(escapeHtml), 'auto', 'ko'], 'te_lib']),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  const out = Array.isArray(json) && json[0];
  if (!Array.isArray(out) || out.length !== lines.length) throw new Error(`google ${res.status}`);
  return out.map((line) => decodeEntities(String(line)).trim());
}

// 한 묶음: Bing → 줄 수가 어긋나면 반씩 나눠 다시 → 그래도 안 되거나 Bing이 실패하면 구글
async function translateChunk(lines) {
  if (Date.now() >= bingDownUntil) {
    try {
      const out = await bingTranslate(lines);
      if (out.length === lines.length) return out;
      if (lines.length >= 4) {
        const mid = Math.ceil(lines.length / 2);
        const [a, b] = await Promise.all([translateChunk(lines.slice(0, mid)), translateChunk(lines.slice(mid))]);
        return a.concat(b);
      }
    } catch {
      bingDownUntil = Date.now() + BING_COOLDOWN_MS;
    }
  }
  return googleTranslate(lines);
}

// lines: 줄별 원문('' = 번역 안 함). 같은 원문(후렴 반복)은 한 번만 보낸다.
// 묶음 하나가 끝날 때마다 onProgress(지금까지의 ko 배열)를 부른다. complete=false면 일부 묶음이 끝내 실패한 것.
async function translateLines(lines, onProgress) {
  const unique = [...new Set(lines.filter(Boolean))];
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const line of unique) {
    if (cur.length && size + line.length + 1 > CHUNK_CHARS) { chunks.push(cur); cur = []; size = 0; }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.length) chunks.push(cur);
  const done = new Map();
  const snapshot = () => lines.map((line) => (line && done.get(line)) || '');
  let complete = true;
  await Promise.all(chunks.map(async (chunk) => {
    let out;
    try { out = await translateChunk(chunk); } catch { complete = false; return; }
    chunk.forEach((line, k) => done.set(line, out[k] || ''));
    if (onProgress) onProgress(snapshot());
  }));
  return { ko: snapshot(), complete };
}

module.exports = { translateLines };
