// 자동 싱크 일정 관리 — 재생되는 소리(16kHz 모노 청크)를 곡별로 모아 30초 창 단위로 음성 인식에 넘기고,
// 창이 하나 끝날 때마다 가사 후보들을 들은 글자에 다시 맞춰 결과를 알린다. Electron 비의존(main이 함수를 넘겨 준다).
//
// 소리는 재생되는 순간에만 흐르므로(유튜브 프레임 안) 첫 재생 중에 점진적으로 계산된다 — 그동안 화면은 1차(대략)
// 싱크, 창이 끝날 때마다 들은 구간까지 정밀 싱크로 바뀐다. 인식은 한 번에 하나(IDLE 우선순위 2스레드) — 지금 곡이 먼저,
// 다 못 끝낸 이전 곡은 잠깐 뒤로(최대 3곡). whisper는 창 길이와 상관없이 30초 단위로 계산하므로 창은 30초,
// 28초 간격(2초 겹침 — 경계에 걸린 낱말을 살린다)으로 고정한다.
// 실측(/root/asrtest/sim.js, small-q8_0 + DTW 시각 + 앞 창 글자를 프롬프트로): 정답 싱크가 있는 곡에서 줄 91~100%가 ±1초 안.

const SR = 16000;
const WIN = 30;
const STRIDE = 28;
const BIN = 0.1; // 채움 기록 단위(초)
const READY_FILL = 0.8;
const QUIET_MS = 6000; // 이 시간 동안 새 소리가 없으면(일시정지·건너뛰기) 덜 찬 창도 처리한다
const MAX_VIDEOS = 3;

class SyncEngine {
  // runAsr({pcm, lang, offsetMs, prompt}) → Promise<[조각]>, runAlign({candidates, heard, durationMs}) → Promise<[결과]>
  // onResult(vid, {results, progress, complete, heard, doneWindows})
  constructor({ runAsr, runAlign, onResult }) {
    this.runAsr = runAsr;
    this.runAlign = runAlign;
    this.onResult = onResult;
    this.videos = new Map();
    this.current = '';
    this.busy = false;
    this.enabled = true;
  }

  // 지금 곡 지정(곡이 바뀔 때마다). meta: { durationMs, lang, candidates:[{lines}], heard?, doneWindows? }
  // meta가 없으면 지금 곡 표시만 바꾼다(그 곡은 싱크할 게 없음 — 이전 곡의 남은 창을 계속 처리)
  setCurrent(vid, meta) {
    this.current = vid || '';
    if (!vid || !meta) { this.pump(); return; }
    const v = this.ensure(vid, meta);
    v.lastFeedAt = Date.now();
    this.evict();
    this.pump();
    // 저장된 들은 글자가 있으면 바로 맞춰 본다(가사만 바뀐 경우 소리를 다시 듣지 않는다)
    if (v.windows.size) this.alignNow(v);
  }

  ensure(vid, meta = {}) {
    let v = this.videos.get(vid);
    if (!v) {
      v = { vid, durationMs: 0, lang: 'auto', candidates: [], pcm: null, bins: null, windows: new Map(), lastFeedAt: 0, alignSeq: 0, completeSent: false };
      this.videos.set(vid, v);
      for (const w of meta.doneWindows || []) v.windows.set(w.k, { done: true, segs: w.segs || [] });
    }
    if (meta.durationMs > 0) v.durationMs = meta.durationMs;
    if (meta.lang) v.lang = meta.lang;
    if (meta.candidates) v.candidates = meta.candidates;
    return v;
  }

  // 가사 후보만 바뀜(사용자가 다른 가사 선택 등) — 들은 글자로 즉시 다시 맞춘다
  setCandidates(vid, candidates) {
    const v = this.videos.get(vid);
    if (!v) return;
    v.candidates = candidates;
    v.completeSent = false;
    this.alignNow(v);
  }

  windowCount(v) {
    const dur = v.durationMs / 1000;
    if (!(dur > 0)) return 0;
    return Math.max(1, Math.ceil(Math.max(0, dur - (WIN - STRIDE)) / STRIDE));
  }

  // 소리 청크: startSec = 청크 첫 표본의 영상 시각
  feed(vid, startSec, pcm) {
    const v = this.videos.get(vid);
    if (!v || !(v.durationMs > 0) || !pcm || !pcm.length) return;
    const total = Math.ceil((v.durationMs / 1000 + 2) * SR);
    if (!v.pcm) { v.pcm = new Int16Array(total); v.bins = new Uint8Array(Math.ceil(total / SR / BIN)); }
    const start = Math.max(0, Math.round(startSec * SR));
    if (start >= v.pcm.length) return;
    const part = pcm.subarray(0, Math.min(pcm.length, v.pcm.length - start));
    v.pcm.set(part, start);
    const b0 = Math.floor(start / SR / BIN);
    const b1 = Math.min(v.bins.length, Math.ceil((start + part.length) / SR / BIN));
    for (let b = b0; b < b1; b++) v.bins[b] = 1;
    v.lastFeedAt = Date.now();
    this.pump();
  }

  fillRatio(v, k) {
    if (!v.bins) return 0;
    const dur = v.durationMs / 1000;
    const s = k * STRIDE;
    const e = Math.min(s + WIN, dur);
    const b0 = Math.floor(s / BIN);
    const b1 = Math.min(v.bins.length, Math.ceil(e / BIN));
    if (b1 <= b0) return 0;
    let n = 0;
    for (let b = b0; b < b1; b++) n += v.bins[b];
    return n / (b1 - b0);
  }

  readyWindow(v) {
    const n = this.windowCount(v);
    const quiet = Date.now() - v.lastFeedAt > QUIET_MS || v.vid !== this.current;
    for (let k = 0; k < n; k++) {
      if (v.windows.has(k)) continue;
      const fill = this.fillRatio(v, k);
      if (fill <= 0) continue;
      const dur = v.durationMs / 1000;
      const endBin = Math.min(v.bins.length - 1, Math.floor(Math.min(k * STRIDE + WIN, dur) / BIN) - 1);
      const endFilled = endBin >= 0 && v.bins[endBin] === 1;
      if ((fill >= READY_FILL && endFilled) || (quiet && fill >= 0.25)) return k;
    }
    return -1;
  }

  async pump() {
    if (this.busy || !this.enabled) return;
    // 지금 곡 먼저, 그다음 최근에 소리가 들어온 순
    const order = [...this.videos.values()].sort((a, b) => (b.vid === this.current) - (a.vid === this.current) || b.lastFeedAt - a.lastFeedAt);
    for (const v of order) {
      if (!v.pcm || !v.candidates.length) continue;
      const k = this.readyWindow(v);
      if (k < 0) continue;
      this.busy = true;
      try {
        await this.runWindow(v, k);
      } catch {
        v.windows.set(k, { done: true, segs: [], failed: true });
      } finally {
        this.busy = false;
      }
      this.alignNow(v);
      setTimeout(() => this.pump(), 0);
      return;
    }
    // 덜 찬 창은 조용해질 때까지 기다린다 — 그 시점에 다시 본다
    if (!this.pumpTimer) {
      this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, QUIET_MS + 500);
      if (this.pumpTimer.unref) this.pumpTimer.unref();
    }
  }

  async runWindow(v, k) {
    const s = k * STRIDE;
    const pcm = v.pcm.slice(Math.round(s * SR), Math.min(v.pcm.length, Math.round((s + WIN) * SR)));
    const prev = v.windows.get(k - 1);
    const prompt = prev && prev.segs.length ? prev.segs.slice(-3).map((x) => x.text).join(' ').slice(-200) : '';
    const segs = await this.runAsr({ pcm, lang: v.lang, offsetMs: s * 1000, prompt });
    // 겹친 2초는 반씩 나눠 가진다 — 앞 창은 끝 1초, 뒤 창은 처음 1초를 버린다
    const n = this.windowCount(v);
    const lo = (s + (k > 0 ? 1 : 0)) * 1000;
    const hi = (s + WIN - (k < n - 1 ? 1 : 0)) * 1000;
    const kept = [];
    for (const seg of segs || []) {
      const toks = (seg.tokens || []).filter((t) => t.t >= lo && t.t < hi);
      if (toks.length) kept.push({ t0: seg.t0, t1: seg.t1, text: toks.map((t) => t.text).join(''), tokens: toks });
    }
    v.windows.set(k, { done: true, segs: kept });
  }

  heard(v) {
    return [...v.windows.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, w]) => w.segs);
  }

  progress(v) {
    const n = this.windowCount(v);
    return n ? Math.min(1, v.windows.size / n) : 0;
  }

  async alignNow(v) {
    if (!v.candidates.length) return;
    const seq = ++v.alignSeq;
    const heard = this.heard(v);
    let results = null;
    try { results = await this.runAlign({ candidates: v.candidates, heard, durationMs: v.durationMs }); } catch { return; }
    if (seq !== v.alignSeq || !results) return; // 그새 더 새 정렬이 시작됨
    const complete = this.windowCount(v) > 0 && v.windows.size >= this.windowCount(v);
    const doneWindows = [...v.windows.entries()].map(([k, w]) => ({ k, segs: w.segs }));
    this.onResult(v.vid, { results, progress: this.progress(v), complete, heard, doneWindows });
    if (complete) { v.pcm = null; v.bins = null; } // 다 들었으면 소리는 버린다(들은 글자만 남긴다)
  }

  isActive(vid) {
    const v = this.videos.get(vid);
    return !!v && (v.pcm !== null || !this.windowCount(v) || v.windows.size < this.windowCount(v));
  }

  // 소리를 들고 있는 곡은 최대 3개 — 오래된 것부터 버린다(지금 곡은 지키고)
  evict() {
    const list = [...this.videos.values()].filter((v) => v.vid !== this.current).sort((a, b) => b.lastFeedAt - a.lastFeedAt);
    for (const v of list.slice(MAX_VIDEOS - 1)) this.videos.delete(v.vid);
  }

  drop(vid) {
    this.videos.delete(vid);
  }
}

module.exports = { SyncEngine, SR, WIN, STRIDE };
