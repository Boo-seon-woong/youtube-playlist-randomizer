const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const ID = 'video123456';
function fixture() {
  const calls = [];
  const view = () => ({
    attrs: {}, events: {}, src: '', classList: { add() {}, remove() {} },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.events[k] = fn; },
    replaceWith(v) { calls.push(['replace', v.attrs.partition || '']); },
    reload() { calls.push(['reload']); },
    executeJavaScript: async () => null,
    getWebContentsId() { return 7; },
    getURL() { return this.src || 'about:blank'; },
  });
  const ctx = vm.createContext({
    fallbackView: view(), document: { createElement: view },
    GUEST_PLAYBACK_PARTITION: 'guest-playback', guestIdentity: 0,
    accountFallbackIds: new Set(), enforcementRetries: new Map(),
    adGateTimer: null, adCssKey: '', clearTimeout() {}, clearInterval() {}, setInterval() { return 1; },
    setTimeout() { return 0; }, // 준비 대기 시간 제한(3초)은 울리지 않게 — 준비 완료로만 진행
    onFallbackConsoleMessage() {}, onFallbackReady() {}, pollSkipClick() {},
    fallbackActive: true, fallbackVideoId: ID, fallbackSeenId: '', fallbackAdShowing: false,
    adEvasionEnabled: false, adEnforcementSeen: true, precisePlaybackActive: false,
    fallbackIds: new Set([ID]),
    showToast(msg) { calls.push(['toast', msg]); },
    stopFallback() { calls.push(['stop']); }, nextTrack() { calls.push(['next']); }, playCurrent() { calls.push(['playCurrent']); },
    queue: [ID], queueIndex: 0, fallbackStall: 0,
    titleCache: new Map(), publishLyricsState() {}, setNowPlaying() {}, updateQueueHighlight() {},
    unplayableIds: new Set(), markUnplayable() {}, absorbElementFullscreen() {}, fallbackAdGate() {},
    player: { stopVideo() {} }, placeholder: {}, watchdogTimer: null, stallTimer: null, fallbackPollTimer: null, skipPollTimer: null,
    accountState: { loggedIn: true },
    window: { fallbackctl: { prepare: async () => true } },
  });
  vm.runInContext([
    extract('guestPartition'), extract('selectFallbackSession'), extract('startFallback'),
    'async ' + extract('loadFallbackPage'), extract('handleAdBlockEnforcement'), 'async ' + extract('pollFallback'),
  ].join('\n'), ctx);
  return { ctx, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

test('direct playback opens in a guest partition by default and in the account session only for login-required tracks', async () => {
  const { ctx } = fixture();
  ctx.startFallback(ID);
  assert.equal(ctx.fallbackView.getAttribute('partition'), 'guest-playback');
  await tick();
  assert.equal(ctx.fallbackView.src, `https://www.youtube.com/watch?v=${ID}`);
  ctx.accountFallbackIds.add(ID);
  ctx.startFallback(ID);
  assert.equal(ctx.fallbackView.getAttribute('partition'), null);
});

test('switching session replaces webview and reattaches both event handlers', () => {
  const { ctx } = fixture();
  const original = ctx.fallbackView;
  ctx.selectFallbackSession('guest-playback');
  assert.notEqual(ctx.fallbackView, original);
  assert.equal(ctx.fallbackView.getAttribute('partition'), 'guest-playback');
  assert.equal(ctx.fallbackView.events['dom-ready'], ctx.onFallbackReady);
  assert.equal(ctx.fallbackView.events['console-message'], ctx.onFallbackConsoleMessage);
  const guest = ctx.fallbackView;
  ctx.selectFallbackSession('guest-playback');
  assert.equal(ctx.fallbackView, guest);
  ctx.selectFallbackSession('');
  assert.equal(ctx.fallbackView.getAttribute('partition'), null);
});

test('enforcement reopens the same track with a fresh guest identity, at most twice, then skips', () => {
  const { ctx, calls } = fixture();
  ctx.startFallback(ID);
  ctx.handleAdBlockEnforcement();
  assert.equal(ctx.fallbackView.getAttribute('partition'), 'guest-playback-1');
  assert.equal(ctx.fallbackVideoId, ID);
  ctx.handleAdBlockEnforcement();
  assert.equal(ctx.fallbackView.getAttribute('partition'), 'guest-playback-2');
  calls.length = 0;
  ctx.handleAdBlockEnforcement();
  assert.deepEqual(calls.filter((c) => c[0] !== 'toast'), [['stop'], ['next']]);
});

test('enforcement on a track that the embed can play goes back to the embed and stops precise-volume routing', () => {
  const { ctx, calls } = fixture();
  ctx.fallbackIds = new Set();
  ctx.precisePlaybackActive = true;
  ctx.handleAdBlockEnforcement();
  assert.equal(ctx.precisePlaybackActive, false);
  assert.deepEqual(calls.filter((c) => c[0] !== 'toast'), [['stop'], ['playCurrent']]);
});

test('inactive webview cannot trigger recovery', () => {
  const { ctx, calls } = fixture();
  ctx.fallbackActive = false;
  ctx.handleAdBlockEnforcement();
  assert.deepEqual(calls, []);
});

test('old session polling cannot skip the replacement session', async () => {
  const { ctx, calls } = fixture();
  let resolve;
  ctx.fallbackView.executeJavaScript = () => new Promise((r) => { resolve = r; });
  const pending = ctx.pollFallback(ID);
  ctx.selectFallbackSession('guest-playback-9');
  resolve(null);
  await pending;
  assert.equal(ctx.fallbackStall, 0);
  assert(!calls.some((c) => c[0] === 'next'));
});

test('the previous track page read before the new page opens does not skip the new track', async () => {
  const { ctx, calls } = fixture();
  ctx.fallbackView.executeJavaScript = async () => ({ vid: 'previous001', t: 50, d: 200, ended: false, paused: false, ad: false });
  await ctx.pollFallback(ID);
  assert(!calls.some((c) => c[0] === 'next'));
  assert.equal(ctx.fallbackStall, 1);
  ctx.fallbackView.executeJavaScript = async () => ({ vid: ID, t: 1, d: 200, ended: false, paused: false, ad: false });
  await ctx.pollFallback(ID);
  assert.equal(ctx.fallbackSeenId, ID);
  // 이 곡을 본 뒤에 다른 영상으로 넘어갔으면(유튜브 자동재생) 다음 곡으로
  ctx.fallbackView.executeJavaScript = async () => ({ vid: 'autoplay001', t: 1, d: 100, ended: false, paused: false, ad: false });
  await ctx.pollFallback(ID);
  assert.deepEqual(calls.filter((c) => c[0] !== 'toast'), [['stop'], ['next']]);
});

test('a login-required track in the guest identity reopens in the account session when signed in', async () => {
  const { ctx } = fixture();
  ctx.startFallback(ID);
  ctx.fallbackView.executeJavaScript = async () => ({ vid: ID, t: 0, d: 0, ended: false, paused: true, ad: false, ps: 'LOGIN_REQUIRED' });
  await ctx.pollFallback(ID);
  assert(ctx.accountFallbackIds.has(ID));
  assert.equal(ctx.fallbackView.getAttribute('partition'), null);

  const signedOut = fixture().ctx;
  signedOut.accountState = { loggedIn: false };
  signedOut.startFallback(ID);
  signedOut.fallbackView.executeJavaScript = async () => ({ vid: ID, t: 0, d: 0, ended: false, paused: true, ad: false, ps: 'LOGIN_REQUIRED' });
  await signedOut.pollFallback(ID);
  assert(!signedOut.accountFallbackIds.has(ID));
  assert.equal(signedOut.fallbackStall, 1);
});

test('the page is opened only after main has prepared the interception, and never for a stale track', async () => {
  const { ctx } = fixture();
  let release;
  ctx.window.fallbackctl.prepare = () => new Promise((r) => { release = r; });
  ctx.startFallback(ID);
  await tick();
  assert.equal(ctx.fallbackView.src, '');
  ctx.fallbackVideoId = 'another0001'; // 준비를 기다리는 사이 다른 곡으로 바뀌었다
  release(true);
  await tick();
  assert.equal(ctx.fallbackView.src, '');
});
