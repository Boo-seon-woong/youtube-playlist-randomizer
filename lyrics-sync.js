// 자동 싱크 일정 관리 — 재생되는 소리(16kHz 모노 청크)를 곡별로 모아 음성 인식에 넘기고, 창이 하나 끝날 때마다
// 가사 후보들을 들은 글자에 다시 맞춰 결과를 알린다. Electron 비의존(main이 함수를 넘겨 준다).
//
// 소리는 재생되는 순간에만 흐르므로(유튜브 프레임 안) 첫 재생 중에 점진적으로 계산된다 — 들은 부분부터 차례로 정밀
// 싱크가 되고, 아직 안 들은 줄은 들은 부분에서 잰 노래 빠르기로 예측한다(lyrics-align.js fillTimes).
//
// 굴러가는 창(rolling): "확정된 지점"부터 30초를 넘기고 앞 28초만 처리(-d)한 뒤, 끝에 걸친 조각을 뺀 마지막 조각 끝을
// 다음 확정 지점으로 삼는다. whisper는 창 끝보다 일찍 끝난 남은 몇 초를 위해 인코더를 한 번 더(30초 분량) 돌리는데
// (실측: 고정 30초 창마다 인코더 2회), 이렇게 하면 창마다 1회다. 첫 창은 소리가 10초만 모여도 바로 처리해 목소리가
// 시작되는 시점을 일찍 안다. 실측(4스레드, 경합 없음): 창당 4.4~5.1초 ≈ 실시간의 0.2배 — 예전(고정 창·빔 5·2스레드)의
// 약 3.5배 빠르다. 짧은 창(14초)은 오히려 정확도가 떨어졌다(千鳥 ±1초 93→53%).

const SR = 16000;
const SPAN_MS = 28000; // 한 창에서 확정할 길이(-d)
const LOOK_MS = 2000; // 그 뒤로 더 넘겨 주는 소리(경계에 걸린 낱말을 살리는 문맥)
const FIRST_SPAN_MS = 10000; // 첫 창 — 목소리 시작을 빨리 찾는다
const CUT_GUARD_MS = 1500; // 창 끝에서 이만큼 안에 끝나는 조각은 다음 창에서 다시(잘렸을 수 있다)
const BIN = 0.1; // 채움 기록 단위(초)
const QUIET_MS = 6000; // 이 시간 동안 새 소리가 없으면(일시정지·건너뛰기) 덜 찬 창도 처리한다
const MAX_VIDEOS = 3;

class SyncEngine {
  // runAsr({pcm, lang, offsetMs, prompt, durationMs}) → Promise<[조각]>, runAlign({candidates, heard, durationMs, heardUntil}) → Promise<[결과]>
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

  // 지금 곡 지정(곡이 바뀔 때마다). meta: { durationMs, lang, candidates:[{lines}], doneWindows? }
  // meta가 없으면 지금 곡 표시만 바꾼다(그 곡은 싱크할 게 없음 — 이전 곡의 남은 창을 계속 처리)
  setCurrent(vid, meta) {
    this.current = vid || '';
    if (!vid || !meta) { this.pump(); return; }
    const v = this.ensure(vid, meta);
    v.lastFeedAt = Date.now();
    this.evict();
    this.pump();
    // 저장된 들은 글자가 있으면 바로 맞춰 본다(가사만 바뀐 경우 소리를 다시 듣지 않는다)
    if (v.windows.length) this.alignNow(v);
  }

  ensure(vid, meta = {}) {
    let v = this.videos.get(vid);
    if (!v) {
      v = { vid, durationMs: 0, lang: 'auto', candidates: [], pcm: null, bins: null, windows: [], at: 0, lastFeedAt: 0, alignSeq: 0 };
      this.videos.set(vid, v);
      // 저장본에서 이어 하기: 예전 형식(k만 있는 28초 격자 창)도 from/to를 계산해 받는다
      for (const w of meta.doneWindows || []) {
        const from = w.from != null ? w.from : w.k * 28000;
        const to = w.to != null ? w.to : from + 28000;
        v.windows.push({ from, to, segs: w.segs || [] });
      }
      v.windows.sort((a, b) => a.from - b.from);
      v.at = v.windows.reduce((m, w) => Math.max(m, w.to), 0);
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
    this.alignNow(v);
  }

  isComplete(v) {
    return v.durationMs > 0 && v.at >= v.durationMs - 1500;
  }

  // 소리 청크: startSec = 청크 첫 표본의 영상 시각
  feed(vid, startSec, pcm) {
    const v = this.videos.get(vid);
    if (!v || !(v.durationMs > 0) || !pcm || !pcm.length || this.isComplete(v)) return;
    const total = Math.ceil((v.durationMs / 1000 + 3) * SR);
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

  // [fromMs, toMs) 중 소리가 들어온 비율
  fill(v, fromMs, toMs) {
    if (!v.bins) return 0;
    const b0 = Math.max(0, Math.floor(fromMs / 1000 / BIN));
    const b1 = Math.min(v.bins.length, Math.ceil(toMs / 1000 / BIN));
    if (b1 <= b0) return 0;
    let n = 0;
    for (let b = b0; b < b1; b++) n += v.bins[b];
    return n / (b1 - b0);
  }

  // 다음에 처리할 창 {from, span, last} 또는 null
  nextWindow(v) {
    if (!v.pcm || this.isComplete(v)) return null;
    const dur = v.durationMs;
    const quiet = Date.now() - v.lastFeedAt > QUIET_MS || v.vid !== this.current;
    let from = v.at;
    // 확정 지점에 소리가 없고(건너뛰기·되감기) 조용해졌으면 소리가 있는 다음 지점으로 건너뛴다
    if (this.fill(v, from, from + 1000) < 0.5) {
      if (!quiet) return null;
      const b0 = Math.floor(from / 1000 / BIN);
      let b = b0;
      while (b < v.bins.length && !v.bins[b]) b++;
      if (b >= v.bins.length) return null;
      from = b * BIN * 1000;
      v.at = from;
    }
    const first = !v.windows.length && from < 1000;
    const span = first ? FIRST_SPAN_MS : SPAN_MS;
    const last = from + span >= dur - 1500;
    const need = last ? dur - from : first ? span : span + LOOK_MS;
    if (this.fill(v, from, from + need) >= 0.95) return { from, span: last ? dur - from : span, last, tile: first && !last };
    // 조용해졌으면(일시정지·곡 넘김) 들어온 만큼만이라도
    if (quiet && this.fill(v, from, from + Math.min(need, 8000)) >= 0.9) {
      let b = Math.floor(from / 1000 / BIN);
      while (b < v.bins.length && v.bins[b]) b++;
      const filledTo = b * BIN * 1000;
      return { from, span: Math.max(1000, filledTo - from), last: true, partial: true };
    }
    return null;
  }

  async pump() {
    if (this.busy || !this.enabled) return;
    // 지금 곡 먼저, 그다음 최근에 소리가 들어온 순
    const order = [...this.videos.values()].sort((a, b) => (b.vid === this.current) - (a.vid === this.current) || b.lastFeedAt - a.lastFeedAt);
    for (const v of order) {
      if (!v.candidates.length) continue;
      const w = this.nextWindow(v);
      if (!w) continue;
      this.busy = true;
      try {
        await this.runWindow(v, w);
      } catch {
        v.at = w.from + w.span; // 실패한 구간은 건너뛴다(같은 자리에서 멈추지 않게)
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

  async runWindow(v, w) {
    const s0 = Math.round((w.from / 1000) * SR);
    const s1 = Math.min(v.pcm.length, Math.round(((w.from + w.span + (w.last ? 0 : LOOK_MS)) / 1000) * SR));
    let pcm = v.pcm.slice(s0, s1);
    // 첫 창(10초)은 30초로 이어 붙여(반복) 넘긴다 — whisper는 짧은 소리를 무음으로 30초까지 채우면 노래를 못 알아듣고
    // "♪~"만 낸다(실측: 12초 그대로 → ♪~, 10초를 반복해 30초 → 1.4/3.3/5.0/6.3/8.7초 정답 1.7/3.4/5.3/8.6초).
    // 12·15초 반복은 불안정했다(로마자 출력·♪~) — 10초만 쓴다. 확정은 -d로 앞 10초만.
    if (w.tile) {
      const full = new Int16Array(30 * SR);
      for (let o = 0; o < full.length; o += pcm.length) full.set(pcm.subarray(0, Math.min(pcm.length, full.length - o)), o);
      pcm = full;
    }
    const prev = v.windows[v.windows.length - 1];
    const prompt = prev && prev.segs.length ? prev.segs.slice(-3).map((x) => x.text).join(' ').slice(-200) : '';
    const segs = (await this.runAsr({ pcm, lang: v.lang, offsetMs: w.from, prompt, durationMs: w.last ? 0 : w.span }))
      .filter((seg) => !w.tile || seg.t0 < w.from + w.span); // 이어 붙인 뒷부분(반복)은 버린다
    // 창 끝 근처(1.5초)의 낱말은 잘렸을 수 있어 다음 창에서 다시 — 확정은 토큰 단위로 그 앞까지.
    // (조각 단위로 자르면 창 전체가 한 조각으로 나온 경우 — 이어 붙인 첫 창에서 실측 — 통째로 버려졌다)
    const cut = w.from + w.span;
    const limit = w.last ? Infinity : cut - CUT_GUARD_MS;
    const kept = [];
    let commitEnd = w.from;
    for (const seg of segs || []) {
      const toks = (seg.tokens || []).filter((t) => t.t < limit);
      if (!toks.length) continue;
      const whole = toks.length === seg.tokens.length;
      kept.push(whole ? seg : { t0: seg.t0, t1: Math.min(seg.t1, limit), text: toks.map((t) => t.text).join(''), tokens: toks });
      commitEnd = Math.max(commitEnd, whole ? Math.min(seg.t1, limit) : toks[toks.length - 1].t);
    }
    const to = w.last ? w.from + w.span : (commitEnd > w.from + 4000 ? commitEnd : limit);
    v.windows.push({ from: w.from, to, segs: kept });
    v.at = Math.max(v.at, to);
  }

  heard(v) {
    return v.windows.slice().sort((a, b) => a.from - b.from).flatMap((w) => w.segs);
  }

  progress(v) {
    return v.durationMs > 0 ? Math.min(1, v.at / v.durationMs) : 0;
  }

  async alignNow(v) {
    if (!v.candidates.length) return;
    const seq = ++v.alignSeq;
    const heard = this.heard(v);
    let results = null;
    try { results = await this.runAlign({ candidates: v.candidates, heard, durationMs: v.durationMs, heardUntil: v.at }); } catch { return; }
    if (seq !== v.alignSeq || !results) return; // 그새 더 새 정렬이 시작됨
    const complete = this.isComplete(v);
    const doneWindows = v.windows.map((w) => ({ from: w.from, to: w.to, segs: w.segs }));
    this.onResult(v.vid, { results, progress: this.progress(v), complete, heard, doneWindows });
    if (complete) { v.pcm = null; v.bins = null; } // 다 들었으면 소리는 버린다(들은 글자만 남긴다)
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

module.exports = { SyncEngine, SR };
