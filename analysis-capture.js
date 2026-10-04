// 미리 듣기(분석용 숨은 임베드) — main이 `ymp=analysis` 임베드 프레임에 심는다. 곡을 빠르게(약 5.5~6배속) 재생하며 소리를
// 받아 원래 시간축의 16kHz 모노로 바꿔 쌓는다. 스피커로는 아무 소리도 안 난다(그래프 출력이 0인 ScriptProcessor뿐).
// 유튜브 소리를 내려받는 것이 아니라 공식 임베드 플레이어로 재생하며 받는다(사용자 요청: 소리를 미리 받아 싱크를 빨리 끝내기).
//
// 원리: 음높이 보존을 끄고(preservesPitch=false) 배속 재생하면 출력은 원래 소리를 빠르게 돌린 것(음 높아짐)이다. 컨텍스트
// 표본율 sr에서 배속 r로 받으면 원래 시간축으로 sr/r Hz 표본이 된다 → r = sr/8000이면 정확히 8kHz(×2 보간해 16kHz),
// r = sr/16000이면 그대로 16kHz. 실측(WSLg, 44.1kHz): 5.5125배속 → whisper 정확도 실시간 녹음과 같거나 나음
// (CLAN QUEEN ±1초 100%, 히미츠 화성침공 96%), 4배속 이상에서도 소리가 나왔다. 높은 배속에서 소리가 안 나오면(브라우저가
// 배속 상한에서 음소거) 2초 뒤 sr/16000(약 3배속)으로 내린다.
(() => {
  if (window.__ympAnalysis) return;
  const st = { chunks: [], done: false, error: '', rate: 0, duration: 0, started: false };
  window.__ympAnalysis = st;
  window.__ympAnalysisTake = () => {
    const out = st.chunks.splice(0);
    return {
      done: st.done, error: st.error, rate: st.rate, duration: st.duration,
      chunks: out.map((c) => {
        const bytes = new Uint8Array(c.d.buffer);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { t: c.t, b64: btoa(s) };
      }),
    };
  };

  const begin = (v) => {
    if (st.started) return;
    st.started = true;
    let ctx;
    try { ctx = new AudioContext(); } catch (e) { st.error = 'audiocontext'; return; }
    const sr = ctx.sampleRate;
    // 원래 시간축 표본율(8000이면 ×2 보간). 다른 프로그램(게임 등)이 앞에 있는 동안(main이 __ympAnalysisSlow를 켠다)에는 16000 = 약 3배속 — 순간 부담을 절반으로
    // (그때 음성 인식은 CPU라 이보다 빨리 받아도 쓰지 못한다). 도중에 바뀌면 main이 __ympAnalysisSetSlow를 부른다.
    let fastSilent = false; // 높은 배속에서 소리가 안 나와 내린 적이 있으면 다시 올리지 않는다
    const fastMode = () => (!fastSilent && sr / 8000 <= 6.5 ? 8000 : 16000);
    let mode = window.__ympAnalysisSlow ? 16000 : fastMode();
    window.__ympAnalysisSetSlow = (slow) => { mode = slow ? 16000 : fastMode(); applyRate(); };
    const applyRate = () => {
      st.rate = sr / mode;
      v.preservesPitch = false;
      try { v.mozPreservesPitch = false; v.webkitPreservesPitch = false; } catch (e) {}
      if (Math.abs(v.playbackRate - st.rate) > 1e-3) v.playbackRate = st.rate;
    };
    const src = ctx.createMediaElementSource(v);
    const proc = ctx.createScriptProcessor(4096, 2, 1);
    let silentSince = 0;
    let silentFrom = 0; // 무음이 시작된 영상 시각 — 재생이 실제로 나아가는데도 무음일 때만 배속을 내린다
    proc.onaudioprocess = (e) => {
      if (v.paused || st.done) return;
      const player = document.getElementById('movie_player');
      if (player && player.classList.contains('ad-showing')) return;
      const a = e.inputBuffer.getChannelData(0);
      const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a;
      let energy = 0;
      for (let i = 0; i < a.length; i += 8) energy += Math.abs(a[i]) + Math.abs(b[i]);
      // 높은 배속에서 소리가 안 나오면 약 3배속으로 내린다. 재생이 실제로 3초 이상 나아갔는데도 무음일 때만 —
      // 곡 중간부터 받을 때(start=…) 처음 버퍼링 동안의 무음을 배속 문제로 착각하지 않게(예전 조건 'currentTime > 3'은 늘 참)
      if (energy < 1e-4 && mode === 8000) {
        if (!silentSince) { silentSince = performance.now(); silentFrom = v.currentTime; }
        else if (performance.now() - silentSince > 2000 && v.currentTime - silentFrom > 3) { fastSilent = true; mode = 16000; applyRate(); silentSince = 0; }
      } else silentSince = 0;
      const up = mode === 8000 ? 2 : 1;
      const out = new Int16Array(a.length * up);
      for (let i = 0; i < a.length; i++) {
        const s0 = (a[i] + b[i]) / 2;
        const s1 = i + 1 < a.length ? (a[i + 1] + b[i + 1]) / 2 : s0;
        out[i * up] = Math.max(-32768, Math.min(32767, Math.round(s0 * 32767)));
        if (up === 2) out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(((s0 + s1) / 2) * 32767)));
      }
      st.chunks.push({ t: v.currentTime, d: out });
      if (st.chunks.length > 3000) st.chunks.splice(0, st.chunks.length - 3000);
    };
    src.connect(proc);
    proc.connect(ctx.destination); // 출력은 0 — 소리는 나지 않는다
    v.addEventListener('ratechange', () => { if (!st.done) setTimeout(applyRate, 0); });
    v.addEventListener('ended', () => { st.done = true; });
    v.addEventListener('durationchange', () => { st.duration = v.duration || st.duration; });
    st.duration = v.duration || 0;
    v.muted = false;
    v.volume = 1;
    applyRate();
    ctx.resume().catch(() => {});
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  };

  // 영상 요소가 생길 때까지 기다렸다가 시작
  const wait = () => {
    const v = document.querySelector('video');
    if (v && v.readyState >= 1) begin(v);
    else if (!st.started) setTimeout(wait, 200);
  };
  wait();
  // 오류 화면(임베드 금지 영상 등)
  setTimeout(() => {
    if (!st.started || (document.querySelector('.ytp-error') && getComputedStyle(document.querySelector('.ytp-error')).display !== 'none')) st.error = st.error || 'unplayable';
  }, 12000);
})();
