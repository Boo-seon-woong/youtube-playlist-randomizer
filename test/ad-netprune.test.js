const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transformWatchHtml, transformPlayerJson, stripPlayerResponse, jsonEnd } = require('../ad-netprune');

const START_CONFIG = { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_START', adTimeOffset: { offsetStartMilliseconds: '0', offsetEndMilliseconds: '-1' }, hideCueRangeMarker: true } };
const LOGGING = { serializedSlotAdServingDataEntry: 'ChMI' };
// 실제 광고가 잡힌 응답 모양(2026-10 워치페이지 실측: adPlacements에 실제 렌더러, adSlots 존재)
function adResponse() {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: 'kJQP7kiw5Fk', title: 'a </script> b' },
    adPlacements: [
      { adPlacementRenderer: { config: START_CONFIG, renderer: { linearAdSequenceRenderer: { ads: [1, 2] } }, adSlotLoggingData: LOGGING } },
      { adPlacementRenderer: { config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_MILLISECONDS' } }, renderer: { adBreakServiceRenderer: {} } } },
    ],
    adSlots: [{ adSlotRenderer: { adSlotMetadata: { triggerEvent: 'SLOT_TRIGGER_EVENT_BEFORE_CONTENT' } } }],
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adBreakHeartbeatParams: 'Q0FBJTNE',
  };
}

test('real ads become the placeholder YouTube itself sends when there is no ad, keeping the preroll slot', () => {
  const pr = adResponse();
  assert.equal(stripPlayerResponse(pr), true);
  assert.deepEqual(pr.adPlacements, [{ adPlacementRenderer: { config: START_CONFIG, renderer: { clientForecastingAdRenderer: {} }, adSlotLoggingData: LOGGING } }]);
  assert.equal('adSlots' in pr, false);
  // uBO와 같이 이 둘은 남긴다(지워도 광고는 없어지지 않고 감지 거리만 는다)
  assert.ok(pr.playerAds && pr.adBreakHeartbeatParams);
});

test('a response that already has only the placeholder is left untouched', () => {
  const pr = { playabilityStatus: { status: 'OK' }, adPlacements: [{ adPlacementRenderer: { config: START_CONFIG, renderer: { clientForecastingAdRenderer: {} } } }] };
  const before = JSON.stringify(pr);
  assert.equal(stripPlayerResponse(pr), false);
  assert.equal(JSON.stringify(pr), before);
});

test('placements without a preroll are removed outright', () => {
  const pr = { playabilityStatus: { status: 'OK' }, adPlacements: [{ adPlacementRenderer: { config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_END' } }, renderer: { linearAdSequenceRenderer: {} } } }] };
  assert.equal(stripPlayerResponse(pr), true);
  assert.equal('adPlacements' in pr, false);
});

test('jsonEnd follows nesting and ignores braces inside strings and escaped quotes', () => {
  const text = 'x = {"a":"}{\\"]","b":[1,{"c":"}"}]};tail';
  const end = jsonEnd(text, 4);
  assert.equal(text.slice(end), ';tail');
  assert.deepEqual(JSON.parse(text.slice(4, end)), { a: '}{"]', b: [1, { c: '}' }] });
  assert.equal(jsonEnd('{"open":', 0), -1);
});

test('the watch page HTML keeps everything outside the inline player response byte-for-byte', () => {
  const inline = JSON.stringify(adResponse()).replace(/</g, '\\u003c');
  const head = '<html><script nonce="n">var ytInitialPlayerResponse = ';
  const tail = ';var meta = document.createElement(\'meta\');</script><script>var ytInitialData = {"x":1};</script></html>';
  const out = transformWatchHtml(head + inline + tail);
  assert.ok(out.startsWith(head));
  assert.ok(out.endsWith(tail));
  const json = out.slice(head.length, out.length - tail.length);
  assert.equal(json.includes('<'), false); // 문자열 속 </script>가 태그를 끊지 않는다
  const pr = JSON.parse(json);
  assert.equal(pr.videoDetails.title, 'a </script> b');
  assert.equal('adSlots' in pr, false);
  assert.ok('clientForecastingAdRenderer' in pr.adPlacements[0].adPlacementRenderer.renderer);
});

test('pages without ads or without the inline response pass through unchanged (null)', () => {
  assert.equal(transformWatchHtml('<html>no player here</html>'), null);
  const clean = 'var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"}};';
  assert.equal(transformWatchHtml(clean), null);
});

test('/player JSON is pruned for player-response shaped objects, including wrapped playerResponse arrays', () => {
  const direct = JSON.parse(transformPlayerJson(JSON.stringify(adResponse())));
  assert.equal('adSlots' in direct, false);
  const wrapped = JSON.parse(transformPlayerJson(JSON.stringify([{ page: 'watch', playerResponse: adResponse() }])));
  assert.equal('adSlots' in wrapped[0].playerResponse, false);
  // 플레이어 응답 모양이 아닌 객체(유튜브의 왕복 검사용 시험 JSON 같은 것)는 건드리지 않는다
  assert.equal(transformPlayerJson('{"adPlacements":true,"playerAds":true,"playerConfig":{}}'), null);
  assert.equal(transformPlayerJson('not json'), null);
});
