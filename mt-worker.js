// 가사 워커 — 내장 모델 번역 · 일본어 발음 · 자동 싱크(음성 인식 + 정렬)를 맡는 유틸리티 프로세스 (main.js가 utilityProcess.fork로 띄운다).
// 추론을 메인 프로세스에서 분리한 이유: 메인은 UI·오디오 때문에 우선순위를 BELOW_NORMAL까지밖에
// 못 내리는데, 그걸로는 게임 프레임 드랍(30%+)이 남았다. 이 프로세스는 IDLE 우선순위로 돌아
// 시스템이 한가할 때만 CPU를 받는다 — 게임 등 전면 앱이 항상 우선한다. 일본어 발음(pronounce.js)도 여기서 한다.
const path = require('path');
const os = require('os');

try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch {} // Windows에서 IDLE_PRIORITY_CLASS

// 번역 모델: Tencent Hy-MT2-1.8B (2026-05, Apache-2.0, 33개 언어) — llama.cpp(node-llama-cpp)로 GGUF IQ4_XS를 돌린다.
// 예전 M2M100-418M(2020, transformers.js/ONNX)은 RSS 1.7GB에 번역이 딱딱하고 짧은 줄에서 같은 말을 수백 번
// 반복하는 고장이 났다(사용자 PC 캐시 실측). 같은 가사 8줄 비교(2스레드): Hy-MT2 IQ4_XS = RSS 1.29GB, 줄당 약 2초,
// "꿈이라면 얼마나 좋았을까요?" / Gemma3-270M·Qwen2.5-0.5B·Qwen3-0.6B·LMT-60-0.6B는 품질 미달로 탈락.
// 1.25비트판(440MB)은 llama.cpp 전용 커널(STQ)이 정식 배포판에 없어 아직 못 쓴다.
const MODEL_FILE = path.join(__dirname, 'models', 'Hy-MT2-1.8B-IQ4_XS.gguf');
const PROMPT = 'Translate the following text into Korean. Note that you should only output the translated result without any additional explanation:\n\n';

let translatorPromise = null;
function getTranslator() {
  if (!translatorPromise) {
    translatorPromise = (async () => {
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
      // GPU는 쓰지 않는다(게임과 그래픽카드를 다투지 않게). 미리 빌드된 바이너리만 — 사용자 PC에서 컴파일 시도 금지
      const llama = await getLlama({ gpu: false, build: 'never' });
      const model = await llama.loadModel({ modelPath: MODEL_FILE });
      // 2스레드: 프로세스가 IDLE 우선순위라 게임이 CPU를 쓰면 이쪽이 밀린다
      const context = await model.createContext({ contextSize: 512, threads: 2 });
      const sequence = context.getSequence();
      // 생성 슬롯(시퀀스)은 하나뿐이라 번역은 반드시 한 번에 하나씩 — 잡 두 개가 겹쳐 같은 시퀀스를 쓰면
      // 서로의 문맥을 지우고 끼어들어 두 곡의 번역이 모두 뒤섞였다(실측: "불한 미소에 불", "먹고기들도 각자")
      let busy = Promise.resolve();
      const exclusive = (fn) => { const run = busy.then(fn, fn); busy = run.catch(() => {}); return run; };
      return (text) => exclusive(async () => {
        await sequence.clearHistory(); // 줄마다 독립 — 앞 줄 문맥이 번역을 끌고 가지 않게
        const session = new LlamaChatSession({ contextSequence: sequence, autoDisposeSequence: false });
        try {
          return await session.prompt(PROMPT + text, {
            maxTokens: Math.min(128, text.length * 3 + 16),
            temperature: 0,
            repeatPenalty: { penalty: 1.05 },
          });
        } finally {
          session.dispose({ disposeSequence: false });
        }
      });
    })();
    translatorPromise.catch(() => { translatorPromise = null; }); // 로드 실패 시 다음 잡에서 재시도
  }
  return translatorPromise;
}

// 소형 모델이 반복 루프에 빠지는 경우(예전 M2M100 실측: "나 나 나 …" 수백 개)를 대비한 안전장치 —
// 남은 연속 반복은 두 번까지로 줄이고 길이를 원문에 비례해 자른다.
function cleanTranslation(text, source) {
  let t = String(text || '').trim();
  t = t.replace(/(\S+)(?:\s+\1){2,}/g, '$1 $1'); // 같은 낱말 3번 이상 연속 → 2번
  t = t.replace(/(.{2,12}?)\1{2,}/g, '$1$1'); // 띄어쓰기 없는 반복 덩어리
  const limit = Math.max(24, source.length * 4);
  return t.length > limit ? t.slice(0, limit).trim() + '…' : t;
}

// 잡: 번역 {id, lines: string[] (빈 문자열 = 생략), order?: number[]} → 줄마다 {type:'line', id, index, ko}, 끝나면 {type:'done', id}
//     발음 {id, type:'pron', lines: string[]} → {type:'done', id, result: string[]} (일본어 → 한글 발음, 수 밀리초)
// 번역을 끄면 main이 {type:'cancel', id}를 보낸다 — 남은 줄을 바로 그만둔다(CPU를 계속 쓰지 않게)
const cancelled = new Set();

// ── 자동 싱크: 음성 인식(asr) · 정렬(align) ──
// asr  {id, type:'asr', pcm: Int16Array(16kHz 모노), lang, offsetMs, prompt} → {type:'done', id, result: [{t0,t1,text,tokens}]}
//      whisper-cli를 IDLE 우선순위 별도 프로세스로 띄운다(asr.js). 한 번에 하나씩.
// align {id, type:'align', candidates: [{lines}], heard: [조각], durationMs} → {type:'done', id, result: [{times, anchored, score, verdict}]}
//      kuromoji(발음 사전)는 발음 표기와 같은 것을 쓴다.
let asrBusy = Promise.resolve();
async function handleSyncJob(data) {
  if (data.type === 'asr') {
    const asr = require('./asr');
    const run = asrBusy.then(() => asr.transcribe(Int16Array.from(data.pcm), {
      lang: data.lang, offsetMs: data.offsetMs, prompt: data.prompt, threads: data.threads || 2, dtw: true, durationMs: data.durationMs || 0,
    }));
    asrBusy = run.catch(() => {});
    return run;
  }
  const { getTokenizer } = require('./pronounce');
  const { alignLyrics, verdict } = require('./lyrics-align');
  const tokenizer = await getTokenizer();
  return (data.candidates || []).map((c) => {
    const r = alignLyrics(c.lines || [], data.heard || [], tokenizer, { durationMs: data.durationMs || 0, heardUntil: data.heardUntil || 0 });
    return { ...r, verdict: verdict(r.score) };
  });
}

process.parentPort.on('message', async (e) => {
  const { id, lines, type } = e.data || {};
  if (type === 'cancel') { cancelled.add(id); return; }
  if (type === 'asr-cancel') { try { require('./asr').cancelCurrent(); } catch {} return; }
  if (type === 'asr' || type === 'align') {
    try {
      process.parentPort.postMessage({ type: 'done', id, result: await handleSyncJob(e.data) });
    } catch (err) {
      process.parentPort.postMessage({ type: 'done', id, error: String((err && err.message) || err) });
    }
    return;
  }
  if (!id || !Array.isArray(lines)) return;
  if (type === 'pron') {
    try {
      const { pronounceLyrics } = require('./pronounce');
      const result = await pronounceLyrics(lines.map((text) => ({ text })));
      process.parentPort.postMessage({ type: 'done', id, result });
    } catch (err) {
      process.parentPort.postMessage({ type: 'done', id, error: String((err && err.message) || err) });
    }
    return;
  }
  try {
    const translate = await getTranslator();
    // order: main이 정한 번역 순서(지금 재생 중인 줄부터). 같은 원문(후렴 반복)은 한 번만 번역한다.
    const order = Array.isArray(e.data.order) ? e.data.order : lines.map((_, i) => i);
    const memo = new Map();
    for (const i of order) {
      if (cancelled.has(id)) break;
      let ko = '';
      if (lines[i]) {
        if (memo.has(lines[i])) {
          ko = memo.get(lines[i]);
        } else {
          try { ko = cleanTranslation(await translate(lines[i]), lines[i]); } catch {}
          memo.set(lines[i], ko);
          await new Promise((resolve) => setTimeout(resolve, 50)); // 줄 사이 휴지
        }
      }
      process.parentPort.postMessage({ type: 'line', id, index: i, ko });
    }
    cancelled.delete(id);
    process.parentPort.postMessage({ type: 'done', id });
  } catch (err) {
    process.parentPort.postMessage({ type: 'done', id, error: String((err && err.message) || err) });
  }
});
