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

// 잡: {id, lines: string[] (빈 문자열 = 번역 생략), src} → 줄마다 {type:'line', id, index, ko}, 끝나면 {type:'done', id}
process.parentPort.on('message', async (e) => {
  const { id, lines, src } = e.data || {};
  if (!id || !Array.isArray(lines)) return;
  try {
    const translate = await getTranslator();
    for (let i = 0; i < lines.length; i++) {
      let ko = '';
      if (lines[i]) {
        try {
          const out = await translate(lines[i], { src_lang: src, tgt_lang: 'ko' });
          ko = String((out && out[0] && out[0].translation_text) || '').trim();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100)); // 줄 사이 휴지
      }
      process.parentPort.postMessage({ type: 'line', id, index: i, ko });
    }
    process.parentPort.postMessage({ type: 'done', id });
  } catch (err) {
    process.parentPort.postMessage({ type: 'done', id, error: String((err && err.message) || err) });
  }
});
