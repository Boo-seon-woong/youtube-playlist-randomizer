// 가사 저장소 — 게스트 로컬 재생목록(playlists.json)에 든 곡만 가사 + 싱크를 디스크에 저장해, 다음 재생부터는
// 검색·음성 인식 없이 바로 띄운다. 계정 연동 재생목록·검색으로 튼 곡은 저장하지 않는다(사용자 명세).
//
// userData/lyrics-store/
//   index.json      { version: 1, lists: { <listId>: [videoId, …] } } — 로컬 재생목록마다 마지막으로 끝까지 받아 본 곡 목록
//   <videoId>.json  { videoId, savedAt, data, heard, augment }
//                   data   = 표시용 가사(보강 전 원본 줄, 싱크 시각 포함) + sync 정보
//                   heard  = 음성 인식 결과(시각 포함) — 가사를 다른 것으로 바꿔도 소리를 다시 듣지 않고 바로 다시 맞춘다
//                   augment= 발음·웹 번역 줄(있으면) — 가사와 함께 지워지도록 같은 파일에 둔다
// 정리: 어느 로컬 재생목록에도 없는 곡의 파일은 지운다. 재생목록은 끝까지 받아 본 경우에만 곡 목록을 바꾼다
// (도중에 끊긴 수집으로 곡을 잘못 지우지 않게). 재생목록 자체가 로컬에서 지워지면 그 목록을 빼고 정리한다.
const fs = require('fs');
const path = require('path');

const SAFE_ID = /^[\w-]{6,20}$/;

class LyricsStore {
  constructor(dir) {
    this.dir = dir;
    this.index = { version: 1, lists: {} };
    this.scans = new Map(); // listId → Set(videoId) — 수집 중(끝나면 index에 반영)
    this.localLists = null; // 로컬 재생목록 listId 집합(playlists.json에서)
    this.gcTimer = null;
  }

  load(localListIds) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8'));
      if (parsed && parsed.lists && typeof parsed.lists === 'object') this.index = { version: 1, lists: parsed.lists };
    } catch {}
    this.setLocalLists(localListIds);
  }

  writeIndex() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.index));
    } catch {}
  }

  file(videoId) {
    return SAFE_ID.test(String(videoId || '')) ? path.join(this.dir, `${videoId}.json`) : null;
  }

  isLocalList(listId) {
    return !!(this.localLists && this.localLists.has(listId));
  }

  // 지금 로컬 재생목록 중 하나에 든 곡인가 (끝까지 받은 목록 + 수집 중인 목록)
  isLocalVideo(videoId) {
    for (const [listId, ids] of Object.entries(this.index.lists)) if (this.isLocalList(listId) && ids.includes(videoId)) return true;
    for (const [listId, ids] of this.scans) if (this.isLocalList(listId) && ids.has(videoId)) return true;
    return false;
  }

  get(videoId) {
    const f = this.file(videoId);
    if (!f) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  }

  // 로컬 곡일 때만 저장한다. 반환: 저장했는지
  put(videoId, entry) {
    const f = this.file(videoId);
    if (!f || !this.isLocalVideo(videoId)) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ ...entry, videoId, savedAt: new Date().toISOString() }));
      return true;
    } catch { return false; }
  }

  remove(videoId) {
    const f = this.file(videoId);
    if (f) { try { fs.unlinkSync(f); } catch {} }
  }

  // ── 재생목록 수집 추적 (main의 playlist:fetchFirst/fetchMore가 부른다) ──
  // 수집 중에는 곡을 목록에 "더하기만" 한다(앱을 도중에 꺼도 이미 저장한 가사가 지워지지 않게).
  // 끝까지 받았을 때만 목록을 그대로 바꿔, 재생목록에서 빠진 곡의 가사가 정리되게 한다.
  beginScan(listId, videoIds) {
    if (!this.isLocalList(listId)) return;
    this.scans.set(listId, new Set(videoIds));
    this.mergeIntoIndex(listId, videoIds);
  }

  addScan(listId, videoIds, done) {
    const set = this.scans.get(listId);
    if (!set) return;
    for (const id of videoIds) set.add(id);
    if (done) {
      this.index.lists[listId] = [...set];
      this.scans.delete(listId);
      this.writeIndex();
      this.scheduleGc();
    } else {
      this.mergeIntoIndex(listId, videoIds);
    }
  }

  mergeIntoIndex(listId, videoIds) {
    const cur = new Set(this.index.lists[listId] || []);
    const before = cur.size;
    for (const id of videoIds) cur.add(id);
    if (cur.size !== before) { this.index.lists[listId] = [...cur]; this.writeIndex(); }
  }

  // playlists.json이 바뀔 때마다(로컬 재생목록 추가·삭제) — 사라진 목록은 빼고 정리
  setLocalLists(listIds) {
    this.localLists = new Set(listIds || []);
    let changed = false;
    for (const listId of Object.keys(this.index.lists)) {
      if (!this.localLists.has(listId)) { delete this.index.lists[listId]; changed = true; }
    }
    if (changed) this.writeIndex();
    this.scheduleGc();
  }

  scheduleGc() {
    clearTimeout(this.gcTimer);
    this.gcTimer = setTimeout(() => this.gc(), 3000);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  // 어느 로컬 목록에도 없는 곡의 가사 파일을 지운다. 반환: 지운 영상 id 목록
  gc() {
    const keep = new Set();
    for (const ids of Object.values(this.index.lists)) for (const id of ids) keep.add(id);
    for (const ids of this.scans.values()) for (const id of ids) keep.add(id);
    const removed = [];
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return removed; }
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const id = name.slice(0, -5);
      if (keep.has(id)) continue;
      try { fs.unlinkSync(path.join(this.dir, name)); removed.push(id); } catch {}
    }
    return removed;
  }
}

// playlists.json 항목(폴더 중첩) → 로컬 재생목록 listId 목록
function localListIds(items) {
  const out = [];
  (function walk(arr) {
    for (const it of arr || []) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'folder') walk(it.items);
      else if (it.listId) out.push(String(it.listId));
    }
  })(items);
  return out;
}

module.exports = { LyricsStore, localListIds };
