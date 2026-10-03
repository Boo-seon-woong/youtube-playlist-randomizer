// 가사 검색 안정성 측정: 같은 입력으로 N번 반복해 결과가 흔들리는지, 알송 요청이 몇 번 실패/타임아웃하는지 센다.
const http = require('http');
const ls = require('/root/2026/prac/youtube_music/lyrics-search.js');

// 알송 HTTP 호출 계측 (실패·타임아웃·소요 시간)
const stats = { req: 0, err: 0, non200: 0, ms: [] };
const origRequest = http.request;
http.request = function (opts, cb) {
  const t0 = Date.now();
  stats.req++;
  const req = origRequest.call(http, opts, (res) => {
    if (res.statusCode !== 200) stats.non200++;
    res.on('end', () => stats.ms.push(Date.now() - t0));
    cb(res);
  });
  req.on('error', (e) => { stats.err++; stats.lastErr = e.message; });
  return req;
};

const CASES = JSON.parse(process.argv[2]);
const N = Number(process.argv[3] || 3);

(async () => {
  for (const [title, channel, durSec] of CASES) {
    const seen = new Map();
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      let r = null;
      try { r = await ls.findLyricsForTrack(title, channel, durSec * 1000); } catch (e) { r = { error: e.message }; }
      const key = r ? (r.error ? `ERROR ${r.error}` : `${r.source}:${r.id} ${r.title} / ${r.artist} ko=${r.hasKorean}`) : 'NOT FOUND';
      seen.set(key, (seen.get(key) || 0) + 1);
      process.stderr.write(`  [${i + 1}/${N}] ${Date.now() - t0}ms ${key}\n`);
    }
    console.log(`\n${title}  (${channel})`);
    for (const [k, c] of seen) console.log(`   ${c}x  ${k}`);
    const q = ls.buildLyricQueries(title, channel);
    console.log('   queries:', JSON.stringify(q.pairs.slice(0, 6)));
  }
  const ms = stats.ms.sort((a, b) => a - b);
  console.log(`\nALSong HTTP: ${stats.req} req, ${stats.err} errors, ${stats.non200} non-200, median ${ms[Math.floor(ms.length / 2)]}ms, max ${ms[ms.length - 1]}ms ${stats.lastErr ? '(last err: ' + stats.lastErr + ')' : ''}`);
})();
