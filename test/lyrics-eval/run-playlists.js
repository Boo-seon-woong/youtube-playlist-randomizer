// 플레이리스트 묶음에 가사 검색을 돌려 결과를 한 곡씩 JSONL로 이어 쓴다 — 판정은 사람이(LLM이) 표를 직접 읽고 한다.
// 사용: node run-playlists.js <label> [--module <path>] [--from N] [--to M] [--step K] [--cards]
//   결과: result-<label>.jsonl (곡마다 한 줄, 중단돼도 그때까지 남는다). 이미 있는 곡은 건너뛴다.
const fs = require('fs');
const path = require('path');
const DIR = path.dirname(__filename);
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const label = process.argv[2] || 'run';
const ls = require(arg('--module', '/root/2026/prac/youtube_music/lyrics-search.js'));
const corpus = JSON.parse(fs.readFileSync(path.join(DIR, 'playlists.json'), 'utf8'));
const from = Number(arg('--from', 0));
const to = Number(arg('--to', corpus.length));
const step = Number(arg('--step', 1));
const useV2 = process.argv.includes('--v2'); // 앱 v1.34+와 같은 경로: 카드·설명란·곡 정보 확인·웹 검색(findLyricsCandidates)
const useCards = process.argv.includes('--cards') || useV2; // 앱과 똑같이 유튜브 음악 카드를 검색 입력으로 넘긴다 (판정에는 안 씀)
const OUT = path.join(DIR, `result-${label}.jsonl`);
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).i) : []);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
let cfgPromise = null;
function cfg() {
  if (!cfgPromise) cfgPromise = fetch('https://www.youtube.com/?hl=ko', { headers: { 'User-Agent': UA, 'Accept-Language': 'ko' } })
    .then((r) => r.text()).then((h) => ({ key: h.match(/"INNERTUBE_API_KEY":"([^"]+)"/)[1], ver: h.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)[1] }));
  return cfgPromise;
}
async function musicCard(videoId) {
  try {
    const c = await cfg();
    const res = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${c.key}&prettyPrint=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: c.ver, hl: 'ko' } }, videoId }),
    });
    const data = await res.json();
    const text = (x) => (x && (x.content || x.simpleText || (x.runs || []).map((r) => r.text).join(''))) || '';
    let info = null;
    let description = '';
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.attributedDescription && !description) description = text(node.attributedDescription);
      const vm = node.videoAttributeViewModel;
      if (vm && vm.title && !info) info = { title: text(vm.title) || String(vm.title), artist: text(vm.subtitle) || String(vm.subtitle || '') };
      for (const v of Object.values(node)) walk(v);
    })(data);
    return useV2 ? { title: info ? info.title : '', artist: info ? info.artist : '', description } : info;
  } catch { return null; }
}

(async () => {
  const todo = [];
  for (let i = from; i < Math.min(to, corpus.length); i += step) if (!done.has(i)) todo.push(i);
  let next = 0;
  await Promise.all((useV2 ? [0, 1] : [0, 1, 2]).map(async () => {
    while (next < todo.length) {
      const i = todo[next++];
      const c = corpus[i];
      const t0 = Date.now();
      let r = null;
      const card = useCards ? musicCard(c.id) : null;
      if (useV2) {
        try {
          const found = await ls.findLyricsCandidates(c.title, c.channel, c.duration * 1000, {
            musicInfo: card.then((i) => (i && i.title ? i : null)), description: card.then((i) => (i && i.description) || ''), videoId: c.id,
          });
          r = found.best;
        } catch {}
      } else {
        try { r = await ls.findLyricsForTrack(c.title, c.channel, c.duration * 1000, { musicInfo: card }); } catch {}
      }
      // v1.31.0 배포본 동작 재현: 못 찾으면 음악 카드 곡명·가수로 한 번 더 (--old-fallback)
      if (!r && process.argv.includes('--old-fallback')) {
        const info = await musicCard(c.id);
        if (info && info.title) { try { r = await ls.findLyricsForTrack(info.title, info.artist, c.duration * 1000); } catch {} }
      }
      const lines = r && r.lines ? r.lines : [];
      // 원문 줄 2개 — 제목만 그럴듯한 엉뚱한 가사를 가려내는 데 쓴다
      const sample = lines.slice(0, 6).map((l) => String(l.text).split('\n')[0]).filter((t) => t.trim()).slice(1, 3).join(' / ');
      fs.appendFileSync(OUT, JSON.stringify({
        i, id: c.id, title: c.title, channel: c.channel, duration: c.duration, ms: Date.now() - t0,
        found: !!r, source: r ? r.source : '', plain: !!(r && r.plain), ko: !!(r && r.hasKorean),
        gotTitle: r ? r.title : '', gotArtist: r ? r.artist : '', sample: sample.slice(0, 70),
      }) + '\n');
    }
  }));
  const all = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ms = all.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => (ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] / 1000).toFixed(1);
  console.log(`[${label}] ${all.length} done | found ${all.filter((r) => r.found).length} (KO ${all.filter((r) => r.ko).length}, plain ${all.filter((r) => r.plain).length}) | p50 ${pct(0.5)}s p90 ${pct(0.9)}s max ${(ms[ms.length - 1] / 1000).toFixed(1)}s`);
})();
