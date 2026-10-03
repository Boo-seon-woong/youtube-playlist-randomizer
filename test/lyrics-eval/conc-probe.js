// 알송 실패율이 동시 요청 수에 따라 달라지는지: 같은 검색 요청을 동시 1/4/16개로 쏴서 실패율 비교
const http = require('http');
const ENC = require('fs').readFileSync('/root/2026/prac/youtube_music/lyrics-search.js','utf8').match(/ALSong_ENC_DATA = '([0-9a-f]+)'/)[1];
function req(agent, timeout) {
  const body = `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:ns1="ALSongWebServer"><SOAP-ENV:Body><ns1:GetResembleLyricList2><ns1:encData>${ENC}</ns1:encData><ns1:pageNo>1</ns1:pageNo><ns1:title>최종화</ns1:title><ns1:artist>아이리 칸나</ns1:artist></ns1:GetResembleLyricList2></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request({ hostname: 'lyrics.alsong.co.kr', port: 80, path: '/alsongwebservice/service1.asmx', method: 'POST', agent,
      headers: { 'Content-Type': 'text/xml;charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'gSOAP/2.7', SOAPAction: 'ALSongWebServer/GetResembleLyricList2' } },
      (res) => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200, ms: Date.now() - t0 })); });
    r.setTimeout(timeout, () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, err: e.message }));
    r.end(body);
  });
}
(async () => {
  for (const [label, conc, agent] of [['seq x24', 1, undefined], ['conc4 x24', 4, undefined], ['conc16 x32', 16, undefined], ['keepalive conc4 x24', 4, new http.Agent({ keepAlive: true, maxSockets: 4 })]]) {
    const total = label.includes('x32') ? 32 : 24;
    const res = [];
    for (let i = 0; i < total; i += conc) res.push(...await Promise.all(Array.from({ length: Math.min(conc, total - i) }, () => req(agent, 5000))));
    const fail = res.filter((r) => !r.ok);
    const okMs = res.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
    console.log(`${label.padEnd(22)} fail ${fail.length}/${res.length}  ok-median ${okMs[Math.floor(okMs.length / 2)]}ms  ${fail[0] ? fail[0].err : ''}`);
  }
  process.exit(0);
})();
