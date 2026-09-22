const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function fixture() {
  const calls = [];
  const view = () => ({
    attrs: {}, events: {},
    getAttribute(k) { return this.attrs[k] || null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.events[k] = fn; },
    replaceWith(v) { calls.push(['replace', v]); },
    reload() { calls.push(['reload']); },
    executeJavaScript: async () => null,
  });
  const ctx = vm.createContext({
    fallbackView: view(), document: { createElement: view },
    GUEST_PLAYBACK_PARTITION: 'guest-playback', guestFallbackIds: new Set(),
    adGateTimer: null, adCssKey: '', clearTimeout() {},
    onFallbackConsoleMessage() {}, onFallbackReady() {},
    fallbackActive: true, fallbackVideoId: 'video123456', fallbackEnforcedId: '',
    adEnforcementSeen: true, fallbackIds: new Set(['video123456']),
    startFallback(id) { calls.push(['start', id]); },
    showToast(msg) { calls.push(['toast', msg]); },
    stopFallback() { calls.push(['stop']); }, nextTrack() { calls.push(['next']); },
    queue: ['video123456'], queueIndex: 0, fallbackStall: 9,
    titleCache: new Map(), publishLyricsState() {},
    unplayableIds: new Set(), markUnplayable() {},
  });
  vm.runInContext(extract('selectFallbackSession') + '\n' + extract('handleAdBlockEnforcement') + '\nasync ' + extract('pollFallback'), ctx);
  return { ctx, calls };
}
test('account-session enforcement retries the same song as guest before disabling ads or skipping', () => {
  const { ctx, calls } = fixture();
  ctx.adEnforcementSeen = false;
  ctx.handleAdBlockEnforcement();
  assert(ctx.guestFallbackIds.has('video123456'));
  assert.deepEqual(calls.filter(c => c[0] !== 'toast'), [['start', 'video123456']]);
  assert.equal(ctx.adEnforcementSeen, false);
});
test('switching session replaces webview and reattaches both event handlers', () => {
  const { ctx } = fixture();
  const original = ctx.fallbackView;
  ctx.selectFallbackSession(true);
  assert.notEqual(ctx.fallbackView, original);
  assert.equal(ctx.fallbackView.getAttribute('partition'), 'guest-playback');
  assert.equal(ctx.fallbackView.events['dom-ready'], ctx.onFallbackReady);
  assert.equal(ctx.fallbackView.events['console-message'], ctx.onFallbackConsoleMessage);
  const guest = ctx.fallbackView;
  ctx.selectFallbackSession(true);
  assert.equal(ctx.fallbackView, guest);
  ctx.selectFallbackSession(false);
  assert.equal(ctx.fallbackView.getAttribute('partition'), null);
});
test('enforcement in guest session uses bounded existing recovery', () => {
  const { ctx, calls } = fixture();
  ctx.selectFallbackSession(true);
  calls.length = 0;
  ctx.handleAdBlockEnforcement();
  ctx.handleAdBlockEnforcement();
  assert.deepEqual(calls.filter(c => c[0] !== 'toast'), [['reload'], ['stop'], ['next']]);
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
  ctx.fallbackView.executeJavaScript = () => new Promise(r => { resolve = r; });
  const pending = ctx.pollFallback('video123456');
  ctx.selectFallbackSession(true);
  resolve(null);
  await pending;
  assert.equal(ctx.fallbackStall, 9);
  assert(!calls.some(c => c[0] === 'next'));
});
