// 기계 번역 전용 유틸리티 프로세스 (main.js가 utilityProcess.fork로 띄운다).
// 추론을 메인 프로세스에서 분리한 이유: 메인은 UI·오디오 때문에 우선순위를 BELOW_NORMAL까지밖에
// 못 내리는데, 그걸로는 게임 프레임 드랍(30%+)이 남았다. 이 프로세스는 IDLE 우선순위 + 1스레드로만
// 돌아 시스템이 한가할 때만 CPU를 받는다 — 게임 등 전면 앱이 항상 우선한다.
const path = require('path');
const os = require('os');

try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch {} // Windows에서 IDLE_PRIORITY_CLASS

let translatorPromise = null;
function getTranslator() {
  if (!translatorPromise) {
    translatorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(__dirname, 'models');
      env.allowRemoteModels = false; // 동봉본만 사용 — 어떤 외부 다운로드도 하지 않는다
      return pipeline('translation', 'Xenova/m2m100_418M', {
        dtype: 'q8',
        // 1스레드 + 스피닝 금지: 프로세스 우선순위가 IDLE이어도 스레드풀 busy-wait는 코어를 점유한다
        session_options: {
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
          extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
        },
      });
    })();
    translatorPromise.catch(() => { translatorPromise = null; }); // 로드 실패 시 다음 잡에서 재시도
  }
  return translatorPromise;
}

// 작은 번역 모델은 짧은 줄·의성어에서 같은 말을 수백 번 반복하는 루프에 빠진다(실측: "나 나 나 …" 수백 개).
// 생성 단계에서 반복을 억제하고, 그래도 남은 연속 반복은 두 번까지로 줄이고 길이를 원문에 비례해 자른다.
function cleanTranslation(text, source) {
  let t = String(text || '').trim();
  t = t.replace(/(\S+)(?:\s+\1){2,}/g, '$1 $1'); // 같은 낱말 3번 이상 연속 → 2번
  t = t.replace(/(.{2,12}?)\1{2,}/g, '$1$1'); // 띄어쓰기 없는 반복 덩어리
  const limit = Math.max(24, source.length * 4);
  return t.length > limit ? t.slice(0, limit).trim() + '…' : t;
}

// 잡: 번역 {id, lines: string[] (빈 문자열 = 생략), src} → 줄마다 {type:'line', id, index, ko}, 끝나면 {type:'done', id}
//     발음 {id, type:'pron', lines: string[]} → {type:'done', id, result: string[]} (일본어 → 한글 발음, 수 밀리초)
// 번역을 끄면 main이 {type:'cancel', id}를 보낸다 — 남은 줄을 바로 그만둔다(CPU를 계속 쓰지 않게)
const cancelled = new Set();

process.parentPort.on('message', async (e) => {
  const { id, lines, src, type } = e.data || {};
  if (type === 'cancel') { cancelled.add(id); return; }
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
    for (let i = 0; i < lines.length; i++) {
      if (cancelled.has(id)) break;
      let ko = '';
      if (lines[i]) {
        try {
          const out = await translate(lines[i], {
            src_lang: src,
            tgt_lang: 'ko',
            max_new_tokens: Math.min(96, lines[i].length * 3 + 8),
            repetition_penalty: 1.3,
            no_repeat_ngram_size: 3,
          });
          ko = cleanTranslation((out && out[0] && out[0].translation_text) || '', lines[i]);
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100)); // 줄 사이 휴지
      }
      process.parentPort.postMessage({ type: 'line', id, index: i, ko });
    }
    cancelled.delete(id);
    process.parentPort.postMessage({ type: 'done', id });
  } catch (err) {
    process.parentPort.postMessage({ type: 'done', id, error: String((err && err.message) || err) });
  }
});
