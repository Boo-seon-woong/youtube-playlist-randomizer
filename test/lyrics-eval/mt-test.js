// 배포본의 기계 번역 경로 실측 — mt-worker.js와 같은 설정(1스레드·스피닝 off)으로 일본어 3줄을 번역한다
const path = require('path');
const APP = 'C:\\Users\\boosu\\Desktop\\YouTube Music Player\\resources\\app';
const req = require('module').createRequire(path.join(APP, 'main.js'));
(async () => {
  const t0 = Date.now();
  let tr;
  try {
    tr = req('@huggingface/transformers');
  } catch (e) { console.log('IMPORT FAIL', e.message); return; }
  console.log('import', Date.now() - t0, 'ms');
  tr.env.cacheDir = path.join(APP, 'models');
  tr.env.allowRemoteModels = false;
  const t1 = Date.now();
  let pipe;
  try {
    pipe = await tr.pipeline('translation', 'Xenova/m2m100_418M', {
      dtype: 'q8',
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } },
    });
  } catch (e) { console.log('LOAD FAIL', e.message); return; }
  console.log('model load', Date.now() - t1, 'ms');
  for (const line of ['真夜中に告ぐ 音の警告', '君の声が聞こえる', '夜に駆ける']) {
    const t2 = Date.now();
    const out = await pipe(line, { src_lang: 'ja', tgt_lang: 'ko' });
    console.log(`${Date.now() - t2}ms  ${line} → ${out[0].translation_text}`);
  }
  console.log('RSS MB', Math.round(process.memoryUsage().rss / 1048576));
})();
