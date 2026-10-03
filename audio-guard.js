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
// state = { cap: 0~1(앱 볼륨의 실제 진폭), eq: { enabled, gains: [6개 dB] } }

(() => {
  if (window.__ympAudio) return;
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
      ctx.createMediaElementSource(el).connect(filters[0]);
      routed.add(el);
      if (!el.paused) ctx.resume().catch(() => {});
    } catch {
      // 이미 다른 컨텍스트에 연결된 요소 등 — EQ만 빠지고 볼륨 상한은 그대로 유지된다
    }
  }

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
