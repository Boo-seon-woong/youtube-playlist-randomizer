// 소형 최신 LLM으로 일→한 가사 번역 품질·속도·메모리 비교 (배포본 런타임에서)
const path = require('path');
const APP = 'C:\\Users\\boosu\\Desktop\\YouTube Music Player\\resources\\app';
const req = require('module').createRequire(path.join(APP, 'main.js'));
const LINES = ['真夜中に告ぐ 音の警告', '君の声が聞こえる', '僕はずっと待ってたんだ', 'あの日見た花の名前を僕達はまだ知らない', '強くなれる理由を知った 僕を連れて進め'];
const MODEL = process.argv[2], DTYPE = process.argv[3];
(async () => {
  const tr = req('@huggingface/transformers');
  tr.env.cacheDir = 'C:\\Users\\boosu\\AppData\\Local\\Temp\\ymp-dbg\\models';
  tr.env.allowRemoteModels = true;
  const t0 = Date.now();
  const gen = await tr.pipeline('text-generation', MODEL, { dtype: DTYPE,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } } });
  console.log(MODEL, DTYPE, 'load', Date.now() - t0, 'ms');
  for (const line of LINES) {
    const t1 = Date.now();
    const messages = [
      { role: 'system', content: 'You translate Japanese song lyrics into natural Korean. Reply with the Korean translation only.' },
      { role: 'user', content: line },
    ];
    const out = await gen(messages, { max_new_tokens: 48, do_sample: false, repetition_penalty: 1.1, ...(MODEL.includes('Qwen3') ? { enable_thinking: false } : {}) });
    const text = out[0].generated_text.at(-1).content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    console.log(`  ${Date.now() - t1}ms  ${line} → ${text}`);
  }
  console.log('  RSS MB', Math.round(process.memoryUsage().rss / 1048576));
})().catch((e) => console.log('ERR', e.message));
