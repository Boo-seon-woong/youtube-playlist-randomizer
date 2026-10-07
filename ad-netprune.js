// 직접 재생(워치페이지) 광고 제거 — 페이지 안이 아니라 **네트워크 단계**에서 한다.
//
// 유튜브 www 앱은 페이지를 열 때마다 클라이언트 감지기 13개를 돌려 결과(biscottiBasedDetection)를 서버로 보낸다(2026-10 실측).
// 예전 방식(페이지 안 JSON.parse·Response.json 가로채기 + #player-ads 숨김 CSS)은 그중 4개에 매 페이지 걸렸다 —
// 광고 필드가 든 시험 JSON의 왕복 검사(j.s_·f.i_), 미끼 <div id="player-ads">의 숨김 검사(e.h_) 등. 그게 쌓여 신원이
// 표시되면 서버가 차단 안내문을 미리 넣어 보내고, 화면을 가리는 팝업(LOCKED_MODAL)이 뜬다.
//
// 그래서 웹뷰 webContents에 CDP Fetch를 걸어 워치페이지 HTML의 인라인 ytInitialPlayerResponse와 /youtubei/v1/player 응답을
// **페이지가 받기 전에** 고친다. 페이지 안에는 아무것도 심지 않으므로 감지기가 볼 것이 없다(실측: 실제 광고가 잡힌 곡 4곡 포함
// 8곡, 감지 0건, 광고 0건). 광고는 지우지 않고 유튜브가 광고가 없을 때 보내는 자리표시(clientForecastingAdRenderer)로 바꾼다 —
// 프리롤 자리(AD_PLACEMENT_KIND_START)가 남아 있어야 SABR 서버가 "프리롤이 있다"고 알려 올 때의 대조 검사(m.p_)도 통과한다.

// 문자열·이스케이프를 고려해 start의 '{'(또는 '[')와 짝이 맞는 닫는 괄호 다음 위치. 못 찾으면 -1
function jsonEnd(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++; // \ 다음 글자는 건너뛴다
      else if (c === 34) inStr = false;
    } else if (c === 34) inStr = true;
    else if (c === 123 || c === 91) depth++;
    else if (c === 125 || c === 93) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const isForecasting = (p) => !!(p && p.adPlacementRenderer && p.adPlacementRenderer.renderer
  && 'clientForecastingAdRenderer' in p.adPlacementRenderer.renderer);
const isStart = (p) => !!(p && p.adPlacementRenderer && p.adPlacementRenderer.config
  && p.adPlacementRenderer.config.adPlacementConfig
  && p.adPlacementRenderer.config.adPlacementConfig.kind === 'AD_PLACEMENT_KIND_START');

// 플레이어 응답 하나에서 실제 광고를 걷어낸다. 바꿨으면 true
function stripPlayerResponse(pr) {
  if (!pr || typeof pr !== 'object') return false;
  let changed = false;
  if (Array.isArray(pr.adPlacements) && pr.adPlacements.some((p) => !isForecasting(p))) {
    const start = pr.adPlacements.find(isStart);
    if (start) {
      const r = start.adPlacementRenderer;
      pr.adPlacements = [{
        adPlacementRenderer: {
          config: r.config,
          renderer: { clientForecastingAdRenderer: {} },
          ...(r.adSlotLoggingData ? { adSlotLoggingData: r.adSlotLoggingData } : {}),
        },
      }];
    } else {
      delete pr.adPlacements; // 프리롤이 없던 응답 — 원래도 프리롤 자리가 없었다
    }
    changed = true;
  }
  if ('adSlots' in pr) {
    delete pr.adSlots;
    changed = true;
  }
  return changed;
}

// 워치페이지 HTML의 인라인 `var ytInitialPlayerResponse = {...}`를 고친다. 바꿀 것이 없으면 null
function transformWatchHtml(html) {
  const marker = 'var ytInitialPlayerResponse = ';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length;
  const end = jsonEnd(html, start);
  if (end < 0) return null;
  let pr;
  try { pr = JSON.parse(html.slice(start, end)); } catch { return null; }
  if (!stripPlayerResponse(pr)) return null;
  // 인라인 JSON은 문자열 속 </script>가 태그를 끊지 않도록 <·>를 \u003c·\u003e로 이스케이프해 둔다 — 같게 되돌려 넣는다
  const json = JSON.stringify(pr).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return html.slice(0, start) + json + html.slice(end);
}

// /youtubei/v1/player 응답(JSON)을 고친다. 플레이어 응답 모양(재생 상태·스트림·영상 정보)인 객체와 그 playerResponse만 손댄다.
function transformPlayerJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  let changed = false;
  const visit = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if ('playabilityStatus' in o || 'streamingData' in o || 'videoDetails' in o) changed = stripPlayerResponse(o) || changed;
    if (o.playerResponse) visit(o.playerResponse);
  };
  visit(obj);
  return changed ? JSON.stringify(obj) : null;
}

// 웹뷰 webContents에 가로채기를 건다. 페이지 쪽에서는 보이지 않는다(Fetch 도메인만 켠다 — Runtime·Network를 켜지 않음).
async function attachAdNetPrune(wc) {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  dbg.on('message', async (_event, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const { requestId, request, responseStatusCode, responseHeaders } = params;
    const pass = () => dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
    if (responseStatusCode !== 200) return pass();
    try {
      const body = await dbg.sendCommand('Fetch.getResponseBody', { requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const out = /\/watch\?/.test(request.url) ? transformWatchHtml(text) : transformPlayerJson(text);
      if (out == null) return pass();
      // 돌려주는 본문은 압축이 풀린 새 본문이다 — 길이·압축 헤더는 뺀다
      const headers = (responseHeaders || []).filter((h) => !/^(content-length|content-encoding)$/i.test(h.name));
      await dbg.sendCommand('Fetch.fulfillRequest', {
        requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(out, 'utf8').toString('base64'),
      });
    } catch {
      pass(); // 어떤 경우에도 요청을 멈춘 채로 두지 않는다 — 광고가 남을 뿐 재생은 된다
    }
  });
  await dbg.sendCommand('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://www.youtube.com/watch?*', resourceType: 'Document', requestStage: 'Response' },
      { urlPattern: 'https://www.youtube.com/youtubei/v1/player?*', requestStage: 'Response' },
    ],
  });
}

module.exports = { attachAdNetPrune, transformWatchHtml, transformPlayerJson, stripPlayerResponse, jsonEnd };
