// 음성 인식(whisper.cpp) 실행기 — 16kHz 모노 PCM 조각을 whisper-cli로 글자 + 시각으로 바꾼다.
// 가사 워커(mt-worker.js)가 부른다. whisper-cli는 별도 프로세스로 띄우고 IDLE 우선순위로 내려 게임 등 전면 앱이
// 항상 CPU를 먼저 가져가게 한다. 모델: models/ggml-small-q8_0.bin(264MB) — 정답 싱크가 있는 곡 실측에서
// base는 노래를 거의 못 알아들었고(들은 글자 96/1251), small-q8_0이 small(f16)보다 빠르면서(145초 곡: 4스레드
// 28초) 줄 99%가 ±1초 안이었다. large-v3-turbo는 조금 더 정확하지만 4배 무거워 실시간 처리에 맞지 않는다.
// 바이너리: asr/win-x64(whisper.cpp b5130 공식 whisper-bin-x64.zip — MSVC 런타임은 Windows에 기본 설치된 것을 쓴다),
// 개발용 리눅스는 asr/linux-x64(직접 빌드, LD_LIBRARY_PATH로 .so를 찾는다).
// 그래픽카드 판: asr/win-x64-vk = CrispASR v0.8.41(whisper.cpp 파생, MIT) crispasr-windows-x86_64-vulkan.zip — whisper-cli와
// 같은 인자·같은 -ojf 결과. 실측(RTX 4060 노트북): 30초 창 CPU 6.5~8.6초 → 1.1초(인코더 2.3초 → 0.08초), 글자 같고 DTW
// 시각 차이 최대 20ms. 첫 실행만 셰이더 준비로 약 26초(드라이버가 캐시). 내장 그래픽(Radeon 780M)은 이 판에서 처리 중
// 죽어(exit 9) 외장(gpu)만 쓴다. 더 가벼운 최신 모델은 노래에 못 쓴다(실측: SenseVoice-Small 14배 빠르지만 78줄 중 2줄,
// Qwen3-ForcedAligner는 60초 넘으면 정렬이 무너지고 메모리 4.7GB).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const MODEL = path.join(__dirname, 'models', 'ggml-small-q8_0.bin');
const GPU_BIN = path.join(__dirname, 'asr', 'win-x64-vk', 'crispasr.exe');
let gpuDevice; // undefined = 아직 모름, null = 없음(또는 이번 실행에서 실패), { index, name }
let gpuProbe = null;

// 외장 그래픽카드 찾기: --diagnostics의 "[1] gpu    name=Vulkan1 desc=NVIDIA GeForce RTX 4060 Laptop GPU mem=…" 줄
function probeGpu() {
  if (gpuDevice !== undefined) return Promise.resolve(gpuDevice);
  if (gpuProbe) return gpuProbe;
  if (process.platform !== 'win32' || !fs.existsSync(GPU_BIN)) { gpuDevice = null; return Promise.resolve(null); }
  gpuProbe = new Promise((resolve) => {
    execFile(GPU_BIN, ['--diagnostics'], { windowsHide: true, timeout: 20000 }, (_err, stdout, stderr) => {
      const m = `${stdout || ''}\n${stderr || ''}`.match(/\]\s+gpu\s+name=Vulkan(\d+)\s+desc=(.*?)\s+mem=/);
      gpuDevice = m ? { index: Number(m[1]), name: m[2].trim() } : null;
      resolve(gpuDevice);
    });
  });
  return gpuProbe;
}

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

// 토큰 조각을 바이트로 이어 붙여 완성된 글자만 내보낸다. whisper는 한자 한 글자를 바이트 단위 토큰 둘셋으로 내기도 해
// ("緒" = e7 b7 92가 두 토큰에 나뉨) 토큰마다 따로 UTF-8로 읽으면 "一��に"가 되고 발음으로 못 바꿔 맞춘 줄이 줄었다
// (실측: 그래픽카드 판에서 자주 — 生命性シンドロウム ±1초 66% → 31%; CPU 판에서도 가끔). 글자 시각은 첫 바이트가 든 토큰의 것.
function joinTokenBytes(tokens) {
  const out = [];
  let pending = Buffer.alloc(0);
  let pendingT = 0;
  for (const tok of tokens) {
    if (!pending.length) pendingT = tok.t;
    pending = Buffer.concat([pending, Buffer.from(tok.text, 'latin1')]);
    // 끝에서 잘린 글자(이어지는 바이트가 모자란 것)는 다음 토큰을 기다린다
    let i = pending.length - 1;
    while (i > 0 && pending.length - i < 4 && (pending[i] & 0xc0) === 0x80) i--;
    const lead = pending[i];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    const done = pending.length - i >= need ? pending.length : i;
    if (done > 0) {
      out.push({ text: pending.subarray(0, done).toString('utf8'), t: pendingT });
      pending = pending.subarray(done);
      pendingT = tok.t;
    }
  }
  if (pending.length) out.push({ text: pending.toString('utf8'), t: pendingT });
  return out;
}

// whisper-cli의 -ojf 결과 → [{t0, t1, text, tokens:[{text, t}]}] (offsetMs를 더해 곡 기준 시각으로)
// opts.latin1: JSON을 latin1로 읽은 것(토큰 text의 한 글자 = 한 바이트) — 토큰 바이트를 이어 글자를 완성한다
function parseWhisperJson(json, offsetMs = 0, opts = {}) {
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
    const joined = opts.latin1 ? joinTokenBytes(tokens) : tokens;
    tokens.length = 0;
    tokens.push(...joined);
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

// pcm: Int16Array(16kHz 모노). opts: { lang, threads, offsetMs, prompt, dtw, durationMs, gpu }
// gpu: 외장 그래픽카드가 있으면 그쪽으로 — 실패하면(취소 제외) 이번 실행 동안은 CPU 판만 쓰고 이 창도 CPU로 다시 한다.
function transcribe(pcm, opts = {}) {
  return (opts.gpu ? probeGpu() : Promise.resolve(null)).then((dev) => {
    if (!dev) return runWhisper(pcm, opts, null);
    return runWhisper(pcm, opts, dev).catch((err) => {
      if (err && err.cancelled) throw err;
      gpuDevice = null;
      return runWhisper(pcm, opts, null);
    });
  });
}

function runWhisper(pcm, opts, gpu) {
  return new Promise((resolve, reject) => {
    const { bin, env } = gpu
      // 보이는 Vulkan 장치를 그 하나로 줄이고 -dev 0 (여럿 보이면 -dev 번호가 CPU로 빠졌다 — 실측)
      ? { bin: GPU_BIN, env: { ...process.env, GGML_VK_VISIBLE_DEVICES: String(gpu.index) } }
      : binPaths();
    const base = path.join(os.tmpdir(), `ymp-asr-${process.pid}-${++seq}`);
    const wav = `${base}.wav`;
    try { fs.writeFileSync(wav, wavBuffer(pcm)); } catch (err) { reject(err); return; }
    // -bs 1 -bo 1: 탐욕 디코딩(빔 5 대비 30초 창 17.0→12.9초, 정확도 차이 없음 — 실측)
    // 그래픽카드 판은 CPU를 멜 계산·토큰 고르기에만 쓴다 — 2스레드면 충분
    const threads = gpu ? 2 : opts.threads || 2;
    const args = ['-m', MODEL, '-f', wav, '-l', opts.lang || 'auto', '-t', String(threads), '-ojf', '-of', base, '-np', '-bs', '1', '-bo', '1'];
    if (gpu) args.push('-dev', '0');
    // -d: 이 길이까지만 처리 — whisper는 마지막 조각이 창 끝보다 일찍 끝나면 남은 몇 초를 위해 인코더를 한 번 더(30초 분량)
    // 돌린다(실측: 30초 창마다 인코더 2회). 창의 앞부분만 확정하고 다음 창을 그 지점부터 시작하면 그 낭비가 거의 없다.
    if (opts.durationMs > 0) args.push('-d', String(Math.round(opts.durationMs)));
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
      try { json = JSON.parse(fs.readFileSync(`${base}.json`).toString('latin1')); } catch {}
      cleanup();
      if (!json) {
        const e = new Error(`whisper exit ${code}: ${err.slice(-300)}`);
        e.cancelled = !!child.cancelled;
        reject(e);
        return;
      }
      resolve(parseWhisperJson(json, opts.offsetMs || 0, { latin1: true }));
    });
  });
}

function cancelCurrent() {
  if (current) { current.cancelled = true; try { current.kill(); } catch {} }
}

module.exports = { available, transcribe, cancelCurrent, parseWhisperJson, wavBuffer, MODEL };
