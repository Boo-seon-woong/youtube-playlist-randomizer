// 오디오 가드 — 유튜브 영상이 재생되는 모든 프레임(메인 창의 임베드 iframe, 직접 재생 웹뷰)에 심는다.
//
// ① 볼륨 상한: HTMLMediaElement.prototype.volume의 setter를 가로채, 유튜브(또는 누구든)가 쓰는 값을
//    앱 볼륨(cap)과 비교해 min(요청값, cap)만 실제로 적용한다. 쓰기 시점에 동기적으로 막으므로
//    "유튜브가 곡 시작 시 자기 저장 볼륨(보통 100%)을 복원 → 앱이 나중에 되돌림" 사이의 누출 틈이 없다.
//    새로 만든 요소는 기본 볼륨이 1.0이라 play() 직전에도 상한을 건다.
//    실측(Electron 41): createMediaElementSource로 Web Audio에 연결해도 요소의 volume·muted가 그래프
//    입력에 그대로 곱해진다(0.10 → 0.100배, muted → 0) — 그래서 아래 EQ도 이 상한을 우회할 수 없다.
// ② 이퀄라이저: 켜졌을 때만 AudioContext를 만들고 요소를 6밴드 필터(60/150/400/1k/2.4k/15kHz, ±12dB)에
//    통과시킨다. 프리앰프를 "합성 응답의 최대 부스트만큼" 낮춰 EQ가 설정 볼륨보다 크게 만들 수 없다.
//    필터 6개는 CPU를 거의 쓰지 않고, 재생이 멈추면 컨텍스트를 suspend해 유휴 비용도 없앤다.
//
// 초기 상태는 window.__ympAudioInit, 이후 갱신은 window.__ympSetAudio(state).
// state = { cap: 0~1(앱 볼륨의 실제 진폭), eq: { enabled, gains: [6개 dB] }, capture?: 자동 싱크용 소리 받기 }
// ③ 소리 받기: 아래 "소리 받아 두기" — 자동 싱크(음성 인식)가 쓸 16kHz 모노 PCM을 쌓아 둔다.

(() => {
  if (window.__ympAudio) return;
  // 미리 듣기용 숨은 임베드(analysis-capture.js)는 볼륨 상한·소리 받기 대상이 아니다 — 스피커로 나가지 않고 따로 받는다
  if (/[?&]ymp=analysis\b/.test(location.href)) return;
  // 미리 듣기용 숨은 임베드(analysis-capture.js)는 볼륨 상한·소리 받기 대상이 아니다 — 스피커로 나가지 않고 따로 받는다
  if (/[?&]ymp=analysis\b/.test(location.href)) return;
  const proto = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (!proto) return;
  const volumeDesc = Object.getOwnPropertyDescriptor(proto, 'volume');
  if (!volumeDesc || !volumeDesc.set) return;
  const nativePlay = proto.play;

  const init = window.__ympAudioInit || {};
  // 상태를 모르면 무음 쪽으로 — 상한을 모른 채 소리를 내는 것보다 안전하다
  let cap = Number.isFinite(init.cap) ? Math.min(1, Math.max(0, init.cap)) : 0;
  let eq = init.eq || { enabled: false, gains: [0, 0, 0, 0, 0, 0] };

  const requested = new WeakMap(); // 요소별로 "요청받은" 볼륨 — cap이 다시 오르면 이 값까지 되돌린다
  const elements = new Set();

  const clamp01 = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  };

  function enforce(el) {
    const want = requested.has(el) ? requested.get(el) : 1;
    const target = Math.min(want, cap);
    if (Math.abs(volumeDesc.get.call(el) - target) > 1e-6) volumeDesc.set.call(el, target);
  }

  function track(el) {
    if (!elements.has(el)) {
      elements.add(el);
      if (eq.enabled) route(el);
    }
  }

  Object.defineProperty(proto, 'volume', {
    configurable: true,
    enumerable: volumeDesc.enumerable,
    // 유튜브가 읽어 갈 때는 자기가 쓴 값을 돌려준다 — 다르면 계속 다시 쓰려 들 수 있다
    get() { return requested.has(this) ? requested.get(this) : volumeDesc.get.call(this); },
    set(value) {
      requested.set(this, clamp01(value));
      track(this);
      enforce(this);
    },
  });

  proto.play = function (...args) {
    track(this);
    enforce(this); // 새 요소의 기본 볼륨 1.0으로 소리가 나기 전에
    if (ctx && ctx.state === 'suspended' && routed.has(this)) ctx.resume().catch(() => {});
    return nativePlay.apply(this, args);
  };

  // play()를 거치지 않는 재생(autoplay 속성 등)에 대한 후속 보정
  document.addEventListener('play', (e) => {
    if (e.target instanceof HTMLMediaElement) {
      track(e.target);
      enforce(e.target);
      if (ctx && ctx.state === 'suspended' && routed.has(e.target)) ctx.resume().catch(() => {});
    }
  }, true);

  // ── 이퀄라이저 ──
  const FREQS = [60, 150, 400, 1000, 2400, 15000];
  let ctx = null;
  let filters = [];
  let preamp = null;
  const routed = new WeakSet();

  function ensureGraph() {
    if (ctx) return true;
    try {
      ctx = new AudioContext({ latencyHint: 'playback' }); // 큰 버퍼 = 낮은 CPU (음악 재생엔 지연이 무관)
    } catch { ctx = null; return false; }
    filters = FREQS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.0;
      b.gain.value = 0;
      return b;
    });
    for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
    preamp = ctx.createGain();
    preamp.gain.value = 1;
    filters[filters.length - 1].connect(preamp);
    preamp.connect(ctx.destination);
    // 재생 중인 요소가 없으면 컨텍스트를 쉬게 한다 (오디오 스레드 유휴 비용 제거)
    const idleCheck = () => {
      for (const el of elements) if (routed.has(el) && !el.paused) return;
      if (ctx.state === 'running') ctx.suspend().catch(() => {});
    };
    document.addEventListener('pause', idleCheck, true);
    document.addEventListener('ended', idleCheck, true);
    return true;
  }

  function route(el) {
    if (routed.has(el) || !ensureGraph()) return;
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(filters[0]);
      routed.add(el);
      if (capturing) src.connect(ensureTap());
      sources.push(src);
      if (!el.paused) ctx.resume().catch(() => {});
    } catch {
      // 이미 다른 컨텍스트에 연결된 요소 등 — EQ만 빠지고 볼륨 상한은 그대로 유지된다
    }
  }

  // ── 소리 받아 두기(자동 싱크용) ──
  // 켜지면 요소를 위 그래프로 통과시키고(EQ가 꺼져 있으면 필터는 0dB로 그대로 통과), EQ 앞단 소리를 ScriptProcessor로
  // 받아 16kHz 모노로 줄여 쌓는다. ScriptProcessor 출력은 0이라 소리에 섞이지 않는다. 컨텍스트는 기본 표본율 —
  // 16kHz 컨텍스트는 실측에서 시계가 멈추고 영상까지 멈췄다. main이 몇 초마다 __ympCapTake()로 가져간다.
  // 청크: { t: 그 순간 영상 시각(초, 청크 끝 무렵), vid: 영상 id, b64: Int16 PCM }
  let capturing = false;
  let tap = null;
  const sources = [];
  let captured = [];
  let vidCache = { at: 0, vid: '' };
  const OUT_RATE = 16000;

  function currentVid() {
    const now = Date.now();
    if (now - vidCache.at < 1000) return vidCache.vid;
    let vid = '';
    try {
      const p = document.getElementById('movie_player');
      const d = p && p.getVideoData && p.getVideoData();
      vid = (d && d.video_id) || '';
    } catch {}
    vidCache = { at: now, vid };
    return vid;
  }

  function ensureTap() {
    if (tap) return tap;
    tap = ctx.createScriptProcessor(4096, 2, 1);
    const ratio = ctx.sampleRate / OUT_RATE;
    tap.onaudioprocess = (e) => {
      if (!capturing) return;
      let el = null;
      for (const x of elements) if (routed.has(x) && !x.paused) { el = x; break; }
      if (!el) return;
      const player = document.getElementById('movie_player');
      if (player && player.classList.contains('ad-showing')) return; // 광고 소리는 받지 않는다
      const a = e.inputBuffer.getChannelData(0);
      const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a;
      const n = Math.floor(a.length / ratio);
      const out = new Int16Array(n);
      for (let k = 0; k < n; k++) {
        const s0 = Math.floor(k * ratio);
        const s1 = Math.min(a.length, Math.floor((k + 1) * ratio));
        let acc = 0;
        for (let i = s0; i < s1; i++) acc += a[i] + b[i];
        const v = acc / (2 * Math.max(1, s1 - s0));
        out[k] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      }
      captured.push({ t: el.currentTime, vid: currentVid(), d: out });
      if (captured.length > 1500) captured.splice(0, captured.length - 1500); // 안 가져가면 약 2분치만 유지
    };
    tap.connect(ctx.destination);
    return tap;
  }

  function setCapture(on) {
    capturing = !!on;
    if (!capturing) { captured = []; return; }
    if (!ensureGraph()) return;
    const t = ensureTap();
    for (const src of sources) { try { src.connect(t); } catch {} }
    for (const el of elements) route(el);
    for (const el of elements) if (routed.has(el) && !el.paused) { ctx.resume().catch(() => {}); break; }
  }

  // 쌓인 청크를 꺼내 간다(꺼낸 것은 비운다). 같은 영상의 이어지는 청크는 하나로 합쳐 보낸다.
  window.__ympCapTake = () => {
    const list = captured;
    captured = [];
    const merged = [];
    for (const c of list) {
      const last = merged[merged.length - 1];
      const dur = c.d.length / OUT_RATE;
      if (last && last.vid === c.vid && Math.abs(c.t - (last.t + dur)) < 0.25) { last.parts.push(c.d); last.t = c.t; continue; }
      merged.push({ t: c.t, vid: c.vid, parts: [c.d] });
    }
    return {
      rate: OUT_RATE,
      chunks: merged.map((m) => {
        const total = m.parts.reduce((s, p) => s + p.length, 0);
        const all = new Int16Array(total);
        let o = 0;
        for (const p of m.parts) { all.set(p, o); o += p.length; }
        const bytes = new Uint8Array(all.buffer);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { t: m.t, vid: m.vid, b64: btoa(s) };
      }),
    };
  };

  function applyEq() {
    if (!eq.enabled) {
      if (!ctx) return; // 한 번도 켠 적 없으면 그래프 자체를 만들지 않는다
      for (const b of filters) b.gain.value = 0;
      preamp.gain.value = 1;
      return;
    }
    if (!ensureGraph()) return;
    for (const el of elements) route(el);
    const gains = Array.isArray(eq.gains) ? eq.gains : [];
    filters.forEach((b, i) => { b.gain.value = Math.max(-12, Math.min(12, Number(gains[i]) || 0)); });
    // 6개 필터를 합친 실제 응답의 최대치만큼 프리앰프를 내린다 — 인접 밴드가 겹쳐 부스트가 더해져도 안전
    const N = 160;
    const freq = new Float32Array(N);
    for (let i = 0; i < N; i++) freq[i] = 20 * Math.pow(1000, i / (N - 1)); // 20Hz ~ 20kHz 로그 간격
    const total = new Float32Array(N).fill(1);
    const mag = new Float32Array(N);
    const phase = new Float32Array(N);
    for (const b of filters) {
      b.getFrequencyResponse(freq, mag, phase);
      for (let i = 0; i < N; i++) total[i] *= mag[i];
    }
    let peak = 1;
    for (let i = 0; i < N; i++) peak = Math.max(peak, total[i]);
    preamp.gain.value = 1 / peak;
  }

  // 앱이 상태를 바꿀 때마다 호출 — 볼륨은 모든 요소에 즉시(동기) 적용된다
  window.__ympSetAudio = (state) => {
    if (!state || typeof state !== 'object') return;
    if (Number.isFinite(state.cap)) cap = Math.min(1, Math.max(0, state.cap));
    if (state.eq && typeof state.eq === 'object') eq = state.eq;
    if (typeof state.capture === 'boolean' && state.capture !== capturing) setCapture(state.capture);
    for (const el of elements) {
      if (!el.isConnected && el.paused) { elements.delete(el); continue; }
      enforce(el);
    }
    applyEq();
  };

  window.__ympAudio = { get cap() { return cap; }, version: 1 };
  // 이미 문서에 있던 요소(가드가 늦게 심어진 임베드)도 즉시 상한을 건다
  for (const el of document.querySelectorAll('video, audio')) { track(el); enforce(el); }
  applyEq();
})();
