// result-<label>.jsonl → 사람이 읽고 판정할 표. 사용: node table.js <label> [from] [to] [--miss]
const fs = require('fs');
const path = require('path');
const [label, from = 0, to = 9999] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const onlyMiss = process.argv.includes('--miss');
const rows = fs.readFileSync(path.join(__dirname, `result-${label}.jsonl`), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((r) => r.i >= Number(from) && r.i < Number(to)).sort((a, b) => a.i - b.i);
for (const r of rows) {
  if (onlyMiss && r.found) continue;
  const tag = r.found ? (r.plain ? 'PL' : r.ko ? 'KO' : 'OR') : '--';
  console.log(`${String(r.i).padStart(3)} ${tag} ${(r.ms / 1000).toFixed(1).padStart(4)}s ${r.title.slice(0, 64)} ‖ ${r.channel.slice(0, 16)}`);
  if (r.found) console.log(`        → ${r.source}: ${r.gotTitle.slice(0, 40)} / ${r.gotArtist.slice(0, 30)} :: ${r.sample.slice(0, 50)}`);
}
