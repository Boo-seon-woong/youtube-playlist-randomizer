// 가사 검색 정확도 채점: corpus.json의 각 영상 제목으로 findLyricsForTrack을 돌려
// OK(정답 곡) / WRONG(다른 곡 연결) / MISS(못 찾음)로 판정한다. 결과는 report-<label>.json에도 남긴다.
const fs = require('fs');
const path = require('path');
const ls = require('/root/2026/prac/youtube_music/lyrics-search.js');

const DIR = path.dirname(__filename);
const corpus = JSON.parse(fs.readFileSync(path.join(DIR, 'corpus.json'), 'utf8'))
  .filter((c) => !/도슨트/.test(c.title)); // 곡이 아닌 해설 영상은 채점에서 뺀다
const label = process.argv[2] || 'run';
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const hit = (value, keys) => keys.some((k) => { const a = norm(value), b = norm(k); return a && b && (a.includes(b) || b.includes(a)); });

(async () => {
  const results = new Array(corpus.length);
  let next = 0;
  const worker = async () => {
    while (next < corpus.length) {
      const i = next++;
      const c = corpus[i];
      const t0 = Date.now();
      let r = null;
      try { r = await ls.findLyricsForTrack(c.title, c.channel, c.duration * 1000); } catch {}
      let verdict = 'MISS';
      if (r) verdict = hit(r.title, c.expectTitles) && hit(r.artist, c.expectArtists) ? 'OK' : 'WRONG';
      results[i] = { verdict, ms: Date.now() - t0, title: c.title, channel: c.channel,
        got: r ? `${r.source} ${r.title} / ${r.artist}${r.hasKorean ? ' [ko]' : ''}` : '' };
    }
  };
  await Promise.all([worker(), worker()]);
  const count = (v) => results.filter((r) => r.verdict === v).length;
  for (const r of results) if (r.verdict !== 'OK') console.log(`${r.verdict.padEnd(5)} ${r.title.slice(0, 70)} | ${r.channel.slice(0, 20)}${r.got ? '\n        → ' + r.got : ''}`);
  const korean = results.filter((r) => r.verdict === 'OK' && r.got.endsWith('[ko]')).length;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n[${label}] OK ${count('OK')}/${results.length}  WRONG ${count('WRONG')}  MISS ${count('MISS')}  (정답 중 한글 가사 ${korean})  중간 ${ms[Math.floor(ms.length / 2)]}ms 최대 ${ms[ms.length - 1]}ms`);
  fs.writeFileSync(path.join(DIR, `report-${label}.json`), JSON.stringify(results, null, 1));
})();
