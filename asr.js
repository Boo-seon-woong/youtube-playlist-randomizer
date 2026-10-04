// 음성 인식(whisper.cpp) 실행기 — 16kHz 모노 PCM 조각을 whisper-cli로 글자 + 시각으로 바꾼다.
// 가사 워커(mt-worker.js)가 부른다. whisper-cli는 별도 프로세스로 띄우고 IDLE 우선순위로 내려 게임 등 전면 앱이
// 항상 CPU를 먼저 가져가게 한다. 모델: models/ggml-small-q8_0.bin(264MB) — 정답 싱크가 있는 곡 실측에서
// base는 노래를 거의 못 알아들었고(들은 글자 96/1251), small-q8_0이 small(f16)보다 빠르면서(145초 곡: 4스레드
// 28초) 줄 99%가 ±1초 안이었다. large-v3-turbo는 조금 더 정확하지만 4배 무거워 실시간 처리에 맞지 않는다.
// 바이너리: asr/win-x64(whisper.cpp b5130 공식 whisper-bin-x64.zip — MSVC 런타임은 Windows에 기본 설치된 것을 쓴다),
// 개발용 리눅스는 asr/linux-x64(직접 빌드, LD_LIBRARY_PATH로 .so를 찾는다).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MODEL = path.join(__dirname, 'models', 'ggml-small-q8_0.bin');

function binPaths() {
  if (process.platform === 'win32') {
    const dir = path.join(__dirname, 'asr', 'win-x64');
    return { bin: path.join(dir, 'whisper-cli.exe'), dir, env: process.env };
  }
  const dir = process.env.YMP_WHISPER_DIR || path.join(__dirname, 'asr', 'linux-x64');
  return { bin: path.join(dir, 'whisper-cli'), dir, env: { ...process.env, LD_LIBRARY_PATH: `${dir}${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}` } };
}

function available() {
  const { bin } = binPaths();
  return fs.existsSync(bin) && fs.existsSync(MODEL);
}

function wavBuffer(pcm, sampleRate = 16000) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(sampleRate, 24); hdr.writeUInt32LE(sampleRate * 2, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

// whisper-cli의 -ojf 결과 → [{t0, t1, text, tokens:[{text, t}]}] (offsetMs를 더해 곡 기준 시각으로)
function parseWhisperJson(json, offsetMs = 0) {
  const out = [];
  for (const seg of (json && json.transcription) || []) {
    const segFrom = seg.offsets.from;
    const segTo = seg.offsets.to;
    const tokens = (seg.tokens || [])
      .filter((t) => t && typeof t.text === 'string' && !/^\[_/.test(t.text))
      // -dtw를 켜면 t_dtw(10ms 단위)가 실제 발음 시점에 더 가깝다 — 없으면 토큰 구간 시작.
      // 단 whisper가 같은 줄을 되풀이(환각)한 창에서는 DTW가 통째로 어긋나(실측: 0~3초 조각의 토큰이 10~28초로 찍힘)
      // 조각 범위 ±1초를 벗어난 DTW 시각은 버리고 토큰 구간 시작을 쓴다
      .map((t) => {
        const from = (t.offsets && t.offsets.from) || 0;
        const dtw = t.t_dtw >= 0 ? t.t_dtw * 10 : -1;
        const ok = dtw >= 0 && dtw >= segFrom - 1000 && dtw <= segTo + 1000;
        return { text: t.text, t: offsetMs + (ok ? dtw : from) };
      });
    const text = tokens.map((t) => t.text).join('').trim();
    if (!text) continue;
    out.push({ t0: offsetMs + seg.offsets.from, t1: offsetMs + seg.offsets.to, text, tokens });
  }
  return dropRepeats(out);
}

// whisper의 되풀이 환각: 한 창 안에서 앞 조각과 똑같은 긴 조각(8글자 이상)이 다시 나오는 것(실측: 0~6초의 두 줄이
// 13~18초에 그대로 다시 찍힘 — 정렬이 뒤의 복사본에 붙어 줄 시각이 13초 밀렸다). 진짜 반복 가사("抜け出せない
// 抜け出せない")는 대개 한 조각에 함께 들어오므로, 바로 앞이 아닌 앞 조각과 같은 긴 조각만 버린다.
// 괄호로만 된 짧은 조각("(音楽)", "(エンディング)", "[拍手]")은 whisper가 소리가 아닌 것에 붙이는 설명이라 버린다
// (실측: 보컬을 못 알아들은 UTAU 곡 창이 "(ダクトリーメイテブリー)"·"(エンディング)"만 남겼다)
function dropRepeats(segs) {
  const norm = (t) => t.replace(/[\s\p{P}\p{S}]/gu, '');
  const out = [];
  for (const seg of segs) {
    const bare = seg.text.trim();
    if (bare.length <= 20 && /^(?:[(\[（【［].*[)\]）】］]|[♪♫\s]+)$/.test(bare)) continue;
    const key = norm(seg.text);
    const earlier = out.slice(0, -1).some((o) => norm(o.text) === key);
    if (key.length >= 8 && earlier) continue;
    out.push(seg);
  }
  return out;
}

let seq = 0;
let current = null; // 지금 돌고 있는 whisper 프로세스(취소용)

// pcm: Int16Array(16kHz 모노). opts: { lang, threads, offsetMs, prompt }
function transcribe(pcm, opts = {}) {
  return new Promise((resolve, reject) => {
    const { bin, env } = binPaths();
    const base = path.join(os.tmpdir(), `ymp-asr-${process.pid}-${++seq}`);
    const wav = `${base}.wav`;
    try { fs.writeFileSync(wav, wavBuffer(pcm)); } catch (err) { reject(err); return; }
    const args = ['-m', MODEL, '-f', wav, '-l', opts.lang || 'auto', '-t', String(opts.threads || 2), '-ojf', '-of', base, '-np'];
    if (opts.prompt) args.push('--prompt', String(opts.prompt).slice(0, 400));
    if (opts.dtw) args.push('-dtw', 'small', '-nfa'); // DTW는 flash attention과 함께 못 쓴다(켜져 있으면 t_dtw가 -1)
    const child = spawn(bin, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    current = child;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch {}
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const cleanup = () => { for (const f of [wav, `${base}.json`]) { try { fs.unlinkSync(f); } catch {} } };
    child.on('error', (e) => { current = null; cleanup(); reject(e); });
    child.on('close', (code) => {
      current = null;
      let json = null;
      try { json = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')); } catch {}
      cleanup();
      if (!json) { reject(new Error(`whisper exit ${code}: ${err.slice(-300)}`)); return; }
      resolve(parseWhisperJson(json, opts.offsetMs || 0));
    });
  });
}

function cancelCurrent() {
  if (current) { try { current.kill(); } catch {} }
}

module.exports = { available, transcribe, cancelCurrent, parseWhisperJson, wavBuffer, MODEL };
